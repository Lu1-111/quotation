// 命令行测试：全部注入假的 createAgent、loadConfig、describeConfig，不依赖真实模型、真实知乎，也不依赖 config.mjs 与 index.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { main } from '../cli.mjs';
import { AgentError } from '../errors.mjs';

const API_KEY = 'sk-test-api-key-0123456789';
const ACCESS_SECRET = 'access-secret-abcdef123456';
const USER_TOKEN = 'user-token-zyxwvu987654';
const SECRET_ENV = { AGENT_API_KEY: API_KEY, ZHIHU_ACCESS_SECRET: ACCESS_SECRET, DATA_SERVICE_AGENT_TOKEN: USER_TOKEN };
const SECRETS = [API_KEY, ACCESS_SECRET, USER_TOKEN];

// 内存输出流：只记录写入的文本。
function memoryStream() {
  const chunks = [];
  return { write(text) { chunks.push(String(text)); return true; }, text: () => chunks.join('') };
}

// 假配置：结构与 INTERFACES.md 一致，密钥故意放进 model.apiKey 与服务器 env，用来检验输出不泄露。
function fakeConfig(extra = {}) {
  return {
    demo: false,
    allowPersonalData: false,
    model: { providerName: 'openai-compatible', baseURL: 'http://127.0.0.1:1/v1', modelName: 'fake-model', apiKey: API_KEY, ready: true },
    limits: { maxSteps: 8, totalMs: 600000, stepMs: 120000, collectionSyncMs: 900000 },
    servers: [
      { id: 'search', enabled: true, reason: '已提供 ZHIHU_ACCESS_SECRET', command: 'node', args: ['search/mcp-server.mjs'], env: { ZHIHU_ACCESS_SECRET: ACCESS_SECRET } },
      { id: 'collection', enabled: false, reason: '未同意个人数据发送给模型服务', command: 'node', args: [], env: {} },
    ],
    ...extra,
  };
}

// 假的 describeConfig：apiKey 换成布尔值，env 只列变量名，和契约对脱敏对象的要求一致。
function fakeDescribe(config) {
  return {
    demo: config.demo,
    allowPersonalData: config.allowPersonalData,
    model: { providerName: config.model.providerName, baseURL: config.model.baseURL, modelName: config.model.modelName, apiKeyConfigured: Boolean(config.model.apiKey), ready: config.model.ready },
    limits: config.limits,
    servers: config.servers.map((server) => ({ id: server.id, enabled: server.enabled, reason: server.reason, command: server.command, args: server.args, envNames: Object.keys(server.env) })),
  };
}

// 假智能体：记录每次 ask 的问题与传入历史（复制一份，避免被后续修改影响断言）与 close 次数。
function fakeAgent(handler) {
  const agent = {
    asks: [],
    closed: 0,
    enabled: ['search'],
    async ask(question, options = {}) {
      agent.asks.push({ question, history: [...(options.history ?? [])], signal: options.signal });
      return handler(question, options, agent.asks.length);
    },
    async close() { agent.closed += 1; },
  };
  return agent;
}

// 默认回答：回显问题，并按契约返回追加了本轮问答的新历史数组。
const echoHandler = (question, { history = [] } = {}) => {
  const text = `回答：${question}`;
  return { text, stepCount: 2, toolCalls: [{ name: 'zhihu_search' }], history: [...history, { role: 'user', content: question }, { role: 'assistant', content: text }] };
};

// 运行 main 并收集退出码、两个输出流和各注入函数的调用记录。
async function run(args, { agent = fakeAgent(echoHandler), config = fakeConfig(), env = {}, stdin = Readable.from([]), signal, createAgentImpl } = {}) {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const calls = { loadConfig: [], createAgent: [], describeConfig: 0 };
  const code = await main(args, {
    env, stdout, stderr, stdin, signal,
    loadConfig: (input) => { calls.loadConfig.push(input); return config; },
    createAgent: createAgentImpl ?? (async (cfg) => { calls.createAgent.push(cfg); return agent; }),
    describeConfig: (cfg) => { calls.describeConfig += 1; return fakeDescribe(cfg); },
  });
  return { code, stdout: stdout.text(), stderr: stderr.text(), calls, agent };
}

// chat 的 stdin：每个元素一行。
const linesInput = (...items) => Readable.from([`${items.join('\n')}\n`]);

test('--help 返回 0，帮助只写 stdout，且不加载配置', async () => {
  const { code, stdout, stderr, calls } = await run(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /ask/);
  assert.equal(stderr, '');
  assert.equal(calls.loadConfig.length, 0);
});

// ===== ask =====
test('ask 正常：stdout 只有回答正文，退出码 0，并关闭智能体', async () => {
  const { code, stdout, stderr, agent, calls } = await run(['ask', '最近有什么热门话题']);
  assert.equal(code, 0);
  assert.equal(stdout, '回答：最近有什么热门话题\n');
  assert.equal(stderr, '');
  assert.equal(agent.asks.length, 1);
  assert.deepEqual(agent.asks[0].history, []);
  assert.equal(agent.closed, 1);
  assert.equal(calls.createAgent.length, 1);
  assert.deepEqual(calls.loadConfig[0].overrides, {});
});

test('ask 的多个词会用空格拼成同一个问题', async () => {
  const { code, agent } = await run(['ask', '你好', '世界']);
  assert.equal(code, 0);
  assert.equal(agent.asks[0].question, '你好 世界');
});

test('命令行选项转成 loadConfig 的 overrides，未给出的选项不写入', async () => {
  const { code, calls } = await run(['ask', '问题', '--demo', '--allow-personal-data', '--max-steps', '5', '--base-url', 'http://127.0.0.1:11434/v1', '--model', 'local-model']);
  assert.equal(code, 0);
  assert.deepEqual(calls.loadConfig[0].overrides, { demo: true, allowPersonalData: true, maxSteps: 5, baseURL: 'http://127.0.0.1:11434/v1', modelName: 'local-model' });
});

test('ask --json 输出 okEnvelope，data 只含 text、stepCount、toolCalls，工具调用只保留名称', async () => {
  const agent = fakeAgent((question) => ({ text: '答案', stepCount: 3, toolCalls: [{ name: 'zhihu_search', input: { query: question } }, { name: 'zhihu_read' }], history: [] }));
  const { code, stdout, stderr } = await run(['ask', '问题', '--json'], { agent });
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.equal(stdout.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(stdout), { schemaVersion: 1, ok: true, data: { text: '答案', stepCount: 3, toolCalls: [{ name: 'zhihu_search' }, { name: 'zhihu_read' }] }, error: null });
});

test('ask 失败：退出码取 AgentError.exitCode，错误只写 stderr，stdout 为空，仍关闭智能体', async () => {
  const agent = fakeAgent(() => { throw new AgentError('MODEL_NOT_CONFIGURED', '模型未配置。', 3); });
  const { code, stdout, stderr } = await run(['ask', '问题'], { agent });
  assert.equal(code, 3);
  assert.equal(stdout, '');
  assert.equal(stderr, '模型未配置。\n');
  assert.equal(agent.closed, 1);
});

test('ask --json 失败：errorEnvelope 写到 stderr，stdout 为空', async () => {
  const agent = fakeAgent(() => { throw new AgentError('STEP_LIMIT', '已达到步数上限。', 1); });
  const { code, stdout, stderr } = await run(['ask', '问题', '--json'], { agent });
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.deepEqual(JSON.parse(stderr), { schemaVersion: 1, ok: false, data: null, error: { code: 'STEP_LIMIT', message: '已达到步数上限。' } });
});

test('createAgent 抛 AgentError：退出码取自错误，没有智能体可关闭', async () => {
  const createAgentImpl = async () => { throw new AgentError('NO_TOOLS_ENABLED', '没有已启用的工具。', 3); };
  const { code, stdout, stderr } = await run(['ask', '问题'], { createAgentImpl });
  assert.equal(code, 3);
  assert.equal(stdout, '');
  assert.equal(stderr, '没有已启用的工具。\n');
});

test('非 AgentError 异常经 safeAgentError 转换，不回显原始消息', async () => {
  const agent = fakeAgent(() => { throw new Error(`上游返回了密钥 ${API_KEY}`); });
  const { code, stdout, stderr } = await run(['ask', '问题'], { agent });
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /智能体内部处理失败/);
  assert.ok(!stderr.includes(API_KEY));
});

test('模型接口错误转成 MODEL_ERROR，只带状态码，不带上游消息', async () => {
  const agent = fakeAgent(() => { throw Object.assign(new Error(`Authorization: Bearer ${API_KEY}`), { name: 'AI_APICallError', statusCode: 401 }); });
  const { code, stderr } = await run(['ask', '问题', '--json'], { agent });
  assert.equal(code, 1);
  const envelope = JSON.parse(stderr);
  assert.equal(envelope.error.code, 'MODEL_ERROR');
  assert.match(envelope.error.message, /HTTP 401/);
  assert.ok(!stderr.includes(API_KEY));
});

// ===== 参数错误 =====
const usageCases = [
  { name: '缺少问题', args: ['ask'], message: /缺少问题/ },
  { name: '问题只有空白', args: ['ask', '   '], message: /缺少问题/ },
  { name: '未知选项', args: ['ask', '问题', '--bogus'], message: /参数无效/ },
  { name: '选项缺少取值', args: ['ask', '问题', '--model'], message: /参数无效/ },
  { name: '密钥不接受命令行参数', args: ['ask', '问题', '--api-key', 'secret-value-123456'], message: /参数无效/ },
  { name: '未知命令', args: ['bogus'], message: /未知命令/ },
  { name: 'doctor 带多余参数', args: ['doctor', '多余'], message: /不接受额外参数/ },
  { name: 'chat 带多余参数', args: ['chat', '多余'], message: /不接受额外参数/ },
  { name: 'chat 不支持 --json', args: ['chat', '--json'], message: /不支持 --json/ },
  { name: '--max-steps 不是整数', args: ['ask', '问题', '--max-steps', 'abc'], message: /--max-steps/ },
  { name: '--max-steps 是小数', args: ['ask', '问题', '--max-steps', '1.5'], message: /--max-steps/ },
  { name: '--base-url 为空白', args: ['ask', '问题', '--base-url', ' '], message: /--base-url 不能为空/ },
];

for (const { name, args, message } of usageCases) {
  test(`参数错误：${name}，返回 2，错误只写 stderr，不加载配置也不创建智能体`, async () => {
    const { code, stdout, stderr, calls } = await run(args);
    assert.equal(code, 2);
    assert.equal(stdout, '');
    assert.match(stderr, message);
    assert.equal(calls.loadConfig.length, 0);
    assert.equal(calls.createAgent.length, 0);
  });
}

test('参数错误且带 --json：errorEnvelope 写到 stderr，stdout 为空', async () => {
  const { code, stdout, stderr } = await run(['ask', '--json']);
  assert.equal(code, 2);
  assert.equal(stdout, '');
  const envelope = JSON.parse(stderr);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.data, null);
  assert.equal(envelope.error.code, 'INVALID_ARGUMENTS');
  assert.match(envelope.error.message, /缺少问题/);
});

test('误传在命令行上的密钥值不会被回显到任何输出', async () => {
  const { stdout, stderr } = await run(['ask', '问题', '--api-key', 'secret-value-123456']);
  assert.ok(!stdout.includes('secret-value-123456'));
  assert.ok(!stderr.includes('secret-value-123456'));
});

test('loadConfig 抛 CONFIG_INVALID：退出码 2，错误只写 stderr，不创建智能体', async () => {
  const stdout = memoryStream();
  const stderr = memoryStream();
  let created = 0;
  const code = await main(['ask', '问题', '--max-steps', '99'], {
    env: {}, stdout, stderr, stdin: Readable.from([]),
    loadConfig: () => { throw new AgentError('CONFIG_INVALID', 'AGENT_MAX_STEPS 必须在 1 到 20 之间。', 2); },
    createAgent: async () => { created += 1; return fakeAgent(echoHandler); },
    describeConfig: fakeDescribe,
  });
  assert.equal(code, 2);
  assert.equal(stdout.text(), '');
  assert.equal(stderr.text(), 'AGENT_MAX_STEPS 必须在 1 到 20 之间。\n');
  assert.equal(created, 0);
});

// ===== doctor =====
test('doctor 不调用 createAgent，退出码取决于配置就绪状态', async () => {
  const { code, calls, agent } = await run(['doctor']);
  // 配置就绪（model.ready: true，search 已启用），所以退出码应为 0
  assert.equal(code, 0);
  assert.equal(calls.createAgent.length, 0);
  assert.equal(agent.closed, 0);
  assert.equal(calls.describeConfig, 1);
});

test('doctor 输出包含服务器启用状态与原因', async () => {
  const { stdout } = await run(['doctor']);
  assert.match(stdout, /search/);
  assert.match(stdout, /已启用/);
  assert.match(stdout, /collection/);
  assert.match(stdout, /未启用/);
  assert.match(stdout, /未同意个人数据/);
});

test('doctor 模型未就绪返回 3', async () => {
  const config = fakeConfig({ model: { providerName: 'openai-compatible', baseURL: null, modelName: null, apiKey: null, ready: false } });
  const { code, stdout } = await run(['doctor'], { config });
  assert.equal(code, 3);
  assert.match(stdout, /模型需要同时配置/);
});

test('doctor 没有已启用服务器返回 3', async () => {
  const config = fakeConfig({ servers: [{ id: 'search', enabled: false, reason: '未提供密钥', command: 'node', args: [], env: {} }] });
  const { code } = await run(['doctor'], { config });
  assert.equal(code, 3);
});

test('doctor --json 输出 okEnvelope，含 config、modelReady、enabledServers', async () => {
  const { code, stdout, stderr } = await run(['doctor', '--json']);
  assert.equal(code, 0);
  assert.equal(stderr, '');
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.ok, true);
  assert.equal(typeof envelope.data.config, 'object');
  assert.equal(envelope.data.modelReady, true);
  assert.deepEqual(envelope.data.enabledServers, ['search']);
});

test('doctor 输出的 describeConfig 对象里不含 apiKey 原值', async () => {
  const { stdout } = await run(['doctor', '--json']);
  assert.ok(!stdout.includes(API_KEY));
  const envelope = JSON.parse(stdout);
  assert.equal(typeof envelope.data.config.model.apiKeyConfigured, 'boolean');
  assert.ok(!('apiKey' in envelope.data.config.model));
});

test('doctor 输出里不含密钥值（人类可读格式）', async () => {
  const { stdout, stderr } = await run(['doctor'], { env: SECRET_ENV });
  for (const secret of SECRETS) {
    assert.ok(!stdout.includes(secret), `stdout 包含密钥 ${secret}`);
    assert.ok(!stderr.includes(secret), `stderr 包含密钥 ${secret}`);
  }
});

// ===== chat =====
test('chat 多轮：历史在内存累积并传入下一轮，空行忽略，输入 exit 退出，退出码 0', async () => {
  const agent = fakeAgent(echoHandler);
  const { code, stdout, agent: a } = await run(['chat'], { agent, stdin: linesInput('你好', '', '天气如何', 'exit') });
  assert.equal(code, 0);
  assert.equal(a.asks.length, 2);
  assert.equal(a.asks[0].question, '你好');
  assert.deepEqual(a.asks[0].history, []);
  assert.equal(a.asks[1].question, '天气如何');
  assert.equal(a.asks[1].history.length, 2);
  assert.deepEqual(a.asks[1].history[0], { role: 'user', content: '你好' });
  assert.deepEqual(a.asks[1].history[1], { role: 'assistant', content: '回答：你好' });
  assert.equal(stdout, '回答：你好\n回答：天气如何\n');
  assert.equal(a.closed, 1);
});

test('chat 遇到 EOF 正常退出，退出码 0', async () => {
  const agent = fakeAgent(echoHandler);
  const { code, agent: a } = await run(['chat'], { agent, stdin: linesInput('问题一', '问题二') });
  assert.equal(code, 0);
  assert.equal(a.asks.length, 2);
});

test('chat 第一行就是 exit：不提问，退出码 0', async () => {
  const agent = fakeAgent(echoHandler);
  const { code, stdout, agent: a } = await run(['chat'], { agent, stdin: linesInput('exit') });
  assert.equal(code, 0);
  assert.equal(a.asks.length, 0);
  assert.equal(stdout, '');
});

test('chat 某一轮失败：停止并返回该错误退出码，不再继续后续输入', async () => {
  const agent = fakeAgent((question, options, turn) => {
    if (turn === 2) throw new AgentError('MODEL_ERROR', '模型服务请求失败。', 1);
    return echoHandler(question, options);
  });
  const { code, stdout, stderr, agent: a } = await run(['chat'], { agent, stdin: linesInput('问题一', '问题二', '问题三') });
  assert.equal(code, 1);
  assert.equal(a.asks.length, 2);
  assert.equal(stdout, '回答：问题一\n');
  assert.equal(stderr, '模型服务请求失败。\n');
});

// ===== 取消与脱敏 =====
test('abort 信号在进入 main 前已触发：返回 130', async () => {
  const controller = new AbortController();
  controller.abort();
  const { code, stdout } = await run(['ask', '问题'], { signal: controller.signal });
  assert.equal(code, 130);
  assert.equal(stdout, '');
});

test('abort 信号在 ask 执行中触发：返回 130，stdout 为空，仍关闭智能体', async () => {
  const controller = new AbortController();
  const agent = fakeAgent(async () => {
    controller.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  });
  const { code, stdout, agent: a } = await run(['ask', '问题'], { agent, signal: controller.signal });
  assert.equal(code, 130);
  assert.equal(stdout, '');
  assert.equal(a.closed, 1);
});

test('stdout 与 stderr 不包含环境变量里的密钥', async () => {
  const agent = fakeAgent((question) => ({ text: `答案 for ${question}`, stepCount: 1, toolCalls: [], history: [] }));
  const { stdout, stderr } = await run(['ask', '问题', '--json'], { agent, env: SECRET_ENV });
  for (const secret of SECRETS) {
    assert.ok(!stdout.includes(secret), `stdout 包含密钥 ${secret}`);
    assert.ok(!stderr.includes(secret), `stderr 包含密钥 ${secret}`);
  }
});

test('智能体回答内容意外含有密钥：写出前脱敏', async () => {
  const agent = fakeAgent(() => ({ text: `这是答案，密钥是 ${API_KEY}，请勿外传。`, stepCount: 1, toolCalls: [], history: [] }));
  const { stdout } = await run(['ask', '问题'], { agent, env: SECRET_ENV });
  assert.ok(!stdout.includes(API_KEY));
  assert.match(stdout, /已隐藏/);
});

test('错误消息意外含有密钥：写出前脱敏', async () => {
  const agent = fakeAgent(() => { throw new AgentError('INTERNAL_ERROR', `内部错误：${ACCESS_SECRET} 无效。`, 1); });
  const { stderr } = await run(['ask', '问题'], { agent, env: SECRET_ENV });
  assert.ok(!stderr.includes(ACCESS_SECRET));
  assert.match(stderr, /已隐藏/);
});
