// P0-B 旧工作台画像授权门禁 HTTP 验收测试（R-B1）：
// 使用真实 createWebServer HTTP 入口（随机回环端口）、真实 loadConfig/describeConfig、
// 独立临时持久化目录、合成采集替身与可控/可计数画像生成器替身。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebServer } from '../web.mjs';
import { loadConfig, describeConfig } from '../config.mjs';
import { generateProfile, PROFILE_VERSION, PROMPT_VERSION } from '../profile.mjs';

const SYNTHETIC_ITEMS = Object.freeze([
  {
    contentId: 'syn-rec-1',
    contentType: 'answer',
    title: '合成阅读记录一：本地回环模型评测',
    summary: '合成摘要内容一，仅用于 P0-B 门禁回归验证。',
    topics: [{ id: 't-1', name: '本地推理' }],
    kinds: ['history'],
    weight: 6.2,
  },
  {
    contentId: 'syn-rec-2',
    contentType: 'article',
    title: '合成阅读记录二：数据最小化与授权边界',
    summary: '合成摘要内容二，仅用于 P0-B 门禁回归验证。',
    topics: [{ id: 't-2', name: '隐私边界' }],
    kinds: ['likes', 'collections'],
    weight: 5.4,
  },
]);

function createSyntheticCollection({ snapshotId = 'snap-syn-1' } = {}) {
  let recordsReads = 0;
  let statusReads = 0;
  let jobCounter = 0;
  let currentSnapshotId = snapshotId;
  const jobs = new Map();
  const colSettings = {
    history: true,
    likes: true,
    collections: false,
    knowledgeFilter: true,
    fetchFullText: false,
    aiReview: false,
  };

  return {
    baseUrl: 'http://127.0.0.1:39905',
    userId: 'syn-user-b1',
    get stats() {
      return { recordsReads, statusReads, jobsCreated: jobCounter };
    },
    resetRecordsReads() {
      recordsReads = 0;
    },
    advanceSnapshot(nextId) {
      currentSnapshotId = nextId;
    },
    localContext: async () => ({
      profile: 'synthetic-b1',
      demo: true,
      consented: true,
      bound: true,
      nickname: '合成读者B1',
      settings: colSettings,
      operation: null,
    }),
    status: () => {
      statusReads += 1;
      return {
        userId: 'syn-user-b1',
        accountBound: true,
        settings: colSettings,
        activeJob: null,
        devices: [],
        latestSnapshot: {
          snapshotId: currentSnapshotId,
          receivedAt: '2026-11-26T00:00:00.000Z',
        },
      };
    },
    settings: (value) => {
      if (value) Object.assign(colSettings, { ...value, aiReview: false });
      return colSettings;
    },
    plan: (value) => value ?? { mode: 'manual', intervalMinutes: 15 },
    records: ({ offset = 0, limit = 10 } = {}) => {
      recordsReads += 1;
      const slice = SYNTHETIC_ITEMS.slice(offset, offset + limit);
      return {
        snapshotId: currentSnapshotId,
        receivedAt: '2026-11-26T00:00:00.000Z',
        metadata: { counts: { history: 1, likes: 1, collections: 1 } },
        page: {
          offset,
          limit,
          total: SYNTHETIC_ITEMS.length,
          returned: slice.length,
          hasMore: offset + slice.length < SYNTHETIC_ITEMS.length,
          nextOffset: offset + slice.length < SYNTHETIC_ITEMS.length ? offset + slice.length : null,
        },
        items: slice,
      };
    },
    exportSnapshot: () => ({
      schemaVersion: 1,
      module: 'data-collection-service',
      kind: 'collection_snapshot',
      snapshotId: currentSnapshotId,
      items: SYNTHETIC_ITEMS,
    }),
    createJob: () => {
      jobCounter += 1;
      const id = `syn-job-${jobCounter}`;
      const now = new Date().toISOString();
      const job = { id, state: 'queued', createdAt: now, updatedAt: now, error: null };
      jobs.set(id, job);
      // 模拟同步很快完成并在轮询时返回 succeeded
      setTimeout(() => {
        job.state = 'succeeded';
        job.updatedAt = new Date().toISOString();
      }, 15);
      return { ...job };
    },
    job: (id) => {
      const found = jobs.get(id);
      return found ? { ...found } : null;
    },
    cancelJob: (id) => {
      const found = jobs.get(id);
      if (found) found.state = 'cancelled';
      return found ? { ...found } : { id, state: 'cancelled' };
    },
    keepalive: (id) => ({ id }),
    readers: () => [],
    ensureReader: async () => ({ readerId: 'syn-builtin-reader', token: 'agt_syn_b1_readonly_token' }),
    forgetReaderIf: () => {},
    get readerId() { return 'syn-builtin-reader'; },
    close: async () => {},
  };
}

function makeFakeProfile(snapshotId, label = '合成画像') {
  return {
    version: PROFILE_VERSION,
    promptVersion: PROMPT_VERSION,
    generatedAt: '2026-11-26T08:00:00.000Z',
    snapshotId,
    syncedAt: '2026-11-26T00:00:00.000Z',
    model: 'local-qwen',
    coverage: { records: 2, counts: { history: 1, likes: 1, collections: 1 }, window: 'latest_50_qualified', completeHistory: false, includesFullText: false },
    summary: label,
    domains: [{ name: '本地推理', share: 0.6, evidence: ['合成阅读记录一：本地回环模型评测'] }],
    topics: ['本地推理', '隐私边界'],
    shifts: [],
    uncertainties: [],
  };
}

async function createTempStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p0-b-profile-gate-'));
  const settingsFile = path.join(dir, 'web-settings.json');
  const profileFile = path.join(dir, 'profile.json');
  return {
    dir,
    settingsFile,
    profileFile,
    async readSettings() {
      try {
        return JSON.parse(await readFile(settingsFile, 'utf8'));
      } catch {
        return null;
      }
    },
    async writeSettings(portion) {
      await writeFile(settingsFile, `${JSON.stringify(portion, null, 2)}\n`, 'utf8');
    },
    async readProfile() {
      try {
        return JSON.parse(await readFile(profileFile, 'utf8'));
      } catch {
        return null;
      }
    },
    async writeProfile(value) {
      await writeFile(profileFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const json = async (response) => ({ status: response.status, body: await response.json() });
const post = (base, pathname, body) => fetch(`${base}${pathname}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function waitForSyncFinished(base, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await json(await fetch(`${base}/api/collection/state`));
    if (body.data?.sync?.state === 'succeeded') return body.data.sync;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待同步完成超时');
}

async function startHarness({
  store,
  env = {},
  settings = {},
  collection = createSyntheticCollection(),
  profile = null,
  generateImpl = null,
} = {}) {
  const calls = {
    generate: [],
    savedProfiles: [],
    persistedSettings: [],
  };

  const app = createWebServer({
    env,
    settings,
    loadConfig,
    describeConfig,
    createAgent: async () => ({
      async ask(q) { return { text: `ok:${q}`, stepCount: 1, toolCalls: [], history: [] }; },
      async close() {},
    }),
    collection,
    profile,
    syncPollMs: 25,
    persist: async (portion) => {
      calls.persistedSettings.push(portion);
      if (store) await store.writeSettings(portion);
    },
    saveSecrets: async () => {},
    saveProfile: async (value) => {
      calls.savedProfiles.push(value);
      if (store) await store.writeProfile(value);
    },
    modelFactory: (modelConfig) => ({ fakeModel: true, baseURL: modelConfig.baseURL, modelName: modelConfig.modelName }),
    generate: async (args) => {
      calls.generate.push(args);
      if (generateImpl) return generateImpl(args);
      return makeFakeProfile(args.snapshotId, `生成于 ${args.modelName}（${args.records.length} 条）`);
    },
  });

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, collection, calls };
}

describe('P0-B / R-B1 旧工作台画像授权门禁', () => {
  it('R-B1.1 关闭个人材料（allowPersonalData: false）+ 非回环模型：四条入口均为 0 生成、0 画像读取、不落库，采集只读快照仍可用', async () => {
    const store = await createTempStore();
    const harness = await startHarness({
      store,
      settings: {
        allowPersonalData: false,
        baseURL: 'https://api.example.com/v1',
        modelName: 'cloud-model-x',
        apiKey: 'sk-synthetic-cloud-key',
      },
    });
    try {
      // 1) 启动自动画像
      const startupResult = harness.app.maybeRefreshProfile('startup');
      assert.equal(startupResult, null, '关闭个人材料时启动自动画像应静默跳过');

      // 2) 同步完成自动画像（真实 POST /api/collection/sync -> sync loop -> maybeRefreshProfile('sync')）
      const syncStart = await json(await post(harness.base, '/api/collection/sync'));
      assert.equal(syncStart.status, 200);
      await waitForSyncFinished(harness.base);
      await new Promise((resolve) => setTimeout(resolve, 60));

      // 3) 保存设置自动画像（真实 POST /api/settings）
      const saved = await json(await post(harness.base, '/api/settings', {
        settings: {
          allowPersonalData: false,
          baseURL: 'https://api.example.com/v1',
          modelName: 'cloud-model-x',
        },
      }));
      assert.equal(saved.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 60));

      // 4) 手动刷新画像（真实 POST /api/profile/refresh）
      const manual = await json(await post(harness.base, '/api/profile/refresh'));
      assert.equal(manual.status, 403);
      assert.equal(manual.body.ok, false);
      assert.equal(manual.body.error.code, 'PERSONAL_DATA_DISABLED');

      // 门禁拦截前：模型生成调用与用于画像的采集记录读取均严格为 0，且未落库
      assert.equal(harness.calls.generate.length, 0, '关闭个人材料时模型生成调用必须为 0');
      assert.equal(harness.collection.stats.recordsReads, 0, '关闭个人材料时不得读取个人采集记录用于画像');
      assert.equal(harness.calls.savedProfiles.length, 0, '不得落库新画像');
      assert.equal(await store.readProfile(), null, '磁盘不应存在画像文件');

      // 核对 /api/profile 状态未损坏且带清晰门禁提示
      const profileResp = await json(await fetch(`${harness.base}/api/profile`));
      assert.equal(profileResp.status, 200);
      assert.equal(profileResp.body.data.profile, null);
      assert.equal(profileResp.body.data.state.status, 'idle');
      assert.equal(profileResp.body.data.gate.allowed, false);
      assert.equal(profileResp.body.data.gate.code, 'PERSONAL_DATA_DISABLED');

      // 采集与只读快照能力仍独立可用
      const colState = await json(await fetch(`${harness.base}/api/collection/state`));
      assert.equal(colState.status, 200);
      assert.equal(colState.body.data.available, true);
      assert.equal(colState.body.data.status.latestSnapshot.snapshotId, 'snap-syn-1');

      const colRecords = await json(await fetch(`${harness.base}/api/collection/records?offset=0&limit=10`));
      assert.equal(colRecords.status, 200);
      assert.equal(colRecords.body.data.items.length, 2);
      assert.equal(harness.calls.generate.length, 0, '查询只读快照后仍不触发画像生成');
    } finally {
      await harness.app.close();
      await store.cleanup();
    }
  });

  it('R-B1.2 关闭个人材料（allowPersonalData: false）+ 回环模型（即使环境变量含 AGENT_ALLOW_PERSONAL_DATA=true）：四条入口同样均为 0 调用、不落库', async () => {
    const store = await createTempStore();
    const harness = await startHarness({
      store,
      env: { AGENT_ALLOW_PERSONAL_DATA: 'true' },
      settings: {
        allowPersonalData: false,
        baseURL: 'http://127.0.0.1:11434/v1',
        modelName: 'local-qwen',
      },
    });
    try {
      // 1) 启动
      assert.equal(harness.app.maybeRefreshProfile('startup'), null);

      // 2) 同步完成
      const syncStart = await json(await post(harness.base, '/api/collection/sync'));
      assert.equal(syncStart.status, 200);
      await waitForSyncFinished(harness.base);
      await new Promise((resolve) => setTimeout(resolve, 60));

      // 3) 保存设置
      const saved = await json(await post(harness.base, '/api/settings', {
        settings: {
          allowPersonalData: false,
          baseURL: 'http://127.0.0.1:11434/v1',
          modelName: 'local-qwen',
        },
      }));
      assert.equal(saved.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 60));

      // 4) 手动刷新
      const manual = await json(await post(harness.base, '/api/profile/refresh'));
      assert.equal(manual.status, 403);
      assert.equal(manual.body.ok, false);
      assert.equal(manual.body.error.code, 'PERSONAL_DATA_DISABLED');

      assert.equal(harness.calls.generate.length, 0);
      assert.equal(harness.collection.stats.recordsReads, 0);
      assert.equal(harness.calls.savedProfiles.length, 0);
      assert.equal(await store.readProfile(), null);
    } finally {
      await harness.app.close();
      await store.cleanup();
    }
  });

  it('R-B1.3 开启个人材料（allowPersonalData: true）+ 非回环模型：自动入口静默拒绝，手动刷新返回 403 CLOUD_CONSENT_REQUIRED，0 调用且不损坏已有画像', async () => {
    const store = await createTempStore();
    const existingProfile = makeFakeProfile('snap-old', '已有合法旧画像');
    const harness = await startHarness({
      store,
      profile: existingProfile,
      settings: {
        allowPersonalData: true,
        baseURL: 'https://api.example.com/v1',
        modelName: 'cloud-model-x',
        apiKey: 'sk-synthetic-cloud-key',
      },
    });
    try {
      // 1) 启动自动画像（旧画像已落后于 snap-syn-1，但因非回环模型仍必须跳过）
      assert.equal(harness.app.maybeRefreshProfile('startup'), null);

      // 2) 同步完成自动画像
      const syncStart = await json(await post(harness.base, '/api/collection/sync'));
      assert.equal(syncStart.status, 200);
      await waitForSyncFinished(harness.base);
      await new Promise((resolve) => setTimeout(resolve, 60));

      // 3) 保存设置自动画像
      const saved = await json(await post(harness.base, '/api/settings', {
        settings: {
          allowPersonalData: true,
          baseURL: 'https://api.example.com/v1',
          modelName: 'cloud-model-x',
        },
      }));
      assert.equal(saved.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 60));

      // 4) 手动刷新返回明确 403 CLOUD_CONSENT_REQUIRED
      const manual = await json(await post(harness.base, '/api/profile/refresh'));
      assert.equal(manual.status, 403);
      assert.equal(manual.body.ok, false);
      assert.equal(manual.body.error.code, 'CLOUD_CONSENT_REQUIRED');

      assert.equal(harness.calls.generate.length, 0, '非回环模型不得触发画像生成');
      assert.equal(harness.collection.stats.recordsReads, 0, '非回环模型被拒前不得读取采集记录');
      assert.equal(harness.calls.savedProfiles.length, 0, '不得落库新画像');
      assert.equal(await store.readProfile(), null);

      // 核对既有合法画像与 ready 状态未被损坏，并给出明确门禁信息
      const profileResp = await json(await fetch(`${harness.base}/api/profile`));
      assert.equal(profileResp.status, 200);
      assert.equal(profileResp.body.data.profile.summary, '已有合法旧画像');
      assert.equal(profileResp.body.data.state.status, 'ready');
      assert.equal(profileResp.body.data.state.errorCode, 'CLOUD_CONSENT_REQUIRED');
      assert.equal(profileResp.body.data.gate.allowed, false);
      assert.equal(profileResp.body.data.gate.code, 'CLOUD_CONSENT_REQUIRED');
      assert.equal(profileResp.body.data.gate.isCloudModel, true);

      // 采集只读快照仍独立可用
      const colRecords = await json(await fetch(`${harness.base}/api/collection/records`));
      assert.equal(colRecords.status, 200);
      assert.equal(colRecords.body.data.items.length, 2);
    } finally {
      await harness.app.close();
      await store.cleanup();
    }
  });

  it('R-B1.4 开启个人材料（allowPersonalData: true）+ 回环模型可用（127.0.0.1 / localhost / ::1）：手动刷新成功并落库', async () => {
    for (const baseURL of [
      'http://127.0.0.1:11434/v1',
      'http://localhost:11434/v1',
      'http://[::1]:11434/v1',
    ]) {
      const store = await createTempStore();
      const harness = await startHarness({
        store,
        settings: {
          allowPersonalData: true,
          baseURL,
          modelName: 'local-qwen',
        },
      });
      try {
        const manual = await json(await post(harness.base, '/api/profile/refresh'));
        assert.equal(manual.status, 200, `回环地址 ${baseURL} 应允许手动生成画像`);
        assert.equal(manual.body.ok, true);
        assert.equal(harness.calls.generate.length, 1);
        assert.equal(harness.collection.stats.recordsReads, 1);
        assert.equal(harness.calls.savedProfiles.length, 1);
        assert.ok(harness.calls.generate[0].signal instanceof AbortSignal, '生成器应收到 AbortSignal');
        assert.equal(harness.calls.generate[0].signal.aborted, false);
        assert.equal(manual.body.data.state.status, 'ready');
        assert.equal(manual.body.data.gate.allowed, true);
        assert.equal(manual.body.data.gate.isLocalModel, true);

        const stored = await store.readProfile();
        assert.ok(stored, `回环地址 ${baseURL} 生成的新画像应落库`);
        assert.equal(stored.snapshotId, 'snap-syn-1');
      } finally {
        await harness.app.close();
        await store.cleanup();
      }
    }
  });

  it('R-B1.5 运行中关闭设置：立即向运行中的生成器传递取消信号，且即使生成器忽略信号随后 resolve，新画像也绝不落库', async () => {
    const store = await createTempStore();
    let generatorStarted;
    let releaseGenerator;
    const startedPromise = new Promise((resolve) => { generatorStarted = resolve; });
    const releasePromise = new Promise((resolve) => { releaseGenerator = resolve; });
    let capturedSignal = null;

    const harness = await startHarness({
      store,
      settings: {
        allowPersonalData: true,
        baseURL: 'http://127.0.0.1:11434/v1',
        modelName: 'local-qwen',
      },
      generateImpl: async ({ snapshotId, signal }) => {
        capturedSignal = signal;
        generatorStarted();
        await releasePromise;
        // 故意忽略 signal.aborted，直接返回一份新画像，验证服务端在落库前再次复核代际与门禁！
        return makeFakeProfile(snapshotId, '运行中被关闭后试图偷渡落库的画像');
      },
    });
    try {
      // 发起手动刷新并等待进入生成器
      const refreshReq = post(harness.base, '/api/profile/refresh');
      await startedPromise;
      assert.ok(capturedSignal instanceof AbortSignal);
      assert.equal(capturedSignal.aborted, false);

      // 运行中通过 POST /api/settings 关闭 allowPersonalData
      const disableResp = await json(await post(harness.base, '/api/settings', {
        settings: {
          allowPersonalData: false,
          baseURL: 'http://127.0.0.1:11434/v1',
          modelName: 'local-qwen',
        },
      }));
      assert.equal(disableResp.status, 200);
      assert.equal(capturedSignal.aborted, true, '关闭 allowPersonalData 后必须立即向运行中的生成器发出取消信号');

      // 放行故意忽略取消信号的生成器，让它 resolve
      releaseGenerator();
      const refreshResp = await json(await refreshReq);
      assert.equal(refreshResp.body.ok, false);
      assert.ok([403, 499].includes(refreshResp.status), `应拒绝或取消旧请求，实际状态码 ${refreshResp.status}`);

      // 核心断言：新画像绝不落库，也不污染内存 profile 与状态
      assert.equal(harness.calls.savedProfiles.length, 0, '被取消的画像结果绝不能调用 saveProfile');
      assert.equal(await store.readProfile(), null, '磁盘绝不能写入新画像');

      const profileResp = await json(await fetch(`${harness.base}/api/profile`));
      assert.equal(profileResp.status, 200);
      assert.equal(profileResp.body.data.profile, null, '内存中的 profile 不得被未授权结果覆盖');
      assert.equal(profileResp.body.data.state.status, 'idle');
      assert.equal(profileResp.body.data.gate.allowed, false);
      assert.equal(profileResp.body.data.gate.code, 'PERSONAL_DATA_DISABLED');
    } finally {
      releaseGenerator?.();
      await harness.app.close();
      await store.cleanup();
    }
  });

  it('R-B1.5b 运行中切换为非回环模型：同样立即发出取消信号且阻止延迟 resolve 的结果落库', async () => {
    const store = await createTempStore();
    const existingProfile = makeFakeProfile('snap-old', '切换前的合法旧画像');
    let generatorStarted;
    let releaseGenerator;
    const startedPromise = new Promise((resolve) => { generatorStarted = resolve; });
    const releasePromise = new Promise((resolve) => { releaseGenerator = resolve; });
    let capturedSignal = null;

    const harness = await startHarness({
      store,
      profile: existingProfile,
      settings: {
        allowPersonalData: true,
        baseURL: 'http://127.0.0.1:11434/v1',
        modelName: 'local-qwen',
      },
      generateImpl: async ({ snapshotId, signal }) => {
        capturedSignal = signal;
        generatorStarted();
        await releasePromise;
        return makeFakeProfile(snapshotId, '切换非回环后试图落库的新画像');
      },
    });
    try {
      const refreshReq = post(harness.base, '/api/profile/refresh');
      await startedPromise;
      assert.equal(capturedSignal.aborted, false);

      // 运行中切换为非回环模型地址
      const switchResp = await json(await post(harness.base, '/api/settings', {
        settings: {
          allowPersonalData: true,
          baseURL: 'https://api.example.com/v1',
          modelName: 'cloud-model-x',
        },
      }));
      assert.equal(switchResp.status, 200);
      assert.equal(capturedSignal.aborted, true, '切换到非回环模型后必须立即取消运行中的画像任务');

      releaseGenerator();
      const refreshResp = await json(await refreshReq);
      assert.equal(refreshResp.body.ok, false);
      assert.equal(harness.calls.savedProfiles.length, 0);
      assert.equal(await store.readProfile(), null);

      const profileResp = await json(await fetch(`${harness.base}/api/profile`));
      assert.equal(profileResp.body.data.profile.summary, '切换前的合法旧画像', '旧合法画像必须完整保留');
      assert.equal(profileResp.body.data.state.status, 'ready');
      assert.equal(profileResp.body.data.gate.code, 'CLOUD_CONSENT_REQUIRED');
    } finally {
      releaseGenerator?.();
      await harness.app.close();
      await store.cleanup();
    }
  });

  it('R-B1.6 关闭后重启：加载同一持久化设置启动新实例，启动自动画像、同步完成与手动刷新均保持 0 调用、不落库', async () => {
    const store = await createTempStore();
    // 实例 1：原本开启回环模型，随后在界面保存关闭 allowPersonalData: false 并落盘
    const first = await startHarness({
      store,
      settings: {
        allowPersonalData: true,
        baseURL: 'http://127.0.0.1:11434/v1',
        modelName: 'local-qwen',
      },
    });
    try {
      const saved = await json(await post(first.base, '/api/settings', {
        settings: {
          allowPersonalData: false,
          baseURL: 'http://127.0.0.1:11434/v1',
          modelName: 'local-qwen',
        },
      }));
      assert.equal(saved.status, 200);
      assert.equal(first.calls.generate.length, 0);
      assert.equal(first.calls.savedProfiles.length, 0);
    } finally {
      await first.app.close();
    }

    // 确认持久化设置已写盘为 allowPersonalData: false
    const persistedSettings = await store.readSettings();
    assert.ok(persistedSettings, '设置应已落盘');
    assert.equal(persistedSettings.allowPersonalData, false);
    assert.equal(await store.readProfile(), null);

    // 实例 2：使用同一份持久化设置与画像状态重启服务
    const second = await startHarness({
      store,
      settings: persistedSettings,
      profile: await store.readProfile(),
    });
    try {
      // 重启后的启动自动画像
      assert.equal(second.app.maybeRefreshProfile('startup'), null);

      // 重启后的同步完成自动画像
      const syncStart = await json(await post(second.base, '/api/collection/sync'));
      assert.equal(syncStart.status, 200);
      await waitForSyncFinished(second.base);
      await new Promise((resolve) => setTimeout(resolve, 60));

      // 重启后的手动刷新
      const manual = await json(await post(second.base, '/api/profile/refresh'));
      assert.equal(manual.status, 403);
      assert.equal(manual.body.ok, false);
      assert.equal(manual.body.error.code, 'PERSONAL_DATA_DISABLED');

      // 严格 0 生成调用、0 画像记录读取、不落库
      assert.equal(second.calls.generate.length, 0);
      assert.equal(second.collection.stats.recordsReads, 0);
      assert.equal(second.calls.savedProfiles.length, 0);
      assert.equal(await store.readProfile(), null);
    } finally {
      await second.app.close();
      await store.cleanup();
    }
  });

  it('R-B1.7 服务关闭取消进行中的画像任务；已授权回环模型下同步完成可自动刷新画像', async () => {
    const store = await createTempStore();
    let started;
    let release;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const releasePromise = new Promise((resolve) => { release = resolve; });
    let closeSignal = null;

    // 1) 服务关闭时取消进行中生成并阻止落库
    const closingHarness = await startHarness({
      store,
      settings: {
        allowPersonalData: true,
        baseURL: 'http://127.0.0.1:11434/v1',
        modelName: 'local-qwen',
      },
      generateImpl: async ({ snapshotId, signal }) => {
        closeSignal = signal;
        started();
        await releasePromise;
        return makeFakeProfile(snapshotId, '关闭后不应落库的画像');
      },
    });
    try {
      const inflight = closingHarness.app.refreshProfile('manual').catch((err) => err);
      await startedPromise;
      assert.equal(closeSignal.aborted, false);
      await closingHarness.app.close();
      assert.equal(closeSignal.aborted, true, 'close() 必须向进行中的画像生成器传递取消信号');
      release();
      const outcome = await inflight;
      assert.ok(outcome instanceof Error);
      assert.equal(closingHarness.calls.savedProfiles.length, 0);
      assert.equal(await store.readProfile(), null);
    } finally {
      release?.();
    }

    // 2) 开启个人材料 + 回环模型时，同步完成后自动触发画像刷新并落库
    const autoHarness = await startHarness({
      store,
      settings: {
        allowPersonalData: true,
        baseURL: 'http://127.0.0.1:11434/v1',
        modelName: 'local-qwen',
      },
    });
    try {
      const syncStart = await json(await post(autoHarness.base, '/api/collection/sync'));
      assert.equal(syncStart.status, 200);
      await waitForSyncFinished(autoHarness.base);
      const deadline = Date.now() + 1000;
      while (autoHarness.calls.savedProfiles.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(autoHarness.calls.generate.length, 1);
      assert.equal(autoHarness.calls.savedProfiles.length, 1);
      assert.equal((await store.readProfile())?.snapshotId, 'snap-syn-1');
    } finally {
      await autoHarness.app.close();
      await store.cleanup();
    }
  });
});

// ============================================================================
// F-B1 & F-B2 验收补测：旧画像外发边界 + 旧画像任务槽恢复 / 超时与取消合并
// ============================================================================

const FB1_MARKERS = Object.freeze({
  domain1: 'FB1_SECRET_DOMAIN_ALPHA',
  domain2: 'FB1_SECRET_DOMAIN_BETA',
  evidence1: 'FB1_SECRET_EVIDENCE_TITLE_01',
  topic1: 'FB1_SECRET_TOPIC_QUANTUM',
  topic2: 'FB1_SECRET_TOPIC_BIOTECH',
  summary: 'FB1_SECRET_SUMMARY_FINGERPRINT',
  shift: 'FB1_SECRET_SHIFT_MARKER',
  recordTitle: 'FB1_SECRET_COLLECTION_RECORD_TITLE',
});

function makeMarkedProfile(snapshotId = 'snap-fb1-existing') {
  return {
    version: PROFILE_VERSION,
    promptVersion: PROMPT_VERSION,
    generatedAt: '2026-11-26T09:00:00.000Z',
    snapshotId,
    syncedAt: '2026-11-26T00:00:00.000Z',
    model: 'local-qwen',
    coverage: { records: 2, counts: { history: 2, likes: 0, collections: 0 }, window: 'latest_50_qualified', completeHistory: false, includesFullText: false },
    summary: `本地画像摘要包含唯一标记 ${FB1_MARKERS.summary}`,
    domains: [
      { name: FB1_MARKERS.domain1, share: 0.6, evidence: [FB1_MARKERS.evidence1] },
      { name: FB1_MARKERS.domain2, share: 0.4, evidence: ['另一条证据'] },
    ],
    topics: [FB1_MARKERS.topic1, FB1_MARKERS.topic2],
    shifts: [FB1_MARKERS.shift],
    uncertainties: [],
  };
}

function createMutableSyntheticCollection({ items = [], snapshotId = null } = {}) {
  const base = createSyntheticCollection({ snapshotId: snapshotId ?? 'snap-empty' });
  let currentItems = [...items];
  let currentSnapshotId = snapshotId;
  let recordsReads = 0;

  return {
    ...base,
    get stats() {
      return { ...base.stats, recordsReads };
    },
    setSnapshot(nextSnapshotId, nextItems) {
      currentSnapshotId = nextSnapshotId;
      currentItems = [...nextItems];
    },
    status: () => ({
      userId: 'syn-user-b2',
      accountBound: true,
      settings: { history: true, likes: true, collections: false, knowledgeFilter: true, fetchFullText: false, aiReview: false },
      activeJob: null,
      devices: [],
      latestSnapshot: currentSnapshotId
        ? { snapshotId: currentSnapshotId, receivedAt: '2026-11-26T10:00:00.000Z' }
        : null,
    }),
    records: ({ offset = 0, limit = 20 } = {}) => {
      recordsReads += 1;
      const slice = currentItems.slice(offset, offset + limit);
      return {
        snapshotId: currentSnapshotId,
        receivedAt: currentSnapshotId ? '2026-11-26T10:00:00.000Z' : null,
        metadata: { counts: { history: currentItems.length, likes: 0, collections: 0 } },
        page: {
          offset,
          limit,
          total: currentItems.length,
          returned: slice.length,
          hasMore: offset + slice.length < currentItems.length,
          nextOffset: offset + slice.length < currentItems.length ? offset + slice.length : null,
        },
        items: slice,
      };
    },
  };
}

function assertNoProfileMarkers(text, label) {
  const haystack = String(text ?? '');
  for (const [key, marker] of Object.entries(FB1_MARKERS)) {
    assert.equal(haystack.includes(marker), false, `${label} 不得包含画像标记 ${key} (${marker})`);
  }
}

async function startInteractionHarness({
  store,
  env = {},
  settings = {},
  collection = createSyntheticCollection(),
  profile = makeMarkedProfile(),
  generateProfileImpl = null,
  profileTimeoutMs,
} = {}) {
  const calls = {
    searchArgs: [],
    interactionPrompts: [],
    askSystemPrompts: [],
    generate: [],
    savedProfiles: [],
  };

  const app = createWebServer({
    env,
    settings,
    loadConfig,
    describeConfig,
    collection,
    profile,
    syncPollMs: 25,
    ...(profileTimeoutMs !== undefined ? { profileTimeoutMs } : {}),
    persist: async (portion) => { if (store) await store.writeSettings(portion); },
    saveSecrets: async () => {},
    saveProfile: async (value) => {
      calls.savedProfiles.push(value);
      if (store) await store.writeProfile(value);
    },
    modelFactory: (modelConfig) => ({ fakeModel: true, baseURL: modelConfig.baseURL, modelName: modelConfig.modelName }),
    generate: async (args) => {
      calls.generate.push(args);
      if (generateProfileImpl) return generateProfileImpl(args);
      return makeFakeProfile(args.snapshotId, `生成于 ${args.modelName}（${args.records.length} 条）`);
    },
    createAgent: async (_cfg, { buildPrompt } = {}) => ({
      async ask(question) {
        const systemPrompt = typeof buildPrompt === 'function' ? buildPrompt({ enabled: ['search'] }) : '';
        calls.askSystemPrompts.push(systemPrompt);
        return { text: `ok:${question}`, stepCount: 1, toolCalls: [], history: [] };
      },
      async close() {},
    }),
    connectServers: async () => ({
      enabled: ['search'],
      tools: {
        zhihu_search: {
          execute: async (args) => {
            calls.searchArgs.push(args);
            return {
              structuredContent: {
                schemaVersion: 1,
                ok: true,
                data: {
                  items: [
                    {
                      title: `公开检索：${String(args.query ?? '').slice(0, 20)}`,
                      excerpt: '公开知乎检索摘要，用于 F-B1 验收。',
                      url: 'https://www.zhihu.com/question/999',
                      voteCount: 42,
                      author: '公开答主',
                    },
                  ],
                },
                error: null,
              },
            };
          },
        },
      },
      close: async () => {},
    }),
    generateInteractionText: async ({ prompt, instructions }) => {
      calls.interactionPrompts.push({ prompt, instructions });
      return {
        text: JSON.stringify({
          viewpoints: [
            { kind: 'profile_1', topic: '通用议题一', claim: '单一工具就能替代全部工程流程。', opponentName: '极简派', opponentIntro: '只看短期便利', coreFlaw: '忽略规模化边界', searchKeywords: ['工程流程'] },
            { kind: 'profile_2', topic: '通用议题二', claim: '直觉判断永远比数据分析更可靠。', opponentName: '直觉派', opponentIntro: '迷信个人经验', coreFlaw: '忽略幸存者偏差', searchKeywords: ['数据分析'] },
            { kind: 'hot', topic: '远程办公效率', claim: '远程办公必然导致团队效率彻底崩溃。', opponentName: '坐班主管', opponentIntro: '习惯面对面盯工位', coreFlaw: '混淆办公形态与协作规范', searchKeywords: ['远程办公'] },
          ],
        }),
      };
    },
  });

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, collection, calls };
}

describe('P0-B / F-B1 旧工作台画像与衍生标签外发边界验收', () => {
  it('F-B1.1 非回环模型 + allowPersonalData: true（demo: false 与 demo: true）：/api/interaction/topics 与 /api/ask 均零泄露画像标记，通用议题与本机展示可用，四入口画像门禁持续拦截', async () => {
    for (const demo of [false, true]) {
      const store = await createTempStore();
      const collection = createMutableSyntheticCollection({
        snapshotId: 'snap-fb1-new',
        items: [
          {
            contentId: 'rec-fb1-1',
            contentType: 'answer',
            title: FB1_MARKERS.recordTitle,
            summary: `记录摘要 ${FB1_MARKERS.summary}`,
            topics: [{ id: 't-fb1', name: FB1_MARKERS.topic1 }],
            domains: [FB1_MARKERS.domain1],
            kinds: ['history'],
            weight: 6.0,
          },
        ],
      });
      const harness = await startInteractionHarness({
        store,
        collection,
        profile: makeMarkedProfile('snap-fb1-old'),
        env: { ZHIHU_ACCESS_SECRET: 'syn-search-secret-fb1' },
        settings: {
          allowPersonalData: true,
          demo,
          baseURL: 'https://api.example.com/v1',
          modelName: 'cloud-model-fb1',
          apiKey: 'sk-synthetic-fb1-key',
        },
      });
      try {
        // 1) 调用 /api/interaction/topics
        const topicsResp = await json(await post(harness.base, '/api/interaction/topics', { refresh: false }));
        assert.equal(topicsResp.status, 200, `demo=${demo} 下通用议题应正常返回 200`);
        assert.equal(topicsResp.body.ok, true);
        assert.equal(topicsResp.body.data.profileUsed, false, `demo=${demo} 非回环模型不得使用画像生成议题`);
        assert.equal(topicsResp.body.data.profileSummary, null, '未获准外发时 profileSummary 应为空');
        assert.equal(topicsResp.body.data.viewpoints.length, 3, '通用议题应正常返回 3 个观点');

        assert.ok(harness.calls.searchArgs.length >= 2, '应捕获到模拟搜索参数');
        assert.ok(harness.calls.interactionPrompts.length >= 1, '应捕获到模拟模型输入');
        assertNoProfileMarkers(JSON.stringify(harness.calls.searchArgs), `F-B1.1(demo=${demo}) 模拟搜索参数`);
        assertNoProfileMarkers(JSON.stringify(harness.calls.interactionPrompts), `F-B1.1(demo=${demo}) 模拟模型输入`);
        assertNoProfileMarkers(JSON.stringify(topicsResp.body.data), `F-B1.1(demo=${demo}) 议题响应`);

        // 2) 调用 /api/ask 验证非回环模型系统提示词同样不注入旧画像
        const askResp = await json(await post(harness.base, '/api/ask', { question: '帮我分析一下今天的话题' }));
        assert.equal(askResp.status, 200);
        assert.equal(harness.calls.askSystemPrompts.length, 1);
        assertNoProfileMarkers(harness.calls.askSystemPrompts[0], `F-B1.1(demo=${demo}) /api/ask 系统提示词`);

        // 3) GET /api/profile 仍保留既有画像供本机展示
        const localProfile = await json(await fetch(`${harness.base}/api/profile`));
        assert.equal(localProfile.status, 200);
        assert.ok(localProfile.body.data.profile.summary.includes(FB1_MARKERS.summary), 'GET /api/profile 仍应保留本机画像用于展示');

        // 4) 复跑旧画像启动、同步完成、保存设置、手动刷新四入口门禁
        assert.equal(harness.app.maybeRefreshProfile('startup'), null);
        const syncStart = await json(await post(harness.base, '/api/collection/sync'));
        assert.equal(syncStart.status, 200);
        await waitForSyncFinished(harness.base);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const saved = await json(await post(harness.base, '/api/settings', {
          settings: {
            allowPersonalData: true,
            demo,
            baseURL: 'https://api.example.com/v1',
            modelName: 'cloud-model-fb1',
          },
        }));
        assert.equal(saved.status, 200);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const manual = await json(await post(harness.base, '/api/profile/refresh'));
        assert.equal(manual.status, 403);
        assert.equal(manual.body.error.code, 'CLOUD_CONSENT_REQUIRED');

        assert.equal(harness.calls.generate.length, 0, '非回环模型四入口画像生成必须为 0');
        assert.equal(harness.collection.stats.recordsReads, 0, '非回环模型不得读取采集记录');
        assert.equal(harness.calls.savedProfiles.length, 0);
      } finally {
        await harness.app.close();
        await store.cleanup();
      }
    }
  });

  it('F-B1.2 关闭个人材料（allowPersonalData: false）：交互与问答均零泄露画像标记、通用议题正常可用，四入口画像门禁均返回 0 调用', async () => {
    const store = await createTempStore();
    const harness = await startInteractionHarness({
      store,
      profile: makeMarkedProfile('snap-fb1-old'),
      settings: {
        allowPersonalData: false,
        demo: true,
        baseURL: 'http://127.0.0.1:11434/v1',
        modelName: 'local-qwen',
      },
    });
    try {
      const topicsResp = await json(await post(harness.base, '/api/interaction/topics', { refresh: false }));
      assert.equal(topicsResp.status, 200);
      assert.equal(topicsResp.body.data.profileUsed, false);
      assert.equal(topicsResp.body.data.profileSummary, null);
      assert.equal(topicsResp.body.data.viewpoints.length, 3);
      assertNoProfileMarkers(JSON.stringify(harness.calls.searchArgs), 'F-B1.2 模拟搜索参数');
      assertNoProfileMarkers(JSON.stringify(harness.calls.interactionPrompts), 'F-B1.2 模拟模型输入');

      const askResp = await json(await post(harness.base, '/api/ask', { question: '你好' }));
      assert.equal(askResp.status, 200);
      assertNoProfileMarkers(harness.calls.askSystemPrompts[0], 'F-B1.2 /api/ask 系统提示词');

      // 本机展示仍可见已有画像
      const localProfile = await json(await fetch(`${harness.base}/api/profile`));
      assert.equal(localProfile.status, 200);
      assert.ok(localProfile.body.data.profile.summary.includes(FB1_MARKERS.summary));

      // 复跑四入口门禁
      assert.equal(harness.app.maybeRefreshProfile('startup'), null);
      const syncStart = await json(await post(harness.base, '/api/collection/sync'));
      assert.equal(syncStart.status, 200);
      await waitForSyncFinished(harness.base);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const saved = await json(await post(harness.base, '/api/settings', {
        settings: {
          allowPersonalData: false,
          demo: true,
          baseURL: 'http://127.0.0.1:11434/v1',
          modelName: 'local-qwen',
        },
      }));
      assert.equal(saved.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const manual = await json(await post(harness.base, '/api/profile/refresh'));
      assert.equal(manual.status, 403);
      assert.equal(manual.body.error.code, 'PERSONAL_DATA_DISABLED');

      assert.equal(harness.calls.generate.length, 0);
      assert.equal(harness.collection.stats.recordsReads, 0);
      assert.equal(harness.calls.savedProfiles.length, 0);
    } finally {
      await harness.app.close();
      await store.cleanup();
    }
  });

  it('F-B1.3 回环模型 + allowPersonalData: true + demo: false（真实外部公开搜索）：交互不外发画像衍生标签、回退通用议题，同时回环问答本机提示词仍可使用本机画像', async () => {
    const store = await createTempStore();
    const harness = await startInteractionHarness({
      store,
      profile: makeMarkedProfile('snap-fb1-local'),
      env: { ZHIHU_ACCESS_SECRET: 'syn-search-secret-fb1' },
      settings: {
        allowPersonalData: true,
        demo: false,
        baseURL: 'http://127.0.0.1:11434/v1',
        modelName: 'local-qwen',
      },
    });
    try {
      const topicsResp = await json(await post(harness.base, '/api/interaction/topics', { refresh: false }));
      assert.equal(topicsResp.status, 200);
      assert.equal(topicsResp.body.data.profileUsed, false, '非 demo 外部公开检索未经已确认清单不得发送画像衍生标签');
      assert.equal(topicsResp.body.data.viewpoints.length, 3);
      assertNoProfileMarkers(JSON.stringify(harness.calls.searchArgs), 'F-B1.3 外部公开搜索参数');
      assertNoProfileMarkers(JSON.stringify(harness.calls.interactionPrompts), 'F-B1.3 交互模型输入');

      // 回环模型 + 开启个人材料的本机问答（不走外部搜索画像标签外发）仍可使用本机画像
      const askResp = await json(await post(harness.base, '/api/ask', { question: '总结我的阅读偏好' }));
      assert.equal(askResp.status, 200);
      assert.ok(harness.calls.askSystemPrompts[0].includes(FB1_MARKERS.summary), '已授权回环模型本机问答可使用本机画像');
    } finally {
      await harness.app.close();
      await store.cleanup();
    }
  });
});

describe('P1/P2 / F-B2 旧画像任务槽恢复、空快照缺数据与超时/取消合并验收', () => {
  it('F-B2.1 空快照手动刷新返回明确非 500 缺数据错误（409 NO_COLLECTION_RECORDS）且 0 模型调用；同进程补入记录后立即再次刷新成功落库', async () => {
    const store = await createTempStore();
    const collection = createMutableSyntheticCollection({ items: [], snapshotId: null });
    const harness = await startHarness({
      store,
      collection,
      settings: {
        allowPersonalData: true,
        baseURL: 'http://127.0.0.1:11434/v1',
        modelName: 'local-qwen',
      },
    });
    try {
      // 1) 空快照首次手动刷新
      const first = await json(await post(harness.base, '/api/profile/refresh'));
      assert.equal(first.status, 409, '空快照应返回明确非 500 缺数据状态（409）');
      assert.notEqual(first.status, 500);
      assert.equal(first.body.ok, false);
      assert.equal(first.body.error.code, 'NO_COLLECTION_RECORDS');
      assert.match(first.body.error.message, /还没有采集记录/);
      assert.equal(harness.calls.generate.length, 0, '空快照时模型调用必须严格为 0');
      assert.equal(harness.calls.savedProfiles.length, 0);
      assert.equal(await store.readProfile(), null);

      // 2) 在同一进程中向同一合成采集替身补入一条记录并更新快照
      collection.setSnapshot('snap-fb2-recovered', [SYNTHETIC_ITEMS[0]]);

      // 3) 立即再次调用 POST /api/profile/refresh，验证任务槽已可靠释放并恢复成功
      const second = await json(await post(harness.base, '/api/profile/refresh'));
      assert.equal(second.status, 200, '补入采集记录后同进程刷新必须成功 200');
      assert.equal(second.body.ok, true);
      assert.equal(second.body.data.state.status, 'ready');
      assert.equal(second.body.data.state.errorCode, null);
      assert.equal(second.body.data.profile.snapshotId, 'snap-fb2-recovered');
      assert.equal(harness.calls.generate.length, 1);
      assert.equal(harness.calls.savedProfiles.length, 1);

      const stored = await store.readProfile();
      assert.ok(stored, '恢复后的画像应成功落库');
      assert.equal(stored.snapshotId, 'snap-fb2-recovered');
    } finally {
      await harness.app.close();
      await store.cleanup();
    }
  });

  it('F-B2.2 延迟上游触发短超时（profileTimeoutMs: 60）：信号中止、任务槽释放、不发生延后落库，且后续正常请求可恢复成功', async () => {
    const store = await createTempStore();
    let mode = 'slow_ignore';
    let capturedSignal = null;
    let capturedTimeoutMs = null;

    const harness = await startInteractionHarness({
      store,
      profile: null,
      profileTimeoutMs: 60,
      settings: {
        allowPersonalData: true,
        baseURL: 'http://127.0.0.1:11434/v1',
        modelName: 'local-qwen',
      },
      generateProfileImpl: async ({ snapshotId, signal, timeoutMs }) => {
        capturedSignal = signal;
        capturedTimeoutMs = timeoutMs;
        if (mode === 'slow_ignore') {
          // 故意忽略 signal，延迟 160ms 后再 resolve，验证短超时中止且绝不延后落库
          await new Promise((resolve) => setTimeout(resolve, 160));
          return makeFakeProfile(snapshotId, '超时后延迟返回的画像（绝不可落库）');
        }
        return makeFakeProfile(snapshotId, '超时恢复后的正常画像');
      },
    });
    try {
      const timedOut = await json(await post(harness.base, '/api/profile/refresh'));
      assert.equal(timedOut.status, 504, '触发短超时应返回 504 TIMEOUT');
      assert.equal(timedOut.body.ok, false);
      assert.equal(timedOut.body.error.code, 'TIMEOUT');
      assert.equal(capturedTimeoutMs, 60);
      assert.ok(capturedSignal instanceof AbortSignal);
      assert.equal(capturedSignal.aborted, true, '短超时必须触发传给生成器的合并信号中止');
      assert.equal(capturedSignal.reason?.name, 'TimeoutError');

      // 等超过延迟上游的 160ms，确认绝不发生延后落库
      await new Promise((resolve) => setTimeout(resolve, 180));
      assert.equal(harness.calls.savedProfiles.length, 0, '超时后的延迟结果绝不能落库');
      assert.equal(await store.readProfile(), null, '磁盘不应写入超时后的延迟画像');

      const afterTimeout = await json(await fetch(`${harness.base}/api/profile`));
      assert.equal(afterTimeout.body.data.profile, null);
      assert.equal(afterTimeout.body.data.state.errorCode, 'TIMEOUT');

      // 切换为正常上游，验证任务槽已释放，同进程后续请求可立即恢复成功
      mode = 'fast';
      const recovered = await json(await post(harness.base, '/api/profile/refresh'));
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body.data.state.status, 'ready');
      assert.equal(recovered.body.data.profile.summary, '超时恢复后的正常画像');
      assert.equal(harness.calls.savedProfiles.length, 1);
      assert.equal((await store.readProfile())?.summary, '超时恢复后的正常画像');
    } finally {
      await harness.app.close();
      await store.cleanup();
    }
  });

  it('F-B2.2b 真实 generateProfile 同时接收外部取消信号与短超时（60ms）时，超时仍可靠生效且不落库', async () => {
    const store = await createTempStore();
    let observedAbortSignal = null;
    const harness = await startInteractionHarness({
      store,
      profile: null,
      profileTimeoutMs: 60,
      settings: {
        allowPersonalData: true,
        baseURL: 'http://127.0.0.1:11434/v1',
        modelName: 'local-qwen',
      },
      generateProfileImpl: (args) => generateProfile({
        ...args,
        generate: ({ abortSignal }) => {
          observedAbortSignal = abortSignal;
          return new Promise((_resolve, reject) => {
            if (abortSignal?.aborted) return reject(abortSignal.reason);
            abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
          });
        },
      }),
    });
    try {
      const resp = await json(await post(harness.base, '/api/profile/refresh'));
      assert.equal(resp.status, 504);
      assert.equal(resp.body.ok, false);
      assert.equal(resp.body.error.code, 'TIMEOUT');
      assert.ok(observedAbortSignal instanceof AbortSignal);
      assert.equal(observedAbortSignal.aborted, true);
      assert.equal(observedAbortSignal.reason?.name, 'TimeoutError');
      assert.equal(harness.calls.savedProfiles.length, 0);
      assert.equal(await store.readProfile(), null);
    } finally {
      await harness.app.close();
      await store.cleanup();
    }
  });

  it('F-B2.3 关闭设置主动终止延迟上游：signal.aborted 为 true、任务槽释放、不发生延后落库，重新开启后可正常恢复', async () => {
    const store = await createTempStore();
    let started;
    let release;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const releasePromise = new Promise((resolve) => { release = resolve; });
    let capturedSignal = null;
    let runCount = 0;

    const harness = await startInteractionHarness({
      store,
      profile: null,
      profileTimeoutMs: 5000,
      settings: {
        allowPersonalData: true,
        baseURL: 'http://127.0.0.1:11434/v1',
        modelName: 'local-qwen',
      },
      generateProfileImpl: async ({ snapshotId, signal }) => {
        runCount += 1;
        if (runCount === 1) {
          capturedSignal = signal;
          started();
          await releasePromise;
          // 故意忽略取消信号并延迟返回，验证绝不落库且不污染后续新任务
          return makeFakeProfile(snapshotId, '被关闭设置中止后延迟返回的画像');
        }
        return makeFakeProfile(snapshotId, '重新授权后生成的合法画像');
      },
    });
    try {
      const firstReq = post(harness.base, '/api/profile/refresh');
      await startedPromise;
      assert.ok(capturedSignal instanceof AbortSignal);
      assert.equal(capturedSignal.aborted, false);

      // 关闭个人材料设置，立即取消运行中的画像任务
      const disableResp = await json(await post(harness.base, '/api/settings', {
        settings: {
          allowPersonalData: false,
          baseURL: 'http://127.0.0.1:11434/v1',
          modelName: 'local-qwen',
        },
      }));
      assert.equal(disableResp.status, 200);
      assert.equal(capturedSignal.aborted, true, '关闭设置必须立即中止延迟上游信号');

      const firstResp = await json(await firstReq);
      assert.equal(firstResp.body.ok, false);
      assert.ok([403, 499].includes(firstResp.status));

      // 放行旧上游让其延后 resolve，并确认绝不落库
      release();
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(harness.calls.savedProfiles.length, 0);
      assert.equal(await store.readProfile(), null);

      // 重新开启个人材料并刷新：确认任务槽已释放，新任务正常成功落库
      const enableResp = await json(await post(harness.base, '/api/settings', {
        settings: {
          allowPersonalData: true,
          baseURL: 'http://127.0.0.1:11434/v1',
          modelName: 'local-qwen',
        },
      }));
      assert.equal(enableResp.status, 200);
      // 等待设置保存触发的自动刷新或主动刷新落库
      const deadline = Date.now() + 1000;
      while (harness.calls.savedProfiles.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const stored = await store.readProfile();
      assert.ok(stored, '重新授权后应可正常恢复画像生成并落库');
      assert.equal(stored.summary, '重新授权后生成的合法画像');
    } finally {
      release?.();
      await harness.app.close();
      await store.cleanup();
    }
  });
});
