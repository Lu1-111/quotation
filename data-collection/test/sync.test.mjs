import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createZhihu } from '../zhihu.mjs';

test('S3 adapter exchanges the code and fetches paginated data with the documented credentials', async () => {
  const redirectUri = 'https://example.org/auth/zhihu/callback';
  const offsets = [];
  const provider = createZhihu({
    appId: 'test-app', appKey: 'test-key', accessSecret: 'test-secret', redirectUri,
    async fetchImpl(url, options) {
      if (url.pathname === '/access_token') {
        assert.equal(options.method, 'POST');
        assert.equal(options.body.get('code'), 'one-time-code');
        assert.equal(options.body.get('app_key'), 'test-key');
        assert.equal(options.body.get('redirect_uri'), redirectUri);
        return Response.json({ code: 20000, data: { access_token: 'test-user', expires_in: 3600 } });
      }
      if (url.pathname === '/user') {
        assert.deepEqual(options.headers, { Authorization: 'Bearer test-user', Accept: 'application/json' });
        return new Response('{"uid":969570047710216201,"fullname":"测试读者"}');
      }
      assert.equal(options.headers.Authorization, 'Bearer test-secret');
      assert.equal(options.headers['X-OAuth-Token'], 'test-user');
      assert.match(options.headers['X-Request-Timestamp'], /^\d{10}$/);
      const item = { Title: '测试创作', Url: 'https://zhuanlan.zhihu.com/p/123?tracking=1', ContentType: 'article' };
      if (url.pathname.endsWith('/contents')) {
        assert.equal(url.searchParams.get('ContentType'), 'all');
        const offset = url.searchParams.get('Offset');
        offsets.push(offset);
        const paging = offset === '0' ? { IsEnd: false, NextOffset: '51' } : { IsEnd: true };
        return Response.json({ Code: 0, Data: { Items: [item], Paging: paging } });
      }
      assert.equal(url.pathname, '/api/v1/user/collections');
      assert.equal(url.searchParams.get('Limit'), '50');
      return Response.json({ Code: 0, Data: { Items: [{ ...item, FavTime: 1234 }] } });
    },
  });

  const authorize = new URL(provider.authorizeUrl('test-state'));
  assert.equal(authorize.hostname, 'openapi.zhihu.com');
  assert.equal(authorize.searchParams.get('state'), 'test-state');
  const grant = await provider.exchange('one-time-code');
  assert.deepEqual(await provider.profile(grant.token), {
    accountId: 'uid:969570047710216201', nickname: '测试读者',
  });
  const { creations, collections } = await provider.snapshot(grant.token);
  assert.deepEqual(offsets, ['0', '51']);
  assert.equal(creations.length, 2);
  assert.equal(creations[0].url, 'https://zhuanlan.zhihu.com/p/123');
  assert.equal(collections[0].favoritedAt, 1234);
});

test('demo HTTP flow verifies state, scopes exports to the session, and supports disconnect', async (t) => {
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  const closed = once(listener, 'close');
  listener.close();
  await closed;

  const origin = `http://127.0.0.1:${port}`;
  const directory = mkdtempSync(join(tmpdir(), 'zhihu-sync-test-'));
  const dataFile = join(directory, 'test.sqlite');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url)), '--demo'], {
    env: { ...process.env, APP_ORIGIN: origin, PORT: String(port), HOST: '127.0.0.1', DATA_FILE: dataFile, CONTENT_AGENT_MODEL: '', CONTENT_AGENT_OLLAMA_URL: 'http://127.0.0.1:11434' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = once(child, 'exit');
  const pageControllers = [];
  t.after(async () => {
    for (const controller of pageControllers) controller.abort();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    rmSync(dataFile, { force: true });
    rmdirSync(directory);
  });
  await Promise.race([
    once(child.stdout, 'data'),
    exited.then(([code]) => { throw new Error(`Demo server exited with code ${code}`); }),
  ]);

  const send = (path, options = {}) => fetch(new URL(path, origin), { ...options, redirect: 'manual' });
  const credentials = (response) => response.headers.getSetCookie().map((value) => value.split(';')[0]);
  const begin = () => send('/auth/zhihu', { method: 'POST', headers: { Origin: origin } });
  assert.equal((await send('/')).status, 200);
  assert.equal((await send('/api/zhihu/export')).status, 401);
  assert.equal((await send('/auth/zhihu', { method: 'POST', headers: { Origin: 'https://other.example' } })).status, 403);

  const denied = await begin();
  const badCallback = new URL(denied.headers.get('location'));
  badCallback.searchParams.delete('state');
  const deniedResult = await send(badCallback, { headers: { Cookie: credentials(denied)[0] } });
  assert.equal(deniedResult.headers.get('location'), '/?auth=invalid-state');

  const started = await begin();
  const callback = started.headers.get('location');
  const flow = credentials(started)[0];
  const connected = await send(callback, { headers: { Cookie: flow } });
  assert.equal(connected.headers.get('location'), '/');
  assert.equal((await send(callback, { headers: { Cookie: flow } })).headers.get('location'), '/?auth=invalid-state');
  const cookie = credentials(connected).find((value) => value.startsWith('zhihu-session='));
  const headers = { Cookie: cookie };
  const current = await (await send('/api/session', { headers })).json();
  assert.equal(current.connected, true);
  assert.ok(!('token' in current));

  const snapshot = await (await send('/api/zhihu/data', { headers })).json();
  assert.equal(snapshot.source, 'demo');
  assert.equal(snapshot.creations.length, 1);
  assert.equal(snapshot.collections.length, 1);
  const download = await send('/api/zhihu/export', { headers });
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(await download.json(), snapshot);
  assert.equal((await send('/api/zhihu/sync', { method: 'POST', headers: { ...headers, Origin: origin } })).status, 200);
  assert.equal((await send('/api/zhihu/disconnect', {
    method: 'POST', headers: { ...headers, Origin: origin },
  })).status, 200);
  assert.equal((await send('/api/zhihu/data', { headers })).status, 401);

  assert.equal((await send('/api/history/export')).status, 401);
  const historySession = await send('/api/history/session');
  const historyCookie = credentials(historySession)[0];
  const historyHeaders = { Cookie: historyCookie, Origin: origin, 'Content-Type': 'application/json' };
  const openPage = async (pageId) => {
    const controller = new AbortController();
    pageControllers.push(controller);
    const response = await send(`/api/history/page?id=${pageId}`, { headers: historyHeaders, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    await reader.read();
    assert.equal((await send('/api/history/page/heartbeat', {
      method: 'POST', headers: historyHeaders, body: JSON.stringify({ pageId }),
    })).status, 200);
    return { controller, reader };
  };
  const pageA = 'test-page-00000001';
  const pageB = 'test-page-00000002';
  assert.equal((await send('/history')).status, 200);
  assert.equal((await send('/api/history/connect', {
    method: 'POST', headers: historyHeaders, body: JSON.stringify({ consent: false }),
  })).status, 403);
  assert.equal((await send('/api/history/connect', {
    method: 'POST', headers: historyHeaders, body: JSON.stringify({ consent: true }),
  })).status, 409);
  await openPage(pageA);
  assert.equal((await send('/api/history/connect', {
    method: 'POST', headers: historyHeaders, body: JSON.stringify({ consent: true }),
  })).status, 200);
  assert.equal((await send('/api/history/sync', {
    method: 'POST', headers: historyHeaders, body: JSON.stringify({ autoSync: true }),
  })).status, 200);
  const historyExport = await send('/api/history/export', { headers: historyHeaders });
  assert.match(historyExport.headers.get('content-disposition'), /^attachment;/);
  const historyData = await historyExport.json();
  assert.equal(historyData.source, 'demo_history');
  assert.equal(historyData.records.length, 3);
  assert.ok(historyData.records.every((record) => record.contentType !== 'profile' && record.contentId !== '104'));
  assert.ok(historyData.records.every((record, index, records) => index === 0 || records[index - 1].weight >= record.weight));
  assert.ok(!JSON.stringify(historyData).includes('token'));
  await openPage(pageB);
  assert.equal((await send('/api/history/page/heartbeat', {
    method: 'POST', headers: historyHeaders, body: JSON.stringify({ pageId: pageA }),
  })).status, 200);
  await send('/api/history/page/close', { method: 'POST', headers: historyHeaders, body: JSON.stringify({ pageId: pageA }) });
  let presenceStatus = await (await send('/api/history/session', { headers: historyHeaders })).json();
  assert.equal(presenceStatus.pageConnected, true);
  assert.equal(presenceStatus.autoSyncActive, true);
  await send('/api/history/page/close', { method: 'POST', headers: historyHeaders, body: JSON.stringify({ pageId: pageB }) });
  presenceStatus = await (await send('/api/history/session', { headers: historyHeaders })).json();
  assert.equal(presenceStatus.pageConnected, false);
  assert.equal(presenceStatus.autoSync, true);
  assert.equal(presenceStatus.autoSyncActive, false);
  assert.equal((await send('/api/history/sync', {
    method: 'POST', headers: historyHeaders, body: JSON.stringify({ autoSync: true }),
  })).status, 409);
  await openPage(pageA);
  const otherSession = await send('/api/history/session');
  const otherData = await (await send('/api/history/data', {
    headers: { Cookie: credentials(otherSession)[0] },
  })).json();
  assert.equal(otherData.records.length, 0);
  assert.equal((await send('/api/history/settings', {
    method: 'POST', headers: historyHeaders, body: JSON.stringify({ consent: false, settings: { history: true, likes: true, collections: true } }),
  })).status, 403);
  assert.equal((await send('/api/history/settings', {
    method: 'POST', headers: historyHeaders, body: JSON.stringify({ consent: true, settings: { history: true, likes: true, collections: true } }),
  })).status, 200);
  assert.equal((await send('/settings')).status, 200);
  assert.equal((await (await send('/api/history/agent', { headers: historyHeaders })).json()).ready, false);
  assert.equal((await send('/api/history/settings', {
    method: 'POST', headers: historyHeaders, body: JSON.stringify({ consent: true, settings: { history: true, likes: true, collections: true, aiReview: true } }),
  })).status, 409);
  assert.equal((await send('/api/history/sync', {
    method: 'POST', headers: historyHeaders, body: JSON.stringify({ autoSync: false }),
  })).status, 200);
  const multiple = await (await send('/api/history/data', { headers: historyHeaders })).json();
  assert.deepEqual(multiple.counts, { history: 3, likes: 1, collections: 1 });
  assert.equal(multiple.records.length, 3);
  const liked = multiple.records.find((record) => record.kinds.includes('likes'));
  assert.equal(liked.weightDetails.actionMultiplier, 4 / 3);
  assert.equal(liked.weightDetails.timeFactor, 1);
  assert.equal((await send('/api/history/settings', {
    method: 'POST', headers: historyHeaders, body: JSON.stringify({ consent: true, settings: { history: false, likes: false, collections: false } }),
  })).status, 200);
  assert.equal((await send('/api/history/sync', {
    method: 'POST', headers: historyHeaders, body: JSON.stringify({ autoSync: false }),
  })).status, 400);
  assert.equal((await send('/api/history/clear', { method: 'POST', headers: historyHeaders })).status, 200);
  const cleared = await (await send('/api/history/data', { headers: historyHeaders })).json();
  assert.equal(cleared.records.length, 0);
});
