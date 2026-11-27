// 用户画像：输入拼装、JSON 解析、提示词注入，以及后台刷新的失败保留策略。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProfileInput, parseProfileJson, normalizeProfile, profilePromptBlock, isStale, generateProfile, PROFILE_VERSION, PROMPT_VERSION,
} from '../profile.mjs';
import { buildSystemPrompt } from '../prompt.mjs';
import { createWebServer } from '../web.mjs';

const MODEL = { providerName: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', modelName: 'fake', apiKey: 'k', ready: true };
const LIMITS = { maxSteps: 8, totalMs: 60000, stepMs: 30000, collectionSyncMs: 900000 };

function fakeConfig() {
  return { demo: false, allowPersonalData: true, model: MODEL, limits: LIMITS, servers: [] };
}

describe('画像输入拼装', () => {
  it('每条记录压成紧凑的几行，超长摘要会被截断', () => {
    const text = buildProfileInput([
      { kinds: ['history'], contentType: 'answer', weight: 5.5, title: '标题一', topics: ['AI'], summary: '很长的摘要'.repeat(60) },
    ], { summaryChars: 20 });
    assert.match(text, /1\. \[浏览｜answer｜权重 5\.50\] 标题一/);
    assert.match(text, /话题：AI/);
    const summaryLine = text.split('\n').find((line) => line.includes('摘要：'));
    assert.ok(summaryLine.length < 40, '摘要应被截断');
  });

  it('缺字段时不产生 undefined 文本', () => {
    const text = buildProfileInput([{ contentType: 'pin' }]);
    assert.doesNotMatch(text, /undefined/);
    assert.match(text, /权重 —/);
  });

  it('话题是 { id, name } 对象时取名字，不能渲染成 [object Object]', () => {
    const text = buildProfileInput([
      { contentType: 'answer', title: '标题', topics: [{ id: 't1', name: '人工智能' }, { id: 't2', name: 'RAG' }, '纯字符串话题'] },
    ]);
    assert.doesNotMatch(text, /\[object Object\]/);
    assert.match(text, /话题：人工智能、RAG、纯字符串话题/);
  });

  it('话题数组里有脏数据时跳过而不是留下占位', () => {
    const text = buildProfileInput([{ contentType: 'answer', title: 't', topics: [{ id: 'x' }, null, { name: '' }, { name: ' 有效 ' }] }]);
    assert.match(text, /话题：有效/);
    assert.doesNotMatch(text, /\[object Object\]/);
  });
});

describe('画像 JSON 解析', () => {
  it('能穿过代码块与前后说明文字', () => {
    const raw = '好的，结果如下：\n```json\n{"summary":"在看 AI","domains":[{"name":"AI","share":0.4,"evidence":["标题"]}],"topics":["RAG"],"shifts":[],"uncertainties":["样本少"]}\n```';
    const value = parseProfileJson(raw);
    assert.equal(value.summary, '在看 AI');
    assert.equal(value.domains[0].name, 'AI');
    assert.equal(value.topics[0], 'RAG');
  });

  it('没有 JSON 时抛错', () => {
    assert.throws(() => parseProfileJson('抱歉，我无法完成'), /没有 JSON/);
  });

  it('字段类型不对时回落成安全默认值', () => {
    const value = normalizeProfile({ summary: 123, domains: [{ share: 'abc' }], topics: 'not-array' });
    assert.equal(value.summary, '');
    assert.deepEqual(value.domains, []);
    assert.deepEqual(value.topics, []);
  });

  it('占比被夹在 0 到 1 之间', () => {
    const value = normalizeProfile({ domains: [{ name: 'A', share: 3 }, { name: 'B', share: -1 }] });
    assert.equal(value.domains[0].share, 1);
    assert.equal(value.domains[1].share, 0);
  });
});

describe('画像进入系统提示词', () => {
  it('没有画像时不出现画像段落', () => {
    const prompt = buildSystemPrompt({ enabled: ['search'], profile: '' });
    assert.doesNotMatch(prompt, /用户画像/);
  });

  it('有画像时附在工具说明之后，并声明以工具数据为准', () => {
    const block = profilePromptBlock({ summary: '在看 AI', domains: [{ name: 'AI', share: 0.3 }], topics: ['RAG'], shifts: [], generatedAt: '2026-11-25T00:00:00.000Z' });
    const prompt = buildSystemPrompt({ enabled: ['collection'], profile: block });
    assert.match(prompt, /## 用户画像/);
    assert.match(prompt, /AI（30%）/);
    assert.match(prompt, /以工具数据为准/);
    assert.ok(prompt.indexOf('用户画像') > prompt.indexOf('个人浏览数据工具'), '画像应排在工具说明之后');
  });

  it('空画像不会拼出空段落', () => {
    assert.equal(profilePromptBlock(null), '');
    assert.equal(profilePromptBlock({ summary: '', domains: [] }), '');
  });

  it('快照不同即视为过期', () => {
    const fresh = { version: PROFILE_VERSION, promptVersion: PROMPT_VERSION, snapshotId: 'a' };
    assert.equal(isStale(fresh, 'b'), true);
    assert.equal(isStale(fresh, 'a'), false);
    assert.equal(isStale(null, 'a'), true);
  });

  it('提示词或数据协议升级后，旧画像自动作废重算', () => {
    const current = { version: PROFILE_VERSION, promptVersion: PROMPT_VERSION, snapshotId: 'a' };
    assert.equal(isStale(current, 'a'), false);
    // 旧画像没有 promptVersion 字段，必须判定过期，否则改了提示词也不会重算。
    assert.equal(isStale({ version: PROFILE_VERSION, snapshotId: 'a' }, 'a'), true);
    assert.equal(isStale({ version: PROFILE_VERSION, promptVersion: PROMPT_VERSION - 1, snapshotId: 'a' }, 'a'), true);
  });
});

// ===== 后台刷新 =====
function fakeCollection(snapshotId = 'snap-1') {
  const counts = { history: 2, likes: 0, collections: 0 };
  const items = [
    { contentId: 'a1', contentType: 'answer', title: '一篇 AI 文章', summary: '摘要一', topics: ['AI'], kinds: ['history'], weight: 5 },
    { contentId: 'a2', contentType: 'article', title: '另一篇', summary: '摘要二', topics: [], kinds: ['history'], weight: 4 },
  ];
  return {
    baseUrl: 'http://127.0.0.1:3005',
    userId: 'u1',
    localContext: async () => ({ local: { consented: true, bound: true } }),
    status: () => ({ userId: 'u1', accountBound: true, settings: {}, activeJob: null, devices: [], latestSnapshot: { snapshotId, receivedAt: '2026-11-25T00:00:00.000Z' } }),
    records: () => ({
      snapshotId, receivedAt: '2026-11-25T00:00:00.000Z',
      metadata: { counts },
      page: { offset: 0, limit: 20, total: items.length, returned: items.length, hasMore: false, nextOffset: null },
      items,
    }),
    readers: () => [],
    get readerId() { return null; },
    close: async () => {},
  };
}

async function startProfileServer({ collection = fakeCollection(), profile = null, generate, saveProfile = async () => {} } = {}) {
  const app = createWebServer({
    env: {},
    settings: { modelName: 'fake', baseURL: 'http://127.0.0.1:9/v1' },
    loadConfig: () => fakeConfig(),
    describeConfig: () => ({ demo: false, allowPersonalData: true, model: { modelName: 'fake', baseURL: MODEL.baseURL, apiKeyConfigured: true }, limits: LIMITS, servers: [] }),
    createAgent: async () => ({ async ask() { return { text: '', stepCount: 1, toolCalls: [], history: [] }; }, async close() {} }),
    collection,
    profile,
    saveProfile,
    generate,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

const json = async (response) => ({ status: response.status, body: await response.json() });

describe('画像接口', () => {
  it('还没有画像时返回空，状态为 idle', async () => {
    const ctx = await startProfileServer({ generate: async () => { throw new Error('不该被调用'); } });
    try {
      const { body } = await json(await fetch(`${ctx.base}/api/profile`));
      assert.equal(body.ok, true);
      assert.equal(body.data.profile, null);
      assert.equal(body.data.state.status, 'idle');
    } finally {
      await ctx.app.close();
    }
  });

  it('手动刷新会生成画像并落盘', async () => {
    const saved = [];
    const ctx = await startProfileServer({
      generate: async ({ records, snapshotId }) => ({
        version: PROFILE_VERSION, promptVersion: PROMPT_VERSION, generatedAt: '2026-11-25T12:00:00.000Z', snapshotId,
        summary: `读了 ${records.length} 条`, domains: [{ name: 'AI', share: 0.5, evidence: [] }],
        topics: ['RAG'], shifts: [], uncertainties: [],
      }),
      saveProfile: async (value) => { saved.push(value); },
    });
    try {
      const { status, body } = await json(await fetch(`${ctx.base}/api/profile/refresh`, { method: 'POST' }));
      assert.equal(status, 200);
      assert.equal(body.data.profile.summary, '读了 2 条');
      assert.equal(body.data.state.status, 'ready');
      assert.equal(saved.length, 1, '应落盘');
      assert.equal(body.data.stale, false);
    } finally {
      await ctx.app.close();
    }
  });

  it('生成失败时保留上一份画像，状态标为 error', async () => {
    const previous = { version: 1, generatedAt: '2026-11-20T00:00:00.000Z', snapshotId: 'old', summary: '旧画像', domains: [], topics: [], shifts: [], uncertainties: [] };
    const ctx = await startProfileServer({
      profile: previous,
      generate: async () => { throw new Error('模型挂了'); },
    });
    try {
      const failed = await fetch(`${ctx.base}/api/profile/refresh`, { method: 'POST' });
      assert.equal(failed.status, 500);
      const { body } = await json(await fetch(`${ctx.base}/api/profile`));
      assert.equal(body.data.profile.summary, '旧画像', '旧画像必须保留');
      assert.equal(body.data.state.status, 'error');
      assert.ok(body.data.state.error, '应给出失败原因');
      assert.doesNotMatch(body.data.state.error, /模型挂了/, '上游原始报错不应直接进界面');
    } finally {
      await ctx.app.close();
    }
  });

  it('画像落后于当前快照时标记为过期', async () => {
    const previous = { version: 1, generatedAt: '2026-11-20T00:00:00.000Z', snapshotId: 'old-snap', summary: '旧', domains: [], topics: [], shifts: [], uncertainties: [] };
    const ctx = await startProfileServer({ profile: previous, collection: fakeCollection('new-snap'), generate: async () => { throw new Error('x'); } });
    try {
      const { body } = await json(await fetch(`${ctx.base}/api/profile`));
      assert.equal(body.data.stale, true);
      assert.equal(body.data.snapshotId, 'new-snap');
    } finally {
      await ctx.app.close();
    }
  });

  it('generateProfile 同时合并调用方取消信号与超时信号：两者均可独立触发中止', async () => {
    const records = [{ contentType: 'answer', title: '测试标题', summary: '摘要', topics: ['AI'], kinds: ['history'], weight: 1 }];

    // 1) 传入未中止的外部 signal 时，短 timeoutMs 依然生效
    const idleController = new AbortController();
    let seenTimeoutSignal = null;
    await assert.rejects(
      () => generateProfile({
        model: { fake: true },
        modelName: 'local-qwen',
        records,
        snapshotId: 'snap-t',
        signal: idleController.signal,
        timeoutMs: 35,
        generate: ({ abortSignal }) => {
          seenTimeoutSignal = abortSignal;
          return new Promise((_resolve, reject) => {
            abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
          });
        },
      }),
      (err) => err?.name === 'TimeoutError',
    );
    assert.equal(seenTimeoutSignal.aborted, true);
    assert.equal(idleController.signal.aborted, false, '超时不应反向污染调用方外部 controller');

    // 2) 长 timeoutMs 下调用方主动 abort 立即生效
    const cancelController = new AbortController();
    let seenCancelSignal = null;
    const pending = generateProfile({
      model: { fake: true },
      modelName: 'local-qwen',
      records,
      snapshotId: 'snap-c',
      signal: cancelController.signal,
      timeoutMs: 60_000,
      generate: ({ abortSignal }) => {
        seenCancelSignal = abortSignal;
        return new Promise((_resolve, reject) => {
          abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
        });
      },
    });
    const reason = new Error('user-cancelled');
    cancelController.abort(reason);
    await assert.rejects(() => pending, (err) => err === reason);
    assert.equal(seenCancelSignal.aborted, true);
  });
});
