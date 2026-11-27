import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mergeTestCookies, syntheticStarfieldOAuth } from '../fixtures/synthetic-starfield-oauth.mjs';
import { startWorkbenchStarfield } from '../workbench-starfield.mjs';

test('旧采集工作台的已登记回调接收星图授权，再把发起登录的浏览器送回正式封面', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'quotation-legacy-callback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // 先留出旧回调端口，复现用户同时运行旧工作台和正式星图的部署。
  const reserved = createServer().listen(0, '127.0.0.1');
  await once(reserved, 'listening');
  const port = reserved.address().port;
  const legacyOrigin = 'http://127.0.0.1:' + port;
  const oauth = syntheticStarfieldOAuth();
  oauth.config.oauthProvider.redirectUri = legacyOrigin + '/auth/zhihu/callback';
  const host = await startWorkbenchStarfield({
    port: 0, ...oauth.config, agents: {}, getIdentity: async () => null,
    debateDb: join(dir, 'debate.sqlite'), knowledgeDb: join(dir, 'map.sqlite'),
  });
  await new Promise((done) => reserved.close(done));
  const legacy = spawn(process.execPath, [fileURLToPath(new URL('../../legacy/data-collection/server.mjs', import.meta.url)), '--demo'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), APP_ORIGIN: legacyOrigin,
      AGENT_STARFIELD_PORT: new URL(host.origin).port, DATA_FILE: join(dir, 'legacy.sqlite') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = once(legacy, 'exit');
  try {
    await Promise.race([once(legacy.stdout, 'data'), exited.then(() => { throw new Error('旧工作台未启动'); })]);
    const start = await fetch(host.origin + '/auth/zhihu/start', { redirect: 'manual' });
    const flow = mergeTestCookies('', start);
    const callback = oauth.finish(start.headers.get('location'), 'legacy-bridge-reader');
    assert.equal(new URL(callback).origin, legacyOrigin);
    const forwarded = await fetch(callback, { redirect: 'manual' });
    assert.equal(forwarded.status, 303);
    assert.deepEqual(forwarded.headers.getSetCookie(), []);
    const finish = new URL(forwarded.headers.get('location'));
    assert.equal(finish.origin, host.origin);
    assert.equal(finish.pathname, '/auth/zhihu/finish');
    assert.deepEqual([...finish.searchParams.keys()], ['ticket']);
    const landed = await fetch(finish, { redirect: 'manual', headers: { cookie: flow } });
    assert.equal(new URL(landed.headers.get('location'), host.origin).href, host.origin + '/');
    const cookie = mergeTestCookies('', landed);
    const cover = await fetch(host.origin, { headers: { cookie } });
    assert.match(await cover.text(), /id="startDebate"/);
    const status = await fetch(host.origin + '/auth/zhihu/status', { headers: { cookie } });
    assert.equal((await status.json()).data.authenticated, true);
  } finally {
    if (legacy.exitCode === null && legacy.signalCode === null) legacy.kill();
    await exited;
    await host.close();
  }
});
