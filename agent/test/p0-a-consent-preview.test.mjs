// P0-A HTTP 验收测试：R-A1、R-A2 及 F-A1（首次云推理先预览后确认门禁）、F-A2（240 字裁剪逐项核对、撤回与重启保持、回环与关闭材料直通）。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { computeOutboundPreviewId } from '../material-policy.mjs';
import { startQuotationService } from '../serve-cli.mjs';
import { createTurnOrchestrator } from '../turn-orchestrator.mjs';

const USAGE = {
  inputTokens: { total: 48, noCache: 48, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 18, text: 18, reasoning: 0 },
};

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeExactLengthSnippet({ prefix, headMarker, tailMarker, totalChars = 240 }) {
  const headBase = `${prefix}${headMarker}`;
  const headChars = Array.from(headBase);
  assert.ok(headChars.length < 150, 'headBase 必须位于前 160 码点内');
  const headPadLen = 160 - headChars.length;
  const first160 = `${headBase}${'甲'.repeat(headPadLen)}`;
  assert.equal(Array.from(first160).length, 160);

  const tailChars = Array.from(tailMarker);
  const remain = totalChars - 160 - tailChars.length;
  assert.ok(remain >= 0, 'tailMarker 必须能放进 161..240 码点内');
  const tailPart = `${'乙'.repeat(remain)}${tailMarker}`;
  const full = `${first160}${tailPart}`;
  assert.equal(Array.from(full).length, totalChars);
  return { full, first160, tailPart };
}

function createCapturingModel(chunkFactory = null) {
  const capturedCalls = [];
  let callIndex = 0;
  const model = new MockLanguageModelV4({
    doStream: async (params) => {
      callIndex += 1;
      capturedCalls.push(params);
      const chunks = typeof chunkFactory === 'function'
        ? await chunkFactory({ callIndex, params })
        : ['已基于当前轮次服务端核验过的依据完成说明。'];
      const parts = [{ type: 'text-start', id: `txt_${callIndex}` }];
      for (const delta of chunks) {
        parts.push({ type: 'text-delta', id: `txt_${callIndex}`, delta });
      }
      parts.push(
        { type: 'text-end', id: `txt_${callIndex}` },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
      );
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
  return { model, capturedCalls };
}

function extractPromptText(call) {
  const msgs = call?.prompt ?? [];
  if (typeof msgs === 'string') return msgs;
  if (!Array.isArray(msgs)) return JSON.stringify(msgs);
  const parts = [];
  for (const msg of msgs) {
    if (typeof msg?.content === 'string') {
      parts.push(msg.content);
    } else if (Array.isArray(msg?.content)) {
      for (const seg of msg.content) {
        if (typeof seg?.text === 'string') parts.push(seg.text);
        else parts.push(JSON.stringify(seg));
      }
    }
  }
  return parts.join('\n');
}

async function readSseStream(url, { token } = {}) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200, `SSE GET failed (${res.status})`);
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

async function createSessionHttp(origin, token, body = {}) {
  const res = await fetch(`${origin}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, body: json, data: json.data, error: json.error };
}

async function createConfirmedCloudSessionHttp(origin, token, extraBody = {}) {
  const previewRes = await createSessionHttp(origin, token, {
    usePersonalMaterials: true,
    ...extraBody,
  });
  assert.equal(previewRes.status, 403, '首次云推理创建会话必须先返回 403 实际预览清单');
  assert.equal(previewRes.error.code, 'CLOUD_CONSENT_REQUIRED');
  const preview = previewRes.error.details?.outboundPreview;
  assert.ok(preview?.outboundPreviewId, '首次预览必须返回非空 outboundPreviewId');
  assert.equal(preview.previewConfirmed, false);
  assert.equal(preview.cloudConsentGranted, false);
  assert.equal(preview.confirmedOutboundPreviewId, null);
  assert.ok(Array.isArray(preview.items) && preview.items.length > 0, '首次预览必须包含实际非空个人材料片段');

  const created = await createSessionHttp(origin, token, {
    usePersonalMaterials: true,
    ...extraBody,
    cloudConsent: true,
    outboundPreviewId: preview.outboundPreviewId,
    ...(preview.snapshotId ? { snapshotId: preview.snapshotId } : {}),
  });
  return { previewRes, preview, created };
}

function countPersistedSessions(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM sessions').get();
    return Number(row?.cnt ?? 0);
  } finally {
    db.close();
  }
}

async function getSessionHttp(origin, token, sessionId) {
  const res = await fetch(`${origin}/v1/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  return { status: res.status, body: json, data: json.data, error: json.error };
}

async function postTurnHttp(origin, token, sessionId, payload) {
  const res = await fetch(`${origin}/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  return { status: res.status, body: json, data: json.data, error: json.error };
}

function buildMockMcpTools({
  collectionRecords = [],
  snapshotId = 'snap_p0a_001',
  searchHandler = null,
} = {}) {
  return {
    zhihu_knowledge_profile: {
      execute: async (args = {}) => {
        const offset = Number.isInteger(args.offset) ? args.offset : 0;
        const limit = Number.isInteger(args.limit) ? args.limit : 10;
        const bodyMaxChars = Number.isInteger(args.bodyMaxChars) ? args.bodyMaxChars : 0;
        const slice = collectionRecords.slice(offset, offset + limit).map((rec) => {
          if (rec.bodyStatus === 'available' && typeof rec.bodyText === 'string' && bodyMaxChars > 0) {
            const clipped = rec.bodyText.slice(0, bodyMaxChars);
            return {
              ...rec,
              bodyText: clipped,
              bodyTruncated: clipped.length < rec.bodyText.length,
            };
          }
          const copy = { ...rec };
          delete copy.bodyText;
          return copy;
        });
        const hasMore = offset + slice.length < collectionRecords.length;
        return {
          schemaVersion: 1,
          ok: true,
          data: {
            snapshotId,
            userId: '00000000-0000-4000-8000-000000000111',
            records: slice,
            page: {
              offset,
              limit,
              total: collectionRecords.length,
              returned: slice.length,
              hasMore,
              nextOffset: hasMore ? offset + slice.length : null,
            },
          },
          error: null,
        };
      },
    },
    zhihu_search: {
      execute: async (args = {}) => {
        if (typeof searchHandler === 'function') {
          return await searchHandler(args);
        }
        return {
          schemaVersion: 1,
          ok: true,
          data: {
            requestId: 'req_p0a_search_1',
            page: { offset: 0, limit: 6, total: 0, returned: 0, hasMore: false, nextOffset: null },
            items: [],
          },
          error: null,
        };
      },
    },
  };
}

// ============================================================================
// R-A1：持久化云授权撤回、兼容字段重算、省略字段及重启保持拒绝、重新确认预览后恢复，以及回环模型豁免
// ============================================================================
test('R-A1：云授权撤回持久化、重复撤回幂等、后续省略与重启后保持 403、重确认预览恢复调用，及回环模型在 false 下仍可用本机材料', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'p0a-ra1-'));
  const cloudDbPath = path.join(tmpDir, 'ra1-cloud.sqlite');
  const localDbPath = path.join(tmpDir, 'ra1-loopback.sqlite');
  const token = 'qtn_p0a_ra1_token_987654';
  const noopOut = { write() {} };

  const records = [
    {
      contentId: 'ra1_remote_1',
      contentType: 'answer',
      title: '远程办公团队的异步文档实践',
      summary: 'RA1_PERSONAL_REMOTE_SNIPPET：跨时区团队通过书面接口契约缩短交付周期。',
      summaryTruncated: false,
      bodyStatus: 'available',
      fullTextAvailable: true,
      bodyText: 'RA1_PERSONAL_REMOTE_SNIPPET：跨时区团队通过书面接口契约缩短交付周期。',
      author: '陈序',
      kinds: ['collections'],
      url: 'https://www.zhihu.com/question/5001/answer/1',
    },
  ];

  const cloudModelPack = createCapturingModel();
  const bootCloud = () =>
    startQuotationService(
      [
        '--allow-personal-data',
        '--host', '127.0.0.1',
        '--port', '0',
        '--db', cloudDbPath,
        '--base-url', 'https://api.cloud-ra1.example/v1',
        '--model', 'ra1-cloud-model',
      ],
      {
        env: { AGENT_SERVER_TOKEN: token, AGENT_OWNER_ID: 'owner_ra1' },
        stdout: noopOut,
        stderr: noopOut,
        connectServers: async () => ({
          tools: buildMockMcpTools({ collectionRecords: records, snapshotId: 'snap_ra1_001' }),
          enabled: ['collection', 'search'],
          close: async () => {},
        }),
        createTurnOrchestrator: (opts) => createTurnOrchestrator({ ...opts, model: cloudModelPack.model }),
      },
    );

  const localModelPack = createCapturingModel();
  const bootLoopback = () =>
    startQuotationService(
      [
        '--allow-personal-data',
        '--host', '127.0.0.1',
        '--port', '0',
        '--db', localDbPath,
        '--base-url', 'http://127.0.0.1:11434/v1',
        '--model', 'ra1-local-model',
      ],
      {
        env: { AGENT_SERVER_TOKEN: token, AGENT_OWNER_ID: 'owner_ra1' },
        stdout: noopOut,
        stderr: noopOut,
        connectServers: async () => ({
          tools: buildMockMcpTools({ collectionRecords: records, snapshotId: 'snap_ra1_local' }),
          enabled: ['collection', 'search'],
          close: async () => {},
        }),
        createTurnOrchestrator: (opts) => createTurnOrchestrator({ ...opts, model: localModelPack.model }),
      },
    );

  let cloudRuntime = null;
  let localRuntime = null;
  try {
    cloudRuntime = await bootCloud();

    // ① 先预览拿到实际 outboundPreviewId 与 snapshotId，再显式确认创建会话并提交第 1 轮成功
    const { preview, created } = await createConfirmedCloudSessionHttp(cloudRuntime.origin, token);
    assert.equal(created.status, 201);
    assert.equal(created.data.outboundPreview.outboundPreviewId, preview.outboundPreviewId);
    assert.equal(created.data.outboundPreview.confirmedOutboundPreviewId, preview.outboundPreviewId);
    assert.equal(created.data.outboundPreview.cloudConsentGranted, true);
    assert.equal(created.data.outboundPreview.previewConfirmed, true);
    assert.equal(created.data.lockedSnapshotId, 'snap_ra1_001');

    const sessionId = created.data.sessionId;
    const t1Post = await postTurnHttp(cloudRuntime.origin, token, sessionId, {
      clientRequestId: 'ra1-turn-1',
      baseGraphVersion: 0,
      text: '远程办公必然降低所有研发团队的协作效率。',
      cloudConsent: true,
    });
    assert.equal(t1Post.status, 202);
    const t1Events = await readSseStream(`${cloudRuntime.origin}${t1Post.data.eventsUrl}`, { token });
    assert.ok(t1Events.some((e) => e.event === 'turn.committed'));
    assert.equal(cloudModelPack.capturedCalls.length, 1);

    const snapAfterT1 = (await getSessionHttp(cloudRuntime.origin, token, sessionId)).data;
    assert.equal(snapAfterT1.cloudConsent, true);
    assert.equal(snapAfterT1.allowCloudModel, true);
    const graphVersionBeforeRevoke = snapAfterT1.graphVersion;

    // ② 同会话传 cloudConsent: false 撤回 -> 403，模型调用数不变，GET 返回 cloudConsent: false 与重算后的兼容字段
    const revokeRes1 = await postTurnHttp(cloudRuntime.origin, token, sessionId, {
      clientRequestId: 'ra1-turn-2-revoke',
      baseGraphVersion: graphVersionBeforeRevoke,
      text: '远程办公团队的异步文档实践真的有效吗？',
      cloudConsent: false,
    });
    assert.equal(revokeRes1.status, 403);
    assert.equal(revokeRes1.error.code, 'CLOUD_CONSENT_REQUIRED');
    assert.ok(revokeRes1.error.details?.outboundPreview?.outboundPreviewId);
    assert.equal(revokeRes1.error.details.outboundPreview.cloudConsentGranted, false);
    assert.equal(revokeRes1.error.details.outboundPreview.previewConfirmed, false);
    assert.equal(cloudModelPack.capturedCalls.length, 1, '撤回轮不得增加云模型调用数');

    const snapAfterRevoke1 = (await getSessionHttp(cloudRuntime.origin, token, sessionId)).data;
    assert.equal(snapAfterRevoke1.cloudConsent, false, 'GET /v1/sessions/:id 必须返回 cloudConsent: false');
    assert.equal(snapAfterRevoke1.allowCloudModel, false, '兼容字段 allowCloudModel 必须重算为 false');
    assert.equal(snapAfterRevoke1.metadata.cloudConsent, false, 'metadata.cloudConsent 必须同步为 false');
    assert.equal(snapAfterRevoke1.confirmedOutboundPreviewId, null);
    assert.equal(snapAfterRevoke1.outboundPreview.cloudConsentGranted, false);
    assert.equal(snapAfterRevoke1.outboundPreview.previewConfirmed, false);
    assert.equal(snapAfterRevoke1.outboundPreview.confirmedOutboundPreviewId, null);
    assert.equal(snapAfterRevoke1.graphVersion, graphVersionBeforeRevoke, '撤回不得改变 graphVersion');
    assert.equal(snapAfterRevoke1.turns.length, 1);

    // 重复撤回严格幂等，图版本保持原值
    const revokeRes2 = await postTurnHttp(cloudRuntime.origin, token, sessionId, {
      clientRequestId: 'ra1-turn-2-revoke-again',
      baseGraphVersion: graphVersionBeforeRevoke,
      text: '再次撤回云端授权。',
      cloudConsent: false,
    });
    assert.equal(revokeRes2.status, 403);
    assert.equal(revokeRes2.error.code, 'CLOUD_CONSENT_REQUIRED');
    const snapAfterRevoke2 = (await getSessionHttp(cloudRuntime.origin, token, sessionId)).data;
    assert.equal(snapAfterRevoke2.cloudConsent, false);
    assert.equal(snapAfterRevoke2.graphVersion, graphVersionBeforeRevoke);
    assert.equal(cloudModelPack.capturedCalls.length, 1);

    // ③ 下一轮省略 cloudConsent -> 必须读取持久化状态返回 403，模型调用数不变
    const omitRes = await postTurnHttp(cloudRuntime.origin, token, sessionId, {
      clientRequestId: 'ra1-turn-3-omit',
      baseGraphVersion: graphVersionBeforeRevoke,
      text: '远程办公必然降低跨时区交付效率。',
    });
    assert.equal(omitRes.status, 403);
    assert.equal(omitRes.error.code, 'CLOUD_CONSENT_REQUIRED');
    assert.ok(omitRes.error.details?.outboundPreview?.outboundPreviewId);
    assert.equal(cloudModelPack.capturedCalls.length, 1, '撤回后省略 cloudConsent 不得触发云模型调用');

    // ④ 重启服务后再次提交（省略 cloudConsent）-> 结果一致且 GET 仍为 cloudConsent: false
    await cloudRuntime.close();
    cloudRuntime = await bootCloud();

    const snapAfterRestart = (await getSessionHttp(cloudRuntime.origin, token, sessionId)).data;
    assert.equal(snapAfterRestart.cloudConsent, false, '重启后 GET /v1/sessions/:id 必须保持 cloudConsent: false');
    assert.equal(snapAfterRestart.allowCloudModel, false);
    assert.equal(snapAfterRestart.outboundPreview.cloudConsentGranted, false);

    const restartText = '远程办公必然导致跨时区沟通完全失效。';
    const afterRestartOmit = await postTurnHttp(cloudRuntime.origin, token, sessionId, {
      clientRequestId: 'ra1-turn-4-restart-omit',
      baseGraphVersion: graphVersionBeforeRevoke,
      text: restartText,
      action: { type: 'analyze_statement' },
    });
    assert.equal(afterRestartOmit.status, 403);
    assert.equal(afterRestartOmit.error.code, 'CLOUD_CONSENT_REQUIRED');
    assert.equal(cloudModelPack.capturedCalls.length, 1, '重启后省略 cloudConsent 仍不得调用云模型');

    // 仅传 cloudConsent: true 但未携带当前预览的 outboundPreviewId -> 要求先确认预览 ID
    const reconsentWithoutId = await postTurnHttp(cloudRuntime.origin, token, sessionId, {
      clientRequestId: 'ra1-turn-5-no-preview-id',
      baseGraphVersion: graphVersionBeforeRevoke,
      text: restartText,
      action: { type: 'analyze_statement' },
      cloudConsent: true,
    });
    assert.equal(reconsentWithoutId.status, 403);
    assert.equal(reconsentWithoutId.error.code, 'CLOUD_CONSENT_REQUIRED');
    const previewIdForTurn5 = reconsentWithoutId.error.details?.outboundPreview?.outboundPreviewId;
    assert.ok(previewIdForTurn5, '403 响应必须附带最新 outboundPreviewId');
    assert.equal(reconsentWithoutId.error.details?.outboundPreview?.items?.length, 1);
    assert.equal(cloudModelPack.capturedCalls.length, 1);

    // ⑤ 重新确认当前预览的 outboundPreviewId 并传 cloudConsent: true -> 恢复调用成功
    const reconsentOk = await postTurnHttp(cloudRuntime.origin, token, sessionId, {
      clientRequestId: 'ra1-turn-5-confirmed',
      baseGraphVersion: graphVersionBeforeRevoke,
      text: restartText,
      action: { type: 'analyze_statement' },
      cloudConsent: true,
      outboundPreviewId: previewIdForTurn5,
    });
    assert.equal(reconsentOk.status, 202);
    const t5Events = await readSseStream(`${cloudRuntime.origin}${reconsentOk.data.eventsUrl}`, { token });
    assert.ok(t5Events.some((e) => e.event === 'turn.committed'));
    assert.equal(cloudModelPack.capturedCalls.length, 2, '重新确认当前预览后应恢复云模型调用');

    const snapRecovered = (await getSessionHttp(cloudRuntime.origin, token, sessionId)).data;
    assert.equal(snapRecovered.cloudConsent, true);
    assert.equal(snapRecovered.allowCloudModel, true);
    assert.equal(snapRecovered.confirmedOutboundPreviewId, previewIdForTurn5);
    assert.equal(snapRecovered.outboundPreview.previewConfirmed, true);

    // ⑥ 另验回环模型在 cloudConsent: false 时仍持久化 false 且继续使用已授权本机材料运行
    localRuntime = await bootLoopback();
    const localSess = await createSessionHttp(localRuntime.origin, token, {
      usePersonalMaterials: true,
      cloudConsent: true,
    });
    assert.equal(localSess.status, 201);

    const localTurnRevoke = await postTurnHttp(localRuntime.origin, token, localSess.data.sessionId, {
      clientRequestId: 'ra1-local-turn-1',
      baseGraphVersion: 0,
      text: '远程办公必然降低跨时区团队协作效率。',
      cloudConsent: false,
    });
    assert.equal(localTurnRevoke.status, 202, '回环模型在 cloudConsent: false 时仍应放行本机材料');
    const localEvents = await readSseStream(`${localRuntime.origin}${localTurnRevoke.data.eventsUrl}`, { token });
    assert.ok(localEvents.some((e) => e.event === 'turn.committed'));
    assert.equal(localModelPack.capturedCalls.length, 1);
    assert.ok(extractPromptText(localModelPack.capturedCalls[0]).includes('RA1_PERSONAL_REMOTE_SNIPPET'));

    const localSnap = (await getSessionHttp(localRuntime.origin, token, localSess.data.sessionId)).data;
    assert.equal(localSnap.cloudConsent, false, '回环模型下显式 cloudConsent: false 也应持久化记录为 false');
  } finally {
    if (cloudRuntime) await cloudRuntime.close();
    if (localRuntime) await localRuntime.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// R-A2：240 字合成片段预览与请求逐项一致（无后段泄露）、切换片段拒绝旧确认、调用前撤回中断
// ============================================================================
test('R-A2：240 字合成片段预览与云模型请求逐项一致且无后段泄露、切换个人片段旧确认被拒、调用前撤回触发取消信号并保持 0 调用', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'p0a-ra2-'));
  const dbPath = path.join(tmpDir, 'ra2-main.sqlite');
  const inflightDbPath = path.join(tmpDir, 'ra2-inflight.sqlite');
  const token = 'qtn_p0a_ra2_token_654321';
  const noopOut = { write() {} };

  const HEAD_ALPHA = 'RA2_HEAD_ALPHA_160_OK';
  const TAIL_ALPHA = 'RA2_TAIL_ALPHA_LEAK_FORBIDDEN';
  const snippetA = makeExactLengthSnippet({
    prefix: '远程办公跨时区异步文档协作实测：',
    headMarker: HEAD_ALPHA,
    tailMarker: TAIL_ALPHA,
    totalChars: 240,
  });

  const HEAD_BETA = 'RA2_HEAD_BETA_160_OK';
  const TAIL_BETA = 'RA2_TAIL_BETA_LEAK_FORBIDDEN';
  const snippetB = makeExactLengthSnippet({
    prefix: '推荐算法冷启动独立乐队探索记录：',
    headMarker: HEAD_BETA,
    tailMarker: TAIL_BETA,
    totalChars: 240,
  });

  const twoLongRecords = [
    {
      contentId: 'ra2_alpha_240',
      contentType: 'answer',
      title: '远程办公跨时区协作复盘',
      summary: snippetA.full,
      summaryTruncated: false,
      bodyStatus: 'available',
      fullTextAvailable: true,
      bodyText: snippetA.full,
      author: '陈序',
      kinds: ['collections'],
      url: 'https://www.zhihu.com/question/6101/answer/1',
    },
    {
      contentId: 'ra2_beta_240',
      contentType: 'answer',
      title: '推荐算法发现独立乐队笔记',
      summary: snippetB.full,
      summaryTruncated: false,
      bodyStatus: 'available',
      fullTextAvailable: true,
      bodyText: snippetB.full,
      author: '周牧',
      kinds: ['collections'],
      url: 'https://www.zhihu.com/question/6102/answer/2',
    },
  ];

  const mainModelPack = createCapturingModel();
  let mainRuntime = null;
  let inflightRuntime = null;

  try {
    mainRuntime = await startQuotationService(
      [
        '--allow-personal-data',
        '--host', '127.0.0.1',
        '--port', '0',
        '--db', dbPath,
        '--base-url', 'https://api.cloud-ra2.example/v1',
        '--model', 'ra2-cloud-model',
      ],
      {
        env: { AGENT_SERVER_TOKEN: token, AGENT_OWNER_ID: 'owner_ra2' },
        stdout: noopOut,
        stderr: noopOut,
        connectServers: async () => ({
          tools: buildMockMcpTools({ collectionRecords: twoLongRecords, snapshotId: 'snap_ra2_240' }),
          enabled: ['collection', 'search'],
          close: async () => {},
        }),
        createTurnOrchestrator: (opts) => createTurnOrchestrator({ ...opts, model: mainModelPack.model }),
      },
    );

    // ① 先预览再确认创建会话（携带匹配的 outboundPreviewId + snapshotId），提交命中 240 字片段 A 的第 1 轮
    const { preview: sessionPreview, created } = await createConfirmedCloudSessionHttp(mainRuntime.origin, token);
    assert.equal(created.status, 201);
    assert.equal(created.data.outboundPreview.outboundPreviewId, sessionPreview.outboundPreviewId);
    assert.equal(created.data.outboundPreview.previewConfirmed, true);
    const sessionId = created.data.sessionId;

    // 校验会话级预览中所有条目均已按 160 码点裁剪且绝不含后段标记
    for (const item of created.data.outboundPreview.items) {
      assert.equal(item.range.start, 0);
      assert.equal(item.range.end, 160);
      assert.equal(item.range.originalLength, 240);
      assert.equal(Array.from(item.text).length, 160);
      assert.equal(item.text.includes(TAIL_ALPHA), false);
      assert.equal(item.text.includes(TAIL_BETA), false);
    }

    const t1Post = await postTurnHttp(mainRuntime.origin, token, sessionId, {
      clientRequestId: 'ra2-turn-1-alpha',
      baseGraphVersion: 0,
      text: '远程办公跨时区异步协作必然降低团队交付效率。',
      cloudConsent: true,
    });
    assert.equal(t1Post.status, 202);
    const t1Events = await readSseStream(`${mainRuntime.origin}${t1Post.data.eventsUrl}`, { token });
    const t1Committed = t1Events.find((e) => e.event === 'turn.committed')?.data;
    assert.ok(t1Committed);
    assert.equal(mainModelPack.capturedCalls.length, 1);

    // 核对本轮预览与实际发给云模型的个人片段逐项一致（evidenceId、来源、range、实际文本）
    const previewA = t1Committed.outboundPreview;
    assert.ok(previewA.outboundPreviewId);
    assert.equal(previewA.items.length, 1);
    const itemA = previewA.items[0];
    assert.equal(itemA.evidenceId, 'ev_col_answer_ra2_alpha_240');
    assert.equal(itemA.source.sourceType, 'collection_record');
    assert.equal(itemA.source.snapshotId, 'snap_ra2_240');
    assert.equal(itemA.source.field, 'bodyText');
    assert.deepEqual(itemA.range, { start: 0, end: 160, originalLength: 240 });
    assert.equal(itemA.text, snippetA.first160);

    const prompt1 = extractPromptText(mainModelPack.capturedCalls[0]);
    assert.ok(prompt1.includes(`[${itemA.evidenceId}]`), '云模型请求必须包含匹配的 evidenceId');
    assert.ok(prompt1.includes(`snap_ra2_240`), '云模型请求必须包含匹配的来源 snapshotId');
    assert.ok(prompt1.includes(`字段=${itemA.source.field}`), '云模型请求必须包含匹配的来源字段');
    assert.ok(prompt1.includes(`范围=0..160/240`), '云模型请求必须包含匹配的裁剪范围 range');
    assert.ok(prompt1.includes(`片段="${itemA.text}"`), '云模型请求必须包含与预览逐字一致的 160 码点片段');
    assert.ok(prompt1.includes(HEAD_ALPHA), '前 160 字标记应进入云模型请求');
    assert.equal(prompt1.includes(TAIL_ALPHA), false, 'R-A2 致命红线：240 字片段的后段标记绝对不得进入云模型请求！');
    assert.equal(prompt1.includes(HEAD_BETA), false, '无关片段 B 不得进入本轮云模型请求');
    assert.equal(prompt1.includes(TAIL_BETA), false);

    // ② 改变涉及的个人片段（切换到命中片段 B 的轮次）：
    //    2a. 省略 outboundPreviewId -> 旧确认（仅确认了片段 A）不能放行，必须返回 403 和新预览
    const snapAfterT1 = (await getSessionHttp(mainRuntime.origin, token, sessionId)).data;
    const topicBText = '推荐算法只会让人的兴趣越来越窄，不可能发现新乐队。';
    const switchOmitRes = await postTurnHttp(mainRuntime.origin, token, sessionId, {
      clientRequestId: 'ra2-turn-2-beta-omit',
      baseGraphVersion: snapAfterT1.graphVersion,
      text: topicBText,
      cloudConsent: true,
    });
    assert.equal(switchOmitRes.status, 403, '切换不同个人片段时旧确认不能放行');
    assert.equal(switchOmitRes.error.code, 'CLOUD_CONSENT_REQUIRED');
    const previewB = switchOmitRes.error.details?.outboundPreview;
    assert.ok(previewB?.outboundPreviewId);
    assert.notEqual(previewB.outboundPreviewId, previewA.outboundPreviewId, '新片段必须生成新的 outboundPreviewId');
    assert.equal(previewB.items.length, 1);
    assert.equal(previewB.items[0].evidenceId, 'ev_col_answer_ra2_beta_240');
    assert.equal(previewB.items[0].text, snippetB.first160);
    assert.equal(previewB.items[0].text.includes(TAIL_BETA), false);
    assert.equal(mainModelPack.capturedCalls.length, 1, '旧确认被拒时不得调用云模型');

    //    2b. 显式传入旧确认的 outboundPreviewId（previewA.outboundPreviewId）-> 仍必须拒绝 403 并返回新预览
    const switchOldIdRes = await postTurnHttp(mainRuntime.origin, token, sessionId, {
      clientRequestId: 'ra2-turn-2-beta-stale-id',
      baseGraphVersion: snapAfterT1.graphVersion,
      text: topicBText,
      cloudConsent: true,
      outboundPreviewId: previewA.outboundPreviewId,
    });
    assert.equal(switchOldIdRes.status, 403, '传入旧的 outboundPreviewId 必须被拒');
    assert.equal(switchOldIdRes.error.code, 'CLOUD_CONSENT_REQUIRED');
    assert.equal(switchOldIdRes.error.details?.outboundPreview?.outboundPreviewId, previewB.outboundPreviewId);
    assert.equal(mainModelPack.capturedCalls.length, 1);

    //    2c. 确认新的 outboundPreviewId -> 放行并逐项核对片段 B
    const switchConfirmedRes = await postTurnHttp(mainRuntime.origin, token, sessionId, {
      clientRequestId: 'ra2-turn-2-beta-confirmed',
      baseGraphVersion: snapAfterT1.graphVersion,
      text: topicBText,
      cloudConsent: true,
      outboundPreviewId: previewB.outboundPreviewId,
    });
    assert.equal(switchConfirmedRes.status, 202);
    const t2Events = await readSseStream(`${mainRuntime.origin}${switchConfirmedRes.data.eventsUrl}`, { token });
    assert.ok(t2Events.some((e) => e.event === 'turn.committed'));
    assert.equal(mainModelPack.capturedCalls.length, 2);

    const prompt2 = extractPromptText(mainModelPack.capturedCalls[1]);
    assert.ok(prompt2.includes(`[ev_col_answer_ra2_beta_240]`));
    assert.ok(prompt2.includes(`片段="${snippetB.first160}"`));
    assert.ok(prompt2.includes(HEAD_BETA));
    assert.equal(prompt2.includes(TAIL_BETA), false, '片段 B 的后段标记同样绝不能进入云模型请求');
    assert.equal(prompt2.includes(HEAD_ALPHA), false);

    // ③ 覆盖一轮在发起云模型调用前（等待前置检索时）收到撤回请求，触发取消信号并阻止调用，确保云模型调用数为 0
    const inflightModelPack = createCapturingModel();
    const searchEntered = createDeferred();
    const releaseSearch = createDeferred();
    let capturedAbortDuringSearch = false;

    inflightRuntime = await startQuotationService(
      [
        '--allow-personal-data',
        '--host', '127.0.0.1',
        '--port', '0',
        '--db', inflightDbPath,
        '--base-url', 'https://api.cloud-ra2-inflight.example/v1',
        '--model', 'ra2-inflight-model',
      ],
      {
        env: { AGENT_SERVER_TOKEN: token, AGENT_OWNER_ID: 'owner_ra2_inflight' },
        stdout: noopOut,
        stderr: noopOut,
        connectServers: async () => ({
          tools: buildMockMcpTools({
            collectionRecords: [twoLongRecords[0]],
            snapshotId: 'snap_ra2_inflight',
            searchHandler: async () => {
              searchEntered.resolve();
              await releaseSearch.promise;
              return {
                schemaVersion: 1,
                ok: true,
                data: {
                  requestId: 'req_inflight_1',
                  page: { offset: 0, limit: 6, total: 0, returned: 0, hasMore: false, nextOffset: null },
                  items: [],
                },
                error: null,
              };
            },
          }),
          enabled: ['collection', 'search'],
          close: async () => {},
        }),
        createTurnOrchestrator: (opts) => {
          const baseOrch = createTurnOrchestrator({ ...opts, model: inflightModelPack.model });
          const origRunTurn = baseOrch.runTurn.bind(baseOrch);
          baseOrch.runTurn = async (ctx) => {
            if (ctx?.signal) {
              ctx.signal.addEventListener('abort', () => {
                capturedAbortDuringSearch = true;
              }, { once: true });
            }
            return origRunTurn(ctx);
          };
          baseOrch.executeTurn = baseOrch.runTurn;
          return baseOrch;
        },
      },
    );

    const { created: inflightSess } = await createConfirmedCloudSessionHttp(inflightRuntime.origin, token);
    assert.equal(inflightSess.status, 201);
    const inflightSessId = inflightSess.data.sessionId;

    // 启动轮次，进入前置检索后暂停在云模型调用前
    const inflightTurnPost = await postTurnHttp(inflightRuntime.origin, token, inflightSessId, {
      clientRequestId: 'ra2-inflight-turn-1',
      baseGraphVersion: 0,
      text: '远程办公跨时区异步协作必然降低交付效率。',
      cloudConsent: true,
    });
    assert.equal(inflightTurnPost.status, 202);

    await searchEntered.promise;
    assert.equal(inflightModelPack.capturedCalls.length, 0, '进入检索等待阶段时云模型尚未被调用');

    // 在发起模型调用前向同会话发送撤回请求
    const midflightRevoke = await postTurnHttp(inflightRuntime.origin, token, inflightSessId, {
      clientRequestId: 'ra2-inflight-revoke',
      baseGraphVersion: 0,
      text: '立即撤回云端授权。',
      cloudConsent: false,
    });
    assert.equal(midflightRevoke.status, 403);
    assert.equal(midflightRevoke.error.code, 'CLOUD_CONSENT_REQUIRED');
    assert.equal(capturedAbortDuringSearch, true, '撤回请求必须向运行中的云端个人材料轮次传递取消信号');

    // 放开检索阻塞，验证运行中的轮次被及时中止且绝不触发云模型调用
    releaseSearch.resolve();
    const inflightEvents = await readSseStream(
      `${inflightRuntime.origin}${inflightTurnPost.data.eventsUrl}`,
      { token },
    );
    assert.equal(inflightEvents.at(-1)?.event, 'turn.done');
    assert.equal(inflightEvents.some((e) => e.event === 'turn.committed'), false, '被撤回中断的轮次不得提交');
    assert.ok(
      inflightEvents.some((e) => e.event === 'turn.failed' || e.event === 'turn.cancelled'),
      '被撤回中断的轮次必须进入失败或取消终态',
    );
    assert.equal(inflightModelPack.capturedCalls.length, 0, '发起模型调用前撤回时，云模型调用数必须严格为 0');

    const inflightSnapAfter = (await getSessionHttp(inflightRuntime.origin, token, inflightSessId)).data;
    assert.equal(inflightSnapAfter.cloudConsent, false);
    assert.equal(inflightSnapAfter.activeTurnId, null);
  } finally {
    if (mainRuntime) await mainRuntime.close();
    if (inflightRuntime) await inflightRuntime.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// F-A1：首次云推理先预览后确认门禁（缺 ID、空清单 ID、快照/片段/目标变化均 403 且 0 会话 0 调用）
// ============================================================================
test('F-A1：首次请求返回实际非空未确认清单且模型调用为 0；只传同意、空清单 ID、快照/片段/端点变化及缺错 snapshotId 均 403 不建会话；匹配重试 201 且首轮仅发已确认片段', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'p0a-fa1-'));
  const mainDbPath = path.join(tmpDir, 'fa1-main.sqlite');
  const otherEndpointDbPath = path.join(tmpDir, 'fa1-other-endpoint.sqlite');
  const token = 'qtn_p0a_fa1_token_112233';
  const noopOut = { write() {} };

  const MARKER_V1 = 'FA1_REMOTE_SNIPPET_V1_INITIAL';
  const MARKER_V2 = 'FA1_REMOTE_SNIPPET_V2_SNAPSHOT_ROTATED';
  const MARKER_V3 = 'FA1_REMOTE_SNIPPET_V3_CONTENT_UPDATED';
  const MARKER_UNRELATED = 'FA1_UNRELATED_COOKING_SNIPPET_NEVER_SENT';

  let currentSnapshotId = 'snap_fa1_v1';
  let currentRecords = [
    {
      contentId: 'fa1_remote_1',
      contentType: 'answer',
      title: '远程办公跨时区协作复盘',
      summary: `${MARKER_V1}：书面异步接口契约降低了跨时区团队等待成本。`,
      summaryTruncated: false,
      bodyStatus: 'available',
      fullTextAvailable: true,
      bodyText: `${MARKER_V1}：书面异步接口契约降低了跨时区团队等待成本。`,
      author: '陈序',
      kinds: ['collections'],
      url: 'https://www.zhihu.com/question/7101/answer/1',
    },
    {
      contentId: 'fa1_unrelated_2',
      contentType: 'article',
      title: '周末面点发酵记录',
      summary: `${MARKER_UNRELATED}：低温冷藏发酵 12 小时的面团记录。`,
      summaryTruncated: false,
      bodyStatus: 'available',
      fullTextAvailable: true,
      bodyText: `${MARKER_UNRELATED}：低温冷藏发酵 12 小时的面团记录。`,
      author: '苏禾',
      kinds: ['history'],
      url: 'https://zhuanlan.zhihu.com/p/7102',
    },
  ];

  function createDynamicTools() {
    return {
      zhihu_knowledge_profile: {
        execute: async (args = {}) => {
          const offset = Number.isInteger(args.offset) ? args.offset : 0;
          const limit = Number.isInteger(args.limit) ? args.limit : 10;
          const bodyMaxChars = Number.isInteger(args.bodyMaxChars) ? args.bodyMaxChars : 0;
          const slice = currentRecords.slice(offset, offset + limit).map((rec) => {
            if (rec.bodyStatus === 'available' && typeof rec.bodyText === 'string' && bodyMaxChars > 0) {
              const clipped = rec.bodyText.slice(0, bodyMaxChars);
              return { ...rec, bodyText: clipped, bodyTruncated: clipped.length < rec.bodyText.length };
            }
            const copy = { ...rec };
            delete copy.bodyText;
            return copy;
          });
          const hasMore = offset + slice.length < currentRecords.length;
          return {
            schemaVersion: 1,
            ok: true,
            data: {
              snapshotId: currentSnapshotId,
              userId: '00000000-0000-4000-8000-000000000701',
              records: slice,
              page: {
                offset,
                limit,
                total: currentRecords.length,
                returned: slice.length,
                hasMore,
                nextOffset: hasMore ? offset + slice.length : null,
              },
            },
            error: null,
          };
        },
      },
      zhihu_search: {
        execute: async () => ({
          schemaVersion: 1,
          ok: true,
          data: {
            requestId: 'req_fa1_search',
            page: { offset: 0, limit: 6, total: 0, returned: 0, hasMore: false, nextOffset: null },
            items: [],
          },
          error: null,
        }),
      },
    };
  }

  const mainModelPack = createCapturingModel();
  const otherModelPack = createCapturingModel();
  let mainRuntime = null;
  let otherEndpointRuntime = null;

  try {
    mainRuntime = await startQuotationService(
      [
        '--allow-personal-data',
        '--host', '127.0.0.1',
        '--port', '0',
        '--db', mainDbPath,
        '--base-url', 'https://api.cloud-fa1.example/v1',
        '--model', 'fa1-cloud-model',
      ],
      {
        env: { AGENT_SERVER_TOKEN: token, AGENT_OWNER_ID: 'owner_fa1' },
        stdout: noopOut,
        stderr: noopOut,
        connectServers: async () => ({
          tools: createDynamicTools(),
          enabled: ['collection', 'search'],
          close: async () => {},
        }),
        createTurnOrchestrator: (opts) => createTurnOrchestrator({ ...opts, model: mainModelPack.model }),
      },
    );

    // 0. 首次请求（未传同意）：必须返回 403 + 实际非空未确认清单，0 会话，0 模型调用
    const firstPreviewRes = await createSessionHttp(mainRuntime.origin, token, {
      usePersonalMaterials: true,
    });
    assert.equal(firstPreviewRes.status, 403);
    assert.equal(firstPreviewRes.error.code, 'CLOUD_CONSENT_REQUIRED');
    const preview1 = firstPreviewRes.error.details?.outboundPreview;
    assert.ok(preview1);
    assert.equal(preview1.previewConfirmed, false);
    assert.equal(preview1.cloudConsentGranted, false);
    assert.equal(preview1.confirmedOutboundPreviewId, null);
    assert.equal(preview1.snapshotId, 'snap_fa1_v1');
    assert.equal(preview1.lockedSnapshotId, 'snap_fa1_v1');
    assert.equal(preview1.items.length, 2);
    assert.ok(preview1.items.some((item) => item.text.includes(MARKER_V1)));
    assert.equal(mainModelPack.capturedCalls.length, 0);
    assert.equal(countPersistedSessions(mainDbPath), 0);

    // ① 只传 cloudConsent: true（缺 outboundPreviewId 与 snapshotId）-> 403，不建会话，0 调用
    const onlyConsentRes = await createSessionHttp(mainRuntime.origin, token, {
      usePersonalMaterials: true,
      cloudConsent: true,
    });
    assert.equal(onlyConsentRes.status, 403);
    assert.equal(onlyConsentRes.error.code, 'CLOUD_CONSENT_REQUIRED');
    assert.equal(onlyConsentRes.error.details.outboundPreview.previewConfirmed, false);
    assert.equal(onlyConsentRes.error.details.outboundPreview.cloudConsentGranted, false);
    assert.equal(onlyConsentRes.error.details.outboundPreview.confirmedOutboundPreviewId, null);
    assert.equal(onlyConsentRes.error.details.outboundPreview.outboundPreviewId, preview1.outboundPreviewId);
    assert.equal(mainModelPack.capturedCalls.length, 0);
    assert.equal(countPersistedSessions(mainDbPath), 0);

    // ② 传空清单计算出的旧/空清单 ID -> 403，不建会话，0 调用
    const emptyManifestId = computeOutboundPreviewId({
      targetOrigin: preview1.targetOrigin,
      modelName: preview1.modelName,
      items: [],
    });
    const emptyIdRes = await createSessionHttp(mainRuntime.origin, token, {
      usePersonalMaterials: true,
      cloudConsent: true,
      outboundPreviewId: emptyManifestId,
      snapshotId: preview1.snapshotId,
    });
    assert.equal(emptyIdRes.status, 403);
    assert.equal(emptyIdRes.error.code, 'CLOUD_CONSENT_REQUIRED');
    assert.equal(emptyIdRes.error.details.outboundPreview.previewConfirmed, false);
    assert.equal(emptyIdRes.error.details.outboundPreview.outboundPreviewId, preview1.outboundPreviewId);
    assert.notEqual(emptyIdRes.error.details.outboundPreview.outboundPreviewId, emptyManifestId);
    assert.equal(mainModelPack.capturedCalls.length, 0);
    assert.equal(countPersistedSessions(mainDbPath), 0);

    // ④a 缺 snapshotId 或错 snapshotId（即使 outboundPreviewId 与当前清单一致）-> 403，不建会话，0 调用
    const missingSnapshotRes = await createSessionHttp(mainRuntime.origin, token, {
      usePersonalMaterials: true,
      cloudConsent: true,
      outboundPreviewId: preview1.outboundPreviewId,
    });
    assert.equal(missingSnapshotRes.status, 403);
    assert.equal(missingSnapshotRes.error.code, 'CLOUD_CONSENT_REQUIRED');
    assert.equal(missingSnapshotRes.error.details.outboundPreview.previewConfirmed, false);
    assert.equal(missingSnapshotRes.error.details.outboundPreview.snapshotId, 'snap_fa1_v1');

    const wrongSnapshotRes = await createSessionHttp(mainRuntime.origin, token, {
      usePersonalMaterials: true,
      cloudConsent: true,
      outboundPreviewId: preview1.outboundPreviewId,
      snapshotId: 'snap_fa1_wrong_id',
    });
    assert.equal(wrongSnapshotRes.status, 403);
    assert.equal(wrongSnapshotRes.error.code, 'CLOUD_CONSENT_REQUIRED');
    assert.equal(wrongSnapshotRes.error.details.outboundPreview.previewConfirmed, false);
    assert.equal(wrongSnapshotRes.error.details.outboundPreview.snapshotId, 'snap_fa1_v1');
    assert.equal(mainModelPack.capturedCalls.length, 0);
    assert.equal(countPersistedSessions(mainDbPath), 0);

    // ③ 快照旋转与片段内容变化后，复用旧 outboundPreviewId -> 403 并返回最新可确认清单，0 会话 0 调用
    currentSnapshotId = 'snap_fa1_v2';
    currentRecords = [
      {
        ...currentRecords[0],
        summary: `${MARKER_V2}：旋转快照后的书面异步评审规范。`,
        bodyText: `${MARKER_V2}：旋转快照后的书面异步评审规范。`,
      },
      currentRecords[1],
    ];
    const staleAfterSnapRotate = await createSessionHttp(mainRuntime.origin, token, {
      usePersonalMaterials: true,
      cloudConsent: true,
      outboundPreviewId: preview1.outboundPreviewId,
      snapshotId: preview1.snapshotId,
    });
    assert.equal(staleAfterSnapRotate.status, 403);
    assert.equal(staleAfterSnapRotate.error.code, 'CLOUD_CONSENT_REQUIRED');
    const preview2 = staleAfterSnapRotate.error.details.outboundPreview;
    assert.equal(preview2.previewConfirmed, false);
    assert.equal(preview2.snapshotId, 'snap_fa1_v2');
    assert.notEqual(preview2.outboundPreviewId, preview1.outboundPreviewId);
    assert.ok(preview2.items.some((item) => item.text.includes(MARKER_V2)));
    assert.equal(mainModelPack.capturedCalls.length, 0);
    assert.equal(countPersistedSessions(mainDbPath), 0);

    // 同 snapshotId 下片段文本变化后，旧 outboundPreviewId 同样被拒
    currentRecords = [
      {
        ...currentRecords[0],
        summary: `${MARKER_V3}：同快照下更新后的跨时区异步文档协作说明。`,
        bodyText: `${MARKER_V3}：同快照下更新后的跨时区异步文档协作说明。`,
      },
      currentRecords[1],
    ];
    const staleAfterSnippetEdit = await createSessionHttp(mainRuntime.origin, token, {
      usePersonalMaterials: true,
      cloudConsent: true,
      outboundPreviewId: preview2.outboundPreviewId,
      snapshotId: preview2.snapshotId,
    });
    assert.equal(staleAfterSnippetEdit.status, 403);
    assert.equal(staleAfterSnippetEdit.error.code, 'CLOUD_CONSENT_REQUIRED');
    const preview3 = staleAfterSnippetEdit.error.details.outboundPreview;
    assert.equal(preview3.previewConfirmed, false);
    assert.equal(preview3.snapshotId, 'snap_fa1_v2');
    assert.notEqual(preview3.outboundPreviewId, preview2.outboundPreviewId);
    assert.ok(preview3.items.some((item) => item.text.includes(MARKER_V3)));
    assert.equal(mainModelPack.capturedCalls.length, 0);
    assert.equal(countPersistedSessions(mainDbPath), 0);

    // ④b 目标模型端点变化时，沿用旧端点的 outboundPreviewId -> 403，不建会话，0 调用
    otherEndpointRuntime = await startQuotationService(
      [
        '--allow-personal-data',
        '--host', '127.0.0.1',
        '--port', '0',
        '--db', otherEndpointDbPath,
        '--base-url', 'https://api.cloud-fa1-other.example/v1',
        '--model', 'fa1-cloud-model',
      ],
      {
        env: { AGENT_SERVER_TOKEN: token, AGENT_OWNER_ID: 'owner_fa1' },
        stdout: noopOut,
        stderr: noopOut,
        connectServers: async () => ({
          tools: createDynamicTools(),
          enabled: ['collection', 'search'],
          close: async () => {},
        }),
        createTurnOrchestrator: (opts) => createTurnOrchestrator({ ...opts, model: otherModelPack.model }),
      },
    );
    const endpointChangedRes = await createSessionHttp(otherEndpointRuntime.origin, token, {
      usePersonalMaterials: true,
      cloudConsent: true,
      outboundPreviewId: preview3.outboundPreviewId,
      snapshotId: preview3.snapshotId,
    });
    assert.equal(endpointChangedRes.status, 403);
    assert.equal(endpointChangedRes.error.code, 'CLOUD_CONSENT_REQUIRED');
    assert.equal(endpointChangedRes.error.details.outboundPreview.targetOrigin, 'https://api.cloud-fa1-other.example');
    assert.notEqual(endpointChangedRes.error.details.outboundPreview.outboundPreviewId, preview3.outboundPreviewId);
    assert.equal(endpointChangedRes.error.details.outboundPreview.previewConfirmed, false);
    assert.equal(otherModelPack.capturedCalls.length, 0);
    assert.equal(countPersistedSessions(otherEndpointDbPath), 0);

    // 最终用当前匹配的 { usePersonalMaterials: true, cloudConsent: true, outboundPreviewId, snapshotId } 重试 -> 201
    const confirmedCreate = await createSessionHttp(mainRuntime.origin, token, {
      usePersonalMaterials: true,
      cloudConsent: true,
      outboundPreviewId: preview3.outboundPreviewId,
      snapshotId: preview3.snapshotId,
    });
    assert.equal(confirmedCreate.status, 201);
    assert.equal(confirmedCreate.data.lockedSnapshotId, 'snap_fa1_v2');
    assert.equal(confirmedCreate.data.outboundPreview.outboundPreviewId, preview3.outboundPreviewId);
    assert.equal(confirmedCreate.data.outboundPreview.confirmedOutboundPreviewId, preview3.outboundPreviewId);
    assert.equal(confirmedCreate.data.outboundPreview.previewConfirmed, true);
    assert.equal(confirmedCreate.data.outboundPreview.cloudConsentGranted, true);
    assert.equal(countPersistedSessions(mainDbPath), 1);

    // 首轮模型请求仅包含该已确认清单中的个人片段
    const turn1 = await postTurnHttp(mainRuntime.origin, token, confirmedCreate.data.sessionId, {
      clientRequestId: 'fa1-turn-1',
      baseGraphVersion: 0,
      text: '远程办公跨时区异步文档协作必然降低研发交付效率。',
    });
    assert.equal(turn1.status, 202);
    const turn1Events = await readSseStream(`${mainRuntime.origin}${turn1.data.eventsUrl}`, { token });
    assert.ok(turn1Events.some((e) => e.event === 'turn.committed'));
    assert.equal(mainModelPack.capturedCalls.length, 1);

    const sentPrompt = extractPromptText(mainModelPack.capturedCalls[0]);
    assert.ok(sentPrompt.includes(MARKER_V3), '首轮模型请求应包含已确认清单中的最新 V3 片段');
    assert.equal(sentPrompt.includes(MARKER_V1), false, '旧 V1 片段绝不能进入模型请求');
    assert.equal(sentPrompt.includes(MARKER_V2), false, '旧 V2 片段绝不能进入模型请求');
    assert.equal(sentPrompt.includes(MARKER_UNRELATED), false, '无关片段绝不能进入模型请求');
  } finally {
    if (mainRuntime) await mainRuntime.close();
    if (otherEndpointRuntime) await otherEndpointRuntime.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// F-A2：240 字两步确认逐项核对（无末段泄露）、撤回与重启拒绝、回环与关闭个人材料正常直通
// ============================================================================
test('F-A2：240 字合成材料两步确认后逐项比对模型输入且末段标记绝不出现；撤回与重启保持 403 且 0 新增调用；回环与关闭个人材料直接 201 成功', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'p0a-fa2-'));
  const cloudDbPath = path.join(tmpDir, 'fa2-cloud.sqlite');
  const localDbPath = path.join(tmpDir, 'fa2-local.sqlite');
  const token = 'qtn_p0a_fa2_token_445566';
  const noopOut = { write() {} };

  const HEAD_MARKER = 'FA2_HEAD_160_VISIBLE_OK';
  const TAIL_MARKER = 'FA2_TAIL_240_CLIPPED_FORBIDDEN';
  const longSnippet = makeExactLengthSnippet({
    prefix: '远程办公跨时区异步文档交付实测：',
    headMarker: HEAD_MARKER,
    tailMarker: TAIL_MARKER,
    totalChars: 240,
  });

  const records = [
    {
      contentId: 'fa2_doc_240',
      contentType: 'answer',
      title: '跨时区异步文档协作 240 字样本',
      summary: longSnippet.full,
      summaryTruncated: false,
      bodyStatus: 'available',
      fullTextAvailable: true,
      bodyText: longSnippet.full,
      author: '陈序',
      kinds: ['collections'],
      url: 'https://www.zhihu.com/question/7201/answer/1',
    },
  ];

  let cloudCollectionCalls = 0;
  const cloudModelPack = createCapturingModel();
  const bootCloud = () =>
    startQuotationService(
      [
        '--allow-personal-data',
        '--host', '127.0.0.1',
        '--port', '0',
        '--db', cloudDbPath,
        '--base-url', 'https://api.cloud-fa2.example/v1',
        '--model', 'fa2-cloud-model',
      ],
      {
        env: { AGENT_SERVER_TOKEN: token, AGENT_OWNER_ID: 'owner_fa2' },
        stdout: noopOut,
        stderr: noopOut,
        connectServers: async () => {
          const baseTools = buildMockMcpTools({ collectionRecords: records, snapshotId: 'snap_fa2_240' });
          const origExec = baseTools.zhihu_knowledge_profile.execute;
          baseTools.zhihu_knowledge_profile.execute = async (args) => {
            cloudCollectionCalls += 1;
            return origExec(args);
          };
          return { tools: baseTools, enabled: ['collection', 'search'], close: async () => {} };
        },
        createTurnOrchestrator: (opts) => createTurnOrchestrator({ ...opts, model: cloudModelPack.model }),
      },
    );

  const localModelPack = createCapturingModel();
  const bootLoopback = () =>
    startQuotationService(
      [
        '--allow-personal-data',
        '--host', '127.0.0.1',
        '--port', '0',
        '--db', localDbPath,
        '--base-url', 'http://127.0.0.1:11434/v1',
        '--model', 'fa2-local-model',
      ],
      {
        env: { AGENT_SERVER_TOKEN: token, AGENT_OWNER_ID: 'owner_fa2' },
        stdout: noopOut,
        stderr: noopOut,
        connectServers: async () => ({
          tools: buildMockMcpTools({ collectionRecords: records, snapshotId: 'snap_fa2_local' }),
          enabled: ['collection', 'search'],
          close: async () => {},
        }),
        createTurnOrchestrator: (opts) => createTurnOrchestrator({ ...opts, model: localModelPack.model }),
      },
    );

  let cloudRuntime = null;
  let localRuntime = null;

  try {
    cloudRuntime = await bootCloud();

    // 1. 第一步预览：返回裁剪后的前 160 字，不含 161..240 末段标记，云调用为 0
    const previewRes = await createSessionHttp(cloudRuntime.origin, token, {
      usePersonalMaterials: true,
    });
    assert.equal(previewRes.status, 403);
    assert.equal(previewRes.error.code, 'CLOUD_CONSENT_REQUIRED');
    const preview = previewRes.error.details?.outboundPreview;
    assert.equal(preview.previewConfirmed, false);
    assert.equal(preview.snapshotId, 'snap_fa2_240');
    assert.equal(preview.items.length, 1);
    const previewItem = preview.items[0];
    assert.equal(previewItem.evidenceId, 'ev_col_answer_fa2_doc_240');
    assert.equal(previewItem.source.sourceType, 'collection_record');
    assert.equal(previewItem.source.snapshotId, 'snap_fa2_240');
    assert.equal(previewItem.source.field, 'bodyText');
    assert.deepEqual(previewItem.range, { start: 0, end: 160, originalLength: 240 });
    assert.equal(previewItem.text, longSnippet.first160);
    assert.equal(previewItem.text.includes(HEAD_MARKER), true);
    assert.equal(previewItem.text.includes(TAIL_MARKER), false);
    assert.equal(cloudModelPack.capturedCalls.length, 0);

    // 2. 第二步显式确认 -> 201，并提交第 1 轮抓取实际云模型输入逐项比对
    const created = await createSessionHttp(cloudRuntime.origin, token, {
      usePersonalMaterials: true,
      cloudConsent: true,
      outboundPreviewId: preview.outboundPreviewId,
      snapshotId: preview.snapshotId,
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.outboundPreview.outboundPreviewId, preview.outboundPreviewId);
    assert.equal(created.data.outboundPreview.previewConfirmed, true);

    const sessionId = created.data.sessionId;
    const t1 = await postTurnHttp(cloudRuntime.origin, token, sessionId, {
      clientRequestId: 'fa2-turn-1',
      baseGraphVersion: 0,
      text: '远程办公跨时区异步文档协作必然降低团队交付效率。',
    });
    assert.equal(t1.status, 202);
    const t1Events = await readSseStream(`${cloudRuntime.origin}${t1.data.eventsUrl}`, { token });
    assert.ok(t1Events.some((e) => e.event === 'turn.committed'));
    assert.equal(cloudModelPack.capturedCalls.length, 1);

    const prompt1 = extractPromptText(cloudModelPack.capturedCalls[0]);
    assert.ok(prompt1.includes(`[${previewItem.evidenceId}]`), '云模型输入必须包含匹配的 evidenceId');
    assert.ok(prompt1.includes('snap_fa2_240'), '云模型输入必须包含匹配的来源 snapshotId');
    assert.ok(prompt1.includes(`字段=${previewItem.source.field}`), '云模型输入必须包含匹配的来源字段');
    assert.ok(prompt1.includes('范围=0..160/240'), '云模型输入必须包含匹配的裁剪范围 range');
    assert.ok(prompt1.includes(`片段="${longSnippet.first160}"`), '云模型输入必须包含与预览逐字一致的前 160 码点文本');
    assert.equal(prompt1.includes(HEAD_MARKER), true);
    assert.equal(prompt1.includes(TAIL_MARKER), false, 'F-A2 红线：裁掉的 161..240 末段标记绝不能出现在实际云模型输入中');

    // 3. 撤回同意 -> 提交省略 cloudConsent 的轮次 -> 重启服务再提交省略 cloudConsent 的轮次：均 403 且无新增云调用
    const snapBeforeRevoke = (await getSessionHttp(cloudRuntime.origin, token, sessionId)).data;
    const revokeRes = await postTurnHttp(cloudRuntime.origin, token, sessionId, {
      clientRequestId: 'fa2-turn-2-revoke',
      baseGraphVersion: snapBeforeRevoke.graphVersion,
      text: '撤回云端同意。',
      cloudConsent: false,
    });
    assert.equal(revokeRes.status, 403);
    assert.equal(revokeRes.error.code, 'CLOUD_CONSENT_REQUIRED');
    assert.equal(cloudModelPack.capturedCalls.length, 1);

    const omitAfterRevoke = await postTurnHttp(cloudRuntime.origin, token, sessionId, {
      clientRequestId: 'fa2-turn-3-omit',
      baseGraphVersion: snapBeforeRevoke.graphVersion,
      text: '远程办公跨时区异步文档协作必然失败。',
    });
    assert.equal(omitAfterRevoke.status, 403);
    assert.equal(omitAfterRevoke.error.code, 'CLOUD_CONSENT_REQUIRED');
    assert.equal(cloudModelPack.capturedCalls.length, 1);

    await cloudRuntime.close();
    cloudRuntime = await bootCloud();

    const omitAfterRestart = await postTurnHttp(cloudRuntime.origin, token, sessionId, {
      clientRequestId: 'fa2-turn-4-restart-omit',
      baseGraphVersion: snapBeforeRevoke.graphVersion,
      text: '重启后再次提交省略同意字段的轮次。',
    });
    assert.equal(omitAfterRestart.status, 403);
    assert.equal(omitAfterRestart.error.code, 'CLOUD_CONSENT_REQUIRED');
    assert.equal(cloudModelPack.capturedCalls.length, 1, '撤回及重启后不得产生任何新增云模型调用');

    // 4. 关闭个人材料（usePersonalMaterials: false）在云模型下直接 201 成功且零采集、零个人材料外发
    const collectionBeforeDisabled = cloudCollectionCalls;
    const disabledCreated = await createSessionHttp(cloudRuntime.origin, token, {
      usePersonalMaterials: false,
    });
    assert.equal(disabledCreated.status, 201);
    assert.equal(disabledCreated.data.usePersonalMaterials, false);
    assert.equal(disabledCreated.data.lockedSnapshotId, null);
    assert.equal(disabledCreated.data.materialsStatus.state, 'disabled_by_user');
    assert.equal(cloudCollectionCalls, collectionBeforeDisabled, 'usePersonalMaterials: false 不得调用采集入口');

    const disabledTurn = await postTurnHttp(cloudRuntime.origin, token, disabledCreated.data.sessionId, {
      clientRequestId: 'fa2-disabled-turn-1',
      baseGraphVersion: 0,
      text: '远程办公跨时区异步文档协作必然降低交付效率。',
    });
    assert.equal(disabledTurn.status, 202);
    const disabledEvents = await readSseStream(`${cloudRuntime.origin}${disabledTurn.data.eventsUrl}`, { token });
    assert.ok(disabledEvents.some((e) => e.event === 'turn.committed'));
    assert.equal(cloudCollectionCalls, collectionBeforeDisabled);
    assert.equal(cloudModelPack.capturedCalls.length, 2);
    const disabledPrompt = extractPromptText(cloudModelPack.capturedCalls[1]);
    assert.equal(disabledPrompt.includes(HEAD_MARKER), false, '关闭个人材料时不得外发个人材料前段');
    assert.equal(disabledPrompt.includes(TAIL_MARKER), false, '关闭个人材料时不得外发个人材料末段');

    // 5. 回环模型（127.0.0.1）启用个人材料时免两步云确认直接 201 成功并正常提交轮次
    localRuntime = await bootLoopback();
    const localCreated = await createSessionHttp(localRuntime.origin, token, {
      usePersonalMaterials: true,
    });
    assert.equal(localCreated.status, 201);
    assert.equal(localCreated.data.lockedSnapshotId, 'snap_fa2_local');
    assert.equal(localCreated.data.outboundPreview.isLocalModel, true);

    const localTurn = await postTurnHttp(localRuntime.origin, token, localCreated.data.sessionId, {
      clientRequestId: 'fa2-local-turn-1',
      baseGraphVersion: 0,
      text: '远程办公跨时区异步文档协作必然降低交付效率。',
    });
    assert.equal(localTurn.status, 202);
    const localEvents = await readSseStream(`${localRuntime.origin}${localTurn.data.eventsUrl}`, { token });
    assert.ok(localEvents.some((e) => e.event === 'turn.committed'));
    assert.equal(localModelPack.capturedCalls.length, 1);
  } finally {
    if (cloudRuntime) await cloudRuntime.close();
    if (localRuntime) await localRuntime.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
