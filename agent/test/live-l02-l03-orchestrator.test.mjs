// L-02（判断有边界与流式/持久化一致）与 L-03（连续多轮公开对话、追问出处、纠错与同批改写对比）端到端 HTTP/SSE 集成测试。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { createSessionStore } from '../session-store.mjs';
import { createQuotationServer, createPrincipalAuth } from '../server.mjs';
import { createTurnOrchestrator } from '../turn-orchestrator.mjs';
import {
  FORBIDDEN_PUBLIC_JARGON,
  buildPublicTurnSystemPrompt,
  buildPublicGentleFallbackChunks,
} from '../turn-prompts.mjs';

const USAGE = {
  inputTokens: { total: 42, noCache: 42, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 24, text: 24, reasoning: 0 },
};

function createScriptedStreamModel(responses = []) {
  let idx = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = responses[Math.min(idx, responses.length - 1)] ?? ['我先帮你核对了一下手头的材料。'];
      idx += 1;
      const parts = [
        { type: 'text-start', id: `pub_txt_${idx}` },
        ...chunks.map((delta) => ({ type: 'text-delta', id: `pub_txt_${idx}`, delta })),
        { type: 'text-end', id: `pub_txt_${idx}` },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
      ];
      return {
        stream: convertArrayToReadableStream(parts),
      };
    },
  });
}

async function readSseStream(url, { token } = {}) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sepIdx;
    while ((sepIdx = buffer.indexOf('\n\n')) >= 0) {
      const rawBlock = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);
      if (!rawBlock.trim() || rawBlock.startsWith(':')) continue;
      let id = null;
      let event = 'message';
      const dataLines = [];
      for (const line of rawBlock.split('\n')) {
        if (line.startsWith('id:')) id = Number(line.slice(3).trim());
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      events.push({
        id,
        event,
        data: dataLines.length ? JSON.parse(dataLines.join('\n')) : null,
      });
    }
  }
  return events;
}

async function createPublicHttpHarness({
  dbPath,
  token = 'qtn_live_pub_test_token_123456',
  materialsAdapter,
  proposalResolver = null,
  model,
}) {
  const store = createSessionStore(dbPath);
  const auth = createPrincipalAuth({
    tokens: [
      {
        token,
        ownerId: 'public_browser_owner',
        label: 'public-test',
        dataMode: 'real',
      },
    ],
  });
  const orchestrator = createTurnOrchestrator({
    store,
    materialsAdapter,
    proposalResolver,
    model,
    publicMode: true,
    fallbackExplanationWhenNoModel: !model,
    env: {},
  });
  const server = createQuotationServer({
    store,
    orchestrator,
    auth,
    dataMode: 'real',
    allowPersonalData: false,
    materialLoader: materialsAdapter,
    modelConfig: {
      providerName: 'openai-compatible',
      modelName: 'mock-public-v4',
      baseURL: 'http://127.0.0.1:11434/v1',
      ready: true,
    },
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const origin = `http://127.0.0.1:${addr.port}`;

  return {
    origin,
    token,
    store,
    orchestrator,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}

async function createPublicSession(origin, token) {
  const res = await fetch(`${origin}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      dataMode: 'real',
      usePersonalMaterials: false,
    }),
  });
  assert.equal(res.status, 201, `POST /v1/sessions failed: ${await res.clone().text()}`);
  const body = await res.json();
  assert.equal(body.ok, true);
  return body.data;
}

async function submitPublicTurn(origin, token, sessionId, payload) {
  const postRes = await fetch(`${origin}/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  assert.equal(postRes.status, 202, `POST turn failed: ${await postRes.clone().text()}`);
  const postBody = await postRes.json();
  assert.equal(postBody.ok, true);

  const { turnId, eventsUrl } = postBody.data;
  const events = await readSseStream(`${origin}${eventsUrl}`, { token });
  const types = events.map((e) => e.event);

  assert.equal(types[0], 'turn.started');
  assert.equal(types[1], 'focus.selected');
  assert.ok(types.includes('evidence.verified'), `缺少 evidence.verified: ${types.join(',')}`);
  assert.ok(types.includes('text.delta'), `缺少 text.delta: ${types.join(',')}`);
  assert.ok(types.includes('turn.committed'), `缺少 turn.committed: ${types.join(',')}`);
  assert.equal(types.at(-1), 'turn.done');

  const streamedText = events
    .filter((e) => e.event === 'text.delta')
    .map((e) => e.data?.delta ?? '')
    .join('');
  const committed = events.find((e) => e.event === 'turn.committed').data;

  const snapRes = await fetch(`${origin}/v1/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(snapRes.status, 200);
  const snapBody = await snapRes.json();
  const persistedTurn = snapBody.data.turns.find((t) => t.turnId === turnId);

  return {
    turnId,
    events,
    streamedText,
    committed,
    session: snapBody.data,
    persistedTurn,
  };
}

test('L-02 端到端 HTTP/SSE：跨主体不误标冲突，拦截中文百分比与无源引文，SSE/持久化/publicAnalysis 完全一致', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'quotation-l02-'));
  const dbPath = path.join(tmpDir, 'l02.sqlite');

  const factoryBExcerpt = '乙工厂在产线淡季一直允许工人之间互相换班，排班安排比较灵活。';
  const factoryAQualifyExcerpt = '甲工厂平时严控换班，但旺季提前报备后特殊班组偶尔可以临时调换班次。';

  let searchCalls = 0;
  const materialsAdapter = {
    enabled: false,
    async searchPublicEvidence() {
      searchCalls += 1;
      return {
        ok: true,
        status: 'ok',
        requestIds: ['req_zhihu_l02_001'],
        items: [
          {
            id: 'ev_factory_b',
            sourceType: 'public_search',
            title: '乙工厂排班制度实录',
            author: '李工',
            attribution: 'other_author',
            excerpt: factoryBExcerpt,
            url: 'https://www.zhihu.com/question/8001/answer/101',
            requestId: 'req_zhihu_l02_001',
          },
          {
            id: 'ev_factory_a_qualify',
            sourceType: 'public_search',
            title: '甲工厂一线班组调班规则说明',
            author: '周班长',
            attribution: 'other_author',
            excerpt: factoryAQualifyExcerpt,
            url: 'https://www.zhihu.com/question/8001/answer/102',
            requestId: 'req_zhihu_l02_001',
          },
        ],
      };
    },
  };

  // 故意让候选模型犯错：试图把“乙工厂”标为 refute、编造无源引文，并引用不存在的证据 ID
  const adversarialProposalResolver = async () => ({
    relations: [
      {
        evidenceId: 'ev_factory_b',
        relation: 'refute',
        quote: '甲工厂早就全面允许自由换班了',
        reason: '乙工厂允许换班直接反驳了甲工厂不允许换班。',
      },
      {
        evidenceId: 'ev_factory_a_qualify',
        relation: 'qualify',
        quote: '旺季提前报备后特殊班组偶尔可以临时调换班次',
        reason: '周班长说明甲工厂仅在旺季提前报备等特定条件下偶尔允许临时调换班次。',
      },
      {
        evidenceId: 'ev_nonexistent_999',
        relation: 'refute',
        quote: '虚构的厂规原文',
        reason: '不存在的证据条目。',
      },
    ],
    citations: [
      {
        evidenceId: 'ev_factory_b',
        quoteText: '甲工厂早就全面允许自由换班了',
      },
      {
        evidenceId: 'ev_factory_a_qualify',
        quoteText: '旺季提前报备后特殊班组偶尔可以临时调换班次',
      },
    ],
    suggestedRewrite: {
      text: '甲工厂平时不允许工人随意换班，除非旺季提前报备经班组批准。',
      kept: '保留了对甲工厂日常严格管控换班的判断',
      narrowed: '把例外情况收在旺季提前报备的特定班组里',
      explanation: '把日常规则和旺季报备的例外分开说，这句话会更贴合实际。',
      basedOnEvidenceIds: ['ev_factory_a_qualify'],
    },
  });

  // 故意让流式模型输出中文数字百分比、无源引文、跨主体错误冲突断言与实现词
  const adversarialModel = createScriptedStreamModel([
    [
      '根据统计有七十二个百分点的人发现',
      '“甲工厂早就全面允许自由换班了”。',
      '而且乙工厂允许换班直接反驳了你的说法，',
      '总承重分母和图版本 v1 都证明它错了。',
    ],
  ]);

  const harness = await createPublicHttpHarness({
    dbPath,
    materialsAdapter,
    proposalResolver: adversarialProposalResolver,
    model: adversarialModel,
  });

  try {
    const created = await createPublicSession(harness.origin, harness.token);
    assert.equal(created.graphVersion, 0);

    const res = await submitPublicTurn(harness.origin, harness.token, created.sessionId, {
      clientRequestId: 'l02-turn-1',
      baseGraphVersion: 0,
      text: '甲工厂从来不允许工人换班。',
    });

    assert.equal(searchCalls, 1, '首轮应触发公开检索');

    // 1. 公开材料绝不能写入个人 confirmedGraph
    assert.deepEqual(res.session.confirmedGraph, [], '公开证据严禁污染个人 confirmedGraph');

    // 2. publicAnalysis 持久化且与 graphVersion 原子同步
    const pa = res.session.publicAnalysis;
    assert.ok(pa, 'GET /v1/sessions/:id 必须返回持久化 publicAnalysis');
    assert.equal(pa.graphVersion, res.session.graphVersion);
    assert.equal(pa.graphVersion, res.committed.graphVersion);
    assert.equal(pa.graphVersion, 1);
    assert.equal(res.committed.publicAnalysis.version, pa.version);

    // 3. 跨主体（乙工厂）绝不能成为冲突/反驳边，且不存在的 ev_nonexistent_999 被拒绝
    const badFactoryBEdge = pa.edges.find((e) => e.evidenceId === 'ev_factory_b');
    assert.equal(badFactoryBEdge, undefined, '跨主体“乙工厂”绝不能出现在冲突/有效关系边中');
    assert.equal(
      pa.edges.some((e) => e.relation === 'refute' || e.relation === 'conflict'),
      false,
      '不应产生任何错误冲突边',
    );
    assert.equal(
      pa.edges.some((e) => e.evidenceId === 'ev_nonexistent_999'),
      false,
      '不存在的 evidenceId 必须被核验器拦截',
    );

    // 4. 每条已显示边都可追溯到真实证据，且保留了甲工厂的限定证据（qualify）
    assert.equal(pa.edges.length, 1);
    assert.equal(pa.edges[0].evidenceId, 'ev_factory_a_qualify');
    assert.equal(pa.edges[0].relation, 'qualify');
    assert.equal(pa.edges[0].author, '周班长');
    assert.ok(
      factoryAQualifyExcerpt.includes(pa.edges[0].quote),
      '边上的引文必须严格来自真实证据原文片段',
    );

    // 5. 无源引文被彻底清除，不出现在 citations、publicAnalysis、SSE 或落库 responseText 中
    const serializedPa = JSON.stringify(pa);
    assert.equal(serializedPa.includes('甲工厂早就全面允许自由换班了'), false, 'publicAnalysis 严禁含无源引文');
    assert.equal(serializedPa.includes('七十二个百分点'), false, 'publicAnalysis 严禁含编造百分比');

    // 6. SSE 流式输出与落库 responseText 100% 一致，且绝不含被拦截内容或实现词
    assert.equal(res.streamedText, res.persistedTurn.responseText, 'SSE 拼接正文必须与落库 responseText 逐字一致');
    assert.ok(res.streamedText.trim().length > 10, '流式守卫拦截异常文本后应输出温柔的核验兜底说明');
    for (const forbidden of [
      '七十二个百分点',
      '甲工厂早就全面允许自由换班了',
      '乙工厂允许换班直接反驳',
      ...FORBIDDEN_PUBLIC_JARGON,
    ]) {
      assert.equal(
        res.streamedText.includes(forbidden),
        false,
        `用户可见回复不得包含「${forbidden}」：${res.streamedText}`,
      );
      assert.equal(
        res.persistedTurn.responseText.includes(forbidden),
        false,
        `落库正文不得包含「${forbidden}」`,
      );
    }
    assert.ok(res.streamedText.includes('周班长'), '兜底说明应基于已核验的周班长证据');
  } finally {
    await harness.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('L-03 连续多轮公开对话：首轮拆解 -> 追问出处 -> 纠错补条件 -> 改写对比（同批证据、关系变化追踪、留白未知项）', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'quotation-l03-'));
  const dbPath = path.join(tmpDir, 'l03.sqlite');

  const evRefuteExcerpt = '我用不同提示词并结合自己的采访笔记配合 AI 写作，写出来的文章结构和语气差别很大。';
  const evQualifyExcerpt = '如果反复用同一个提示词批量写稿，AI 生成的文章确实容易套路化、越来越像。';

  let searchCallCount = 0;
  const materialsAdapter = {
    enabled: false,
    async searchPublicEvidence() {
      searchCallCount += 1;
      return {
        ok: true,
        status: 'ok',
        requestIds: ['req_zhihu_l03_001'],
        items: [
          {
            id: 'ev_ai_refute',
            sourceType: 'public_search',
            title: '我是怎么用 AI 辅助写深度特稿的',
            author: '林岚',
            attribution: 'other_author',
            excerpt: evRefuteExcerpt,
            url: 'https://www.zhihu.com/question/9002/answer/201',
            requestId: 'req_zhihu_l03_001',
          },
          {
            id: 'ev_ai_qualify',
            sourceType: 'public_search',
            title: '批量用 AI 出稿为什么越看越像？',
            author: '顾远',
            attribution: 'other_author',
            excerpt: evQualifyExcerpt,
            url: 'https://www.zhihu.com/question/9002/answer/202',
            requestId: 'req_zhihu_l03_001',
          },
        ],
      };
    },
  };

  // 使用无外部 LLM 依赖的温柔确定性回复路径（fallbackExplanationWhenNoModel: true），验证完整结构化与文案链路
  const harness = await createPublicHttpHarness({
    dbPath,
    materialsAdapter,
    proposalResolver: null,
    model: null,
  });

  try {
    const created = await createPublicSession(harness.origin, harness.token);

    // ===== 第 1 轮：输入原句 =====
    const t1 = await submitPublicTurn(harness.origin, harness.token, created.sessionId, {
      clientRequestId: 'l03-turn-1',
      baseGraphVersion: 0,
      text: 'AI 写作只会让文章越来越像。',
    });

    assert.equal(searchCallCount, 1, '第 1 轮应检索公开材料');
    const pa1 = t1.session.publicAnalysis;
    assert.ok(pa1);
    assert.equal(pa1.claim.text, 'AI 写作只会让文章越来越像。');
    assert.equal(pa1.claim.focus.spanText, '只会');
    assert.equal(pa1.graphVersion, 1);
    assert.equal(t1.session.graphVersion, 1);
    assert.deepEqual(t1.session.confirmedGraph, [], '公开对话不得写入个人 confirmedGraph');

    const refuteEdge1 = pa1.edges.find((e) => e.evidenceId === 'ev_ai_refute');
    const qualifyEdge1 = pa1.edges.find((e) => e.evidenceId === 'ev_ai_qualify');
    assert.equal(refuteEdge1?.relation, 'refute', '第 1 轮林岚的经验应直接反驳“只会”');
    assert.equal(qualifyEdge1?.relation, 'qualify', '第 1 轮顾远关于反复用同一提示词的说法应标为限定');
    assert.ok(pa1.suggestedRewrite?.text, '第 1 轮应给出可编辑改写');
    assert.ok(pa1.suggestedRewrite.explanation, '改写应附带说明');

    // ===== 第 2 轮：追问「你怎么知道？」 =====
    const t2 = await submitPublicTurn(harness.origin, harness.token, created.sessionId, {
      clientRequestId: 'l03-turn-2',
      baseGraphVersion: t1.session.graphVersion,
      text: '你怎么知道？出处是什么？',
    });

    assert.equal(searchCallCount, 1, '追问出处应复用同批证据，不无谓重复搜索');
    const pa2 = t2.session.publicAnalysis;
    assert.equal(pa2.claim.text, 'AI 写作只会让文章越来越像。', '追问出处必须记住当前原句');
    assert.equal(pa2.materialBoundary.reusedBatch, true);
    assert.equal(pa2.materialBoundary.searchStatus, 'skipped_no_gap');
    assert.equal(t2.session.graphVersion, 1, '纯追问出处不无谓递增图版本');
    assert.equal(pa2.graphVersion, 1);
    assert.ok(
      t2.streamedText.includes('林岚') || t2.streamedText.includes('顾远'),
      `追问出处回复应点明作者来源：${t2.streamedText}`,
    );

    // ===== 第 3 轮：纠正条件「这条其实说的是另一回事 / 我说的其实是反复用同一个提示词」 =====
    const t3 = await submitPublicTurn(harness.origin, harness.token, created.sessionId, {
      clientRequestId: 'l03-turn-3',
      baseGraphVersion: t2.session.graphVersion,
      text: '林岚这条其实说的是另一回事，我说的其实是反复用同一个提示词的情况。',
    });

    assert.equal(searchCallCount, 1, '同题纠错应在同一批证据下重新比较关系');
    const pa3 = t3.session.publicAnalysis;
    assert.equal(pa3.materialBoundary.reusedBatch, true);
    assert.equal(t3.session.graphVersion, 2, '条件变化影响关系，应原子递增版本');
    assert.equal(pa3.graphVersion, 2);

    const refuteRemovedChange = pa3.relationChanges.find((c) => c.evidenceId === 'ev_ai_refute');
    assert.ok(refuteRemovedChange, 'relationChanges 必须明确记录林岚这条关系的变化');
    assert.equal(refuteRemovedChange.previousRelation, 'refute');
    assert.notEqual(refuteRemovedChange.currentRelation, 'refute', '补充条件后林岚不再直接反驳');
    assert.ok(
      pa3.changeSummary.includes('反复用同一个提示词'),
      `changeSummary 应具体指出加入的条件变化：${pa3.changeSummary}`,
    );
    assert.equal(
      pa3.edges.some((e) => e.evidenceId === 'ev_ai_refute' && e.relation === 'refute'),
      false,
      '纠错后林岚的反驳边应从当前有效冲突边中消解',
    );

    // ===== 第 4 轮：用户输入自己的改写版本 =====
    const t4 = await submitPublicTurn(harness.origin, harness.token, created.sessionId, {
      clientRequestId: 'l03-turn-4',
      baseGraphVersion: t3.session.graphVersion,
      text: '如果反复用同一个提示词批量写稿，AI 写作容易让文章越来越像。',
    });

    assert.equal(searchCallCount, 1, '同题改写应在同批证据下可比');
    const pa4 = t4.session.publicAnalysis;
    assert.equal(pa4.materialBoundary.reusedBatch, true);
    assert.equal(t4.session.graphVersion, 3);
    assert.equal(pa4.graphVersion, 3);
    assert.ok(
      pa4.statementHistory.length >= 3,
      'statementHistory 应保留原句与后续改写版本，便于同批证据对比',
    );
    assert.equal(pa4.statementHistory[0].text, 'AI 写作只会让文章越来越像。');
    assert.equal(
      pa4.statementHistory.at(-1).text,
      '如果反复用同一个提示词批量写稿，AI 写作容易让文章越来越像。',
    );
    // 顾远的证据落在同一范围内（支持/限定），林岚的非匹配场景保持未知/留白
    const guEdge4 = pa4.edges.find((e) => e.evidenceId === 'ev_ai_qualify');
    assert.ok(guEdge4 && ['support', 'qualify'].includes(guEdge4.relation), '改写后顾远材料应呼应或限定当前句子');
    assert.ok(pa4.materialBoundary.unknownCount >= 1, '未覆盖情形应保持未知/留白');
    assert.equal(t4.streamedText, t4.persistedTurn.responseText);

    // 验证每轮回复都不含实现词与人机列表套话
    for (const turnRes of [t1, t2, t3, t4]) {
      for (const jargon of FORBIDDEN_PUBLIC_JARGON) {
        assert.equal(
          turnRes.streamedText.includes(jargon),
          false,
          `回复不得包含实现词「${jargon}」：${turnRes.streamedText}`,
        );
      }
      assert.equal(/首先.*其次.*最后|综上所述|1\.\s*.*\n2\./s.test(turnRes.streamedText), false);
    }
  } finally {
    await harness.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('公开模式降级与真人聊天提示词红线：限流/空结果温柔提示，无 AI 味套话', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'quotation-pub-degrade-'));
  const dbPath = path.join(tmpDir, 'degrade.sqlite');

  const rateLimitedAdapter = {
    enabled: false,
    async searchPublicEvidence() {
      return {
        ok: false,
        status: 'rate_limited',
        error: { code: 'RATE_LIMITED', message: '429 Too Many Requests' },
      };
    },
  };

  const harness = await createPublicHttpHarness({
    dbPath,
    materialsAdapter: rateLimitedAdapter,
    model: null,
  });

  try {
    const created = await createPublicSession(harness.origin, harness.token);
    const res = await submitPublicTurn(harness.origin, harness.token, created.sessionId, {
      clientRequestId: 'degrade-turn-1',
      baseGraphVersion: 0,
      text: '周末早起一定能提高一整周的工作状态。',
    });

    const pa = res.session.publicAnalysis;
    assert.equal(pa.materialBoundary.searchStatus, 'rate_limited');
    assert.equal(pa.claim.text, '周末早起一定能提高一整周的工作状态。');
    assert.ok(res.streamedText.includes('这次没能查到资料'), `限流提示应自然温和：${res.streamedText}`);
    assert.ok(res.streamedText.includes('原句还在这里'));

    // 校验真人聊天提示词约束
    const sysPrompt = buildPublicTurnSystemPrompt({ publicAction: 'new_claim', searchStatus: 'ok' });
    assert.ok(sysPrompt.includes('60–140'), '系统提示词应约束真人聊天字数范围');
    assert.ok(sysPrompt.includes('不仅……更……'), '系统提示词应明确禁用中文 AI 路标词');

    const emptyChunks = buildPublicGentleFallbackChunks({
      publicAnalysis: {
        claim: { text: '周末早起一定能提高状态。', focus: { spanText: '一定', kind: 'quantifier' } },
        edges: [],
        citations: [],
        materialBoundary: { searchStatus: 'empty', recalledCount: 1, unknownCount: 1 },
      },
      publicAction: 'new_claim',
    });
    const emptyText = emptyChunks.join('');
    assert.ok(emptyText.includes('相近的说法'));
    assert.ok(emptyText.includes('把范围说清'));
  } finally {
    await harness.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
