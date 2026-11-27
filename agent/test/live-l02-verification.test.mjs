import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import {
  createStreamingOutputGuard,
  extractNamedEntities,
  verifyPublicAnalysisProposal,
} from '../verifier.mjs';
import {
  createPublicProposalResolver,
  decomposePublicClaim,
} from '../public-proposal.mjs';

const USAGE = {
  inputTokens: { total: 32, noCache: 32, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 64, text: 64, reasoning: 0 },
};

function makeJsonModel(payloads = []) {
  let idx = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const current = payloads[Math.min(idx++, payloads.length - 1)];
      if (current instanceof Error) throw current;
      const text = typeof current === 'string' ? current : JSON.stringify(current);
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: USAGE,
        warnings: [],
      };
    },
  });
}

test('L-02-1 跨主体隔离：甲工厂 vs 乙工厂（及 A公司/B公司、一车间/二车间）严禁误标冲突或支持，必须归为 unknown 并记入 rejectedItems', () => {
  const yiFactoryEv = {
    id: 'ev_pub_yi_factory',
    sourceType: 'public_search',
    title: '制造企业弹性班次经验',
    author: '陈工',
    attribution: 'other_author',
    excerpt: '乙工厂推行弹性换班制度后良率稳定，一线工人提前报备即可互换班次。',
    url: 'https://www.zhihu.com/question/1001/answer/2001',
  };

  // 即便模型强行将乙工厂提议为 refute，后端硬校验必须拦截，不画冲突边
  const res = verifyPublicAnalysisProposal({
    claimText: '甲工厂绝对不允许一线工人换班',
    decomposition: { subject: '甲工厂', action: '不允许换班' },
    evidenceList: [yiFactoryEv],
    proposal: {
      focus: {
        spanText: '绝对',
        kind: 'quantifier',
        reason: '我先看看「绝对」。只要能找到一个例外，这句话就还能再收一收。',
      },
      relations: [
        {
          evidenceId: yiFactoryEv.id,
          relation: 'refute',
          quote: '乙工厂推行弹性换班制度后良率稳定',
          reason: '乙工厂可以换班，直接反驳甲工厂不能换班。',
        },
      ],
      suggestedRewrite: {
        text: '甲工厂通常不允许一线工人私下换班',
        kept: '留住了你对甲工厂换班规矩的判断。',
        narrowed: '去掉了「绝对」二字。',
        explanation: '原来的判断可以留着，把话说得留点余地。',
        evidenceIds: [yiFactoryEv.id],
      },
    },
  });

  // 绝不能产生冲突边或证据节点
  assert.equal(res.edges.length, 0);
  assert.equal(res.citations.length, 0);
  assert.equal(res.nodes.filter((n) => n.kind === 'evidence').length, 0);

  // verifiedRelations 降级为 unknown，且保留原作者
  assert.equal(res.verifiedRelations.length, 1);
  assert.equal(res.verifiedRelations[0].relation, 'unknown');
  assert.equal(res.verifiedRelations[0].downgradedFrom, 'refute');
  assert.equal(res.verifiedRelations[0].author, '陈工');
  assert.equal(res.verifiedRelations[0].attribution, 'other_author');

  // rejectedItems 准确记录跨主体拦截及被过滤的改写伪出处
  const crossRejected = res.rejectedItems.find((item) => item.reason === 'CROSS_SUBJECT_MISMATCH');
  assert.ok(crossRejected, '必须记录 CROSS_SUBJECT_MISMATCH');
  assert.equal(crossRejected.claimSubject, '甲工厂');
  assert.equal(crossRejected.evidenceSubject, '乙工厂');
  assert.ok(crossRejected.boundaryReason.includes('乙工厂'));
  assert.ok(crossRejected.boundaryReason.includes('甲工厂'));
  assert.ok(res.unknownParts.some((u) => u.includes('乙工厂') && u.includes('甲工厂')));

  // 无已通过核验边时，改写的 evidenceIds 必须被清空，不能挂靠被拦截的跨主体证据
  assert.deepEqual(res.suggestedRewrite.evidenceIds, []);

  // 泛化验证其他跨主体对：A公司 vs B公司、一车间 vs 二车间、某甲 vs 某乙
  const entitiesAB = extractNamedEntities('A公司严禁远程办公，但B公司实行混合办公');
  assert.deepEqual(entitiesAB.map((e) => e.raw), ['A公司', 'B公司']);

  const workshopRes = verifyPublicAnalysisProposal({
    claimText: '一车间从来不允许临时换岗',
    evidenceList: [
      {
        id: 'ev_w2',
        sourceType: 'public_search',
        title: '二车间轮岗办法',
        author: '林师傅',
        excerpt: '二车间每周都支持工友互相换岗协作。',
        url: 'https://www.zhihu.com/question/1002/answer/2002',
      },
    ],
    proposal: {
      relations: [
        {
          evidenceId: 'ev_w2',
          relation: 'refute',
          quote: '二车间每周都支持工友互相换岗协作',
          reason: '二车间允许换岗。',
        },
      ],
    },
  });
  assert.equal(workshopRes.edges.length, 0);
  assert.equal(workshopRes.verifiedRelations[0].relation, 'unknown');
  assert.ok(workshopRes.rejectedItems.some((r) => r.reason === 'CROSS_SUBJECT_MISMATCH'));
});

test('L-02-2 正向对照：同主体直接反驳(refute)、同主体支持(support)、局部场景限定(qualify)与关系变化计算', () => {
  const evRefute = {
    id: 'ev_jia_refute',
    sourceType: 'public_search',
    title: '甲工厂一线排班说明',
    author: '赵班长',
    attribution: 'other_author',
    excerpt: '我在甲工厂干了五年，一线工人只要提前一天报备班组长，就可以正常换班。',
    url: 'https://www.zhihu.com/question/3001/answer/4001',
  };
  const evSupport = {
    id: 'ev_jia_support',
    sourceType: 'public_search',
    title: '甲工厂考勤纪律帖',
    author: '孙师傅',
    attribution: 'other_author',
    excerpt: '甲工厂一线岗位考勤纪律很严，私下口头换班一律按缺勤处理。',
    url: 'https://www.zhihu.com/question/3001/answer/4002',
  };
  const evQualify = {
    id: 'ev_batch_writing',
    sourceType: 'public_search',
    title: 'AI 写作真实体验',
    author: '沈清',
    attribution: 'other_author',
    excerpt: '在批量写稿的场景下，反复用同一个提示词确实会让文章越来越像模板，但用来梳理提纲时反而有启发。',
    url: 'https://www.zhihu.com/question/3002/answer/4003',
  };

  // 1) 同主体甲工厂：同时核验 refute 与 support，确保都能准确追溯到 evidenceId 与原片段真实 quote
  const factoryVerified = verifyPublicAnalysisProposal({
    claimText: '甲工厂绝对不允许一线工人换班',
    evidenceList: [evRefute, evSupport],
    proposal: {
      focus: {
        spanText: '绝对',
        kind: 'quantifier',
        reason: '我先看看「绝对」。只要能找到一个例外，这句话就还能再收一收。',
      },
      relations: [
        {
          evidenceId: evRefute.id,
          relation: 'refute',
          quote: '一线工人只要提前一天报备班组长，就可以正常换班',
          reason: '赵班长提到甲工厂报备后就能换班，和「绝对不允许」正好撞上了。',
        },
        {
          evidenceId: evSupport.id,
          relation: 'support',
          quote: '私下口头换班一律按缺勤处理',
          reason: '孙师傅提到甲工厂严管私下换班，能支撑你对严格考勤的印象。',
        },
      ],
      suggestedRewrite: {
        text: '甲工厂不允许一线工人未经报备私下换班',
        kept: '留住了你对甲工厂换班管得严的判断。',
        narrowed: '把范围收到了「未经报备私下换班」里。',
        explanation: '原来的判断可以留着，加上「未经报备私下换班」，大家更容易懂你在说什么。',
        evidenceIds: [evRefute.id, evSupport.id],
      },
    },
  });

  assert.equal(factoryVerified.edges.length, 2);
  const refuteEdge = factoryVerified.edges.find((e) => e.evidenceId === evRefute.id);
  const supportEdge = factoryVerified.edges.find((e) => e.evidenceId === evSupport.id);
  assert.equal(refuteEdge.relation, 'refute');
  assert.equal(supportEdge.relation, 'support');
  assert.equal(
    evRefute.excerpt.slice(refuteEdge.quoteStartOffset, refuteEdge.quoteEndOffset),
    refuteEdge.quote,
  );
  assert.equal(
    evSupport.excerpt.slice(supportEdge.quoteStartOffset, supportEdge.quoteEndOffset),
    supportEdge.quote,
  );
  for (const node of factoryVerified.nodes.filter((n) => n.kind === 'evidence')) {
    assert.equal(node.attribution, 'other_author');
    assert.ok(node.url && node.author && node.title && node.excerpt);
  }
  assert.deepEqual(factoryVerified.suggestedRewrite.evidenceIds, [evRefute.id, evSupport.id]);

  // 2) 局部场景限定（批量写稿）：即使模型误标为 support，后端也自动规范为 qualify 并记录 scopeCondition
  const writingVerified = verifyPublicAnalysisProposal({
    claimText: 'AI写作只会让文章越来越像模板',
    evidenceList: [evQualify],
    proposal: {
      relations: [
        {
          evidenceId: evQualify.id,
          relation: 'support',
          quote: '在批量写稿的场景下，反复用同一个提示词确实会让文章越来越像模板',
          reason: '这位作者说的是批量写稿，能帮我们看清这一种情况，别的写法还得另看。',
        },
      ],
    },
  });

  assert.equal(writingVerified.edges.length, 1);
  assert.equal(writingVerified.edges[0].relation, 'qualify');
  assert.equal(writingVerified.edges[0].label, '限定');
  assert.ok(writingVerified.edges[0].scopeCondition?.includes('批量写稿'));

  // 3) 关系变化计算：改写后原本的 refute 转为 qualify，自动输出 relationChanges 与具体 changeSummary
  const round2 = verifyPublicAnalysisProposal({
    claimText: '甲工厂不允许一线工人未经报备私下换班',
    evidenceList: [evRefute, evSupport],
    previousPublicAnalysis: factoryVerified,
    proposal: {
      relations: [
        {
          evidenceId: evRefute.id,
          relation: 'qualify',
          scopeCondition: '提前一天报备班组长',
          quote: '一线工人只要提前一天报备班组长，就可以正常换班',
          reason: '补上「未经报备」后，这条报备换班的例子就不再直接反驳你的句子了。',
        },
        {
          evidenceId: evSupport.id,
          relation: 'support',
          quote: '私下口头换班一律按缺勤处理',
          reason: '孙师傅说的正好和这句改写对上。',
        },
      ],
    },
  });

  assert.equal(round2.relationChanges.length, 1);
  assert.equal(round2.relationChanges[0].evidenceId, evRefute.id);
  assert.equal(round2.relationChanges[0].from, 'refute');
  assert.equal(round2.relationChanges[0].to, 'qualify');
  assert.equal(round2.relationChanges[0].status, 'resolved');
  assert.ok(round2.changeSummary && round2.changeSummary.includes('赵班长'));
});

test('L-02-3 无源引文与不存在证据拦截：编造 quote 或不存在 evidenceId 严禁进入可见边与引文', () => {
  const realEv = {
    id: 'ev_real_1',
    sourceType: 'public_search',
    title: '推荐算法冷启动观察',
    author: '许澄',
    attribution: 'other_author',
    excerpt: '刚开始用推荐流时，系统会放一些探索流量，很容易刷到平时不关注的冷门内容。',
    url: 'https://www.zhihu.com/question/5001/answer/6001',
  };

  const res = verifyPublicAnalysisProposal({
    claimText: '推荐算法只会让人的兴趣越来越窄',
    evidenceList: [realEv],
    proposal: {
      relations: [
        // 编造原摘要中根本不存在的 quote -> 拒绝
        {
          evidenceId: realEv.id,
          relation: 'refute',
          quote: '推荐算法已经让90%的用户拓宽了视野',
          reason: '伪造引文应被拦截。',
        },
        // 不存在的 evidenceId -> 拒绝
        {
          evidenceId: 'ev_ghost_999',
          relation: 'support',
          quote: '某虚构片段',
          reason: '不存在的证据 ID 应被拦截。',
        },
      ],
      suggestedRewrite: {
        text: '长期只看同类内容后，推荐算法容易让兴趣越来越窄',
        kept: '留住了你对信息茧房的担心。',
        narrowed: '把范围收到了长期只看同类内容之后。',
        explanation: '原来的担心可以留着，加上前提大家更容易懂。',
        evidenceIds: ['ev_ghost_999', realEv.id],
      },
    },
  });

  assert.equal(res.edges.length, 0);
  assert.equal(res.citations.length, 0);
  assert.equal(res.verifiedRelations.length, 0);
  assert.deepEqual(res.suggestedRewrite.evidenceIds, []);

  const reasons = new Set(res.rejectedItems.map((item) => item.reason));
  assert.ok(reasons.has('QUOTE_NOT_FOUND_IN_EVIDENCE'));
  assert.ok(reasons.has('EVIDENCE_NOT_FOUND'));
  assert.ok(reasons.has('REWRITE_EVIDENCE_NOT_VERIFIED'));

  // 带额外空白的真实引文应可通过空白归一化匹配并还原原文
  const whitespaceRes = verifyPublicAnalysisProposal({
    claimText: '推荐算法只会让人的兴趣越来越窄',
    evidenceList: [realEv],
    proposal: {
      relations: [
        {
          evidenceId: realEv.id,
          relation: 'refute',
          quote: '刚开始用推荐流时，  系统会放一些探索流量',
          reason: '许澄提到刚开始用时会放探索流量，和「只会」撞上了。',
        },
      ],
    },
  });
  assert.equal(whitespaceRes.edges.length, 1);
  assert.equal(whitespaceRes.edges[0].quote, '刚开始用推荐流时，系统会放一些探索流量');
});

test('L-02-4 流式守卫：拦截中文数字百分比/百分点/成数与无引号伪断言，同时放行已核验数值与原文片段', () => {
  const guard = createStreamingOutputGuard({
    allowedQuoteSources: [
      '这位作者提到冷启动阶段探索占比大约百分之十五，其余情况没提。',
      '在批量写稿的场景下，反复用同一个提示词确实会让文章越来越像模板',
    ],
    allowedRates: [58],
    fallbackRateText: '暂无比例（未定）',
  });

  // 模拟跨分片流式推送：混合真实引文、合法数字、中文数字伪比例、成数、无引号权威断言
  const chunks = [
    '先看真依据：“在批量写稿的场景下，反复用同一个提示词确实会让文章越来越像模板”。',
    '原文里提过百分之十五，程序算出的合法比例是百分之五十八。',
    '另外这三条证据和第一轮一成不变的结论都正常放行。',
    '但模型擅自写了七十',
    '二个百分点，又说百分',
    '之六十八的人反对，甚至编了七成二和八十个百分点。',
    '某权威调',
    '查显示效率下降了四十个百分点。',
    '据知乎高赞称，所有工厂早就取消了换班。',
    '有调查表明远程办公产出下降了35%。',
  ];

  let visibleStream = '';
  for (const c of chunks) {
    visibleStream += guard.push(c);
  }
  const flushed = guard.flush();
  visibleStream += flushed.tailText;
  const stats = guard.getStats();

  // 1) 真实引文、原文中出现的“百分之十五”、allowedRates 允许的“百分之五十八”、普通中文数词必须完整放行
  assert.ok(visibleStream.includes('“在批量写稿的场景下，反复用同一个提示词确实会让文章越来越像模板”'));
  assert.ok(visibleStream.includes('百分之十五'));
  assert.ok(visibleStream.includes('百分之五十八'));
  assert.ok(visibleStream.includes('三条证据'));
  assert.ok(visibleStream.includes('一成不变'));

  // 2) 未核验中文百分比/百分点/成数/无引号伪断言绝不可放行到用户可见流
  for (const forbidden of [
    '七十二个百分点',
    '百分之六十八',
    '七成二',
    '八十个百分点',
    '某权威调查',
    '四十个百分点',
    '据知乎高赞称',
    '有调查表明',
    '35%',
  ]) {
    assert.ok(!visibleStream.includes(forbidden), `不应放行未核验表述: ${forbidden}`);
  }

  // 3) getStats 暴露完整统计并标记违规
  assert.equal(stats.hadViolation, true);
  assert.equal(stats.hadBlockedContent, true);
  assert.ok(stats.blockedNumbers.includes('七十二个百分点'));
  assert.ok(stats.blockedNumbers.includes('百分之六十八'));
  assert.ok(stats.blockedNumbers.includes('七成二'));
  assert.ok(stats.blockedNumbers.includes('八十个百分点'));
  assert.ok(stats.blockedAssertions.length >= 3);
  assert.equal(flushed.hadViolation, true);

  // 4) 纯净合规文本不应触发误报
  const cleanGuard = createStreamingOutputGuard({
    allowedQuoteSources: ['一线工人只要提前一天报备班组长，就可以正常换班'],
    allowedRates: [],
  });
  const cleanOut =
    cleanGuard.push('赵班长提到“一线工人只要提前一天报备班组长，就可以正常换班”，这条例子和你的原句正好撞上了。')
    + cleanGuard.flush().tailText;
  assert.equal(cleanGuard.getStats().hadViolation, false);
  assert.equal(cleanGuard.getStats().blockedAssertions.length, 0);
  assert.equal(cleanGuard.getStats().blockedNumbers.length, 0);
  assert.ok(cleanOut.includes('赵班长提到'));
});

test('L-02-5 decomposePublicClaim 与 createPublicProposalResolver：模拟模型 JSON 解析、人情味短句提示词与异常降级', async () => {
  // 1) decomposePublicClaim 正常模型路径
  const decomposeModel = makeJsonModel([
    {
      subject: 'AI 写稿',
      action: '让文章越来越像模板',
      condition: null,
      falsifiableScope: '只要有不用统一模板、反而写出独特表达的例子，「只会」就说得太满了。',
      focusSpan: '只会',
      focusKind: 'quantifier',
      focusReason: '我先看看「只会」。只要能找到一个例外，这句话就还能再收一收。',
      searchQueries: ['AI写稿 模板化 批量', 'AI辅助写作 表达 边界'],
    },
  ]);

  const decomposed = await decomposePublicClaim({
    model: decomposeModel,
    sentence: 'AI写稿只会让文章越来越像模板',
  });

  assert.equal(decomposed.source, 'model');
  assert.equal(decomposed.subject, 'AI 写稿');
  assert.equal(decomposed.focusSpan, '只会');
  assert.equal('AI写稿只会让文章越来越像模板'.slice(decomposed.startOffset, decomposed.endOffset), '只会');
  assert.equal(decomposed.searchQueries.length, 2);
  // 检查提示词已融入去 AI 味规范与禁用词约束
  const decomposePromptText = JSON.stringify(decomposeModel.doGenerateCalls[0].prompt);
  assert.ok(decomposePromptText.includes('15-45 字'));
  assert.ok(decomposePromptText.includes('综上所述'));
  assert.ok(decomposePromptText.includes('不仅……更……'));
  // 推理开关由模型适配层按供应商设置，公开分析提示词不覆盖它。
  assert.equal(decomposeModel.doGenerateCalls[0].providerOptions?.openaiCompatible, undefined);

  // 2) decomposePublicClaim 非法 JSON / 无模型平稳降级
  const brokenModel = makeJsonModel(['这不是合法的 JSON 输出！！！']);
  const degradedDecomp = await decomposePublicClaim({
    model: brokenModel,
    sentence: '甲工厂绝对不允许一线工人换班',
  });
  assert.equal(degradedDecomp.source, 'fallback');
  assert.equal(degradedDecomp.subject, '甲工厂');
  assert.equal(
    '甲工厂绝对不允许一线工人换班'.slice(degradedDecomp.startOffset, degradedDecomp.endOffset),
    degradedDecomp.focusSpan,
  );
  assert.ok(degradedDecomp.searchQueries.length >= 1);

  // 3) createPublicProposalResolver 正常模型路径 + verifyPublicAnalysisProposal 联调
  const publicEvidence = [
    {
      id: 'ev_pub_ai_1',
      sourceType: 'public_search',
      title: '用 AI 写稿三年后的真实感受',
      author: '周行',
      attribution: 'other_author',
      excerpt: '在批量写稿时反复用同一个提示词，文章确实越来越像模板；但如果只让它帮忙拆提纲，反而省出时间打磨自己的话。',
      url: 'https://www.zhihu.com/question/7001/answer/8001',
    },
  ];

  const proposalModel = makeJsonModel([
    {
      focus: {
        spanText: '只会',
        kind: 'quantifier',
        reason: '我先看看「只会」。只要能找到一个例外，这句话就还能再收一收。',
      },
      relations: [
        {
          evidenceId: 'ev_pub_ai_1',
          relation: 'qualify',
          scopeCondition: '批量写稿时反复用同一个提示词',
          quote: '在批量写稿时反复用同一个提示词，文章确实越来越像模板',
          reason: '这位作者说的是批量写稿，能帮我们看清这一种情况，别的写法还得另看。',
        },
      ],
      suggestedRewrite: {
        text: '批量写稿时反复用同一个提示词，AI 容易让文章越来越像模板',
        kept: '留住了你对文章套路化的担心。',
        narrowed: '把话放回了批量写稿和复用同一提示词的场景里。',
        explanation: '原来的担心可以留着，把话放回具体场景里，大家更容易懂你在担心什么。',
        evidenceIds: ['ev_pub_ai_1'],
      },
      unknownParts: ['其他写作体裁下会不会也这样，目前还缺更多例子。'],
      changeSummary: '加上「反复用同一个提示词」后，这条反例就不再直接反驳你的句子了。',
    },
  ]);

  const resolver = createPublicProposalResolver({ model: proposalModel });
  const proposal = await resolver({
    turnId: 'turn_1',
    turnNumber: 1,
    claimText: 'AI写稿只会让文章越来越像模板',
    decomposition: decomposed,
    publicEvidence,
  });

  assert.equal(proposal.source, 'model');
  assert.equal(proposal.relations.length, 1);
  assert.equal(proposal.relations[0].relation, 'qualify');
  assert.ok(proposal.suggestedRewrite.explanation.includes('原来的担心可以留着'));

  const proposalPromptText = JSON.stringify(proposalModel.doGenerateCalls[0].prompt);
  assert.ok(proposalPromptText.includes('15-45 字'));
  assert.ok(proposalPromptText.includes('humanizer-zh'));

  const verified = verifyPublicAnalysisProposal({
    claimText: 'AI写稿只会让文章越来越像模板',
    decomposition: decomposed,
    proposal,
    evidenceList: publicEvidence,
  });
  assert.equal(verified.edges.length, 1);
  assert.equal(verified.edges[0].relation, 'qualify');
  assert.equal(verified.citations.length, 1);
  assert.equal(verified.rejectedItems.length, 0);

  // 4) createPublicProposalResolver 模型异常或无模型时安全降级（不编造跨主体冲突）
  const errResolver = createPublicProposalResolver({ model: makeJsonModel([new Error('upstream 502')]) });
  const fallbackProposal = await errResolver({
    turnId: 'turn_2',
    turnNumber: 2,
    claimText: '甲工厂绝对不允许一线工人换班',
    publicEvidence: [
      {
        id: 'ev_pub_yi',
        sourceType: 'public_search',
        title: '乙工厂弹性换班实践',
        author: '李明',
        excerpt: '乙工厂允许一线工人互相换班。',
        url: 'https://www.zhihu.com/question/8001/answer/9001',
      },
    ],
  });

  assert.equal(fallbackProposal.source, 'fallback');
  assert.equal(fallbackProposal.relations.length, 1);
  assert.equal(fallbackProposal.relations[0].relation, 'unknown');
  assert.ok(fallbackProposal.relations[0].reason.includes('乙工厂'));
  assert.ok(fallbackProposal.relations[0].reason.includes('甲工厂'));
});
