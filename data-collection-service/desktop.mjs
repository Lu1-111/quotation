import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { createServiceStore } from './store.mjs';
import { createApiServer } from './server.mjs';
import { ApiError, createApiClient } from './client.mjs';
import { createWorker } from './worker.mjs';
import { writeSnapshot, safeCliError } from './local/runtime.mjs';
import { ServiceError } from './errors.mjs';

export async function startDesktop({ demo = false, dataDir, profile = 'default', port = 3005, browser, signal, log = () => {} } = {}) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(profile)) throw new ServiceError('INVALID_PROFILE', '档案名仅使用英文字母、数字、下划线或连字符。');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ServiceError('INVALID_PORT', '端口无效。');
  profile = profile.toLowerCase();
  const root = resolve(dataDir || fileURLToPath(new URL('./.data/desktop', import.meta.url))), scope = join(root, demo ? 'demo' : 'live');
  const profileRoot = join(scope, `profile-${profile}`), credentialsPath = join(profileRoot, 'credentials.json');
  const store = createServiceStore(join(scope, 'service.sqlite'), { demo });
  let credentials;
  try {
    credentials = existsSync(credentialsPath) ? JSON.parse(readFileSync(credentialsPath, 'utf8')) : store.provision('本机用户', `desktop-${profile}`, (value) => { writeSnapshot(credentialsPath, value); return value; });
    store.authenticate(credentials.userToken, 'user'); store.authenticate(credentials.deviceToken, 'device');
  } catch (error) { store.close(); throw error; }
  let worker, server, operation = null, closing = false;
  let lastLocal = { profile, demo, consented: false, bound: false, nickname: '', settings: store.settings(credentials.userId) };
  let notice = null;
  const shutdown = new AbortController();
  const active = AbortSignal.any([shutdown.signal, ...(signal ? [signal] : [])]);
  async function refreshLocal() { try { lastLocal = await worker.status(); } catch {} }
  function begin(kind, action) {
    if (operation) throw new ServiceError('BUSY', '当前操作正在进行，请等待或先停止同步。', 409);
    const controller = new AbortController(), selectedSignal = AbortSignal.any([controller.signal, active]);
    const current = { kind, controller, done: null }; operation = current;
    current.done = (async () => {
      try { const result = await action(selectedSignal); notice = null; return result; }
      catch (error) { const safe = error instanceof ApiError || error instanceof ServiceError ? error : safeCliError(error, selectedSignal); notice = { code: safe.code, message: safe.message }; throw safe; }
      finally { if (operation === current) operation = null; await refreshLocal(); }
    })();
    return current;
  }
  async function settleIdle() {
    if (operation?.kind === 'poll' && !store.status(credentials.userId).activeJob) await operation.done.catch(() => {});
  }
  const control = {
    userId: credentials.userId,
    async status() { if (!operation) await refreshLocal(); return { ...lastLocal, operation: operation?.kind === 'login' ? 'login' : store.status(credentials.userId).activeJob ? 'sync' : null, notice,
      mcpServerPath: fileURLToPath(new URL('./mcp-server.mjs', import.meta.url)), dataLocation: '当前设备' }; },
    async login(input) {
      await settleIdle(); const task = begin('login', (selectedSignal) => worker.login({ ...input, loginTimeout: 600, signal: selectedSignal }));
      task.done.then(() => store.settings(credentials.userId, input.settings)).catch(() => {});
      return { started: true };
    },
    async cancelLogin() { if (operation?.kind === 'login') { operation.controller.abort(); await operation.done.catch(() => {}); } return { stopped: true }; },
    async stopSync() {
      const job = store.status(credentials.userId).activeJob; if (job) store.cancel(credentials.userId, job.id);
      if (operation?.kind === 'poll') { operation.controller.abort(); await operation.done.catch(() => {}); }
      return { stopped: true };
    },
    async authorize(input) { await settleIdle(); return begin('consent', async (selectedSignal) => { const result = await worker.authorize({ ...input, signal: selectedSignal }); store.settings(credentials.userId, input.settings); return result; }).done; },
    async revoke() {
      const job = store.status(credentials.userId).activeJob; if (job) store.cancel(credentials.userId, job.id);
      if (operation) { operation.controller.abort(); await operation.done.catch(() => {}); }
      return begin('revoke', (selectedSignal) => worker.revoke({ signal: selectedSignal })).done;
    },
    async clearData() {
      await this.stopSync(); await this.cancelLogin();
      if (operation) { operation.controller.abort(); await operation.done.catch(() => {}); }
      return begin('clear', async (selectedSignal) => { await worker.clearData({ signal: selectedSignal }); store.clear(credentials.userId); return { cleared: true }; }).done;
    },
  };
  // 确定实际端口后创建 Host 校验规则；只绑定回环，不暴露本机登录操作。
  // 端口 0 供测试选择临时端口，正式启动使用用户指定的固定端口。
  let actualPort = port;
  if (port === 0) {
    const { createServer } = await import('node:net'); const probe = createServer();
    await new Promise((ok, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', ok); }); actualPort = probe.address().port;
    await new Promise((ok) => probe.close(ok));
  }
  const baseUrl = `http://127.0.0.1:${actualPort}`;
  try {
    server = createApiServer({ store, localControl: control, publicOrigin: baseUrl });
    await new Promise((ok, fail) => { server.once('error', fail); server.listen(actualPort, '127.0.0.1', ok); });
    worker = createWorker({ client: createApiClient({ baseUrl, token: credentials.deviceToken }), dataDir: join(profileRoot, 'worker'), profile, demo, browser, log });
    await refreshLocal();
  } catch (error) { server?.close(); store.close(); throw error; }
  const loop = (async () => {
    while (!active.aborted) {
      if (!operation) { try { await begin('poll', (selectedSignal) => worker.runOnce({ signal: selectedSignal })).done; } catch {} }
      try { await pause(1500, undefined, { signal: active }); } catch { break; }
    }
  })();
  const close = async () => {
    if (closing) return; closing = true; shutdown.abort();
    const job = store.status(credentials.userId).activeJob; if (job) store.cancel(credentials.userId, job.id);
    if (operation) { operation.controller.abort(); await operation.done.catch(() => {}); }
    await loop; await new Promise((ok) => { server.close(ok); server.closeIdleConnections(); }); store.close();
  };
  active.addEventListener('abort', () => { void close(); }, { once: true });
  log(`用户操作界面：${baseUrl}${demo ? '（合成演示）' : ''}`);
  return { baseUrl, store, userId: credentials.userId, close, done: new Promise((ok) => server.once('close', ok)) };
}

export function openDesktopPage(url) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }); child.once('error', () => {}); child.unref();
}
