import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createContentAgent, splitBody } from '../content-agent.mjs';
import { contentHash, ruleReview } from '../content-policy.mjs';
import { createHistoryStore } from '../history-data.mjs';
import { collectSelectedData } from '../zhihu-sources.mjs';

const post = (overrides = {}) => ({ contentId: '1', contentType: 'article', kind: 'history',
  title: '数据库索引的工作原理', summary: '介绍索引原理和性能测试方法，比较不同数据结构。',
  topics: [], voteCount: 10, commentCount: 2, bodyText: '介绍索引工作原理。通过性能测试比较不同数据结构。', bodyStatus: 'available', ...overrides });
const result = (overrides = {}) => ({ decision: 'keep', confidence: 0.95, reason: '正文解释了索引机制。',
  summary: '索引通过数据结构加快检索，具体性能取决于查询场景。', keywords: ['索引'], tags: ['技术解析'], domains: ['计算机'], knowledgePoints: ['索引的数据结构'], ...overrides });

test('knowledge rules remove sensational examples without banning educational sensitive topics', () => {
  assert.equal(ruleReview(post({ title: '是什么让你感到人和禽兽没有区别？', bodyText: '', summary: '公司新来一个小美女，黑丝，又纯又欲。' })).decision, 'exclude');
  assert.equal(ruleReview(post({ title: '是什么让你感到人和禽兽没有区别？', bodyText: '', summary: '' })).decision, 'exclude');
  assert.equal(ruleReview(post({ title: '性教育与犯罪预防科普', bodyText: '结合临床研究与统计数据分析原因。' })).decision, 'keep');
  assert.equal(ruleReview(post({ title: '人和禽兽有什么区别？', bodyText: '研究表明不同物种行为有差异，实验和统计提供了证据。' })).decision, 'keep');
  assert.equal(ruleReview(post({ title: '如何评价游戏里的叙事结构', bodyText: '这里提供文本分析和人物塑造的具体步骤。' })).decision, 'keep');
  assert.equal(ruleReview(post({ title: '一篇资料', summary: '', bodyText: '' })).decision, 'review');
});

test('full-body agent processes every character, summarizes all parts, and reuses input-specific cache', async () => {
  const bodies = [];
  let calls = 0;
  const agent = createContentAgent({ model: 'local-model', async fetchImpl(url, options) {
    calls += 1;
    const input = JSON.parse(options.body);
    if (url.pathname === '/api/show') return Response.json({ model_info: { 'local.context_length': 8192 } });
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(input.stream, false);
    assert.ok(input.format.properties.knowledgePoints);
    assert.equal(input.messages[0].role, 'system');
    const prompt = JSON.parse(input.messages[1].content);
    if (prompt.body) bodies.push(prompt.body);
    return Response.json({ done: true, message: { content: JSON.stringify(result()) } });
  } });
  const run = agent.createRun();
  const record = post({ bodyText: '一段正文🙂。'.repeat(900) });
  const cache = new Map();
  const output = await run(record, { cached: (key) => cache.get(key), save: (key, value) => cache.set(key, value) });
  assert.equal(bodies.join(''), record.bodyText);
  assert.equal(splitBody(record.bodyText).join(''), record.bodyText);
  assert.equal(output.analysis.coverage.characters, Array.from(record.bodyText).length);
  assert.ok(output.analysis.coverage.chunks > 1);
  assert.ok(output.analysis.coverage.aggregationLevels > 0);
  assert.deepEqual(output.analysis.domains, ['计算机']);
  const previous = calls;
  const second = await agent.createRun()(record, { cached: (key) => cache.get(key) });
  assert.equal(second.analysis.method, 'ollama');
  assert.equal(calls, previous);
  assert.notEqual(contentHash(record), contentHash({ ...record, bodyText: `${record.bodyText}新增内容` }));
});

test('agent does not invent full-text summaries on missing or partial bodies, model errors, or low confidence', async () => {
  let calls = 0;
  const failing = createContentAgent({ model: 'local-model', async fetchImpl() { calls += 1; throw new Error('offline'); } });
  for (const bodyStatus of ['unavailable', 'partial']) {
    const output = await failing.createRun()(post({ bodyStatus }));
    assert.equal(output.analysis.summary, null);
    assert.match(output.analysis.agentWarning, /正文不足/);
  }
  assert.equal(calls, 0);
  const run = failing.createRun();
  assert.equal((await run(post())).analysis.summary, null);
  assert.equal((await run(post({ contentId: '2' }))).analysis.method, 'rules');
  assert.equal(calls, 1);
  const uncertain = createContentAgent({ model: 'local-model', async fetchImpl(url) {
    return Response.json(url.pathname === '/api/show' ? { model_info: {} } : { message: { content: JSON.stringify(result({ decision: 'exclude', confidence: 0.4 })) } });
  } });
  assert.equal((await uncertain.createRun()(post())).analysis.decision, 'review');
  assert.throws(() => createContentAgent({ baseUrl: 'https://example.org' }), /本机回环/);
  const remote = createContentAgent({ model: 'remote', async fetchImpl() { return Response.json({ remote_host: 'https://cloud.example', model_info: {} }); } });
  assert.equal((await remote.status()).ready, false);
});

test('store excludes unsuitable cached posts reversibly, preserves reasons, and keeps data-kind counts separate', () => {
  const db = new DatabaseSync(':memory:');
  const store = createHistoryStore(db);
  store.create('source');
  store.save('source', { id: 'owner', nickname: '读者' }, [post(), post({ contentId: 'bad', title: '你做过最龌龊，最下流的事是什么？', bodyText: '', summary: '纯故事。' })], false);
  const filtered = store.snapshot('source');
  assert.equal(filtered.records.length, 1);
  assert.equal(filtered.excluded.length, 1);
  assert.equal(filtered.excluded[0].analysis.decision, 'exclude');
  assert.deepEqual(filtered.counts, { history: 1, likes: 0, collections: 0 });
  store.saveSettings('source', { history: true, likes: false, collections: false, knowledgeFilter: false });
  assert.equal(store.snapshot('source').records.length, 2);
  store.clear('source');
  assert.equal(store.snapshot('source').excluded.length, 0);
  db.close();
});

test('collection obtains body even when metrics exist and continues after knowledge exclusions', async () => {
  const analyzed = [];
  const history = (id, title) => ({ data: { header: { title }, content: { voteup_count: 10, comment_count: 2, topics: [{ id: 't', name: '主题' }] },
    extra: { content_type: 'answer', content_token: id, read_time: 1900000000 } } });
  const requests = [];
  const gateway = { async request(path) {
    requests.push(path);
    const url = new URL(path, 'https://www.zhihu.com');
    if (url.pathname.includes('read_history')) return url.searchParams.get('offset') === '0'
      ? { data: [history('bad', '你做过最龌龊，最下流的事是什么？')], paging: { is_end: false, next: '?offset=50' } }
      : { data: [history('good', '数据库索引的工作原理')], paging: { is_end: true } };
    const id = url.pathname.split('/').pop();
    assert.match(path, /include=content/);
    return { id, content: `<p>${id === 'bad' ? '小美女，黑丝，又纯又欲。' : '索引的工作原理和性能测试，以下是完整说明。'}</p>`, voteup_count: 10, comment_count: 2 };
  } };
  const records = await collectSelectedData(gateway, { id: 'me', slug: 'me' }, { history: true, aiReview: true, knowledgeFilter: true }, {
    checkActive() {}, async pause() {}, progress() {}, async analyze(record) { analyzed.push(record); return record; },
  });
  assert.equal(records.filter((r) => r.analysis.decision !== 'exclude').length, 1);
  assert.equal(records.filter((r) => r.analysis.decision === 'exclude').length, 1);
  assert.equal(analyzed.length, 2);
  assert.ok(analyzed.every((r) => r.bodyStatus === 'available' && r.bodyText));
  assert.ok(requests.some((path) => path.includes('offset=50')));
});
