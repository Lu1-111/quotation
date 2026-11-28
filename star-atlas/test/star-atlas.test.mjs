import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createStarAtlasApp } from '../src/app.mjs';
import { collectSelectedData } from '../src/collector/zhihu-sources.mjs';
import { createDetailCache } from '../src/collector/history-data.mjs';
import { createPlanetsDatabase, PLANETS_DB_FORMAT_DECLARATION } from '../src/db/planets-db.mjs';
import { createStarMapStore } from '../src/db/star-map-store.mjs';
import { createUserDatabase, USER_DB_FORMAT_DECLARATION } from '../src/db/user-db.mjs';
import { computeVisualMetricsFromWeight, createStarWriterAgent } from '../src/agents/star-writer-agent.mjs';
import { convertRecordsWithFallbackRules } from '../src/agents/converter-agent.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'star-atlas-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('用户数据库与星球数据库均包含前置格式声明且支持原子读写与自增编号', async () => {
  await withTempDir(async (dir) => {
    const userDb = createUserDatabase(path.join(dir, 'user-db.json'));
    const planetsDb = createPlanetsDatabase(path.join(dir, 'planets-db.json'));

    await userDb.ensureInitialized();
    await planetsDb.ensureInitialized();

    const rawUser = JSON.parse(await readFile(userDb.filePath, 'utf8'));
    assert.equal(rawUser.$formatDeclaration.database, USER_DB_FORMAT_DECLARATION.database);
    assert.equal(Object.keys(rawUser)[0], '$formatDeclaration', '格式声明应位于用户数据库最前置字段');
    assert.equal(rawUser.schemaVersion, 3);

    const rawPlanets = JSON.parse(await readFile(planetsDb.filePath, 'utf8'));
    assert.equal(rawPlanets.$formatDeclaration.database, PLANETS_DB_FORMAT_DECLARATION.database);
    assert.equal(Object.keys(rawPlanets)[0], '$formatDeclaration', '格式声明应位于星球数据库最前置字段');

    const { added } = await planetsDb.addPlanets([
      {
        domain: '人工智能',
        knowledgePoint: 'GRPO 组内相对策略优化',
        summary: '通过组内相对奖励归一化替代 Critic 价值网络以降低显存开销。',
        weight: 88,
      },
      {
        domain: '物理学',
        knowledgePoint: '量子无通信定理',
        summary: '约化密度矩阵不受远端测量基选择影响，因果律在量子纠缠下依然严格成立。',
        weight: 76,
      },
    ]);

    assert.equal(added.length, 2);
    assert.equal(added[0].id, 'PL-0001');
    assert.equal(added[1].id, 'PL-0002');
    assert.equal(added[0].status, 'pending');
  });
});

test('采集并发加速基准：模拟 50 条初次采集显著低于 15 秒，增量同步显著低于 10 秒', async () => {
  await withTempDir(async (dir) => {
    const now = Math.floor(Date.now() / 1000);
    const items50 = Array.from({ length: 50 }, (_, idx) => ({
      data: {
        header: { title: `知识点测试文章 ${idx + 1}` },
        content: { summary: `关于计算机系统与算法优化的深度解析 ${idx + 1}`, author_name: '作者' },
        extra: { content_token: String(1000 + idx), content_type: 'answer', read_time: now - idx * 60 },
      },
    }));

    let detailRequests = 0;
    const mockGateway = {
      async request(urlPath) {
        if (urlPath.includes('read_history')) {
          return { data: items50, paging: { is_end: true } };
        }
        // 模拟每次详情网络耗时 100ms（原串行 1000ms+100ms 需 55 秒，并发 6 路仅需 ~1.5 秒）
        detailRequests += 1;
        await new Promise((r) => setTimeout(r, 100));
        const id = urlPath.split('/').pop().split('?')[0];
        return {
          id,
          voteup_count: 120,
          comment_count: 18,
          excerpt: `关于系统优化的详细摘要 ${id}`,
          question: { title: `知识点测试文章 ${id}`, topics: [{ id: 'ai', name: '人工智能' }] },
        };
      },
    };

    const cache = createDetailCache(path.join(dir, 'detail-cache.json'));
    const t0 = Date.now();
    const initial = await collectSelectedData(
      mockGateway,
      { id: 'u1', slug: 'u1' },
      { history: true, likes: false, collections: false, knowledgeFilter: true, fetchFullText: false },
      { cache, concurrency: 6, batchPauseMs: 50, enrichBudgetMs: 8000 },
    );
    const initialMs = Date.now() - t0;

    assert.equal(initial.items.length, 50);
    assert.equal(initial.mode, 'initial');
    assert.ok(initialMs < 15_000, `初次 50 条采集应 <= 15s，实际 ${initialMs}ms`);
    assert.ok(detailRequests > 0);

    // 增量同步（全部命中已有记录，应极速完成且不再重复请求详情）
    const prevDetailCalls = detailRequests;
    const t1 = Date.now();
    const incremental = await collectSelectedData(
      mockGateway,
      { id: 'u1', slug: 'u1' },
      { history: true, likes: false, collections: false, knowledgeFilter: true, fetchFullText: false },
      { cache, previous: { records: initial.items }, concurrency: 6, batchPauseMs: 50, enrichBudgetMs: 4000 },
    );
    const incMs = Date.now() - t1;

    assert.equal(incremental.mode, 'incremental');
    assert.equal(incremental.items.length, 50);
    assert.equal(detailRequests, prevDetailCalls, '增量同步应复用已有记录不发多余详情请求');
    assert.ok(incMs < 10_000, `增量同步应 <= 10s，实际 ${incMs}ms`);
  });
});

test('数据转换规则：严格过滤网文与日常噪音并提炼知识点', () => {
  const sampleRecords = [
    {
      key: 'answer:1',
      title: '从 PPO 到 GRPO：DeepSeek-R1 为什么能用组内相对优势替代 Critic 网络？',
      summary: '对比 Actor-Critic 与 GRPO 组内归一化奖励估计，说明 KL 散度约束如何防止策略坍缩。',
      topics: [{ name: '强化学习' }, { name: 'AI' }],
      weight: 5.4,
    },
    {
      key: 'answer:2',
      title: '穿越回古代带着无限超市系统，第一天怎么震惊皇帝？',
      summary: '我穿越过去刚绑定系统就掏出一瓶冰镇可乐，皇帝当场封我为镇国公。',
      topics: [{ name: '网文' }, { name: '爽文' }],
      weight: 4.1,
    },
    {
      key: 'pin:3',
      title: '晒一下今天的午饭日常，楼下黄焖鸡真香',
      summary: '今天心情不错，吃完午饭去喝了杯冰美式。',
      topics: [{ name: '日常' }],
      weight: 2.0,
    },
  ];

  const { planets, discarded } = convertRecordsWithFallbackRules(sampleRecords);
  assert.equal(planets.length, 1);
  assert.equal(discarded.length, 2);
  assert.equal(planets[0].domain, '人工智能');
  assert.ok(!planets[0].knowledgePoint.includes('？'), '提炼知识点不应直接照搬疑问句帖子标题');
});

test('星图写入 Agent：语义领域归并（AI=人工智能）、动态新开星系、分支同色异色、跨分支连线与权重单调视觉映射', async () => {
  await withTempDir(async (dir) => {
    const planetsDb = createPlanetsDatabase(path.join(dir, 'planets-db.json'));
    const starMapStore = createStarMapStore(path.join(dir, 'star-map.json'));
    await planetsDb.ensureInitialized();
    await starMapStore.ensureInitialized();

    const writer = createStarWriterAgent({
      planetsDb,
      starMapStore,
      getModel: async () => ({ model: null, modelName: null }),
    });
    writer.startWatching();

    // 1. 写入两条同属人工智能（但一条标“人工智能”，一条标“AI”！）且属于不同分支的知识点 + 一条同分支知识点
    await planetsDb.addPlanets([
      {
        domain: '人工智能',
        knowledgePoint: '视觉语言投影对齐',
        summary: '通过投影层与高分辨率切片将图像 Token 对齐到语言模型隐空间。',
        weight: 92,
      },
      {
        domain: 'AI',
        knowledgePoint: 'CLIP 图文对比学习',
        summary: '使用对称 InfoNCE 损失构造多模态图文共享嵌入空间。',
        weight: 60,
      },
      {
        domain: 'AI',
        knowledgePoint: 'GRPO 组内相对策略优化',
        summary: '在强化学习中用组内相对奖励归一化替代 Critic 价值网络并引入 KL 散度约束。',
        weight: 86,
      },
    ]);
    await writer.processPending();

    let map = await starMapStore.read();
    // 语义归并校验：虽然领域字段一个是“人工智能”、两个是“AI”，但只能有 1 个星系！
    assert.equal(map.galaxies.length, 1, '语义相同的“人工智能”与“AI”必须归入同一个星系');
    assert.equal(map.planets.length, 3);

    const vlm = map.planets.find((p) => p.knowledgePoint === '视觉语言投影对齐');
    const clip = map.planets.find((p) => p.knowledgePoint === 'CLIP 图文对比学习');
    const grpo = map.planets.find((p) => p.knowledgePoint === 'GRPO 组内相对策略优化');

    // 同分支同色校验
    assert.equal(vlm.branchId, clip.branchId, '两条多模态知识点应归入同一分支');
    assert.deepEqual(vlm.color, clip.color, '同分支星球颜色必须完全一致');

    // 不同分支异色校验
    assert.notEqual(vlm.branchId, grpo.branchId, '多模态与强化学习应划分为不同分支');
    assert.notDeepEqual(vlm.color, grpo.color, '不同分支星球颜色必须不同');

    // 当前暂取消大小和亮度区分：所有星球 sizeFactor 与 brightness 保持统一（weight 仍如实保留）
    assert.equal(vlm.sizeFactor, 1, '当前暂取消大小区分，所有星球 sizeFactor 统一为 1');
    assert.equal(clip.sizeFactor, 1);
    assert.equal(vlm.brightness, 1, '当前暂取消亮度区分，所有星球 brightness 统一为 1');
    assert.equal(clip.brightness, 1);
    const lowM = computeVisualMetricsFromWeight(20);
    const highM = computeVisualMetricsFromWeight(95);
    assert.equal(lowM.sizeFactor, highM.sizeFactor);
    assert.equal(lowM.brightness, highM.brightness);

    // 2. 写入一个全新领域（数学与信息论，且与 GRPO 共享 KL 散度概念）-> 应开辟第 2 个星系并产生跨分支连线
    await planetsDb.addPlanets([
      {
        domain: '数学与信息论',
        knowledgePoint: '香农信息熵与 KL 散度',
        summary: '刻画信息不确定度与概率分布差异的相对熵 KL 散度，是交叉熵与策略约束的核心。',
        weight: 84,
      },
    ]);
    await writer.processPending();

    map = await starMapStore.read();
    assert.equal(map.galaxies.length, 2, '明显属于尚不存在的新领域时应开辟新星系');
    const crossLinks = map.links.filter((l) => l.crossBranch);
    assert.ok(crossLinks.length >= 1, '应支持不同分支/领域间确有关联的知识点连线');

    // 3. 再次写入同属新领域（但字面写“概率论”）-> 应归入刚开辟的第 2 个星系，而不新开第 3 个星系
    await planetsDb.addPlanets([
      {
        domain: '概率论',
        knowledgePoint: '贝叶斯后验更新',
        summary: '结合先验概率与似然比对事件置信度进行动态更新。',
        weight: 70,
      },
    ]);
    await writer.processPending();

    map = await starMapStore.read();
    assert.equal(map.galaxies.length, 2, '后续同语义领域知识点应自动归入已有星系');
    assert.equal(map.planets.length, 5);

    // 4. 验证直接修改 planets-db.json 文件也能触发监听写入
    const diskJson = JSON.parse(await readFile(planetsDb.filePath, 'utf8'));
    diskJson.records.push({
      id: 'PL-0099',
      domain: '生物医学',
      knowledgePoint: 'CRISPR-Cas9 基因编辑',
      summary: '通过引导 RNA 与 PAM 序列精准定位并切割目标 DNA 双链。',
      weight: 80,
      status: 'pending',
    });
    await writeFile(planetsDb.filePath, JSON.stringify(diskJson, null, 2), 'utf8');
    await writer.processPending();

    map = await starMapStore.read();
    assert.equal(map.galaxies.length, 3, '外部写入全新领域后应实时开辟第 3 个星系');
    assert.ok(map.planets.some((p) => p.id === 'PL-0099'));

    writer.stopWatching();
  });
});

test('端到端 HTTP 服务：演示采集 -> 用户库 -> 画像 Agent + 数据转换 Agent -> 星球库 -> 星图写入 Agent 全链路闭环', async () => {
  await withTempDir(async (dir) => {
    const app = await createStarAtlasApp({
      dataDir: path.join(dir, 'data'),
      secretsDir: path.join(dir, '.data'),
      getModelOverride: async () => ({ model: null, modelName: null }),
    });

    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const port = app.server.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 第一轮演示采集（初次）
      const sync1 = await fetch(`${base}/api/collection/sync-demo`, { method: 'POST' }).then((r) => r.json());
      assert.equal(sync1.syncStats.mode, 'initial');
      assert.equal(sync1.syncStats.withinBudget, true);

      const [userDb, planetsDb, starMap, profileRes] = await Promise.all([
        fetch(`${base}/api/user-db`).then((r) => r.json()),
        fetch(`${base}/api/planets`).then((r) => r.json()),
        fetch(`${base}/api/starmap`).then((r) => r.json()),
        fetch(`${base}/api/profile`).then((r) => r.json()),
      ]);

      assert.ok(userDb.$formatDeclaration, '用户库接口返回包含前置格式说明');
      assert.ok(planetsDb.$formatDeclaration, '星球库接口返回包含前置格式说明');
      assert.ok(profileRes.profile?.summary, '采集结束后画像 Agent 自动同步生成画像');
      assert.ok(planetsDb.records.length >= 10, '数据转换 Agent 应提炼出有效知识星球');
      assert.ok(
        planetsDb.records.every((r) => !/穿越|黄焖鸡|明星直播|笑死我了/.test(r.knowledgePoint)),
        '星球库不得包含网文/日常/八卦噪音',
      );
      assert.equal(starMap.planets.length, planetsDb.records.length, '星图写入 Agent 应实时将全部星球写入 3D 星图');
      assert.ok(starMap.galaxies.length >= 3, '多领域数据应自动划分出合理数量的星系');
      assert.ok(planetsDb.records.every((r) => r.status === 'placed'));
      assert.ok(
        planetsDb.records.every((r) => Array.isArray(r.sources) && r.sources.length >= 1 && r.sources[0].title),
        '每颗从帖子归纳出的星球都应携带结构化出处（sources）',
      );
      assert.ok(
        starMap.planets.every((p) => Array.isArray(p.sources) && p.sources.length >= 1 && p.sources[0].title),
        '星图节点应透传结构化出处供详情卡展示',
      );

      // 第二轮演示采集（增量：新增 AI 同义领域与全新生物医学领域）
      const prevGalaxies = starMap.galaxies.length;
      const sync2 = await fetch(`${base}/api/collection/sync-demo`, { method: 'POST' }).then((r) => r.json());
      assert.equal(sync2.syncStats.mode, 'incremental');
      assert.equal(sync2.syncStats.withinBudget, true);

      const starMap2 = await fetch(`${base}/api/starmap`).then((r) => r.json());
      assert.ok(starMap2.planets.length > starMap.planets.length, '增量同步应新增星球');
      assert.equal(starMap2.galaxies.length, prevGalaxies + 1, '新增的 AI 归入已有星系，仅生物医学新开 1 个星系');

      // 手动通过 API 写入一条领域写为“AI”的知识点，验证实时落星图且不重复建星系
      const manual = await fetch(`${base}/api/planets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain: 'AI',
          knowledgePoint: 'FlashAttention IO 感知分块计算',
          summary: '通过 SRAM 分块融合 Softmax 减少 HBM 显存读写，实现线性显存复杂度的精确注意力。',
          weight: 94,
        }),
      }).then((r) => r.json());

      assert.equal(manual.added.length, 1);
      assert.equal(manual.writerResult.totalGalaxies, starMap2.galaxies.length, '手动写入“AI”应语义归入已有人工智能星系');
    } finally {
      await app.close();
    }
  });
});
