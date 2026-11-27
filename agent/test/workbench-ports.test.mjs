import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startWorkbenchStarfield } from '../workbench-starfield.mjs';

test('正式首页与兼容端口共用绑定、进行中的回合、进度恢复和撤回状态', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-ports-'));
  let owner = 'reader-a';
  const waiting = Promise.withResolvers();
  const release = Promise.withResolvers();
  const config = {
    port: 0, compatibilityPort: 0, debateDb: join(dir, 'debate.sqlite'), knowledgeDb: join(dir, 'knowledge.sqlite'),
    getIdentity: () => owner,
    getMaterials: () => ({ snapshotId: 'test', records: [], profile: { generatedAt: 'v1', domains: [], topics: [] } }),
    agents: {
      topics: () => [{ id: 't1', claim: '公开讨论' }],
      decompose: () => [],
      async prepareRound() {
        waiting.resolve();
        await release.promise;
        return { currentRound: { id: 'r1', number: 1, focus: {}, opponent: { argument: '第一轮' }, options: [] } };
      },
    },
  };
  let runtime = await startWorkbenchStarfield(config);
  t.after(async () => {
    release.resolve();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });
  const primary = runtime.origin;
  const previous = runtime.compatibilityOrigin;
  assert.notEqual(previous, primary);
  let cookie;
  async function request(origin, path, body, requestOrigin = origin) {
    const res = await fetch(origin + path, {
      method: body ? 'POST' : 'GET',
      headers: { connection: "close", origin: requestOrigin, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body && JSON.stringify(body),
    });
    if (res.headers.has('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return res;
  }
  async function json(origin, path, body) {
    const res = await request(origin, path, body);
    assert(res.ok, `${path} returned ${res.status}`);
    return (await res.json()).data;
  }
  assert.equal(await (await request(previous, '/')).text(), await (await request(primary, '/')).text());
  const pair = new URL((await runtime.issuePair()).url);
  assert.equal(pair.origin, primary);
  const link = await json(primary, '/api/host/session', { pairCode: pair.hash.slice(6) });
  assert.equal(link.connected, true);
  assert.equal(link.resumeSessionId, null);
  assert.equal((await json(previous, '/api/host/session', {})).connected, true);
  assert.equal((await request(primary, '/v1/debate/topics', {}, previous)).status, 403);
  const { topics } = await json(previous, '/v1/debate/topics', {});
  const { sessionId } = await json(previous, '/v1/sessions', { topicId: topics[0].id });
  const path = '/v1/sessions/' + sessionId;
  assert.equal((await json(primary, '/api/host/session', {})).resumeSessionId, sessionId);
  const { turnId } = await json(previous, path + '/turns', {
    clientRequestId: 'open', baseGraphVersion: 0, action: { type: 'open_debate' },
  });
  await waiting.promise;
  // 第二个进程只成功占到临时主口、没占到兼容口，也不能擅自“恢复”第一个进程的活跃轮次。
  await assert.rejects(startWorkbenchStarfield({ ...config, compatibilityPort: Number(new URL(previous).port) }), { code: 'EADDRINUSE' });
  assert.equal((await json(primary, path)).activeTurnId, turnId);
  release.resolve();
  const sse = await (await request(primary, path + '/turns/' + turnId + '/events')).text();
  assert.match(sse, /event: turn\.committed/);
  assert.deepEqual(await json(primary, path), await json(previous, path));
  assert.equal((await json(primary, '/api/host/session', {})).resumeSessionId, sessionId);

  await runtime.close();
  runtime = await startWorkbenchStarfield({ ...config, port: Number(new URL(primary).port), compatibilityPort: Number(new URL(previous).port) });
  assert.equal((await json(primary, '/api/host/session', {})).resumeSessionId, sessionId);
  assert.equal((await json(previous, path)).debate.currentRound.id, 'r1');
  owner = 'reader-b';
  assert.equal((await json(primary, '/api/host/session', {})).resumeSessionId, null);
  const otherPair = new URL((await runtime.issuePair()).url);
  const other = await json(previous, '/api/host/session', { pairCode: otherPair.hash.slice(6) });
  assert.equal(other.connected, true);
  assert.equal(other.resumeSessionId, null);
  runtime.revoke(owner);
  assert.equal((await json(primary, '/api/host/session', {})).connected, false);
});
