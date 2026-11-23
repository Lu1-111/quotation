import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError } from '../errors.mjs';
import { describeConfig, loadConfig } from '../config.mjs';

const AGENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_KEY = 'sk-model-key-AAAA1111';
const ACCESS_SECRET = 'access-secret-BBBB2222';
const USER_TOKEN = 'user-token-CCCC3333';
const SEARCH_MAIN = path.join(AGENT_DIR, '..', 'information-search', 'mcp-server.mjs');

const load = (env = {}, overrides = {}) => loadConfig({ env, overrides });
const server = (config, id) => config.servers.find((item) => item.id === id);
const isConfigInvalid = (error) => error instanceof AgentError && error.code === 'CONFIG_INVALID' && error.exitCode === 2;

test('空环境下使用默认值，且整个对象被冻结', () => {
  const config = load();
  assert.equal(config.demo, false);
  assert.equal(config.allowPersonalData, false);
  assert.deepEqual(config.model, { providerName: 'openai-compatible', baseURL: null, modelName: null, apiKey: null, ready: false });
  assert.deepEqual(config.limits, { maxSteps: 8, totalMs: 600000, stepMs: 120000, collectionSyncMs: 900000 });
  assert.equal(Object.isFrozen(config) && Object.isFrozen(config.model) && Object.isFrozen(config.servers), true);
  assert.equal(Object.isFrozen(server(config, 'search')) && Object.isFrozen(server(config, 'search').env), true);
  assert.throws(() => { config.demo = true; }, TypeError);
});

test('采集工具默认不启用：缺少同意或令牌都不启用', () => {
  const noConsent = server(load({ DATA_SERVICE_AGENT_TOKEN: USER_TOKEN }), 'collection');
  assert.equal(noConsent.enabled, false);
  assert.deepEqual(noConsent.env, {});
  assert.match(noConsent.reason, /未同意/);
  const noToken = server(load({ AGENT_ALLOW_PERSONAL_DATA: 'true' }), 'collection');
  assert.equal(noToken.enabled, false);
  assert.deepEqual(noToken.env, {});
  assert.match(noToken.reason, /DATA_SERVICE_AGENT_TOKEN/);
});

test('同时同意个人数据并提供用户令牌才启用采集', () => {
  const env = { AGENT_ALLOW_PERSONAL_DATA: 'TRUE', DATA_SERVICE_AGENT_TOKEN: USER_TOKEN };
  const viaOverride = load({ DATA_SERVICE_AGENT_TOKEN: USER_TOKEN }, { allowPersonalData: true });
  for (const config of [load(env), viaOverride]) {
    const collection = server(config, 'collection');
    assert.equal(config.allowPersonalData, true);
    assert.equal(collection.enabled, true);
    assert.equal(collection.command, process.execPath);
    assert.deepEqual(collection.args, [path.join(AGENT_DIR, '..', 'data-collection-service', 'mcp-server.mjs')]);
    assert.deepEqual(collection.env, { DATA_SERVICE_URL: 'http://127.0.0.1:3005', DATA_SERVICE_AGENT_TOKEN: USER_TOKEN });
  }
  assert.equal(server(load(env, { allowPersonalData: false }), 'collection').enabled, false);
  assert.equal(server(load({ ...env, DATA_SERVICE_URL: 'http://127.0.0.1:4000' }), 'collection').env.DATA_SERVICE_URL, 'http://127.0.0.1:4000');
});

test('搜索在有访问密钥或演示模式时启用', () => {
  const off = server(load(), 'search');
  assert.equal(off.enabled, false);
  assert.deepEqual(off.env, {});
  assert.equal(server(load({ ZHIHU_ACCESS_SECRET: '   ' }), 'search').enabled, false);
  const secret = server(load({ ZHIHU_ACCESS_SECRET: ACCESS_SECRET, DATA_FILE: 'data/tags.json' }), 'search');
  assert.equal(secret.enabled, true);
  assert.deepEqual(secret.args, [SEARCH_MAIN]);
  assert.deepEqual(secret.env, { ZHIHU_ACCESS_SECRET: ACCESS_SECRET, DATA_FILE: 'data/tags.json' });
  const demoConfig = load({}, { demo: true });
  const demo = server(demoConfig, 'search');
  assert.equal(demo.enabled, true);
  assert.deepEqual(demo.args, [SEARCH_MAIN, '--demo']);
  assert.deepEqual(demo.env, {});
  assert.equal(server(demoConfig, 'collection').args.includes('--demo'), false);
});

test('子进程 env 只含契约变量，绝不含模型密钥', () => {
  const config = load({
    AGENT_API_KEY: MODEL_KEY, AGENT_BASE_URL: 'https://llm.example/v1', AGENT_MODEL: 'm', AGENT_ALLOW_PERSONAL_DATA: 'true',
    ZHIHU_ACCESS_SECRET: ACCESS_SECRET, DATA_SERVICE_AGENT_TOKEN: USER_TOKEN, UNRELATED_VAR: 'x',
  });
  const search = server(config, 'search');
  const collection = server(config, 'collection');
  assert.equal(search.enabled && collection.enabled, true);
  assert.deepEqual(Object.keys(search.env), ['ZHIHU_ACCESS_SECRET']);
  assert.deepEqual(Object.keys(collection.env), ['DATA_SERVICE_URL', 'DATA_SERVICE_AGENT_TOKEN']);
  assert.equal(JSON.stringify(config.servers).includes(MODEL_KEY), false);
});

test('搜索与采集目录相对 agent/ 解析，不随当前工作目录变化', () => {
  const original = process.cwd();
  process.chdir(os.tmpdir());
  try {
    const config = load({ AGENT_COLLECTION_DIR: '../custom-collection', ZHIHU_ACCESS_SECRET: ACCESS_SECRET });
    assert.deepEqual(server(config, 'search').args, [SEARCH_MAIN]);
    assert.deepEqual(server(config, 'collection').args, [path.join(AGENT_DIR, '..', 'custom-collection', 'mcp-server.mjs')]);
    const absolute = path.join(os.tmpdir(), 'abs-search');
    assert.deepEqual(server(load({ AGENT_SEARCH_DIR: absolute, ZHIHU_ACCESS_SECRET: ACCESS_SECRET }), 'search').args, [path.join(absolute, 'mcp-server.mjs')]);
  } finally {
    process.chdir(original);
  }
});

test('模型配置：环境变量与覆盖项，ready 只看地址与模型名', () => {
  const env = { AGENT_BASE_URL: 'https://llm.example/v1', AGENT_MODEL: 'model-a', AGENT_API_KEY: MODEL_KEY };
  assert.deepEqual(load(env).model, { providerName: 'openai-compatible', baseURL: 'https://llm.example/v1', modelName: 'model-a', apiKey: MODEL_KEY, ready: true });
  const overridden = load(env, { baseURL: 'http://127.0.0.1:11434/v1', modelName: 'model-b' }).model;
  assert.equal(overridden.baseURL, 'http://127.0.0.1:11434/v1');
  assert.equal(overridden.modelName, 'model-b');
  const partial = load({ AGENT_BASE_URL: 'http://127.0.0.1:11434/v1' }).model;
  assert.equal(partial.ready, false);
  assert.equal(partial.apiKey, null);
});

test('非法数值抛 CONFIG_INVALID（退出码 2）', () => {
  for (const value of ['0', '21', '-1', '1.5', 'abc', '1e1']) {
    assert.throws(() => load({ AGENT_MAX_STEPS: value }), (error) => isConfigInvalid(error) && /AGENT_MAX_STEPS/.test(error.message), value);
  }
  for (const name of ['AGENT_TOTAL_TIMEOUT_MS', 'AGENT_STEP_TIMEOUT_MS']) {
    for (const value of ['0', '-5', '1.5', 'abc', '10s']) {
      assert.throws(() => load({ [name]: value }), (error) => isConfigInvalid(error) && error.message.includes(name), `${name}=${value}`);
    }
  }
  assert.throws(() => load({}, { maxSteps: 0 }), isConfigInvalid);
  assert.throws(() => load({}, { maxSteps: 99 }), isConfigInvalid);
});

test('合法边界值被接受，覆盖项优先于环境变量', () => {
  assert.equal(load({ AGENT_MAX_STEPS: '1' }).limits.maxSteps, 1);
  assert.equal(load({ AGENT_MAX_STEPS: '20' }).limits.maxSteps, 20);
  assert.equal(load({ AGENT_MAX_STEPS: '5' }, { maxSteps: '12' }).limits.maxSteps, 12);
  assert.equal(load({ AGENT_MAX_STEPS: '' }).limits.maxSteps, 8);
  const limits = load({ AGENT_TOTAL_TIMEOUT_MS: '1000', AGENT_STEP_TIMEOUT_MS: '500' }).limits;
  assert.deepEqual(limits, { maxSteps: 8, totalMs: 1000, stepMs: 500, collectionSyncMs: 900000 });
});

test('describeConfig 可安全打印：不含密钥与令牌的值', () => {
  const config = load({
    AGENT_BASE_URL: 'https://user:pw-DDDD4444@llm.example/v1?key=EEEE5555', AGENT_MODEL: 'm', AGENT_API_KEY: MODEL_KEY,
    AGENT_ALLOW_PERSONAL_DATA: 'true', ZHIHU_ACCESS_SECRET: ACCESS_SECRET, DATA_SERVICE_AGENT_TOKEN: USER_TOKEN,
  });
  const described = describeConfig(config);
  const printed = JSON.stringify(described);
  for (const secret of [MODEL_KEY, ACCESS_SECRET, USER_TOKEN, 'pw-DDDD4444', 'EEEE5555']) {
    assert.equal(printed.includes(secret), false, secret);
  }
  assert.equal(Object.hasOwn(described.model, 'apiKey'), false);
  assert.equal(described.model.apiKeyConfigured, true);
  assert.equal(described.model.baseURL, 'https://llm.example/v1');
  assert.deepEqual(server(described, 'collection').env, ['DATA_SERVICE_URL', 'DATA_SERVICE_AGENT_TOKEN']);
  assert.deepEqual(server(described, 'search').env, ['ZHIHU_ACCESS_SECRET']);
  assert.equal(describeConfig(load()).model.apiKeyConfigured, false);
});
