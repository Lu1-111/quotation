import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createZhihuLoginProvider } from '../zhihu-login.mjs';

const config = { ZHIHU_OAUTH_APP_ID: 'test-app', ZHIHU_OAUTH_APP_KEY: 'test-app-key', ZHIHU_OAUTH_REDIRECT_URI: 'https://example.test/auth/zhihu/callback?project=sample' };
const userId = '969570047710216201';

test('知乎登录复用原授权客户端，无需搜索密钥，uid 无损并以官方 hash_id 核对采集账号', async () => {
  const calls = [];
  const fetchImpl = async (rawUrl, opts) => {
    const url = new URL(rawUrl);
    calls.push(url.pathname);
    assert.equal(url.origin, 'https://openapi.zhihu.com');
    assert.equal(opts.redirect, 'error');
    if (url.pathname === '/access_token') {
      assert.equal(opts.method, 'POST');
      assert.equal(opts.body.get('app_key'), config.ZHIHU_OAUTH_APP_KEY);
      assert.equal(opts.body.get('redirect_uri'), config.ZHIHU_OAUTH_REDIRECT_URI);
      assert.equal(opts.body.get('code'), 'test-code');
      return Response.json({ code: 20000, data: { access_token: 'test-user-token', expires_in: 3600 } });
    }
    assert.equal(new Headers(opts.headers).get('authorization'), 'Bearer test-user-token');
    return new Response('{"code":20000,"data":{"uid":' + userId + ',"hash_id":"abcde","email":"omitted","fullname":"同名"}}');
  };
  const provider = createZhihuLoginProvider(config, fetchImpl);
  assert.equal(provider.configured, true);
  const url = new URL(provider.authorize({ state: 'synthetic-state' }));
  assert.equal(url.origin + url.pathname, 'https://openapi.zhihu.com/authorize');
  assert.equal(url.searchParams.get('app_id'), config.ZHIHU_OAUTH_APP_ID);
  assert.equal(url.searchParams.get('redirect_uri'), config.ZHIHU_OAUTH_REDIRECT_URI);
  assert.equal(url.searchParams.get('state'), 'synthetic-state');
  assert.equal(url.searchParams.has('app_key'), false);
  const login = await provider.authenticate({ code: 'test-code' });
  assert.equal(login.subject, 'uid:' + userId);
  assert.equal(login.workbenchAccountId, createHash('sha256').update('zhihu:abcde').digest('hex'));
  assert.deepEqual(Object.keys(login).sort(), ['expiresAt', 'subject', 'workbenchAccountId']);
  assert.deepEqual(calls, ['/access_token', '/user']);
});

test('回调默认复用旧工作台，非回环明文地址及用昵称充当账号标识均无法登录', async () => {
  assert.equal(createZhihuLoginProvider({ ZHIHU_OAUTH_APP_ID: 'test', ZHIHU_OAUTH_APP_KEY: 'test' }).redirectUri, 'http://127.0.0.1:3000/auth/zhihu/callback');
  assert.equal(createZhihuLoginProvider({ ...config, ZHIHU_OAUTH_REDIRECT_URI: '', APP_ORIGIN: 'https://registered.test/' }).redirectUri, 'https://registered.test/auth/zhihu/callback');
  for (const uri of ['http://example.test/auth/zhihu/callback', 'https://example.test/auth/other',
    'https://example.test/auth/zhihu/callback?state=wrong', 'https://example.test/auth/zhihu/callback#fragment']) {
    assert.equal(createZhihuLoginProvider({ ...config, ZHIHU_OAUTH_REDIRECT_URI: uri }).configured, false);
  }
  let profile = { fullname: '与另一用户同名' };
  const provider = createZhihuLoginProvider(config, async (url) => String(url).endsWith('/access_token')
    ? Response.json({ access_token: 'test-token', expires_in: 600 })
    : Response.json(profile));
  await assert.rejects(provider.authenticate({ code: 'test-code' }));
  profile = { uid: userId };
  const onlyUid = await provider.authenticate({ code: 'test-code' });
  assert.equal(onlyUid.subject, 'uid:' + userId);
  assert.equal(onlyUid.workbenchAccountId, null);
});

test('原回环回调端口空闲时只接收回调，在主入口核对浏览器后才建立会话', async (t) => {
  const { createServer } = await import('node:http');
  const { startWorkbenchStarfield } = await import('../workbench-starfield.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const probe = createServer();
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const oldOrigin = 'http://127.0.0.1:' + probe.address().port;
  await new Promise((done) => probe.close(done));
  const dir = await mkdtemp(join(tmpdir(), 'callback-only-'));
  let calls = 0;
  const runtime = await startWorkbenchStarfield({ port: 0, agents: {},
    getIdentity: () => null, getMaterials() { assert.fail(); },
    debateDb: join(dir, 'sessions.sqlite'), knowledgeDb: join(dir, 'knowledge.sqlite'),
    oauthProvider: {
      configured: true, redirectUri: oldOrigin + '/auth/zhihu/callback',
      authorize: ({ state }) => 'https://provider.example/login?state=' + state,
      async authenticate({ code }) { calls++; assert.equal(code, 'sample'); return { subject: 'test' }; },
    },
  });
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  const request = (url, cookie) => fetch(url, { redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), connection: 'close' } });
  assert.equal(runtime.callbackOrigin, oldOrigin);
  for (const path of ['/', '/login', '/api/host/session', '/v1/knowledge-map']) assert.equal((await request(oldOrigin + path)).status, 404);
  async function issue() {
    const start = await request(runtime.origin + '/auth/zhihu/start');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    assert.match(state, /^sf\.[A-Za-z0-9_-]{43}$/);
    const callback = await request(oldOrigin + '/auth/zhihu/callback?state=' + state + '&authorization_code=sample');
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.getSetCookie().length, 0);
    const finish = new URL(callback.headers.get('location'));
    assert.equal(finish.origin, runtime.origin);
    assert.equal(finish.pathname, '/auth/zhihu/finish');
    assert.deepEqual([...finish.searchParams.keys()], ['ticket']);
    assert.equal(finish.href.includes('sample'), false);
    return { finish, flowCookie: start.headers.getSetCookie()[0].split(';')[0] };
  }
  const one = await issue();
  const absent = await request(one.finish);
  assert.equal(absent.headers.get('location'), '/login?error=expired');
  const replay = await request(one.finish, one.flowCookie);
  assert.equal(replay.headers.get('location'), '/login?error=expired');
  assert.equal(calls, 0);
  const two = await issue();
  const verified = await request(two.finish, two.flowCookie);
  assert.equal(verified.headers.get('location'), '/');
  assert.equal(calls, 1);
  const credentials = verified.headers.getSetCookie().find((value) => value.startsWith('quotation_zhihu_login='));
  assert.ok(credentials.includes('HttpOnly'));
  const status = await (await request(runtime.origin + '/auth/zhihu/status', credentials.split(';')[0])).json();
  assert.equal(status.data.authenticated, true);
});
