// 统一应用内核与 HTTP/SSE 服务端：
// 将 数据采集 -> 用户数据库 -> [画像 Agent + 数据转换 Agent] -> 星球数据库（实时监听）-> 星图写入 Agent -> 3D 星图前端 完整串联。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConverterAgent } from './agents/converter-agent.mjs';
import { createLlmConfigStore } from './agents/llm.mjs';
import { createProfileAgent } from './agents/profile-agent.mjs';
import { createStarWriterAgent } from './agents/star-writer-agent.mjs';
import { createZhihuOAuthService } from './auth/zhihu-oauth.mjs';
import { createCollectorService } from './collector/collector.mjs';
import { createPlanetsDatabase } from './db/planets-db.mjs';
import { createProfileStore } from './db/profile-store.mjs';
import { createStarMapStore } from './db/star-map-store.mjs';
import { createUserDatabase } from './db/user-db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

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

async function readJsonBody(req, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('请求体过大。'), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('请求体不是合法的 JSON。'), { status: 400 });
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export async function createStarAtlasApp({
  dataDir = path.join(PROJECT_ROOT, 'data'),
  secretsDir = path.join(PROJECT_ROOT, '.data'),
  webDir = path.join(PROJECT_ROOT, 'web'),
  browserChannel = process.env.COLLECTOR_BROWSER || 'auto',
  getModelOverride = null,
  gatewayFactory = null,
  autoWatch = true,
} = {}) {
  const userDb = createUserDatabase(path.join(dataDir, 'user-db.json'));
  const planetsDb = createPlanetsDatabase(path.join(dataDir, 'planets-db.json'));
  const starMapStore = createStarMapStore(path.join(dataDir, 'star-map.json'));
  const profileStore = createProfileStore(path.join(dataDir, 'profile.json'));
  const llmConfigStore = createLlmConfigStore(secretsDir);
  const zhihuOAuth = createZhihuOAuthService();

  await Promise.all([
    userDb.ensureInitialized(),
    planetsDb.ensureInitialized(),
    starMapStore.ensureInitialized(),
  ]);

  const sseClients = new Set();
  const pipelineLog = [];

  const pipelineState = {
    collection: { status: 'idle', stage: null, fetched: 0, lastStats: null, error: null },
    profile: { status: 'idle', lastUpdatedAt: null, error: null },
    converter: { status: 'idle', lastStats: null, error: null },
    starWriter: { status: 'watching', lastStats: null, error: null },
  };

  function pushLog(actor, message, detail = null) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: new Date().toISOString(),
      actor,
      message,
      detail,
    };
    pipelineLog.unshift(entry);
    if (pipelineLog.length > 40) pipelineLog.length = 40;
    broadcast('pipeline.log', entry);
  }

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  const getModel = getModelOverride || (() => llmConfigStore.getModel());

  const profileAgent = createProfileAgent({ userDb, profileStore, getModel });

  const converterAgent = createConverterAgent({
    userDb,
    planetsDb,
    getModel,
    onProgress(info) {
      pipelineState.converter.status = info.stage === 'converted' ? 'idle' : 'running';
      broadcast('converter.progress', info);
    },
  });

  const starWriterAgent = createStarWriterAgent({
    planetsDb,
    starMapStore,
    getModel,
    onStarMapUpdated({ stats, newlyPlacedPlanets, starMap }) {
      pipelineState.starWriter.status = 'watching';
      pipelineState.starWriter.lastStats = stats;
      pipelineState.starWriter.error = null;
      pushLog(
        '星图写入 Agent',
        `已写入 ${stats.placedCount} 颗星球（新开星系 ${stats.newGalaxies} 个，新建连线 ${stats.addedLinks} 条）`,
        stats,
      );
      broadcast('starmap.updated', {
        stats,
        newlyPlacedIds: newlyPlacedPlanets.map((p) => p.id),
        starMap,
      });
    },
  });

  starWriterAgent.events.on('error', (err) => {
    pipelineState.starWriter.status = 'error';
    pipelineState.starWriter.error = err?.message || '星图写入失败';
    pushLog('星图写入 Agent', `写入失败：${pipelineState.starWriter.error}`);
    broadcast('pipeline.error', { actor: 'starWriter', message: pipelineState.starWriter.error });
  });

  planetsDb.events.on('change', ({ reason, data }) => {
    if (reason === 'planets_added' || reason === 'external_file_change' || reason === 'planets_reset_pending') {
      pipelineState.starWriter.status = 'running';
      broadcast('planets.changed', {
        reason,
        total: data.records.length,
        pending: data.records.filter((r) => r.status !== 'placed').length,
      });
    }
  });

  async function runPostCollectionPipeline({ syncStats }) {
    pipelineState.collection.status = 'idle';
    pipelineState.collection.lastStats = syncStats;
    pipelineState.collection.error = null;
    pushLog(
      '数据采集',
      `同步完成（${syncStats.mode === 'initial' ? '初次采集' : '增量同步'}，共 ${syncStats.fetchedCount} 条，耗时 ${(
        syncStats.durationMs / 1000
      ).toFixed(2)}s）`,
      syncStats,
    );
    broadcast('collection.completed', syncStats);

    // 画像 Agent 与数据转换 Agent 紧随采集结束并行触发（画像与采集强绑定，数据转换写入星球库后实时唤醒星图写入 Agent）
    const profileTask = (async () => {
      pipelineState.profile.status = 'running';
      pipelineState.profile.error = null;
      broadcast('pipeline.state', pipelineState);
      pushLog('画像 Agent', '开始读取用户数据库并生成知识与偏好画像...');
      try {
        const res = await profileAgent.run({ force: true });
        pipelineState.profile.status = 'idle';
        pipelineState.profile.lastUpdatedAt = res.profile?.generatedAt || new Date().toISOString();
        pushLog('画像 Agent', `用户画像已更新（覆盖 ${res.profile?.coverage?.records ?? 0} 条记录）`);
        broadcast('profile.updated', res.profile);
        return res;
      } catch (err) {
        pipelineState.profile.status = 'error';
        pipelineState.profile.error = err?.message || '画像更新失败';
        pushLog('画像 Agent', `更新失败（已保留旧画像）：${pipelineState.profile.error}`);
        broadcast('pipeline.error', { actor: 'profile', message: pipelineState.profile.error });
        return null;
      }
    })();

    const converterTask = (async () => {
      pipelineState.converter.status = 'running';
      pipelineState.converter.error = null;
      broadcast('pipeline.state', pipelineState);
      pushLog('数据转换 Agent', '开始过滤非知识噪音并提炼结构化知识点...');
      try {
        const res = await converterAgent.run();
        pipelineState.converter.status = 'idle';
        pipelineState.converter.lastStats = res;
        if (!res.skipped) {
          pushLog(
            '数据转换 Agent',
            `处理 ${res.processedRecords} 条记录：提炼 ${res.addedPlanets} 颗新星球（合并 ${res.updatedPlanets} 颗，过滤非知识条目 ${res.discardedCount} 条）`,
            res,
          );
        } else {
          pushLog('数据转换 Agent', '没有待转换的新增用户记录');
        }
        broadcast('converter.completed', res);
        return res;
      } catch (err) {
        pipelineState.converter.status = 'error';
        pipelineState.converter.error = err?.message || '数据转换失败';
        pushLog('数据转换 Agent', `转换失败：${pipelineState.converter.error}`);
        broadcast('pipeline.error', { actor: 'converter', message: pipelineState.converter.error });
        return null;
      }
    })();

    await Promise.all([profileTask, converterTask]);
    // 等待星图写入 Agent 完成当前所有待写入条目
    await starWriterAgent.processPending();
    broadcast('pipeline.state', pipelineState);
  }

  const collector = createCollectorService({
    userDb,
    dataDir,
    channel: browserChannel,
    gatewayFactory,
    onProgress(info) {
      pipelineState.collection.status = info.stage === 'completed' ? 'idle' : 'running';
      pipelineState.collection.stage = info.stage;
      pipelineState.collection.fetched = info.fetched;
      broadcast('collection.progress', info);
    },
    onLoginState(info) {
      if (info.state === 'logged_in') {
        pushLog('数据采集', `已检测到知乎登录成功（账号：${info.account?.nickname || '已认证'}），现在可以点击同步`);
        broadcast('collection.logged_in', info.account);
      }
    },
    onSyncComplete: async ({ syncStats }) => {
      // 同步完成后异步不阻塞采集计时统计，但仍等待完整链路供调用方感知
      await runPostCollectionPipeline({ syncStats });
    },
  });

  if (autoWatch) {
    starWriterAgent.startWatching();
  }

  async function buildStatusPayload(req = null) {
    const [modelConfig, collectionState, starMap, planetsData, profile] = await Promise.all([
      llmConfigStore.getPublicConfig(),
      collector.getState(),
      starMapStore.read(),
      planetsDb.read(),
      profileStore.read(),
    ]);
    const oauthSess = req ? zhihuOAuth.getSession(req) : zhihuOAuth.getLatestSession();
    return {
      ok: true,
      model: modelConfig,
      oauth: {
        configured: zhihuOAuth.configured,
        redirectUri: zhihuOAuth.redirectUri,
        callbackBridge: zhihuOAuth.callbackOrigin,
        authenticated: Boolean(oauthSess),
        account: oauthSess ? { accountId: oauthSess.accountId, nickname: oauthSess.nickname } : null,
      },
      collection: collectionState,
      pipeline: pipelineState,
      logs: pipelineLog.slice(0, 20),
      counts: {
        userRecords: collectionState.totalRecords,
        planetsDbTotal: planetsData.records.length,
        planetsDbPending: planetsData.records.filter((r) => r.status !== 'placed').length,
        starMapGalaxies: starMap.galaxies.length,
        starMapPlanets: starMap.planets.length,
        starMapLinks: starMap.links.length,
        hasProfile: Boolean(profile),
      },
    };
  }

  async function serveStatic(reqPath, res) {
    const cleanPath = reqPath === '/' ? '/index.html' : reqPath === '/workbench' ? '/workbench.html' : reqPath;
    const normalized = path.normalize(cleanPath).replace(/^(\.\.[/\\])+/, '');
    const fullPath = path.resolve(webDir, `.${path.sep}${normalized}`);
    if (!fullPath.startsWith(path.resolve(webDir))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    try {
      const info = await stat(fullPath);
      if (!info.isFile()) throw Object.assign(new Error('Not a file'), { code: 'ENOENT' });
      const content = await readFile(fullPath);
      const ext = path.extname(fullPath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
      });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    try {
      const origin = `http://${req.headers.host || '127.0.0.1:3300'}`;

      if (req.method === 'GET' && pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          status: 'healthy',
          version: '1.0.0',
          uptimeSeconds: Math.round(process.uptime()),
        });
      }

      if (req.method === 'GET' && pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      // ===== 知乎官方 OAuth 浏览器授权路由 =====
      if (req.method === 'GET' && pathname === '/auth/zhihu/status') {
        const sess = zhihuOAuth.getSession(req);
        return sendJson(res, 200, {
          configured: zhihuOAuth.configured,
          authenticated: Boolean(sess),
          account: sess ? { accountId: sess.accountId, nickname: sess.nickname } : null,
          redirectUri: zhihuOAuth.redirectUri,
          callbackBridge: zhihuOAuth.callbackOrigin,
          loginUrl: '/auth/zhihu/start',
        });
      }

      if (pathname === '/auth/zhihu/start' && ['GET', 'POST'].includes(req.method)) {
        const returnPath = url.searchParams.get('returnTo') === '/' ? '/' : '/workbench';
        return zhihuOAuth.handleStart(req, res, origin, returnPath);
      }

      if (req.method === 'GET' && pathname === '/auth/zhihu/callback') {
        return await zhihuOAuth.handleCallback(req, res, url, origin, (sess) => {
          pushLog('知乎 OAuth', `官方授权登录成功（${sess.nickname} / ${sess.accountId}）`);
          broadcast('oauth.authenticated', { accountId: sess.accountId, nickname: sess.nickname });
        });
      }

      if (req.method === 'GET' && pathname === '/auth/zhihu/finish') {
        return await zhihuOAuth.handleFinish(req, res, url, (sess) => {
          pushLog('知乎 OAuth', `官方授权登录成功（${sess.nickname} / ${sess.accountId}）`);
          broadcast('oauth.authenticated', { accountId: sess.accountId, nickname: sess.nickname });
        });
      }

      if (req.method === 'POST' && pathname === '/auth/zhihu/logout') {
        pushLog('知乎 OAuth', '已退出官方授权登录会话');
        return zhihuOAuth.handleLogout(req, res);
      }

      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/status') {
        return sendJson(res, 200, await buildStatusPayload(req));
      }

      if (req.method === 'GET' && pathname === '/api/settings') {
        return sendJson(res, 200, await llmConfigStore.getPublicConfig());
      }

      if (req.method === 'POST' && pathname === '/api/settings') {
        const body = await readJsonBody(req);
        const saved = await llmConfigStore.saveConfig(body);
        pushLog('系统设置', `已更新大模型配置（${saved.modelName || '未指定模型'}）`);
        return sendJson(res, 200, saved);
      }

      if (req.method === 'GET' && pathname === '/api/starmap') {
        return sendJson(res, 200, await starMapStore.read());
      }

      if (req.method === 'POST' && pathname === '/api/starmap/rebuild') {
        pushLog('星图写入 Agent', '开始根据星球数据库重建完整 3D 星图...');
        const stats = await starWriterAgent.rebuildAll();
        return sendJson(res, 200, stats);
      }

      if (req.method === 'GET' && pathname === '/api/planets') {
        return sendJson(res, 200, await planetsDb.read());
      }

      if (req.method === 'POST' && pathname === '/api/planets') {
        const body = await readJsonBody(req);
        const list = Array.isArray(body.records) ? body.records : [body];
        const result = await planetsDb.addPlanets(list);
        pushLog('星球数据库', `手动写入 ${result.added.length} 颗待放置知识点，星图写入 Agent 已实时响应`);
        // 触发并等待星图写入完成，便于接口调用方直接拿到最新星图状态
        const writerResult = await starWriterAgent.processPending();
        return sendJson(res, 201, { ...result, writerResult });
      }

      if (req.method === 'GET' && pathname === '/api/profile') {
        return sendJson(res, 200, { profile: await profileStore.read() });
      }

      if (req.method === 'POST' && pathname === '/api/profile/refresh') {
        pipelineState.profile.status = 'running';
        try {
          const result = await profileAgent.run({ force: true });
          pipelineState.profile.status = 'idle';
          pipelineState.profile.lastUpdatedAt = result.profile?.generatedAt || new Date().toISOString();
          broadcast('profile.updated', result.profile);
          return sendJson(res, 200, result);
        } catch (err) {
          pipelineState.profile.status = 'error';
          pipelineState.profile.error = err?.message || '画像刷新失败';
          throw err;
        }
      }

      if (req.method === 'GET' && pathname === '/api/user-db') {
        return sendJson(res, 200, await userDb.read());
      }

      if (req.method === 'GET' && pathname === '/api/collection/state') {
        return sendJson(res, 200, await collector.getState());
      }

      if (req.method === 'POST' && pathname === '/api/collection/settings') {
        const body = await readJsonBody(req);
        const next = collector.updateSettings(body);
        return sendJson(res, 200, { settings: next });
      }

      if (req.method === 'POST' && pathname === '/api/collection/login') {
        const result = await collector.openLoginWindow();
        pushLog('数据采集', '已打开专用知乎登录窗口，请在窗口中完成登录');
        return sendJson(res, 200, result);
      }

      if (req.method === 'POST' && pathname === '/api/collection/qr-login') {
        const result = await collector.startQrLogin();
        pushLog('数据采集', result.loggedIn ? `已检测到登录态（${result.account?.nickname || '知乎'}）` : '已在工作台页面内加载知乎扫码二维码');
        return sendJson(res, 200, result);
      }

      if (req.method === 'GET' && pathname === '/api/collection/qr-state') {
        return sendJson(res, 200, await collector.getQrSnapshot());
      }

      if (req.method === 'POST' && pathname === '/api/collection/sync-oauth') {
        const sess = zhihuOAuth.getSession(req) || zhihuOAuth.getLatestSession();
        if (!sess) {
          return sendJson(res, 401, { error: '请先在工作台完成「知乎官方 OAuth 授权登录」。' });
        }
        pipelineState.collection.status = 'running';
        broadcast('pipeline.state', pipelineState);
        const { creations, collections } = await zhihuOAuth.fetchOfficialUserData(sess.accessToken);
        const merged = [...creations, ...collections];
        if (merged.length === 0) {
          pipelineState.collection.status = 'idle';
          return sendJson(res, 400, {
            error: '当前知乎账号的官方 OAuth 创作/收藏列表为空；请使用页面内「知乎扫码登录」采集近 50 条浏览历史。',
          });
        }
        const result = await collector.syncFromOAuthRecords({ account: sess, oauthRecords: merged });
        return sendJson(res, 200, {
          syncStats: result.syncStats,
          status: await buildStatusPayload(req),
        });
      }

      if (req.method === 'POST' && pathname === '/api/collection/sync') {
        pipelineState.collection.status = 'running';
        pipelineState.collection.error = null;
        broadcast('pipeline.state', pipelineState);
        const result = await collector.sync();
        return sendJson(res, 200, {
          syncStats: result.syncStats,
          status: await buildStatusPayload(req),
        });
      }

      if (req.method === 'POST' && pathname === '/api/collection/sync-demo') {
        pipelineState.collection.status = 'running';
        pipelineState.collection.error = null;
        broadcast('pipeline.state', pipelineState);
        const result = await collector.syncDemo();
        return sendJson(res, 200, {
          syncStats: result.syncStats,
          status: await buildStatusPayload(),
        });
      }

      if (req.method === 'POST' && pathname === '/api/pipeline/convert') {
        const body = await readJsonBody(req);
        const resConvert = await converterAgent.run({ forceAll: Boolean(body?.forceAll) });
        const writerResult = await starWriterAgent.processPending();
        return sendJson(res, 200, { converter: resConvert, starWriter: writerResult });
      }

      if (req.method === 'POST' && pathname === '/api/reset') {
        collector.resetDemoRound();
        await Promise.all([userDb.clear(), planetsDb.clear(), starMapStore.clear(), profileStore.clear()]);
        pipelineState.collection.lastStats = null;
        pipelineState.converter.lastStats = null;
        pipelineState.starWriter.lastStats = null;
        pushLog('系统', '已清空用户数据库、星球数据库、画像与 3D 星图');
        const emptyMap = await starMapStore.read();
        broadcast('starmap.updated', { stats: null, newlyPlacedIds: [], starMap: emptyMap });
        broadcast('profile.updated', null);
        return sendJson(res, 200, { ok: true, status: await buildStatusPayload() });
      }

      if (req.method === 'GET') {
        return await serveStatic(pathname, res);
      }

      return sendJson(res, 404, { error: '接口不存在。' });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      return sendJson(res, status, { error: error?.message || '服务器内部错误。' });
    }
  });

  // 心跳保活 SSE 连接
  const heartbeat = setInterval(() => {
    for (const res of sseClients) {
      try {
        res.write(': keepalive\n\n');
      } catch {
        sseClients.delete(res);
      }
    }
  }, 25_000);
  heartbeat.unref?.();

  async function startOAuthBridge(publicOrigin) {
    return zhihuOAuth.startCallbackBridge(publicOrigin, (sess) => {
      pushLog('知乎 OAuth', `官方授权登录成功（${sess.nickname} / ${sess.accountId}）`);
      broadcast('oauth.authenticated', { accountId: sess.accountId, nickname: sess.nickname });
    });
  }

  async function close() {
    clearInterval(heartbeat);
    starWriterAgent.stopWatching();
    for (const res of sseClients) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    sseClients.clear();
    await zhihuOAuth.close();
    await collector.close();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return {
    server,
    zhihuOAuth,
    startOAuthBridge,
    userDb,
    planetsDb,
    starMapStore,
    profileStore,
    llmConfigStore,
    collector,
    profileAgent,
    converterAgent,
    starWriterAgent,
    close,
  };
}
