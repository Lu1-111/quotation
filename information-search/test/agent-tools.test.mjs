import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createAgentTools, createLocalAgentTools, getToolDefinitions } from '../agent-tools.mjs';
import { createInformationSearch } from '../search.mjs';
import { createSearchStore } from '../store.mjs';
import { normalizeItem, SearchError } from '../official-client.mjs';
import { toolSchemas } from '../tool-schemas.mjs';

function localData(t) {
  const directory = mkdtempSync(join(tmpdir(), 'quotation-agent-tools-'));
  const filename = join(directory, 'search.sqlite');
  const fixture = { filename, dispose: async () => {} };
  t.after(async () => { await fixture.dispose(); rmSync(filename, { force: true }); rmdirSync(directory); });
  return fixture;
}

function setup(t, { client, timeoutMs } = {}) {
  const fixture = localData(t);
  const store = createSearchStore(fixture.filename);
  const service = createInformationSearch({ client, store, queryDelayMs: 0 });
  const tools = createAgentTools({ service, store, configured: true, timeoutMs });
  fixture.dispose = async () => { await tools.close(); store.close(); };
  return { store, tools };
}

test('工具定义可直接发现，参数拒绝未知字段，状态不返回密钥或文件路径', async (t) => {
  const fixture = localData(t);
  const tools = createLocalAgentTools({ dataFile: fixture.filename, accessSecret: 'private-agent-fixture' });
  fixture.dispose = () => tools.close();
  const definitions = getToolDefinitions();
  assert.deepEqual(definitions.map((tool) => tool.name), ['zhihu_search', 'zhihu_get_search_result', 'zhihu_search_status']);
  assert.equal(definitions[0].inputSchema.additionalProperties, false);
  assert.equal(definitions[0].inputSchema.properties.maxQueries.default, 2);
  const status = await tools.call('zhihu_search_status', '{}');
  assert.equal(status.data.configured, true);
  assert.equal(status.data.capabilities.fullText, false);
  assert.ok(!JSON.stringify(status).includes('private-agent-fixture'));
  assert.ok(!JSON.stringify(status).includes('search.sqlite'));
  for (const args of [{ tags: '人工智能' }, { query: 'RAG', topicId: 'native' }, { query: 'RAG', limit: 21 }, '{bad']) {
    assert.equal((await tools.call('zhihu_search', args)).error.code, 'INVALID_ARGUMENTS');
  }
  assert.equal((await tools.call('constructor')).error.code, 'UNKNOWN_TOOL');
  assert.equal((await tools.call('zhihu_get_search_result', {})).error.code, 'INVALID_ARGUMENTS');
  assert.equal((await tools.call('zhihu_get_search_result', { requestId: '00000000-0000-4000-8000-000000000000' })).error.code, 'NOT_FOUND');
  const emptyFixture = localData(t);
  const missing = createLocalAgentTools({ dataFile: emptyFixture.filename, accessSecret: '' });
  emptyFixture.dispose = () => missing.close();
  assert.equal((await missing.call('zhihu_search', { query: 'RAG' })).error.code, 'NOT_CONFIGURED');
});

test('工具裁剪模型上下文，分页只读取保存的快照，原始摘要与缓存保持完整', async (t) => {
  let calls = 0;
  const client = { async search() {
    calls += 1;
    return { hasMore: false, items: Array.from({ length: 10 }, (_, index) => normalizeItem({
      ContentID: String(index), ContentType: 'Article', Title: `RAG 评测 ${index}`, ContentText: '人工智能' + '😀'.repeat(200),
      Url: `https://zhuanlan.zhihu.com/p/${index}?utm_source=fixture`, RankingScore: 10 - index,
    })) };
  } };
  const { tools, store } = setup(t, { client });
  const first = await tools.call('zhihu_search', JSON.stringify({ query: 'RAG', limit: 3, excerptMaxChars: 100 }));
  assert.equal(first.ok, true);
  assert.equal(first.data.page.total, 10);
  assert.equal(first.data.page.nextOffset, 3);
  assert.equal([...first.data.items[0].excerpt].length, 100);
  assert.equal(first.data.items[0].excerptTruncated, true);
  assert.equal(first.data.items[0].fullTextAvailable, false);
  assert.match(first.data.items[0].url, /utm_source=fixture/);
  assert.equal([...store.get(first.data.requestId).items[0].excerpt].length, 204);
  const next = await tools.call('zhihu_get_search_result', { requestId: first.data.requestId, offset: 3, limit: 20 });
  assert.equal(next.data.items.length, 7);
  assert.equal(next.data.page.hasMore, false);
  assert.equal(calls, 1);
  const repeat = await tools.call('zhihu_search', { query: 'RAG' });
  assert.equal(repeat.data.stats.apiCalls, 0);
  assert.equal(calls, 1);
  for (const response of [first, next, repeat]) assert.equal(toolSchemas.zhihu_search.output.safeParse(response).success, true);
});

test('工具将上游故障转为稳定错误，不把原始异常或凭证回传给模型', async (t) => {
  let fault;
  const { tools } = setup(t, { client: { async search() { throw fault; } } });
  for (const [code, retryable] of [['UPSTREAM_AUTH', false], ['RATE_LIMITED', false], ['NETWORK_ERROR', true]]) {
    fault = new SearchError('private-agent-fixture', 502, code);
    const result = await tools.call('zhihu_search', { query: 'RAG' });
    assert.equal(result.error.code, code);
    assert.equal(result.error.retryable, retryable);
    assert.ok(!JSON.stringify(result).includes('private-agent-fixture'));
  }
  fault = new Error('private-agent-fixture');
  assert.equal((await tools.call('zhihu_search', { query: 'RAG' })).error.code, 'INTERNAL_ERROR');
});

test('Agent 搜索可取消、超时和关闭，忙碌时状态仍可读取，不保存未完成结果', async (t) => {
  let entered;
  let started = new Promise((resolve) => { entered = resolve; });
  const client = { async search(_query, _limit, { signal }) { entered(); await pause(1000, undefined, { signal }); return { hasMore: false, items: [] }; } };
  const { tools, store } = setup(t, { client });
  const controller = new AbortController();
  const pending = tools.call('zhihu_search', { query: 'RAG' }, { signal: controller.signal });
  await started;
  assert.equal((await tools.call('zhihu_search_status')).data.busy, true);
  assert.equal((await tools.call('zhihu_search', { query: 'RAG' })).error.code, 'BUSY');
  controller.abort(new Error('不得回传此原因'));
  assert.equal((await pending).error.code, 'CANCELLED');
  assert.equal(store.get(), null);
  const timed = setup(t, { client, timeoutMs: 25 });
  assert.equal((await timed.tools.call('zhihu_search', { query: 'RAG' })).error.code, 'TIMEOUT');
  assert.equal(timed.store.get(), null);
  started = new Promise((resolve) => { entered = resolve; });
  const running = tools.call('zhihu_search', { query: 'RAG' });
  await started;
  await tools.close();
  assert.equal((await running).error.code, 'CANCELLED');
  assert.equal((await tools.call('zhihu_search_status')).error.code, 'CLOSED');
});

test('标准 MCP 客户端可无网页启动进程、发现工具、搜索并读取结果', { timeout: 15000 }, async (t) => {
  const fixture = localData(t);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../mcp-server.mjs', import.meta.url)), '--demo'],
    env: { ...process.env, DATA_FILE: fixture.filename, ZHIHU_ACCESS_SECRET: '' }, stderr: 'pipe' });
  const client = new Client({ name: 'quotation-integration-test', version: '1.0.0' });
  fixture.dispose = () => client.close();
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.equal(catalog.tools.length, 3);
  assert.ok(catalog.tools.every((tool) => tool.outputSchema.type === 'object'));
  const status = await client.callTool({ name: 'zhihu_search_status', arguments: {} });
  assert.equal(status.structuredContent.data.demo, true);
  const searched = await client.callTool({ name: 'zhihu_search', arguments: { keywords: ['RAG'], tags: ['人工智能'], maxQueries: 1 } });
  assert.equal(searched.isError, false);
  assert.equal(searched.structuredContent.data.items.length, 1);
  assert.deepEqual(JSON.parse(searched.content[0].text), searched.structuredContent);
  const saved = await client.callTool({ name: 'zhihu_get_search_result', arguments: { requestId: searched.structuredContent.data.requestId } });
  assert.equal(saved.structuredContent.data.requestId, searched.structuredContent.data.requestId);
  const invalid = await client.callTool({ name: 'zhihu_search', arguments: { query: 'RAG', accessSecret: 'must-not-accept' } });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, 'INVALID_ARGUMENTS');
});
