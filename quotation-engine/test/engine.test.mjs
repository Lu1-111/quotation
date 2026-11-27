import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ASSESSMENTS,
  PROTOCOL_VERSION,
  QUOTE_SCHEMA_VERSION,
  RATE_INTERPRETATION_NOTE,
  brightness,
  collapseAfter,
  compareStatementsOnGraph,
  computeGraph,
  evaluateStatementQuote,
  quote,
  topologicalSortNodes,
  validateDag,
  validateGraph,
} from '../index.mjs';

import {
  brightness as frontendBrightness,
  collapseAfter as frontendCollapseAfter,
  computeGraph as frontendComputeGraph,
} from '../../frontend-design/web/src/starfield.js';
import { graph as frontendCaseGraph } from '../../frontend-design/web/src/quotation-case.js';
import {
  ASSESSMENTS as protocolAssessments,
  PROTOCOL_VERSION as backendProtocolVersion,
  RATE_INTERPRETATION_NOTE as protocolInterpretationNote,
} from '../../agent/protocol.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = join(__dirname, '..');

// 对齐合成 5 节点音乐推荐判断图（taste=3, friend=1, example=1, change=0, possible=0, 分母=5）
const MUSIC_CASE_NODES = [
  {
    id: 'taste',
    name: '初期发现新乐队',
    text: '我刚开始用推荐页时，确实顺着它发现过好几个没听过的小众乐队。',
    cluster: 'music',
    deps: [],
  },
  {
    id: 'friend',
    name: '朋友歌单分享',
    text: '朋友交换的歌单也让我喜欢上了原先不听的曲风。',
    cluster: 'music',
    deps: [],
  },
  {
    id: 'example',
    name: '初期拓宽反例',
    text: '以我自己的初期经历为例，推荐至少有过拓宽音乐口味的作用。',
    cluster: 'music',
    deps: ['taste'],
  },
  {
    id: 'change',
    name: '口味有过拓展',
    text: '我的音乐口味有过拓展的经历。',
    cluster: 'music',
    deps: ['taste', 'friend'],
  },
  {
    id: 'possible',
    name: '给拓宽情形留位置',
    text: '讨论推荐的影响时，需要给初期拓宽兴趣的情形留出位置。',
    cluster: 'music',
    deps: ['example'],
  },
];

test('《实施方案》第二节基准算例：承重 2,1,0,1,0、分母 4、冲突 B 得 25%、冲突 A 得 75%', () => {
  // A 支撑 B (B.deps=['A'])，B 支撑 C (C.deps=['B'])，另有 D 支撑 E (E.deps=['D'])
  const planNodes = [
    { id: 'A', text: '判断 A（根基）', cluster: 'c1', deps: [] },
    { id: 'B', text: '判断 B（依赖 A）', cluster: 'c1', deps: ['A'] },
    { id: 'C', text: '判断 C（依赖 B）', cluster: 'c1', deps: ['B'] },
    { id: 'D', text: '判断 D（独立根基）', cluster: 'c2', deps: [] },
    { id: 'E', text: '判断 E（依赖 D）', cluster: 'c2', deps: ['D'] },
  ];

  const computed = computeGraph(planNodes);
  assert.deepEqual(
    computed.map((n) => n.S),
    [2, 1, 0, 1, 0],
  );
  assert.deepEqual(
    computed.map((n) => n.d),
    [0, 1, 2, 0, 1],
  );

  // 只直接冲突于 B -> C 连带失去依据 -> 分子 1 / 分母 4 -> 25%
  const quoteB = evaluateStatementQuote({
    graph: computed,
    graphVersion: 1,
    statementId: 'stmt_conflict_b',
    text: '某句仅与 B 直接冲突的话。',
    assessment: 'conflict',
    directConflicts: ['B'],
    reason: '经核验仅直接冲突于节点 B，节点 C 因唯一依据失效而连带坍塌。',
    conflictReasons: [{ nodeId: 'B', reason: '与本人已确认判断 B 矛盾', evidenceIds: ['ev_b'] }],
    verifiedEvidenceIds: ['ev_b'],
  });
  assert.equal(quoteB.denominator, 4);
  assert.equal(quoteB.numerator, 1);
  assert.equal(quoteB.rate, 25);
  assert.deepEqual(quoteB.directConflicts, ['B']);
  assert.deepEqual(quoteB.collateral, ['C']);
  assert.deepEqual(quoteB.affected, ['B', 'C']);
  assert.equal(quoteB.interpretationNote, RATE_INTERPRETATION_NOTE);

  // 同图上另一句只直接冲突于 A -> B、C 连带受影响 -> 分子 3 / 分母 4 -> 75%
  const quoteA = evaluateStatementQuote({
    graph: computed,
    graphVersion: 1,
    statementId: 'stmt_conflict_a',
    text: '同图上仅与 A 直接冲突的话。',
    assessment: 'conflict',
    directConflicts: ['A'],
    reason: '经核验直接冲突于根基 A，导致 B 与 C 级联失去支撑。',
    verifiedEvidenceIds: ['ev_a'],
  });
  assert.equal(quoteA.denominator, 4);
  assert.equal(quoteA.numerator, 3);
  assert.equal(quoteA.rate, 75);
  assert.deepEqual(quoteA.directConflicts, ['A']);
  assert.deepEqual(quoteA.collateral, ['B', 'C']);
  assert.deepEqual(quoteA.affected, ['A', 'B', 'C']);
});

test('过半失效阈值边界：恰好保留一半依据（1/2、2/4）继续存活，严格少于一半（1/3、1/4）才坍塌', () => {
  const thresholdGraph = computeGraph([
    { id: 'p1', text: '支柱 1', cluster: 1, deps: [] },
    { id: 'p2', text: '支柱 2', cluster: 1, deps: [] },
    { id: 'p3', text: '支柱 3', cluster: 1, deps: [] },
    { id: 'p4', text: '支柱 4', cluster: 1, deps: [] },
    { id: 'half2', text: '双支柱判断', cluster: 1, deps: ['p1', 'p2'] },
    { id: 'three', text: '三支柱判断', cluster: 1, deps: ['p1', 'p2', 'p3'] },
    { id: 'half4', text: '四支柱判断', cluster: 1, deps: ['p1', 'p2', 'p3', 'p4'] },
  ]);

  // 损 1 根支柱：half2 剩 1/2 (0.5) 存活，three 剩 2/3 存活，half4 剩 3/4 存活
  const dead1 = collapseAfter(['p1'], thresholdGraph);
  assert.equal(dead1.has('half2'), false);
  assert.equal(dead1.has('three'), false);
  assert.equal(dead1.has('half4'), false);

  // 损 2 根支柱：half2 剩 0/2 坍塌；three 剩 1/3 (< 0.5) 坍塌；half4 剩 2/4 (=== 0.5) 必须继续存活！
  const dead2 = collapseAfter(new Set(['p1', 'p2']), thresholdGraph);
  assert.equal(dead2.has('half2'), true);
  assert.equal(dead2.has('three'), true);
  assert.equal(dead2.has('half4'), false);

  // 损 3 根支柱：half4 剩 1/4 (< 0.5) 坍塌
  const dead3 = collapseAfter(['p1', 'p2', 'p3'], thresholdGraph);
  assert.equal(dead3.has('half4'), true);

  // 空/null 输入安全
  assert.deepEqual([...collapseAfter(null, thresholdGraph)], []);
});

test('边界口径：叶节点冲突（rate=0 仍保留冲突）、零分母稀疏图（rate=null）、无证据未定与相容', () => {
  const graph = computeGraph(MUSIC_CASE_NODES); // denominator = 5, change.S = 0, possible.S = 0

  // 1. 仅冲突于 S=0 的叶节点 possible：rate 为 0，但 directConflicts 与 affected 完整保留
  const leafConflict = evaluateStatementQuote({
    graph,
    graphVersion: 2,
    statementId: 'stmt_leaf',
    text: '讨论推荐影响时不必给初期拓宽留位置。',
    assessment: 'conflict',
    directConflicts: ['possible'],
    reason: '与叶节点 possible 直接矛盾，但该叶节点无下游承重，结构损失比例为 0%。',
    conflictReasons: ['直接否定叶判断 possible'],
    verifiedEvidenceIds: ['ev_turn_6'],
  });
  assert.equal(leafConflict.assessment, 'conflict');
  assert.equal(leafConflict.numerator, 0);
  assert.equal(leafConflict.denominator, 5);
  assert.equal(leafConflict.rate, 0);
  assert.deepEqual(leafConflict.directConflicts, ['possible']);
  assert.deepEqual(leafConflict.collateral, []);
  assert.deepEqual(leafConflict.affected, ['possible']);
  assert.deepEqual(leafConflict.conflictReasons, ['直接否定叶判断 possible']);

  // 2. 零分母无边稀疏图：存在已核验冲突时 rate = null，仍保留 directConflicts 与理由
  const sparseNodes = [
    { id: 'solo_1', text: '我第一周用推荐页发现过两支独立乐队。', cluster: 'music', deps: [] },
    { id: 'solo_2', text: '我平时也会按专辑年份自己搜歌。', cluster: 'music', deps: [] },
  ];
  const sparseConflict = evaluateStatementQuote({
    graph: sparseNodes,
    graphVersion: 1,
    statementId: 'stmt_sparse_conflict',
    text: '推荐算法从来没帮人发现过新乐队。',
    assessment: 'conflict',
    directConflicts: ['solo_1'],
    reason: '与本人已确认经历 solo_1 直接冲突；当前图尚无支撑边（分母为 0），不折算百分比。',
    conflictReasons: [{ nodeId: 'solo_1', reason: '本人第一周即通过推荐发现过新乐队', evidenceIds: ['ev_1'] }],
    verifiedEvidenceIds: ['ev_1'],
  });
  assert.equal(sparseConflict.assessment, 'conflict');
  assert.equal(sparseConflict.denominator, 0);
  assert.equal(sparseConflict.numerator, 0);
  assert.equal(sparseConflict.rate, null);
  assert.deepEqual(sparseConflict.directConflicts, ['solo_1']);
  assert.deepEqual(sparseConflict.affected, ['solo_1']);
  assert.equal(sparseConflict.conflictReasons.length, 1);

  // 零分母图上的相容判断：rate 也为 null
  const sparseCompatible = evaluateStatementQuote({
    graph: sparseNodes,
    graphVersion: 1,
    statementId: 'stmt_sparse_ok',
    text: '有时自己搜歌也能找到好专辑。',
    assessment: 'compatible',
    reason: '与已知孤立判断相容，但全图承重分母为 0。',
  });
  assert.equal(sparseCompatible.rate, null);
  assert.deepEqual(sparseCompatible.directConflicts, []);

  // 3. 有边图上的相容判断：rate = 0
  const normalCompatible = evaluateStatementQuote({
    graph,
    graphVersion: 2,
    statementId: 'stmt_compatible',
    text: '推荐在初期确实可能拓宽口味。',
    assessment: 'compatible',
    reason: '与本人已确认经历一致，无冲突。',
    verifiedEvidenceIds: ['ev_turn_4'],
  });
  assert.equal(normalCompatible.rate, 0);
  assert.equal(normalCompatible.denominator, 5);
  assert.deepEqual(normalCompatible.directConflicts, []);

  // 4. 无证据未定（insufficient_evidence）：rate = null，绝不预设降分或残留冲突列表
  const insufficient = evaluateStatementQuote({
    graph,
    graphVersion: 2,
    statementId: 'stmt_unknown',
    text: '深夜十二点后推荐池会自动缩窄一半。',
    assessment: 'insufficient_evidence',
    directConflicts: ['taste'], // 即便上层误传已存在节点，insufficient_evidence 口径下也必须清空冲突集合
    reason: '当前个人记录与公开搜索均无关于深夜时段策略核验材料，保持未定。',
  });
  assert.equal(insufficient.assessment, 'insufficient_evidence');
  assert.equal(insufficient.rate, null);
  assert.equal(insufficient.numerator, 0);
  assert.equal(insufficient.denominator, 5);
  assert.deepEqual(insufficient.directConflicts, []);
  assert.deepEqual(insufficient.collateral, []);
  assert.deepEqual(insufficient.affected, []);
  assert.deepEqual(insufficient.conflictReasons, []);
});

test('环路检测、悬空引用、重复依赖拦截与非拓扑序合法 DAG 稳定排序', () => {
  // 空图开关
  assert.equal(validateGraph([]).ok, false);
  assert.equal(validateGraph([], { allowEmpty: true }).ok, true);
  assert.deepEqual(validateDag([]), { ok: true, errors: [], sortedNodes: [] });
  assert.equal(validateDag([], { allowEmpty: false }).ok, false);
  assert.deepEqual(computeGraph([]), []);

  // 自环
  const selfLoop = [{ id: 'a', text: '自环节点', cluster: 'c', deps: ['a'] }];
  assert.equal(validateGraph(selfLoop).ok, false);
  const selfDag = validateDag(selfLoop);
  assert.equal(selfDag.ok, false);
  assert.ok(selfDag.errors.some((e) => e.includes('自环') || e.includes('自身')));

  // 二元环
  const twoCycle = [
    { id: 'a', text: '节点 A', cluster: 'c', deps: ['b'] },
    { id: 'b', text: '节点 B', cluster: 'c', deps: ['a'] },
  ];
  const twoDag = validateDag(twoCycle);
  assert.equal(twoDag.ok, false);
  assert.ok(twoDag.errors.some((e) => e.includes('循环依赖')));
  assert.throws(
    () => topologicalSortNodes(twoCycle),
    (err) => err.code === 'INVALID_GRAPH' && err.message.includes('循环依赖'),
  );

  // 三元环
  const threeCycle = [
    { id: 'n1', text: '节点 1', cluster: 'c', deps: ['n3'] },
    { id: 'n2', text: '节点 2', cluster: 'c', deps: ['n1'] },
    { id: 'n3', text: '节点 3', cluster: 'c', deps: ['n2'] },
  ];
  const threeDag = validateDag(threeCycle);
  assert.equal(threeDag.ok, false);
  assert.ok(threeDag.errors.some((e) => e.includes('n1 -> n2 -> n3 -> n1')));
  assert.throws(() => computeGraph(threeCycle), { code: 'INVALID_GRAPH' });

  // 悬空引用与重复依赖
  const danglingAndDup = [
    { id: 'a', text: '根', cluster: 'c', deps: [] },
    { id: 'b', text: '子', cluster: 'c', deps: ['a', 'a', 'ghost'] },
  ];
  const badDag = validateDag(danglingAndDup);
  assert.equal(badDag.ok, false);
  assert.ok(badDag.errors.some((e) => e.includes('重复依赖')));
  assert.ok(badDag.errors.some((e) => e.includes('不存在的节点：ghost')));

  // 非拓扑序合法 DAG：子判断排在父判断之前
  const shuffledNodes = [
    { id: 'possible', text: '讨论推荐的影响时，需要给初期拓宽兴趣的情形留出位置。', cluster: 'music', deps: ['example'] },
    { id: 'change', text: '我的音乐口味有过拓展的经历。', cluster: 'music', deps: ['taste', 'friend'] },
    { id: 'taste', text: '我刚开始用推荐页时，确实顺着它发现过好几个没听过的小众乐队。', cluster: 'music', deps: [] },
    { id: 'example', text: '以我自己的初期经历为例，推荐至少有过拓宽音乐口味的作用。', cluster: 'music', deps: ['taste'] },
    { id: 'friend', text: '朋友交换的歌单也让我喜欢上了原先不听的曲风。', cluster: 'music', deps: [] },
  ];
  // validateGraph 要求严格输入拓扑序，应拒绝前向依赖
  assert.equal(validateGraph(shuffledNodes).ok, false);
  // validateDag 接受非拓扑序 DAG 并产出合法拓扑序
  const dagRes = validateDag(shuffledNodes);
  assert.equal(dagRes.ok, true);
  assert.equal(validateGraph(dagRes.sortedNodes).ok, true);

  // computeGraph 对打乱顺序的同一张 DAG 算出的各节点 S 与 d 必须与正序图完全一致
  const expectedById = new Map(computeGraph(MUSIC_CASE_NODES).map((n) => [n.id, n]));
  const fromShuffledById = new Map(computeGraph(shuffledNodes).map((n) => [n.id, n]));
  for (const [id, exp] of expectedById.entries()) {
    const got = fromShuffledById.get(id);
    assert.equal(got.S, exp.S);
    assert.equal(got.d, exp.d);
    assert.deepEqual(got.depsOf, exp.depsOf);
  }

  // evaluateStatementQuote 拦截不存在的冲突节点 ID（默认抛错，可选忽略）
  assert.throws(
    () =>
      evaluateStatementQuote({
        graph: MUSIC_CASE_NODES,
        statementId: 'stmt_bad_conflict',
        assessment: 'conflict',
        directConflicts: ['taste', 'non_existent_node'],
      }),
    (err) => err.code === 'INVALID_CONFLICT_NODE' && err.unknownNodeIds.includes('non_existent_node'),
  );

  const ignoredUnknown = evaluateStatementQuote({
    graph: MUSIC_CASE_NODES,
    statementId: 'stmt_ignore_unknown',
    assessment: 'conflict',
    directConflicts: ['taste', 'non_existent_node', 'taste'],
    ignoreUnknownConflicts: true,
  });
  assert.deepEqual(ignoredUnknown.directConflicts, ['taste']);
  assert.equal(ignoredUnknown.rate, 80);

  // 非法 assessment 拦截
  assert.throws(
    () => evaluateStatementQuote({ graph: MUSIC_CASE_NODES, assessment: 'maybe' }),
    { code: 'INVALID_ASSESSMENT' },
  );
});

test('同图多改写对比（compareStatementsOnGraph）与图版本演进后重算一致性', () => {
  const statements = [
    {
      statementId: 'stmt_original',
      role: 'original',
      text: '推荐算法只会让人的兴趣越来越窄。',
      assessment: 'conflict',
      directConflicts: ['taste'],
      reason: '绝对量词“只会”与本人初期发现小众乐队的经历直接冲突。',
    },
    {
      statementId: 'stmt_rewrite_tone',
      text: '我的看法是，推荐算法对人的兴趣只有一种影响，就是让它越来越窄。',
      assessment: 'conflict',
      directConflicts: ['taste'],
      reason: '仅更换语气，“只有一种影响”仍保留全称排他前提，冲突不变。',
    },
    {
      statementId: 'stmt_rewrite_scope',
      text: '推荐在刚开始用时确实帮我发现过新乐队；我担心的是连续听同类歌曲之后，新推荐会不会变少。',
      assessment: 'compatible',
      directConflicts: [],
      reason: '缩小主张范围并承认初期拓宽经历，消除了与 taste 的冲突。',
    },
    {
      statementId: 'stmt_rewrite_unverified',
      text: '推荐系统会在用户注册满 180 天后切换为纯重复池。',
      assessment: 'insufficient_evidence',
      directConflicts: [],
      reason: '缺乏关于 180 天固定阈值的数据证据，维持未定。',
    },
  ];

  // 图版本 v3：5 节点（denominator = 5），原句与换语气均为 80%，缩小范围为 0%
  const cmpV3 = compareStatementsOnGraph({
    graph: MUSIC_CASE_NODES,
    graphVersion: 3,
    statements,
  });
  assert.equal(cmpV3.graphVersion, 3);
  assert.equal(cmpV3.denominator, 5);
  assert.equal(cmpV3.totalNodes, 5);
  assert.equal(cmpV3.baselineStatementId, 'stmt_original');
  assert.equal(cmpV3.quotes.length, 4);

  const [cTone, cScope, cUnverified] = cmpV3.comparisons;
  assert.equal(cTone.statementId, 'stmt_rewrite_tone');
  assert.equal(cTone.deltaRate, 0);
  assert.deepEqual(cTone.resolvedConflicts, []);
  assert.deepEqual(cTone.addedConflicts, []);
  assert.equal(cTone.assessmentChanged, false);

  assert.equal(cScope.statementId, 'stmt_rewrite_scope');
  assert.equal(cScope.deltaRate, -80);
  assert.deepEqual(cScope.resolvedConflicts, ['taste']);
  assert.deepEqual(cScope.addedConflicts, []);
  assert.equal(cScope.assessmentChanged, true);

  assert.equal(cUnverified.statementId, 'stmt_rewrite_unverified');
  assert.equal(cUnverified.rate, null);
  assert.equal(cUnverified.deltaRate, null);
  assert.deepEqual(cUnverified.resolvedConflicts, []);
  assert.deepEqual(cUnverified.resolvedAffected, []);
  assert.deepEqual(cUnverified.addedConflicts, []);
  assert.deepEqual(cUnverified.addedAffected, []);
  assert.equal(cUnverified.assessmentChanged, true);

  // 图版本 v4：用户补充独立分支（新增 d_root -> d_leaf1, d_leaf2，新增承重 2，总分母变为 5 + 2 = 7）
  // 同一组句子在新图上统一重算：4 / 7 = 57%
  const updatedGraphV4 = [
    ...MUSIC_CASE_NODES,
    { id: 'd_root', text: '连着听同类歌时，我会主动去搜冷门厂牌歌单。', cluster: 'habit', deps: [] },
    { id: 'd_leaf1', text: '主动检索能抵消一部分重复推荐。', cluster: 'habit', deps: ['d_root'] },
    { id: 'd_leaf2', text: '我把主动搜索当成听歌习惯的一部分。', cluster: 'habit', deps: ['d_root'] },
  ];
  const cmpV4 = compareStatementsOnGraph({
    graph: updatedGraphV4,
    graphVersion: 4,
    statements,
  });
  assert.equal(cmpV4.graphVersion, 4);
  assert.equal(cmpV4.denominator, 7);
  assert.equal(cmpV4.quotes[0].rate, 57);
  assert.equal(cmpV4.comparisons[0].deltaRate, 0);
  assert.equal(cmpV4.comparisons[1].deltaRate, -57);

  // 连续 20 次运行结果逐字段完全一致（确定性保障）
  for (let i = 0; i < 20; i += 1) {
    assert.deepEqual(
      compareStatementsOnGraph({ graph: updatedGraphV4, graphVersion: 4, statements }),
      cmpV4,
    );
  }
});

test('与 frontend-design/web/src/starfield.js 及 agent/protocol.mjs 保持严格一致', () => {
  assert.equal(PROTOCOL_VERSION, backendProtocolVersion);
  assert.deepEqual(ASSESSMENTS, protocolAssessments);
  assert.equal(RATE_INTERPRETATION_NOTE, protocolInterpretationNote);
  assert.equal(QUOTE_SCHEMA_VERSION, 1);

  // 1. 25 节点多簇合成图逐位对齐前端 starfield.js
  const nodes = [];
  for (let i = 0; i < 25; i += 1) {
    const cluster = i < 10 ? 10 : (i < 18 ? 2 : 1);
    const deps = [];
    if (i > 0 && i % 5 !== 0) deps.push(`n${i - 1}`);
    if (i > 2 && i % 4 === 0) deps.push(`n${i - 2}`);
    if (i > 4 && i % 6 === 0) deps.push(`n${i - 3}`);
    nodes.push({ id: `n${i}`, text: `论点 ${i}`, cluster, deps: [...new Set(deps)] });
  }
  const backendG = computeGraph(nodes);
  const frontendG = frontendComputeGraph(nodes);
  assert.deepEqual(backendG, frontendG);
  assert.deepEqual(brightness(backendG), frontendBrightness(frontendG));
  assert.deepEqual(
    [...collapseAfter(['n0', 'n5'], backendG)],
    [...frontendCollapseAfter(new Set(['n0', 'n5']), frontendG)],
  );

  // 2. 前端正式 30 节点星图（quotation-case.js）算价结果对齐
  const rawCaseNodes = frontendCaseGraph.map(({ id, name, text, kind, cluster, deps, x, y }) => ({
    id,
    name,
    text,
    kind,
    cluster,
    deps,
    x,
    y,
  }));
  const recomputedCase = computeGraph(rawCaseNodes);
  assert.deepEqual(recomputedCase, frontendCaseGraph);
  assert.deepEqual(brightness(recomputedCase), frontendBrightness(frontendCaseGraph));

  const legacyQ = quote(recomputedCase, ['taste', 'discover']);
  const v1Q = evaluateStatementQuote({
    graph: recomputedCase,
    graphVersion: 1,
    statementId: 'case_original',
    text: '推荐算法只会让人的兴趣越来越窄。',
    assessment: 'conflict',
    directConflicts: ['taste', 'discover'],
  });
  assert.equal(v1Q.rate, legacyQ.rate);
  assert.equal(v1Q.numerator, legacyQ.lost);
  assert.equal(v1Q.denominator, legacyQ.total);
  assert.deepEqual(v1Q.affected, legacyQ.dead);
});

test('Schema 与合成样例文件完整有效且可由引擎纯函数精确复算', () => {
  const schema = JSON.parse(
    readFileSync(join(ENGINE_ROOT, 'schemas', 'quote-v1.schema.json'), 'utf8'),
  );
  const quoteExample = JSON.parse(
    readFileSync(join(ENGINE_ROOT, 'examples', 'quote-v1.json'), 'utf8'),
  );
  const frontendSample = JSON.parse(
    readFileSync(join(ENGINE_ROOT, 'examples', 'frontend-consume-sample.json'), 'utf8'),
  );

  // 校验 quote-v1.json 满足 Schema 全部必填字段与无多余属性约束
  assert.deepEqual(Object.keys(quoteExample).sort(), [...schema.required].sort());
  assert.ok(schema.properties.assessment.enum.includes(quoteExample.assessment));
  assert.equal(quoteExample.interpretationNote, schema.properties.interpretationNote.const);

  // 用 frontend-consume-sample.json 内的星图节点与输入句子独立重算，验证零手工篡改
  const rawNodes = frontendSample.starfield.nodes.map(({ id, name, text, cluster, deps, evidenceIds }) => ({
    id,
    name,
    text,
    cluster,
    deps,
    evidenceIds,
  }));
  const recomputedNodes = computeGraph(rawNodes);
  const recomputedL = brightness(recomputedNodes);

  recomputedNodes.forEach((n, idx) => {
    assert.equal(frontendSample.starfield.nodes[idx].S, n.S);
    assert.equal(frontendSample.starfield.nodes[idx].d, n.d);
    assert.equal(frontendSample.starfield.nodes[idx].brightness, recomputedL[idx]);
  });

  const recomputedComparison = compareStatementsOnGraph({
    graph: recomputedNodes,
    graphVersion: frontendSample.starfield.graphVersion,
    statements: frontendSample.rewriteComparison.quotes.map((q) => ({
      statementId: q.statementId,
      text: q.text,
      assessment: q.assessment,
      directConflicts: q.directConflicts,
      conflictReasons: q.conflictReasons,
      reason: q.reason,
      verifiedEvidenceIds: q.verifiedEvidenceIds,
    })),
    baselineStatementId: frontendSample.rewriteComparison.baselineStatementId,
  });

  assert.deepEqual(frontendSample.rewriteComparison, recomputedComparison);
  assert.deepEqual(quoteExample, recomputedComparison.quotes[0]);
});

// 轻量零依赖 Draft 2020-12 Schema 递归校验器（覆盖 quote-v1.schema.json 全部关键字）
function validateAgainstSchema(value, subSchema, rootSchema, path = '$') {
  const errors = [];
  if (!subSchema || typeof subSchema !== 'object') return errors;

  if (subSchema.$ref) {
    const refPath = subSchema.$ref.replace(/^#\//, '').split('/');
    let resolved = rootSchema;
    for (const seg of refPath) {
      resolved = resolved?.[seg];
    }
    if (!resolved) {
      errors.push(`${path}: 无法解析 $ref ${subSchema.$ref}`);
      return errors;
    }
    return validateAgainstSchema(value, resolved, rootSchema, path);
  }

  if ('const' in subSchema && !Object.is(value, subSchema.const)) {
    errors.push(`${path}: 期望常量 ${JSON.stringify(subSchema.const)}，实际为 ${JSON.stringify(value)}`);
  }

  if (Array.isArray(subSchema.enum) && !subSchema.enum.includes(value)) {
    errors.push(`${path}: 值 ${JSON.stringify(value)} 不在枚举 ${JSON.stringify(subSchema.enum)} 中`);
  }

  if (subSchema.type) {
    const allowedTypes = Array.isArray(subSchema.type) ? subSchema.type : [subSchema.type];
    const matchesType = allowedTypes.some((t) => {
      if (t === 'null') return value === null;
      if (t === 'array') return Array.isArray(value);
      if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
      if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
      if (t === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
      return typeof value === t;
    });
    if (!matchesType) {
      errors.push(`${path}: 类型不匹配，期望 ${JSON.stringify(allowedTypes)}，实际为 ${JSON.stringify(value)}`);
      return errors;
    }
  }

  if (typeof value === 'string' && typeof subSchema.minLength === 'number') {
    if (value.length < subSchema.minLength) {
      errors.push(`${path}: 字符串长度 ${value.length} 小于 minLength=${subSchema.minLength}`);
    }
  }

  if (typeof value === 'number') {
    if (typeof subSchema.minimum === 'number' && value < subSchema.minimum) {
      errors.push(`${path}: 数值 ${value} 小于 minimum=${subSchema.minimum}`);
    }
    if (typeof subSchema.maximum === 'number' && value > subSchema.maximum) {
      errors.push(`${path}: 数值 ${value} 大于 maximum=${subSchema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof subSchema.maxItems === 'number' && value.length > subSchema.maxItems) {
      errors.push(`${path}: 数组长度 ${value.length} 超过 maxItems=${subSchema.maxItems}`);
    }
    if (subSchema.uniqueItems === true) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) {
        errors.push(`${path}: 数组违反 uniqueItems 约束`);
      }
    }
    if (subSchema.items) {
      value.forEach((item, idx) => {
        errors.push(...validateAgainstSchema(item, subSchema.items, rootSchema, `${path}[${idx}]`));
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(subSchema.required)) {
      for (const reqKey of subSchema.required) {
        if (!(reqKey in value) || value[reqKey] === undefined) {
          errors.push(`${path}: 缺少必填属性 ${reqKey}`);
        }
      }
    }
    if (subSchema.properties) {
      for (const [propKey, propSchema] of Object.entries(subSchema.properties)) {
        if (propKey in value && value[propKey] !== undefined) {
          errors.push(
            ...validateAgainstSchema(value[propKey], propSchema, rootSchema, `${path}.${propKey}`),
          );
        }
      }
    }
    if (subSchema.additionalProperties === false && subSchema.properties) {
      for (const key of Object.keys(value)) {
        if (!(key in subSchema.properties)) {
          errors.push(`${path}: 存在不允许的额外属性 ${key}`);
        }
      }
    }
  }

  if (Array.isArray(subSchema.oneOf)) {
    const passCount = subSchema.oneOf.filter(
      (branch) => validateAgainstSchema(value, branch, rootSchema, path).length === 0,
    ).length;
    if (passCount !== 1) {
      errors.push(`${path}: oneOf 分支命中数为 ${passCount}（期望恰好为 1）`);
    }
  }

  if (Array.isArray(subSchema.allOf)) {
    for (const cond of subSchema.allOf) {
      if (cond.if) {
        const ifErrors = validateAgainstSchema(value, cond.if, rootSchema, path);
        if (ifErrors.length === 0 && cond.then) {
          errors.push(...validateAgainstSchema(value, cond.then, rootSchema, path));
        }
      } else {
        errors.push(...validateAgainstSchema(value, cond, rootSchema, path));
      }
    }
  }

  return errors;
}

test('QA-07：无证据改写不得标为已解决冲突，仅同图已核验改写能进入 resolvedConflicts 与 resolvedAffected', () => {
  const quoteSchema = JSON.parse(
    readFileSync(join(ENGINE_ROOT, 'schemas', 'quote-v1.schema.json'), 'utf8'),
  );

  // 原句冲突于 taste（连带 example、possible），分母=5，报价=80%
  // 对照：1) 无证据改写 insufficient_evidence；2) 已核验相容改写 compatible；3) 缩小冲突仅剩叶节点 possible 的已核验改写
  const result = compareStatementsOnGraph({
    graph: MUSIC_CASE_NODES,
    graphVersion: 5,
    statements: [
      {
        statementId: 'stmt_orig',
        role: 'original',
        text: '推荐算法只会让人的兴趣越来越窄。',
        assessment: 'conflict',
        directConflicts: ['taste'],
        conflictReasons: [{ nodeId: 'taste', reason: '与本人初期发现小众乐队经历冲突', evidenceIds: ['ev_1'] }],
        verifiedEvidenceIds: ['ev_1'],
        reason: '原句与承重根节点 taste 直接冲突。',
      },
      {
        statementId: 'stmt_unverified_rewrite',
        text: '推荐算法在凌晨时段只推送重复老歌。',
        assessment: 'insufficient_evidence',
        directConflicts: [],
        reason: '无凌晨时段证据，保持未定。',
      },
      {
        statementId: 'stmt_verified_compatible',
        text: '推荐在初期帮我发现过新乐队，我只担心长期同质化。',
        assessment: 'compatible',
        directConflicts: [],
        verifiedEvidenceIds: ['ev_1'],
        reason: '经已核验证据确认消除对 taste 的冲突。',
      },
      {
        statementId: 'stmt_partial_conflict',
        text: '初期确实发现过新乐队，但讨论推荐时不必给这种情形留位置。',
        assessment: 'conflict',
        directConflicts: ['possible'],
        conflictReasons: [{ nodeId: 'possible', reason: '与叶节点 possible 直接冲突', evidenceIds: ['ev_2'] }],
        verifiedEvidenceIds: ['ev_1', 'ev_2'],
        reason: '消除了根基 taste 的冲突，但引入叶节点 possible 冲突。',
      },
    ],
  });

  for (const q of result.quotes) {
    assert.deepEqual(validateAgainstSchema(q, quoteSchema, quoteSchema), []);
  }
  for (const cmp of result.comparisons) {
    assert.deepEqual(
      validateAgainstSchema(cmp, quoteSchema.$defs.statementComparisonItem, quoteSchema),
      [],
    );
  }

  const [unverifiedCmp, compatibleCmp, partialCmp] = result.comparisons;

  // 1. 改写为 insufficient_evidence：差值为 null，已解决集合必须为空，新增集合也为空
  assert.equal(unverifiedCmp.assessment, 'insufficient_evidence');
  assert.equal(unverifiedCmp.rate, null);
  assert.equal(unverifiedCmp.deltaRate, null);
  assert.deepEqual(unverifiedCmp.resolvedConflicts, []);
  assert.deepEqual(unverifiedCmp.resolvedAffected, []);
  assert.deepEqual(unverifiedCmp.addedConflicts, []);
  assert.deepEqual(unverifiedCmp.addedAffected, []);

  // 2. 正向对照：已核验 compatible 改写真实解除冲突，进入 resolvedConflicts 与 resolvedAffected
  assert.equal(compatibleCmp.assessment, 'compatible');
  assert.equal(compatibleCmp.rate, 0);
  assert.equal(compatibleCmp.deltaRate, -80);
  assert.deepEqual(compatibleCmp.resolvedConflicts, ['taste']);
  assert.deepEqual(compatibleCmp.resolvedAffected, ['taste', 'example', 'possible']);
  assert.deepEqual(compatibleCmp.addedConflicts, []);
  assert.deepEqual(compatibleCmp.addedAffected, []);

  // 3. 部分解除的已核验 conflict 改写：taste 与 example 解除，possible 仍受影响并成为新增直接冲突
  assert.equal(partialCmp.assessment, 'conflict');
  assert.equal(partialCmp.rate, 0);
  assert.equal(partialCmp.deltaRate, -80);
  assert.deepEqual(partialCmp.resolvedConflicts, ['taste']);
  assert.deepEqual(partialCmp.resolvedAffected, ['taste', 'example']);
  assert.deepEqual(partialCmp.addedConflicts, ['possible']);
  assert.deepEqual(partialCmp.addedAffected, []);

  // 4. 基准原句本身为 insufficient_evidence 时，比较差值与已解决集合同样为空
  const unverifiedBaselineCmp = compareStatementsOnGraph({
    graph: MUSIC_CASE_NODES,
    graphVersion: 5,
    statements: [
      {
        statementId: 'base_unknown',
        role: 'original',
        text: '待核实的初始句。',
        assessment: 'insufficient_evidence',
      },
      {
        statementId: 'rewrite_compatible',
        text: '已核验相容改写。',
        assessment: 'compatible',
        verifiedEvidenceIds: ['ev_1'],
      },
    ],
  });
  assert.equal(unverifiedBaselineCmp.comparisons[0].deltaRate, null);
  assert.deepEqual(unverifiedBaselineCmp.comparisons[0].resolvedConflicts, []);
  assert.deepEqual(unverifiedBaselineCmp.comparisons[0].resolvedAffected, []);
});

test('QA-10：23/40 整数百分比精确舍入为 58、非法 conflictReasons/evidenceIds 拦截与 Schema 严格对齐', () => {
  const quoteSchema = JSON.parse(
    readFileSync(join(ENGINE_ROOT, 'schemas', 'quote-v1.schema.json'), 'utf8'),
  );

  // 1. 构造 40 对独立的根节点与叶节点（总节点 80，每个根 S=1、叶 S=0，分母=40），冲突 23 个根 -> 分子 23 / 分母 40 = 57.5% -> 必须精确舍入为 58
  const fortyPairNodes = [];
  for (let i = 0; i < 40; i += 1) {
    fortyPairNodes.push({ id: `r_${i}`, text: `根判断 ${i}`, cluster: `c_${i % 4}`, deps: [] });
    fortyPairNodes.push({ id: `l_${i}`, text: `叶判断 ${i}`, cluster: `c_${i % 4}`, deps: [`r_${i}`] });
  }
  const conflict23Ids = Array.from({ length: 23 }, (_, i) => `r_${i}`);

  const legacyRes = quote(fortyPairNodes, conflict23Ids);
  assert.equal(legacyRes.lost, 23);
  assert.equal(legacyRes.total, 40);
  assert.equal(legacyRes.rate, 58);

  const v1Res = evaluateStatementQuote({
    graph: fortyPairNodes,
    graphVersion: 1,
    statementId: 'stmt_23_of_40',
    text: '覆盖 23 个独立承重根节点的全称断言。',
    assessment: 'conflict',
    directConflicts: conflict23Ids,
    reason: '分子 23、分母 40，(100 * 23) / 40 = 57.5，四舍五入应得 58%。',
    conflictReasons: conflict23Ids.map((id, idx) => ({
      nodeId: id,
      reason: `与根节点 ${id} 冲突`,
      evidenceIds: [`ev_${idx}`, `ev_${idx}`], // 同时验证去重后满足 uniqueItems
    })),
    verifiedEvidenceIds: ['ev_0', 'ev_1'],
  });
  assert.equal(v1Res.numerator, 23);
  assert.equal(v1Res.denominator, 40);
  assert.equal(v1Res.rate, 58);
  assert.equal(v1Res.conflictReasons[0].evidenceIds.length, 1);
  assert.deepEqual(validateAgainstSchema(v1Res, quoteSchema, quoteSchema), []);

  // 2. 拦截非法 conflictReasons 与非法 evidenceIds / verifiedEvidenceIds，统一抛 INVALID_ARGUMENTS
  const invalidConflictReasonCases = [
    [{}], // 空对象缺 nodeId 与 reason
    [{ nodeId: 'r_0' }], // 缺 reason
    [{ reason: '仅有理由缺节点 ID' }], // 缺 nodeId
    [{ nodeId: '', reason: '空 nodeId' }],
    [{ nodeId: '   ', reason: '空白 nodeId' }],
    [{ nodeId: 'r_0', reason: '' }],
    [{ nodeId: 'r_0', reason: '   ' }],
    [''], // 空字符串理由
    ['   '], // 纯空白字符串理由
    [123], // 数字
    [null], // null 元素
    [['nested']], // 数组元素
    [{ nodeId: 'r_0', reason: '字符串 evidenceIds', evidenceIds: 'ev_1' }], // 字符串形式 evidenceIds
    [{ nodeId: 'r_0', reason: '数字 evidenceIds', evidenceIds: 42 }],
    [{ nodeId: 'r_0', reason: '对象 evidenceIds', evidenceIds: { id: 'ev_1' } }],
    [{ nodeId: 'r_0', reason: '含空串 evidenceIds', evidenceIds: ['ev_1', ''] }],
    [{ nodeId: 'r_0', reason: '含数字元素 evidenceIds', evidenceIds: [100] }],
    [{ nodeId: 'r_0', reason: '含非有限数值附加字段', score: Number.NaN }],
  ];

  for (const badReasons of invalidConflictReasonCases) {
    assert.throws(
      () =>
        evaluateStatementQuote({
          graph: MUSIC_CASE_NODES,
          graphVersion: 1,
          statementId: 'stmt_invalid_reasons',
          text: '测试非法冲突理由拦截',
          assessment: 'conflict',
          directConflicts: ['taste'],
          conflictReasons: badReasons,
        }),
      (err) => err.code === 'INVALID_ARGUMENTS',
      `期望拒绝非法 conflictReasons: ${JSON.stringify(badReasons)}`,
    );
  }

  assert.throws(
    () =>
      evaluateStatementQuote({
        graph: MUSIC_CASE_NODES,
        graphVersion: 1,
        statementId: 'stmt_invalid_ev',
        text: '测试非法 verifiedEvidenceIds',
        assessment: 'compatible',
        verifiedEvidenceIds: 'ev_not_array',
      }),
    { code: 'INVALID_ARGUMENTS' },
  );

  // 允许 evidenceIds 显式为 null 或 undefined 时规范化省略该可选键，产物严格通过 Schema
  const normalizedNullEv = evaluateStatementQuote({
    graph: MUSIC_CASE_NODES,
    graphVersion: 1,
    statementId: 'stmt_null_ev_field',
    text: '测试可选 evidenceIds 为 null 时不透传非法 null',
    assessment: 'conflict',
    directConflicts: ['taste'],
    conflictReasons: [{ nodeId: 'taste', reason: '与根判断冲突', evidenceIds: null }],
  });
  assert.equal('evidenceIds' in normalizedNullEv.conflictReasons[0], false);
  assert.deepEqual(validateAgainstSchema(normalizedNullEv, quoteSchema, quoteSchema), []);
});

test('QA-10：10,000 节点长链与万级菱形 DAG 校验、承重计算及算价无栈溢出压力测试', () => {
  const N = 10_000;

  // 1. 10,000 节点逆序输入单链（n0 <- n1 <- ... <- n9999），验证迭代三色 DFS + 位图传递闭包无栈溢出
  const reversedChain = [];
  for (let i = N - 1; i >= 0; i -= 1) {
    reversedChain.push({
      id: `n${i}`,
      text: `长链判断 ${i}`,
      cluster: 'chain',
      deps: i === 0 ? [] : [`n${i - 1}`],
    });
  }

  const startMs = performance.now();
  const dagCheck = validateDag(reversedChain);
  assert.equal(dagCheck.ok, true);
  assert.equal(dagCheck.sortedNodes.length, N);
  assert.equal(dagCheck.sortedNodes[0].id, 'n0');
  assert.equal(dagCheck.sortedNodes[N - 1].id, `n${N - 1}`);

  const computedChain = computeGraph(reversedChain);
  assert.equal(computedChain[0].S, N - 1);
  assert.equal(computedChain[0].d, 0);
  assert.equal(computedChain[N - 1].S, 0);
  assert.equal(computedChain[N - 1].d, N - 1);
  assert.equal(computedChain[5000].S, N - 1 - 5000);
  assert.equal(computedChain[5000].d, 5000);

  // 在 10,000 节点长链上执行根节点冲突算价：全链坍塌，rate = 100%，分母 = 9999 * 10000 / 2 = 49,995,000
  const chainQuote = evaluateStatementQuote({
    graph: computedChain,
    graphVersion: 1,
    statementId: 'stmt_10k_chain',
    text: '否定 10,000 节点长链的唯一根基 n0。',
    assessment: 'conflict',
    directConflicts: ['n0'],
    conflictReasons: [{ nodeId: 'n0', reason: '直接否定长链根基', evidenceIds: ['ev_root'] }],
    verifiedEvidenceIds: ['ev_root'],
  });
  const elapsedMs = performance.now() - startMs;

  assert.equal(chainQuote.denominator, (N * (N - 1)) / 2);
  assert.equal(chainQuote.numerator, (N * (N - 1)) / 2);
  assert.equal(chainQuote.rate, 100);
  assert.equal(chainQuote.affected.length, N);
  assert.ok(elapsedMs < 3000, `10,000 节点长链全链路耗时应远低于 3000ms，实际 ${elapsedMs.toFixed(1)}ms`);

  // 2. 10,000 节点首尾闭环检测无栈溢出
  const giantCycle = reversedChain.map((n) =>
    n.id === 'n0' ? { ...n, deps: [`n${N - 1}`] } : n,
  );
  const cycleRes = validateDag(giantCycle);
  assert.equal(cycleRes.ok, false);
  assert.ok(cycleRes.errors.some((e) => e.includes('检测到循环依赖')));

  // 3. 多路径汇合菱形链验证位图去重精确性（1,000 层 × 每层 2 节点汇合，共 2,001 节点）
  // root -> (a0, b0) -> (a1, b1) -> ... -> (a999, b999)，每层两个节点同时依赖上一层两个节点
  const layers = 1000;
  const diamondDag = [{ id: 'root', text: '菱形根', cluster: 'd', deps: [] }];
  for (let l = 0; l < layers; l += 1) {
    const prevDeps = l === 0 ? ['root'] : [`a_${l - 1}`, `b_${l - 1}`];
    diamondDag.push({ id: `a_${l}`, text: `层 ${l} 左`, cluster: 'd', deps: prevDeps });
    diamondDag.push({ id: `b_${l}`, text: `层 ${l} 右`, cluster: 'd', deps: prevDeps });
  }
  const computedDiamond = computeGraph(diamondDag);
  assert.equal(computedDiamond[0].id, 'root');
  assert.equal(computedDiamond[0].S, layers * 2); // 去重后恰好为后续全部 2000 个节点
  assert.equal(computedDiamond[1].S, (layers - 1) * 2);
  assert.equal(computedDiamond[computedDiamond.length - 1].d, layers);
});
