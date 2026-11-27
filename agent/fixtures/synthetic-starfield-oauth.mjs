// 工作台 HTTP/浏览器集成测试使用的隔离身份。所有授权请求在测试进程内完成。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export function mergeTestCookies(current, response) {
  const entries = new Map(current.split('; ').filter(Boolean).map((item) => {
    const split = item.indexOf('=');
    return [item.slice(0, split), item.slice(split + 1)];
  }));
  for (const header of response.headers.getSetCookie()) {
    const value = header.split(';')[0];
    const split = value.indexOf('=');
    const key = value.slice(0, split);
    if (!value.slice(split + 1) || /Max-Age=0(?:;|$)/i.test(header)) entries.delete(key);
    else entries.set(key, value.slice(split + 1));
  }
  return [...entries].map(([key, value]) => key + '=' + value).join('; ');
}

export function syntheticStarfieldOAuth(authorizeUrl = 'https://oauth.example.test/authorize') {
  const codes = new Map();
  const accountId = (owner) => 'synthetic-zhihu-' + owner;
  const oauthProvider = {
    configured: true,
    authorize({ state, redirectUri }) {
      const url = new URL(authorizeUrl);
      url.searchParams.set('state', state);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      return url.href;
    },
    async authenticate({ code, redirectUri }) {
      const issued = codes.get(code);
      assert.ok(issued, '合成授权码未签发或已使用');
      codes.delete(code);
      assert.equal(issued.redirectUri, redirectUri);
      return { subject: accountId(issued.owner), workbenchAccountId: accountId(issued.owner) };
    },
  };
  function finish(authorization, owner) {
    const start = new URL(authorization);
    assert.equal(start.origin + start.pathname, authorizeUrl);
    const redirectUri = start.searchParams.get('redirect_uri');
    assert.ok(start.searchParams.get('state'), '授权请求应提供 state');
    const code = randomUUID();
    codes.set(code, { owner, redirectUri });
    const url = new URL(redirectUri);
    url.searchParams.set('state', start.searchParams.get('state'));
    url.searchParams.set('authorization_code', code);
    return url.href;
  }
  async function login(origin, owner) {
    const start = await fetch(origin + '/auth/zhihu/start', { redirect: 'manual' });
    assert.ok([302, 303].includes(start.status), '未进入 OAuth 授权入口');
    const callback = finish(start.headers.get('location'), owner);
    const ephemeral = mergeTestCookies('', start);
    assert.ok(ephemeral, '登录状态缺少短期浏览器绑定');
    const result = await fetch(callback, { redirect: 'manual', headers: { cookie: ephemeral } });
    assert.ok([302, 303].includes(result.status));
    assert.equal(new URL(result.headers.get('location'), origin).pathname, '/');
    const cookie = mergeTestCookies('', result);
    assert.ok(cookie, '回调未签发浏览器登录会话');
    return cookie;
  }
  return { config: { oauthProvider, getWorkbenchAccountId: accountId }, authorizeUrl, finish, login };
}
