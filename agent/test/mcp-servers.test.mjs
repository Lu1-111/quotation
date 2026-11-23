import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentError } from '../errors.mjs';
import { buildChildEnv, connectServers } from '../mcp-servers.mjs';

// 只用假传输与假客户端：不启动子进程，不依赖真实模型与知乎。
const SECRET = 'secret-token-xyz';
const capture = (promise) => promise.then(() => null, (error) => error);
const server = (id, over = {}) => ({ id, enabled: true, reason: '测试', command: process.execPath, args: [`${id}-mcp-server.mjs`], env: { DATA_SERVICE_AGENT_TOKEN: SECRET }, ...over });

function harness({ failOn, toolsFail, tools = {} } = {}) {
  const log = { transports: [], clients: [] };
  const createTransport = (options) => {
    const transport = { options, closed: 0, close: async () => { transport.closed += 1; } };
    log.transports.push(transport);
    return transport;
  };
  const createClient = async ({ transport }) => {
    const id = transport.options.args[0].replace('-mcp-server.mjs', '');
    if (failOn === id) throw new Error(`spawn failed with ${SECRET}`);
    const client = {
      id, closed: 0,
      close: async () => { client.closed += 1; },
      tools: async () => {
        if (toolsFail === id) throw new Error('tools/list failed');
        return tools[id] ?? { [`${id}_tool`]: { description: id } };
      },
    };
    log.clients.push(client);
    return client;
  };
  return { log, createTransport, createClient };
}

async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test('没有已启用的服务器时抛 NO_TOOLS_ENABLED', async () => {
  const h = harness();
  for (const servers of [[], [server('search', { enabled: false, reason: '未同意个人数据发送给模型服务' })]]) {
    const error = await capture(connectServers({ servers }, h));
    assert.ok(error instanceof AgentError);
    assert.equal(error.code, 'NO_TOOLS_ENABLED');
    assert.equal(error.exitCode, 3);
  }
  assert.equal(h.log.transports.length, 0);
});

test('连接成功：合并工具、返回 enabled，close 关闭全部客户端且幂等', async () => {
  const h = harness();
  const connection = await connectServers({ servers: [server('search'), server('collection'), server('off', { enabled: false })] }, h);
  assert.deepEqual(connection.enabled, ['search', 'collection']);
  assert.deepEqual(Object.keys(connection.tools).sort(), ['collection_tool', 'search_tool']);
  assert.equal(h.log.transports.length, 2);
  await Promise.all([connection.close(), connection.close()]);
  await connection.close();
  assert.deepEqual(h.log.clients.map((client) => client.closed), [1, 1]);
});

test('某个服务器启动失败：先关闭已启动的，再抛 MCP_START_FAILED，消息不含环境变量', async () => {
  const h = harness({ failOn: 'collection' });
  const error = await capture(connectServers({ servers: [server('search'), server('collection')] }, h));
  assert.ok(error instanceof AgentError);
  assert.equal(error.code, 'MCP_START_FAILED');
  assert.ok(error.message.includes('collection'));
  assert.ok(!error.message.includes(SECRET));
  assert.deepEqual(h.log.clients.map((client) => client.closed), [1]);
  assert.equal(h.log.transports[1].closed, 1);
});

test('tools() 失败或工具名冲突时同样关闭已启动的客户端', async () => {
  const failing = harness({ toolsFail: 'collection' });
  const first = await capture(connectServers({ servers: [server('search'), server('collection')] }, failing));
  assert.equal(first.code, 'MCP_START_FAILED');
  assert.deepEqual(failing.log.clients.map((client) => client.closed), [1, 1]);
  const clash = harness({ tools: { search: { dup: {} }, collection: { dup: {} } } });
  const second = await capture(connectServers({ servers: [server('search'), server('collection')] }, clash));
  assert.equal(second.code, 'MCP_START_FAILED');
  assert.deepEqual(clash.log.clients.map((client) => client.closed), [1, 1]);
});

test('已取消的 signal 不启动任何服务器', async () => {
  const h = harness();
  const error = await capture(connectServers({ servers: [server('search')] }, { ...h, signal: AbortSignal.abort() }));
  assert.equal(error.code, 'CANCELLED');
  assert.equal(h.log.transports.length, 0);
});

test('传给子进程的 env 不含 AGENT_API_KEY 与无关变量', async () => {
  await withEnv({ AGENT_API_KEY: 'sk-should-not-leak', UNRELATED_PARENT_VAR: 'parent-only' }, async () => {
    const h = harness();
    const leaky = server('search', { env: { ZHIHU_ACCESS_SECRET: 'access-1', AGENT_API_KEY: 'sk-should-not-leak' } });
    await connectServers({ servers: [leaky] }, h);
    const env = h.log.transports[0].options.env;
    const keys = Object.keys(env).map((key) => key.toUpperCase());
    assert.ok(!keys.includes('AGENT_API_KEY'));
    assert.ok(!keys.includes('UNRELATED_PARENT_VAR'));
    assert.ok(!Object.values(env).includes('sk-should-not-leak'));
    assert.equal(env.ZHIHU_ACCESS_SECRET, 'access-1');
    if (process.env.PATH) assert.ok(keys.includes('PATH'));
  });
});

test('buildChildEnv 只保留基础变量与 server.env，忽略非字符串与 AGENT_ 前缀', () => {
  const env = buildChildEnv({ DATA_SERVICE_URL: 'http://127.0.0.1:3005', AGENT_MODEL: 'x', BAD: 1 }, { PATH: '/bin', HOME: '/home/u', AGENT_API_KEY: 'k', OTHER: 'o', TMP: '/tmp' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/u', TMP: '/tmp', DATA_SERVICE_URL: 'http://127.0.0.1:3005' });
});
