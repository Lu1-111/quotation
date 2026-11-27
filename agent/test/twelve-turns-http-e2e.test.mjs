// 真实 HTTP + SSE + 磁盘 SQLite + 进程重启恢复的十二轮贯穿验收与泛化测试。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { startQuotationService } from '../serve-cli.mjs';
import { createTurnOrchestrator } from '../turn-orchestrator.mjs';

const USAGE = {
  inputTokens: { total: 48, noCache: 48, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 24, text: 24, reasoning: 0 },
};

function createStreamingMockModel() {
  let callIndex = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      callIndex += 1;
      return {
        stream: convertArrayToReadableStream([
          { type: 'text-start', id: `txt_${callIndex}` },
          { type: 'text-delta', id: `txt_${callIndex}`, delta: `【第 ${callIndex} 次流式核验说明·首段】` },
          { type: 'text-delta', id: `txt_${callIndex}`, delta: '已按服务端核验后的证据、归属与承重结构输出结论。' },
          { type: 'text-end', id: `txt_${callIndex}` },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
        ]),
      };
    },
  });
}

async function readSseStream(url, { token, lastEventId = null } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (lastEventId !== null) headers['Last-Event-ID'] = String(lastEventId);
  const res = await fetch(url, { headers });
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

async function submitAndAwaitTurn(origin, token, sessionId, payload) {
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
  assert.ok(types.includes('text.delta'), `Missing text.delta in ${types.join(',')}`);
  assert.ok(types.includes('turn.committed'), `Missing turn.committed in ${types.join(',')}`);
  assert.equal(types.at(-1), 'turn.done');

  const committed = events.find((e) => e.event === 'turn.committed').data;
  const sessionRes = await fetch(`${origin}/v1/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(sessionRes.status, 200);
  const sessionBody = await sessionRes.json();
  return { turnId, eventsUrl, events, committed, session: sessionBody.data };
}

async function bootTestService(dbPath, token = 'qtn_e2e_test_secret_token_123456') {
  const model = createStreamingMockModel();
  const noopOut = { write() {} };
  return startQuotationService(
    ['--demo', '--allow-personal-data', '--host', '127.0.0.1', '--port', '0', '--db', dbPath, '--base-url', 'http://127.0.0.1:11434/v1', '--model', 'mock-stream-v4'],
    {
      env: {
        AGENT_SERVER_TOKEN: token,
        AGENT_OWNER_ID: 'user-e2e-owner',
      },
      stdout: noopOut,
      stderr: noopOut,
      connectServers: async () => ({ tools: {}, enabled: [], close: async () => {} }),
      createTurnOrchestrator: (opts) => createTurnOrchestrator({ ...opts, model }),
    },
  );
}

test('HTTP + SSE + SQLite 十二轮完整跑通、中途重启恢复与非推荐算法新句泛化验收', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'quotation-http-12turns-'));
  const dbPath = path.join(tmpDir, 'twelve-turns.sqlite');
  const token = 'qtn_e2e_test_secret_token_123456';
  let runtime = null;

  try {
    runtime = await bootTestService(dbPath, token);

    // 创建会话：自动锁定合成采集首个 snapshotId 并完成跨页读取
    const createRes = await fetch(`${runtime.origin}/v1/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ usePersonalMaterials: true }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()).data;
    const sessionId = created.sessionId;
    assert.equal(created.dataMode, 'demo');
    assert.equal(created.graphVersion, 0);
    assert.ok(created.lockedSnapshotId, '应锁定首个采集 snapshotId');
    assert.ok(created.outboundPreview.snippetCount >= 8, '外发模型预览应展示将发送的片段列表');

    let v = created.graphVersion;

    // ===== 第 1 轮：输入原句 =====
    const t1 = await submitAndAwaitTurn(runtime.origin, token, sessionId, {
      clientRequestId: 'req-turn-01',
      baseGraphVersion: v,
      text: '推荐算法只会让人的兴趣越来越窄。',
    });
    const focus1 = t1.events.find((e) => e.event === 'focus.selected').data.focus;
    assert.equal(focus1.spanText, '只会');
    assert.equal('推荐算法只会让人的兴趣越来越窄。'.slice(focus1.startOffset, focus1.endOffset), '只会');
    // 收藏他人回答（周牧）不能当作本人立场直接确认冲突
    assert.equal(t1.session.confirmedGraph.length, 0);
    assert.ok(t1.session.pendingConfirmations.length >= 1, '收藏的他人反例应进入待确认区');
    v = t1.session.graphVersion;

    // ===== 第 2 轮：询问为何拆“只会” =====
    const t2 = await submitAndAwaitTurn(runtime.origin, token, sessionId, {
      clientRequestId: 'req-turn-02',
      baseGraphVersion: v,
      text: '为什么先拆“只会”这个词？候选反例是谁说的？',
    });
    assert.equal(t2.session.graphVersion, v, '只问原因与出处不递增 graphVersion');

    // ===== 第 3 轮：指出候选反例只是收藏的他人回答 =====
    const t3 = await submitAndAwaitTurn(runtime.origin, token, sessionId, {
      clientRequestId: 'req-turn-03',
      baseGraphVersion: v,
      text: '那条通过推荐发现独立乐队的回答只是我收藏的周牧写的回答，不是我自己说的。',
    });
    assert.ok(t3.session.deniedAttributions.length >= 1, '第三轮后应持久化否认归属记录');
    const zhouDenial = t3.session.deniedAttributions.find((d) => (d.originalAuthor ?? d.author) === '周牧');
    assert.ok(zhouDenial, '否认记录中必须保留原作者周牧');
    v = t3.session.graphVersion;

    // ===== 第 4 轮：本人陈述亲身发现过新乐队 =====
    const t4 = await submitAndAwaitTurn(runtime.origin, token, sessionId, {
      clientRequestId: 'req-turn-04',
      baseGraphVersion: v,
      text: '不过我自己确实通过推荐页发现过以前完全没听过的新乐队。',
    });
    assert.ok(t4.session.graphVersion > v, '本人确认新事实应递增 graphVersion');
    v = t4.session.graphVersion;
    const origAfterT4 = t4.session.statements.find((s) => s.role === 'original') ?? t4.session.statements[0];
    assert.equal(origAfterT4.quote.assessment, 'conflict');
    assert.ok(Number.isInteger(origAfterT4.quote.rate), '存在本人反例与承重边时应给出整数冲突比例');

    // ===== 第 5 轮：请 Agent 检查“刚开始用的时候”条件 =====
    const t5 = await submitAndAwaitTurn(runtime.origin, token, sessionId, {
      clientRequestId: 'req-turn-05',
      baseGraphVersion: v,
      text: '请帮我检查一下“刚开始用的时候”这个适用条件能支持什么。',
    });
    assert.ok(t5.committed.conditionCheckResult, '第五轮应明确返回局部条件可支持的边界说明');
    v = t5.session.graphVersion;

    // ===== 第 6 轮：本人确认适用范围 =====
    const t6 = await submitAndAwaitTurn(runtime.origin, token, sessionId, {
      clientRequestId: 'req-turn-06',
      baseGraphVersion: v,
      text: '我本人确认：我发现新乐队只发生在刚开始用的时候。',
    });
    assert.ok(t6.session.graphVersion > v, '本人确认限定范围应更新图版本');
    v = t6.session.graphVersion;

    const factT4 = t6.session.facts.find((f) => f.turnId === t4.turnId);
    const condT6 = t6.session.facts.find((f) => f.turnId === t6.turnId);
    assert.ok(factT4 && condT6 && factT4.id !== condT6.id, '本人事实（第 4 轮）与限定条件（第 6 轮）必须分别定位到各自轮次');

    // ===== 中途模拟进程完全退出并从磁盘 SQLite 重启恢复 =====
    await runtime.close();
    runtime = await bootTestService(dbPath, token);

    const refreshedAfterRestart = await (await fetch(`${runtime.origin}/v1/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    assert.equal(refreshedAfterRestart.data.graphVersion, v);
    // 重启后重放第 6 轮已提交事件流（全量重放 + Last-Event-ID 增量续读），验证 turn.committed 完全一致
    const replayedT6Events = await readSseStream(
      `${runtime.origin}${t6.eventsUrl}`,
      { token },
    );
    assert.deepEqual(
      replayedT6Events.find((e) => e.event === 'turn.committed').data,
      t6.committed,
      '进程重启后重放同一轮事件必须返回完全一致的已提交载荷',
    );
    const resumedT6Events = await readSseStream(
      `${runtime.origin}${t6.eventsUrl}`,
      { token, lastEventId: 2 },
    );
    assert.ok(resumedT6Events.every((e) => e.id > 2), 'Last-Event-ID 续读只返回序号大于 2 的事件');
    assert.deepEqual(
      resumedT6Events.find((e) => e.event === 'turn.committed').data,
      t6.committed,
    );

    // ===== 第 7 轮：只换语气 =====
    const t7 = await submitAndAwaitTurn(runtime.origin, token, sessionId, {
      clientRequestId: 'req-turn-07',
      baseGraphVersion: v,
      text: '换个说法：在我看来，推荐算法对人的兴趣只有变窄这一种作用。',
    });
    v = t7.session.graphVersion;

    // ===== 第 8 轮：缩小主张到连续听同类歌曲之后 =====
    const t8 = await submitAndAwaitTurn(runtime.origin, token, sessionId, {
      clientRequestId: 'req-turn-08',
      baseGraphVersion: v,
      text: '如果改成：连续听同类歌曲之后，推荐里的新东西会越来越少。',
    });
    v = t8.session.graphVersion;
    assert.ok(t8.session.statements.length >= 3, '应能同时取回原句与两个改写共三个句子版本');
    const [stmtOrig, stmtTone, stmtScope] = t8.session.statements;
    assert.equal(stmtOrig.quote.graphVersion, v);
    assert.equal(stmtTone.quote.graphVersion, v);
    assert.equal(stmtScope.quote.graphVersion, v);
    assert.equal(stmtOrig.quote.denominator, stmtTone.quote.denominator);
    assert.equal(stmtOrig.quote.denominator, stmtScope.quote.denominator);
    assert.equal(stmtTone.quote.assessment, 'conflict', '只换语气仍保留绝对排他冲突');
    assert.equal(stmtTone.quote.rate, stmtOrig.quote.rate, '只换语气在同一张图上不应降低报价');
    assert.equal(stmtScope.quote.assessment, 'insufficient_evidence', '缺本人证据的缩小范围改写应维持未定');
    assert.equal(stmtScope.quote.rate, null, '缺证据改写不得预设降分');

    // ===== 第 9 轮：追问为什么结果有别 =====
    const t9 = await submitAndAwaitTurn(runtime.origin, token, sessionId, {
      clientRequestId: 'req-turn-09',
      baseGraphVersion: v,
      text: '为什么这两个改写版本和原句的报价结果有别？',
    });
    assert.equal(t9.session.graphVersion, v, '追问对比原因不递增 graphVersion');

    // ===== 第 10 轮：撤回第六轮的条件 =====
    const t10 = await submitAndAwaitTurn(runtime.origin, token, sessionId, {
      clientRequestId: 'req-turn-10',
      baseGraphVersion: v,
      text: '我撤回第六轮“刚开始用的时候”这个限定条件。',
    });
    assert.ok(t10.session.graphVersion > v, '撤回已确认条件应递增 graphVersion 并重算');
    v = t10.session.graphVersion;
    assert.ok(t10.committed.invalidatedItems.length >= 1, '撤回必须明确列出受影响失效的结论项');
    const factT4AfterRetract = t10.session.facts.find((f) => f.turnId === t4.turnId);
    const condT6AfterRetract = t10.session.facts.find((f) => f.turnId === t6.turnId);
    assert.equal(factT4AfterRetract.status, 'active', '第 4 轮独立确认的本人事实必须保留');
    assert.equal(condT6AfterRetract.status, 'retracted', '第 6 轮条件应被标为 retracted');
    assert.ok(
      t10.session.confirmedGraph.some((n) => (n.confirmedTurnId ?? n.turnId) === t4.turnId || (n.sourceFactIds ?? []).includes(factT4AfterRetract.id)),
      '已确认图中第 4 轮独立事实节点必须继续成立',
    );

    // ===== 第 11 轮：追问哪项结论受影响及早期第三轮证据 =====
    const t11 = await submitAndAwaitTurn(runtime.origin, token, sessionId, {
      clientRequestId: 'req-turn-11',
      baseGraphVersion: v,
      text: '刚才撤回第六轮后哪项结论受影响了？另外第三轮那条周牧的收藏现在怎么归属？',
    });
    assert.equal(t11.session.graphVersion, v, '追问受影响项与早期出处不递增 graphVersion');

    // ===== 第 12 轮：收束总结 =====
    const t12 = await submitAndAwaitTurn(runtime.origin, token, sessionId, {
      clientRequestId: 'req-turn-12',
      baseGraphVersion: v,
      text: '请收束本次讨论，总结原句、采纳的改写、仍存分歧与全部出处。',
    });
    const summaryBeforeRestart = t12.session.convergenceSummary;
    assert.ok(summaryBeforeRestart, '第 12 轮后必须生成持久化收束摘要');
    assert.ok(summaryBeforeRestart.originalStatement);
    assert.ok(summaryBeforeRestart.adoptedRewrite);
    assert.ok(Array.isArray(summaryBeforeRestart.disagreements));
    assert.ok(Array.isArray(summaryBeforeRestart.citations) && summaryBeforeRestart.citations.length >= 2);
    // 再次确认周牧仍是原作者，未被篡改为本人
    assert.equal(
      t12.session.evidenceIndex.some((ev) => ev.author === '周牧' && ev.attribution === 'self'),
      false,
      '任何时刻都不得将周牧的回答误归于本人',
    );

    // 终局再次重启进程，核对会话快照与收束报告 100% 一致
    await runtime.close();
    runtime = await bootTestService(dbPath, token);
    const finalSession = (await (await fetch(`${runtime.origin}/v1/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json()).data;
    assert.deepEqual(finalSession.convergenceSummary, summaryBeforeRestart);
    assert.equal(finalSession.turns.length, 12);

    // ===== 泛化测试：完全不含“推荐算法”的新议题句子 =====
    const genCreateRes = await fetch(`${runtime.origin}/v1/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ usePersonalMaterials: true }),
    });
    const genSessionId = (await genCreateRes.json()).data.sessionId;

    const g1 = await submitAndAwaitTurn(runtime.origin, token, genSessionId, {
      clientRequestId: 'gen-turn-01',
      baseGraphVersion: 0,
      text: '远程办公必然降低所有团队的协作效率。',
    });
    const genFocus = g1.events.find((e) => e.event === 'focus.selected').data.focus;
    assert.equal(genFocus.spanText, '必然');
    assert.equal(g1.session.confirmedGraph.length, 0, '陈序关于远程办公的收藏记录不能直接当本人立场');

    const g2 = await submitAndAwaitTurn(runtime.origin, token, genSessionId, {
      clientRequestId: 'gen-turn-02',
      baseGraphVersion: g1.session.graphVersion,
      text: '我自己带跨时区工程团队远程办公时，靠异步文档协作反而缩短了交付周期。',
    });
    const genOrig = g2.session.statements[0];
    assert.equal(genOrig.quote.assessment, 'conflict');
    assert.ok(Number.isInteger(genOrig.quote.rate), '非推荐算法新句确认本人反例后同样能准确算出结构冲突报价');
  } finally {
    if (runtime) await runtime.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
