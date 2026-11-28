#!/usr/bin/env node
// 「报价」正式星图页面与真实公开 `/v1` HTTP/SSE 同源宿主入口（真实公开搜索 + 服务端模型 + 按浏览器会话隔离）。
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentError, safeAgentError } from './errors.mjs';
import { apiError, apiOk } from './protocol.mjs';
import { loadConfig } from './config.mjs';
import { createModel } from './agent.mjs';
import { connectServers as defaultConnectServers } from './mcp-servers.mjs';
import { createPrincipalAuth, createQuotationServer } from './server.mjs';
import { createSessionStore } from './session-store.mjs';
import { createMaterialsAdapter } from './materials.mjs';
import { createTurnOrchestrator } from './turn-orchestrator.mjs';

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
/* 报价版前端已归档，主前端迁到 star-atlas/web；这里仍托管归档副本以保持公开链路可用 */
const FRONTEND_WEB_DIR = path.resolve(AGENT_DIR, '..', 'frontend-design', 'archive', '2026-11-28-web');
const DEFAULT_DB_PATH = path.resolve(AGENT_DIR, '.data', 'sessions-public-web.sqlite');
export const PUBLIC_SESSION_COOKIE_NAME = 'quotation_public_sid';
const MAX_HOST_SESSIONS = 512;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const REDACTED = '[已隐藏]';

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
});

const FORBIDDEN_EXTERNAL_FIELD_RE = new RegExp(
  '^(?:'
  + 'base_?url|api_?url|search_?url|endpoint|upstream_?url|webhook_?url|callback_?url|proxy_?url|'
  + 'model_?url|mcp_?url|service_?url|data_?service_?url|openapi_?base_?url|'
  + 'api_?key|access_?secret|zhihu_?secret|bearer_?token|server_?token|agent_?token|user_?token'
  + ')$',
  'i',
);

const FORBIDDEN_METADATA_KEYS = new Set([
  'proposalsByRequestId',
  'proposalsByTurnNumber',
  'initialGraph',
  'initialEvidence',
  'initialEvidences',
  'initialFacts',
  'proposal',
  'proposals',
]);

const HELP = `「报价」正式星图与真实公开 /v1 同源宿主（Node.js 24+）

用法：
  npm run serve:public:web -- [选项]
  node --env-file-if-exists=.env public-web-host.mjs [选项]

选项：
  --host <host>       监听主机地址（默认 127.0.0.1）
  --port <port>       监听端口，0 表示随机空闲端口（默认 3007）
  --db <path>         指定独立公开会话 SQLite 数据库路径（默认 .data/sessions-public-web.sqlite）
  --base-url <url>    覆盖 AGENT_BASE_URL
  --model <name>      覆盖 AGENT_MODEL
  --help              显示本帮助说明

环境变量：
  ZHIHU_ACCESS_SECRET    官方知乎公开搜索凭证（仅服务端持有；缺省时仍可启动并标注未配置）
  AGENT_BASE_URL         服务端模型 OpenAI 兼容接口地址
  AGENT_MODEL            服务端模型名称
  AGENT_API_KEY          服务端模型密钥（仅服务端持有，严禁下发至浏览器）
  AGENT_SERVER_TOKEN     可选：直连 /v1 接口的 Bearer 令牌（与浏览器会话彼此隔离）
  AGENT_ALLOWED_ORIGINS  可选：逗号分隔的额外允许同源列表
`;

function usageError(message) {
  return new AgentError('INVALID_ARGUMENTS', message, 2);
}

export function parsePublicWebHostArgs(args = []) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        host: { type: 'string' },
        port: { type: 'string' },
        db: { type: 'string' },
        'base-url': { type: 'string' },
        model: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch {
    throw usageError('参数无效，请运行 node public-web-host.mjs --help 查看格式。');
  }

  const { values } = parsed;
  if (values.help) {
    return { help: true, options: {} };
  }

  const host = values.host !== undefined ? values.host.trim() : undefined;
  if (values.host !== undefined && !host) {
    throw usageError('--host 不能为空。');
  }

  let port;
  if (values.port !== undefined) {
    const trimmed = values.port.trim();
    if (!/^[0-9]+$/.test(trimmed)) {
      throw usageError('--port 必须是 0 到 65535 之间的整数。');
    }
    port = Number(trimmed);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw usageError('--port 必须是 0 到 65535 之间的整数。');
    }
  }

  if (values.db !== undefined && !values.db.trim()) {
    throw usageError('--db 不能为空。');
  }
  if (values['base-url'] !== undefined && !values['base-url'].trim()) {
    throw usageError('--base-url 不能为空。');
  }
  if (values.model !== undefined && !values.model.trim()) {
    throw usageError('--model 不能为空。');
  }

  return {
    help: false,
    options: {
      host,
      port,
      dbPath: values.db?.trim(),
      baseURL: values['base-url']?.trim(),
      modelName: values.model?.trim(),
    },
  };
}

function parseCookies(headerValue) {
  const map = new Map();
  if (typeof headerValue !== 'string' || !headerValue.trim()) return map;
  for (const segment of headerValue.split(';')) {
    const idx = segment.indexOf('=');
    if (idx <= 0) continue;
    const key = segment.slice(0, idx).trim();
    const val = segment.slice(idx + 1).trim();
    if (key) map.set(key, val);
  }
  return map;
}

export function isAllowedBrowserV1Route(method, pathname) {
  if (method === 'POST' && pathname === '/v1/sessions') return true;
  if (method === 'GET' && /^\/v1\/sessions\/[^/]+$/.test(pathname)) return true;
  if (method === 'POST' && /^\/v1\/sessions\/[^/]+\/turns$/.test(pathname)) return true;
  if (method === 'GET' && /^\/v1\/sessions\/[^/]+\/turns\/[^/]+\/events$/.test(pathname)) return true;
  if (method === 'POST' && /^\/v1\/sessions\/[^/]+\/turns\/[^/]+\/cancel$/.test(pathname)) return true;
  return false;
}

function hasRawTraversalPattern(rawUrl) {
  const rawPath = String(rawUrl ?? '/').split('?')[0];
  return /(?:^|\/)\.\.(?:\/|$)|%2e%2e|%5c|%00|\\|\0/i.test(rawPath);
}

function resolveSafeStaticFile(webRootReal, requestPathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;

  let relativePath;
  if (decoded === '/' || decoded === '/index.html') {
    relativePath = 'index.html';
  } else if (decoded.startsWith('/src/')) {
    relativePath = decoded.slice(1);
  } else {
    return null;
  }

  const segments = relativePath.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..' || seg.startsWith('.'))) {
    return null;
  }
  if (segments[0] === 'src' && segments[1] === 'verify') {
    return null;
  }

  const candidate = path.resolve(webRootReal, relativePath);
  if (candidate !== webRootReal && !candidate.startsWith(`${webRootReal}${path.sep}`)) {
    return null;
  }
  if (!existsSync(candidate)) return null;

  let realCandidate;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    return null;
  }
  if (realCandidate !== webRootReal && !realCandidate.startsWith(`${webRootReal}${path.sep}`)) {
    return null;
  }

  let stats;
  try {
    stats = statSync(realCandidate);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;

  const ext = path.extname(realCandidate).toLowerCase();
  const contentType = MIME_TYPES[ext];
  if (!contentType) return null;

  return { filePath: realCandidate, contentType };
}

function normalizeSecretsList(values = []) {
  const filtered = values
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length >= 6);
  return [...new Set(filtered)].sort((a, b) => b.length - a.length);
}

function redactText(input, secrets = []) {
  let output = String(input);
  for (const secret of secrets) {
    output = output.split(secret).join(REDACTED);
  }
  return output;
}

function findForbiddenExternalKey(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findForbiddenExternalKey(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_EXTERNAL_FIELD_RE.test(key)) {
      return key;
    }
    const hit = findForbiddenExternalKey(nested, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// 公开客户端安全边界校验：拒绝个人数据、种子图、工具/候选提议注入及外部接口地址字段，并规范化会话参数。
export function validatePublicClientPayload(routeKind, payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_ARGUMENTS',
      message: '请求参数格式不正确，请提交有效的 JSON 对象。',
    };
  }

  const forbiddenExternalKey = findForbiddenExternalKey(payload);
  if (forbiddenExternalKey) {
    return {
      ok: false,
      status: 403,
      code: 'SESSION_FORBIDDEN',
      message: '公开体验模式不支持自定义外部接口地址或密钥配置。',
      details: { field: forbiddenExternalKey },
    };
  }

  if (payload.usePersonalMaterials === true || payload.snapshotId !== undefined) {
    return {
      ok: false,
      status: 403,
      code: 'PERSONAL_DATA_FORBIDDEN',
      message: '公开体验模式只使用知乎公开资料，不支持读取个人采集内容或指定个人快照。',
      details: { field: payload.usePersonalMaterials === true ? 'usePersonalMaterials' : 'snapshotId' },
    };
  }

  if (payload.initialGraph !== undefined) {
    return {
      ok: false,
      status: 403,
      code: 'SESSION_FORBIDDEN',
      message: '公开体验模式不允许从浏览器直接写入初始星图。',
      details: { field: 'initialGraph' },
    };
  }

  if (routeKind === 'create_session') {
    if (payload.dataMode !== undefined && payload.dataMode !== 'real') {
      return {
        ok: false,
        status: 403,
        code: 'DATA_MODE_MISMATCH',
        message: '公开体验模式仅支持真实公开会话，不能混入合成演示数据模式。',
        details: { field: 'dataMode' },
      };
    }
    if (payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)) {
      if (payload.metadata.usePersonalMaterials === true || payload.metadata.snapshotId !== undefined) {
        return {
          ok: false,
          status: 403,
          code: 'PERSONAL_DATA_FORBIDDEN',
          message: '公开体验模式不支持通过扩展字段开启个人采集内容。',
          details: { field: 'metadata' },
        };
      }
      for (const forbiddenKey of FORBIDDEN_METADATA_KEYS) {
        if (Object.hasOwn(payload.metadata, forbiddenKey)) {
          return {
            ok: false,
            status: 403,
            code: 'SESSION_FORBIDDEN',
            message: '公开体验模式不允许注入预置候选提议、初始星图或初始证据。',
            details: { field: `metadata.${forbiddenKey}` },
          };
        }
      }
    }

    return {
      ok: true,
      normalizedPayload: {
        ...payload,
        dataMode: 'real',
        usePersonalMaterials: false,
      },
    };
  }

  if (routeKind === 'create_turn') {
    if (Object.hasOwn(payload, 'proposal')) {
      return {
        ok: false,
        status: 403,
        code: 'SESSION_FORBIDDEN',
        message: '公开体验模式不允许客户端直接注入候选提议。',
        details: { field: 'proposal' },
      };
    }
    if (payload.action && typeof payload.action === 'object' && Object.hasOwn(payload.action, 'proposal')) {
      return {
        ok: false,
        status: 403,
        code: 'SESSION_FORBIDDEN',
        message: '公开体验模式不允许通过 action.proposal 注入候选提议。',
        details: { field: 'action.proposal' },
      };
    }
    return {
      ok: true,
      normalizedPayload: payload,
    };
  }

  return { ok: true, normalizedPayload: payload };
}

async function readAndParseRequestJson(req, { allowEmpty = false, maxBytes = MAX_JSON_BODY_BYTES } = {}) {
  const contentType = req.headers['content-type'];
  const contentLengthHeader = req.headers['content-length'];
  if (contentLengthHeader !== undefined && Number(contentLengthHeader) > maxBytes) {
    return {
      ok: false,
      status: 413,
      code: 'BODY_TOO_LARGE',
      message: '这次发送的内容有点长，精简一下再试试吧。',
    };
  }
  if (contentType !== undefined && !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return {
      ok: false,
      status: 415,
      code: 'CONTENT_TYPE',
      message: '请求体格式需要为 application/json。',
    };
  }

  let totalBytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      return {
        ok: false,
        status: 413,
        code: 'BODY_TOO_LARGE',
        message: '这次发送的内容有点长，精简一下再试试吧。',
      };
    }
    chunks.push(chunk);
  }

  if (totalBytes === 0) {
    if (allowEmpty) {
      return { ok: true, payload: {} };
    }
    if (!contentType) {
      return {
        ok: false,
        status: 415,
        code: 'CONTENT_TYPE',
        message: '请求体格式需要为 application/json。',
      };
    }
    return {
      ok: false,
      status: 400,
      code: 'INVALID_JSON',
      message: '请求内容不能为空。',
    };
  }

  if (!contentType) {
    return {
      ok: false,
      status: 415,
      code: 'CONTENT_TYPE',
      message: '请求体格式需要为 application/json。',
    };
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return { ok: true, payload: parsed };
  } catch {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_JSON',
      message: '请求内容不是有效的 JSON 格式。',
    };
  }
}

function createForwardedJsonRequest(origReq, normalizedPayload) {
  const bodyBuffer = Buffer.from(JSON.stringify(normalizedPayload), 'utf8');
  const proxy = Readable.from([bodyBuffer]);
  proxy.method = origReq.method;
  proxy.url = origReq.url;
  proxy.httpVersion = origReq.httpVersion;
  proxy.socket = origReq.socket;
  proxy.headers = {
    ...origReq.headers,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bodyBuffer.length),
  };
  return proxy;
}

function buildSearchOnlyCallTool(searchTools = {}) {
  return async (toolName, args = {}, { signal } = {}) => {
    // 公开宿主绝不代理个人采集类工具
    if (toolName === 'zhihu_knowledge_profile' || String(toolName).startsWith('zhihu_collection')) {
      return {
        schemaVersion: 1,
        ok: false,
        data: null,
        error: {
          code: 'PERSONAL_DATA_FORBIDDEN',
          message: '公开体验模式不支持读取个人采集内容。',
        },
      };
    }
    const tool = searchTools?.[toolName];
    if (!tool || typeof tool.execute !== 'function') {
      return {
        schemaVersion: 1,
        ok: false,
        data: null,
        error: {
          code: 'NOT_CONFIGURED',
          message: '当前还没有配置公开搜索凭证，暂时查不到知乎公开资料。',
        },
      };
    }
    return tool.execute(args, { abortSignal: signal, signal });
  };
}

function filterSearchOnlyTools(rawTools = {}) {
  const safeTools = {};
  for (const [name, def] of Object.entries(rawTools ?? {})) {
    if (name === 'zhihu_search' || name === 'zhihu_get_search_result' || name === 'zhihu_search_status') {
      safeTools[name] = def;
    }
  }
  return safeTools;
}

function listenAsync(server, port, host) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (err) => {
      server.off('listening', onListening);
      rejectPromise(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolvePromise(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServerAsync(server) {
  return new Promise((resolvePromise) => {
    if (!server.listening) {
      resolvePromise();
      return;
    }
    server.close(() => resolvePromise());
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
  });
}

function sendJsonResponse(res, status, payload, extraHeaders = {}, secrets = []) {
  if (res.destroyed || res.writableEnded) return;
  const serialized = redactText(JSON.stringify(payload), secrets);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(serialized);
}

export async function startPublicWebHost({
  host = '127.0.0.1',
  port = 3007,
  dbPath = DEFAULT_DB_PATH,
  env = process.env,
  baseURL = undefined,
  modelName = undefined,
  ownerId: directOwnerId = 'public-api-owner',
  internalToken: injectedDirectToken = null,
  bearerToken = null,
  model: injectedModel = null,
  orchestrator: injectedOrchestrator = null,
  materialsAdapter: injectedMaterialsAdapter = null,
  proposalResolver: injectedProposalResolver = null,
  connectServers: injectedConnectServers = defaultConnectServers,
  loadConfig: injectedLoadConfig = loadConfig,
  webDir = FRONTEND_WEB_DIR,
  allowedOrigins = [],
  onSseResponse = null,
  logger = null,
  stdout = process.stdout,
  stderr = process.stderr,
  quiet = false,
} = {}) {
  const resolvedWebDir = realpathSync(webDir);
  const resolvedDbPath = path.resolve(AGENT_DIR, dbPath);

  const overrides = {
    demo: false,
    allowPersonalData: false,
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(modelName !== undefined ? { modelName } : {}),
  };
  const loadedConfig = await injectedLoadConfig({ env, overrides });

  // 公开宿主仅允许连接 search 服务器，绝不连接 collection 个人采集服务。
  const searchOnlyServers = (loadedConfig.servers ?? [])
    .filter((server) => server?.id === 'search')
    .map((server) => ({ ...server }));
  const publicConfig = {
    ...loadedConfig,
    demo: false,
    allowPersonalData: false,
    servers: searchOnlyServers,
  };

  const store = createSessionStore(resolvedDbPath, { dataMode: 'real', demo: false });

  let mcpConnection = null;
  let searchTools = {};
  let searchReady = false;

  try {
    if (!injectedMaterialsAdapter) {
      const enabledSearchServers = searchOnlyServers.filter((s) => s.enabled);
      if (enabledSearchServers.length > 0) {
        try {
          mcpConnection = await injectedConnectServers({
            ...publicConfig,
            servers: enabledSearchServers,
          });
          searchTools = filterSearchOnlyTools(mcpConnection?.tools ?? {});
          searchReady = Boolean(searchTools.zhihu_search);
        } catch (mcpErr) {
          // 缺配置或连接失败时不阻断公开宿主启动，由 capabilities 如实标注 searchStatus: 'not_configured'
          if (!(mcpErr instanceof AgentError && mcpErr.code === 'NO_TOOLS_ENABLED')) {
            if (!quiet && stderr) {
              stderr.write('[quotation-public-web] 公开搜索服务暂未就绪，已降级为未配置状态启动。\n');
            }
          }
          searchTools = {};
          searchReady = false;
        }
      }
    } else {
      searchReady = injectedMaterialsAdapter.searchReady !== false;
    }

    const searchStatus = searchReady ? 'ready' : 'not_configured';

    const defaultMaterialsAdapter = createMaterialsAdapter({
      config: publicConfig,
      dataMode: 'real',
      demo: false,
      allowPersonalMaterials: false,
      usePersonalMaterials: false,
      enabled: false,
      tools: searchTools,
      callTool: buildSearchOnlyCallTool(searchTools),
    });
    const effectiveMaterialsAdapter = injectedMaterialsAdapter ?? defaultMaterialsAdapter;

    let effectiveModel = injectedModel ?? null;
    if (!effectiveModel && publicConfig.model?.ready && publicConfig.model.baseURL && publicConfig.model.modelName) {
      effectiveModel = createModel(publicConfig.model);
    }
    const modelReady = Boolean(effectiveModel);
    const modelStatus = modelReady ? 'ready' : 'not_configured';

    const modelConfigForServer = {
      ...(publicConfig.model ?? {}),
      ready: modelReady,
    };

    // 动态装配可选的 ./public-proposal.mjs（与并行开发的语义提议模块解耦）
    let effectiveProposalResolver = injectedProposalResolver ?? null;
    if (!effectiveProposalResolver && effectiveModel) {
      try {
        const proposalMod = await import('./public-proposal.mjs');
        if (typeof proposalMod?.createPublicProposalResolver === 'function') {
          effectiveProposalResolver = proposalMod.createPublicProposalResolver({
            model: effectiveModel,
            config: publicConfig,
            materialsAdapter: effectiveMaterialsAdapter,
            dataMode: 'real',
            publicMode: true,
          });
        }
      } catch {
        // 并行开发期若尚未存在 public-proposal.mjs，保持安全回退
      }
    }

    const orchestratorOptions = {
      store,
      dataMode: 'real',
      demo: false,
      publicMode: true,
      allowPersonalMaterials: false,
      materialsAdapter: effectiveMaterialsAdapter,
      materialLoader: effectiveMaterialsAdapter,
      model: effectiveModel,
      proposalResolver: effectiveProposalResolver,
      tools: searchTools,
      config: {
        ...publicConfig,
        demo: false,
        allowPersonalData: false,
        model: modelConfigForServer,
      },
      env,
      fallbackExplanationWhenNoModel: false,
    };

    const orchestrator = typeof injectedOrchestrator === 'function'
      ? await injectedOrchestrator(orchestratorOptions)
      : (injectedOrchestrator ?? createTurnOrchestrator(orchestratorOptions));

    // 多主体鉴权表：每个浏览器会话分配独立 ownerId + 内部 Bearer；同时支持显式 Bearer 直连。
    const rawDirectToken = injectedDirectToken ?? bearerToken;
    const directToken = typeof rawDirectToken === 'string' && rawDirectToken.trim()
      ? rawDirectToken.trim()
      : null;

    const auth = createPrincipalAuth({
      tokens: directToken
        ? [
            {
              token: directToken,
              ownerId: directOwnerId,
              label: 'public-web-host-direct-bearer',
              dataMode: 'real',
            },
          ]
        : [],
    });

    // 浏览器会话隔离表：sid -> { sid, ownerId: 'pub_<16hex>', internalToken }
    const browserSessions = new Map();
    const issueBrowserSession = () => {
      const sid = randomBytes(32).toString('base64url');
      const browserOwnerId = `pub_${randomBytes(8).toString('hex')}`;
      const browserInternalToken = `qtn_pub_host_${randomBytes(32).toString('base64url')}`;

      if (browserSessions.size >= MAX_HOST_SESSIONS) {
        const oldestKey = browserSessions.keys().next().value;
        if (oldestKey) {
          const evicted = browserSessions.get(oldestKey);
          browserSessions.delete(oldestKey);
          if (evicted?.internalToken) {
            auth.revokeToken(evicted.internalToken);
          }
        }
      }

      auth.registerToken({
        token: browserInternalToken,
        ownerId: browserOwnerId,
        label: 'public-web-browser-session',
        dataMode: 'real',
      });

      const record = {
        sid,
        ownerId: browserOwnerId,
        internalToken: browserInternalToken,
      };
      browserSessions.set(sid, record);
      return record;
    };

    const getBrowserSession = (req) => {
      const cookies = parseCookies(req.headers.cookie);
      const sid = cookies.get(PUBLIC_SESSION_COOKIE_NAME);
      if (typeof sid !== 'string' || !sid) return null;
      return browserSessions.get(sid) ?? null;
    };

    const ensureBrowserSessionCookieHeader = (req) => {
      const existing = getBrowserSession(req);
      if (existing) return null;
      const created = issueBrowserSession();
      return `${PUBLIC_SESSION_COOKIE_NAME}=${created.sid}; HttpOnly; SameSite=Strict; Path=/`;
    };

    const baseSecretValues = normalizeSecretsList([
      env.AGENT_API_KEY,
      env.ZHIHU_ACCESS_SECRET,
      env.DATA_SERVICE_AGENT_TOKEN,
      env.DATA_SERVICE_USER_TOKEN,
      publicConfig.model?.apiKey,
      directToken,
    ]);
    const currentAllSecrets = () => normalizeSecretsList([
      ...baseSecretValues,
      ...(typeof auth.redactionValues === 'function' ? auth.redactionValues() : []),
    ]);

    const capabilities = Object.freeze({
      searchReady,
      searchStatus,
      modelReady,
      modelStatus,
      canSwitchToDemo: true,
    });

    let effectiveOrigin = null;
    let effectiveHost = null;
    let allowedOriginSet = new Set();
    let apiServer = null;
    let sseConnectSeq = 0;

    const hostServer = createServer(async (req, res) => {
      try {
        res.setHeader('X-Content-Type-Options', 'nosniff');

        if (!effectiveHost || req.headers.host !== effectiveHost) {
          sendJsonResponse(
            res,
            403,
            apiError('HOST_DENIED', '请求地址与当前服务来源不一致，已拒绝访问。'),
            {},
            currentAllSecrets(),
          );
          return;
        }

        const requestOrigin = req.headers.origin;
        if (requestOrigin && !allowedOriginSet.has(requestOrigin)) {
          sendJsonResponse(
            res,
            403,
            apiError('ORIGIN_DENIED', '请求来源不在当前允许的同源范围内。'),
            {},
            currentAllSecrets(),
          );
          return;
        }

        if (hasRawTraversalPattern(req.url)) {
          sendJsonResponse(
            res,
            403,
            apiError('INVALID_ARGUMENTS', '无法访问非法或越界路径。'),
            {},
            currentAllSecrets(),
          );
          return;
        }

        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', effectiveOrigin);
        const pathname = url.pathname;

        // 1. GET /health
        if (pathname === '/health' && method === 'GET') {
          apiServer.emit('request', req, res);
          return;
        }

        // 2. 同源宿主握手接口：签发独立浏览器 HttpOnly Cookie，返回能力状态（绝不下发任何密钥或令牌）
        if (pathname === '/api/host/session' && method === 'POST') {
          const secFetchSite = req.headers['sec-fetch-site'];
          if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
            sendJsonResponse(
              res,
              403,
              apiError('ORIGIN_DENIED', '跨站请求不能建立公开体验会话。'),
              {},
              currentAllSecrets(),
            );
            return;
          }
          const setCookie = ensureBrowserSessionCookieHeader(req);
          sendJsonResponse(
            res,
            200,
            apiOk({
              mode: 'public',
              dataMode: 'real',
              hostReady: true,
              usePersonalMaterials: false,
              capabilities,
            }),
            setCookie ? { 'Set-Cookie': setCookie } : {},
            currentAllSecrets(),
          );
          return;
        }

        // 3. /v1/* 请求：同源浏览器通过独立 Cookie 映射到专属 ownerId，同时兼容显式 Authorization Bearer 直连
        if (pathname.startsWith('/v1/')) {
          if (method === 'OPTIONS') {
            apiServer.emit('request', req, res);
            return;
          }

          const hasAuthorizationHeader = typeof req.headers.authorization === 'string'
            && req.headers.authorization.trim().length > 0;

          if (!hasAuthorizationHeader) {
            if (!isAllowedBrowserV1Route(method, pathname)) {
              sendJsonResponse(
                res,
                403,
                apiError('SESSION_FORBIDDEN', '这个接口不在公开体验允许的访问范围内。'),
                {},
                currentAllSecrets(),
              );
              return;
            }

            const secFetchSite = req.headers['sec-fetch-site'];
            if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
              sendJsonResponse(
                res,
                403,
                apiError('ORIGIN_DENIED', '跨站请求已被当前服务拦截。'),
                {},
                currentAllSecrets(),
              );
              return;
            }

            const browserSession = getBrowserSession(req);
            if (!browserSession) {
              sendJsonResponse(
                res,
                401,
                apiError('UNAUTHORIZED', '当前浏览会话尚未建立或已失效，刷新页面后即可重新开始。'),
                {},
                currentAllSecrets(),
              );
              return;
            }

            // 仅在服务端内存中绑定当前浏览器的专属内部 Bearer，绝不暴露给前端
            req.headers.authorization = `Bearer ${browserSession.internalToken}`;
          }

          // 安全边界校验：拦截公开客户端越权字段并规范化 usePersonalMaterials: false
          const isCreateSession = method === 'POST' && pathname === '/v1/sessions';
          const isCreateTurn = method === 'POST' && /^\/v1\/sessions\/[^/]+\/turns$/.test(pathname);
          let requestToForward = req;

          if (isCreateSession || isCreateTurn) {
            const parsedBody = await readAndParseRequestJson(req, {
              allowEmpty: isCreateSession,
              maxBytes: MAX_JSON_BODY_BYTES,
            });
            if (!parsedBody.ok) {
              sendJsonResponse(
                res,
                parsedBody.status,
                apiError(parsedBody.code, parsedBody.message),
                {},
                currentAllSecrets(),
              );
              return;
            }

            const validation = validatePublicClientPayload(
              isCreateSession ? 'create_session' : 'create_turn',
              parsedBody.payload,
            );
            if (!validation.ok) {
              sendJsonResponse(
                res,
                validation.status,
                apiError(validation.code, validation.message, validation.details ?? null),
                {},
                currentAllSecrets(),
              );
              return;
            }

            requestToForward = createForwardedJsonRequest(req, validation.normalizedPayload);
          }

          // 测试与验收钩子：观察 SSE 连接建立与续读
          const sseMatch = method === 'GET'
            ? pathname.match(/^\/v1\/sessions\/([^/]+)\/turns\/([^/]+)\/events$/)
            : null;
          if (sseMatch && typeof onSseResponse === 'function') {
            sseConnectSeq += 1;
            onSseResponse({
              request: requestToForward,
              response: res,
              sessionId: decodeURIComponent(sseMatch[1]),
              turnId: decodeURIComponent(sseMatch[2]),
              lastEventId: req.headers['last-event-id'] ? String(req.headers['last-event-id']) : null,
              attempt: sseConnectSeq,
            });
          }

          apiServer.emit('request', requestToForward, res);
          return;
        }

        // 4. 静态托管 frontend-design/web/ 正式页面与脚本样式
        if (method === 'GET' || method === 'HEAD') {
          if (pathname === '/favicon.ico') {
            res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
            res.end();
            return;
          }
          const staticFile = resolveSafeStaticFile(resolvedWebDir, pathname);
          if (!staticFile) {
            sendJsonResponse(
              res,
              404,
              apiError('SESSION_NOT_FOUND', '没有找到请求的页面资源。'),
              {},
              currentAllSecrets(),
            );
            return;
          }

          const headers = {
            'Content-Type': staticFile.contentType,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          };
          if (pathname === '/' || pathname === '/index.html') {
            const setCookie = ensureBrowserSessionCookieHeader(req);
            if (setCookie) {
              headers['Set-Cookie'] = setCookie;
            }
          }

          const content = readFileSync(staticFile.filePath);
          res.writeHead(200, {
            ...headers,
            'Content-Length': String(content.length),
          });
          if (method === 'HEAD') {
            res.end();
          } else {
            res.end(content);
          }
          return;
        }

        sendJsonResponse(
          res,
          404,
          apiError('SESSION_NOT_FOUND', '没有找到对应的接口或方法。'),
          {},
          currentAllSecrets(),
        );
      } catch {
        sendJsonResponse(
          res,
          500,
          apiError('INTERNAL_ERROR', '服务刚刚遇到一点意外。你的原句还在这里，等一下可以再试。'),
          {},
          currentAllSecrets(),
        );
      }
    });

    hostServer.requestTimeout = 0;
    hostServer.headersTimeout = 15_000;

    const bound = await listenAsync(hostServer, port, host);
    const boundPort = typeof bound === 'object' && bound ? bound.port : port;
    const hostBracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    effectiveHost = `${hostBracketed}:${boundPort}`;
    effectiveOrigin = `http://${effectiveHost}`;
    allowedOriginSet = new Set([effectiveOrigin, ...allowedOrigins]);

    apiServer = createQuotationServer({
      store,
      orchestrator,
      auth,
      materialLoader: effectiveMaterialsAdapter,
      dataMode: 'real',
      modelConfig: modelConfigForServer,
      config: {
        ...publicConfig,
        demo: false,
        allowPersonalData: false,
        model: modelConfigForServer,
      },
      publicOrigin: effectiveOrigin,
      allowedOrigins: [...allowedOriginSet],
      secrets: baseSecretValues,
      logger,
    });

    if (!quiet && stderr) {
      stderr.write(
        `[quotation-public-web] 已启动真实公开同源宿主 ${effectiveOrigin} | dataMode=real | search=${searchStatus} | model=${modelStatus} | db=${path.basename(resolvedDbPath)} | 页面=${path.relative(AGENT_DIR, resolvedWebDir)}\n`,
      );
    }

    let closingPromise = null;
    const close = () => {
      if (!closingPromise) {
        closingPromise = (async () => {
          await closeServerAsync(hostServer);
          if (mcpConnection?.close) {
            try {
              await mcpConnection.close();
            } catch {
              // 忽略 MCP 关闭异常
            }
          }
          if (typeof store?.close === 'function') {
            try {
              store.close();
            } catch {
              // 忽略存储关闭异常
            }
          }
        })();
      }
      return closingPromise;
    };

    return {
      help: false,
      server: hostServer,
      origin: effectiveOrigin,
      host,
      port: boundPort,
      mode: 'public',
      dataMode: 'real',
      dbPath: resolvedDbPath,
      capabilities,
      auth,
      store,
      orchestrator,
      materialsAdapter: effectiveMaterialsAdapter,
      directToken,
      stdout,
      close,
    };
  } catch (err) {
    if (mcpConnection?.close) {
      try {
        await mcpConnection.close();
      } catch {
        // 忽略清理异常
      }
    }
    try {
      store.close();
    } catch {
      // 忽略清理异常
    }
    throw err;
  }
}

export async function main(args = [], {
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  signal,
  ...deps
} = {}) {
  let runtime = null;
  try {
    if (signal?.aborted) {
      throw new DOMException('Cancelled', 'AbortError');
    }
    const parsed = parsePublicWebHostArgs(args);
    if (parsed.help) {
      stdout.write(HELP);
      return 0;
    }

    const host = parsed.options.host
      ?? (typeof env.AGENT_PUBLIC_WEB_HOST === 'string' && env.AGENT_PUBLIC_WEB_HOST.trim()
        ? env.AGENT_PUBLIC_WEB_HOST.trim()
        : (typeof env.AGENT_SERVER_HOST === 'string' && env.AGENT_SERVER_HOST.trim()
          ? env.AGENT_SERVER_HOST.trim()
          : '127.0.0.1'));

    const rawEnvPort = (typeof env.AGENT_PUBLIC_WEB_PORT === 'string' && env.AGENT_PUBLIC_WEB_PORT.trim())
      || (typeof env.AGENT_SERVER_PORT === 'string' && env.AGENT_SERVER_PORT.trim())
      || null;
    const port = parsed.options.port
      ?? (rawEnvPort && /^[0-9]+$/.test(rawEnvPort) ? Number(rawEnvPort) : 3007);

    const dbPath = parsed.options.dbPath
      ?? (typeof env.AGENT_PUBLIC_DB_PATH === 'string' && env.AGENT_PUBLIC_DB_PATH.trim()
        ? env.AGENT_PUBLIC_DB_PATH.trim()
        : (typeof env.AGENT_DB_PATH === 'string' && env.AGENT_DB_PATH.trim()
          ? env.AGENT_DB_PATH.trim()
          : DEFAULT_DB_PATH));

    const envToken = typeof env.AGENT_SERVER_TOKEN === 'string' && env.AGENT_SERVER_TOKEN.trim()
      ? env.AGENT_SERVER_TOKEN.trim()
      : null;

    const envAllowedOrigins = typeof env.AGENT_ALLOWED_ORIGINS === 'string' && env.AGENT_ALLOWED_ORIGINS.trim()
      ? env.AGENT_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    runtime = await startPublicWebHost({
      host,
      port,
      dbPath,
      env,
      baseURL: parsed.options.baseURL,
      modelName: parsed.options.modelName,
      internalToken: envToken,
      allowedOrigins: envAllowedOrigins,
      stdout,
      stderr,
      ...deps,
    });

    await new Promise((resolvePromise) => {
      if (signal?.aborted) {
        resolvePromise();
        return;
      }
      signal?.addEventListener('abort', () => resolvePromise(), { once: true });
      runtime.server.once('close', () => resolvePromise());
    });

    await runtime.close();
    return 0;
  } catch (error) {
    if (runtime) {
      try {
        await runtime.close();
      } catch {
        // 忽略清理异常
      }
    }
    const safe = safeAgentError(error, signal);
    stderr.write(`${safe.message}\n`);
    return safe.exitCode;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    process.exitCode = await main(process.argv.slice(2), { signal: controller.signal });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
