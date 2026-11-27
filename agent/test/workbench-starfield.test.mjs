import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkbenchStarfield } from '../workbench-starfield.mjs';
import { createDebateAgents, DEBATE_ROUNDS } from '../debate-agents.mjs';
import { modelThinkingOptions } from '../agent.mjs';

const now = Date.parse('2026-11-27T00:00:00Z');
const fact = '在开放式办公室里，键盘敲击声会干扰邻座同事。';
const privateTitle = '用户自己的未外发材料标题';
const fakeSearch = (createdTime = now) => ({ ok: true, data: { requestId: 'real-like-synthetic', items: [{
  contentId: '123456', contentType: 'answer', title: '开放式办公室的键盘声音',
  excerpt: fact, author: '合成作者', url: 'https://www.zhihu.com/question/123/answer/456',
  createdTime, voteCount: 50, commentCount: 10,
}] } });

function fixtures({ firstArgument } = {}) {
  const roleCalls = [];
  const searchCalls = [];
  let serial = 0;
  const agents = createDebateAgents({
    now: () => now,
    search: async (params) => { searchCalls.push(params); return fakeSearch(); },
    complete: async (role, _instructions, input) => {
      roleCalls.push({ role, input });
      if (role === 'topic') return { claim: '办公室的测试判断' + ++serial + '在任何场合都成立。',
        topic: '办公室声音', flaw: '把少数个人体验外推到所有场景', evidenceId: input.source[0].id };
      if (role === 'structure') return { nodes: [
        { id: 'b1', name: '座位距离', text: '所有座位之间的距离相同。', deps: [] },
        { id: 'b2', name: '使用频率', text: '员工每天敲击键盘的时间相同。', deps: [] },
        { id: 'b3', name: '环境声', text: '办公室的背景声不变。', deps: [] },
        { id: 'b4', name: '结论', text: input.claim, deps: ['b1', 'b2', 'b3'] },
      ] };
      if (role === 'opponent' && firstArgument) {
        const argument = firstArgument;
        firstArgument = null;
        return { stance: 'defend', argument, citations: [] };
      }
      if (role === 'opponent') return { stance: 'defend', responseRef: input.lastChoice?.slice(0, 7),
        argument: (input.lastChoice ? '你刚才提到' + input.lastChoice.slice(0, 7) + '，' : '')
          + '在我看来，' + input.focus.lens + '仍然能解释我为什么坚持这个判断。', citations: [] };
      if (role === 'options') return { options: [
        { angle: '公开论据', text: input.focus.lens + '有个反例：' + fact, fact, conflicts: [],
          citations: [{ evidenceId: input.evidence[0].id, quote: fact }] },
        { angle: '要求另一个案例', text: '在' + input.focus.lens + '上，可以比较其他办公空间吗？', fact: null },
        { angle: '判断依据', text: '你在' + input.focus.lens + '上会看哪些客观标准？', fact: null },
        { angle: '虚构引用', text: '与真实资料无关的虚构事实。', fact, citations: [{ evidenceId: input.evidence[0].id, quote: '这个引文不存在' }] },
      ] };
      if (role === 'settlement') return { points: input.selected.map(({ round, fact: description }) => ({
        round, title: round === 12 ? '声学实验中的噪音' : '开放办公的输入噪音',
        domain: round === 12 ? '声学工程' : '职场管理', description,
      })) };
      throw new Error('Unexpected model role');
    },
  });
  return { agents, roleCalls, searchCalls };
}

test('对手发言包含未核验引文时先重写，再发布完整的回应', async () => {
  const { agents, roleCalls } = fixtures({ firstArgument: '资料说「只要倾听就能化解一切矛盾」，所以我认为足够了。' });
  const topic = { topic: '办公室声音', claim: '键盘声一定影响同事。' };
  const beliefs = await agents.decompose(topic);
  const published = [];
  const { currentRound } = await agents.prepareRound({ topic, beliefs, history: [], evidence: [], willpower: 100 },
    1, (stage, text) => { if (stage === 'opponent') published.push(text); });
  assert.equal(roleCalls.filter(({ role }) => role === 'opponent').length, 2);
  assert.deepEqual(published, [currentRound.opponent.argument]);
  assert.doesNotMatch(published[0], /略去|只要倾听/);
});

test('工作台配对、三题、十二轮选择及独立知识库端到端', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-starfield-'));
  const debateDb = join(dir, 'debate.sqlite');
  const knowledgeDb = join(dir, 'knowledge.sqlite');
  const { agents, roleCalls, searchCalls } = fixtures();
  let owner = 'synthetic-reader-a';
  let profile = { generatedAt: 'profile-v1',
    domains: [{ name: '团队管理', share: .7, evidence: [privateTitle] }, { name: '软件技术', share: .3, evidence: [] }],
    topics: ['协作'], summary: '敏感内容不得进入外部请求',
  };
  const runtime = await startWorkbenchStarfield({ port: 0, debateDb, knowledgeDb, agents,
    getIdentity: async () => owner,
    getMaterials: async () => ({ profile, snapshotId: 's1',
      records: [{ title: privateTitle, topics: ['团队协作'], domains: ['团队管理'] }] }),
  });
  const request = (path, { cookie, input, headers = {} } = {}) => fetch(runtime.origin + path, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...(cookie ? { cookie } : {}),
      ...(input === undefined ? {} : { 'content-type': 'application/json', origin: runtime.origin }) },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const read = async (path, opts) => {
    const response = await request(path, opts);
    return { response, payload: await response.json() };
  };
  try {
    assert.equal((await request('/v1/knowledge-map')).status, 401);
    assert.equal((await request('/')).status, 200);
    const pair = new URL((await runtime.issuePair()).url).hash.slice(6);
    const link = await read('/api/host/session', { input: { pairCode: pair } });
    assert.equal(link.payload.data.connected, true);
    assert.equal((await request('/api/host/session', { input: { pairCode: pair } })).status, 401);
    const cookie = link.response.headers.get('set-cookie').split(';')[0];
    const get = async (path) => (await read(path, { cookie })).payload.data;
    const send = async (path, input) => await read(path, { cookie, input });

    const original = await get('/v1/knowledge-map');
    assert.equal(original.version, 1);
    assert.equal(original.domains[0].points[0].kind, 'encountered');
    assert.equal(original.domains[0].points[0].title, '团队协作');

    let { topics } = (await send('/v1/debate/topics', {})).payload.data;
    assert.deepEqual(topics.map((topic) => topic.source), ['profile', 'profile', 'hot']);
    assert.equal(topics[0].sector, '职场与协作');
    const hotClaim = topics[2].claim;
    profile = { ...profile, generatedAt: 'profile-v2', domains: [{ name: '摄影', share: .9, evidence: [] }] };
    const stale = await send('/v1/sessions', { topicId: topics[0].id });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.payload.error.code, 'TOPIC_EXPIRED');
    ({ topics } = (await send('/v1/debate/topics', {})).payload.data);
    assert.equal(topics[0].sector, '影像与设计');
    assert.equal(topics[2].claim, hotClaim);
    assert.ok(!JSON.stringify({ roleCalls, searchCalls }).includes(privateTitle));
    assert.ok(!JSON.stringify({ roleCalls, searchCalls }).includes(profile.summary));

    const started = (await send('/v1/sessions', { topicId: topics[0].id })).payload.data;
    const sid = '/v1/sessions/' + started.sessionId;
    const execute = async (operation, requestId) => {
      const input = { clientRequestId: requestId, baseGraphVersion: 0, action: operation };
      const turn = await send(sid + '/turns', input);
      assert.equal(turn.response.status, 202);
      const path = sid + '/turns/' + turn.payload.data.turnId + '/events';
      const sse = await (await request(path, { cookie })).text();
      assert.match(sse, /event: turn\.committed/);
      assert.match(sse, /event: turn\.done/);
      if (requestId !== 'choice-' + DEBATE_ROUNDS) {
        const raw = /event: evidence\.verified\ndata: ([^\n]+)/.exec(sse)?.[1];
        assert.ok(raw);
        const event = JSON.parse(raw);
        assert.deepEqual(Object.keys(event), ['roundId', 'evidenceIds']);
        assert.deepEqual(event.evidenceIds, ['ev_sch_answer_123456']);
      }
      const replay = await (await request(path, { cookie, headers: { 'last-event-id': '1' } })).text();
      assert.doesNotMatch(replay, /event: turn\.started/);
      const duplicate = await send(sid + '/turns', input);
      assert.equal(duplicate.response.status, 200);
      assert.equal(duplicate.payload.data.turnId, turn.payload.data.turnId);
      return get(sid);
    };

    let state = await execute({ type: 'open_debate' }, 'open');
    const first = state.debate.currentRound;
    const alternate = (await send('/v1/sessions', { topicId: topics[0].id })).payload.data;
    const alternateSid = '/v1/sessions/' + alternate.sessionId;
    const alternateTurn = async (action, clientRequestId) => {
      const result = await send(alternateSid + '/turns', { action, clientRequestId, baseGraphVersion: 0 });
      assert.equal(result.response.status, 202);
      await (await request(alternateSid + '/turns/' + result.payload.data.turnId + '/events', { cookie })).text();
      return get(alternateSid);
    };
    const alternateInitial = (await alternateTurn({ type: 'open_debate' }, 'open')).debate.currentRound;
    const alternateRound = (await alternateTurn({
      type: 'choose_debate_option',
      roundId: alternateInitial.id,
      optionId: alternateInitial.options[0].id,
    }, 'alternate')).debate.currentRound;
    assert.equal(alternateRound.opponent.respondsTo, alternateInitial.options[0].id);

    const blocked = new DatabaseSync(knowledgeDb);
    try {
      for (let round = 1; round <= DEBATE_ROUNDS; round += 1) {
        const shown = state.debate.currentRound;
        assert.equal(shown.number, round);
        assert.equal(shown.options.length, 3);
        assert.ok(shown.options.every((option) => option.angle !== '虚构引用'));
        const selected = shown.options[round % 2 === 0 ? 0 : 1];
        if (round > 1) {
          assert.equal(shown.opponent.respondsTo, state.debate.history.at(-1).option.id);
          assert.ok(state.debate.history.at(-1).option.text.includes(shown.opponent.responseRef));
        }
        assert.equal((await get('/v1/knowledge-map')).version, 1);
        if (round === DEBATE_ROUNDS) blocked.exec('BEGIN IMMEDIATE');
        state = await execute({ type: 'choose_debate_option', roundId: shown.id, optionId: selected.id }, 'choice-' + round);
        assert.equal(state.debate.history.length, round);
        if (round === 1) {
          assert.equal(state.debate.currentRound.opponent.respondsTo, first.options[1].id);
          assert.notEqual(state.debate.currentRound.opponent.argument, alternateRound.opponent.argument);
        }
      }
      assert.equal((await get('/v1/knowledge-map')).pending, true);
      assert.equal((await get('/v1/knowledge-map')).version, 1);
    } finally { blocked.close(); }

    assert.equal(state.debate.currentRound, null);
    assert.equal(state.debate.settlement.points.length, 6);
    assert.equal(state.debate.settlement.pending.length, 6);
    assert.equal(roleCalls.filter((call) => call.role === 'settlement').length, 1);
    const map = await get('/v1/knowledge-map');
    assert.equal(map.version, 2);
    const point = map.domains[0].points.find((value) => value.kind === 'verified');
    assert.equal(point.title, '开放办公的输入噪音');
    assert.equal(point.sources.length, 5);
    assert.ok(point.sources.every((ref) => ref.round % 2 === 0 && ref.sessionId === started.sessionId));
    assert.equal(map.domains.find((domain) => domain.name === '声学工程').points[0].sources[0].round, 12);
    assert.deepEqual(await get('/v1/knowledge-map'), map);

    // 即使浏览器还带原 Cookie，工作台切换账号也无法读取此前会话。
    owner = 'synthetic-reader-b';
    assert.equal((await request(sid, { cookie })).status, 401);
    const secondPair = new URL((await runtime.issuePair()).url).hash.slice(6);
    const linked = await read('/api/host/session', { input: { pairCode: secondPair } });
    const otherCookie = linked.response.headers.get('set-cookie').split(';')[0];
    assert.equal((await request(sid, { cookie: otherCookie })).status, 403);
    assert.equal((await read('/v1/knowledge-map', { cookie: otherCookie })).payload.data.version, 1);

    const db = new DatabaseSync(knowledgeDb, { readOnly: true });
    try { assert.equal(db.prepare('SELECT count(*) n FROM knowledge_imports').get().n, 1); }
    finally { db.close(); }
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('统一模型工厂在可关闭的智谱与 DeepSeek 模型上关掉思考', () => {
  assert.deepEqual(modelThinkingOptions({ modelName: 'glm-5.4', baseURL: 'https://open.bigmodel.cn' }), { thinking: { type: 'disabled' } });
  assert.deepEqual(modelThinkingOptions({ modelName: 'deepseek-flash' }), { thinking: { type: 'disabled' } });
  assert.deepEqual(modelThinkingOptions({ modelName: 'glm-5.3-flash' }), { reasoning_effort: 'low' });
});

test('取消回合和重启保持已提交进度，旧取消请求不会中断新回合', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-starfield-recover-'));
  const names = fixtures();
  const args = {
    port: 0,
    debateDb: join(dir, 'debate.sqlite'),
    knowledgeDb: join(dir, 'knowledge.sqlite'),
    agents: names.agents,
    getIdentity: async () => 'synthetic-owner',
    getMaterials: async () => ({
      snapshotId: 's1', records: [],
      profile: { generatedAt: 'v1', domains: [{ name: '管理', evidence: [] }], topics: [] },
    }),
  };
  const original = names.agents.prepareRound;
  let enter;
  let blocked;
  names.agents.prepareRound = async (state, num, emit, signal) => {
    if (blocked) {
      enter?.();
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    return original(state, num, emit, signal);
  };
  let runtime = await startWorkbenchStarfield(args);
  let cookie;
  const request = async (path, input) => {
    const res = await fetch(runtime.origin + path, {
      method: input ? 'POST' : 'GET',
      headers: { ...(cookie ? { cookie } : {}), ...(input ? { 'content-type': 'application/json' } : {}) },
      body: input ? JSON.stringify(input) : undefined,
    });
    if (res.headers.has('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return res;
  };
  const json = async (path, input) => (await (await request(path, input)).json()).data;
  try {
    const pairCode = new URL((await runtime.issuePair()).url).hash.slice(6);
    await json('/api/host/session', { pairCode });
    const { topics } = await json('/v1/debate/topics', {});
    const { sessionId } = await json('/v1/sessions', { topicId: topics[0].id });
    const path = '/v1/sessions/' + sessionId;
    const submit = (clientRequestId, action) => json(path + '/turns', { clientRequestId, action, baseGraphVersion: 0 });
    const sse = async (turnId) => (await request(path + '/turns/' + turnId + '/events')).text();
    const open = await submit('open', { type: 'open_debate' });
    await sse(open.turnId);
    const round = (await json(path)).debate.currentRound;
    const choice = { type: 'choose_debate_option', roundId: round.id, optionId: round.options[0].id };
    blocked = true;
    let entered = new Promise((resolve) => { enter = resolve; });
    const pending = await submit('pending', choice);
    await entered;
    await json(path + '/turns/' + pending.turnId + '/cancel', {});
    assert.match(await sse(pending.turnId), /event: turn\.cancelled/);
    assert.equal((await json(path)).debate.history.length, 0);

    entered = new Promise((resolve) => { enter = resolve; });
    const newer = await submit('keep-this', choice);
    await entered;
    await json(path + '/turns/' + pending.turnId + '/cancel', {});
    const stillActive = await json(path);
    assert.equal(stillActive.activeTurnId, newer.turnId);
    assert.equal(stillActive.debate.history.length, 0);
    await runtime.close();

    blocked = false;
    runtime = await startWorkbenchStarfield(args);
    assert.equal((await json('/api/host/session', {})).connected, true);
    const recovered = await json(path);
    assert.equal(recovered.lastTurn.status, 'interrupted');
    assert.equal(recovered.debate.currentRound.id, round.id);
    assert.equal(recovered.debate.history.length, 0);
    assert.equal((await json('/v1/knowledge-map')).version, 1);
    const retry = await submit('retry-after-restart', choice);
    assert.match(await sse(retry.turnId), /event: turn\.committed/);
    assert.equal((await json(path)).debate.history.length, 1);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('撤回授权后，正在兑换的配对码与旧会话都不能恢复权限', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-starfield-revoke-'));
  const owner = 'synthetic-owner';
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let pauseMaterials = false;
  const runtime = await startWorkbenchStarfield({
    port: 0,
    debateDb: join(dir, 'debate.sqlite'),
    knowledgeDb: join(dir, 'knowledge.sqlite'),
    agents: fixtures().agents,
    getIdentity: async () => owner,
    getMaterials: async () => {
      if (pauseMaterials) {
        entered.resolve();
        await release.promise;
      }
      return { snapshotId: 's1', records: [], profile: { generatedAt: 'v1', domains: [], topics: [] } };
    },
  });
  const issue = async () => new URL((await runtime.issuePair()).url).hash.slice(6);
  const link = (pairCode) => fetch(runtime.origin + '/api/host/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairCode }),
  });
  try {
    const initial = await link(await issue());
    assert.equal(initial.status, 200);
    const cookie = initial.headers.get('set-cookie').split(';')[0];
    const pairCode = await issue();
    pauseMaterials = true;
    const exchange = link(pairCode);
    await entered.promise;
    runtime.revoke(owner);
    release.resolve();
    const revoked = await exchange;
    assert.equal(revoked.status, 401);
    assert.equal(revoked.headers.get('set-cookie'), null);
    assert.equal((await fetch(runtime.origin + '/v1/knowledge-map', { headers: { cookie } })).status, 401);
    assert.equal((await link(pairCode)).status, 401);

    pauseMaterials = false;
    assert.equal((await link(await issue())).status, 200);
  } finally {
    release.resolve();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('正式星球封面在手机上走完十二轮，三维星点保留本轮出处并能返回封面', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-cover-browser-'));
  const { agents } = fixtures();
  const runtime = await startWorkbenchStarfield({
    port: 0,
    debateDb: join(dir, 'debate.sqlite'),
    knowledgeDb: join(dir, 'knowledge.sqlite'),
    agents,
    getIdentity: async () => 'synthetic-cover-reader',
    getMaterials: async () => ({
      snapshotId: 'cover-fixture', records: [],
      profile: { generatedAt: 'v1', domains: [], topics: ['团队协作'] },
    }),
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });

  const { loadBrowser } = await import('../../data-collection-service/local/lib/browser-runtime.mjs');
  const { chromium, selected } = await loadBrowser();
  browser = await chromium.launch({ ...selected.launchOptions, headless: true });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  page.setDefaultTimeout(8000);
  const calls = [];
  const errors = [];
  page.on('request', (request) => {
    const { origin, pathname } = new URL(request.url());
    calls.push({ origin, pathname, method: request.method(), type: request.resourceType() });
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const button = (name) => page.getByRole('button', { name, exact: true });
  const showCover = async () => {
    await button('返回封面').click();
    await page.getByRole('heading', { name: /对方买不买得起/u }).waitFor();
  };

  await page.goto(runtime.origin);
  await page.getByRole('heading', { name: /对方买不买得起/u }).waitFor();
  assert.ok(await page.locator('#planet').isVisible());
  assert.equal(await button('使用演示账号').isVisible(), false);
  await button('开始观点交锋').click();
  await page.getByRole('link', { name: '去工作台连接' }).waitFor();
  assert.equal(calls.filter(({ pathname }) => pathname.startsWith('/v1/')).length, 0);

  const pair = new URL((await runtime.issuePair()).url);
  pair.searchParams.set('debug', '1');
  await page.goto(pair.href);
  await button('找三个观点').waitFor();
  await showCover();
  await button('我的知识星图').click();
  const galaxy = page.getByRole('dialog', { name: 'Mind Galaxy' });
  await galaxy.waitFor();
  await galaxy.getByText(/1 个知识点.*v1/u).waitFor();
  // 画布星点没有 DOM 元素，读取引擎投影坐标后，用触屏命中该点。
  const projected = await page.waitForFunction(() => {
    const star = window.__galaxy?.projected.find((point) => point.n.name === '团队协作');
    return star && { x: star.x, y: star.y };
  });
  await galaxy.locator('canvas').tap({ position: await projected.jsonValue() });
  await galaxy.getByRole('heading', { name: '团队协作', exact: true }).waitFor();
  await button('← 返回').click();
  await galaxy.waitFor({ state: 'hidden' });

  await button('开始观点交锋').click();
  const topics = button('挑战这条观点');
  await topics.first().waitFor();
  assert.equal(await topics.count(), 3);
  assert.equal(await page.getByText('来自你的画像偏好', { exact: true }).count(), 2);
  assert.equal(await page.getByText('知乎近期高互动', { exact: true }).count(), 1);
  await topics.first().click();
  const options = page.locator('.option-button');
  for (let round = 1; round <= DEBATE_ROUNDS; round += 1) {
    await page.getByText('第 ' + round + ' / 12 轮', { exact: true }).waitFor();
    await options.first().waitFor();
    assert.equal(await options.count(), 3);
    const verified = page.getByRole('button', { name: /公开论据/u });
    if (round === 1) {
      const firstCard = page.locator('article').filter({ has: verified });
      await firstCard.getByText('看看出处', { exact: true }).click();
      const reference = firstCard.getByRole('link', { name: /合成作者/u });
      assert.equal(await reference.getAttribute('href'), 'https://www.zhihu.com/question/123/answer/456');
    }
    if (round === 2) {
      await page.reload();
      await page.getByText('第 2 / 12 轮', { exact: true }).waitFor();
      await page.getByText(/回应了你上轮提到的/u).waitFor();
    }
    await verified.click();
  }
  await button('去知识星图看看').waitFor();
  assert.equal(await page.locator('.timeline article').count(), DEBATE_ROUNDS);
  await button('去知识星图看看').click();
  const finalStar = page.locator('details.star').filter({ has: page.getByText('声学实验中的噪音', { exact: true }) });
  await finalStar.locator('summary').first().click();
  await finalStar.getByRole('button', { name: '在三维星图中查看' }).click();
  await galaxy.waitFor();
  await galaxy.getByText(/3 个知识点.*v2/u).waitFor();
  assert.equal(await galaxy.locator('#cardName').innerText(), '声学实验中的噪音');
  assert.equal(await galaxy.locator('#cardCluster').innerText(), '声学工程');
  await galaxy.getByText('看看出处', { exact: true }).click();
  await galaxy.getByText('来自本局第 12 轮', { exact: true }).waitFor();
  assert.equal(await galaxy.getByRole('link', { name: /合成作者/u }).getAttribute('href'),
    'https://www.zhihu.com/question/123/answer/456');
  await button('← 返回').click();
  await galaxy.waitFor({ state: 'hidden' });
  await showCover();
  assert.deepEqual([...new Set(calls.map(({ origin }) => origin))], [runtime.origin]);
  assert.equal(calls.filter(({ pathname, method }) => pathname === '/v1/sessions' && method === 'POST').length, 1);
  assert.equal(calls.filter(({ pathname, method }) => pathname.endsWith('/turns') && method === 'POST').length, 13);
  assert.equal(calls.filter(({ pathname, type }) => pathname.endsWith('/events') && type === 'eventsource').length, 13);
  assert.deepEqual(errors, []);
});
