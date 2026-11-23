import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jsonSchema, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { AgentError } from '../errors.mjs';
import { buildTimeout, createAgent } from '../agent.mjs';

// 注入假 connect 与 mock 模型；config 用手写字面量，不依赖 config.mjs 是否已就绪。
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
let callSeq = 0;
const textStep = (text) => ({ content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] });
const toolStep = (name, input = {}) => ({ content: [{ type: 'tool-call', toolCallId: `call-${++callSeq}`, toolName: name, input: JSON.stringify(input) }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] });
// 按顺序返回脚本化结果，用完后重复最后一条。
const scripted = (...steps) => { let index = 0; return async () => steps[Math.min(index++, steps.length - 1)]; };
const mockModel = (...steps) => new MockLanguageModelV4({ doGenerate: scripted(...steps) });
const capture = (promise) => promise.then(() => null, (error) => error);
const buildPrompt = async () => '测试系统提示词';

const makeConfig = ({ limits = {}, model = {} } = {}) => ({
  demo: true, allowPersonalData: false,
  model: { providerName: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', modelName: 'test-model', apiKey: null, ready: true, ...model },
  limits: { maxSteps: 4, totalMs: 60000, stepMs: 30000, collectionSyncMs: 900000, ...limits },
  servers: [
    { id: 'search', enabled: true, reason: '演示模式', command: process.execPath, args: ['search.mjs'], env: {} },
    { id: 'collection', enabled: false, reason: '未同意个人数据发送给模型服务', command: null, args: [], env: {} },
  ],
});

function fakeConnect() {
  const state = { connects: 0, closes: 0, toolRuns: 0 };
  const search = tool({ description: '搜索知乎', inputSchema: jsonSchema({ type: 'object', properties: { query: { type: 'string' } } }), execute: async () => { state.toolRuns += 1; return { ok: true, items: [] }; } });
  const connect = async () => { state.connects += 1; return { tools: { zhihu_search: search }, enabled: ['search'], close: async () => { state.closes += 1; } }; };
  return { state, connect };
}

test('ask 返回 text、stepCount、toolCalls，连接惰性且只建立一次', async () => {
  const { state, connect } = fakeConnect();
  const model = mockModel(toolStep('zhihu_search', { query: '测试' }), textStep('回答一'), textStep('回答二'));
  const agent = createAgent(makeConfig(), { connect, model, buildPrompt });
  assert.deepEqual(agent.enabled, ['search']);
  assert.equal(state.connects, 0);
  const first = await agent.ask('问题一');
  assert.equal(first.text, '回答一');
  assert.equal(first.stepCount, 2);
  assert.deepEqual(first.toolCalls, [{ name: 'zhihu_search' }]);
  assert.equal(state.toolRuns, 1);
  const second = await agent.ask('问题二');
  assert.equal(second.text, '回答二');
  assert.equal(second.stepCount, 1);
  assert.deepEqual(second.toolCalls, []);
  assert.equal(state.connects, 1);
  assert.ok(JSON.stringify(model.doGenerateCalls[0].prompt).includes('测试系统提示词'));
  await agent.close();
  assert.equal(state.closes, 1);
});

test('history 不被修改且只含文本', async () => {
  const { connect } = fakeConnect();
  const history = Object.freeze([Object.freeze({ role: 'user', content: '旧问题' }), Object.freeze({ role: 'assistant', content: '旧回答' })]);
  const before = JSON.stringify(history);
  const model = mockModel(toolStep('zhihu_search', { query: '新' }), textStep('新回答'));
  const agent = createAgent(makeConfig(), { connect, model, buildPrompt });
  const result = await agent.ask('新问题', { history });
  assert.equal(JSON.stringify(history), before);
  assert.notEqual(result.history, history);
  assert.deepEqual(result.history, [...history, { role: 'user', content: '新问题' }, { role: 'assistant', content: '新回答' }]);
  for (const item of result.history) {
    assert.deepEqual(Object.keys(item).sort(), ['content', 'role']);
    assert.equal(typeof item.content, 'string');
  }
  assert.ok(JSON.stringify(model.doGenerateCalls[0].prompt).includes('旧问题'));
  await agent.close();
});

test('model 未就绪抛 MODEL_NOT_CONFIGURED，且不启动子进程', async () => {
  const { state, connect } = fakeConnect();
  const agent = createAgent(makeConfig({ model: { baseURL: null, modelName: null, ready: false } }), { connect, buildPrompt });
  const error = await capture(agent.ask('问题'));
  assert.ok(error instanceof AgentError);
  assert.equal(error.code, 'MODEL_NOT_CONFIGURED');
  assert.equal(error.exitCode, 3);
  assert.equal(state.connects, 0);
  await agent.close();
});

test('达到步数上限仍在请求工具时抛 STEP_LIMIT，不挂起', async () => {
  const { state, connect } = fakeConnect();
  const model = new MockLanguageModelV4({ doGenerate: async () => toolStep('zhihu_search', { query: '循环' }) });
  const agent = createAgent(makeConfig({ limits: { maxSteps: 3 } }), { connect, model, buildPrompt });
  const error = await capture(agent.ask('问题'));
  assert.ok(error instanceof AgentError);
  assert.equal(error.code, 'STEP_LIMIT');
  assert.equal(model.doGenerateCalls.length, 3);
  assert.equal(state.toolRuns, 3);
  await agent.close();
});

test('abort 后抛 CANCELLED（开始前已取消、运行中取消）', async () => {
  const { connect } = fakeConnect();
  const pre = createAgent(makeConfig(), { connect, model: mockModel(textStep('不会用到')), buildPrompt });
  const early = await capture(pre.ask('问题', { signal: AbortSignal.abort() }));
  assert.ok(early instanceof AgentError);
  assert.equal(early.code, 'CANCELLED');
  assert.equal(early.exitCode, 130);
  const controller = new AbortController();
  let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    calls += 1;
    if (calls === 1) return toolStep('zhihu_search', { query: '取消' });
    controller.abort();
    throw new DOMException('aborted', 'AbortError');
  } });
  const mid = createAgent(makeConfig(), { connect, model, buildPrompt });
  const late = await capture(mid.ask('问题', { signal: controller.signal }));
  assert.ok(late instanceof AgentError);
  assert.equal(late.code, 'CANCELLED');
  await pre.close();
  await mid.close();
});

test('close 幂等，关闭后再 ask 抛 CLOSED；从未连接过也能安全关闭', async () => {
  const { state, connect } = fakeConnect();
  const agent = createAgent(makeConfig(), { connect, model: mockModel(textStep('好')), buildPrompt });
  await agent.ask('问题');
  await Promise.all([agent.close(), agent.close()]);
  await agent.close();
  assert.equal(state.closes, 1);
  const error = await capture(agent.ask('再问'));
  assert.ok(error instanceof AgentError);
  assert.equal(error.code, 'CLOSED');
  const unused = fakeConnect();
  const idle = createAgent(makeConfig(), { connect: unused.connect, model: mockModel(textStep('好')), buildPrompt });
  await idle.close();
  assert.equal(unused.state.connects, 0);
  assert.equal((await capture(idle.ask('问'))).code, 'CLOSED');
});

test('连接失败时原样抛出 AgentError，下次 ask 可重试', async () => {
  const ok = fakeConnect();
  let attempts = 0;
  const connect = async (...args) => {
    attempts += 1;
    if (attempts === 1) throw new AgentError('NO_TOOLS_ENABLED', '没有可用的 MCP 服务器。', 3);
    return ok.connect(...args);
  };
  const agent = createAgent(makeConfig(), { connect, model: mockModel(textStep('重试成功')), buildPrompt });
  const error = await capture(agent.ask('问题'));
  assert.equal(error.code, 'NO_TOOLS_ENABLED');
  assert.equal(error.exitCode, 3);
  const result = await agent.ask('问题');
  assert.equal(result.text, '重试成功');
  assert.equal(attempts, 2);
  await agent.close();
});

test('buildTimeout：连上同步工具时放宽 stepMs 并设置按工具超时', () => {
  const limits = { totalMs: 600000, stepMs: 120000, collectionSyncMs: 900000 };
  assert.deepEqual(buildTimeout(limits, ['zhihu_search']), { totalMs: 600000, stepMs: 120000 });
  assert.deepEqual(buildTimeout(limits, ['zhihu_search', 'zhihu_collection_sync']), { totalMs: 600000, stepMs: 900000, tools: { zhihu_collection_syncMs: 900000 } });
  assert.equal(buildTimeout({ totalMs: 1000, stepMs: 5000000, collectionSyncMs: 900000 }, ['zhihu_collection_sync']).stepMs, 5000000);
});

// 端到端：本机起假 OpenAI 兼容 HTTP 服务，连真实的 information-search/mcp-server.mjs --demo。
// 只有 information-search/node_modules 已存在时才运行，否则跳过并说明原因。
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const searchModules = fileURLToPath(new URL('../../information-search/node_modules', import.meta.url));
const searchServer = fileURLToPath(new URL('../../information-search/mcp-server.mjs', import.meta.url));

test('端到端：fake HTTP 模型服务 + 真实搜索 MCP --demo', { skip: !existsSync(searchModules) ? 'information-search/node_modules 不存在，请先在该目录执行 npm ci' : false }, async (t) => {
  // 假 OpenAI 兼容 HTTP 服务：第一轮返回工具调用 zhihu_search，第二轮返回文本。
  let round = 0;
  const httpServer = createServer((req, res) => {
    round += 1;
    res.setHeader('Content-Type', 'application/json');
    if (round === 1) {
      res.end(JSON.stringify({ id: 'fake-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'zhihu_search', arguments: JSON.stringify({ query: '知乎测试' }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    } else {
      res.end(JSON.stringify({ id: 'fake-2', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '测试回答' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
    }
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  t.after(() => new Promise((ok) => httpServer.close(ok)));
  const e2eConfig = {
    demo: true, allowPersonalData: false,
    model: { providerName: 'openai-compatible', baseURL: `http://127.0.0.1:${port}/v1`, modelName: 'fake-model', apiKey: 'fake-key', ready: true },
    limits: { maxSteps: 4, totalMs: 30000, stepMs: 20000, collectionSyncMs: 900000 },
    servers: [{ id: 'search', enabled: true, reason: '演示模式', command: process.execPath, args: [searchServer, '--demo'], env: {} }],
  };
  const agent = createAgent(e2eConfig, { buildPrompt });
  t.after(() => agent.close());
  const result = await agent.ask('端到端测试问题');
  assert.equal(typeof result.text, 'string');
  assert.ok(result.text.length > 0);
  assert.equal(result.stepCount, 2);
  assert.deepEqual(result.toolCalls, [{ name: 'zhihu_search' }]);
  assert.deepEqual(agent.enabled, ['search']);
});
