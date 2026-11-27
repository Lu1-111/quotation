// 「报价」后端 `/v1` HTTP/SSE 同源服务、本机多主体令牌鉴权与流式订阅转发。
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  BackendServiceError,
  DATA_MODES,
  SERVICE_ERROR_CODES,
  TURN_STATUSES,
  apiError,
  apiOk,
} from './protocol.mjs';
import {
  cancelTurnBodySchema,
  createSessionBodySchema,
  createTurnBodySchema,
  parseContract,
  parseLastEventId,
  parsePathId,
  sessionQuerySchema,
} from './http-contracts.mjs';
import {
  DEFAULT_OUTBOUND_EXCERPT_CHARS,
  buildOutboundPersonalManifest,
  isLocalModelEndpoint as isLocalModelEndpointPolicy,
} from './material-policy.mjs';
import {
  sanitizePersonalEvidenceForPreview,
  selectTurnPersonalEvidences,
} from './turn-orchestrator.mjs';

const KNOWN_ERROR_CODES = new Set(SERVICE_ERROR_CODES);
const TERMINAL_TURN_STATUSES = new Set(TURN_STATUSES.filter((status) => status !== 'running'));
const MIN_SECRET_LENGTH = 6;
const REDACTED = '[已隐藏]';

const DEFAULT_STATUS_BY_CODE = Object.freeze({
  INVALID_JSON: 400,
  CONTENT_TYPE: 415,
  BODY_TOO_LARGE: 413,
  INVALID_ARGUMENTS: 400,
  HOST_DENIED: 403,
  ORIGIN_DENIED: 403,
  UNAUTHORIZED: 401,
  TOKEN_REVOKED: 401,
  SESSION_FORBIDDEN: 403,
  DATA_MODE_MISMATCH: 403,
  CLOUD_CONSENT_REQUIRED: 403,
  SESSION_NOT_FOUND: 404,
  TURN_NOT_FOUND: 404,
  CLIENT_REQUEST_ID_CONFLICT: 409,
  TURN_IN_PROGRESS: 409,
  STALE_GRAPH_VERSION: 409,
  RATE_LIMITED: 429,
  UPSTREAM_AUTH: 502,
  MODEL_NOT_CONFIGURED: 503,
  MODEL_ERROR: 502,
  TIMEOUT: 504,
  CANCELLED: 409,
  VERIFICATION_REJECTED: 400,
  INTERNAL_ERROR: 500,
});

function sha256Buffer(value) {
  return createHash('sha256').update(String(value)).digest();
}

function sha256Hex(value) {
  return sha256Buffer(value).toString('hex');
}

function parseStrictOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PUBLIC_ORIGIN 和 ALLOWED_ORIGINS 必须是完整 HTTP/HTTPS 来源。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) {
    throw new Error('PUBLIC_ORIGIN 和 ALLOWED_ORIGINS 必须是完整来源，不含路径或凭据。');
  }
  return url;
}

// 解析监听来源：若未显式固定端口或配置端口为 :0，自动读取 server.address() 实际绑定的 127.0.0.1:<port>。
function resolveEffectiveOrigin(server, configuredOrigin) {
  if (configuredOrigin) {
    let parsed = null;
    try {
      parsed = new URL(configuredOrigin);
    } catch {
      throw new Error('publicOrigin 格式无效。');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('publicOrigin 必须是不含路径与凭据的来源地址。');
    }
    const rawPort = configuredOrigin.slice(`${parsed.protocol}//${parsed.hostname}`.length);
    if (rawPort !== ':0') {
      const strict = parseStrictOrigin(configuredOrigin);
      return { origin: strict.origin, host: strict.host, protocol: strict.protocol };
    }
    const addr = server.address();
    const port = addr && typeof addr === 'object' && Number.isInteger(addr.port) ? addr.port : 3006;
    const dynamicUrl = new URL(`${parsed.protocol}//${parsed.hostname}:${port}`);
    return { origin: dynamicUrl.origin, host: dynamicUrl.host, protocol: dynamicUrl.protocol };
  }

  const addr = server.address();
  if (addr && typeof addr === 'object' && Number.isInteger(addr.port) && addr.port > 0) {
    let hostLiteral = '127.0.0.1';
    if (addr.address === '::1') hostLiteral = '[::1]';
    else if (addr.address && !['0.0.0.0', '::', '::ffff:127.0.0.1', '127.0.0.1'].includes(addr.address)) {
      hostLiteral = addr.address.includes(':') && !addr.address.startsWith('[') ? `[${addr.address}]` : addr.address;
    }
    const dynamicUrl = new URL(`http://${hostLiteral}:${addr.port}`);
    return { origin: dynamicUrl.origin, host: dynamicUrl.host, protocol: dynamicUrl.protocol };
  }

  const fallback = new URL('http://127.0.0.1:3006');
  return { origin: fallback.origin, host: fallback.host, protocol: fallback.protocol };
}

export function isLocalModelEndpoint(baseURL, modelConfig = null) {
  return isLocalModelEndpointPolicy(baseURL, modelConfig);
}

function resolveSessionUsePersonalMaterials(sessionSnapshot, runtimeMeta = null) {
  if (sessionSnapshot?.usePersonalMaterials === false) return false;
  if (sessionSnapshot?.materialsStatus?.state === 'disabled_by_user') return false;
  if (sessionSnapshot?.metadata?.usePersonalMaterials === false) return false;
  if (runtimeMeta?.usePersonalMaterials === false) return false;
  if (typeof sessionSnapshot?.usePersonalMaterials === 'boolean') return sessionSnapshot.usePersonalMaterials;
  if (typeof sessionSnapshot?.metadata?.usePersonalMaterials === 'boolean') return sessionSnapshot.metadata.usePersonalMaterials;
  if (typeof runtimeMeta?.usePersonalMaterials === 'boolean') return runtimeMeta.usePersonalMaterials;
  return true;
}

function resolveSessionCloudConsent(sessionSnapshot, runtimeMeta = null, storeSupportsConsentPersistence = true) {
  if (!storeSupportsConsentPersistence && runtimeMeta && typeof runtimeMeta.cloudConsent === 'boolean') {
    return runtimeMeta.cloudConsent;
  }
  if (typeof sessionSnapshot?.cloudConsent === 'boolean') {
    return sessionSnapshot.cloudConsent;
  }
  if (typeof sessionSnapshot?.allowCloudModel === 'boolean') {
    return sessionSnapshot.allowCloudModel;
  }
  if (sessionSnapshot?.metadata && typeof sessionSnapshot.metadata.cloudConsent === 'boolean') {
    return sessionSnapshot.metadata.cloudConsent;
  }
  if (runtimeMeta && typeof runtimeMeta.cloudConsent === 'boolean') {
    return runtimeMeta.cloudConsent;
  }
  return false;
}

export function buildOutboundPreview({
  modelConfig = null,
  usePersonalMaterials = false,
  cloudConsent = false,
  evidences = [],
  snapshotId = null,
  confirmedOutboundPreviewId = null,
  maxItems,
  maxExcerptChars = DEFAULT_OUTBOUND_EXCERPT_CHARS,
  redact = (s) => String(s ?? ''),
} = {}) {
  return buildOutboundPersonalManifest({
    modelConfig,
    usePersonalMaterials,
    cloudConsent,
    evidences,
    snapshotId,
    confirmedOutboundPreviewId,
    ...(Number.isInteger(maxItems) ? { maxItems } : {}),
    maxExcerptChars,
    redact,
  });
}

function normalizeSecrets(values = []) {
  const filtered = values
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length >= MIN_SECRET_LENGTH);
  return [...new Set(filtered)].sort((a, b) => b.length - a.length);
}

function redactText(input, secrets = []) {
  let output = String(input);
  for (const secret of secrets) {
    output = output.split(secret).join(REDACTED);
  }
  return output;
}

// 多主体 Bearer 凭证鉴别器：仅存 SHA-256 摘要，支持注册、立即吊销与 dataMode 隔离校验。
export function createPrincipalAuth({ tokens = [] } = {}) {
  const entries = new Map();
  const knownSecrets = new Set();

  function registerToken({ token, ownerId, label = 'local-principal', dataMode = null } = {}) {
    if (typeof token !== 'string' || !token.trim()) {
      throw new BackendServiceError('INVALID_ARGUMENTS', '注册凭证的 token 不能为空。', 400);
    }
    if (typeof ownerId !== 'string' || !ownerId.trim()) {
      throw new BackendServiceError('INVALID_ARGUMENTS', '注册凭证的 ownerId 不能为空。', 400);
    }
    if (dataMode !== null && dataMode !== undefined && !DATA_MODES.includes(dataMode)) {
      throw new BackendServiceError('INVALID_ARGUMENTS', '凭证 dataMode 仅允许 demo 或 real。', 400);
    }
    const cleanToken = token.trim();
    const cleanOwnerId = ownerId.trim();
    const digest = sha256Buffer(cleanToken);
    const key = digest.toString('hex');
    if (cleanToken.length >= MIN_SECRET_LENGTH) knownSecrets.add(cleanToken);
    const record = {
      digest,
      ownerId: cleanOwnerId,
      label: typeof label === 'string' && label.trim() ? label.trim() : 'local-principal',
      dataMode: dataMode ?? null,
      revoked: false,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    entries.set(key, record);
    return {
      ownerId: record.ownerId,
      label: record.label,
      dataMode: record.dataMode,
      revoked: false,
    };
  }

  function revokeToken(token) {
    if (typeof token !== 'string' || !token.trim()) return { revoked: false };
    const key = sha256Hex(token.trim());
    const record = entries.get(key);
    if (!record) return { revoked: false };
    record.revoked = true;
    record.revokedAt = new Date().toISOString();
    return { revoked: true, ownerId: record.ownerId };
  }

  function authenticateHeader(authorizationHeader, { expectedDataMode = null } = {}) {
    if (typeof authorizationHeader !== 'string' || !authorizationHeader.startsWith('Bearer ')) {
      throw new BackendServiceError('UNAUTHORIZED', '缺少有效的 Bearer 身份凭证。', 401);
    }
    const rawToken = authorizationHeader.slice(7).trim();
    if (!rawToken) {
      throw new BackendServiceError('UNAUTHORIZED', '缺少有效的 Bearer 身份凭证。', 401);
    }
    return authenticateToken(rawToken, { expectedDataMode });
  }

  function authenticateToken(rawToken, { expectedDataMode = null } = {}) {
    if (typeof rawToken !== 'string' || !rawToken.trim()) {
      throw new BackendServiceError('UNAUTHORIZED', '缺少有效的身份凭证。', 401);
    }
    const candidateDigest = sha256Buffer(rawToken.trim());
    const record = entries.get(candidateDigest.toString('hex'));
    if (!record || !timingSafeEqual(record.digest, candidateDigest)) {
      throw new BackendServiceError('UNAUTHORIZED', '身份凭证无效或未授权。', 401);
    }
    if (record.revoked) {
      throw new BackendServiceError('TOKEN_REVOKED', '身份凭证已被吊销，请重新获取授权。', 401);
    }
    if (expectedDataMode && record.dataMode && record.dataMode !== expectedDataMode) {
      throw new BackendServiceError(
        'DATA_MODE_MISMATCH',
        '凭证绑定的数据模式与当前服务隔离模式不一致，拒绝混用演示与真实数据。',
        403,
      );
    }
    return {
      ownerId: record.ownerId,
      label: record.label,
      dataMode: record.dataMode ?? expectedDataMode,
    };
  }

  for (const item of tokens) {
    registerToken(item);
  }

  return {
    registerToken,
    revokeToken,
    authenticate: authenticateToken,
    authenticateHeader,
    redactionValues: () => [...knownSecrets],
  };
}

// 检查函数首个参数特征，兼容对象入参与位置入参子模块签名。
function firstParamName(fn) {
  if (typeof fn !== 'function') return '';
  const src = Function.prototype.toString.call(fn).trim();
  const match = src.match(/^(?:async\s+)?(?:function(?:\s+\w+)?\s*|\w+\s*)?\(([^)]*)\)/);
  if (!match) return '';
  return match[1].split(',')[0]?.trim() ?? '';
}

function prefersObjectArg(fn) {
  const firstParam = firstParamName(fn);
  if (!firstParam) return false;
  if (firstParam.startsWith('{')) return true;
  const src = Function.prototype.toString.call(fn).trim();
  const match = src.match(/^(?:async\s+)?(?:function(?:\s+\w+)?\s*|\w+\s*)?\(([^)]*)\)/);
  const paramCount = (match?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean).length;
  if (paramCount === 1) {
    const cleanName = firstParam.split('=')[0].trim();
    if (!['ownerId', 'userId', 'sessionId', 'ownerIdOrOptions'].includes(cleanName)) return true;
  }
  return false;
}

function toBackendError(error) {
  if (error instanceof BackendServiceError) return error;
  if (error && typeof error === 'object' && typeof error.code === 'string') {
    if (KNOWN_ERROR_CODES.has(error.code)) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
        ? error.status
        : (DEFAULT_STATUS_BY_CODE[error.code] ?? 400);
      const message = typeof error.message === 'string' && error.message.trim()
        ? error.message
        : '请求未能通过服务校验。';
      return new BackendServiceError(error.code, message, status, null);
    }
    if (error.code === 'NOT_FOUND') {
      return new BackendServiceError('SESSION_NOT_FOUND', error.message || '请求的资源不存在。', 404);
    }
  }
  return new BackendServiceError('INTERNAL_ERROR', '服务内部处理失败，请检查本机服务运行状态。', 500);
}

function emitSafeLog(logger, entry) {
  if (!logger) return;
  const safeEntry = {
    method: String(entry.method ?? 'UNKNOWN'),
    route: String(entry.route ?? '/unknown'),
    status: Number.isInteger(entry.status) ? entry.status : 500,
    latencyMs: Math.max(0, Math.round(Number(entry.latencyMs) || 0)),
    errorCode: entry.errorCode ? String(entry.errorCode) : null,
  };
  try {
    if (typeof logger === 'function') logger(safeEntry);
    else if (typeof logger.info === 'function') logger.info(safeEntry);
  } catch {
    // 日志输出异常不影响主请求链路。
  }
}

async function readJsonBody(request, { maxBodyBytes, allowEmpty = false, emptyFallback = undefined }) {
  const contentType = request.headers['content-type'];
  const contentLengthHeader = request.headers['content-length'];
  if (contentLengthHeader !== undefined && Number(contentLengthHeader) > maxBodyBytes) {
    throw new BackendServiceError('BODY_TOO_LARGE', '请求体超过单次大小限制。', 413);
  }
  if (contentType !== undefined && !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new BackendServiceError('CONTENT_TYPE', '请求体 Content-Type 需为 application/json。', 415);
  }

  let totalBytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxBodyBytes) {
      throw new BackendServiceError('BODY_TOO_LARGE', '请求体超过单次大小限制。', 413);
    }
    chunks.push(chunk);
  }

  if (totalBytes === 0) {
    if (allowEmpty) return emptyFallback;
    if (!contentType) {
      throw new BackendServiceError('CONTENT_TYPE', '请求体 Content-Type 需为 application/json。', 415);
    }
    throw new BackendServiceError('INVALID_JSON', '请求体不能为空。', 400);
  }

  if (!contentType) {
    throw new BackendServiceError('CONTENT_TYPE', '请求体 Content-Type 需为 application/json。', 415);
  }

  const rawText = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(rawText);
  } catch {
    throw new BackendServiceError('INVALID_JSON', '请求体不是有效的 JSON。', 400);
  }
}

async function invokeCreateSession(store, ownerId, payload) {
  if (typeof store?.createSession !== 'function') {
    throw new BackendServiceError('INTERNAL_ERROR', '会话存储未实现 createSession。', 500);
  }
  if (prefersObjectArg(store.createSession)) {
    return store.createSession({ ownerId, ...payload });
  }
  return store.createSession(ownerId, payload);
}

async function invokeGetSession(store, ownerId, sessionId) {
  const fn = store?.getSession ?? store?.getSessionSnapshot ?? store?.session;
  if (typeof fn !== 'function') {
    throw new BackendServiceError('INTERNAL_ERROR', '会话存储未实现 getSession。', 500);
  }
  const snapshot = prefersObjectArg(fn)
    ? await fn.call(store, { ownerId, sessionId })
    : await fn.call(store, ownerId, sessionId);
  if (!snapshot) {
    throw new BackendServiceError('SESSION_NOT_FOUND', '指定的会话不存在。', 404);
  }
  if (snapshot.ownerId && snapshot.ownerId !== ownerId) {
    throw new BackendServiceError('SESSION_FORBIDDEN', '无权访问其他主体的会话。', 403);
  }
  return snapshot;
}

async function invokeLookupItem(store, ownerId, sessionId, lookupId) {
  if (typeof store?.getFactOrTurnById !== 'function') return null;
  if (prefersObjectArg(store.getFactOrTurnById)) {
    return store.getFactOrTurnById({ ownerId, sessionId, lookupId, id: lookupId });
  }
  return store.getFactOrTurnById(ownerId, sessionId, lookupId);
}

async function invokeUpdateSessionConsent(store, ownerId, sessionId, patch) {
  if (typeof store?.updateSessionConsent !== 'function') return null;
  if (prefersObjectArg(store.updateSessionConsent)) {
    return store.updateSessionConsent({ ownerId, sessionId, ...patch });
  }
  return store.updateSessionConsent(ownerId, sessionId, patch);
}

async function invokeFailTurn(store, ownerId, sessionId, turnId, errorInfo) {
  if (typeof store?.failTurn !== 'function') return;
  if (prefersObjectArg(store.failTurn)) {
    await store.failTurn({ ownerId, sessionId, turnId, ...errorInfo, error: errorInfo });
    return;
  }
  const first = firstParamName(store.failTurn).split('=')[0].trim();
  if (first === 'sessionId') {
    await store.failTurn(sessionId, turnId, errorInfo);
    return;
  }
  await store.failTurn(ownerId, sessionId, turnId, errorInfo);
}

async function invokeCancelTurn({ orchestrator, store, ownerId, sessionId, turnId, reason }) {
  const target = typeof orchestrator?.cancelTurn === 'function' ? orchestrator : store;
  const fn = target?.cancelTurn;
  if (typeof fn !== 'function') {
    throw new BackendServiceError('INTERNAL_ERROR', '服务未实现 cancelTurn。', 500);
  }
  if (prefersObjectArg(fn)) {
    return fn.call(target, { ownerId, sessionId, turnId, reason });
  }
  return fn.call(target, ownerId, sessionId, turnId, { reason });
}

async function invokeExecuteTurn(orchestrator, context) {
  const fn = orchestrator?.executeTurn ?? orchestrator?.runTurn;
  if (typeof fn !== 'function') {
    throw new BackendServiceError('MODEL_NOT_CONFIGURED', '未配置轮次流式编排器，无法执行新轮次。', 503);
  }
  if (prefersObjectArg(fn)) {
    return fn.call(orchestrator, context);
  }
  return fn.call(orchestrator, context.ownerId, context.sessionId, context.turnId, context);
}

async function loadPersonalMaterials({
  materialLoader,
  ownerId,
  dataMode,
  snapshotId,
  explicitlyForced,
}) {
  const loaderFn = typeof materialLoader === 'function'
    ? materialLoader
    : (materialLoader?.loadMaterials ?? materialLoader?.load ?? materialLoader?.loadInitialMaterials ?? null);

  if (!loaderFn || materialLoader?.enabled === false) {
    return {
      lockedSnapshotId: null,
      evidences: [],
      materialsStatus: {
        state: 'unconfigured',
        source: 'none',
        count: 0,
        message: '未启用个人采集只读入口，已从本人输入开始空材料会话。',
      },
    };
  }

  let loaded;
  try {
    loaded = await loaderFn.call(materialLoader, { ownerId, dataMode, snapshotId });
  } catch (error) {
    const mapped = toBackendError(error);
    if (['DATA_MODE_MISMATCH', 'CLOUD_CONSENT_REQUIRED', 'UNAUTHORIZED', 'TOKEN_REVOKED', 'SESSION_FORBIDDEN'].includes(mapped.code)) {
      throw mapped;
    }
    // 显式指定 snapshotId 或显式强制使用个人材料时保留错误；默认尝试读取但无快照/未就绪时回退为空材料会话。
    if (snapshotId || explicitlyForced) {
      throw mapped;
    }
    return {
      lockedSnapshotId: null,
      evidences: [],
      materialsStatus: {
        state: 'empty',
        source: 'none',
        count: 0,
        reasonCode: mapped.code,
        message: '暂未读取到可用的个人采集快照，已从本人输入开始空材料会话。',
      },
    };
  }

  if (!loaded) {
    return {
      lockedSnapshotId: null,
      evidences: [],
      materialsStatus: {
        state: 'empty',
        source: 'none',
        count: 0,
        message: '当前无已保存的个人采集快照，已从本人输入开始空材料会话。',
      },
    };
  }

  const snapshotMode = loaded.dataMode
    ?? (loaded.source === 'demo_history' ? 'demo' : loaded.source === 'zhihu_selected_data' ? 'real' : null);
  if (snapshotMode && snapshotMode !== dataMode) {
    throw new BackendServiceError(
      'DATA_MODE_MISMATCH',
      '个人采集快照的数据模式与当前服务隔离模式不一致，拒绝混用演示与真实数据。',
      403,
    );
  }

  if (loaded.status && loaded.status !== 'ok') {
    if (snapshotId || explicitlyForced) {
      const code = loaded.errorCode === 'NOT_FOUND' ? 'INVALID_ARGUMENTS' : 'UPSTREAM_AUTH';
      throw new BackendServiceError(code, loaded.message || '读取指定的个人采集材料快照失败。', 400);
    }
    return {
      lockedSnapshotId: null,
      evidences: [],
      materialsStatus: {
        state: loaded.status === 'not_configured' ? 'unconfigured' : 'empty',
        source: 'none',
        count: 0,
        reasonCode: loaded.errorCode ?? loaded.status,
        message: loaded.message || '未读取到可用的个人采集材料，已从本人输入开始空材料会话。',
      },
    };
  }

  const snapshotMismatched = loaded.materialsStatus?.reasonCode === 'SNAPSHOT_MISMATCH'
    || loaded.materialsStatus?.reasonCode === 'NOT_FOUND';
  const lockedSnapshotId = loaded.lockedSnapshotId
    ?? loaded.snapshotId
    ?? (snapshotMismatched ? null : (snapshotId ?? null));
  const evidences = Array.isArray(loaded.evidences)
    ? loaded.evidences
    : Array.isArray(loaded.evidence)
      ? loaded.evidence
      : Array.isArray(loaded.materials)
        ? loaded.materials
        : Array.isArray(loaded.records)
          ? loaded.records
          : Array.isArray(loaded.items)
            ? loaded.items
            : [];

  return {
    lockedSnapshotId,
    evidences,
    materialsStatus: loaded.materialsStatus ?? {
      state: evidences.length > 0 ? 'loaded' : 'empty',
      source: evidences.length > 0 ? 'collection' : 'none',
      count: evidences.length,
      lockedSnapshotId,
      message: evidences.length > 0
        ? `已锁定快照并载入 ${evidences.length} 条已授权个人材料。`
        : '采集入口已连接但当前无材料记录，将从本人输入开始会话。',
    },
  };
}

export function createQuotationServer({
  store,
  orchestrator = null,
  auth = createPrincipalAuth(),
  materialLoader = null,
  dataMode = 'demo',
  modelConfig = null,
  config = null,
  publicOrigin = null,
  allowedOrigins = [],
  maxBodyBytes = 1024 * 1024,
  sseHeartbeatMs = 15_000,
  secrets = [],
  logger = null,
} = {}) {
  if (!DATA_MODES.includes(dataMode)) {
    throw new Error(`服务 dataMode 必须是 demo 或 real，收到：${String(dataMode)}`);
  }
  if (!store) {
    throw new Error('createQuotationServer 需要提供 store 实例。');
  }

  const effectiveModel = modelConfig ?? config?.model ?? null;
  const staticAllowedOrigins = allowedOrigins.map((item) => parseStrictOrigin(item).origin);
  if (publicOrigin && !publicOrigin.endsWith(':0')) {
    parseStrictOrigin(publicOrigin);
  }

  // 跟踪运行中轮次的取消控制器，供主动 cancel 端点在验证所有权后触发中止信号。
  const activeTurnControllers = new Map();
  // 记录会话级云推理授权与个人材料状态，供后续轮次复核。
  const sessionRuntimeMeta = new Map();

  function currentSecrets() {
    const extra = [
      ...(Array.isArray(secrets) ? secrets : []),
      effectiveModel?.apiKey ?? null,
      ...(typeof auth?.redactionValues === 'function' ? auth.redactionValues() : []),
    ];
    return normalizeSecrets(extra);
  }

  const server = createServer(async (request, response) => {
    const startedAt = performance.now();
    let matchedRoute = '/unknown';

    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Vary', 'Origin');

    const sendJson = (status, payload, errorCode = null) => {
      if (!response.destroyed && !response.writableEnded) {
        const serialized = redactText(JSON.stringify(payload), currentSecrets());
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(serialized);
      }
      emitSafeLog(logger, {
        method: request.method,
        route: matchedRoute,
        status,
        latencyMs: performance.now() - startedAt,
        errorCode,
      });
    };

    try {
      const effective = resolveEffectiveOrigin(server, publicOrigin);
      const allowedSet = new Set([effective.origin, ...staticAllowedOrigins]);

      if (request.headers.host !== effective.host) {
        throw new BackendServiceError('HOST_DENIED', '请求 Host 与服务监听来源不一致。', 403);
      }

      const requestOrigin = request.headers.origin;
      if (requestOrigin && !allowedSet.has(requestOrigin)) {
        throw new BackendServiceError('ORIGIN_DENIED', '网页 Origin 不在允许的同源列表。', 403);
      }
      if (requestOrigin) {
        response.setHeader('Access-Control-Allow-Origin', requestOrigin);
      }

      if (request.method === 'OPTIONS') {
        matchedRoute = '/preflight';
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Last-Event-ID');
        response.writeHead(204);
        response.end();
        emitSafeLog(logger, {
          method: 'OPTIONS',
          route: matchedRoute,
          status: 204,
          latencyMs: performance.now() - startedAt,
          errorCode: null,
        });
        return;
      }

      const url = new URL(request.url ?? '/', effective.origin);
      const pathname = url.pathname;
      const method = request.method ?? 'GET';

      // 1. GET /health
      if (pathname === '/health' && method === 'GET') {
        matchedRoute = '/health';
        sendJson(200, apiOk({ service: 'quotation-agent-backend', dataMode }));
        return;
      }

      // 路由预匹配（用于精确日志模板及 404 区分，仍在各自路由入口优先做鉴权）。
      const sessionMatch = pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      const turnsCollectionMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/turns$/);
      const turnEventsMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/turns\/([^/]+)\/events$/);
      const turnCancelMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/turns\/([^/]+)\/cancel$/);

      if (pathname === '/v1/sessions' && method === 'POST') matchedRoute = '/v1/sessions';
      else if (sessionMatch && method === 'GET') matchedRoute = '/v1/sessions/:id';
      else if (turnsCollectionMatch && method === 'POST') matchedRoute = '/v1/sessions/:id/turns';
      else if (turnEventsMatch && method === 'GET') matchedRoute = '/v1/sessions/:id/turns/:turnId/events';
      else if (turnCancelMatch && method === 'POST') matchedRoute = '/v1/sessions/:id/turns/:turnId/cancel';

      // 所有非 /health 端点统一先鉴别 Bearer 主体凭证与 dataMode。
      const principal = typeof auth.authenticateHeader === 'function'
        ? auth.authenticateHeader(request.headers.authorization, { expectedDataMode: dataMode })
        : auth.authenticate(
          typeof request.headers.authorization === 'string' && request.headers.authorization.startsWith('Bearer ')
            ? request.headers.authorization.slice(7).trim()
            : '',
          { expectedDataMode: dataMode },
        );
      const ownerId = principal.ownerId;

      // 2. POST /v1/sessions
      if (pathname === '/v1/sessions' && method === 'POST') {
        const rawBody = await readJsonBody(request, {
          maxBodyBytes,
          allowEmpty: true,
          emptyFallback: {},
        });
        const body = parseContract(createSessionBodySchema, rawBody ?? {});

        if (body.dataMode && body.dataMode !== dataMode) {
          throw new BackendServiceError(
            'DATA_MODE_MISMATCH',
            `请求的数据模式（${body.dataMode}）与当前服务隔离模式（${dataMode}）不一致，严禁混用演示与真实数据。`,
            403,
          );
        }

        const loaderAvailable = Boolean(materialLoader && materialLoader.enabled !== false);
        const wantsPersonalMaterials = body.usePersonalMaterials === false
          ? false
          : (loaderAvailable || body.usePersonalMaterials === true);
        const cloudConsentInput = body.cloudConsent ?? null;
        const cloudConsentGranted = body.cloudConsent === true;
        const isCloudModelTarget = !isLocalModelEndpointPolicy(effectiveModel?.baseURL ?? null, effectiveModel);

        let lockedSnapshotId = null;
        let evidences = [];
        let materialsStatus = {
          state: body.usePersonalMaterials === false ? 'disabled_by_user' : 'unconfigured',
          source: 'none',
          count: 0,
          message: body.usePersonalMaterials === false
            ? '本次会话已按请求跳过个人采集材料，直接从本人输入开始。'
            : '未配置个人采集材料入口，直接从本人输入开始空材料会话。',
        };

        if (body.usePersonalMaterials !== false && (loaderAvailable || body.usePersonalMaterials === true)) {
          let loaded;
          try {
            loaded = await loadPersonalMaterials({
              materialLoader,
              ownerId,
              dataMode,
              snapshotId: body.snapshotId,
              explicitlyForced: body.usePersonalMaterials === true,
            });
            if (
              isCloudModelTarget
              && body.snapshotId
              && loaded.evidences.length === 0
              && (
                loaded.materialsStatus?.reasonCode === 'SNAPSHOT_MISMATCH'
                || loaded.materialsStatus?.reasonCode === 'NOT_FOUND'
              )
            ) {
              const latestLoaded = await loadPersonalMaterials({
                materialLoader,
                ownerId,
                dataMode,
                snapshotId: undefined,
                explicitlyForced: false,
              }).catch(() => null);
              if (latestLoaded && Array.isArray(latestLoaded.evidences) && latestLoaded.evidences.length > 0) {
                loaded = latestLoaded;
              }
            }
          } catch (loadErr) {
            const mappedErr = toBackendError(loadErr);
            if (isCloudModelTarget && body.snapshotId && mappedErr.code === 'INVALID_ARGUMENTS') {
              const latestLoaded = await loadPersonalMaterials({
                materialLoader,
                ownerId,
                dataMode,
                snapshotId: undefined,
                explicitlyForced: false,
              }).catch(() => null);
              if (latestLoaded && Array.isArray(latestLoaded.evidences) && latestLoaded.evidences.length > 0) {
                loaded = latestLoaded;
              } else {
                throw mappedErr;
              }
            } else {
              throw loadErr;
            }
          }
          lockedSnapshotId = loaded.lockedSnapshotId;
          evidences = loaded.evidences;
          materialsStatus = loaded.materialsStatus;
        } else if (body.snapshotId) {
          throw new BackendServiceError(
            'INVALID_ARGUMENTS',
            '未启用个人材料读取时不能指定采集 snapshotId。',
            400,
          );
        }

        const persistedUsePersonalMaterials = Boolean(
          evidences.length > 0 && body.usePersonalMaterials !== false
            ? true
            : (body.usePersonalMaterials === false ? false : wantsPersonalMaterials),
        );

        const activeSecrets = currentSecrets();
        const redactFn = (s) => redactText(s, activeSecrets);
        const persistedEvidences = persistedUsePersonalMaterials
          ? evidences.map((ev) => {
              if (!ev || typeof ev !== 'object') return ev;
              const withSnapshot = lockedSnapshotId && !ev.snapshotId
                ? { ...ev, snapshotId: lockedSnapshotId }
                : ev;
              const sanitized = sanitizePersonalEvidenceForPreview(withSnapshot, activeSecrets);
              if (!sanitized) return withSnapshot;
              return {
                ...withSnapshot,
                id: sanitized.id,
                evidenceId: sanitized.evidenceId,
                contentKey: sanitized.contentKey,
                sourceType: sanitized.sourceType,
                locator: sanitized.locator,
                textKind: sanitized.textKind,
                snapshotId: sanitized.snapshotId,
                truncated: sanitized.truncated,
                summaryTruncated: sanitized.summaryTruncated,
                excerpt: sanitized.excerpt,
              };
            })
          : [];
        const normalizedPreviewEvidences = persistedUsePersonalMaterials
          ? persistedEvidences.map((ev) => sanitizePersonalEvidenceForPreview(ev, activeSecrets) ?? ev)
          : [];

        const rawSessionPreview = buildOutboundPreview({
          modelConfig: effectiveModel,
          usePersonalMaterials: persistedUsePersonalMaterials && (evidences.length > 0 || body.usePersonalMaterials === true),
          cloudConsent: cloudConsentGranted,
          evidences: normalizedPreviewEvidences,
          snapshotId: lockedSnapshotId,
          redact: redactFn,
        });

        const effectiveSnapshotId = lockedSnapshotId ?? rawSessionPreview.snapshotId ?? null;
        const previewIdMatches = typeof body.outboundPreviewId === 'string'
          && body.outboundPreviewId === rawSessionPreview.outboundPreviewId;
        const snapshotMatches = !effectiveSnapshotId
          || (typeof body.snapshotId === 'string' && body.snapshotId === effectiveSnapshotId);
        const hasExplicitPreviewConfirmation = Boolean(
          cloudConsentGranted
          && rawSessionPreview.items.length > 0
          && previewIdMatches
          && snapshotMatches,
        );

        // 本机回环推理地址在 demo / real 下均不触发云同意门禁；非回环云模型且拟外发清单包含个人片段时，
        // 必须先预览实际清单，再携带 cloudConsent: true、匹配的 outboundPreviewId 及当前 snapshotId 确认后才创建已确认会话。
        if (
          rawSessionPreview.isCloudModel
          && persistedUsePersonalMaterials
          && rawSessionPreview.items.length > 0
          && !hasExplicitPreviewConfirmation
        ) {
          const unconfirmedPreview = {
            ...rawSessionPreview,
            cloudConsentGranted: false,
            confirmedOutboundPreviewId: null,
            previewConfirmed: false,
            snapshotId: effectiveSnapshotId,
            lockedSnapshotId: effectiveSnapshotId,
          };
          let reasonMessage = '当前配置为非本机云推理模型，请先核对拟外发个人材料预览清单，再携带 cloudConsent: true、匹配的 outboundPreviewId 与 snapshotId 确认创建会话。';
          if (cloudConsentGranted && !previewIdMatches) {
            reasonMessage = '创建会话时缺少或提交了不匹配的 outboundPreviewId，请核对最新拟外发个人材料预览清单后重新确认。';
          } else if (cloudConsentGranted && !snapshotMatches) {
            reasonMessage = '创建会话时缺少或提交了与当前采集快照不一致的 snapshotId，请核对最新拟外发个人材料预览清单后重新确认。';
          }
          throw new BackendServiceError(
            'CLOUD_CONSENT_REQUIRED',
            reasonMessage,
            403,
            { outboundPreview: unconfirmedPreview },
          );
        }

        const initialConfirmedPreviewId = hasExplicitPreviewConfirmation ? rawSessionPreview.outboundPreviewId : null;
        const initialConfirmedSnippets = hasExplicitPreviewConfirmation ? rawSessionPreview.items : [];
        const outboundPreview = {
          ...rawSessionPreview,
          snapshotId: effectiveSnapshotId,
          lockedSnapshotId: effectiveSnapshotId,
          confirmedOutboundPreviewId: initialConfirmedPreviewId,
          previewConfirmed: hasExplicitPreviewConfirmation,
        };

        const created = await invokeCreateSession(store, ownerId, {
          dataMode,
          usePersonalMaterials: persistedUsePersonalMaterials,
          lockedSnapshotId: effectiveSnapshotId,
          evidences: persistedEvidences,
          initialEvidence: persistedEvidences,
          initialEvidences: persistedEvidences,
          materials: persistedEvidences,
          materialsStatus,
          outboundPreview,
          confirmedOutboundPreviewId: initialConfirmedPreviewId,
          confirmedOutboundSnippets: initialConfirmedSnippets,
          cloudConsent: cloudConsentInput,
          initialText: body.initialText ?? null,
          ...(body.initialGraph !== undefined ? { initialGraph: body.initialGraph } : {}),
          metadata: {
            ...(body.metadata ?? {}),
            usePersonalMaterials: persistedUsePersonalMaterials,
            materialsStatus,
            cloudConsent: cloudConsentInput,
            ...(body.initialText ? { initialText: body.initialText } : {}),
          },
        });

        const sessionId = created.sessionId ?? created.id;
        const resolvedUsePersonalMaterials = body.usePersonalMaterials === false
          ? false
          : (typeof created?.usePersonalMaterials === 'boolean'
              ? created.usePersonalMaterials
              : persistedUsePersonalMaterials);

        // 与预览阶段保持同一规范化口径，确认落库后的 evidenceIndex、outboundPreviewId 与已确认清单 100% 对齐。
        let finalOutboundPreview = created.outboundPreview ?? outboundPreview;
        let finalConfirmedPreviewId = initialConfirmedPreviewId;
        let finalConfirmedSnippets = initialConfirmedSnippets;
        if (
          resolvedUsePersonalMaterials
          && Array.isArray(created?.evidenceIndex)
          && created.evidenceIndex.length > 0
        ) {
          const finalSnapshotId = created.lockedSnapshotId ?? effectiveSnapshotId ?? null;
          const persistedCollection = created.evidenceIndex
            .filter((e) => e?.sourceType === 'collection_record')
            .map((ev) => sanitizePersonalEvidenceForPreview(ev, activeSecrets) ?? ev);
          const alignedPreview = buildOutboundPreview({
            modelConfig: effectiveModel,
            usePersonalMaterials: true,
            cloudConsent: cloudConsentGranted,
            evidences: persistedCollection,
            snapshotId: finalSnapshotId,
            confirmedOutboundPreviewId: initialConfirmedPreviewId,
            redact: redactFn,
          });
          const alignedConfirmed = Boolean(
            hasExplicitPreviewConfirmation
            && alignedPreview.items.length > 0
            && alignedPreview.outboundPreviewId === rawSessionPreview.outboundPreviewId,
          );
          finalConfirmedPreviewId = alignedConfirmed ? alignedPreview.outboundPreviewId : null;
          finalConfirmedSnippets = alignedConfirmed ? alignedPreview.items : [];
          finalOutboundPreview = {
            ...alignedPreview,
            snapshotId: finalSnapshotId,
            lockedSnapshotId: finalSnapshotId,
            confirmedOutboundPreviewId: finalConfirmedPreviewId,
            previewConfirmed: alignedConfirmed,
          };
          if (typeof store.updateSessionConsent === 'function') {
            await invokeUpdateSessionConsent(store, ownerId, sessionId, {
              cloudConsent: cloudConsentInput,
              confirmedOutboundPreviewId: finalConfirmedPreviewId,
              confirmedOutboundSnippets: finalConfirmedSnippets,
              outboundPreview: finalOutboundPreview,
              expectedDataMode: dataMode,
            });
          }
        }

        sessionRuntimeMeta.set(sessionId, {
          usePersonalMaterials: resolvedUsePersonalMaterials,
          hasPersonalMaterials: resolvedUsePersonalMaterials && (evidences.length > 0 || Boolean(lockedSnapshotId)),
          cloudConsent: cloudConsentInput,
          confirmedOutboundPreviewId: finalConfirmedPreviewId,
          confirmedOutboundSnippets: finalConfirmedSnippets,
        });

        sendJson(201, apiOk({
          sessionId,
          ownerId: created.ownerId ?? ownerId,
          graphVersion: created.graphVersion ?? 0,
          dataMode: created.dataMode ?? dataMode,
          usePersonalMaterials: resolvedUsePersonalMaterials,
          lockedSnapshotId: created.lockedSnapshotId ?? lockedSnapshotId ?? null,
          materialsStatus: created.materialsStatus ?? materialsStatus,
          outboundPreview: finalOutboundPreview,
        }));
        return;
      }

      // 3. POST /v1/sessions/:id/turns
      if (turnsCollectionMatch && method === 'POST') {
        const sessionId = parsePathId(turnsCollectionMatch[1], 'id');
        const rawBody = await readJsonBody(request, { maxBodyBytes, allowEmpty: false });
        const body = parseContract(createTurnBodySchema, rawBody);

        // 先校验会话存在性、主体所有权与数据模式隔离。
        const sessionSnapshot = await invokeGetSession(store, ownerId, sessionId);
        if (sessionSnapshot.dataMode && sessionSnapshot.dataMode !== dataMode) {
          throw new BackendServiceError(
            'DATA_MODE_MISMATCH',
            '会话数据模式与当前服务隔离模式不一致。',
            403,
          );
        }

        const storePersistsConsent = typeof store.updateSessionConsent === 'function';
        const runtimeMeta = sessionRuntimeMeta.get(sessionId) ?? null;
        const sessionUsePersonalMaterials = resolveSessionUsePersonalMaterials(sessionSnapshot, runtimeMeta);
        const sessionEvidenceList = Array.isArray(sessionSnapshot.evidenceIndex)
          ? sessionSnapshot.evidenceIndex
          : (Array.isArray(sessionSnapshot.evidences) ? sessionSnapshot.evidences : []);
        const turnUsesPersonalMaterials = sessionUsePersonalMaterials && (
          Boolean(sessionSnapshot.lockedSnapshotId)
          || sessionEvidenceList.some((e) => e?.sourceType === 'collection_record')
          || Boolean(materialLoader && materialLoader.enabled !== false && sessionSnapshot.materialsStatus?.state === 'loaded')
          || Boolean(runtimeMeta?.hasPersonalMaterials)
        );

        const activeSecrets = currentSecrets();
        const redactFn = (s) => redactText(s, activeSecrets);
        const selectedTurnPersonalEvidences = turnUsesPersonalMaterials
          ? selectTurnPersonalEvidences({
              sessionSnapshot,
              text: body.text,
              focusRef: body.focusRef ?? null,
              action: body.action ?? null,
              secrets: activeSecrets,
            })
          : [];

        const persistedConsent = resolveSessionCloudConsent(sessionSnapshot, runtimeMeta, storePersistsConsent);
        const persistedConfirmedPreviewId = storePersistsConsent
          ? (sessionSnapshot.confirmedOutboundPreviewId ?? sessionSnapshot.outboundPreview?.confirmedOutboundPreviewId ?? null)
          : (runtimeMeta?.confirmedOutboundPreviewId ?? sessionSnapshot.confirmedOutboundPreviewId ?? null);
        const persistedConfirmedSnippets = storePersistsConsent
          ? (Array.isArray(sessionSnapshot.confirmedOutboundSnippets) ? sessionSnapshot.confirmedOutboundSnippets : [])
          : (Array.isArray(runtimeMeta?.confirmedOutboundSnippets) ? runtimeMeta.confirmedOutboundSnippets : []);

        // 若请求体显式传 cloudConsent: false：先持久化撤回 + 同步内存 + 取消该会话正在运行的云端个人材料轮次！
        if (body.cloudConsent === false) {
          const revokedTurnPreview = buildOutboundPreview({
            modelConfig: effectiveModel,
            usePersonalMaterials: turnUsesPersonalMaterials,
            cloudConsent: false,
            evidences: selectedTurnPersonalEvidences,
            snapshotId: sessionSnapshot.lockedSnapshotId ?? null,
            confirmedOutboundPreviewId: null,
            redact: redactFn,
          });
          const revokedSessionPreview = buildOutboundPreview({
            modelConfig: effectiveModel,
            usePersonalMaterials: turnUsesPersonalMaterials,
            cloudConsent: false,
            evidences: selectedTurnPersonalEvidences.length > 0
              ? selectedTurnPersonalEvidences
              : (turnUsesPersonalMaterials
                  ? sessionEvidenceList
                      .filter((e) => e?.sourceType === 'collection_record')
                      .map((ev) => sanitizePersonalEvidenceForPreview(ev, activeSecrets) ?? ev)
                  : []),
            snapshotId: sessionSnapshot.lockedSnapshotId ?? null,
            confirmedOutboundPreviewId: null,
            redact: redactFn,
          });

          if (storePersistsConsent) {
            await invokeUpdateSessionConsent(store, ownerId, sessionId, {
              cloudConsent: false,
              confirmedOutboundPreviewId: null,
              confirmedOutboundSnippets: [],
              outboundPreview: revokedSessionPreview,
              expectedDataMode: dataMode,
            });
          }

          sessionRuntimeMeta.set(sessionId, {
            usePersonalMaterials: sessionUsePersonalMaterials,
            hasPersonalMaterials: turnUsesPersonalMaterials,
            cloudConsent: false,
            confirmedOutboundPreviewId: null,
            confirmedOutboundSnippets: [],
          });

          // 撤回时立即向该会话所有正在运行、涉及云模型+个人材料的轮次传递取消信号。
          for (const activeEntry of activeTurnControllers.values()) {
            if (
              activeEntry.sessionId === sessionId
              && activeEntry.isCloudModel
              && activeEntry.usesPersonalMaterials
              && !activeEntry.controller.signal.aborted
            ) {
              activeEntry.controller.abort(
                new BackendServiceError(
                  'CLOUD_CONSENT_REQUIRED',
                  '会话云推理授权已撤回，已中止待发送个人材料的云端轮次。',
                  403,
                ),
              );
            }
          }

          if (revokedTurnPreview.isCloudModel && turnUsesPersonalMaterials) {
            throw new BackendServiceError(
              'CLOUD_CONSENT_REQUIRED',
              '当前模型为非本机云推理服务，云推理授权已撤回；携带个人材料执行轮次需重新确认预览并同意（cloudConsent: true）。',
              403,
              { outboundPreview: revokedTurnPreview },
            );
          }
        }

        const effectiveConsent = body.cloudConsent !== undefined
          ? body.cloudConsent
          : Boolean(persistedConsent);

        const turnOutboundPreview = buildOutboundPreview({
          modelConfig: effectiveModel,
          usePersonalMaterials: turnUsesPersonalMaterials,
          cloudConsent: effectiveConsent === true,
          evidences: selectedTurnPersonalEvidences,
          snapshotId: sessionSnapshot.lockedSnapshotId ?? null,
          confirmedOutboundPreviewId: effectiveConsent === true ? persistedConfirmedPreviewId : null,
          redact: redactFn,
        });

        let approvedOutboundManifest = null;
        if (turnOutboundPreview.isCloudModel && turnUsesPersonalMaterials) {
          if (effectiveConsent !== true) {
            throw new BackendServiceError(
              'CLOUD_CONSENT_REQUIRED',
              '当前模型为非本机云推理服务，携带个人材料执行轮次需本人明确同意（cloudConsent: true）并确认当前外发预览。',
              403,
              { outboundPreview: turnOutboundPreview },
            );
          }

          if (body.outboundPreviewId !== undefined) {
            if (body.outboundPreviewId !== turnOutboundPreview.outboundPreviewId) {
              throw new BackendServiceError(
                'CLOUD_CONSENT_REQUIRED',
                '提交的 outboundPreviewId 与当前轮次拟外发个人材料预览不一致，请核对最新预览清单后重新确认。',
                403,
                { outboundPreview: turnOutboundPreview },
              );
            }
          } else {
            const confirmedDigestSet = new Set(
              persistedConfirmedSnippets
                .map((item) => item?.digest)
                .filter((d) => typeof d === 'string' && d.length > 0),
            );
            const allTurnItemsAlreadyConfirmed = turnOutboundPreview.items.every(
              (item) => confirmedDigestSet.has(item.digest),
            );
            if (persistedConsent !== true || !allTurnItemsAlreadyConfirmed) {
              throw new BackendServiceError(
                'CLOUD_CONSENT_REQUIRED',
                '会话云推理授权已变更或本轮涉及新的个人材料片段，请核对最新外发预览清单并携带匹配的 outboundPreviewId 确认。',
                403,
                { outboundPreview: turnOutboundPreview },
              );
            }
          }

          const confirmedManifest = {
            ...turnOutboundPreview,
            cloudConsentGranted: true,
            confirmedOutboundPreviewId: turnOutboundPreview.outboundPreviewId,
            previewConfirmed: true,
          };
          approvedOutboundManifest = confirmedManifest;

          const updateConfirmedScope =
            body.outboundPreviewId !== undefined || turnOutboundPreview.items.length > 0;
          const nextConfirmedPreviewId = updateConfirmedScope
            ? confirmedManifest.outboundPreviewId
            : (persistedConfirmedPreviewId ?? confirmedManifest.outboundPreviewId);
          const nextConfirmedSnippets = updateConfirmedScope
            ? confirmedManifest.items
            : persistedConfirmedSnippets;

          if (storePersistsConsent && (updateConfirmedScope || body.cloudConsent === true)) {
            await invokeUpdateSessionConsent(store, ownerId, sessionId, {
              cloudConsent: true,
              confirmedOutboundPreviewId: nextConfirmedPreviewId,
              confirmedOutboundSnippets: nextConfirmedSnippets,
              outboundPreview: confirmedManifest,
              expectedDataMode: dataMode,
            });
          }

          sessionRuntimeMeta.set(sessionId, {
            usePersonalMaterials: sessionUsePersonalMaterials,
            hasPersonalMaterials: turnUsesPersonalMaterials,
            cloudConsent: true,
            confirmedOutboundPreviewId: nextConfirmedPreviewId,
            confirmedOutboundSnippets: nextConfirmedSnippets,
          });
        } else if (body.cloudConsent === true) {
          if (storePersistsConsent) {
            await invokeUpdateSessionConsent(store, ownerId, sessionId, {
              cloudConsent: true,
              expectedDataMode: dataMode,
            });
          }
          sessionRuntimeMeta.set(sessionId, {
            usePersonalMaterials: sessionUsePersonalMaterials,
            hasPersonalMaterials: turnUsesPersonalMaterials,
            cloudConsent: true,
            confirmedOutboundPreviewId: persistedConfirmedPreviewId,
            confirmedOutboundSnippets: persistedConfirmedSnippets,
          });
        }

        const begun = await store.beginTurn(ownerId, sessionId, {
          clientRequestId: body.clientRequestId,
          baseGraphVersion: body.baseGraphVersion,
          text: body.text,
          focusRef: body.focusRef ?? null,
          action: body.action ?? null,
          usePersonalMaterials: sessionUsePersonalMaterials,
          cloudConsent: effectiveConsent,
        });

        const turn = begun?.turn ?? begun;
        const reused = Boolean(begun?.reused ?? turn?.reused);
        const turnId = turn.turnId ?? turn.id;
        const eventsUrl = `/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events`;

        if (reused) {
          sendJson(200, apiOk({
            sessionId,
            turnId,
            turnNumber: turn.turnNumber ?? null,
            status: turn.status,
            baseGraphVersion: turn.baseGraphVersion ?? body.baseGraphVersion,
            reused: true,
            eventsUrl,
          }));
          return;
        }

        const turnKey = `${sessionId}:${turnId}`;
        const controller = new AbortController();
        activeTurnControllers.set(turnKey, {
          sessionId,
          turnId,
          controller,
          isCloudModel: turnOutboundPreview.isCloudModel,
          usesPersonalMaterials: turnUsesPersonalMaterials,
        });

        // 后台异步启动流式编排器，严格捕获异常并通过 store.failTurn 落库兜底，绝不产生 unhandledRejection。
        Promise.resolve()
          .then(() => invokeExecuteTurn(orchestrator, {
            ownerId,
            sessionId,
            turnId,
            turn,
            clientRequestId: body.clientRequestId,
            baseGraphVersion: body.baseGraphVersion,
            text: body.text,
            focusRef: body.focusRef ?? null,
            focus: body.focusRef ?? null,
            action: body.action ?? null,
            usePersonalMaterials: sessionUsePersonalMaterials,
            cloudConsent: effectiveConsent,
            allowCloudModel: turnOutboundPreview.isLocalModel ? true : Boolean(effectiveConsent),
            approvedOutboundManifest,
            signal: controller.signal,
          }))
          .catch(async (execError) => {
            if (controller.signal.aborted) return;
            const safeErr = toBackendError(execError);
            try {
              await invokeFailTurn(store, ownerId, sessionId, turnId, {
                code: safeErr.code,
                message: safeErr.message,
              });
            } catch {
              // 若轮次已由编排器自身进入终态（committed/cancelled/failed），忽略重复落库错误。
            }
          })
          .finally(() => {
            activeTurnControllers.delete(turnKey);
          });

        sendJson(202, apiOk({
          sessionId,
          turnId,
          turnNumber: turn.turnNumber ?? null,
          status: turn.status ?? 'running',
          baseGraphVersion: turn.baseGraphVersion ?? body.baseGraphVersion,
          reused: false,
          eventsUrl,
        }));
        return;
      }

      // 4. GET /v1/sessions/:id/turns/:turnId/events（真实流式 SSE + Last-Event-ID 无损补齐）
      if (turnEventsMatch && method === 'GET') {
        const sessionId = parsePathId(turnEventsMatch[1], 'id');
        const turnId = parsePathId(turnEventsMatch[2], 'turnId');
        const afterSeq = parseLastEventId(request.headers['last-event-id']);

        // 校验会话所有权与数据模式（跨主体订阅 SSE 直接返回 403 SESSION_FORBIDDEN）。
        const sessionSnapshot = await invokeGetSession(store, ownerId, sessionId);
        if (sessionSnapshot.dataMode && sessionSnapshot.dataMode !== dataMode) {
          throw new BackendServiceError('DATA_MODE_MISMATCH', '会话数据模式与当前服务隔离模式不一致。', 403);
        }

        if (typeof store.subscribeTurnEvents !== 'function' || typeof store.listTurnEvents !== 'function') {
          throw new BackendServiceError('INTERNAL_ERROR', '会话存储未实现事件订阅接口。', 500);
        }

        const bufferedLive = [];
        let replayFlushed = false;
        let streamClosed = false;
        let lastSentSeq = afterSeq;
        let heartbeatTimer = null;
        let unsubscribe = () => {};

        const closeSseSubscription = () => {
          if (streamClosed) return;
          streamClosed = true;
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          try {
            unsubscribe();
          } catch {
            // 忽略解绑异常。
          }
        };

        const finishSseResponse = () => {
          const wasOpen = !streamClosed;
          closeSseSubscription();
          if (!response.destroyed && !response.writableEnded) {
            response.end();
          }
          if (wasOpen) {
            emitSafeLog(logger, {
              method: 'GET',
              route: matchedRoute,
              status: 200,
              latencyMs: performance.now() - startedAt,
              errorCode: null,
            });
          }
        };

        const writeSseEvent = (ev) => {
          if (streamClosed || response.destroyed || response.writableEnded) return;
          const seq = Number(ev?.seq ?? ev?.id);
          if (!Number.isInteger(seq) || seq <= lastSentSeq) return;
          lastSentSeq = seq;
          const eventType = String(ev?.eventType ?? ev?.event ?? ev?.type ?? 'message');
          const rawPayload = ev?.payload !== undefined ? ev.payload : (ev?.data !== undefined ? ev.data : {});
          const rawJson = JSON.stringify(rawPayload);
          const safeJson = redactText(rawJson, currentSecrets());
          response.write(`id: ${seq}\nevent: ${eventType}\ndata: ${safeJson}\n\n`);
          if (eventType === 'turn.done') {
            finishSseResponse();
          }
        };

        const liveListener = (ev) => {
          if (streamClosed) return;
          if (!replayFlushed) {
            bufferedLive.push(ev);
            return;
          }
          writeSseEvent(ev);
        };

        // 先注册实时监听缓冲，再查询历史事件，杜绝查询与监听之间的并发丢包窗口！
        unsubscribe = store.subscribeTurnEvents(sessionId, turnId, liveListener) || (() => {});
        let historyEvents;
        let turnRecord = null;
        try {
          if (typeof store.getTurn === 'function') {
            turnRecord = prefersObjectArg(store.getTurn)
              ? await store.getTurn({ ownerId, sessionId, turnId })
              : await store.getTurn(ownerId, sessionId, turnId);
            if (!turnRecord) {
              throw new BackendServiceError('TURN_NOT_FOUND', '指定的轮次不存在。', 404);
            }
          } else if (Array.isArray(sessionSnapshot.turns)) {
            turnRecord = sessionSnapshot.turns.find((item) => (item.turnId ?? item.id) === turnId) ?? null;
            if (!turnRecord) {
              throw new BackendServiceError('TURN_NOT_FOUND', '指定的轮次不存在。', 404);
            }
          }
          historyEvents = await store.listTurnEvents(ownerId, sessionId, turnId, { afterSeq });
        } catch (err) {
          closeSseSubscription();
          throw err;
        }

        const sseHeaders = {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          'X-Content-Type-Options': 'nosniff',
          'Vary': 'Origin',
        };
        if (requestOrigin) {
          sseHeaders['Access-Control-Allow-Origin'] = requestOrigin;
        }

        request.socket?.setNoDelay?.(true);
        response.writeHead(200, sseHeaders);
        response.flushHeaders();

        // 客户端主动断开连接时仅解绑当前 SSE listener，绝不中止后台执行中的轮次！
        const onClientDisconnect = () => {
          if (streamClosed) return;
          closeSseSubscription();
          emitSafeLog(logger, {
            method: 'GET',
            route: matchedRoute,
            status: 200,
            latencyMs: performance.now() - startedAt,
            errorCode: null,
          });
        };
        request.once('aborted', onClientDisconnect);
        response.once('close', onClientDisconnect);

        if (sseHeartbeatMs > 0) {
          heartbeatTimer = setInterval(() => {
            if (!streamClosed && !response.destroyed && !response.writableEnded) {
              response.write(': keep-alive\n\n');
            }
          }, sseHeartbeatMs);
          heartbeatTimer.unref?.();
        }

        const orderedHistory = Array.isArray(historyEvents)
          ? [...historyEvents].sort((a, b) => Number(a.seq ?? a.id) - Number(b.seq ?? b.id))
          : [];
        for (const ev of orderedHistory) {
          writeSseEvent(ev);
          if (streamClosed) return;
        }

        while (bufferedLive.length > 0 && !streamClosed) {
          bufferedLive.sort((a, b) => Number(a.seq ?? a.id) - Number(b.seq ?? b.id));
          const ev = bufferedLive.shift();
          writeSseEvent(ev);
        }
        replayFlushed = true;

        // 若客户端传入的 Last-Event-ID 已达到或超过已完结轮次的最后一条事件，避免连接永久挂起。
        if (!streamClosed) {
          let latestTurn = turnRecord;
          if (!latestTurn && typeof store.getTurn === 'function') {
            latestTurn = prefersObjectArg(store.getTurn)
              ? await store.getTurn({ ownerId, sessionId, turnId })
              : await store.getTurn(ownerId, sessionId, turnId);
          } else if (!latestTurn && Array.isArray(sessionSnapshot.turns)) {
            const refreshed = await invokeGetSession(store, ownerId, sessionId);
            latestTurn = Array.isArray(refreshed.turns)
              ? refreshed.turns.find((item) => (item.turnId ?? item.id) === turnId) ?? null
              : null;
          }
          if (latestTurn && TERMINAL_TURN_STATUSES.has(latestTurn.status)) {
            const tailEvents = await store.listTurnEvents(ownerId, sessionId, turnId, { afterSeq: lastSentSeq });
            if (Array.isArray(tailEvents)) {
              for (const ev of tailEvents) {
                writeSseEvent(ev);
                if (streamClosed) return;
              }
            }
            if (!streamClosed) {
              finishSseResponse();
            }
          }
        }
        return;
      }

      // 5. POST /v1/sessions/:id/turns/:turnId/cancel
      if (turnCancelMatch && method === 'POST') {
        const sessionId = parsePathId(turnCancelMatch[1], 'id');
        const turnId = parsePathId(turnCancelMatch[2], 'turnId');
        const rawBody = await readJsonBody(request, {
          maxBodyBytes,
          allowEmpty: true,
          emptyFallback: undefined,
        });
        const body = parseContract(cancelTurnBodySchema, rawBody);
        const reason = body?.reason ?? undefined;

        // 必须在触发 AbortController 前先核验会话所有权，防止跨主体请求中止他人轮次！
        const sessionSnapshot = await invokeGetSession(store, ownerId, sessionId);
        if (sessionSnapshot.dataMode && sessionSnapshot.dataMode !== dataMode) {
          throw new BackendServiceError('DATA_MODE_MISMATCH', '会话数据模式与当前服务隔离模式不一致。', 403);
        }

        let existingTurn = null;
        if (Array.isArray(sessionSnapshot.turns)) {
          existingTurn = sessionSnapshot.turns.find((item) => (item?.turnId ?? item?.id) === turnId) ?? null;
        }
        if (!existingTurn && typeof store.getTurn === 'function') {
          existingTurn = prefersObjectArg(store.getTurn)
            ? await store.getTurn({ ownerId, sessionId, turnId })
            : await store.getTurn(ownerId, sessionId, turnId);
        }
        if (!existingTurn) {
          throw new BackendServiceError('TURN_NOT_FOUND', '指定的轮次不存在。', 404);
        }

        // 若轮次已处于任意终态（committed / cancelled / failed / interrupted），绝不产生新终态事件，直接幂等返回已有终态。
        if (TERMINAL_TURN_STATUSES.has(existingTurn.status)) {
          const existingStatus = existingTurn.status;
          sendJson(200, apiOk({
            sessionId,
            turnId,
            outcome: existingStatus,
            status: existingStatus,
            graphVersion: Number.isInteger(sessionSnapshot.graphVersion) ? sessionSnapshot.graphVersion : 0,
          }));
          return;
        }

        const turnKey = `${sessionId}:${turnId}`;
        const activeEntry = activeTurnControllers.get(turnKey);
        const controller = activeEntry?.controller ?? activeEntry;
        if (controller && !controller.signal.aborted) {
          controller.abort(new DOMException(reason || '用户主动取消当前轮次', 'AbortError'));
        }

        const cancelResult = await invokeCancelTurn({
          orchestrator,
          store,
          ownerId,
          sessionId,
          turnId,
          reason,
        });

        const rawStatus = cancelResult?.status ?? cancelResult?.turn?.status ?? 'cancelled';
        const status = TERMINAL_TURN_STATUSES.has(rawStatus) ? rawStatus : 'cancelled';
        const rawOutcome = cancelResult?.outcome ?? status;
        const outcome = TERMINAL_TURN_STATUSES.has(rawOutcome) ? rawOutcome : status;
        let graphVersion = cancelResult?.graphVersion ?? cancelResult?.sessionGraphVersion;
        if (!Number.isInteger(graphVersion)) {
          const refreshed = await invokeGetSession(store, ownerId, sessionId);
          graphVersion = refreshed.graphVersion ?? 0;
        }

        sendJson(200, apiOk({
          sessionId,
          turnId,
          outcome,
          status,
          graphVersion,
        }));
        return;
      }

      // 6. GET /v1/sessions/:id
      if (sessionMatch && method === 'GET') {
        const sessionId = parsePathId(sessionMatch[1], 'id');
        const queryObj = Object.fromEntries(url.searchParams.entries());
        const query = parseContract(sessionQuerySchema, queryObj);

        const sessionSnapshot = await invokeGetSession(store, ownerId, sessionId);
        if (sessionSnapshot.dataMode && sessionSnapshot.dataMode !== dataMode) {
          throw new BackendServiceError('DATA_MODE_MISMATCH', '会话数据模式与当前服务隔离模式不一致。', 403);
        }

        const runtimeMeta = sessionRuntimeMeta.get(sessionId) ?? null;
        const resolvedUsePersonalMaterials = resolveSessionUsePersonalMaterials(sessionSnapshot, runtimeMeta);
        const storePersistsConsent = typeof store.updateSessionConsent === 'function';
        const enrichedSnapshot = {
          ...sessionSnapshot,
          ...(typeof sessionSnapshot.usePersonalMaterials === 'boolean'
            ? {}
            : { usePersonalMaterials: resolvedUsePersonalMaterials }),
          ...(!storePersistsConsent && runtimeMeta && typeof runtimeMeta.cloudConsent === 'boolean'
            ? {
                cloudConsent: runtimeMeta.cloudConsent,
                allowCloudModel: runtimeMeta.cloudConsent,
              }
            : {}),
        };

        if (query.lookupId !== undefined) {
          const retrievedItem = await invokeLookupItem(store, ownerId, sessionId, query.lookupId);
          sendJson(200, apiOk({
            ...enrichedSnapshot,
            retrievedItem: retrievedItem ?? null,
          }));
          return;
        }

        sendJson(200, apiOk(enrichedSnapshot));
        return;
      }

      throw new BackendServiceError('SESSION_NOT_FOUND', '请求的接口路径或方法不存在。', 404);
    } catch (rawError) {
      const safeErr = toBackendError(rawError);
      if (response.headersSent) {
        if (!response.destroyed && !response.writableEnded) {
          response.end();
        }
        emitSafeLog(logger, {
          method: request.method,
          route: matchedRoute,
          status: safeErr.status,
          latencyMs: performance.now() - startedAt,
          errorCode: safeErr.code,
        });
        return;
      }
      sendJson(safeErr.status, apiError(safeErr.code, safeErr.message, safeErr.details), safeErr.code);
    }
  });

  server.requestTimeout = 0; // SSE 流支持长连接，不受常规上传超时切断。
  server.headersTimeout = 15_000;

  return server;
}
