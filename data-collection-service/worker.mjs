import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { createCliRuntime, safeCliError } from './local/runtime.mjs';
import { defaultSettings, parseSettings } from './contracts.mjs';
import { ApiError } from './client.mjs';

export function createWorker({ client, dataDir, profile = 'default', demo = false, browser, runtime, log = () => {} } = {}) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(profile)) throw new ApiError('INVALID_PROFILE', '档案名称只允许 1 至 64 位英文字母、数字、下划线或连字符。');
  profile = profile.toLowerCase();
  const root = resolve(dataDir); const scope = join(root, demo ? 'demo' : 'live');
  const grantPath = join(scope, `grant-${profile}.json`);
  const local = runtime || createCliRuntime({ dataDir: root, demo, browserChannel: browser });
  const info = async (signal) => {
    const value = await client.request('/v1/worker/info', { signal });
    if (value.demo !== demo) throw new ApiError('MODE_MISMATCH', '采集器和服务端的真实／演示模式不一致。');
    return value;
  };
  const readGrant = () => { try { return JSON.parse(readFileSync(grantPath, 'utf8')); } catch { throw new ApiError('CONSENT_REQUIRED', '请本人先执行 worker-login --consent，确认账号与采集范围。'); } };
  function saveGrant(value) {
    mkdirSync(scope, { recursive: true, mode: 0o700 }); const temporary = `${grantPath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); renameSync(temporary, grantPath);
  }
  async function checkGrant(identity, selected, signal) {
    const grant = readGrant();
    if (grant.userId !== identity.userId || grant.deviceId !== identity.deviceId || grant.demo !== demo) throw new ApiError('CONSENT_REQUIRED', '本机同意记录不属于当前设备或用户。');
    const allowed = parseSettings(grant.settings);
    // 正文读取范围大于摘要，必须同样受本机同意约束，服务端不能单方面开启。
    if (['history', 'likes', 'collections', 'fetchFullText'].some((key) => selected[key] && !allowed[key]) || (allowed.knowledgeFilter && !selected.knowledgeFilter)) throw new ApiError('CONSENT_SCOPE_MISMATCH', '服务器请求超出本机允许范围。');;
    const status = await local.execute('status', { profile }, { signal });
    if (!status.value.consented || !status.value.bound) throw new ApiError('LOGIN_REQUIRED', '本机尚未登录或已撤回同意。');
    if (status.value.accountRef !== grant.accountRef) throw new ApiError('ACCOUNT_MISMATCH', '本机账号与同意记录不一致。');
    return grant;
  }
  return {
    async login({ consent = false, settings = defaultSettings, loginTimeout = 180, signal } = {}) {
      if (!consent) throw new ApiError('CONSENT_REQUIRED', '登录前需 --consent，同意所选数据保存本机并上传到配置的采集服务。');
      const selected = parseSettings(settings); const identity = await info(signal);
      let result;
      try { result = await local.execute('login', { profile, consent: true, browser, loginTimeout, ...selected }, { signal, log }); }
      catch (error) { throw safeCliError(error, signal); }
      if (!result.value.accountRef) throw new ApiError('LOGIN_REQUIRED', '无法绑定本机账号。');
      const grant = { schemaVersion: 1, ...identity, profile, accountRef: result.value.accountRef, settings: selected, consentedAt: new Date().toISOString() };
      saveGrant(grant);
      return { deviceId: identity.deviceId, profile, demo, settings: selected, consented: true };
    },
    async status({ signal } = {}) {
      const state = (await local.execute('status', { profile }, { signal })).value;
      let grant = null; try { grant = readGrant(); } catch {}
      return { profile, demo, consented: Boolean(state.consented && grant), bound: Boolean(state.bound), nickname: state.nickname || '',
        settings: grant?.settings || state.settings, browser: state.browser || browser || 'auto', lastSyncedAt: state.lastSyncedAt || null };
    },
    async authorize({ consent = false, settings = defaultSettings, signal } = {}) {
      if (!consent) throw new ApiError('CONSENT_REQUIRED', '请本人确认修改后的采集范围。');
      const selected = parseSettings(settings), identity = await info(signal), previous = readGrant();
      const state = (await local.execute('status', { profile }, { signal })).value;
      if (!state.consented || !state.bound || identity.userId !== previous.userId || identity.deviceId !== previous.deviceId || state.accountRef !== previous.accountRef) throw new ApiError('LOGIN_REQUIRED', '请先在当前设备完成登录和采集同意。');
      await local.execute('config', { profile, ...selected }, { signal });
      saveGrant({ ...previous, settings: selected, consentedAt: new Date().toISOString() });
      return { profile, settings: selected, consented: true };
    },
    async revoke({ signal } = {}) {
      // runtime 撤回同意并删除会话；残留的 grant 不足以再次启动采集。
      await local.execute('logout', { profile }, { signal }); return { profile, revoked: true };
    },
    async clearData({ signal } = {}) { await local.execute('clear', { profile, yes: true }, { signal }); return { profile, cleared: true }; },
    async runOnce({ signal } = {}) {
      const identity = await info(signal);
      const claimed = await client.request('/v1/worker/claim', { method: 'POST', body: {}, signal });
      if (!claimed) return { worked: false };
      const { job, leaseToken } = claimed; const controller = new AbortController();
      const active = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
      const endpoint = `/v1/worker/jobs/${encodeURIComponent(job.id)}`;
      const heartbeat = async () => client.request(`${endpoint}/heartbeat`, { method: 'POST', body: { leaseToken }, signal: active });
      let timer; let pumping = Promise.resolve(); let grant;
      try {
        grant = await checkGrant(identity, job.settings, active);
        await heartbeat();
        timer = setInterval(() => {
          pumping = pumping.then(heartbeat).catch(() => { controller.abort(new ApiError('LEASE_EXPIRED', '调用方已离线或设备租约失效。')); });
        }, claimed.heartbeatSeconds * 1000);
        const result = await local.execute('sync', { profile, ...job.settings }, { signal: active, log });
        active.throwIfAborted();
        if (result.accountRef !== grant.accountRef) throw new ApiError('ACCOUNT_MISMATCH', '本次采集账号与同意记录不一致。');
        await heartbeat();
        const body = { leaseToken, accountRef: result.accountRef, snapshot: result.value };
        // 网络断开后使用同一内容重试；服务端以任务和内容摘要幂等写入。
        let uploaded;
        for (let attempt = 0; attempt < 2; attempt++) {
          try { uploaded = await client.request(`${endpoint}/complete`, { method: 'POST', body, signal: active }); break; }
          catch (error) { if (error.code !== 'NETWORK_ERROR' || attempt) throw error; }
        }
        return { worked: true, jobId: job.id, state: 'succeeded', snapshotId: uploaded.snapshotId };
      } catch (error) {
        const safe = error instanceof ApiError ? error : safeCliError(error, active);
        const code = ['CONSENT_REQUIRED', 'CONSENT_SCOPE_MISMATCH', 'LOGIN_REQUIRED', 'ACCOUNT_MISMATCH'].includes(safe.code) ? safe.code
          : safe.code === 'ACCOUNT_OR_SESSION_MISMATCH' ? 'ACCOUNT_MISMATCH' : 'COLLECTION_FAILED';
        if (!active.aborted) await client.request(`${endpoint}/fail`, { method: 'POST', body: { leaseToken, code }, signal: AbortSignal.timeout(5000) }).catch(() => {});
        if (signal?.aborted) throw signal.reason;
        return { worked: true, jobId: job.id, state: 'failed', code: active.aborted ? 'LEASE_EXPIRED' : code };
      } finally {
        clearInterval(timer); controller.abort(); await pumping;
        if (grant) await local.execute('config', { profile, ...grant.settings }).catch(() => {});
      }
    },
    async run({ signal, pollMs = 5000, once = false } = {}) {
      do {
        signal?.throwIfAborted();
        try { const result = await this.runOnce({ signal }); if (once) return result; if (result.worked) log(`任务 ${result.jobId}：${result.state}`); }
        catch (error) { if (signal?.aborted || once || ['MODE_MISMATCH', 'UNAUTHORIZED'].includes(error.code)) throw error; log('暂时无法连接采集服务，稍后重试。'); }
        await pause(pollMs, undefined, { signal });
      } while (true);
    },
  };
}
