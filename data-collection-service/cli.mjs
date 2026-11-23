#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServiceStore } from './store.mjs';
import { createApiServer } from './server.mjs';
import { createWorker } from './worker.mjs';
import { defaultSettings } from './contracts.mjs';
import { storagePaths, configuredClient, defaultWorkerDir } from './config.mjs';
import { writeSnapshot } from './local/runtime.mjs';
import { inspectEnvironment } from './local/lib/browser-runtime.mjs';

const help = `知乎通用采集模块（Node.js 24+）
node cli.mjs <命令> [选项]
  desktop         启动用户图形界面、API 和本机采集器；默认打开页面
  serve           启动 API 服务；默认 127.0.0.1:3005
  provision       创建应用用户与设备，必须 --name <名称> --output <私有凭证文件>
  device-add      为已有用户增加设备，必须 --user-id <UUID> --output <私有凭证文件>
  device-revoke   撤销设备凭证，必须 --user-id <UUID> --device-id <UUID>
  token-rotate    替换用户凭证并取消其任务，必须 --user-id <UUID> --output <新文件>
  worker-login    本人确认采集及上传同意并登录知乎，需要 --consent
  worker-doctor   检查本机采集器环境，无需服务凭证，不连接知乎
  worker          前台运行本机采集器，仅处理已请求的任务；--once 只处理一次
  worker-revoke   撤回本机同意并删除知乎登录会话
  status          查询当前应用用户和设备状态
  sync            请求同步并等待，输出完整交付 JSON
  export          读取最近的完整交付 JSON

通用：--demo、--credentials <私有凭证文件>、--data-dir <服务数据库根目录>
设备：--profile <英文档案名>、--worker-data-dir <本机目录>、--browser auto|msedge|chrome|chromium
同意范围：--history/--no-history、--likes、--collections、--knowledge-filter/--no-knowledge-filter
provision 的输出文件含用户、设备凭证，仅供本地开发；跨设备分别交付对应角色凭证。
凭证不接受命令行明文参数；使用私有文件或环境变量。真实采集需 Edge/Chrome 或已安装的托管 Chromium。
`;

export async function main(args, { signal } = {}) {
  const { values: options, positionals } = parseArgs({ args, allowPositionals: true, allowNegative: true, options: {
    ...Object.fromEntries(['port', 'name', 'device', 'user-id', 'device-id', 'output', 'credentials', 'data-dir', 'worker-data-dir', 'profile', 'browser'].map((key) => [key, { type: 'string' }])),
    ...Object.fromEntries(['open', 'launch-check', 'demo', 'consent', 'once', 'history', 'likes', 'collections', 'knowledge-filter', 'help'].map((key) => [key, { type: 'boolean' }])),
  } });
  const command = positionals[0] || 'help';
  if (options.help || command === 'help') { process.stdout.write(help); return; }
  if (positionals.length !== 1) throw new Error('只允许一个命令。');
  if (command === 'desktop') {
    const { startDesktop, openDesktopPage } = await import('./desktop.mjs');
    const app = await startDesktop({ demo: Boolean(options.demo), dataDir: options['data-dir'], profile: options.profile || 'default', browser: options.browser,
      port: Number(options.port || process.env.PORT || 3005), signal, log: (message) => process.stderr.write(message + '\n') });
    if (options.open !== false) openDesktopPage(app.baseUrl);
    await app.done; return;
  }
  if (command === 'worker-doctor') {
    const result = await inspectEnvironment({ preference: options.browser || process.env.WORKER_BROWSER || 'auto', launchCheck: Boolean(options['launch-check']) });
    process.stdout.write(JSON.stringify(result) + '\n'); if (!result.readyForLogin) process.exitCode = 3; return;
  }
  if (options['launch-check'] !== undefined) throw new Error('launch-check 仅适用于 worker-doctor。');
  if (['history', 'likes', 'collections', 'knowledge-filter'].some((key) => options[key] !== undefined) && command !== 'worker-login') throw new Error('采集范围选项仅用于 worker-login；实际请求范围通过用户 API 设置。');
  const demo = Boolean(options.demo); const paths = storagePaths(demo, options['data-dir']);
  if (['serve', 'provision', 'device-add', 'device-revoke', 'token-rotate'].includes(command)) {
    const store = createServiceStore(paths.database, { demo });
    if (command !== 'serve') {
      try {
        if (command === 'device-revoke') { process.stdout.write(JSON.stringify(store.revokeDevice(options['user-id'], options['device-id'])) + '\n'); return; }
        if (!options.output) throw new Error('必须通过 --output 指定新的私有凭证文件。');
        const baseUrl = process.env.DATA_SERVICE_URL || process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:3005';
        const deliver = (value) => { writeSnapshot(options.output, { baseUrl, ...value }); return value; };
        const value = command === 'provision' ? store.provision(options.name, options.device || 'desktop', deliver) : command === 'token-rotate' ? store.rotateUserToken(options['user-id'], deliver) : store.addDevice(options['user-id'], options.device || 'desktop', deliver);
        process.stdout.write(JSON.stringify({ userId: value.userId, deviceId: value.deviceId, demo, credentialsFile: resolve(options.output) }) + '\n');
      } finally { store.close(); }
      return;
    }
    const port = Number(process.env.PORT || 3005); const host = process.env.HOST || '127.0.0.1';
    if (!Number.isInteger(port) || port < 1 || port > 65535) { store.close(); throw new Error('PORT 无效。'); }
    const publicOrigin = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`;
    const server = createApiServer({ store, publicOrigin, allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean) });
    const stop = () => { server.close(); server.closeIdleConnections(); };
    signal?.addEventListener('abort', stop, { once: true });
    try {
      await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok); });
      process.stderr.write(`采集 API 已启动：${publicOrigin}${demo ? '（合成演示）' : ''}\n`);
      if (signal?.aborted) stop();
      await new Promise((ok) => server.once('close', ok));
    } finally { signal?.removeEventListener('abort', stop); store.close(); }
    return;
  }
  let result;
  if (['worker-login', 'worker', 'worker-revoke'].includes(command)) {
    const worker = createWorker({ client: configuredClient('device', options.credentials), demo,
      dataDir: options['worker-data-dir'] || defaultWorkerDir(), profile: options.profile || process.env.WORKER_PROFILE || 'default', browser: options.browser || process.env.WORKER_BROWSER || undefined,
      log: (message) => process.stderr.write(message + '\n') });
    if (command === 'worker-login') result = await worker.login({ consent: options.consent, settings: { ...defaultSettings,
      ...Object.fromEntries(['history', 'likes', 'collections'].filter((key) => options[key] !== undefined).map((key) => [key, options[key]])),
      ...(options['knowledge-filter'] !== undefined ? { knowledgeFilter: options['knowledge-filter'] } : {}) }, signal });
    else if (command === 'worker-revoke') result = await worker.revoke({ signal });
    else result = await worker.run({ signal, once: options.once });
  } else if (['status', 'sync', 'export'].includes(command)) {
    const client = configuredClient('user', options.credentials);
    result = command === 'status' ? await client.status({ signal }) : command === 'sync' ? await client.sync({ signal }) : await client.read('latest', { signal });
    if (options.output) { writeSnapshot(options.output, result); result = { savedTo: resolve(options.output) }; }
  } else throw new Error('未知命令，请查看 --help。');
  if (result !== undefined) process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController(); const stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await main(process.argv.slice(2), { signal: controller.signal }); }
  catch (error) { if (!controller.signal.aborted) { process.stderr.write(JSON.stringify({ ok: false, error: { code: error.code || 'STARTUP_ERROR', message: ['ApiError', 'ServiceError', 'CliError', 'BrowserSetupError'].includes(error.constructor.name) ? error.message : '运行失败，请检查参数、配置、依赖与本机权限。' } }) + '\n'); process.exitCode = 1; } }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
