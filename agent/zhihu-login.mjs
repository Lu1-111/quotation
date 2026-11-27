import { createHash, randomBytes } from 'node:crypto';
import { createZhihuAccountAuth } from '../legacy/data-collection/zhihu.mjs';

const callbackPath = '/auth/zhihu/callback';
const flowTtl = 10 * 60_000;
const sessionTtl = 8 * 3600_000;
const nonce = () => randomBytes(32).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest('hex');

function registeredCallback(value) {
  try {
    const uri = new URL(value);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(uri.hostname);
    if ((uri.protocol !== 'https:' && !(local && uri.protocol === 'http:'))
      || uri.pathname !== callbackPath || uri.username || uri.password || uri.hash
      || ['code', 'authorization_code', 'state', 'error'].some((key) => uri.searchParams.has(key))) return null;
    return value;
  } catch { return null; }
}

export function createZhihuLoginProvider(env = process.env, fetchImpl = fetch) {
  const appId = env.ZHIHU_OAUTH_APP_ID?.trim();
  const appKey = env.ZHIHU_OAUTH_APP_KEY?.trim();
  const existingOrigin = env.APP_ORIGIN?.trim() || 'http://127.0.0.1:3000';
  const redirectUri = registeredCallback(env.ZHIHU_OAUTH_REDIRECT_URI?.trim()
    || existingOrigin.replace(/\/$/, '') + callbackPath);
  const client = createZhihuAccountAuth({ appId, appKey, redirectUri, fetchImpl });
  return {
    redirectUri,
    configured: Boolean(appId && appKey && redirectUri),
    authorize: ({ state }) => client.authorizeUrl(state),
    async authenticate({ code }) {
      const grant = await client.exchange(code);
      const { accountId, hashId } = await client.identity(grant.token);
      if (!/^uid:\d{1,20}$/.test(accountId) && !(hashId && accountId === 'hash:' + hashId)) {
        throw new Error('未取得有效的知乎标识。');
      }
      return {
        subject: accountId,
        workbenchAccountId: hashId ? digest('zhihu:' + hashId) : null,
        expiresAt: grant.expiresAt,
      };
    },
  };
}

function cookie(req, name) {
  const value = (req.headers.cookie ?? '').split(';').map((item) => item.trim()).find((item) => item.startsWith(name + '='))?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function setCookie(name, value, maxAge, secure) {
  return name + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (secure ? '; Secure' : '');
}

export function createStarfieldLogin({ db, provider }) {
  const flows = new Map();
  const finishes = new Map();
  const flowCookie = 'quotation_zhihu_flow';
  const sessionCookie = 'quotation_zhihu_login';
  db.exec('CREATE TABLE IF NOT EXISTS starfield_logins (token_hash TEXT PRIMARY KEY, subject_hash TEXT NOT NULL, account_ref TEXT, expires INTEGER NOT NULL)');
  const find = db.prepare('SELECT subject_hash AS subject, account_ref AS workbenchAccountId, expires FROM starfield_logins WHERE token_hash=? AND expires>?');
  const remove = db.prepare('DELETE FROM starfield_logins WHERE token_hash=?');

  function read(req) {
    const id = cookie(req, sessionCookie);
    if (!id) return null;
    const credentialHash = digest(id);
    const session = find.get(credentialHash, Date.now());
    return session ? { ...session, credentialHash } : null;
  }

  function redirect(res, path, cookies = []) {
    res.writeHead(303, { location: path, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      ...(cookies.length ? { 'set-cookie': cookies } : {}) });
    res.end();
  }

  function sweep(now) {
    for (const entries of [flows, finishes]) {
      for (const [key, item] of entries) if (item.expires <= now) entries.delete(key);
    }
  }

  async function complete(req, res, attempt, onPair) {
    const secure = attempt.returnOrigin.startsWith('https:');
    const clearFlow = setCookie(flowCookie, '', 0, secure);
    const flow = cookie(req, flowCookie);
    if (!flow || digest(flow) !== attempt.flowHash || attempt.expires <= Date.now()) {
      return redirect(res, '/login?error=expired', [clearFlow]);
    }
    if (attempt.error) return redirect(res, '/login?error=' + attempt.error, [clearFlow]);
    try {
      const identity = await provider.authenticate({ code: attempt.code, redirectUri: attempt.redirectUri });
      const now = Date.now();
      const expires = Math.floor(Math.min(now + sessionTtl, identity.expiresAt ?? now + sessionTtl));
      if (typeof identity.subject !== 'string' || !identity.subject.trim() || !Number.isFinite(expires) || expires < now + 1000) {
        throw new Error('无效的登录身份。');
      }
      const sid = nonce(), credentialHash = digest(sid);
      const login = { subject: digest(identity.subject), workbenchAccountId: identity.workbenchAccountId ?? null, expires, credentialHash };
      const previous = cookie(req, sessionCookie);
      if (previous) remove.run(digest(previous));
      db.prepare('DELETE FROM starfield_logins WHERE expires<=?').run(now);
      db.prepare('INSERT INTO starfield_logins VALUES (?, ?, ?, ?)').run(credentialHash, login.subject, login.workbenchAccountId, expires);
      const cookies = [clearFlow, setCookie(sessionCookie, sid, Math.floor((expires - now) / 1000), secure)];
      if (attempt.pairCode) {
        const pairCookie = await onPair(attempt.pairCode, login);
        if (pairCookie) cookies.push(pairCookie);
      }
      redirect(res, '/', cookies);
    } catch { redirect(res, '/login?error=provider_error', [clearFlow]); }
  }

  return {
    read, redirect,
    valid: (credentialHash) => Boolean(find.get(credentialHash, Date.now())),
    configured: Boolean(provider.configured),
    registeredOrigin: provider.redirectUri ? new URL(provider.redirectUri).origin : null,
    start(req, res, origin, pairCode) {
      if (!provider.configured) return redirect(res, '/login?error=not_configured');
      const redirectUri = provider.redirectUri ?? origin + callbackPath;
      const now = Date.now();
      sweep(now);
      const flow = nonce(), state = 'sf.' + nonce();
      const destination = provider.authorize({ state, redirectUri });
      flows.set(digest(state), { flowHash: digest(flow), redirectUri, returnOrigin: origin, pairCode, expires: now + flowTtl });
      redirect(res, destination, [setCookie(flowCookie, flow, flowTtl / 1000, origin.startsWith('https:'))]);
    },
    async callback(req, res, url, fallbackOrigin, onPair) {
      const state = url.searchParams.getAll('state');
      const key = state.length === 1 && /^sf\.[A-Za-z0-9_-]{43}$/.test(state[0]) && digest(state[0]);
      const attempt = flows.get(key);
      const registered = attempt && new URL(attempt.redirectUri);
      if (!attempt || attempt.expires <= Date.now() || url.origin !== registered.origin
        || [...registered.searchParams].some(([name, expected]) => url.searchParams.get(name) !== expected)) {
        return redirect(res, fallbackOrigin + '/login?error=expired');
      }
      flows.delete(key);
      const codes = [...url.searchParams.getAll('authorization_code'), ...url.searchParams.getAll('code')];
      if (url.searchParams.has('error')) attempt.error = 'cancelled';
      else if (codes.length !== 1 || !codes[0] || codes[0].length > 4096) attempt.error = 'expired';
      else attempt.code = codes[0];

      // 公网回调从不签发本机会话，返回不含授权码的一次性票据，由原浏览器完成最后校验。
      if (url.origin !== attempt.returnOrigin) {
        const ticket = nonce();
        attempt.expires = Math.min(attempt.expires, Date.now() + 60_000);
        finishes.set(digest(ticket), attempt);
        return redirect(res, attempt.returnOrigin + '/auth/zhihu/finish?ticket=' + ticket);
      }
      return complete(req, res, attempt, onPair);
    },
    async finish(req, res, url, onPair) {
      const values = url.searchParams.getAll('ticket');
      const key = values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0]) && digest(values[0]);
      const attempt = finishes.get(key);
      if (!attempt || attempt.returnOrigin !== url.origin) return redirect(res, '/login?error=expired');
      finishes.delete(key);
      return complete(req, res, attempt, onPair);
    },
    logout(req, res, secure) {
      const sid = cookie(req, sessionCookie);
      if (sid) remove.run(digest(sid));
      redirect(res, '/login', [setCookie(sessionCookie, '', 0, secure), setCookie(flowCookie, '', 0, secure)]);
    },
  };
}
