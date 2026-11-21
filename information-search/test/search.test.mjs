import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOfficialClient, createDemoClient, normalizeItem, SearchError } from '../official-client.mjs';
import { validateCriteria, buildQueryPlan, matchItem, createInformationSearch } from '../search.mjs';
import { createSearchStore } from '../store.mjs';
import { createSearchHttpServer } from '../server.mjs';
import { toMarkdown } from '../report.mjs';

const raw = (extra = {}) => ({ ContentID: '123', ContentType: 'Article', Title: 'RAG 评测方法', ContentText: '人工智能与检索实践。',
  Url: 'https://zhuanlan.zhihu.com/p/123?utm_source=official', AuthorName: '示例作者', VoteUpCount: 10, CommentCount: 2, RankingScore: 0.8, ...extra });

function localStore(t, options) {
  const directory = mkdtempSync(join(tmpdir(), 'quotation-search-'));
  const filename = join(directory, 'search.sqlite');
  const store = createSearchStore(filename, options);
  t.after(() => { store.close(); rmSync(filename, { force: true }); rmdirSync(directory); });
  return store;
}

test('官方客户端只使用文档参数，并保留长 ID、溯源链接和来源字段', async () => {
  const client = createOfficialClient({ accessSecret: 'fixture-secret', async fetchImpl(url, options) {
    assert.equal(url.origin, 'https://developer.zhihu.com');
    assert.equal(url.pathname, '/api/v1/content/zhihu_search');
    assert.deepEqual([...url.searchParams.keys()], ['Query', 'Count']);
    assert.equal(url.searchParams.get('Query'), 'RAG 评测');
    assert.equal(url.searchParams.get('Count'), '1');
    assert.equal(options.headers.Authorization, 'Bearer fixture-secret');
    assert.match(options.headers['X-Request-Timestamp'], /^\d{10}$/);
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ Code: 0, Data: { HasMore: false, SearchHashId: 'trace', Items: [raw({ ContentText: '<em>RAG</em> &amp; 检索<script>bad()</script>', CommentInfoList: [{ Content: '<b>精选评论</b>' }] })] } }).replace('"123"', '969570047710216201'));
  } });
  const result = await client.search('RAG 评测', 1);
  assert.equal(result.items[0].contentId, '969570047710216201');
  assert.match(result.items[0].url, /utm_source=official/);
  assert.equal(result.items[0].canonicalUrl, 'https://zhuanlan.zhihu.com/p/123');
  assert.equal(result.items[0].excerpt, 'RAG & 检索');
  assert.deepEqual(result.items[0].selectedComments, ['精选评论']);
  assert.equal(result.items[0].platformTags, null);
  assert.equal(result.items[0].fullTextAvailable, false);
});

test('官方错误映射不暴露凭证，取消请求不会被当成成功', async () => {
  for (const [code, status] of [[20001, 401], [30001, 429], [10001, 400], [90001, 502]]) {
    const client = createOfficialClient({ accessSecret: 'private-fixture-value', fetchImpl: async () => Response.json({ Code: code, Message: 'private-fixture-value' }) });
    await assert.rejects(client.search('RAG'), (error) => error.status === status && !error.message.includes('private-fixture-value'));
  }
  await assert.rejects(createOfficialClient().search('RAG'), (error) => error.code === 'NOT_CONFIGURED');
  const signal = AbortSignal.abort(new Error('已取消'));
  const client = createOfficialClient({ accessSecret: 'fixture', async fetchImpl(_url, options) { options.signal.throwIfAborted(); } });
  await assert.rejects(client.search('RAG', 1, { signal }), /已取消/);
  assert.equal(normalizeItem(raw({ Url: 'javascript:alert(1)' })).url, null);
});

test('条件校验限制查询预算，计划截取可追溯，不构造分页或话题参数', () => {
  const criteria = validateCriteria({ keywords: ['RAG', 'rag', '检索'], tags: ['人工智能', '知识库'], maxQueries: 2 });
  assert.equal(criteria.keywords.length, 2);
  const plan = buildQueryPlan(criteria);
  assert.equal(plan.queries.length, 2);
  assert.equal(plan.truncated, true);
  for (const input of [{}, { keywords: 'RAG' }, { query: 'x', countPerQuery: 11 }, { query: 'x', maxQueries: 7 }, { query: 'x', tagMode: 'exact' }, { query: 'x', topicId: '1' }]) {
    assert.throws(() => validateCriteria(input), (error) => error.status === 400);
  }
});

test('关键词和标签词支持任意或全部匹配，兼容中文相邻与英文词边界', () => {
  const criteria = validateCriteria({ keywords: ['RAG', '评测'], tags: ['人工智能'], keywordMode: 'all' });
  const matched = matchItem(normalizeItem(raw()), criteria);
  assert.equal(matched.accepted, true);
  assert.deepEqual(matched.tags, ['人工智能']);
  assert.equal(matched.tagSource, 'local_title_excerpt_match');
  assert.ok(matched.evidence.some((entry) => entry.term === 'RAG' && entry.fields.includes('title')));
  const ai = validateCriteria({ keywords: ['AI'] });
  assert.equal(matchItem(normalizeItem(raw({ Title: 'AI模型', ContentText: '' })), ai).accepted, true);
  assert.equal(matchItem(normalizeItem(raw({ Title: 'railway', ContentText: '' })), ai).accepted, false);
  assert.equal(matchItem(normalizeItem(raw()), validateCriteria({ tags: ['人工智能', '物理'], tagMode: 'all' })).accepted, false);
  assert.equal(matchItem(normalizeItem(raw()), validateCriteria({ query: 'RAG', contentTypes: ['answer'] })).accepted, false);
});

test('服务合并不同摘要片段、去重并缓存查询，支持强制刷新和缓存到期', async (t) => {
  let clock = 1_000; let calls = 0;
  const store = localStore(t, { now: () => clock, ttlMs: 100 });
  const client = { async search(query) { calls += 1; return { query, searchHashId: `s-${calls}`, hasMore: false, items: [normalizeItem(raw({ ContentText: calls % 2 ? '数据库索引' : '人工智能', RankingScore: calls / 10 }))] }; } };
  const service = createInformationSearch({ client, store, now: () => clock, queryDelayMs: 0 });
  const input = { keywords: ['RAG'], tags: ['人工智能'], maxQueries: 2 };
  const first = await service.search(input);
  assert.equal(first.items.length, 1);
  assert.equal(first.stats.rawCount, 2);
  assert.equal(first.stats.uniqueCount, 1);
  assert.equal(first.items[0].excerptVariants.length, 2);
  assert.equal(first.items[0].rankingScore, 0.2);
  assert.ok(first.searches.every((item) => !item.fromCache));
  const second = await service.search(input);
  assert.equal(calls, 2);
  assert.equal(second.stats.apiCalls, 0);
  assert.equal(second.stats.cacheHits, 2);
  assert.ok(second.searches.every((item) => item.fromCache));
  await service.search(input, { refresh: true });
  assert.equal(calls, 4);
  clock += 101;
  await service.search(input);
  assert.equal(calls, 6);
  assert.equal(store.get().requestId !== first.requestId, true);
});

test('后续查询失败或取消时保留上一次成功结果', async (t) => {
  const store = localStore(t);
  const initial = createInformationSearch({ client: createDemoClient(), store, queryDelayMs: 0 });
  const saved = await initial.search({ query: 'RAG', maxQueries: 1 });
  let calls = 0;
  const broken = createInformationSearch({ store, queryDelayMs: 0, client: { async search() { calls += 1; if (calls === 2) throw new SearchError('限流', 429); return { hasMore: true, items: [normalizeItem(raw())] }; } } });
  await assert.rejects(broken.search({ keywords: ['检索'], tags: ['知识库'], maxQueries: 2 }, { refresh: true }), (error) => error.status === 429);
  assert.equal(store.get().requestId, saved.requestId);
  const controller = new AbortController();
  const cancelled = createInformationSearch({ store, queryDelayMs: 0, client: { async search() { controller.abort(new Error('取消')); return { hasMore: false, items: [] }; } } });
  await assert.rejects(cancelled.search({ query: '取消测试' }, { signal: controller.signal }), /取消/);
  assert.equal(store.get().requestId, saved.requestId);
});

test('HTTP 支持演示搜索、参数校验、安全导出和来源检查', async (t) => {
  const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; listener.close(); await once(listener, 'close');
  const origin = `http://127.0.0.1:${port}`;
  const store = localStore(t);
  const service = createInformationSearch({ client: createDemoClient(), store, demo: true, queryDelayMs: 0 });
  const server = createSearchHttpServer({ origin, service, store, configured: true, demo: true });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const send = (path, options = {}) => fetch(origin + path, options);
  assert.equal((await send('/')).status, 200);
  assert.equal((await send('/api/status')).status, 200);
  assert.equal((await send('/api/export')).status, 404);
  const payload = { criteria: { keywords: ['RAG'], tags: ['人工智能'], maxQueries: 2 } };
  assert.equal((await send('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).status, 403);
  const response = await send('/api/search', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.provider, 'demo');
  assert.equal(snapshot.coverage.platformTagsAvailable, false);
  assert.deepEqual((await (await send(`/api/results?id=${snapshot.requestId}`)).json()).criteria, snapshot.criteria);
  const exported = await send(`/api/export?id=${snapshot.requestId}&format=markdown`);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  assert.match(await exported.text(), /标签词仅匹配标题和摘要/);
  assert.equal((await send('/api/search', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ criteria: { topicId: 'native' } }) })).status, 400);
  const report = toMarkdown({ ...snapshot, items: snapshot.items.map((item) => ({ ...item, title: '<script>bad()</script>[link]' })) });
  assert.ok(!report.includes('<script>'));
});

test('页面取消会终止执行中的 HTTP 搜索，同一服务拒绝重叠任务', { timeout: 5000 }, async (t) => {
  const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; listener.close(); await once(listener, 'close');
  const origin = `http://127.0.0.1:${port}`;
  const store = localStore(t);
  let entered; let stopped;
  const started = new Promise((resolve) => { entered = resolve; });
  const cancelled = new Promise((resolve) => { stopped = resolve; });
  const service = { async search(_criteria, { signal }) {
    entered();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    stopped(); signal.throwIfAborted();
  } };
  const server = createSearchHttpServer({ origin, service, store, configured: true });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const controller = new AbortController();
  const options = { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ criteria: { query: 'RAG' } }) };
  const running = fetch(`${origin}/api/search`, { ...options, signal: controller.signal });
  await started;
  assert.equal((await fetch(`${origin}/api/search`, options)).status, 409);
  controller.abort();
  await assert.rejects(running);
  await cancelled;
  assert.equal(store.get(), null);
});
