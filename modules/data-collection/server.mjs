import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDemoZhihu, createZhihu, ZhihuError } from './zhihu.mjs';
import { createHistoryStore, HistoryError } from './history-data.mjs';
import { createDemoHistoryGateway, createHistoryCollector } from './history-collector.mjs';
import { createContentAgent } from './content-agent.mjs';
import { createPagePresence, validPageId } from './page-presence.mjs';

const FLOW_TTL = 10 * 60_000;
const SESSION_TTL = 8 * 60 * 60_000;
const CALLBACK = '/auth/zhihu/callback';
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/history', ['history.html', 'text/html; charset=utf-8']],
  ['/history.js', ['history.js', 'text/javascript; charset=utf-8']],
  ['/settings', ['settings.html', 'text/html; charset=utf-8']],
  ['/settings.js', ['settings.js', 'text/javascript; charset=utf-8']],
  ['/page-session.js', ['page-session.js', 'text/javascript; charset=utf-8']],
].map(([path, [name, type]]) => [path, { type, body: readFileSync(new URL(`./public/${name}`, import.meta.url)) }]));

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const appOrigin = new URL(process.env.APP_ORIGIN || `http://127.0.0.1:${port}`);
const demo = process.argv.includes('--demo');
const isLoopback = (name) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(name);
if (appOrigin.href !== `${appOrigin.origin}/` || !['http:', 'https:'].includes(appOrigin.protocol)) {
  throw new Error('APP_ORIGIN 必须是 HTTP 或 HTTPS 的站点根地址。');
}
if (appOrigin.protocol !== 'https:' && (!isLoopback(appOrigin.hostname) || !isLoopback(host))) {
  throw new Error('部署给其他用户访问时，APP_ORIGIN 必须使用 HTTPS。');
}
if (demo && (!isLoopback(host) || !isLoopback(appOrigin.hostname))) {
  throw new Error('演示模式只允许在本机运行。');
}

const redirectUri = `${appOrigin.origin}${CALLBACK}`;
const provider = demo ? createDemoZhihu(redirectUri) : createZhihu({
  appId: process.env.ZHIHU_OAUTH_APP_ID,
  appKey: process.env.ZHIHU_OAUTH_APP_KEY,
  accessSecret: process.env.ZHIHU_ACCESS_SECRET,
  redirectUri,
});

const dataFile = resolve(process.env.DATA_FILE || (demo ? '.data/demo.sqlite' : '.data/zhihu.sqlite'));
mkdirSync(dirname(dataFile), { recursive: true, mode: 0o700 });
closeSync(openSync(dataFile, 'a', 0o600));
const db = new DatabaseSync(dataFile);
db.exec(`PRAGMA secure_delete = ON;
CREATE TABLE IF NOT EXISTS snapshots (
  account_id TEXT PRIMARY KEY,
  snapshot TEXT NOT NULL
)`);
const selectSnapshot = db.prepare('SELECT snapshot FROM snapshots WHERE account_id = ?');
const upsertSnapshot = db.prepare(`INSERT INTO snapshots (account_id, snapshot) VALUES (?, ?)
  ON CONFLICT(account_id) DO UPDATE SET snapshot = excluded.snapshot`);
const deleteSnapshot = db.prepare('DELETE FROM snapshots WHERE account_id = ?');

const pending = new Map();
const sessions = new Map();
const syncJobs = new Map();
const randomId = () => randomBytes(32).toString('base64url');
const secure = appOrigin.protocol === 'https:';
const flowCookie = secure ? '__Host-zhihu-flow' : 'zhihu-flow';
const sessionCookie = secure ? '__Host-zhihu-session' : 'zhihu-session';
const historyCookie = secure ? '__Host-history-session' : 'history-session';
const historyAvailable = isLoopback(host) && isLoopback(appOrigin.hostname);
const historyStore = createHistoryStore(db);
const contentAgent = createContentAgent({ baseUrl: process.env.CONTENT_AGENT_OLLAMA_URL || 'http://127.0.0.1:11434', model: process.env.CONTENT_AGENT_MODEL || '' });
const pagePresence = createPagePresence({ onInactive: (id) => historyCollector.stopForClosedPage(id) });
const historyCollector = createHistoryCollector(historyStore, {
  contentAgent,
  isPageActive: (id) => pagePresence.active(id),
  directory: resolve(dirname(dataFile), 'history-profiles'),
  channel: process.env.HISTORY_BROWSER_CHANNEL || 'msedge',
  ...(demo ? { gatewayFactory: createDemoHistoryGateway, pageDelay: 0 } : {}),
});

function cookieValue(req, name) {
  const pair = (req.headers.cookie ?? '').split(';').map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`));
  const value = pair?.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value ?? '') ? value : null;
}

function cookie(name, value, ttl) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttl / 1000)}${secure ? '; Secure' : ''}`;
}

function sessionFor(req) {
  const id = cookieValue(req, sessionCookie);
  const session = sessions.get(id);
  if (session && session.expiresAt > Date.now()) return session;
  sessions.delete(id);
  return null;
}

function readSnapshot(accountId) {
  const saved = selectSnapshot.get(accountId);
  return saved ? JSON.parse(saved.snapshot) : null;
}

async function sync(session) {
  if (!session.token || session.tokenExpiresAt <= Date.now()) {
    session.token = null;
    throw new ZhihuError('知乎授权已过期，请重新连接后再同步。', 401);
  }
  const running = syncJobs.get(session.accountId);
  if (running) return running;

  const job = (async () => {
    const data = await provider.snapshot(session.token);
    if (sessions.get(session.id) !== session || session.expiresAt <= Date.now()) {
      throw new ZhihuError('会话已结束，请重新连接。', 401);
    }
    const snapshot = {
      source: demo ? 'demo' : 'zhihu',
      profile: { nickname: session.nickname },
      syncedAt: new Date().toISOString(),
      ...data,
    };
    upsertSnapshot.run(session.accountId, JSON.stringify(snapshot));
    session.syncError = null;
    return snapshot;
  })();
  syncJobs.set(session.accountId, job);
  try {
    return await job;
  } finally {
    syncJobs.delete(session.accountId);
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function redirect(res, location, cookies = []) {
  res.writeHead(303, { Location: location, ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
  res.end();
}

async function requestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new HistoryError('请求内容过大。', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HistoryError('请求内容无效。', 400);
  }
}

async function handle(req, res) {
  const url = new URL(req.url, appOrigin);
  if (url.origin !== appOrigin.origin) return json(res, 400, { error: '请求地址无效。' });

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");

  if (req.method === 'POST' && req.headers.origin !== appOrigin.origin) {
    return json(res, 403, { error: '请求来源无效。' });
  }

  const { pathname } = url;
  const session = sessionFor(req);
  if (pathname.startsWith('/api/history/')) {
    if (!historyAvailable) return json(res, 403, { error: '知乎信息采集服务需要在本机启动并访问。' });
    let sourceId = cookieValue(req, historyCookie);
    if (req.method === 'GET' && pathname === '/api/history/session') {
      if (!sourceId || !historyStore.get(sourceId)) {
        sourceId = randomId();
        historyStore.create(sourceId);
        res.setHeader('Set-Cookie', cookie(historyCookie, sourceId, 30 * 86_400_000));
      }
      return json(res, 200, { demo, ...historyCollector.status(sourceId) });
    }
    if (!sourceId || !historyStore.get(sourceId)) return json(res, 401, { error: '请刷新网页以建立本机采集会话。' });
    if (req.method === 'GET' && pathname === '/api/history/page') {
      const pageId = url.searchParams.get('id');
      if (!validPageId(pageId)) return json(res, 400, { error: '网页连接标识无效。' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const release = pagePresence.attach(sourceId, pageId, () => res.end());
      const pulse = () => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify({ leaseSeconds: pagePresence.leaseMs / 1000 })}\n\n`); };
      pulse();
      const timer = setInterval(pulse, 10_000);
      timer.unref();
      res.on('close', () => { clearInterval(timer); release(); });
      res.on('error', release);
      return;
    }
    if (req.method === 'POST' && ['/api/history/page/heartbeat', '/api/history/page/close'].includes(pathname)) {
      const body = await requestBody(req);
      if (!validPageId(body?.pageId)) return json(res, 400, { error: '网页连接标识无效。' });
      if (pathname.endsWith('/close')) { pagePresence.release(sourceId, body.pageId); return json(res, 200, { closed: true }); }
      if (!pagePresence.touch(sourceId, body.pageId)) return json(res, 409, { error: '网页连接已失效，请等待重新连接。' });
      return json(res, 200, { connected: true });
    }
    if (req.method === 'GET' && pathname === '/api/history/agent') return json(res, 200, await contentAgent.status());
    if (req.method === 'GET' && pathname === '/api/history/settings') {
      return json(res, 200, historyStore.settings(sourceId));
    }
    if (req.method === 'POST' && pathname === '/api/history/settings') {
      const body = await requestBody(req);
      if (body?.consent !== true) return json(res, 403, { error: '保存设置前请确认所选数据的获取与保存用途。' });
      if (body.settings?.aiReview === true && !contentAgent.configured) return json(res, 409, { error: '全文 Agent 暂未配置，当前可使用本地知识规则筛选。' });
      const settings = historyCollector.configure(sourceId, body.settings);
      historyStore.consent(sourceId);
      return json(res, 200, settings);
    }
    if (req.method === 'POST' && pathname === '/api/history/connect') {
      const body = await requestBody(req);
      if (body?.consent !== true) return json(res, 403, { error: '请先勾选同意采集并同步所选的知乎信息。' });
      historyStore.consent(sourceId);
      await historyCollector.open(sourceId);
      return json(res, 200, { demo, ...historyCollector.status(sourceId) });
    }
    if (req.method === 'POST' && pathname === '/api/history/sync') {
      const body = await requestBody(req);
      if (typeof body?.autoSync !== 'boolean') return json(res, 400, { error: '请指定自动同步设置。' });
      await historyCollector.sync(sourceId, body.autoSync);
      return json(res, 200, { demo, ...historyCollector.status(sourceId) });
    }
    if (req.method === 'POST' && pathname === '/api/history/pause') {
      historyCollector.pause(sourceId);
      return json(res, 200, { demo, ...historyCollector.status(sourceId) });
    }
    if (req.method === 'POST' && pathname === '/api/history/disconnect') {
      await historyCollector.disconnect(sourceId);
      return json(res, 200, { demo, ...historyCollector.status(sourceId) });
    }
    if (req.method === 'POST' && pathname === '/api/history/clear') {
      await historyCollector.disconnect(sourceId);
      historyStore.clear(sourceId);
      return json(res, 200, { demo, ...historyCollector.status(sourceId) });
    }
    if (req.method === 'GET' && ['/api/history/data', '/api/history/export'].includes(pathname)) {
      if (pathname.endsWith('/export')) {
        res.setHeader('Content-Disposition', `attachment; filename="zhihu-history-${new Date().toISOString().slice(0, 10)}.json"`);
      }
      return json(res, 200, historyStore.snapshot(sourceId, demo));
    }
    return json(res, 404, { error: '接口不存在。' });
  }
  if (req.method === 'POST' && pathname === '/auth/zhihu') {
    if (!provider.ready) return json(res, 503, { error: '请先配置知乎应用凭证。' });
    pending.delete(cookieValue(req, flowCookie));
    const flow = randomId();
    const state = randomId();
    pending.set(flow, { state, expiresAt: Date.now() + FLOW_TTL });
    return redirect(res, provider.authorizeUrl(state), [cookie(flowCookie, flow, FLOW_TTL)]);
  }

  if (req.method === 'GET' && pathname === CALLBACK) {
    const clearFlow = cookie(flowCookie, '', 0);
    const flow = cookieValue(req, flowCookie);
    const attempt = pending.get(flow);
    pending.delete(flow);
    const state = url.searchParams.get('state');
    if (!attempt || attempt.expiresAt <= Date.now() || !/^[A-Za-z0-9_-]{43}$/.test(state ?? '')
        || !timingSafeEqual(Buffer.from(state), Buffer.from(attempt.state))) {
      return redirect(res, '/?auth=invalid-state', [clearFlow]);
    }

    const code = url.searchParams.get('authorization_code');
    if (!code) return redirect(res, '/?auth=no-code', [clearFlow]);

    let grant;
    let profile;
    try {
      grant = await provider.exchange(code);
      profile = await provider.profile(grant.token);
    } catch (error) {
      if (!(error instanceof ZhihuError)) throw error;
      return redirect(res, '/?auth=failed', [clearFlow]);
    }

    // A disconnect from another tab can invalidate the old session during the exchange.
    if (session && sessions.get(session.id) !== session) return redirect(res, '/', [clearFlow]);
    const id = randomId();
    const next = {
      id, ...profile, token: grant.token, tokenExpiresAt: grant.expiresAt,
      expiresAt: Date.now() + SESSION_TTL, syncError: null,
    };
    if (session) sessions.delete(session.id);
    sessions.set(id, next);
    try {
      await sync(next);
    } catch (error) {
      if (!(error instanceof ZhihuError)) throw error;
      next.syncError = error.message;
    }
    return redirect(res, '/', [clearFlow, cookie(sessionCookie, id, SESSION_TTL)]);
  }

  if (req.method === 'GET' && pathname === '/api/session') {
    return json(res, 200, {
      demo, ready: provider.ready, connected: Boolean(session),
      ...(session ? {
        nickname: session.nickname, syncError: session.syncError,
        canSync: Boolean(session.token) && session.tokenExpiresAt > Date.now(),
      } : {}),
    });
  }

  if (pathname.startsWith('/api/zhihu/')) {
    if (!session) return json(res, 401, { error: '请先连接知乎。' });
    if (req.method === 'POST' && pathname === '/api/zhihu/sync') return json(res, 200, await sync(session));
    if (req.method === 'POST' && pathname === '/api/zhihu/disconnect') {
      for (const [id, active] of sessions) {
        if (active.accountId === session.accountId) sessions.delete(id);
      }
      pending.delete(cookieValue(req, flowCookie));
      deleteSnapshot.run(session.accountId);
      res.setHeader('Set-Cookie', [cookie(sessionCookie, '', 0), cookie(flowCookie, '', 0)]);
      return json(res, 200, { disconnected: true });
    }
    if (req.method === 'GET' && ['/api/zhihu/data', '/api/zhihu/export'].includes(pathname)) {
      const snapshot = readSnapshot(session.accountId);
      if (!snapshot) return json(res, 404, { error: '当前账号还没有同步快照。' });
      if (pathname.endsWith('/export')) {
        const day = snapshot.syncedAt.slice(0, 10);
        res.setHeader('Content-Disposition', `attachment; filename="zhihu-data-${day}.json"`);
      }
      return json(res, 200, snapshot);
    }
  }

  const file = req.method === 'GET' && FILES.get(pathname);
  if (!file) return json(res, 404, { error: '页面不存在。' });
  res.writeHead(200, { 'Content-Type': file.type });
  res.end(file.body);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, attempt] of pending) if (attempt.expiresAt <= now) pending.delete(id);
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
    else if (session.tokenExpiresAt <= now) session.token = null;
  }
}, 60_000).unref();

setInterval(() => { historyCollector.tick().catch(() => {}); }, 15_000).unref();
setInterval(() => { pagePresence.sweep(); }, 1000).unref();

createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (res.headersSent) return res.destroy();
    if (error instanceof ZhihuError || error instanceof HistoryError) return json(res, error.status, { error: error.message });
    console.error('Request failed:', error.name);
    return json(res, 500, { error: '服务暂时不可用，请稍后重试。' });
  });
}).listen(port, host, () => {
  console.log(`${demo ? '本地演示' : '知乎数据同步'} ${appOrigin.origin}`);
  if (!demo) console.log(`OAuth 回调 ${redirectUri}`);
});
