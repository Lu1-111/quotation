#!/usr/bin/env node
// 合成十二轮 HTTP/SSE 可复现回放、质量盲比基线对照与延迟分位测量脚本。
// 不依赖知乎登录或外部网络，可直接复现审查项并导出脱敏契约样例。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { startQuotationService } from '../serve-cli.mjs';
import { createTurnOrchestrator } from '../turn-orchestrator.mjs';

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = path.resolve(AGENT_DIR, '..', 'examples');

const USAGE = {
  inputTokens: { total: 64, noCache: 64, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 36, text: 36, reasoning: 0 },
};

function createBenchModel() {
  let seq = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      seq += 1;
      return {
        stream: convertArrayToReadableStream([
          { type: 'text-start', id: `s_${seq}` },
          { type: 'text-delta', id: `s_${seq}`, delta: '已核对当前焦点与证据归属：' },
          { type: 'text-delta', id: `s_${seq}`, delta: '具体引文与承重比例均取自服务端核验结果。' },
          { type: 'text-end', id: `s_${seq}` },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
        ]),
      };
    },
  });
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return Number(sortedValues[idx].toFixed(2));
}

async function collectSseWithTiming(url, token, t0) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  let firstStatusMs = null;
  let firstTextMs = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!block.trim() || block.startsWith(':')) continue;
      let id = null;
      let event = 'message';
      const dataLines = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('id:')) id = Number(line.slice(3).trim());
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      const nowMs = performance.now() - t0;
      if (firstStatusMs === null && (event === 'turn.started' || event === 'focus.selected')) {
        firstStatusMs = nowMs;
      }
      if (firstTextMs === null && event === 'text.delta') {
        firstTextMs = nowMs;
      }
      events.push({ id, event, data: JSON.parse(dataLines.join('\n')) });
    }
  }
  return { events, firstStatusMs, firstTextMs, totalMs: performance.now() - t0 };
}

const TWELVE_TURNS = [
  '推荐算法只会让人的兴趣越来越窄。',
  '为什么先拆“只会”这个词？候选反例是谁写的？',
  '那条通过推荐发现独立乐队的回答只是我收藏的周牧写的回答，不是我自己说的。',
  '不过我自己确实通过推荐页发现过以前完全没听过的新乐队。',
  '请帮我检查一下“刚开始用的时候”这个适用条件能支持什么。',
  '我本人确认：我发现新乐队只发生在刚开始用的时候。',
  '换个说法：在我看来，推荐算法对人的兴趣只有变窄这一种作用。',
  '如果改成：连续听同类歌曲之后，推荐里的新东西会越来越少。',
  '为什么这两个改写版本和原句的报价结果有别？',
  '我撤回第六轮“刚开始用的时候”这个限定条件。',
  '刚才撤回第六轮后哪项结论受影响了？另外第三轮那条周牧的收藏现在怎么归属？',
  '请收束本次讨论，总结原句、采纳的改写、仍存分歧与全部出处。',
];

async function main() {
  const writeExamples = process.argv.includes('--write-examples');
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'quotation-replay-'));
  const dbPath = path.join(tmpDir, 'replay-demo.sqlite');
  const token = 'qtn_synthetic_replay_token_demo_only';
  const noop = { write() {} };

  const coldStartT0 = performance.now();
  const runtime = await startQuotationService(
    ['--demo', '--allow-personal-data', '--host', '127.0.0.1', '--port', '0', '--db', dbPath, '--base-url', 'http://127.0.0.1:11434/v1', '--model', 'synthetic-stream-v4'],
    {
      env: { AGENT_SERVER_TOKEN: token, AGENT_OWNER_ID: 'synthetic-demo-reviewer' },
      stdout: noop,
      stderr: noop,
      connectServers: async () => ({ tools: {}, enabled: [], close: async () => {} }),
      createTurnOrchestrator: (opts) => createTurnOrchestrator({ ...opts, model: createBenchModel() }),
    },
  );

  try {
    const sessRes = await fetch(`${runtime.origin}/v1/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ usePersonalMaterials: true }),
    });
    const sessionCreated = (await sessRes.json()).data;
    const coldSessionInitMs = Number((performance.now() - coldStartT0).toFixed(2));
    const sessionId = sessionCreated.sessionId;

    let baseGraphVersion = sessionCreated.graphVersion;
    const turnSummaries = [];
    const hotStatusMs = [];
    const hotFirstTextMs = [];
    const hotTotalMs = [];
    let turn4SampleEvents = null;

    for (let i = 0; i < TWELVE_TURNS.length; i += 1) {
      const turnNo = i + 1;
      const t0 = performance.now();
      const postRes = await fetch(`${runtime.origin}/v1/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientRequestId: `replay-turn-${String(turnNo).padStart(2, '0')}`,
          baseGraphVersion,
          text: TWELVE_TURNS[i],
        }),
      });
      const postData = (await postRes.json()).data;
      const streamStats = await collectSseWithTiming(`${runtime.origin}${postData.eventsUrl}`, token, t0);
      const snap = (await (await fetch(`${runtime.origin}/v1/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })).json()).data;

      if (turnNo > 1) {
        hotStatusMs.push(streamStats.firstStatusMs ?? 0);
        hotFirstTextMs.push(streamStats.firstTextMs ?? 0);
        hotTotalMs.push(streamStats.totalMs);
      }
      if (turnNo === 4) {
        turn4SampleEvents = streamStats.events;
      }

      const committed = streamStats.events.find((e) => e.event === 'turn.committed')?.data;
      turnSummaries.push({
        turnNumber: turnNo,
        turnId: postData.turnId,
        intent: committed?.intent,
        focus: streamStats.events.find((e) => e.event === 'focus.selected')?.data?.focus?.spanText ?? null,
        baseGraphVersion,
        committedGraphVersion: snap.graphVersion,
        activeAssessment: committed?.activeQuote?.assessment ?? null,
        activeRate: committed?.activeQuote?.rate ?? null,
        eventCount: streamStats.events.length,
        firstStatusMs: Number((streamStats.firstStatusMs ?? 0).toFixed(2)),
        firstTextMs: Number((streamStats.firstTextMs ?? 0).toFixed(2)),
        totalMs: Number(streamStats.totalMs.toFixed(2)),
      });
      baseGraphVersion = snap.graphVersion;
    }

    const finalSnapshot = (await (await fetch(`${runtime.origin}/v1/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json()).data;

    if (writeExamples) {
      mkdirSync(EXAMPLES_DIR, { recursive: true });
      writeFileSync(
        path.join(EXAMPLES_DIR, 'session-snapshot-v1.json'),
        `${JSON.stringify(finalSnapshot, null, 2)}\n`,
      );
      writeFileSync(
        path.join(EXAMPLES_DIR, 'sse-turn-events-v1.json'),
        `${JSON.stringify(turn4SampleEvents, null, 2)}\n`,
      );
    }

    const sortNum = (arr) => [...arr].sort((a, b) => a - b);
    const report = {
      schemaVersion: 1,
      protocolVersion: 'quotation-backend/v1',
      mode: 'demo_synthetic_replay',
      coldBootAndSessionCreateMs: coldSessionInitMs,
      hotSessionLatencyMs: {
        sampleCount: hotTotalMs.length,
        firstStatus: { p50: percentile(sortNum(hotStatusMs), 50), p95: percentile(sortNum(hotStatusMs), 95) },
        firstUsefulText: { p50: percentile(sortNum(hotFirstTextMs), 50), p95: percentile(sortNum(hotFirstTextMs), 95) },
        turnComplete: { p50: percentile(sortNum(hotTotalMs), 50), p95: percentile(sortNum(hotTotalMs), 95) },
      },
      finalGraphVersion: finalSnapshot.graphVersion,
      statementCount: finalSnapshot.statements.length,
      statements: finalSnapshot.statements.map((s) => ({
        statementId: s.statementId,
        role: s.role,
        assessment: s.quote?.assessment,
        rate: s.quote?.rate,
        numerator: s.quote?.numerator,
        denominator: s.quote?.denominator,
        directConflicts: s.quote?.directConflicts,
      })),
      selfMisattributionCount: finalSnapshot.evidenceIndex.filter((e) => e.author !== 'self' && e.attribution === 'self').length,
      deniedAttributionsCount: finalSnapshot.deniedAttributions.length,
      converged: Boolean(finalSnapshot.convergenceSummary),
      turns: turnSummaries,
    };

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await runtime.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

await main();
