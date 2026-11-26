#!/usr/bin/env node
// 智能体图形界面：一个只监听回环地址的 HTTP 服务，把 agent.mjs 与 data-collection-service 合成一个页面。
//
// 设计约束（与本模块其余部分一致）：
// - 只绑定 127.0.0.1，没有账号体系，也不提供公网入口；POST 还校验来源，跨站页面无法驱动它。
// - 模型密钥与各类令牌只留在进程内存：不写进页面、不写进磁盘，所有返回值统一深度脱敏。
// - 非机密配置（模型地址、模型名、演示开关、采集服务地址）存 .data/web-settings.json，重启后仍在。
// - 同一时刻只处理一个提问，避免两条请求抢同一个 MCP 连接；长等待可点停止取消。
// - 采集能力由 collection.mjs 注入；没有采集组件时，界面只剩对话，采集接口统一返回 503。
// - 采集的权限边界不在这里放宽：登录/同意仍走 data-collection-service 自己的三重校验，
//   Agent 侧只用它签发的 agt_ 只读令牌。
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentError, safeAgentError, okEnvelope, errorEnvelope } from './errors.mjs';
import { collectSecrets, redactSecrets } from './cli.mjs';
import { createModel } from './agent.mjs';
import { buildSystemPrompt } from './prompt.mjs';
import { generateProfile, isStale, profilePromptBlock, PROFILE_RECORD_LIMIT } from './profile.mjs';
import { createInteractionController } from './interaction.mjs';

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(AGENT_DIR, 'public', 'index.html');
const SETTINGS_FILE = path.join(AGENT_DIR, '.data', 'web-settings.json');
const PROFILE_FILE = path.join(AGENT_DIR, '.data', 'profile.json');
// 密钥单独一个文件：和 web-settings.json 分开，便于单独删除、也便于说明它是明文。
const SECRETS_FILE = path.join(AGENT_DIR, '.data', 'secrets.json');

const DEFAULT_PORT = 3210;
const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;
// 页面超过这么久没有轮询采集状态，就认为界面已经关掉，主动取消正在进行的同步。
const PAGE_IDLE_MS = 60_000;
const KEEPALIVE_MS = 20_000;

// 可落盘的设置项：全部不含密钥。apiKey、agentToken、searchSecret 只在内存里。
export const PERSISTED_KEYS = Object.freeze(['baseURL', 'modelName', 'demo', 'allowPersonalData', 'serviceURL', 'maxSteps']);
export const SECRET_KEYS = Object.freeze(['apiKey', 'agentToken', 'searchSecret']);

// 采集服务自己的错误码，连同合适的 HTTP 状态一起透传，避免被压成笼统的 INTERNAL_ERROR。
const SERVICE_STATUS = {
  BUSY: 409, UNAUTHORIZED: 401, NOT_FOUND: 404, READ_ONLY: 403,
  CONSENT_REQUIRED: 403, CONSENT_SCOPE_MISMATCH: 403, LOGIN_REQUIRED: 401,
  LOCAL_UI_DENIED: 403, LOCAL_UI_REQUIRED: 403, INVALID_ARGUMENTS: 400,
};

const blankSettings = () => ({
  baseURL: '', modelName: '', apiKey: '',
  demo: false, allowPersonalData: false,
  serviceURL: '', agentToken: '', searchSecret: '', maxSteps: '',
});

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const truthy = (value) => value === true || value === 'true';

// 只接受已知字段，并统一形态；未知字段直接丢弃，避免外部往里塞东西。
export function sanitizeSettings(input) {
  const source = input && typeof input === 'object' ? input : {};
  const next = blankSettings();
  for (const key of ['baseURL', 'modelName', 'apiKey', 'serviceURL', 'agentToken', 'searchSecret']) {
    next[key] = text(source[key]).slice(0, 2000);
  }
  next.demo = truthy(source.demo);
  next.allowPersonalData = truthy(source.allowPersonalData);
  const steps = text(source.maxSteps);
  next.maxSteps = /^[0-9]{1,2}$/.test(steps) ? steps : '';
  return next;
}

export function persistedPortion(settings) {
  const out = {};
  for (const key of PERSISTED_KEYS) out[key] = settings[key];
  return out;
}

// 只有非空字段才覆盖环境变量，留空表示沿用 .env。
export function buildOverrides(settings) {
  const overrides = {};
  if (settings.demo) overrides.demo = true;
  if (settings.allowPersonalData) overrides.allowPersonalData = true;
  if (settings.baseURL) overrides.baseURL = settings.baseURL;
  if (settings.modelName) overrides.modelName = settings.modelName;
  if (settings.maxSteps) overrides.maxSteps = Number(settings.maxSteps);
  return overrides;
}

// 把界面上的密钥写进交给 loadConfig 的环境副本，不污染 process.env。
export function buildEnv(baseEnv, settings) {
  const env = { ...baseEnv };
  if (settings.apiKey) env.AGENT_API_KEY = settings.apiKey;
  if (settings.serviceURL) env.DATA_SERVICE_URL = settings.serviceURL;
  if (settings.agentToken) env.DATA_SERVICE_AGENT_TOKEN = settings.agentToken;
  if (settings.searchSecret) env.ZHIHU_ACCESS_SECRET = settings.searchSecret;
  return env;
}

// 需要在输出里抹掉的值：环境变量里的 + 本次在界面上填的 + 自动签发的只读令牌。
function secretValues(baseEnv, settings, collectionToken) {
  return collectSecrets({
    ...baseEnv,
    AGENT_API_KEY: settings.apiKey,
    DATA_SERVICE_AGENT_TOKEN: collectionToken ?? settings.agentToken,
    ZHIHU_ACCESS_SECRET: settings.searchSecret,
  });
}

// 先对值做替换再序列化：直接对 JSON 文本做替换会破坏含引号的值。
function redactDeep(value, secrets) {
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item, secrets);
    return out;
  }
  return value;
}

function httpStatusFor(error) {
  if (Number.isInteger(error?.httpStatus)) return error.httpStatus;
  return error?.exitCode === 2 ? 400 : error?.exitCode === 3 ? 409 : error?.exitCode === 130 ? 499 : 500;
}

// 采集服务抛出的错误带自己的 code，原样保留，不用 safeAgentError 压平。
function asSafeError(error, signal) {
  if (error instanceof AgentError) return error;
  if (typeof error?.code === 'string' && typeof error?.message === 'string' && error.message) {
    const wrapped = new AgentError(error.code, error.message, 1);
    wrapped.httpStatus = SERVICE_STATUS[error.code] ?? 502;
    return wrapped;
  }
  return safeAgentError(error, signal);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AgentError('INVALID_ARGUMENTS', '请求体过大。', 2));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new AgentError('INVALID_ARGUMENTS', '请求体不是合法 JSON。', 2));
      }
    });
    request.on('error', (error) => reject(new AgentError('INVALID_ARGUMENTS', `读取请求失败：${error.message}`, 2)));
  });
}

// 跨站页面发来的 POST 会被浏览器带上别的 Origin；没有 Origin 的是本机命令行工具。
function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

// 采集设置的六个字段里，aiReview 由服务端锁死为 false，这里不接受外部改写。
function collectionSettingsFrom(body) {
  const source = body && typeof body === 'object' ? body : {};
  return {
    history: Boolean(source.history),
    likes: Boolean(source.likes),
    collections: Boolean(source.collections),
    knowledgeFilter: source.knowledgeFilter !== false,
    fetchFullText: Boolean(source.fetchFullText),
    aiReview: false,
  };
}

// 保存前挡住两类常见手误：地址不是完整 URL、把地址填进了密钥。
// 否则坏地址只会在提问时变成一句笼统的"内部处理失败"，很难看出是哪一栏错了。
export function assertUsableSettings(settings, submitted = null) {
  if (settings.baseURL) {
    let parsed;
    try {
      parsed = new URL(settings.baseURL);
    } catch {
      throw new AgentError('INVALID_ARGUMENTS', '接口地址必须是完整 URL，例如 https://api.deepseek.com/v1。', 2);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new AgentError('INVALID_ARGUMENTS', '接口地址只支持 http 或 https。', 2);
    }
  }
  // 只检查本次真正提交的密钥：沿用旧值时不该因为历史值而卡住保存。
  const keySubmitted = !submitted || Object.hasOwn(submitted, 'apiKey');
  if (keySubmitted && /^https?:\/\//i.test(settings.apiKey)) {
    throw new AgentError('INVALID_ARGUMENTS', '模型密钥填成了网址，请检查是否和接口地址填反了。', 2);
  }
  return settings;
}

/**
 * 组装 HTTP 服务。除 env、设置与采集组件外全部可注入，测试用假实现即可，不启动子进程、不联网。
 * @returns {{ server: import('node:http').Server, close: () => Promise<void>, getSettings: () => object }}
 */
export function createWebServer({
  env = process.env,
  settings: initialSettings = {},
  loadConfig,
  describeConfig,
  createAgent,
  connectServers,
  persist = async () => {},
  uiFile = UI_FILE,
  collection = null,
  collectionError = null,
  profile: initialProfile = null,
  saveProfile = async () => {},
  saveSecrets = async () => {},
  generate = generateProfile,
  modelFactory = createModel,
  interaction: injectedInteraction = null,
  generateInteractionText,
} = {}) {
  if (typeof loadConfig !== 'function' || typeof describeConfig !== 'function' || typeof createAgent !== 'function') {
    throw new TypeError('createWebServer 需要 loadConfig、describeConfig、createAgent。');
  }

  let settings = sanitizeSettings(initialSettings);
  let config = null;
  let agent = null;
  let history = [];
  let busy = false;
  let controller = null;
  let collectionToken = null;
  let syncTimer = null;
  let profile = initialProfile && typeof initialProfile === 'object' ? initialProfile : null;
  let profileRunning = null;
  const profileState = { status: profile ? 'ready' : 'idle', error: null, at: profile?.generatedAt ?? null, durationMs: null, reason: null };

  // 采集同步的进度状态：前端每 2.5 秒轮询一次 /api/collection/state 时顺带续命。
  const sync = { jobId: null, state: null, error: null, startedAt: 0, lastSeen: 0, lastKeepalive: 0, finishedAt: null, durationMs: null };

  const secrets = () => secretValues(env, settings, collectionToken);

  // 配置只在需要时才构建；设置、令牌、采集地址变化后置空，下一次请求重建。
  function buildEnvNow() {
    const extra = {};
    // 勾了"允许个人数据"才把自动签发的只读令牌交给 Agent，等价于命令行里显式同意。
    if (collection && settings.allowPersonalData && collectionToken) {
      extra.DATA_SERVICE_URL = collection.baseUrl;
      extra.DATA_SERVICE_AGENT_TOKEN = collectionToken;
    }
    return buildEnv({ ...env, ...extra }, settings);
  }

  function currentConfig() {
    if (!config) config = loadConfig({ env: buildEnvNow(), overrides: buildOverrides(settings) });
    return config;
  }

  // 内置只读入口按需签发：只有真要给 Agent 用个人数据时才建，避免无谓的授权记录。
  async function ensureCollectionToken() {
    if (!collection) return null;
    if (collectionToken) return collectionToken;
    try {
      const reader = await collection.ensureReader();
      collectionToken = reader.token;
      config = null;
      return collectionToken;
    } catch {
      collectionToken = null;
      return null;
    }
  }

  async function closeAgent() {
    const current = agent;
    agent = null;
    if (current) {
      try { await current.close(); } catch { /* 关闭失败不影响后续 */ }
    }
  }

  async function resetAgent() {
    await closeAgent();
    await interaction?.resetConnection?.();
    config = null;
  }

  function stopSyncLoop() {
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  }

  // 同步进度轮询：同时负责续调用方租约。页面长时间不轮询就取消任务——"关掉界面即停止采集"。
  // 任务结束的那一刻记下完成时间与耗时，前端据此给出"同步完成"的提示。
  function startSyncLoop() {
    stopSyncLoop();
    syncTimer = setInterval(() => {
      if (!sync.jobId || !collection) { stopSyncLoop(); return; }
      try {
        if (Date.now() - sync.lastSeen > PAGE_IDLE_MS) {
          try { collection.cancelJob(sync.jobId); } catch { /* 任务可能已结束 */ }
          sync.state = 'cancelled';
          sync.error = { code: 'CLIENT_OFFLINE', message: '界面已关闭，同步停止。' };
          markSyncFinished();
          stopSyncLoop();
          return;
        }
        const job = collection.job(sync.jobId);
        sync.state = job?.state ?? sync.state;
        sync.error = job?.error ?? null;
        if (job && (job.state === 'queued' || job.state === 'running')) {
          if (Date.now() - sync.lastKeepalive > KEEPALIVE_MS) {
            collection.keepalive(sync.jobId);
            sync.lastKeepalive = Date.now();
          }
        } else {
          markSyncFinished(job);
          stopSyncLoop();
          // 每次同步成功就在后台重算画像，保证随时都有一份可参考的。
          if (job?.state === 'succeeded') maybeRefreshProfile('sync');
        }
      } catch (error) {
        sync.error = { code: error?.code ?? 'ERROR', message: error?.message ?? '同步状态读取失败。' };
        markSyncFinished();
        stopSyncLoop();
      }
    }, 1500);
    syncTimer.unref?.();
  }

  // 优先用任务自己的 updatedAt 算耗时，和服务端时钟一致，不受轮询间隔影响。
  function markSyncFinished(job = null) {
    if (sync.finishedAt) return;
    const finished = job?.updatedAt ? Date.parse(job.updatedAt) : Date.now();
    const started = job?.createdAt ? Date.parse(job.createdAt) : sync.startedAt;
    sync.finishedAt = Number.isFinite(finished) ? new Date(finished).toISOString() : new Date().toISOString();
    sync.durationMs = Number.isFinite(finished) && Number.isFinite(started) && started > 0
      ? Math.max(0, finished - started)
      : null;
  }

  // ===== 用户画像 =====
  // 取当前快照的记录（分页拼起来，最多 PROFILE_RECORD_LIMIT 条），顺带带上计数。
  function collectProfileRecords() {
    const records = [];
    let counts = null;
    let snapshotId = null;
    let receivedAt = null;
    let offset = 0;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = collection.records({ offset, limit: 20 });
      records.push(...(page.items ?? []));
      counts ??= page.metadata?.counts ?? null;
      snapshotId ??= page.snapshotId ?? null;
      receivedAt ??= page.receivedAt ?? null;
      if (!page.page?.hasMore || records.length >= PROFILE_RECORD_LIMIT) break;
      offset = page.page.nextOffset ?? records.length;
    }
    return { records: records.slice(0, PROFILE_RECORD_LIMIT), counts, snapshotId, receivedAt };
  }

  // 生成画像：失败时保留上一份，绝不把已有的画像清空。
  async function refreshProfile(reason = 'manual') {
    if (profileRunning) return profileRunning;
    profileRunning = (async () => {
      const started = Date.now();
      profileState.status = 'running';
      profileState.error = null;
      profileState.reason = reason;
      try {
        if (!collection) throw new Error('采集组件未启动，没有可画像的数据。');
        const config = currentConfig();
        if (!config.model?.ready) throw new Error('模型还没配置，无法生成画像。');
        const { records, counts, snapshotId, receivedAt } = collectProfileRecords();
        if (!records.length) throw new Error('还没有采集记录，先同步一次。');
        const next = await generate({
          model: createModel(config.model),
          modelName: config.model.modelName,
          records,
          counts,
          snapshotId,
          syncedAt: receivedAt,
        });
        profile = next;
        profileState.status = 'ready';
        profileState.at = next.generatedAt;
        await saveProfile(next);
        return next;
      } catch (error) {
        // 有旧画像就标成 error（还能用），没有就是 failed。
        // 上游原始报错不进界面，统一过一遍 safeAgentError 给出中文短句。
        profileState.status = profile ? 'error' : 'failed';
        profileState.error = safeAgentError(error).message;
        throw error;
      } finally {
        profileState.durationMs = Date.now() - started;
        profileRunning = null;
      }
    })();
    return profileRunning;
  }

  // 只在没有画像、或画像落后于当前快照时刷新；后台触发用，吞掉错误。
  function maybeRefreshProfile(reason) {
    if (!collection) return null;
    let snapshotId = null;
    try {
      snapshotId = collection.status()?.latestSnapshot?.snapshotId ?? null;
    } catch { /* 状态读不到就先不动 */ }
    if (!profile && !snapshotId) return null;
    if (profile && !isStale(profile, snapshotId)) return null;
    return refreshProfile(reason).catch(() => null);
  }

  function profilePayload() {
    let snapshotId = null;
    try { snapshotId = collection?.status()?.latestSnapshot?.snapshotId ?? null; } catch { /* 忽略 */ }
    return {
      profile,
      state: { ...profileState },
      stale: isStale(profile, snapshotId),
      snapshotId,
    };
  }

  async function collectionState() {
    const data = {
      available: Boolean(collection),
      error: collection ? null : (collectionError ?? '采集组件未启动。'),
      builtinReaderId: collection?.readerId ?? null,
      sync: { ...sync },
    };
    if (!collection) return data;
    // 前端轮询到这里就续一次命；同步进行中才算"界面还在"。
    sync.lastSeen = Date.now();
    try {
      data.status = collection.status();
      data.local = await collection.localContext();
      data.readers = collection.readers();
      data.builtinReaderId = collection.readerId;
    } catch (error) {
      const safe = asSafeError(error);
      data.error = safe.message;
      data.errorCode = safe.code;
    }
    return data;
  }

  async function statusPayload() {
    // 勾了个人数据却还没签令牌时补签一次，让状态如实反映"已接上采集"。
    if (settings.allowPersonalData && collection && !collectionToken) await ensureCollectionToken();
    const data = {
      settings: { ...settings },
      busy,
      historyLength: history.length,
    };
    for (const key of SECRET_KEYS) delete data.settings[key];
    for (const key of SECRET_KEYS) data.settings[`${key}Configured`] = Boolean(settings[key]);
    try {
      const description = describeConfig(currentConfig());
      data.config = description;
      data.modelReady = Boolean(description?.model?.modelName && description?.model?.baseURL);
      data.servers = description.servers ?? [];
    } catch (error) {
      const safe = safeAgentError(error);
      data.config = null;
      data.configError = safe.message;
      data.modelReady = false;
      data.servers = [];
    }
    data.collection = { available: Boolean(collection), error: collection ? null : (collectionError ?? '采集组件未启动。') };
    // 采集服务已接管时，界面不再要求手填采集凭证。
    data.collectionAutoToken = Boolean(collection && collectionToken);
    return data;
  }

  function sendJson(response, status, payload) {
    const body = JSON.stringify(redactDeep(payload, secrets()));
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(body);
  }

  const sendOk = (response, data) => sendJson(response, 200, okEnvelope(data));

  async function handleAsk(request, response) {
    if (busy) {
      sendJson(response, 409, errorEnvelope({ code: 'BUSY', message: '上一条提问还没结束，请等它完成或先点停止。' }));
      return;
    }
    const body = await readJson(request);
    const question = text(body.question);
    if (!question) throw new AgentError('INVALID_ARGUMENTS', '问题不能为空。', 2);

    busy = true;
    controller = new AbortController();
    const started = Date.now();
    try {
      // 需要个人数据时先确保只读令牌可用；拿不到就不把采集工具接进来，避免带着坏令牌启动子进程。
      if (settings.allowPersonalData && collection) await ensureCollectionToken();
      if (!agent) {
        agent = await createAgent(currentConfig(), {
          // 每次提问都重新拼提示词：画像更新后无需重建智能体就能生效。
          buildPrompt: ({ enabled }) => buildSystemPrompt({ enabled, profile: profilePromptBlock(profile) }),
        });
      }
      const result = await agent.ask(question, { history, signal: controller.signal });
      const answer = typeof result?.text === 'string' ? result.text : '';
      history = Array.isArray(result?.history) ? result.history : [...history, { role: 'user', content: question }, { role: 'assistant', content: answer }];
      sendOk(response, {
        text: answer,
        // 只保留工具名：参数与结果可能含个人数据，命令行 --json 同样只给名字。
        toolCalls: (result?.toolCalls ?? []).map((call) => ({ name: String(call?.name ?? '') })),
        stepCount: Number.isInteger(result?.stepCount) ? result.stepCount : 0,
        elapsedMs: Date.now() - started,
        historyLength: history.length,
      });
    } catch (error) {
      const safe = asSafeError(error, controller.signal);
      sendJson(response, httpStatusFor(safe), errorEnvelope(safe));
    } finally {
      busy = false;
      controller = null;
    }
  }

  async function handleProbe(request, response) {
    if (typeof connectServers !== 'function') throw new AgentError('INTERNAL_ERROR', '当前未启用连接测试。', 1);
    let active = null;
    try {
      if (settings.allowPersonalData && collection) await ensureCollectionToken();
      active = await connectServers(currentConfig(), { signal: AbortSignal.timeout(45_000) });
      const tools = Object.entries(active.tools ?? {}).map(([name, tool]) => ({
        name,
        description: typeof tool?.description === 'string' ? tool.description.slice(0, 240) : '',
      }));
      sendOk(response, { enabled: [...(active.enabled ?? [])], tools });
    } catch (error) {
      const safe = asSafeError(error);
      sendJson(response, httpStatusFor(safe), errorEnvelope(safe));
    } finally {
      if (active) { try { await active.close(); } catch { /* 尽力回收 */ } }
    }
  }

  async function handleSettings(request, response) {
    const body = await readJson(request);
    const incoming = body.settings && typeof body.settings === 'object' ? body.settings : body;
    const next = sanitizeSettings(incoming);
    // 未提交的密钥沿用旧值（页面上留空表示不修改）；显式提交空串才是清除。
    for (const key of SECRET_KEYS) {
      if (!Object.hasOwn(incoming, key)) next[key] = settings[key];
    }
    assertUsableSettings(next, incoming);
    settings = next;
    await resetAgent();
    history = [];
    await persist(persistedPortion(settings));
    // 密钥单独落盘，重启后自动恢复，不用每次重填。
    await saveSecrets(settings);
    if (settings.allowPersonalData && collection) await ensureCollectionToken();
    // 刚配好模型、又还没有画像时，顺手补一份（不阻塞保存响应）。
    maybeRefreshProfile('settings');
    sendOk(response, await statusPayload());
  }

  // ===== 采集相关路由 =====
  function requireCollection() {
    if (collection) return collection;
    const error = new AgentError('COLLECTION_UNAVAILABLE', collectionError ?? '采集组件未启动，只能使用对话。', 1);
    error.httpStatus = 503;
    throw error;
  }

  async function handleCollectionSync(request, response) {
    const api = requireCollection();
    if (sync.jobId) {
      const current = api.job(sync.jobId);
      if (current && ['queued', 'running'].includes(current.state)) {
        throw new AgentError('BUSY', '已有采集任务在进行，请等待或先停止。', 1);
      }
    }
    const body = await readJson(request);
    const job = api.createJob(body.settings ? collectionSettingsFrom(body.settings) : undefined);
    sync.jobId = job.id;
    sync.state = job.state;
    sync.error = null;
    sync.startedAt = Date.now();
    sync.lastSeen = Date.now();
    sync.lastKeepalive = Date.now();
    sync.finishedAt = null;
    sync.durationMs = null;
    api.keepalive(job.id);
    startSyncLoop();
    sendOk(response, { job, sync: { ...sync } });
  }

  async function handleCollectionRoute(request, response, url, method) {
    const api = requireCollection();
    const path = url.pathname;

    if (path === '/api/collection/state' && method === 'GET') return sendOk(response, await collectionState());
    if (path === '/api/collection/settings' && method === 'POST') {
      const body = await readJson(request);
      return sendOk(response, { settings: api.settings(collectionSettingsFrom(body.settings ?? body)) });
    }
    if (path === '/api/collection/plan' && method === 'POST') {
      const body = await readJson(request);
      const plan = { mode: body.mode === 'page_interval' ? 'page_interval' : 'manual', intervalMinutes: Number(body.intervalMinutes) || 15 };
      return sendOk(response, { plan: api.plan(plan) });
    }
    if (path === '/api/collection/login' && method === 'POST') {
      const body = await readJson(request);
      const next = collectionSettingsFrom(body.settings ?? body);
      // 登录同时携带本次选择的采集范围，与采集服务自己控制台的语义一致。
      const result = await api.login({ consent: true, settings: next });
      return sendOk(response, { ...result, settings: api.settings() });
    }
    if (path === '/api/collection/consent' && method === 'POST') {
      const body = await readJson(request);
      const result = await api.authorize({ consent: true, settings: collectionSettingsFrom(body.settings ?? body) });
      return sendOk(response, result ?? { ok: true });
    }
    if (path === '/api/collection/revoke' && method === 'POST') {
      const result = await api.revokeConsent();
      return sendOk(response, result ?? { revoked: true });
    }
    if (path === '/api/collection/stop' && method === 'POST') {
      stopSyncLoop();
      if (sync.jobId) { try { api.cancelJob(sync.jobId); } catch { /* 任务可能已结束 */ } }
      sync.state = 'cancelled';
      try { markSyncFinished(api.job(sync.jobId)); } catch { markSyncFinished(); }
      const result = await api.stop();
      return sendOk(response, result ?? { stopped: true });
    }
    if (path === '/api/collection/sync' && method === 'POST') return handleCollectionSync(request, response);
    if (path === '/api/collection/cancel' && method === 'POST') {
      stopSyncLoop();
      if (sync.jobId) api.cancelJob(sync.jobId);
      sync.state = 'cancelled';
      try { markSyncFinished(api.job(sync.jobId)); } catch { markSyncFinished(); }
      return sendOk(response, { sync: { ...sync } });
    }
    if (path === '/api/collection/records' && method === 'GET') {
      const query = {
        offset: Number(url.searchParams.get('offset') ?? 0) || 0,
        limit: Math.min(Math.max(Number(url.searchParams.get('limit') ?? 10) || 10, 1), 20),
      };
      return sendOk(response, api.records(query));
    }
    if (path === '/api/collection/export' && method === 'GET') {
      const snapshot = api.exportSnapshot();
      const body = JSON.stringify(snapshot, null, 2);
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="zhihu-collection-${new Date().toISOString().slice(0, 10)}.json"`,
        'cache-control': 'no-store',
      });
      response.end(redactSecrets(body, secrets()));
      return;
    }
    if (path === '/api/collection/clear' && method === 'POST') {
      stopSyncLoop();
      sync.jobId = null;
      sync.state = null;
      sync.error = null;
      sync.finishedAt = null;
      sync.durationMs = null;
      // 本机会话与同意先清，再清服务端数据：顺序反了会留下无法解释的绑定状态。
      let local = null;
      try { local = await api.clearLocal(); } catch (error) { local = { error: error.message }; }
      const server = api.clearServer();
      agent = null;
      config = null;
      return sendOk(response, { local, server });
    }
    if (path === '/api/collection/readers' && method === 'GET') {
      return sendOk(response, { readers: api.readers(), builtinReaderId: api.readerId });
    }
    if (path === '/api/collection/readers' && method === 'POST') {
      const body = await readJson(request);
      const label = text(body.label).slice(0, 80) || '手动创建的入口';
      const created = api.createReader(label);
      // 明文令牌只在这里出现一次，之后服务端只存哈希。
      return sendOk(response, {
        reader: { readerId: created.readerId, label: created.label, createdAt: created.createdAt, readOnly: true },
        agentToken: created.agentToken,
      });
    }
    const readerMatch = path.match(/^\/api\/collection\/readers\/([^/]+)$/);
    if (readerMatch && method === 'DELETE') {
      const id = decodeURIComponent(readerMatch[1]);
      const result = api.revokeReader(id);
      api.forgetReaderIf?.(id);
      if (api.readerId === null) { collectionToken = null; config = null; }
      return sendOk(response, result);
    }
    throw new AgentError('NOT_FOUND', '采集接口不存在。', 1);
  }

  const interaction = injectedInteraction ?? (typeof connectServers === 'function'
    ? createInteractionController({
        getConfig: currentConfig,
        createModel: modelFactory,
        connectServers,
        getProfile: () => profile,
        getCollectionRecords: () => {
          if (!collection) return [];
          try { return collectProfileRecords().records; } catch { return []; }
        },
        ...(typeof generateInteractionText === 'function' ? { generate: generateInteractionText } : {}),
      })
    : null);

  function requireInteraction() {
    if (interaction) return interaction;
    throw new AgentError('INTERNAL_ERROR', '当前未启用交互模块（缺少搜索连接器）。', 1);
  }

  async function handleInteractionRoute(request, response, url, method) {
    const ctrl = requireInteraction();
    const pathname = url.pathname;
    if (pathname === '/api/interaction/state' && method === 'GET') {
      return sendOk(response, ctrl.getState());
    }
    if (pathname === '/api/interaction/topics' && method === 'POST') {
      const body = await readJson(request);
      return sendOk(response, await ctrl.generateViewpoints({ refresh: Boolean(body.refresh) }));
    }
    if (pathname === '/api/interaction/select' && method === 'POST') {
      const body = await readJson(request);
      return sendOk(response, await ctrl.selectViewpoint(text(body.viewpointId)));
    }
    if (pathname === '/api/interaction/act' && method === 'POST') {
      const body = await readJson(request);
      return sendOk(response, await ctrl.submitChoice(text(body.optionId)));
    }
    if (pathname === '/api/interaction/reset' && method === 'POST') {
      return sendOk(response, ctrl.backToSelection());
    }
    if (pathname === '/api/interaction/cancel' && method === 'POST') {
      return sendOk(response, { cancelled: ctrl.cancel() });
    }
    throw new AgentError('NOT_FOUND', '交互模块接口不存在。', 1);
  }

  async function route(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = request.method ?? 'GET';

    if (method === 'POST' && !sameOrigin(request)) {
      sendJson(response, 403, errorEnvelope({ code: 'ORIGIN_DENIED', message: '只接受本页面发起的请求。' }));
      return;
    }

    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/interaction')) {
      const html = await readFile(uiFile);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(html);
      return;
    }
    if (method === 'GET' && url.pathname === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    if (url.pathname.startsWith('/api/collection/')) return handleCollectionRoute(request, response, url, method);
    if (url.pathname.startsWith('/api/interaction/')) {
      try {
        return await handleInteractionRoute(request, response, url, method);
      } catch (error) {
        const safe = asSafeError(error);
        sendJson(response, httpStatusFor(safe), errorEnvelope(safe));
        return;
      }
    }

    if (method === 'GET' && url.pathname === '/api/profile') return sendOk(response, profilePayload());
    if (method === 'POST' && url.pathname === '/api/secrets/clear') {
      for (const key of SECRET_KEYS) settings[key] = '';
      await resetAgent();
      await saveSecrets(settings);
      return sendOk(response, await statusPayload());
    }
    if (method === 'POST' && url.pathname === '/api/profile/refresh') {
      try {
        await refreshProfile('manual');
        return sendOk(response, profilePayload());
      } catch (error) {
        const safe = asSafeError(error);
        sendJson(response, httpStatusFor(safe), errorEnvelope(safe));
        return;
      }
    }

    if (method === 'GET' && url.pathname === '/api/status') return sendOk(response, await statusPayload());
    if (method === 'POST' && url.pathname === '/api/ask') return handleAsk(request, response);
    if (method === 'POST' && url.pathname === '/api/settings') return handleSettings(request, response);
    if (method === 'POST' && url.pathname === '/api/probe') return handleProbe(request, response);
    if (method === 'POST' && url.pathname === '/api/cancel') {
      const cancelled = Boolean(controller);
      controller?.abort();
      return sendOk(response, { cancelled });
    }
    if (method === 'POST' && url.pathname === '/api/reset') {
      controller?.abort();
      await resetAgent();
      history = [];
      return sendOk(response, { historyLength: 0 });
    }

    sendJson(response, 404, errorEnvelope({ code: 'NOT_FOUND', message: '没有这个接口。' }));
  }

  const server = createServer((request, response) => {
    route(request, response).catch((error) => {
      const safe = asSafeError(error);
      if (!response.headersSent) sendJson(response, httpStatusFor(safe), errorEnvelope(safe));
      else response.end();
    });
  });

  return {
    server,
    getSettings: () => ({ ...settings }),
    refreshProfile,
    maybeRefreshProfile,
    getProfile: () => profilePayload(),
    interaction,
    async close() {
      stopSyncLoop();
      controller?.abort();
      if (sync.jobId && collection) { try { collection.cancelJob(sync.jobId); } catch { /* 忽略 */ } }
      await interaction?.close?.();
      await closeAgent();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function readPersistedSettings() {
  try {
    const raw = await readFile(SETTINGS_FILE, 'utf8');
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return blankSettings();
  }
}

async function writeStoredSettings(portion) {
  try {
    await mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
    await writeFile(SETTINGS_FILE, `${JSON.stringify(portion, null, 2)}\n`, 'utf8');
  } catch { /* 落盘失败不影响本次使用 */ }
}

async function readStoredProfile() {
  try {
    const raw = await readFile(PROFILE_FILE, 'utf8');
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function writeStoredProfile(profile) {
  try {
    await mkdir(path.dirname(PROFILE_FILE), { recursive: true });
    await writeFile(PROFILE_FILE, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  } catch { /* 画像落盘失败时，内存里那份仍然可用 */ }
}

// 本机保存的密钥：明文，但单独放一个文件、只给当前用户读写，且 .data/ 已在 .gitignore 里。
// 说明见 agent/README.md：这是本机便利性与"不落盘"之间的取舍，不是安全边界。
async function readStoredSecrets() {
  try {
    const raw = await readFile(SECRETS_FILE, 'utf8');
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') return {};
    const out = {};
    for (const key of SECRET_KEYS) {
      if (typeof value[key] === 'string' && value[key]) out[key] = value[key];
    }
    return out;
  } catch {
    return {};
  }
}

async function writeStoredSecrets(settings) {
  const payload = {};
  for (const key of SECRET_KEYS) {
    if (settings[key]) payload[key] = settings[key];
  }
  try {
    // 全部清空时连文件一起删掉，不留空壳。
    if (Object.keys(payload).length === 0) {
      await rm(SECRETS_FILE, { force: true });
      return;
    }
    await mkdir(path.dirname(SECRETS_FILE), { recursive: true });
    await writeFile(SECRETS_FILE, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    // Windows 上 chmod 基本无效，权限由用户目录 ACL 决定；类 Unix 上把权限收到仅本人。
    await chmod(SECRETS_FILE, 0o600).catch(() => {});
  } catch { /* 落盘失败不影响当前会话使用 */ }
}

function parsePort(argv) {
  const index = argv.indexOf('--port');
  const raw = index >= 0 ? argv[index + 1] : process.env.AGENT_WEB_PORT;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_PORT;
  const value = Number(String(raw).trim());
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new AgentError('INVALID_ARGUMENTS', '端口必须是 1 到 65535 之间的整数。', 2);
  }
  return value;
}

// ===== 入口：只在作为主脚本运行时监听端口 =====
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const argv = process.argv.slice(2);
  const port = parsePort(argv);
  const collectionDemo = argv.includes('--collection-demo');
  const collectionPort = Number(process.env.COLLECTION_PORT || 3005);
  const [{ loadConfig, describeConfig }, { createAgent }, { connectServers }] = await Promise.all([
    import('./config.mjs'),
    import('./agent.mjs'),
    import('./mcp-servers.mjs'),
  ]);

  const persisted = await readPersistedSettings();
  // 上次保存的密钥自动恢复；为空表示还没有或在界面上清除过。
  const storedSecrets = await readStoredSecrets();
  const shutdown = new AbortController();

  // 采集组件是可选依赖：起不来也要让对话能用，错误留给采集页显示。
  let collection = null;
  let collectionError = null;
  try {
    const { startCollection } = await import('./collection.mjs');
    collection = await startCollection({
      demo: collectionDemo,
      port: collectionPort,
      profile: process.env.WORKER_PROFILE || 'default',
      signal: shutdown.signal,
      log: (message) => process.stderr.write(`${message}\n`),
    });
    process.stdout.write(`采集组件已就绪：${collection.baseUrl}${collectionDemo ? '（合成演示）' : ''}\n`);
  } catch (error) {
    collectionError = error?.message ?? '采集组件启动失败。';
    process.stderr.write(`采集组件启动失败：${collectionError}\n`);
  }

  const app = createWebServer({
    env: process.env,
    settings: { ...persisted, ...storedSecrets },
    loadConfig,
    describeConfig,
    createAgent,
    connectServers,
    persist: writeStoredSettings,
    saveSecrets: writeStoredSecrets,
    collection,
    collectionError,
    profile: await readStoredProfile(),
    saveProfile: writeStoredProfile,
  });
  app.server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      process.stderr.write(`端口 ${port} 已被占用，可换一个：node web.mjs --port 3211\n`);
    } else {
      process.stderr.write(`启动失败：${error.message}\n`);
    }
    process.exitCode = 1;
  });
  app.server.listen(port, DEFAULT_HOST, () => {
    process.stdout.write(`图形界面已启动：http://${DEFAULT_HOST}:${port}/（pid ${process.pid}）\n`);
    process.stderr.write('配置在页面里填写；Ctrl+C 停止。\n');
    // 启动时补一次画像：没有画像、或画像落后于当前快照就后台生成，不阻塞启动。
    app.maybeRefreshProfile?.('startup');
  });

  // 进程级兜底：被外部杀掉时没有堆栈可查，至少把两类异常与退出码打到 stderr，
  // 下次能从日志里区分"自己崩了"和"被宿主回收"。
  process.on('uncaughtException', (error) => {
    process.stderr.write(`未捕获异常：${error?.stack ?? error}\n`);
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`未处理的 Promise 拒绝：${reason?.stack ?? reason}\n`);
  });
  process.on('exit', (code) => {
    try { process.stderr.write(`进程退出，code=${code}\n`); } catch { /* 已无法写出 */ }
  });
  const stop = async () => {
    shutdown.abort();
    await app.close();
    try { await collection?.close(); } catch { /* 已关闭 */ }
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
