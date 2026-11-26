// 图形界面的 HTTP 层测试：全部用注入的假实现，不启动 MCP 子进程、不连接模型服务。
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createWebServer, sanitizeSettings, buildOverrides, buildEnv, persistedPortion } from '../web.mjs';

const MODEL = { providerName: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', modelName: 'fake-model', apiKey: 'sk-secret-value-123456', ready: true };
const LIMITS = { maxSteps: 8, totalMs: 60000, stepMs: 30000, collectionSyncMs: 900000 };

function fakeConfig(overrides = {}) {
  return {
    demo: false,
    allowPersonalData: true,
    model: MODEL,
    limits: LIMITS,
    servers: [
      { id: 'search', enabled: true, reason: '已启用：已配置 ZHIHU_ACCESS_SECRET。', command: 'node', args: [], env: {} },
      { id: 'collection', enabled: false, reason: '未启用：缺少 DATA_SERVICE_AGENT_TOKEN，请在采集界面创建只读入口。', command: 'node', args: [], env: {} },
    ],
    ...overrides,
  };
}

function fakeDescribe(config) {
  return {
    demo: config.demo,
    allowPersonalData: config.allowPersonalData,
    model: { providerName: MODEL.providerName, baseURL: MODEL.baseURL, modelName: config.model.modelName, apiKeyConfigured: Boolean(config.model.apiKey) },
    limits: config.limits,
    servers: config.servers.map((server) => ({ ...server, env: Object.keys(server.env) })),
  };
}

async function start(options = {}) {
  const calls = { asked: [], created: 0, closed: 0, persisted: [] };
  const app = createWebServer({
    env: {},
    settings: { modelName: 'fake-model', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-secret-value-123456' },
    loadConfig: () => fakeConfig(),
    describeConfig: fakeDescribe,
    createAgent: async () => {
      calls.created += 1;
      return {
        async ask(question, { history = [] } = {}) {
          calls.asked.push({ question, historyLength: history.length });
          if (options.ask) return options.ask(question, { history });
          return {
            text: `回答：${question}`,
            stepCount: 2,
            toolCalls: [{ name: 'zhihu_search' }],
            history: [...history, { role: 'user', content: question }, { role: 'assistant', content: `回答：${question}` }],
          };
        },
        async close() { calls.closed += 1; },
        enabled: ['search'],
      };
    },
    connectServers: async () => ({
      enabled: ['search'],
      tools: { zhihu_search: { description: '官方搜索' }, zhihu_search_status: { description: '状态' } },
      close: async () => {},
    }),
    persist: async (portion) => { calls.persisted.push(portion); },
    ...options.createWebServer,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, calls };
}

const json = async (response) => ({ status: response.status, body: await response.json() });
const post = (base, path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe('设置规范化', () => {
  it('只保留已知字段，丢弃未知键与错误类型', () => {
    const settings = sanitizeSettings({ baseURL: ' http://x/v1 ', unknown: 'x', apiKey: 123, demo: 'true', maxSteps: '07' });
    assert.equal(settings.baseURL, 'http://x/v1');
    assert.equal(settings.demo, true);
    assert.equal(settings.apiKey, '');
    assert.equal(settings.maxSteps, '07');
    assert.equal(Object.hasOwn(settings, 'unknown'), false);
  });

  it('步数超出两位数形态时回落为空（交给 config 校验）', () => {
    assert.equal(sanitizeSettings({ maxSteps: '999' }).maxSteps, '');
    assert.equal(sanitizeSettings({ maxSteps: 'abc' }).maxSteps, '');
  });

  it('落盘内容不含密钥，覆盖项只含非空字段', () => {
    const settings = sanitizeSettings({ baseURL: 'http://x/v1', modelName: 'm', apiKey: 'k', agentToken: 't', searchSecret: 's', demo: true });
    const portion = persistedPortion(settings);
    assert.deepEqual(Object.keys(portion).sort(), ['allowPersonalData', 'baseURL', 'demo', 'maxSteps', 'modelName', 'serviceURL']);
    assert.equal(portion.apiKey, undefined);
    assert.equal(portion.agentToken, undefined);
    assert.equal(portion.searchSecret, undefined);
    assert.deepEqual(buildOverrides(settings), { demo: true, baseURL: 'http://x/v1', modelName: 'm' });
    const env = buildEnv({ EXISTING: '1' }, settings);
    assert.equal(env.EXISTING, '1');
    assert.equal(env.AGENT_API_KEY, 'k');
    assert.equal(env.ZHIHU_ACCESS_SECRET, 's');
    assert.equal(env.DATA_SERVICE_AGENT_TOKEN, 't');
  });

  it('空白设置不产生覆盖项，也不污染环境', () => {
    assert.deepEqual(buildOverrides(sanitizeSettings({})), {});
    const env = buildEnv({ AGENT_API_KEY: 'from-env' }, sanitizeSettings({}));
    assert.equal(env.AGENT_API_KEY, 'from-env');
  });
});

describe('HTTP 接口', () => {
  let ctx;
  before(async () => { ctx = await start(); });
  after(async () => { await ctx.app.close(); });

  it('首页返回页面本身，且带三个页签', async () => {
    const response = await fetch(`${ctx.base}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /本机工作台/);
    assert.match(html, /\/api\/ask/);
    for (const page of ['chat', 'interaction', 'collection', 'delivery']) assert.match(html, new RegExp(`data-page="${page}"`));

    const standalone = await fetch(`${ctx.base}/interaction`);
    assert.equal(standalone.status, 200);
    assert.match(await standalone.text(), /id="page-interaction"/);
  });

  it('状态接口给出模型与服务器，且不含密钥原文', async () => {
    const { status, body } = await json(await fetch(`${ctx.base}/api/status`));
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.modelReady, true);
    assert.equal(body.data.settings.apiKeyConfigured, true);
    assert.equal(body.data.settings.apiKey, undefined);
    assert.equal(body.data.settings.agentToken, undefined);
    assert.deepEqual(body.data.servers.map((server) => server.id), ['search', 'collection']);
    assert.doesNotMatch(JSON.stringify(body), /sk-secret-value/);
  });

  it('提问返回文本、工具名与耗时，并累积多轮历史', async () => {
    const first = await json(await post(ctx.base, '/api/ask', { question: '最近在看什么' }));
    assert.equal(first.status, 200);
    assert.equal(first.body.data.text, '回答：最近在看什么');
    assert.deepEqual(first.body.data.toolCalls, [{ name: 'zhihu_search' }]);
    assert.equal(first.body.data.historyLength, 2);
    assert.equal(typeof first.body.data.elapsedMs, 'number');

    const second = await json(await post(ctx.base, '/api/ask', { question: '再说详细点' }));
    assert.equal(second.body.data.historyLength, 4);
    assert.equal(ctx.calls.asked.at(-1).historyLength, 2, '第二次提问应带上两轮历史');
  });

  it('空问题返回 400 且不创建智能体调用', async () => {
    const asked = ctx.calls.asked.length;
    const { status, body } = await json(await post(ctx.base, '/api/ask', { question: '   ' }));
    assert.equal(status, 400);
    assert.equal(body.error.code, 'INVALID_ARGUMENTS');
    assert.equal(ctx.calls.asked.length, asked);
  });

  it('非法 JSON 返回 400', async () => {
    const response = await fetch(`${ctx.base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_ARGUMENTS');
  });

  it('跨站来源的 POST 被拒绝', async () => {
    const { status, body } = await json(await post(ctx.base, '/api/ask', { question: 'x' }, { origin: 'http://evil.example' }));
    assert.equal(status, 403);
    assert.equal(body.error.code, 'ORIGIN_DENIED');
  });

  it('连接测试列出工具名', async () => {
    const { status, body } = await json(await post(ctx.base, '/api/probe'));
    assert.equal(status, 200);
    assert.deepEqual(body.data.enabled, ['search']);
    assert.deepEqual(body.data.tools.map((tool) => tool.name), ['zhihu_search', 'zhihu_search_status']);
  });

  it('保存设置只落盘非密钥字段并清空对话', async () => {
    const { status, body } = await json(await post(ctx.base, '/api/settings', {
      settings: { baseURL: 'http://127.0.0.1:9/v1', modelName: 'fake-model', apiKey: 'sk-other-999999', demo: true },
    }));
    assert.equal(status, 200);
    assert.equal(body.data.settings.apiKeyConfigured, true);
    assert.equal(body.data.historyLength, 0);
    const portion = ctx.calls.persisted.at(-1);
    assert.equal(portion.apiKey, undefined);
    assert.equal(portion.demo, true);
  });

  it('接口地址不是完整 URL 时拒绝保存', async () => {
    const ctx = await start();
    try {
      const bad = await json(await post(ctx.base, '/api/settings', {
        settings: { baseURL: 'api.deepseek.com/v1', modelName: 'deepseek-flash' },
      }));
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.code, 'INVALID_ARGUMENTS');
      assert.match(bad.body.error.message, /完整 URL/);

      const ok = await json(await post(ctx.base, '/api/settings', {
        settings: { baseURL: 'https://api.deepseek.com/v1', modelName: 'deepseek-flash' },
      }));
      assert.equal(ok.status, 200);
    } finally {
      await ctx.app.close();
    }
  });

  it('密钥字段填成网址时给出"填反了"的提示', async () => {
    const ctx = await start();
    try {
      const swapped = await json(await post(ctx.base, '/api/settings', {
        settings: { baseURL: 'https://api.deepseek.com/v1', modelName: 'x', apiKey: 'https://api.deepseek.com/v1' },
      }));
      assert.equal(swapped.status, 400);
      assert.equal(swapped.body.error.code, 'INVALID_ARGUMENTS');
      assert.match(swapped.body.error.message, /填反/);
    } finally {
      await ctx.app.close();
    }
  });

  it('沿用旧密钥时不应因为历史值而卡住保存', async () => {
    // 模拟"校验上线前就存进了一个像网址的密钥"，此时只改其它字段仍应能保存。
    const ctx = await start({
      createWebServer: {
        settings: { modelName: 'fake-model', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'https://legacy-bogus-key' },
      },
    });
    try {
      const saved = await json(await post(ctx.base, '/api/settings', {
        settings: { baseURL: 'http://127.0.0.1:9/v1', modelName: 'fake-model' },
      }));
      assert.equal(saved.status, 200);
    } finally {
      await ctx.app.close();
    }
  });

  it('未知路径返回 404', async () => {
    const { status, body } = await json(await fetch(`${ctx.base}/api/nope`));
    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  it('保存设置时不提交的密钥沿用旧值，显式空串才清除', async () => {
    const ctx2 = await start();
    try {
      const kept = await json(await post(ctx2.base, '/api/settings', {
        settings: { baseURL: 'http://127.0.0.1:9/v1', modelName: 'fake-model', demo: false },
      }));
      assert.equal(kept.body.data.settings.apiKeyConfigured, true, '未提交 apiKey 时应保留原值');

      const cleared = await json(await post(ctx2.base, '/api/settings', {
        settings: { baseURL: 'http://127.0.0.1:9/v1', modelName: 'fake-model', apiKey: '' },
      }));
      assert.equal(cleared.body.data.settings.apiKeyConfigured, false, '显式提交空串应清除');
    } finally {
      await ctx2.app.close();
    }
  });
});

describe('回答与错误的脱敏', () => {
  it('回答里出现密钥时被替换', async () => {
    const ctx = await start({
      createWebServer: {
        createAgent: async () => ({
          async ask() { return { text: '密钥是 sk-secret-value-123456 对吧', stepCount: 1, toolCalls: [], history: [] }; },
          async close() {},
        }),
      },
    });
    try {
      const { body } = await json(await post(ctx.base, '/api/ask', { question: '把密钥念一遍' }));
      assert.doesNotMatch(JSON.stringify(body), /sk-secret-value/);
      assert.match(body.data.text, /\[已隐藏\]/);
    } finally {
      await ctx.app.close();
    }
  });

  it('智能体报错映射为对应状态码，并带上稳定错误码', async () => {
    const { AgentError } = await import('../errors.mjs');
    const ctx = await start({
      createWebServer: {
        createAgent: async () => ({
          async ask() { throw new AgentError('NO_TOOLS_ENABLED', '没有可用的 MCP 服务器。', 3); },
          async close() {},
        }),
      },
    });
    try {
      const { status, body } = await json(await post(ctx.base, '/api/ask', { question: 'x' }));
      assert.equal(status, 409);
      assert.equal(body.error.code, 'NO_TOOLS_ENABLED');
      assert.doesNotMatch(body.error.message, /at |stack/i);
    } finally {
      await ctx.app.close();
    }
  });
});

describe('并发与取消', () => {
  it('同一时刻只处理一个提问，第二个返回 409', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const ctx = await start({
      createWebServer: {
        createAgent: async () => ({
          async ask(question) {
            await gate;
            return { text: `慢回答：${question}`, stepCount: 1, toolCalls: [], history: [] };
          },
          async close() {},
        }),
      },
    });
    try {
      const first = post(ctx.base, '/api/ask', { question: '第一个' });
      await new Promise((resolve) => setTimeout(resolve, 40));
      const second = await json(await post(ctx.base, '/api/ask', { question: '第二个' }));
      assert.equal(second.status, 409);
      assert.equal(second.body.error.code, 'BUSY');
      release();
      const done = await json(await first);
      assert.equal(done.body.ok, true);
    } finally {
      release();
      await ctx.app.close();
    }
  });

  it('取消接口在没有进行中提问时如实返回 false', async () => {
    const ctx = await start();
    try {
      const { body } = await json(await post(ctx.base, '/api/cancel'));
      assert.equal(body.data.cancelled, false);
    } finally {
      await ctx.app.close();
    }
  });
});

// ===== 采集组件接入 =====
const BUILTIN_TOKEN = 'agt_builtin_token_456789';

function fakeCollection() {
  const settings = { history: true, likes: false, collections: false, knowledgeFilter: true, fetchFullText: false, aiReview: false };
  const store = { readers: [], minted: 0, jobs: [] };
  return {
    baseUrl: 'http://127.0.0.1:3005',
    userId: 'user-1',
    store,
    localContext: async () => ({ profile: 'default', demo: false, consented: true, bound: true, nickname: '演示读者', settings, operation: null }),
    status: () => ({
      userId: 'user-1', accountBound: true, settings, activeJob: null, devices: [],
      latestSnapshot: { snapshotId: 'snap-1', receivedAt: '2026-11-25T00:00:00.000Z' },
    }),
    settings: (value) => { if (value) Object.assign(settings, { ...value, aiReview: false }); return settings; },
    plan: (value) => value ?? { mode: 'manual', intervalMinutes: 15 },
    records: () => ({
      page: { offset: 0, limit: 10, total: 2, returned: 2, hasMore: false, nextOffset: null },
      records: [{ title: 'a' }, { title: 'b' }],
    }),
    exportSnapshot: () => ({ schemaVersion: 1, module: 'data-collection-service', kind: 'collection_snapshot' }),
    createJob: () => { const job = { id: 'job-1', state: 'queued' }; store.jobs.push(job); return job; },
    job: () => ({ id: 'job-1', state: 'succeeded', error: null }),
    cancelJob: () => ({ id: 'job-1', state: 'cancelled' }),
    keepalive: () => ({ id: 'job-1' }),
    clearServer: () => ({ cleared: true }),
    clearLocal: async () => ({ cleared: true }),
    login: async () => ({ started: true }),
    authorize: async () => ({ authorized: true }),
    revokeConsent: async () => ({ revoked: true }),
    stop: async () => ({ stopped: true }),
    readers: () => store.readers,
    createReader: (label) => {
      store.minted += 1;
      const item = { readerId: `r-${store.minted}`, label, createdAt: '2026-11-25T00:00:00.000Z', readOnly: true };
      store.readers.push(item);
      return { ...item, agentToken: `agt_manual_${store.minted}_abcdef` };
    },
    revokeReader: (id) => { store.readers = store.readers.filter((item) => item.readerId !== id); return { readerId: id, revoked: true }; },
    ensureReader: async () => ({ readerId: 'builtin-reader', token: BUILTIN_TOKEN }),
    forgetReaderIf: () => {},
    get readerId() { return 'builtin-reader'; },
    close: async () => {},
  };
}

async function startCollectionServer({ collection = fakeCollection(), settings = {}, spies = {} } = {}) {
  const app = createWebServer({
    env: {},
    settings,
    loadConfig: (input) => { (spies.inputs ??= []).push(input); return fakeConfig(); },
    describeConfig: fakeDescribe,
    createAgent: async () => ({ async ask(q) { return { text: `回答：${q}`, stepCount: 1, toolCalls: [], history: [] }; }, async close() {} }),
    collection,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

describe('密钥本机保存', () => {
  it('保存设置时把合并后的密钥交给落盘回调', async () => {
    const saved = [];
    const ctx = await start({ createWebServer: { saveSecrets: async (value) => saved.push({ ...value }) } });
    try {
      const { body } = await json(await post(ctx.base, '/api/settings', {
        settings: { baseURL: 'http://127.0.0.1:9/v1', modelName: 'm', apiKey: 'sk-new-key-123456' },
      }));
      assert.equal(body.data.settings.apiKeyConfigured, true);
      assert.equal(saved.at(-1).apiKey, 'sk-new-key-123456', '密钥应交给落盘回调');
      assert.doesNotMatch(JSON.stringify(body), /sk-new-key/, '响应里仍然不能出现密钥');
    } finally {
      await ctx.app.close();
    }
  });

  it('启动时恢复的密钥会进入模型配置', async () => {
    const spies = {};
    const ctx = await start({
      createWebServer: {
        settings: { modelName: 'm', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-restored-key' },
        loadConfig: (input) => { (spies.inputs ??= []).push(input); return fakeConfig(); },
      },
    });
    try {
      await fetch(`${ctx.base}/api/status`);
      assert.equal(spies.inputs.at(-1).env.AGENT_API_KEY, 'sk-restored-key');
    } finally {
      await ctx.app.close();
    }
  });

  it('清除密钥后回到未配置状态，并通知落盘回调删除', async () => {
    const saved = [];
    const ctx = await start({ createWebServer: { saveSecrets: async (value) => saved.push({ ...value }) } });
    try {
      const { status, body } = await json(await post(ctx.base, '/api/secrets/clear'));
      assert.equal(status, 200);
      assert.equal(body.data.settings.apiKeyConfigured, false);
      assert.equal(saved.at(-1).apiKey, '');
      assert.doesNotMatch(JSON.stringify(body), /sk-secret-value/);
    } finally {
      await ctx.app.close();
    }
  });
});

describe('采集组件接入', () => {
  it('没有采集组件时给出 503，对话仍可用', async () => {
    const ctx = await start();
    try {
      const { status, body } = await json(await fetch(`${ctx.base}/api/collection/state`));
      assert.equal(status, 503);
      assert.equal(body.error.code, 'COLLECTION_UNAVAILABLE');
      const status2 = await json(await fetch(`${ctx.base}/api/status`));
      assert.equal(status2.body.data.collection.available, false);
    } finally {
      await ctx.app.close();
    }
  });

  it('状态接口带出账号、范围与最近快照', async () => {
    const ctx = await startCollectionServer();
    try {
      const { status, body } = await json(await fetch(`${ctx.base}/api/collection/state`));
      assert.equal(status, 200);
      assert.equal(body.data.available, true);
      assert.equal(body.data.status.accountBound, true);
      assert.equal(body.data.status.settings.history, true);
      assert.equal(body.data.local.nickname, '演示读者');
      assert.equal(body.data.builtinReaderId, 'builtin-reader');
    } finally {
      await ctx.app.close();
    }
  });

  it('保存采集范围会写回服务，并锁死 aiReview', async () => {
    const ctx = await startCollectionServer();
    try {
      const { body } = await json(await post(ctx.base, '/api/collection/settings', {
        settings: { history: false, likes: true, collections: true, knowledgeFilter: false, fetchFullText: true, aiReview: true },
      }));
      assert.equal(body.data.settings.likes, true);
      assert.equal(body.data.settings.history, false);
      assert.equal(body.data.settings.fetchFullText, true);
      assert.equal(body.data.settings.aiReview, false);
    } finally {
      await ctx.app.close();
    }
  });

  it('同步会建任务并记录进度', async () => {
    const ctx = await startCollectionServer();
    try {
      const { status, body } = await json(await post(ctx.base, '/api/collection/sync'));
      assert.equal(status, 200);
      assert.equal(body.data.job.id, 'job-1');
      assert.equal(body.data.sync.jobId, 'job-1');
      assert.equal(body.data.sync.state, 'queued');
    } finally {
      await ctx.app.close();
    }
  });

  it('记录分页与导出走同一份快照', async () => {
    const ctx = await startCollectionServer();
    try {
      const list = await json(await fetch(`${ctx.base}/api/collection/records?offset=0&limit=10`));
      assert.equal(list.body.data.page.total, 2);
      assert.equal(list.body.data.records.length, 2);

      const exported = await fetch(`${ctx.base}/api/collection/export`);
      assert.equal(exported.status, 200);
      assert.match(exported.headers.get('content-disposition') ?? '', /attachment/);
      assert.equal((await exported.json()).kind, 'collection_snapshot');
    } finally {
      await ctx.app.close();
    }
  });

  it('新建入口只在创建时返回一次明文令牌，列表里查不到', async () => {
    const ctx = await startCollectionServer();
    try {
      const created = await json(await post(ctx.base, '/api/collection/readers', { label: '我的 Agent' }));
      assert.match(created.body.data.agentToken, /^agt_manual_1_/);
      assert.equal(created.body.data.reader.label, '我的 Agent');

      const listed = await json(await fetch(`${ctx.base}/api/collection/readers`));
      assert.equal(listed.body.data.readers.length, 1);
      assert.doesNotMatch(JSON.stringify(listed.body), /agt_manual_1_/);
    } finally {
      await ctx.app.close();
    }
  });

  it('撤销入口后列表为空', async () => {
    const ctx = await startCollectionServer();
    try {
      const created = await json(await post(ctx.base, '/api/collection/readers', { label: 'x' }));
      const id = created.body.data.reader.readerId;
      const removed = await json(await fetch(`${ctx.base}/api/collection/readers/${encodeURIComponent(id)}`, { method: 'DELETE' }));
      assert.equal(removed.body.data.revoked, true);
      const listed = await json(await fetch(`${ctx.base}/api/collection/readers`));
      assert.equal(listed.body.data.readers.length, 0);
    } finally {
      await ctx.app.close();
    }
  });

  it('同意个人数据时把自动签发的只读令牌与采集地址交给 Agent', async () => {
    const spies = {};
    const ctx = await startCollectionServer({ settings: { allowPersonalData: true }, spies });
    try {
      await fetch(`${ctx.base}/api/status`);
      const env = spies.inputs.at(-1).env;
      assert.equal(env.DATA_SERVICE_AGENT_TOKEN, BUILTIN_TOKEN);
      assert.equal(env.DATA_SERVICE_URL, 'http://127.0.0.1:3005');
      const body = await json(await fetch(`${ctx.base}/api/status`));
      assert.doesNotMatch(JSON.stringify(body.body), /agt_builtin_token/);
      assert.equal(body.body.data.collectionAutoToken, true);
    } finally {
      await ctx.app.close();
    }
  });

  it('没同意个人数据时不注入采集令牌', async () => {
    const spies = {};
    const ctx = await startCollectionServer({ settings: { allowPersonalData: false }, spies });
    try {
      await fetch(`${ctx.base}/api/status`);
      const env = spies.inputs.at(-1).env;
      assert.equal(env.DATA_SERVICE_AGENT_TOKEN, undefined);
    } finally {
      await ctx.app.close();
    }
  });

  it('清除数据会先清本机再清服务端', async () => {
    const order = [];
    const collection = fakeCollection();
    collection.clearLocal = async () => { order.push('local'); return { cleared: true }; };
    collection.clearServer = () => { order.push('server'); return { cleared: true }; };
    const ctx = await startCollectionServer({ collection });
    try {
      const { body } = await json(await post(ctx.base, '/api/collection/clear'));
      assert.equal(body.ok, true);
      assert.deepEqual(order, ['local', 'server']);
    } finally {
      await ctx.app.close();
    }
  });
});

describe('交互模块 HTTP 路由接入', () => {
  it('覆盖 /api/interaction/* 全流程并执行密钥脱敏', async () => {
    const fakeInteraction = {
      getState: () => ({ phase: 'idle', viewpoints: [], clash: null, summary: null }),
      generateViewpoints: async ({ refresh }) => ({
        phase: 'select',
        batchIndex: refresh ? 1 : 0,
        viewpoints: [{ id: 'vp-1', kind: 'profile', topic: '测试', claim: '测试包含密钥 sk-secret-value-123456' }],
      }),
      selectViewpoint: async (id) => ({
        phase: 'clash',
        clash: { viewpoint: { id }, willpower: 100, maxWillpower: 100, round: 1, difficultyVisible: false, currentRound: { round: 1, opponentArgument: '立论', options: [{ id: 'opt-1', label: 'A', text: '话术', difficulty: null }] } },
      }),
      submitChoice: async () => ({
        phase: 'summary',
        summary: { totalRounds: 4, appropriateCount: 4, overallComment: '完胜', roundReviews: [], knowledgePoints: [{ title: '知识点', detail: '说明' }] },
      }),
      backToSelection: () => ({ phase: 'select', viewpoints: [{ id: 'vp-1' }] }),
      cancel: () => false,
      resetConnection: async () => {},
      close: async () => {},
    };
    const ctx = await start({ createWebServer: { interaction: fakeInteraction } });
    try {
      const init = await json(await fetch(`${ctx.base}/api/interaction/state`));
      assert.equal(init.status, 200);
      assert.equal(init.body.data.phase, 'idle');

      const topics = await json(await post(ctx.base, '/api/interaction/topics', { refresh: true }));
      assert.equal(topics.status, 200);
      assert.equal(topics.body.data.batchIndex, 1);
      assert.doesNotMatch(JSON.stringify(topics.body), /sk-secret-value/, '交互接口输出同样必须脱敏密钥');

      const selected = await json(await post(ctx.base, '/api/interaction/select', { viewpointId: 'vp-1' }));
      assert.equal(selected.body.data.phase, 'clash');
      assert.equal(selected.body.data.clash.difficultyVisible, false);

      const acted = await json(await post(ctx.base, '/api/interaction/act', { optionId: 'opt-1' }));
      assert.equal(acted.body.data.phase, 'summary');

      const reset = await json(await post(ctx.base, '/api/interaction/reset'));
      assert.equal(reset.body.data.phase, 'select');
    } finally {
      await ctx.app.close();
    }
  });
});
