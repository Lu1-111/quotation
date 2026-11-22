#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BROWSERS, inspectEnvironment } from './lib/browser-runtime.mjs';

// 先检查版本，再加载内置 SQLite，避免旧 Node.js 只报模块不存在。
const runtimeModule = Number(process.versions.node.split('.')[0]) >= 24 ? await import('./runtime.mjs') : null;
const CliError = runtimeModule?.CliError || class extends Error {
  constructor(code, message, exitCode = 2) { super(message); this.code = code; this.exitCode = exitCode; }
};

const HELP = `知乎数据采集 CLI（Node.js 24+）

用法：node cli.mjs <命令> [选项]

命令：
  doctor      检查 Node、浏览器与图形环境，不登录、不采集
  login       打开专用浏览器，等待本人登录，绑定当前档案
  sync        后台获取所选信息、过滤、排序并保存，单次执行
  config      查看或保存采集种类与浏览器选择
  status      查看当前档案状态
  profiles    列出当前真实／演示模式的本机档案
  export      输出版本 3 JSON，可写入指定文件
  logout      撤回采集同意并清除本机浏览器登录状态，保留采集数据
  clear       删除当前档案采集数据与登录状态，需要 --yes
  unlock      清理已退出进程留下的锁，需要 --yes，不能强行解锁活跃进程

常用选项：
  --profile <name>       档案名称，默认 default，大小写不区分
  --data-dir <path>      数据根目录，默认模块内 .data
  --browser <channel>    auto、msedge、chrome、chromium；默认自动检测
  --launch-check         仅 doctor：实际启动并关闭无头浏览器，不访问知乎
  --consent             同意采集所选信息并保存到本机，首次 login／sync 必需
  --history / --no-history
  --likes / --no-likes
  --collections / --no-collections
  --knowledge-filter / --no-knowledge-filter
  --login-timeout <sec>  登录等待时限，1 至 900 秒，默认 180
  --output <file>        sync／export 的 JSON 文件路径
  --overwrite           显式覆盖已有普通输出文件
  --json                只向 stdout 写入结构化结果，失败信息在 stderr
  --quiet               隐藏普通进度提示
  --demo                合成演示，不调用真实知乎，不与真实数据混用
  --yes                 确认 clear 或 unlock
  --help                显示帮助

示例：
  node cli.mjs sync --demo --consent --history --likes --collections --json
  node cli.mjs login --profile personal --consent
  node cli.mjs config --profile personal --history --likes --collections
  node cli.mjs sync --profile personal --json
  node cli.mjs export --profile personal --output .data/exports/latest.json

本程序不启动 HTTP 服务；首次真实登录需要本人操作浏览器。
后续同步使用保存的登录状态，遇到验证或登录失效时停止并提示重新 login。
`;

export function parseCliArgs(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, allowNegative: true, strict: true, options: {
      profile: { type: 'string' }, 'data-dir': { type: 'string' }, browser: { type: 'string' }, 'login-timeout': { type: 'string' }, output: { type: 'string' },
      ...Object.fromEntries(['launch-check', 'consent', 'history', 'likes', 'collections', 'knowledge-filter', 'overwrite', 'json', 'quiet', 'demo', 'yes', 'help'].map((key) => [key, { type: 'boolean' }])),
    } });
  } catch { throw new CliError('INVALID_ARGUMENTS', '参数无效，请运行 node cli.mjs --help 查看格式。', 2); }
  const { values, positionals } = parsed;
  if (values.help || !positionals.length) return { command: 'help', options: values };
  const command = positionals[0];
  if (positionals.length !== 1 || !['doctor', 'login', 'sync', 'config', 'status', 'profiles', 'export', 'logout', 'clear', 'unlock', 'help'].includes(command)) throw new CliError('INVALID_COMMAND', '未知命令，请运行 node cli.mjs --help。', 2);
  const optionError = () => { throw new CliError('INVALID_ARGUMENTS', '选项不适用于当前命令，请查看 --help。', 2); };
  const selectors = ['history', 'likes', 'collections', 'knowledge-filter'];
  if (selectors.some((key) => values[key] !== undefined) && !['login', 'sync', 'config'].includes(command)) optionError();
  if (values.browser !== undefined && !['doctor', 'login', 'sync', 'config'].includes(command)) optionError();
  if (values['login-timeout'] !== undefined && command !== 'login') optionError();
  if ((values.output !== undefined || values.overwrite) && !['sync', 'export'].includes(command)) optionError();
  if (values.overwrite && !values.output) optionError();
  if (values.consent !== undefined && !['login', 'sync'].includes(command)) optionError();
  if (values.yes !== undefined && !['clear', 'unlock'].includes(command)) optionError();
  if (values['launch-check'] !== undefined && command !== 'doctor') optionError();
  const timeout = values['login-timeout'] ?? '180';
  if (!/^\d+$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > 900) throw new CliError('INVALID_ARGUMENTS', 'login-timeout 必须为 1 至 900 秒的整数。', 2);
  if (values.output !== undefined && !values.output.trim()) optionError();
  if (values['data-dir'] !== undefined && !values['data-dir'].trim()) optionError();
  if (values.browser !== undefined && !BROWSERS.includes(values.browser)) throw new CliError('INVALID_BROWSER', 'browser 只支持 auto、msedge、chrome、chromium。', 2);
  return { command, options: { ...values, dataDir: values['data-dir'], knowledgeFilter: values['knowledge-filter'], loginTimeout: Number(timeout) } };
}

function human(result) {
  if (result.type === 'snapshot') return `已保存采集结果：${result.value.records.length} 条合格内容，${result.value.excluded.length} 条排除记录。${result.savedTo ? `\nJSON：${result.savedTo}` : '\n使用 --json 获取完整结果，或用 export 导出。'}`;
  const value = result.value;
  if (value.profiles) return value.profiles.length ? `本机档案：\n${value.profiles.map((name) => `  ${name}`).join('\n')}` : '当前模式尚无本机档案。';
  if ('unlocked' in value) return value.unlocked ? '已移除退出进程的遗留锁。' : '当前没有遗留锁。';
  return [`档案：${value.profile}${value.demo ? '（合成演示）' : ''}`, `账号：${value.nickname || '尚未绑定'}`,
    `采集同意：${value.consented ? '已确认' : '未确认'}`, `最近同步：${value.lastSyncedAt || '尚未同步'}`,
    `信息种类：${['history', 'likes', 'collections'].filter((kind) => value.settings?.[kind]).join(', ') || '未选择'}`,
    `浏览 ${value.counts?.history || 0}，点赞 ${value.counts?.likes || 0}，收藏 ${value.counts?.collections || 0}`].join('\n');
}

export async function runCli(args, { stdout = process.stdout, stderr = process.stderr, signal } = {}) {
  let parsed;
  try {
    parsed = parseCliArgs(args);
    if (parsed.command === 'help') { stdout.write(HELP); return 0; }
    const { command, options } = parsed;
    if (command === 'doctor') {
      const value = await inspectEnvironment({ preference: options.browser || process.env.CLI_BROWSER_CHANNEL || 'auto', launchCheck: Boolean(options['launch-check']) });
      stdout.write(options.json ? JSON.stringify(value) + '\n' : `Node.js：${value.nodeVersion}${value.nodeReady ? '（符合要求）' : '（需要 24+）'}\n系统：${value.platform}\n浏览器：${value.browser.selected || '未就绪'}\n图形环境：${value.displayReady ? '具备基本条件' : '未检测到 Linux 显示服务'}\n登录启动检查：${value.readyForLogin ? '通过，仍需本人登录和网络验证' : '未通过'}\n${value.browser.error?.message || value.launchCheck.error?.message || ''}\n`);
      return value.readyForLogin ? 0 : 3;
    }
    if (!runtimeModule) throw new CliError('UNSUPPORTED_NODE', '本模块需要 Node.js 24+，请更新 Node.js 后重试。');
    const runtime = runtimeModule.createCliRuntime({ dataDir: options.dataDir, demo: Boolean(options.demo) });
    const result = await runtime.execute(command, options, { signal, log: (message) => { if (!options.json && !options.quiet) stderr.write(message + '\n'); } });
    if (options.json || (command === 'export' && !options.output)) stdout.write(JSON.stringify(result.value) + '\n');
    else stdout.write(human(result) + '\n');
    return 0;
  } catch (error) {
    const safe = runtimeModule ? runtimeModule.safeCliError(error, signal) : error instanceof CliError ? error : new CliError('STARTUP_ERROR', '启动失败，请检查 Node.js 版本和依赖。');
    if (parsed?.options.json || args.includes('--json')) stderr.write(JSON.stringify({ error: { code: safe.code, message: safe.message } }) + '\n');
    else stderr.write(`${safe.message}\n`);
    return safe.exitCode;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal });
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
}
