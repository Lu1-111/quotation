#!/usr/bin/env node
// 「报价」后端 `/v1` HTTP/SSE 独立服务启动器（不改动既有 cli.mjs 产品入口）。
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentError, safeAgentError } from './errors.mjs';
import { DATA_MODES } from './protocol.mjs';
import { createPrincipalAuth, createQuotationServer } from './server.mjs';

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));

const HELP = `「报价」后端 HTTP/SSE 服务启动器（Node.js 24+）

用法：
  node --env-file-if-exists=.env serve-cli.mjs [选项]

选项：
  --host <host>             监听主机地址（默认 127.0.0.1）
  --port <port>             监听端口，0 表示随机空闲端口（默认 3006）
  --demo                    使用合成演示模式（默认数据文件 .data/sessions-demo.sqlite）
  --allow-personal-data     允许在授权前提下连接个人采集只读入口
  --db <path>               指定 SQLite 会话库路径（默认按 demo/real 物理隔离）
  --base-url <url>          覆盖 AGENT_BASE_URL
  --model <name>            覆盖 AGENT_MODEL
  --max-steps <n>           覆盖 AGENT_MAX_STEPS
  --help                    显示本帮助说明

环境变量：
  AGENT_SERVER_TOKEN        本机宿主 Bearer 令牌（未设置时自动生成临时安全令牌）
  AGENT_OWNER_ID            本机默认授权主体标识（默认 local-owner）
  AGENT_TOKEN_FILE          可选：将生成的本机宿主令牌以 0600 权限写入指定路径供桌面宿主读取
  AGENT_ALLOWED_ORIGINS     可选：逗号分隔的同源白名单（如 Electron 宿主来源）
`;

function usageError(message) {
  return new AgentError('INVALID_ARGUMENTS', message, 2);
}

export function parseServeCliArgs(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        host: { type: 'string' },
        port: { type: 'string' },
        demo: { type: 'boolean' },
        'allow-personal-data': { type: 'boolean' },
        db: { type: 'string' },
        'base-url': { type: 'string' },
        model: { type: 'string' },
        'max-steps': { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch {
    throw usageError('参数无效，请运行 node serve-cli.mjs --help 查看格式。');
  }

  const { values } = parsed;
  if (values.help) {
    return { help: true, options: values };
  }

  const host = values.host !== undefined ? values.host.trim() : undefined;
  if (values.host !== undefined && !host) {
    throw usageError('--host 不能为空。');
  }

  let port;
  if (values.port !== undefined) {
    if (!/^[0-9]+$/.test(values.port.trim())) {
      throw usageError('--port 必须是 0 到 65535 之间的整数。');
    }
    port = Number(values.port.trim());
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw usageError('--port 必须是 0 到 65535 之间的整数。');
    }
  }

  if (values.db !== undefined && !values.db.trim()) {
    throw usageError('--db 不能为空。');
  }

  if (values['max-steps'] !== undefined && !/^[0-9]+$/.test(values['max-steps'].trim())) {
    throw usageError('--max-steps 必须是正整数。');
  }

  for (const key of ['base-url', 'model']) {
    if (values[key] !== undefined && !values[key].trim()) {
      throw usageError(`--${key} 不能为空。`);
    }
  }

  return {
    help: false,
    options: {
      host,
      port,
      demo: Boolean(values.demo),
      allowPersonalData: Boolean(values['allow-personal-data']),
      db: values.db?.trim(),
      baseURL: values['base-url']?.trim(),
      modelName: values.model?.trim(),
      maxSteps: values['max-steps'] !== undefined ? Number(values['max-steps'].trim()) : undefined,
    },
  };
}

// 演示与真实模式默认使用物理隔离的 SQLite 文件，从存储层杜绝数据混用。
export function resolveDefaultDbPath(dataMode, customDbPath, baseDir = AGENT_DIR) {
  if (!DATA_MODES.includes(dataMode)) {
    throw usageError(`不支持的数据模式：${String(dataMode)}`);
  }
  if (customDbPath && customDbPath.trim()) {
    return path.resolve(baseDir, customDbPath.trim());
  }
  const filename = dataMode === 'demo' ? 'sessions-demo.sqlite' : 'sessions-real.sqlite';
  return path.resolve(baseDir, '.data', filename);
}

function expectsObjectFirstArg(fn) {
  if (typeof fn !== 'function') return false;
  const src = Function.prototype.toString.call(fn).trim();
  const match = src.match(/^(?:async\s+)?(?:function(?:\s+\w+)?\s*|\w+\s*)?\(([^)]*)\)/);
  const firstParam = match?.[1]?.split(',')[0]?.trim() ?? '';
  return firstParam.startsWith('{');
}

function buildMcpCallTool(tools = {}) {
  return async (toolName, args = {}, { signal } = {}) => {
    const tool = tools?.[toolName];
    if (!tool || typeof tool.execute !== 'function') {
      return {
        schemaVersion: 1,
        ok: false,
        data: null,
        error: { code: 'NOT_CONFIGURED', message: `未启用工具：${toolName}` },
      };
    }
    return tool.execute(args, { abortSignal: signal });
  };
}

async function tryImportFirst(specifiers) {
  for (const specifier of specifiers) {
    try {
      return await import(specifier);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND') continue;
      throw error;
    }
  }
  return null;
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
    server.closeIdleConnections?.();
  });
}

export async function startQuotationService(args = [], {
  env = {},
  stdout = process.stdout,
  stderr = process.stderr,
  loadConfig: injectedLoadConfig,
  createSessionStore: injectedCreateSessionStore,
  createMaterialLoader: injectedCreateMaterialLoader,
  createTurnOrchestrator: injectedCreateTurnOrchestrator,
  connectServers: injectedConnectServers,
  createServerImpl = createQuotationServer,
} = {}) {
  const parsed = parseServeCliArgs(args);
  if (parsed.help) {
    stdout.write(HELP);
    return { help: true, close: async () => {} };
  }

  const { options } = parsed;
  const envDemo = typeof env.AGENT_DATA_MODE === 'string' && env.AGENT_DATA_MODE.trim() === 'demo';
  const demo = options.demo || envDemo;
  const dataMode = demo ? 'demo' : 'real';

  const overrides = {};
  if (demo) overrides.demo = true;
  if (options.allowPersonalData) overrides.allowPersonalData = true;
  if (options.baseURL !== undefined) overrides.baseURL = options.baseURL;
  if (options.modelName !== undefined) overrides.modelName = options.modelName;
  if (options.maxSteps !== undefined) overrides.maxSteps = options.maxSteps;

  const loadCfg = injectedLoadConfig ?? (await import('./config.mjs')).loadConfig;
  const config = await loadCfg({ env, overrides });

  const host = options.host ?? (typeof env.AGENT_SERVER_HOST === 'string' && env.AGENT_SERVER_HOST.trim() ? env.AGENT_SERVER_HOST.trim() : '127.0.0.1');
  const rawEnvPort = typeof env.AGENT_SERVER_PORT === 'string' && env.AGENT_SERVER_PORT.trim() ? env.AGENT_SERVER_PORT.trim() : null;
  const port = options.port ?? (rawEnvPort && /^[0-9]+$/.test(rawEnvPort) ? Number(rawEnvPort) : 3006);
  const dbPath = resolveDefaultDbPath(dataMode, options.db ?? env.AGENT_DB_PATH);

  // 1. 初始化 SQLite 会话存储
  let createStoreFn = injectedCreateSessionStore;
  if (!createStoreFn) {
    const storeMod = await tryImportFirst(['./session-store.mjs', './store.mjs']);
    createStoreFn = storeMod?.createSessionStore ?? storeMod?.createStore ?? null;
  }
  if (typeof createStoreFn !== 'function') {
    throw new AgentError('INTERNAL_ERROR', '缺少会话存储模块（session-store.mjs），无法启动后端服务。', 1);
  }
  const store = expectsObjectFirstArg(createStoreFn)
    ? await createStoreFn({ filename: dbPath, dbPath, dataMode, demo })
    : await createStoreFn(dbPath, { dataMode, demo });

  let mcpConnection = null;
  try {
    // 2. 可选连接 MCP 工具服务（缺凭证时保留无工具能力以支持空材料会话或按轮报错）
    const connectFn = injectedConnectServers ?? (await import('./mcp-servers.mjs')).connectServers;
    try {
      mcpConnection = await connectFn(config);
    } catch (mcpError) {
      if (!(mcpError instanceof AgentError && mcpError.code === 'NO_TOOLS_ENABLED')) {
        throw mcpError;
      }
    }

    const mcpTools = mcpConnection?.tools ?? {};
    const callTool = buildMcpCallTool(mcpTools);

    // 3. 初始化个人材料加载适配器与公开检索桥接
    let materialLoader = null;
    let materialsAdapter = null;
    let createMaterialFn = injectedCreateMaterialLoader;
    const matMod = !createMaterialFn
      ? await tryImportFirst(['./materials.mjs', './material-loader.mjs', './material-adapter.mjs'])
      : null;
    if (!createMaterialFn && matMod) {
      createMaterialFn = matMod.createMaterialLoader ?? matMod.createMaterialsAdapter ?? matMod.createMaterialAdapter ?? null;
    }

    if (typeof createMaterialFn === 'function') {
      materialLoader = await createMaterialFn({
        config,
        env,
        dataMode,
        demo,
        tools: mcpTools,
        callTool,
      });
      materialsAdapter = materialLoader;
    } else if (matMod && typeof matMod.loadAuthorizedCollectionMaterials === 'function') {
      const hasCollectionTool = Boolean(config.allowPersonalData && mcpTools.zhihu_knowledge_profile);
      const hasSearchTool = Boolean(mcpTools.zhihu_search);
      if (hasCollectionTool) {
        materialLoader = {
          enabled: true,
          async loadMaterials({ snapshotId }) {
            return matMod.loadAuthorizedCollectionMaterials({
              callTool,
              lockedSnapshotId: snapshotId ?? null,
            });
          },
        };
      }
      if (hasCollectionTool || hasSearchTool) {
        materialsAdapter = {
          ...(hasCollectionTool
            ? {
                async readCollectionCandidates({ snapshotId, signal }) {
                  const res = await matMod.loadAuthorizedCollectionMaterials({
                    callTool,
                    lockedSnapshotId: snapshotId ?? null,
                    signal,
                  });
                  return res.evidence ?? [];
                },
              }
            : {}),
          ...(hasSearchTool && typeof matMod.searchPublicEvidenceByGap === 'function'
            ? {
                async searchPublicEvidence({ query, maxQueries = 2, limit = 6, signal }) {
                  const res = await matMod.searchPublicEvidenceByGap({
                    callTool,
                    sentence: query,
                    maxQueries,
                    limit,
                    forceSearch: true,
                    signal,
                  });
                  if (res.status === 'rate_limited') {
                    return { ok: false, error: { code: 'RATE_LIMITED', message: res.message } };
                  }
                  return { ok: true, items: res.evidence ?? [] };
                },
              }
            : {}),
        };
      }
    }

    // 4. 初始化流式轮次编排器
    let orchestrator = null;
    let createOrchestratorFn = injectedCreateTurnOrchestrator;
    if (!createOrchestratorFn) {
      const orchMod = await tryImportFirst(['./turn-orchestrator.mjs', './orchestrator.mjs', './stream-orchestrator.mjs']);
      createOrchestratorFn = orchMod?.createTurnOrchestrator ?? orchMod?.createStreamOrchestrator ?? orchMod?.createOrchestrator ?? null;
    }
    if (typeof createOrchestratorFn === 'function') {
      orchestrator = await createOrchestratorFn({
        config,
        env,
        store,
        dataMode,
        demo,
        tools: mcpTools,
        materialLoader,
        materialsAdapter,
        fallbackExplanationWhenNoModel: demo && !config?.model?.ready,
      });
    }

    // 5. 初始化本机多主体鉴权凭证（不把用户隐私写入日志）
    const envToken = typeof env.AGENT_SERVER_TOKEN === 'string' && env.AGENT_SERVER_TOKEN.trim()
      ? env.AGENT_SERVER_TOKEN.trim()
      : null;
    const activeToken = envToken ?? `qtn_${randomBytes(32).toString('base64url')}`;
    const ownerId = typeof env.AGENT_OWNER_ID === 'string' && env.AGENT_OWNER_ID.trim()
      ? env.AGENT_OWNER_ID.trim()
      : 'local-owner';

    const auth = createPrincipalAuth({
      tokens: [{ token: activeToken, ownerId, label: envToken ? 'env-configured' : 'ephemeral-host', dataMode }],
    });

    if (!envToken && typeof env.AGENT_TOKEN_FILE === 'string' && env.AGENT_TOKEN_FILE.trim()) {
      const tokenFilePath = path.resolve(AGENT_DIR, env.AGENT_TOKEN_FILE.trim());
      mkdirSync(path.dirname(tokenFilePath), { recursive: true, mode: 0o700 });
      writeFileSync(tokenFilePath, `${activeToken}\n`, { mode: 0o600 });
    }

    const allowedOrigins = typeof env.AGENT_ALLOWED_ORIGINS === 'string' && env.AGENT_ALLOWED_ORIGINS.trim()
      ? env.AGENT_ALLOWED_ORIGINS.split(',').map((item) => item.trim()).filter(Boolean)
      : [];

    const hostBracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const publicOrigin = `http://${hostBracketed}:${port}`;

    const secretValues = [
      env.AGENT_API_KEY,
      env.ZHIHU_ACCESS_SECRET,
      env.DATA_SERVICE_AGENT_TOKEN,
      env.DATA_SERVICE_USER_TOKEN,
      activeToken,
    ].filter((val) => typeof val === 'string' && val.trim().length >= 6);

    const logger = (entry) => {
      stdout.write(`${JSON.stringify({ type: 'http_access', ...entry })}\n`);
    };

    const server = createServerImpl({
      store,
      orchestrator,
      auth,
      materialLoader,
      dataMode,
      config,
      publicOrigin,
      allowedOrigins,
      secrets: secretValues,
      logger,
    });

    const bound = await listenAsync(server, port, host);
    const boundPort = typeof bound === 'object' && bound ? bound.port : port;
    const effectiveOrigin = `http://${hostBracketed}:${boundPort}`;

    const authModeHint = envToken
      ? '使用环境变量 AGENT_SERVER_TOKEN 鉴权'
      : (env.AGENT_TOKEN_FILE ? '已生成本机随机 Bearer 令牌并写入 AGENT_TOKEN_FILE' : '已生成本机会话期随机 Bearer 令牌（建议通过 AGENT_SERVER_TOKEN 或 AGENT_TOKEN_FILE 与本机宿主共享）');

    stderr.write(
      `[quotation-backend] 已启动监听 ${effectiveOrigin} | dataMode=${dataMode} | db=${path.basename(dbPath)} | 鉴权=${authModeHint}\n`,
    );

    let closingPromise = null;
    const close = () => {
      if (!closingPromise) {
        closingPromise = (async () => {
          await closeServerAsync(server);
          if (mcpConnection?.close) {
            try { await mcpConnection.close(); } catch { /* 忽略关闭异常 */ }
          }
          if (typeof store?.close === 'function') {
            try { await store.close(); } catch { /* 忽略关闭异常 */ }
          }
        })();
      }
      return closingPromise;
    };

    return {
      help: false,
      server,
      origin: effectiveOrigin,
      port: boundPort,
      dataMode,
      dbPath,
      ownerId,
      auth,
      // 仅对同进程宿主/测试返回内存引用，不打印至日志。
      bootstrapToken: envToken ? null : activeToken,
      close,
    };
  } catch (startupError) {
    if (mcpConnection?.close) {
      try { await mcpConnection.close(); } catch { /* 忽略回收错误 */ }
    }
    if (typeof store?.close === 'function') {
      try { await store.close(); } catch { /* 忽略回收错误 */ }
    }
    throw startupError;
  }
}

export async function main(args, {
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
    runtime = await startQuotationService(args, { env, stdout, stderr, ...deps });
    if (runtime.help) return 0;

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
      try { await runtime.close(); } catch { /* 忽略清理异常 */ }
    }
    const safe = safeAgentError(error, signal);
    stderr.write(`${safe.message}\n`);
    return safe.exitCode;
  }
}

if (process.argv[1] && pathToFileURL(resolvePath(process.argv[1])).href === import.meta.url) {
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

function resolvePath(target) {
  return path.resolve(target);
}
