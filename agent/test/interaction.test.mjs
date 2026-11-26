import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INITIAL_WILLPOWER,
  MAX_WILLPOWER,
  MAX_CLASH_ROUNDS,
  computeBeliefGraph,
  collapseAfter,
  difficultyFromQuotation,
  computeWillpowerDelta,
  computeWillpowerDamage,
  nextAccuracy,
  scoreRoundOptions,
} from '../quotation.mjs';
import { createInteractionController, extractJsonObject, roundDepthSpec, willpowerToneSpec } from '../interaction.mjs';
import { safeAgentError } from '../errors.mjs';

describe('报价打分与意志平衡算法（quotation.mjs）', () => {
  const sampleNodes = [
    { id: 'b1', name: '切身经历A', cluster: 1, deps: [], text: '自己用某工具确实省过时间。' },
    { id: 'b2', name: '切身经历B', cluster: 2, deps: [], text: '见过同事手工操作出错。' },
    { id: 'b3', name: '单依赖推论', cluster: 1, deps: ['b1'], text: '工具在特定任务上更快。' },
    { id: 'b4', name: '双依赖推论', cluster: 2, deps: ['b1', 'b2'], text: '自动化往往比人工稳妥。' },
    { id: 'b5', name: '顶层极端结论', cluster: 3, deps: ['b3', 'b4'], text: '人工审核已经完全没有存在必要。' },
  ];

  it('承重数 S 与过半失稳级联塌陷规则正确', () => {
    const graph = computeBeliefGraph(sampleNodes);
    const byId = new Map(graph.map((n) => [n.id, n]));
    // b1 支撑 b3、b4、b5 共 3 个节点；b2 支撑 b4、b5 共 2 个节点；b5 为顶层叶节点 S=0。
    assert.equal(byId.get('b1').S, 3);
    assert.equal(byId.get('b2').S, 2);
    assert.equal(byId.get('b5').S, 0);

    // 只拆 b2：b4 有两个依赖（b1 仍存活，存活率 0.5 >= 0.5），b4 不塌。
    const onlyB2 = collapseAfter(new Set(['b2']), graph);
    assert.deepEqual([...onlyB2], ['b2']);

    // 只拆 b1：b3（0/1 < 0.5）塌陷；随后 b5 只有 b4 存活（1/2 = 0.5）暂不塌；若同时拆 b1+b2 则全图塌陷。
    const onlyB1 = collapseAfter(new Set(['b1']), graph);
    assert.deepEqual([...onlyB1].sort(), ['b1', 'b3']);

    const both = collapseAfter(new Set(['b1', 'b2']), graph);
    assert.equal(both.size, 5);
  });

  it('单回合选项打分保证固定包含「非常简单」与「非常困难」，且伤害效果有区分', () => {
    const graph = computeBeliefGraph(sampleNodes);
    const searchItems = [
      { title: '自动化审核边界条件与人工复核数据', excerpt: '统计研究表明在高风险边界场景下，人工复核不可或缺。' },
    ];
    const rawOptions = [
      { text: '数据显示日常重复环节确实适合自动化，但在高风险边界条件下仍需人工兜底。', conflicts: [], flawLevel: 0, rationale: '承认合理经验并指出边界' },
      { text: '自动化在常规场景更稳，但异常长尾案例仍需要人工介入判断。', conflicts: ['b4'], flawLevel: 0, rationale: '拆解中间推论' },
      { text: '你省时间只是运气好，自动化其实经常出错。', conflicts: ['b1'], flawLevel: 1, rationale: '否定切身经历且以偏概全' },
      { text: '自动化完全错了，所有研究都证明机器错误率百分百高于人工，毫无价值！', conflicts: ['b1', 'b2'], flawLevel: 2, rationale: '事实错误且全盘否定' },
    ];

    const scored = scoreRoundOptions(rawOptions, graph, searchItems, { seed: 'test-seed-1' });
    assert.equal(scored.length, 4);
    const difficulties = scored.map((o) => o.difficulty);
    assert.ok(difficulties.includes('非常简单'), '必须包含非常简单');
    assert.ok(difficulties.includes('非常困难'), '必须包含非常困难');

    // 按报价升序检查：报价越低，意志减损越高，且相邻选项报价与伤害均有明显梯度。
    const byQuote = [...scored].sort((a, b) => a.quotation - b.quotation);
    assert.equal(byQuote[0].difficulty, '非常简单');
    assert.equal(byQuote.at(-1).difficulty, '非常困难');
    for (let i = 1; i < byQuote.length; i += 1) {
      assert.ok(byQuote[i].quotation - byQuote[i - 1].quotation >= 12, '相邻选项报价应拉开梯度');
      assert.ok(byQuote[i].damage < byQuote[i - 1].damage, '报价更高的选项造成的意志减损应更低');
    }
  });

  it('简单两档削减意志、困难两档增加意志，满 8 回合未归零判负', () => {
    // 简单两档严格削减意志（willpowerDelta < 0），困难两档严格增加意志（willpowerDelta > 0）
    assert.ok(computeWillpowerDelta(14) < 0, '非常简单应削减意志');
    assert.ok(computeWillpowerDelta(38) < 0, '比较简单应削减意志');
    assert.ok(computeWillpowerDelta(62) > 0, '比较困难应增加意志');
    assert.ok(computeWillpowerDelta(88) > 0, '非常困难应显著增加意志');
    assert.ok(computeWillpowerDelta(88) > computeWillpowerDelta(62), '非常困难增加的意志应高于比较困难');

    const simulate = (quotations) => {
      let willpower = INITIAL_WILLPOWER;
      let round = 0;
      while (willpower > 0 && round < MAX_CLASH_ROUNDS) {
        round += 1;
        const q = quotations[(round - 1) % quotations.length];
        willpower = Math.min(MAX_WILLPOWER, Math.max(0, willpower + computeWillpowerDelta(q)));
      }
      return { round, willpower, victory: willpower === 0 };
    };

    // 1. 全选「非常简单」（q ≈ 14）：4 回合归零获胜
    const easyWin = simulate([14]);
    assert.equal(easyWin.victory, true);
    assert.equal(easyWin.round, 4);

    // 2. 全选「比较简单」（q ≈ 36）：5 回合归零获胜
    const midEasyWin = simulate([36]);
    assert.equal(midEasyWin.victory, true);
    assert.equal(midEasyWin.round, 5);

    // 3. 混合失误后纠偏：8 回合内成功归零获胜
    const mixedWin = simulate([88, 14, 38, 62, 14, 14, 38]);
    assert.equal(mixedWin.victory, true);
    assert.ok(mixedWin.round <= MAX_CLASH_ROUNDS);

    // 4. 频繁选困难选项：满 8 回合未归零则判负
    const loseRun = simulate([88, 62, 88, 38, 62, 88, 38, 62]);
    assert.equal(loseRun.round, 8);
    assert.equal(loseRun.victory, false);
    assert.ok(loseRun.willpower > 0);
  });

  it('准确率与检定难度映射符合规则', () => {
    assert.equal(difficultyFromQuotation(15), '非常简单');
    assert.equal(difficultyFromQuotation(40), '比较简单');
    assert.equal(difficultyFromQuotation(60), '比较困难');
    assert.equal(difficultyFromQuotation(88), '非常困难');

    assert.equal(nextAccuracy('非常简单'), 1);
    assert.equal(nextAccuracy('比较简单'), 1);
    assert.equal(nextAccuracy('比较困难'), 0);
    assert.equal(nextAccuracy('非常困难'), 0);
  });
});

describe('交互模块三板块状态机与隐藏数值保护（interaction.mjs）', () => {
  function createHarness() {
    const searchCalls = [];
    let llmStep = 0;

    const fakeConfig = {
      demo: true,
      allowPersonalData: true,
      model: { providerName: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', modelName: 'mock-llm', ready: true },
      servers: [{ id: 'search', enabled: true, reason: '演示模式', command: 'node', args: [], env: {} }],
    };

    const fakeProfile = {
      summary: '关注 RAG 检索评测与 Python 工程实践',
      domains: [
        { name: 'RAG 与知识检索', share: 0.6, evidence: ['RAG 评测指标设计'] },
        { name: 'Python 数据工程', share: 0.4, evidence: ['Python 批处理优化'] },
      ],
      topics: ['向量检索', '重排序', '数据清洗'],
    };

    const connectServers = async () => ({
      enabled: ['search'],
      tools: {
        zhihu_search: {
          execute: async (args) => {
            searchCalls.push(args);
            return {
              structuredContent: {
                schemaVersion: 1,
                ok: true,
                data: {
                  items: [
                    { title: `知乎讨论：${args.query.slice(0, 18)}`, excerpt: '实证数据显示需结合边界条件与混合检索策略综合评估。', url: 'https://www.zhihu.com/question/123', voteCount: 88, author: '测试答主' },
                  ],
                },
                error: null,
              },
            };
          },
        },
      },
      close: async () => {},
    });

    const generate = async ({ prompt }) => {
      llmStep += 1;
      if (prompt.includes('"viewpoints"')) {
        return {
          text: JSON.stringify({
            viewpoints: [
              { kind: 'profile_1', topic: 'RAG 向量检索', claim: `只要把上下文窗口拉大，RAG 检索就彻底过时了（批次${llmStep}）`, opponentName: '长窗口拥趸', opponentIntro: '深信超长上下文能替代一切检索架构', coreFlaw: '忽略了推理延迟、成本与大海捞针精度衰减', searchKeywords: ['RAG', '长上下文'] },
              { kind: 'profile_2', topic: 'Python 性能', claim: `Python 慢到完全无法用于任何生产级数据处理（批次${llmStep}）`, opponentName: '唯底层语言论者', opponentIntro: '曾遇到纯 Python 循环性能瓶颈', coreFlaw: '混淆了解释器循环与底层 C/Rust 向量化算子', searchKeywords: ['Python', '向量化'] },
              { kind: 'hot', topic: '远程办公效率', claim: `远程办公必然导致团队效率彻底崩溃（批次${llmStep}）`, opponentName: '传统坐班主管', opponentIntro: '习惯面对面盯工位管理', coreFlaw: '把缺乏异步文档规范归咎于远程形态本身', searchKeywords: ['远程办公', '异步协作'] },
            ],
          }),
        };
      }
      if (prompt.includes('"openingArgument"')) {
        return {
          text: JSON.stringify({
            openingArgument: '现在的模型动辄百万上下文，直接把文档全塞进去就行了，维护 RAG 纯属多此一举！',
            beliefNodes: [
              { id: 'b1', name: '长窗口可用', cluster: 1, deps: [], text: '小文档直接塞进长窗口确实能答对。' },
              { id: 'b2', name: '切片有损耗', cluster: 2, deps: [], text: '粗暴切分文档有时会截断上下文。' },
              { id: 'b3', name: '全量输入省事', cluster: 1, deps: ['b1'], text: '不建索引能省掉前期工程工作。' },
              { id: 'b4', name: '检索必丢信息', cluster: 2, deps: ['b1', 'b2'], text: '只要做检索就一定不如全量准确。' },
              { id: 'b5', name: 'RAG 已过时', cluster: 3, deps: ['b3', 'b4'], text: '长上下文已经彻底取代 RAG。' },
            ],
            options: [
              { text: '小规模文档塞长窗口确实方便，但在百万级动态知识库下，数据显示每次全量推理的首字延迟与成本会暴增数十倍，RAG 依然不可替代。', tactic: '边界与成本实证', conflicts: [], flawLevel: 0, rationale: '认可小规模体验，用规模化延迟与成本数据拆解绝对化结论', knowledgePoint: { title: 'RAG 与长窗口的成本及延迟边界', detail: '长窗口每次请求重复计算 KV Cache，在高频大规模语料下延迟与成本远高于先检索再生成。' } },
              { text: '长上下文中间位置存在注意力衰减，结合混合检索与重排序反而能提升信噪比。', tactic: '信噪比机制', conflicts: ['b4'], flawLevel: 0, rationale: '从大海捞针注意力分散解释检索提纯价值', knowledgePoint: { title: 'Lost-in-the-Middle 注意力稀释效应', detail: '超长输入中无关噪声会稀释关键段落注意力，精准召回可提升回答准确率。' } },
              { text: '你根本不懂工程，小文档塞长窗口也经常胡说八道！', tactic: '情绪反驳', conflicts: ['b1'], flawLevel: 1, rationale: '直接否定对方真实有效的小文档体验，引发抵触', knowledgePoint: { title: '小语料场景的直接上下文适用性', detail: '语料较少且固定时，直接利用长上下文配前缀缓存是合理方案。' } },
              { text: '大模型根本不支持超过四千字的输入，所谓百万窗口全是虚假宣传，必须百分百用检索！', tactic: '事实错误硬怼', conflicts: ['b1', 'b2'], flawLevel: 2, rationale: '包含明显事实错误，立刻丧失说服力', knowledgePoint: { title: '现代主流模型的上下文窗口规模', detail: '主流模型已普遍支持 128K 至 1M 级上下文，争论焦点在于成本、实时性与信噪比而非窗口上限。' } },
            ],
          }),
        };
      }
      if (prompt.includes('"counterArgument"')) {
        return {
          text: JSON.stringify({
            counterArgument: `就算成本高一点，硬件总会降价（第${llmStep}步反驳），而且切片把语义切碎的问题你怎么解决？`,
            options: [
              { text: '粗暴定长切片确实会断句，但现在通过语义分块、父子文档索引与重排序，既能保留完整段落上下文，又能兼顾毫秒级更新。', tactic: '父子索引方案', conflicts: [], flawLevel: 0, rationale: '正面回应切片痛点并给出成熟工程解法', knowledgePoint: { title: '父子文档块（Parent-Child Chunking）检索', detail: '以细粒度子块做高精度检索命中，再回传完整父段落给模型，兼顾召回率与上下文完整度。' } },
              { text: '知识库每分钟都在增删权限与实时数据，全量塞上下文无法做到行级权限隔离。', tactic: '实时性与权限', conflicts: ['b3'], flawLevel: 0, rationale: '补充企业级权限与实时更新刚需', knowledgePoint: { title: 'RAG 的动态更新与权限控制优势', detail: '检索层可在召回阶段按用户权限过滤文档，避免全量上下文泄露越权信息。' } },
              { text: '硬件降价远远赶不上数据膨胀，等降价太天真了。', tactic: '武断否定', conflicts: ['b1'], flawLevel: 1, rationale: '态度生硬且缺乏具体论据支撑', knowledgePoint: { title: '推理算力成本曲线', detail: '前缀缓存可降低静态长文本成本，但动态多文档组合仍难以命中缓存。' } },
              { text: '切片根本不存在任何信息损失，随便按 50 个字截断也绝对不会影响准确率！', tactic: '违背常识', conflicts: ['b1', 'b2'], flawLevel: 2, rationale: '违背基本工程事实，被对方轻易识破', knowledgePoint: { title: '分块粒度对召回质量的影响', detail: '过小的固定切片会丢失指代与前提信息，需配合重叠窗口或结构化切分。' } },
            ],
          }),
        };
      }
      return {
        text: JSON.stringify({
          overallComment: '你在交锋中准确把握了长上下文与 RAG 各自的适用边界，成功说服了对手。',
          knowledgePoints: [
            { title: 'RAG 与长窗口的互补关系', detail: '大规模动态知识库靠 RAG 降本提纯，局部深度推理靠长窗口承载上下文。' },
            { title: '父子分块与混合重排', detail: '通过结构化分块与 Rerank 解决传统定长切分语义断裂问题。' },
          ],
        }),
      };
    };

    const ctrl = createInteractionController({
      getConfig: () => fakeConfig,
      createModel: () => ({ id: 'mock' }),
      connectServers,
      getProfile: () => fakeProfile,
      generate,
    });

    return { ctrl, searchCalls };
  }

  it('板块一生成 2 个画像观点 + 1 个热门观点，支持「换一批」，且绝不泄露隐藏字段', async () => {
    const { ctrl, searchCalls } = createHarness();
    const first = await ctrl.generateViewpoints({ refresh: false });

    assert.equal(first.phase, 'select');
    assert.equal(first.profileUsed, true);
    assert.equal(first.viewpoints.length, 3);
    assert.equal(first.viewpoints[0].kind, 'profile');
    assert.equal(first.viewpoints[1].kind, 'profile');
    assert.equal(first.viewpoints[2].kind, 'hot');
    assert.match(first.viewpoints[2].sourceBadge, /热门话题/);
    assert.equal(searchCalls.length, 2, '板块一应调用搜索工具获取兴趣与热门素材');

    const second = await ctrl.generateViewpoints({ refresh: true });
    assert.equal(second.batchIndex, 1);
    assert.notEqual(second.viewpoints[0].claim, first.viewpoints[0].claim, '换一批应生成新的观点批次');
  });

  it('板块二隐藏报价与准确率：初始隐藏难度 → 选困难后显露难度 → 选简单后再次隐藏 → 意志归零进入板块三并可回调板块一', async () => {
    const { ctrl, searchCalls } = createHarness();
    const sel = await ctrl.generateViewpoints();
    const clash1 = await ctrl.selectViewpoint(sel.viewpoints[0].id);

    assert.equal(clash1.phase, 'clash');
    assert.equal(clash1.clash.willpower, 100);
    assert.equal(clash1.clash.round, 1);
    // 初始准确率为 1：难度必须隐藏！且公开 JSON 不得含 quotation 或 accuracy。
    assert.equal(clash1.clash.difficultyVisible, false);
    for (const opt of clash1.clash.currentRound.options) {
      assert.equal(opt.difficulty, null);
    }
    const serialized1 = JSON.stringify(clash1);
    assert.doesNotMatch(serialized1, /"quotation":/);
    assert.doesNotMatch(serialized1, /"accuracy":/);

    // 第 1 回合：故意挑选内部难度为「非常困难」的选项 -> 准确率应降为 0，第 2 回合显示检定难度！
    const hardOpt = ctrl._debugInternalState().currentOptions.find((o) => o.difficulty === '非常困难');
    assert.ok(hardOpt);
    // 等待一拍让后台预取（setImmediate）触发，验证预取已命中队列
    await new Promise((r) => setImmediate(r));
    assert.ok(ctrl._debugInternalState().prefetchedKeys.length === 1, '阅读第 1 回合时应在后台预取第 2 回合检索');
    const callsAfterPrefetch = searchCalls.length;
    const clash2 = await ctrl.submitChoice(hardOpt.id);

    assert.equal(clash2.phase, 'clash');
    assert.equal(clash2.clash.round, 2);
    assert.equal(searchCalls.length, callsAfterPrefetch, '第 2 回合应直接命中后台预取结果，不再阻塞等待重复检索');
    assert.equal(clash2.clash.difficultyVisible, true, '选了非常困难后准确率变为 0，应显示检定难度');
    const visibleDiffs = clash2.clash.currentRound.options.map((o) => o.difficulty);
    assert.ok(visibleDiffs.every(Boolean), '所有选项均应带难度标签');
    assert.ok(visibleDiffs.includes('非常简单') && visibleDiffs.includes('非常困难'));
    assert.ok(clash2.clash.willpower > 100, '选中非常困难选项应助长对手意志（超过初始 100）');
    assert.ok(clash2.clash.lastResolution.willpowerDelta > 0, '困难选项 willpowerDelta 应为正值');
    assert.doesNotMatch(JSON.stringify(clash2), /"quotation":/);
    assert.doesNotMatch(JSON.stringify(clash2), /"accuracy":/);

    // 第 2 回合：根据提示选择「非常简单」选项 -> 准确率恢复为 1，第 3 回合难度再次隐藏！
    const easyOpt2 = clash2.clash.currentRound.options.find((o) => o.difficulty === '非常简单');
    const clash3 = await ctrl.submitChoice(easyOpt2.id);
    assert.equal(clash3.phase, 'clash');
    assert.ok(clash3.clash.willpower < clash2.clash.willpower, '选中非常简单选项应显著削减对手意志');
    assert.equal(clash3.clash.difficultyVisible, false, '选中非常简单后准确率变回 1，下一轮难度应重新隐藏');
    assert.ok(clash3.clash.currentRound.options.every((o) => o.difficulty === null));

    // 持续选择最优选项直至对手意志归 0，验证 8 回合内获胜且进入板块三总结。
    let current = clash3;
    while (current.phase === 'clash') {
      const bestInternal = ctrl._debugInternalState().currentOptions.find((o) => o.difficulty === '非常简单');
      current = await ctrl.submitChoice(bestInternal.id);
    }

    assert.equal(current.phase, 'summary');
    assert.equal(current.summary.victory, true);
    assert.equal(current.summary.outcome, 'victory');
    assert.ok(current.summary.totalRounds >= 4 && current.summary.totalRounds <= 8, `应在 8 回合内获胜，实际 ${current.summary.totalRounds}`);
    assert.equal(current.summary.roundReviews.length, current.summary.totalRounds);
    // 第 1 回合选了非常困难 -> 欠妥（false）；后续选了非常简单 -> 恰当（true）。
    assert.equal(current.summary.roundReviews[0].appropriate, false);
    assert.ok(current.summary.roundReviews[0].betterApproach, '欠妥回合应给出更优参考话术');
    assert.equal(current.summary.roundReviews[1].appropriate, true);
    assert.ok(current.summary.knowledgePoints.length >= 2, '总结应输出本次获得的知识点');
    assert.doesNotMatch(JSON.stringify(current), /"quotation":/);

    // 点击完成回调至板块一
    const back = ctrl.backToSelection();
    assert.equal(back.phase, 'select');
    assert.equal(back.viewpoints.length, 3);
    await ctrl.close();
  });

  it('JSON 容错解析与自动重试：兼容未转义内部双引号、提前闭合花括号、双对象分段与首次截断重试', async () => {
    // 1. 字符串内部夹杂未转义英文双引号 + 提前闭合根对象 `},"options":`
    const brokenPremature = '{"openingArgument":"正如"把克制写进代码"所说, 严管最有效。","beliefNodes":[{"id":"b1","name":"观察","cluster":1,"deps":[],"text":"所谓"赢在起跑线"常见"}],"options":[{"text":"认可"克制"初衷，但一刀切会导致报复性沉迷。","conflicts":[],"flawLevel":0},{"text":"方案B","conflicts":["b1"],"flawLevel":1},{"text":"方案C","conflicts":["b1"],"flawLevel":2}]}';
    // 故意构造 `]},` -> `]}},` 提前闭合根对象
    const withExtraBrace = brokenPremature.replace('],"options":', ']},"options":');
    const repaired1 = extractJsonObject(withExtraBrace);
    assert.equal(repaired1.options.length, 3);
    assert.match(repaired1.openingArgument, /把克制写进代码/);

    // 2. 分成两个连续顶层 JSON 对象输出
    const twoObjects = '{"openingArgument":"立论内容","beliefNodes":[]}\n{"options":[{"text":"A","conflicts":[],"flawLevel":0},{"text":"B","conflicts":[],"flawLevel":1},{"text":"C","conflicts":[],"flawLevel":2}]}';
    const repaired2 = extractJsonObject(twoObjects);
    assert.equal(repaired2.openingArgument, '立论内容');
    assert.equal(repaired2.options.length, 3);

    // 3. AI_RetryError 解包后应归类为 MODEL_ERROR，而非笼统的 INTERNAL_ERROR
    const apiErr = Object.assign(new Error('upstream 503'), { name: 'AI_APICallError', statusCode: 503 });
    const retryErr = Object.assign(new Error('retries exhausted'), { name: 'AI_RetryError', lastError: apiErr });
    const mapped = safeAgentError(retryErr);
    assert.equal(mapped.code, 'MODEL_ERROR');
    assert.match(mapped.message, /HTTP 503/);

    // 4. selectViewpoint 首次返回截断非 JSON 时自动补试第 2 次并成功进入交锋
    let selectAttempts = 0;
    const ctrl = createInteractionController({
      enablePrefetch: false,
      getConfig: () => ({
        demo: true,
        model: { providerName: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', modelName: 'mock', ready: true },
        servers: [{ id: 'search', enabled: true, command: 'node', args: [], env: {} }],
      }),
      createModel: () => ({ id: 'mock' }),
      connectServers: async () => ({
        enabled: ['search'],
        tools: {
          zhihu_search: {
            execute: async () => ({ structuredContent: { ok: true, data: { items: [{ title: '把"克制"写进代码', excerpt: '避免"一刀切"' }] } } }),
          },
        },
        close: async () => {},
      }),
      generate: async ({ prompt }) => {
        if (prompt.includes('"viewpoints"')) {
          return {
            text: JSON.stringify({
              viewpoints: [
                { kind: 'profile_1', topic: '议题1', claim: '观点1', opponentName: '甲', opponentIntro: '背景', coreFlaw: '漏洞', searchKeywords: ['词1'] },
                { kind: 'profile_2', topic: '议题2', claim: '观点2', opponentName: '乙', opponentIntro: '背景', coreFlaw: '漏洞', searchKeywords: ['词2'] },
                { kind: 'hot', topic: '议题3', claim: '观点3', opponentName: '丙', opponentIntro: '背景', coreFlaw: '漏洞', searchKeywords: ['词3'] },
              ],
            }),
          };
        }
        selectAttempts += 1;
        if (selectAttempts === 1) {
          return { text: '{"openingArgument":"半截被截断的输出...' };
        }
        return { text: withExtraBrace };
      },
    });

    const topics = await ctrl.generateViewpoints();
    const clash = await ctrl.selectViewpoint(topics.viewpoints[0].id);
    assert.equal(selectAttempts, 2, '首次截断应自动重试第 2 次');
    assert.equal(clash.phase, 'clash');
    assert.equal(clash.clash.currentRound.options.length, 3);
    await ctrl.close();
  });

  it('回合反驳提示词严格锚定对手维护原观点、反驳用户上一轮说服话术', async () => {
    const capturedPrompts = [];
    const ctrl = createInteractionController({
      enablePrefetch: false,
      getConfig: () => ({
        demo: true,
        model: { providerName: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', modelName: 'mock', ready: true },
        servers: [{ id: 'search', enabled: true, command: 'node', args: [], env: {} }],
      }),
      createModel: () => ({ id: 'mock' }),
      connectServers: async () => ({
        enabled: ['search'],
        tools: {
          zhihu_search: {
            execute: async () => ({ structuredContent: { ok: true, data: { items: [{ title: '远程办公实证研究', excerpt: '异步文档可保障效率' }] } } }),
          },
        },
        close: async () => {},
      }),
      generate: async ({ prompt, instructions }) => {
        capturedPrompts.push({ prompt, instructions });
        if (prompt.includes('"viewpoints"')) {
          return {
            text: JSON.stringify({
              viewpoints: [
                { kind: 'profile_1', topic: '远程办公', claim: '远程办公必然导致效率崩溃', opponentName: '坐班主管', opponentIntro: '习惯盯工位', coreFlaw: '混淆沟通规范与办公地点', searchKeywords: ['远程办公'] },
                { kind: 'profile_2', topic: '议题2', claim: '观点2', opponentName: '乙', opponentIntro: '背景', coreFlaw: '漏洞', searchKeywords: ['词2'] },
                { kind: 'hot', topic: '议题3', claim: '观点3', opponentName: '丙', opponentIntro: '背景', coreFlaw: '漏洞', searchKeywords: ['词3'] },
              ],
            }),
          };
        }
        if (prompt.includes('"openingArgument"')) {
          return {
            text: JSON.stringify({
              openingArgument: '我带队十年，不在工位盯着大家绝对会摸鱼，远程办公必然导致效率崩溃！',
              beliefNodes: [],
              options: [
                { text: '缺乏明确产出指标时确实容易松散，但在异步文档完备的团队中，远程反而减少了通勤损耗。', conflicts: [], flawLevel: 0 },
                { text: '用看板同样能跟进进度。', conflicts: ['b4'], flawLevel: 0 },
                { text: '坐班才全是在摸鱼！', conflicts: ['b1'], flawLevel: 2 },
              ],
            }),
          };
        }
        return {
          text: JSON.stringify({
            counterArgument: '你说异步文档能解决太理想化了，遇到跨部门突发故障根本来不及写文档，所以远程办公还是会导致效率崩溃！',
            options: [
              { text: '突发故障可走即时语音应急通道，日常研发走异步文档，二者结合并不冲突。', conflicts: [], flawLevel: 0 },
              { text: '跨部门对齐可以每天固定站会。', conflicts: ['b4'], flawLevel: 1 },
              { text: '从来不会有任何突发故障！', conflicts: ['b1', 'b2'], flawLevel: 2 },
            ],
          }),
        };
      },
    });

    const sel = await ctrl.generateViewpoints();
    const r1 = await ctrl.selectViewpoint(sel.viewpoints[0].id);
    await ctrl.submitChoice(r1.clash.currentRound.options[0].id);

    const counterCall = capturedPrompts.at(-1);
    assert.match(counterCall.prompt, /对手「坐班主管」始终维护的原观点：「远程办公必然导致效率崩溃」/);
    assert.match(counterCall.prompt, /用户回应/);
    assert.match(counterCall.prompt, /严禁否定原观点/);
    assert.match(counterCall.prompt, /严禁复读前几轮已说过的旧论据/);
    assert.match(counterCall.prompt, /每条 26-46 字/);
    assert.match(counterCall.instructions, /切换到本轮新角度维护原观点/);
    await ctrl.close();
  });

  it('满 8 回合仍未将对手意志削减至 0 时判定说服失败并进入失败总结', async () => {
    const { ctrl } = createHarness();
    const sel = await ctrl.generateViewpoints();
    let current = await ctrl.selectViewpoint(sel.viewpoints[0].id);

    for (let r = 1; r <= MAX_CLASH_ROUNDS; r += 1) {
      assert.equal(current.phase, 'clash');
      assert.equal(current.clash.round, r);
      const worstOpt = ctrl._debugInternalState().currentOptions.find((o) => o.difficulty === '非常困难');
      current = await ctrl.submitChoice(worstOpt.id);
    }

    assert.equal(current.phase, 'summary');
    assert.equal(current.summary.victory, false);
    assert.equal(current.summary.outcome, 'defeat');
    assert.equal(current.summary.totalRounds, 8);
    assert.ok(current.summary.finalWillpower > 0);
    await ctrl.close();
  });

  it('8 回合多角度广度切换与知识深度由浅入深递进，对手底气随剩余意志下降逐级减弱', () => {
    const angles = new Set();
    for (let r = 1; r <= 8; r += 1) {
      const spec = roundDepthSpec(r);
      assert.ok(spec.stageLabel && spec.angleLabel);
      angles.add(spec.angleLabel);
    }
    assert.equal(angles.size, 8, '1-8 回合应各自具备不重复的切入维度以拓展广度');

    assert.equal(willpowerToneSpec(100).label, '底气十足');
    assert.equal(willpowerToneSpec(62).label, '嘴硬找补');
    assert.equal(willpowerToneSpec(35).label, '底气不足');
    assert.equal(willpowerToneSpec(15).label, '强弩之末');
  });
});
