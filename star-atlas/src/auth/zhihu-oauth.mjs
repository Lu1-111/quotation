// 知乎官方 OAuth 浏览器授权登录与数据接口封装（复用 origin/main 的官方协议规范）：
// - 支持 /auth/zhihu/start -> https://openapi.zhihu.com/authorize -> /auth/zhihu/callback -> /auth/zhihu/finish
// - 当登记回调为 http://127.0.0.1:3000/auth/zhihu/callback 且 3000 端口空闲时，自动拉起专用回环回调桥接服务，
//   保证浏览器授权完成后无缝回跳到当前工作台（http://127.0.0.1:3300/workbench）。
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const AUTH_ORIGIN = 'https://openapi.zhihu.com';
const DATA_ORIGIN = 'https://developer.zhihu.com';
const CALLBACK_PATH = '/auth/zhihu/callback';
const FLOW_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 8 * 3600_000;
const FLOW_COOKIE = 'star_atlas_zhihu_flow';
const SESSION_COOKIE = 'star_atlas_zhihu_session';

const nonce = () => randomBytes(32).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest('hex');

export class ZhihuOAuthError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

async function requestJson(url, options, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ZhihuOAuthError('连接知乎官方授权服务失败，请检查网络后重试。', 502);
  }
  if ([401, 403].includes(response.status)) {
    throw new ZhihuOAuthError('知乎拒绝了本次授权或数据请求，请重新授权。', 403);
  }
  if (response.status === 429) {
    throw new ZhihuOAuthError('知乎官方接口暂时限流，请稍后重试。', 429);
  }
  if (!response.ok) {
    throw new ZhihuOAuthError(`知乎官方接口返回 HTTP ${response.status}。`, 502);
  }
  try {
    return JSON.parse(await response.text(), (key, value, context) => {
      if (key === 'uid' && typeof value === 'number') return context.source;
      return value;
    });
  } catch {
    throw new ZhihuOAuthError('知乎返回数据无法解析。', 502);
  }
}

function unwrapOAuthBody(body) {
  if (!body || (body.code !== undefined && ![0, 20000].includes(body.code))) {
    throw new ZhihuOAuthError('知乎授权请求失败，请重新发起授权。', 403);
  }
  return body.data ?? body;
}

function readCookie(req, name) {
  const value = (req.headers.cookie ?? '')
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function makeCookie(name, value, maxAgeSeconds, secure = false) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

function sendRedirect(res, location, cookies = []) {
  res.writeHead(303, {
    Location: location,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
  });
  res.end();
}

function safeZhihuUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' && (parsed.hostname === 'zhihu.com' || parsed.hostname.endsWith('.zhihu.com'))) {
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      return parsed.href;
    }
  } catch {
    // ignore
  }
  return null;
}

export function createZhihuOAuthService({ env = process.env, fetchImpl = fetch } = {}) {
  const appId = env.ZHIHU_OAUTH_APP_ID?.trim() || '';
  const appKey = env.ZHIHU_OAUTH_APP_KEY?.trim() || '';
  const accessSecret = env.ZHIHU_ACCESS_SECRET?.trim() || '';
  const existingOrigin = (env.APP_ORIGIN?.trim() || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const redirectUri = env.ZHIHU_OAUTH_REDIRECT_URI?.trim() || `${existingOrigin}${CALLBACK_PATH}`;
  const configured = Boolean(appId && appKey && redirectUri);

  const flows = new Map();
  const tickets = new Map();
  const sessions = new Map(); // tokenHash -> { accountId, hashId, nickname, accessToken, expiresAt }
  let callbackServer = null;
  let callbackOrigin = null;

  function sweep() {
    const now = Date.now();
    for (const m of [flows, tickets, sessions]) {
      for (const [k, v] of m) {
        if ((v.expiresAt ?? v.expires ?? 0) <= now) m.delete(k);
      }
    }
  }

  function authorizeUrl(state) {
    const url = new URL('/authorize', AUTH_ORIGIN);
    url.search = new URLSearchParams({
      app_id: appId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
    });
    return url.href;
  }

  async function exchangeCode(code) {
    const body = await requestJson(
      new URL('/access_token', AUTH_ORIGIN),
      {
        method: 'POST',
        body: new URLSearchParams({
          app_id: appId,
          app_key: appKey,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code,
        }),
      },
      fetchImpl,
    );
    const grant = unwrapOAuthBody(body);
    const lifetime = Number(grant.expires_in);
    if (typeof grant.access_token !== 'string' || !grant.access_token || !Number.isFinite(lifetime) || lifetime <= 0) {
      throw new ZhihuOAuthError('知乎未返回有效的访问令牌。', 502);
    }
    return { token: grant.access_token, expiresAt: Date.now() + lifetime * 1000 };
  }

  async function fetchIdentity(token) {
    const profile = unwrapOAuthBody(
      await requestJson(
        new URL('/user', AUTH_ORIGIN),
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
        fetchImpl,
      ),
    );
    const accountId =
      typeof profile.uid === 'string' && /^\d+$/.test(profile.uid)
        ? `uid:${profile.uid}`
        : typeof profile.hash_id === 'string' && profile.hash_id
          ? `hash:${profile.hash_id}`
          : null;
    if (!accountId) throw new ZhihuOAuthError('知乎未返回有效的用户标识。', 502);
    return {
      accountId,
      hashId: typeof profile.hash_id === 'string' ? profile.hash_id : null,
      nickname: typeof profile.fullname === 'string' ? profile.fullname : '知乎用户',
    };
  }

  async function fetchOfficialUserData(token) {
    if (!accessSecret) return { creations: [], collections: [] };
    const callData = async (subpath, query) => {
      const url = new URL(`/api/v1/user/${subpath}`, DATA_ORIGIN);
      url.search = new URLSearchParams(query);
      const body = await requestJson(
        url,
        {
          headers: {
            Authorization: `Bearer ${accessSecret}`,
            'X-OAuth-Token': token,
            'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
        },
        fetchImpl,
      );
      if (body?.Code !== 0 || !Array.isArray(body?.Data?.Items)) return [];
      return body.Data.Items;
    };

    const [creationsRaw, collectionsRaw] = await Promise.all([
      callData('contents', { ContentType: 'all', SortField: 'ts', SortOrder: 'desc', Offset: '0', Limit: '50' }).catch(() => []),
      callData('collections', { Limit: '50' }).catch(() => []),
    ]);

    const toRecord = (item, kind, idx) => {
      const type = String(item.ContentType || 'article').toLowerCase();
      const url = safeZhihuUrl(item.Url);
      const id = url?.split('/').filter(Boolean).pop() || `oauth-${kind}-${idx + 1}`;
      return {
        key: `${kind}:${type}:${id}`,
        kind,
        contentId: id,
        contentType: ['answer', 'article', 'pin'].includes(type) ? type : 'article',
        title: typeof item.Title === 'string' ? item.Title : '',
        summary: typeof item.Summary === 'string' ? item.Summary : '',
        author: '',
        url,
        voteCount: Number.isFinite(item.LikeCount) ? item.LikeCount : null,
        commentCount: Number.isFinite(item.CommentCount) ? item.CommentCount : null,
        topics: [],
        sourceReadTime: Number.isFinite(item.FavTime || item.CreatedAt) ? String(item.FavTime || item.CreatedAt) : null,
      };
    };

    return {
      creations: creationsRaw.map((item, idx) => toRecord(item, 'likes', idx)),
      collections: collectionsRaw.map((item, idx) => toRecord(item, 'collections', idx)),
    };
  }

  function getSession(req) {
    sweep();
    const sid = readCookie(req, SESSION_COOKIE);
    if (!sid) return null;
    const sess = sessions.get(digest(sid));
    if (!sess || sess.expiresAt <= Date.now()) return null;
    return sess;
  }

  function getLatestSession() {
    sweep();
    let best = null;
    for (const s of sessions.values()) {
      if (!best || s.createdAt > best.createdAt) best = s;
    }
    return best;
  }

  async function completeAttempt(req, res, attempt, onAuthenticated) {
    const secure = attempt.returnOrigin.startsWith('https:');
    const clearFlow = makeCookie(FLOW_COOKIE, '', 0, secure);
    const returnUrl = `${attempt.returnOrigin}${attempt.returnPath || '/workbench'}`;
    const flow = readCookie(req, FLOW_COOKIE);
    if (!flow || digest(flow) !== attempt.flowHash || attempt.expires <= Date.now()) {
      return sendRedirect(res, `${returnUrl}?oauth_error=expired`, [clearFlow]);
    }
    if (attempt.error) {
      return sendRedirect(res, `${returnUrl}?oauth_error=${encodeURIComponent(attempt.error)}`, [clearFlow]);
    }
    try {
      const grant = await exchangeCode(attempt.code);
      const identity = await fetchIdentity(grant.token);
      const now = Date.now();
      const expiresAt = Math.min(now + SESSION_TTL_MS, grant.expiresAt);
      const sid = nonce();
      const session = {
        ...identity,
        accessToken: grant.token,
        createdAt: now,
        expiresAt,
      };
      sessions.set(digest(sid), session);
      onAuthenticated?.(session);
      const maxAge = Math.max(60, Math.floor((expiresAt - now) / 1000));
      return sendRedirect(res, `${returnUrl}?oauth=ok`, [clearFlow, makeCookie(SESSION_COOKIE, sid, maxAge, secure)]);
    } catch (err) {
      const code = err instanceof ZhihuOAuthError ? 'provider_error' : 'failed';
      return sendRedirect(res, `${returnUrl}?oauth_error=${code}`, [clearFlow]);
    }
  }

  function handleStart(req, res, origin, returnPath = '/workbench') {
    if (!configured) {
      return sendRedirect(res, `${origin}${returnPath}?oauth_error=not_configured`);
    }
    sweep();
    const flow = nonce();
    const state = `sa.${nonce()}`;
    const target = authorizeUrl(state);
    flows.set(digest(state), {
      flowHash: digest(flow),
      redirectUri,
      returnOrigin: origin,
      returnPath,
      expires: Date.now() + FLOW_TTL_MS,
    });
    return sendRedirect(res, target, [makeCookie(FLOW_COOKIE, flow, Math.floor(FLOW_TTL_MS / 1000), origin.startsWith('https:'))]);
  }

  async function handleCallback(req, res, url, fallbackOrigin, onAuthenticated) {
    sweep();
    const state = url.searchParams.get('state');
    const key = state && /^sa\.[A-Za-z0-9_-]{43}$/.test(state) ? digest(state) : null;
    const attempt = key ? flows.get(key) : null;
    if (!attempt || attempt.expires <= Date.now()) {
      return sendRedirect(res, `${fallbackOrigin}/workbench?oauth_error=expired`);
    }
    flows.delete(key);

    const code = url.searchParams.get('authorization_code') || url.searchParams.get('code');
    if (url.searchParams.has('error')) {
      attempt.error = 'cancelled';
    } else if (!code || code.length > 4096) {
      attempt.error = 'expired';
    } else {
      attempt.code = code;
    }

    // 如果回调端口（例如 3000）与工作台端口（例如 3300）不同，签发短期一次性 ticket 跳回工作台域完成 Cookie 写入
    if (url.origin !== attempt.returnOrigin) {
      const ticket = nonce();
      attempt.expires = Math.min(attempt.expires, Date.now() + 60_000);
      tickets.set(digest(ticket), attempt);
      return sendRedirect(res, `${attempt.returnOrigin}/auth/zhihu/finish?ticket=${encodeURIComponent(ticket)}`);
    }
    return completeAttempt(req, res, attempt, onAuthenticated);
  }

  async function handleFinish(req, res, url, onAuthenticated) {
    sweep();
    const ticket = url.searchParams.get('ticket');
    const key = ticket && /^[A-Za-z0-9_-]{43}$/.test(ticket) ? digest(ticket) : null;
    const attempt = key ? tickets.get(key) : null;
    if (!attempt || attempt.expires <= Date.now()) {
      return sendRedirect(res, `/workbench?oauth_error=expired`);
    }
    tickets.delete(key);
    return completeAttempt(req, res, attempt, onAuthenticated);
  }

  function handleLogout(req, res) {
    const sid = readCookie(req, SESSION_COOKIE);
    if (sid) sessions.delete(digest(sid));
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': makeCookie(SESSION_COOKIE, '', 0, false),
    });
    res.end(JSON.stringify({ ok: true }));
  }

  // 当配置的回调地址位于本机其他端口（如 127.0.0.1:3000）时，自动起一个轻量回环回调监听服务
  async function startCallbackBridge(fallbackOrigin, onAuthenticated) {
    if (!configured || callbackServer) return null;
    let parsed;
    try {
      parsed = new URL(redirectUri);
    } catch {
      return null;
    }
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) return null;
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (!port || parsed.origin === fallbackOrigin) return null;

    const srv = createServer((req, res) => {
      const url = new URL(req.url || '/', parsed.origin);
      if (req.method === 'GET' && url.pathname === CALLBACK_PATH) {
        handleCallback(req, res, url, fallbackOrigin, onAuthenticated).catch(() => {
          sendRedirect(res, `${fallbackOrigin}/workbench?oauth_error=failed`);
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    });

    const bindHost = process.env.STAR_ATLAS_HOST === '0.0.0.0' ? '0.0.0.0' : parsed.hostname;
    try {
      await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, bindHost, resolve);
      });
      callbackServer = srv;
      callbackOrigin = parsed.origin;
      return callbackOrigin;
    } catch {
      // 3000 端口已被占用时忽略（不阻塞主服务启动）
      return null;
    }
  }

  async function close() {
    if (callbackServer) {
      const closing = callbackServer;
      callbackServer = null;
      await new Promise((resolve) => closing.close(() => resolve()));
    }
  }

  return {
    configured,
    redirectUri,
    get callbackOrigin() {
      return callbackOrigin;
    },
    getSession,
    getLatestSession,
    fetchOfficialUserData,
    handleStart,
    handleCallback,
    handleFinish,
    handleLogout,
    startCallbackBridge,
    close,
  };
}
