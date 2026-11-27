#!/usr/bin/env node
// 「报价」正式星图页面与新版 `/v1` HTTP/SSE 同源宿主入口（演示隔离模式，零外部凭证可开箱运行）。
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentError, safeAgentError } from './errors.mjs';
import { apiError, apiOk } from './protocol.mjs';
import { createPrincipalAuth, createQuotationServer } from './server.mjs';
import { createSessionStore } from './session-store.mjs';
import { createMaterialsAdapter } from './materials.mjs';
import { createTurnOrchestrator } from './turn-orchestrator.mjs';
import {
  SYNTHETIC_SEARCH_CORPUS,
  createSyntheticMaterialAdapters,
} from './fixtures/synthetic-materials.mjs';

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_WEB_DIR = path.resolve(AGENT_DIR, '..', 'frontend-design', 'web');
const DEFAULT_DB_PATH = path.resolve(AGENT_DIR, '.data', 'sessions-demo-web.sqlite');
export const SESSION_COOKIE_NAME = 'quotation_demo_sid';
const MAX_HOST_SESSIONS = 256;

// 补充多领域合成检索语料（换班/排班场景），与默认推荐算法、远程办公语料并存，确保跨领域切换在零外部凭证下均有来源可查。
const EXTRA_DEMO_SEARCH_CORPUS = Object.freeze([
  Object.freeze({
    key: 'answer:9201',
    contentId: '9201',
    contentType: 'answer',
    title: '制造业工厂推行弹性换班制度后，产线良率为什么没有下降？',
    excerpt: '在完成标准交接清单与双人复核的电子装配车间中，允许一线班组提前报备换班后，疲劳误操作反而减少，单班良率保持稳定。',
    excerptTruncated: false,
    textKind: 'excerpt',
    fullTextAvailable: false,
    platformTags: null,
    url: 'https://www.zhihu.com/question/8201/answer/9201?utm_source=synthetic_search',
    canonicalUrl: 'https://www.zhihu.com/question/8201/answer/9201',
    author: '周景明',
    voteCount: 96,
    commentCount: 14,
    rankingScore: 0.88,
    createdTime: '2026-10-28T09:15:00.000Z',
    editedTime: null,
    topicHints: ['换班', '排班', '工厂', '车间', '产线', '良率', '交接', '反例'],
  }),
  Object.freeze({
    key: 'article:9202',
    contentId: '9202',
    contentType: 'article',
    title: '临时高频换班在哪些排班条件下会引发交接漏项？',
    excerpt: '当夜班与白班交接窗口不足十五分钟且缺少书面点检记录时，临时换班会明显增加工序漏检与设备参数配置偏差。',
    excerptTruncated: false,
    textKind: 'excerpt',
    fullTextAvailable: false,
    platformTags: null,
    url: 'https://zhuanlan.zhihu.com/p/9202?utm_source=synthetic_search',
    canonicalUrl: 'https://zhuanlan.zhihu.com/p/9202',
    author: '许砚秋',
    voteCount: 118,
    commentCount: 21,
    rankingScore: 0.9,
    createdTime: '2026-11-01T13:45:00.000Z',
    editedTime: null,
    topicHints: ['换班', '排班', '夜班', '工厂', '车间', '交接', '边界', '原因'],
  }),
]);

const DEFAULT_DEMO_SEARCH_CORPUS = Object.freeze([
  ...SYNTHETIC_SEARCH_CORPUS,
  ...EXTRA_DEMO_SEARCH_CORPUS,
]);

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

const HELP = `「报价」正式星图与 /v1 同源合成演示宿主（Node.js 24+）

用法：
  npm run serve:demo:web -- [选项]
  node --env-file-if-exists=.env demo-web-host.mjs [选项]

选项：
  --host <host>   监听主机地址（默认 127.0.0.1）
  --port <port>   监听端口，0 表示随机空闲端口（默认 3006）
  --db <path>     指定独立 SQLite 数据库路径（默认 .data/sessions-demo-web.sqlite）
  --help          显示本帮助说明

环境变量：
  AGENT_SERVER_TOKEN     可选：指定宿主内部 Bearer 令牌（未设置时自动生成临时随机令牌）
  AGENT_OWNER_ID         可选：指定演示主体 ID（默认 demo-web-owner）
  AGENT_ALLOWED_ORIGINS  可选：逗号分隔的额外允许同源列表
`;

function usageError(message) {
  return new AgentError('INVALID_ARGUMENTS', message, 2);
}

export function parseDemoWebHostArgs(args = []) {
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
        help: { type: 'boolean' },
      },
    });
  } catch {
    throw usageError('参数无效，请运行 node demo-web-host.mjs --help 查看格式。');
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

  return {
    help: false,
    options: {
      host,
      port,
      dbPath: values.db?.trim(),
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

  // 禁止访问隐藏文件、路径穿越段或验证脚本目录
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

function sendJsonResponse(res, status, payload, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

export async function startDemoWebHost({
  host = '127.0.0.1',
  port = 3006,
  dbPath = DEFAULT_DB_PATH,
  ownerId = 'demo-web-owner',
  internalToken: injectedInternalToken = null,
  bearerToken = null,
  model = null,
  orchestrator: injectedOrchestrator = null,
  materialLoader: injectedMaterialLoader = null,
  materialsAdapter: injectedMaterialsAdapter = null,
  syntheticOptions = {},
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

  const store = createSessionStore(resolvedDbPath, { dataMode: 'demo', demo: true });
  const synthetic = createSyntheticMaterialAdapters({
    searchCorpus: DEFAULT_DEMO_SEARCH_CORPUS,
    ...syntheticOptions,
  });
  const defaultMaterialsAdapter = createMaterialsAdapter({
    dataMode: 'demo',
    demo: true,
    callTool: synthetic.callTool,
    enabled: true,
  });
  const effectiveMaterialsAdapter = injectedMaterialsAdapter ?? injectedMaterialLoader ?? defaultMaterialsAdapter;
  const effectiveMaterialLoader = injectedMaterialLoader ?? injectedMaterialsAdapter ?? defaultMaterialsAdapter;

  const modelConfig = {
    providerName: model ? 'synthetic-model' : 'deterministic-demo',
    modelName: model ? 'synthetic-stream-v4' : 'deterministic-fallback',
    baseURL: 'http://127.0.0.1:11434/v1',
    ready: Boolean(model),
    isLocal: true,
    isLoopback: true,
    isCloud: false,
  };

  const orchestratorOptions = {
    store,
    dataMode: 'demo',
    demo: true,
    materialsAdapter: effectiveMaterialsAdapter,
    materialLoader: effectiveMaterialLoader,
    model,
    config: {
      demo: true,
      allowPersonalData: true,
      model: modelConfig,
    },
    fallbackExplanationWhenNoModel: !model,
  };

  const orchestrator = typeof injectedOrchestrator === 'function'
    ? await injectedOrchestrator(orchestratorOptions)
    : (injectedOrchestrator ?? createTurnOrchestrator(orchestratorOptions));

  const rawToken = injectedInternalToken ?? bearerToken;
  const internalToken = typeof rawToken === 'string' && rawToken.trim()
    ? rawToken.trim()
    : `qtn_demo_host_${randomBytes(32).toString('base64url')}`;

  const auth = createPrincipalAuth({
    tokens: [
      {
        token: internalToken,
        ownerId,
        label: 'demo-web-host-internal',
        dataMode: 'demo',
      },
    ],
  });

  // 浏览器同源会话 ID 表（仅存随机不透明会话键，绝不含 Bearer 令牌或用户隐私）
  const sessionIds = new Set();
  const issueSessionId = () => {
    const sid = randomBytes(32).toString('base64url');
    if (sessionIds.size >= MAX_HOST_SESSIONS) {
      const oldest = sessionIds.values().next().value;
      if (oldest) sessionIds.delete(oldest);
    }
    sessionIds.add(sid);
    return sid;
  };
  const hasValidSessionCookie = (req) => {
    const cookies = parseCookies(req.headers.cookie);
    const val = cookies.get(SESSION_COOKIE_NAME);
    return typeof val === 'string' && sessionIds.has(val);
  };
  const ensureSessionCookieHeader = (req) => {
    if (hasValidSessionCookie(req)) return null;
    const sid = issueSessionId();
    return `${SESSION_COOKIE_NAME}=${sid}; HttpOnly; SameSite=Strict; Path=/`;
  };

  let effectiveOrigin = null;
  let effectiveHost = null;
  let allowedOriginSet = new Set();
  let apiServer = null;
  let sseConnectSeq = 0;

  const hostServer = createServer((req, res) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');

      if (!effectiveHost || req.headers.host !== effectiveHost) {
        sendJsonResponse(res, 403, apiError('HOST_DENIED', '请求 Host 与本机同源宿主地址不一致。'));
        return;
      }

      const requestOrigin = req.headers.origin;
      if (requestOrigin && !allowedOriginSet.has(requestOrigin)) {
        sendJsonResponse(res, 403, apiError('ORIGIN_DENIED', '请求 Origin 不在允许的本机同源范围内。'));
        return;
      }

      if (hasRawTraversalPattern(req.url)) {
        sendJsonResponse(res, 403, apiError('INVALID_ARGUMENTS', '禁止访问非法或越界路径。'));
        return;
      }

      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', effectiveOrigin);
      const pathname = url.pathname;

      if (pathname === '/favicon.ico' && (method === 'GET' || method === 'HEAD')) {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      // 1. GET /health 直接交由内部 /v1 服务处理
      if (pathname === '/health' && method === 'GET') {
        apiServer.emit('request', req, res);
        return;
      }

      // 2. 同源宿主会话引导接口（签发 HttpOnly; SameSite=Strict Cookie，绝不下发任何令牌）
      if (pathname === '/api/host/session' && method === 'POST') {
        const secFetchSite = req.headers['sec-fetch-site'];
        if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
          sendJsonResponse(res, 403, apiError('ORIGIN_DENIED', '跨站请求不能建立本机同源演示会话。'));
          return;
        }
        const setCookie = ensureSessionCookieHeader(req);
        sendJsonResponse(
          res,
          200,
          apiOk({
            mode: 'demo',
            dataMode: 'demo',
            hostReady: true,
            usePersonalMaterials: true,
            capabilities: {
              searchReady: true,
              searchStatus: 'ready',
              modelReady: true,
              modelStatus: 'ready',
              canSwitchToDemo: false,
            },
          }),
          setCookie ? { 'Set-Cookie': setCookie } : {},
        );
        return;
      }

      // 3. /v1/* 请求：兼容显式 Authorization Bearer 直连，同时为同源页面通过 HttpOnly Cookie 在服务端注入内部 Bearer
      if (pathname.startsWith('/v1/')) {
        if (method === 'OPTIONS') {
          apiServer.emit('request', req, res);
          return;
        }

        const hasAuthorizationHeader = typeof req.headers.authorization === 'string'
          && req.headers.authorization.trim().length > 0;

        if (!hasAuthorizationHeader) {
          if (!isAllowedBrowserV1Route(method, pathname)) {
            sendJsonResponse(res, 403, apiError('SESSION_FORBIDDEN', '该接口路径或方法不在同源浏览器允许白名单内。'));
            return;
          }

          const secFetchSite = req.headers['sec-fetch-site'];
          if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
            sendJsonResponse(res, 403, apiError('ORIGIN_DENIED', '跨站请求被本机同源宿主拒绝。'));
            return;
          }

          if (!hasValidSessionCookie(req)) {
            sendJsonResponse(
              res,
              401,
              apiError('UNAUTHORIZED', '本机同源演示会话未建立或已过期，请刷新页面重新进入。'),
            );
            return;
          }

          // 仅在服务端内存中注入内部 Bearer，绝不回传给浏览器
          req.headers.authorization = `Bearer ${internalToken}`;
        }

        // 测试钩子：允许自动化测试在指定 SSE 连接上观察并模拟流中断
        const sseMatch = method === 'GET'
          ? pathname.match(/^\/v1\/sessions\/([^/]+)\/turns\/([^/]+)\/events$/)
          : null;
        if (sseMatch && typeof onSseResponse === 'function') {
          sseConnectSeq += 1;
          onSseResponse({
            request: req,
            response: res,
            sessionId: decodeURIComponent(sseMatch[1]),
            turnId: decodeURIComponent(sseMatch[2]),
            lastEventId: req.headers['last-event-id'] ? String(req.headers['last-event-id']) : null,
            attempt: sseConnectSeq,
          });
        }

        apiServer.emit('request', req, res);
        return;
      }

      // 4. 静态托管 frontend-design/web/ 正式页面与脚本样式
      if (method === 'GET' || method === 'HEAD') {
        const staticFile = resolveSafeStaticFile(resolvedWebDir, pathname);
        if (!staticFile) {
          sendJsonResponse(res, 404, apiError('SESSION_NOT_FOUND', '请求的页面资源不存在。'));
          return;
        }

        const headers = {
          'Content-Type': staticFile.contentType,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        };
        if (pathname === '/' || pathname === '/index.html') {
          const setCookie = ensureSessionCookieHeader(req);
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

      sendJsonResponse(res, 404, apiError('SESSION_NOT_FOUND', '请求的接口路径或方法不存在。'));
    } catch {
      sendJsonResponse(res, 500, apiError('INTERNAL_ERROR', '本机宿主处理请求时发生内部异常。'));
    }
  });

  hostServer.requestTimeout = 0;
  hostServer.headersTimeout = 15_000;

  try {
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
      materialLoader: effectiveMaterialLoader,
      dataMode: 'demo',
      modelConfig,
      config: {
        demo: true,
        allowPersonalData: true,
        model: modelConfig,
      },
      publicOrigin: effectiveOrigin,
      allowedOrigins: [...allowedOriginSet],
      secrets: [internalToken],
      logger,
    });

    if (!quiet && stderr) {
      stderr.write(
        `[quotation-demo-web] 已启动同源演示宿主 ${effectiveOrigin} | dataMode=demo | db=${path.basename(resolvedDbPath)} | 页面=${path.relative(AGENT_DIR, resolvedWebDir)}\n`,
      );
    }

    let closingPromise = null;
    const close = () => {
      if (!closingPromise) {
        closingPromise = (async () => {
          await closeServerAsync(hostServer);
          if (typeof store?.close === 'function') {
            try {
              store.close();
            } catch {
              // 忽略关闭异常
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
      dataMode: 'demo',
      dbPath: resolvedDbPath,
      ownerId,
      // 仅对同进程程序化调用与自动化测试返回内存引用，绝不打印日志或暴露到前端响应。
      internalToken,
      auth,
      store,
      orchestrator,
      synthetic,
      stdout,
      close,
    };
  } catch (err) {
    try {
      await closeServerAsync(hostServer);
    } catch {
      // 忽略清理异常
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
} = {}) {
  let runtime = null;
  try {
    if (signal?.aborted) {
      throw new DOMException('Cancelled', 'AbortError');
    }
    const parsed = parseDemoWebHostArgs(args);
    if (parsed.help) {
      stdout.write(HELP);
      return 0;
    }

    const host = parsed.options.host
      ?? (typeof env.AGENT_DEMO_WEB_HOST === 'string' && env.AGENT_DEMO_WEB_HOST.trim()
        ? env.AGENT_DEMO_WEB_HOST.trim()
        : (typeof env.AGENT_SERVER_HOST === 'string' && env.AGENT_SERVER_HOST.trim()
          ? env.AGENT_SERVER_HOST.trim()
          : '127.0.0.1'));

    const rawEnvPort = (typeof env.AGENT_DEMO_WEB_PORT === 'string' && env.AGENT_DEMO_WEB_PORT.trim())
      || (typeof env.AGENT_SERVER_PORT === 'string' && env.AGENT_SERVER_PORT.trim())
      || null;
    const port = parsed.options.port
      ?? (rawEnvPort && /^[0-9]+$/.test(rawEnvPort) ? Number(rawEnvPort) : 3006);

    const dbPath = parsed.options.dbPath
      ?? (typeof env.AGENT_DB_PATH === 'string' && env.AGENT_DB_PATH.trim()
        ? env.AGENT_DB_PATH.trim()
        : DEFAULT_DB_PATH);

    const envToken = typeof env.AGENT_SERVER_TOKEN === 'string' && env.AGENT_SERVER_TOKEN.trim()
      ? env.AGENT_SERVER_TOKEN.trim()
      : null;

    const ownerId = typeof env.AGENT_OWNER_ID === 'string' && env.AGENT_OWNER_ID.trim()
      ? env.AGENT_OWNER_ID.trim()
      : 'demo-web-owner';

    const envAllowedOrigins = typeof env.AGENT_ALLOWED_ORIGINS === 'string' && env.AGENT_ALLOWED_ORIGINS.trim()
      ? env.AGENT_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    runtime = await startDemoWebHost({
      host,
      port,
      dbPath,
      ownerId,
      internalToken: envToken,
      allowedOrigins: envAllowedOrigins,
      stdout,
      stderr,
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
