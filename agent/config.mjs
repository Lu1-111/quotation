// 智能体配置：把环境变量与覆盖项整理成冻结的配置对象。
// 除本文件外，其他文件不直接读取 process.env；任何输出都不得包含模型密钥或用户令牌。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError } from './errors.mjs';

// 搜索与采集目录的默认值相对 agent/ 解析，不随启动时的当前工作目录变化。
const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_SERVICE_URL = 'http://127.0.0.1:3005';
// 采集同步较慢，固定为 15 分钟，供引擎为同步工具放宽超时。
const COLLECTION_SYNC_MS = 900000;

const invalid = (message) => new AgentError('CONFIG_INVALID', message, 2);

// 空串与纯空白一律视为未设置。
function text(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// 开关只认 true（不区分大小写），其余取值一律按关闭处理。
const flag = (value) => typeof value === 'string' && value.trim().toLowerCase() === 'true';

// 整数只接受纯数字串；未设置或空串用默认值。错误消息不回显输入值。
function readInt(raw, { label, hint, min, max, fallback }) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = String(raw).trim();
  const number = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw invalid(`${label} 必须是${hint}。`);
  }
  return number;
}

const timeoutOption = (label, fallback) => ({ label, hint: '正整数（毫秒）', min: 1, max: Number.MAX_SAFE_INTEGER, fallback });

// 只取契约列出的变量，且只保留已设置的项。
function pick(env, names) {
  const result = {};
  for (const name of names) {
    const value = text(env[name]);
    if (value !== null) result[name] = value;
  }
  return result;
}

const resolveDir = (value, fallback) => path.resolve(AGENT_DIR, text(value) ?? fallback);

function searchServer(env, demo, dir) {
  const childEnv = pick(env, ['ZHIHU_ACCESS_SECRET', 'DATA_FILE']);
  const hasSecret = Object.hasOwn(childEnv, 'ZHIHU_ACCESS_SECRET');
  const enabled = demo || hasSecret;
  const args = [path.join(dir, 'mcp-server.mjs')];
  if (demo) args.push('--demo');
  let reason = '未启用：没有演示模式，也缺少 ZHIHU_ACCESS_SECRET。';
  if (demo) reason = '已启用：演示模式，使用合成数据。';
  else if (hasSecret) reason = '已启用：已配置 ZHIHU_ACCESS_SECRET。';
  return { id: 'search', enabled, reason, command: process.execPath, args, env: enabled ? childEnv : {} };
}

function collectionServer(env, allowPersonalData, dir) {
  // 采集 MCP 要求用户在界面创建的 agt_ 只读凭证（见 data-collection-service/agent-tools.mjs），
  // 它只能读已保存的数据，无法登录、改设置或发起同步。usr_ 用户令牌不被该入口接受。
  const token = text(env.DATA_SERVICE_AGENT_TOKEN);
  const enabled = allowPersonalData && token !== null;
  let reason = '已启用：已同意个人数据发送给所配置的模型服务，并配置了 DATA_SERVICE_AGENT_TOKEN。';
  if (!allowPersonalData) reason = '未启用：未同意把个人浏览数据发送给模型服务。';
  else if (token === null) reason = '未启用：缺少 DATA_SERVICE_AGENT_TOKEN，请在采集界面创建只读入口。';
  const childEnv = enabled
    ? { DATA_SERVICE_URL: text(env.DATA_SERVICE_URL) ?? DEFAULT_DATA_SERVICE_URL, DATA_SERVICE_AGENT_TOKEN: token }
    : {};
  return { id: 'collection', enabled, reason, command: process.execPath, args: [path.join(dir, 'mcp-server.mjs')], env: childEnv };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export function loadConfig({ env = process.env, overrides = {} } = {}) {
  const demo = overrides.demo === true;
  const allowPersonalData = typeof overrides.allowPersonalData === 'boolean'
    ? overrides.allowPersonalData
    : flag(env.AGENT_ALLOW_PERSONAL_DATA);
  const baseURL = text(overrides.baseURL) ?? text(env.AGENT_BASE_URL);
  const modelName = text(overrides.modelName) ?? text(env.AGENT_MODEL);
  const limits = {
    maxSteps: readInt(overrides.maxSteps ?? env.AGENT_MAX_STEPS, { label: 'AGENT_MAX_STEPS（最大步数）', hint: '1 到 20 之间的整数', min: 1, max: 20, fallback: 8 }),
    totalMs: readInt(env.AGENT_TOTAL_TIMEOUT_MS, timeoutOption('AGENT_TOTAL_TIMEOUT_MS（总超时）', 600000)),
    stepMs: readInt(env.AGENT_STEP_TIMEOUT_MS, timeoutOption('AGENT_STEP_TIMEOUT_MS（单步超时）', 120000)),
    collectionSyncMs: COLLECTION_SYNC_MS,
  };
  return deepFreeze({
    demo,
    allowPersonalData,
    model: { providerName: 'openai-compatible', baseURL, modelName, apiKey: text(env.AGENT_API_KEY), ready: baseURL !== null && modelName !== null },
    limits,
    servers: [
      searchServer(env, demo, resolveDir(env.AGENT_SEARCH_DIR, '../information-search')),
      collectionServer(env, allowPersonalData, resolveDir(env.AGENT_COLLECTION_DIR, '../data-collection-service')),
    ],
  });
}

// 地址里可能带账号口令或查询串，打印前一律去掉。
function safeUrl(value) {
  if (value === null || value === undefined) return null;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '（地址格式无效）';
  }
}

// 可安全打印的配置摘要：不含密钥与令牌，子进程 env 只列变量名。
export function describeConfig(config) {
  const { apiKey, baseURL, ...model } = config.model;
  return {
    demo: config.demo,
    allowPersonalData: config.allowPersonalData,
    model: { ...model, baseURL: safeUrl(baseURL), apiKeyConfigured: Boolean(apiKey) },
    limits: { ...config.limits },
    servers: config.servers.map((server) => ({
      id: server.id,
      enabled: server.enabled,
      reason: server.reason,
      command: server.command,
      args: [...server.args],
      env: Object.keys(server.env),
    })),
  };
}
