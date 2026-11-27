// QA-01 至 QA-08、QA-10、QA-11 端到端 HTTP + SSE + 磁盘 SQLite + 进程重启回归测试套件。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { startQuotationService } from '../serve-cli.mjs';
import { createTurnOrchestrator } from '../turn-orchestrator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUOTE_SCHEMA = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../quotation-engine/schemas/quote-v1.schema.json'), 'utf8'),
);

const USAGE = {
  inputTokens: { total: 42, noCache: 42, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

function createCapturingModel(chunkFactory = null) {
  const capturedCalls = [];
  let callIndex = 0;
  const model = new MockLanguageModelV4({
    doStream: async (params) => {
      callIndex += 1;
      capturedCalls.push(params);
      const chunks = typeof chunkFactory === 'function'
        ? await chunkFactory({ callIndex, params })
        : ['已根据本轮服务端核验过的依据完成评估说明。'];
      const parts = [{ type: 'text-start', id: `txt_${callIndex}` }];
      for (const delta of chunks) {
        parts.push({ type: 'text-delta', id: `txt_${callIndex}`, delta });
      }
      parts.push(
        { type: 'text-end', id: `txt_${callIndex}` },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
      );
      return {
        stream: convertArrayToReadableStream(parts),
      };
    },
  });
  return { model, capturedCalls };
}

function serializePromptCall(call) {
  return JSON.stringify(call?.prompt ?? call ?? '');
}

async function readSseStream(url, { token, lastEventId = null, onEvent = null } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (lastEventId !== null) headers['Last-Event-ID'] = String(lastEventId);
  const res = await fetch(url, { headers });
  if (res.status !== 200) {
    assert.fail(`SSE GET failed (${res.status}): ${await res.text()}`);
  }
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
      const parsed = {
        id,
        event,
        data: dataLines.length ? JSON.parse(dataLines.join('\n')) : null,
      };
      events.push(parsed);
      if (typeof onEvent === 'function') {
        await onEvent(parsed);
      }
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

async function getSessionHttp(origin, token, sessionId, query = '') {
  const suffix = query ? `?${query}` : '';
  const res = await fetch(`${origin}/v1/sessions/${sessionId}${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  return { status: res.status, body: json, data: json.data, error: json.error };
}

async function submitTurnHttp(origin, token, sessionId, payload, { expectCommitted = true } = {}) {
  const postRes = await fetch(`${origin}/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const postBody = await postRes.json();
  if (postRes.status !== 202 && postRes.status !== 200) {
    return {
      acceptedStatus: postRes.status,
      postBody,
      error: postBody.error,
      events: [],
      committed: null,
      failed: null,
      session: (await getSessionHttp(origin, token, sessionId)).data,
    };
  }

  const { turnId, eventsUrl } = postBody.data;
  const events = await readSseStream(`${origin}${eventsUrl}`, { token });
  assert.equal(events.at(-1)?.event, 'turn.done');

  const committed = events.find((e) => e.event === 'turn.committed')?.data ?? null;
  const failed = events.find((e) => e.event === 'turn.failed')?.data ?? null;
  if (expectCommitted) {
    assert.ok(committed, `Expected turn.committed, got events: ${events.map((e) => e.event).join(' -> ')} (${JSON.stringify(failed)})`);
  }

  const sessionSnap = await getSessionHttp(origin, token, sessionId);
  assert.equal(sessionSnap.status, 200);
  return {
    acceptedStatus: postRes.status,
    turnId,
    eventsUrl,
    events,
    committed,
    failed,
    session: sessionSnap.data,
  };
}

function assertValidQuoteV1(quote) {
  assert.ok(quote && typeof quote === 'object' && !Array.isArray(quote));
  const allowedProps = new Set(Object.keys(QUOTE_SCHEMA.properties));
  const requiredProps = QUOTE_SCHEMA.required;
  const actualKeys = Object.keys(quote);

  for (const reqKey of requiredProps) {
    assert.ok(actualKeys.includes(reqKey), `quote 缺少必需字段 ${reqKey}`);
  }
  for (const key of actualKeys) {
    assert.ok(allowedProps.has(key), `quote 含未定义额外字段 ${key}，违反 additionalProperties:false`);
  }
  assert.ok(['conflict', 'compatible', 'insufficient_evidence'].includes(quote.assessment));
  assert.equal(quote.interpretationNote, QUOTE_SCHEMA.properties.interpretationNote.const);
  if (quote.assessment !== 'conflict') {
    assert.equal(quote.directConflicts.length, 0);
    assert.equal(quote.collateral.length, 0);
    assert.equal(quote.affected.length, 0);
    assert.equal(quote.numerator, 0);
    assert.equal(quote.conflictReasons.length, 0);
  }
  if (quote.assessment === 'insufficient_evidence' || quote.denominator === 0) {
    assert.equal(quote.rate, null);
  }
  for (const r of quote.conflictReasons) {
    if (typeof r === 'string') {
      assert.ok(r.trim().length > 0);
    } else {
      assert.equal(typeof r.nodeId, 'string');
      assert.ok(r.nodeId.trim().length > 0);
      assert.equal(typeof r.reason, 'string');
      assert.ok(r.reason.trim().length > 0);
      if (r.evidenceIds !== undefined) {
        assert.ok(Array.isArray(r.evidenceIds));
        assert.ok(r.evidenceIds.every((id) => typeof id === 'string' && id.trim().length > 0));
      }
    }
  }
}

function buildCustomMcpTools({
  collectionRecords = [],
  snapshotId = 'snap_qa_custom_001',
  searchItems = [],
  collectionCalls = [],
  searchCalls = [],
} = {}) {
  return {
    zhihu_knowledge_profile: {
      execute: async (args = {}) => {
        collectionCalls.push({ ...args });
        const targetSnap = args.snapshotId ?? snapshotId;
        if (targetSnap !== snapshotId) {
          return {
            schemaVersion: 1,
            ok: false,
            data: null,
            error: { code: 'NOT_FOUND', message: `未知快照 ${targetSnap}` },
          };
        }
        const offset = Number.isInteger(args.offset) ? args.offset : 0;
        const limit = Number.isInteger(args.limit) ? args.limit : 10;
        const bodyMaxChars = Number.isInteger(args.bodyMaxChars) ? args.bodyMaxChars : 0;
        const pageSlice = collectionRecords.slice(offset, offset + limit).map((rec) => {
          const canReturnBody = rec.bodyStatus === 'available' && typeof rec.bodyText === 'string' && bodyMaxChars > 0;
          if (!canReturnBody) {
            const copy = { ...rec };
            delete copy.bodyText;
            return copy;
          }
          const clipped = rec.bodyText.slice(0, bodyMaxChars);
          return {
            ...rec,
            bodyText: clipped,
            bodyTruncated: clipped.length < rec.bodyText.length || Boolean(rec.bodyTruncated),
          };
        });
        const hasMore = offset + pageSlice.length < collectionRecords.length;
        return {
          schemaVersion: 1,
          ok: true,
          data: {
            snapshotId,
            userId: '00000000-0000-4000-8000-000000000999',
            records: pageSlice,
            page: {
              offset,
              limit,
              total: collectionRecords.length,
              returned: pageSlice.length,
              hasMore,
              nextOffset: hasMore ? offset + pageSlice.length : null,
            },
          },
          error: null,
        };
      },
    },
    zhihu_search: {
      execute: async (args = {}) => {
        searchCalls.push({ ...args });
        return {
          schemaVersion: 1,
          ok: true,
          data: {
            requestId: `req_search_${searchCalls.length}`,
            page: { offset: 0, limit: 8, total: searchItems.length, returned: searchItems.length, hasMore: false, nextOffset: null },
            items: searchItems,
          },
          error: null,
        };
      },
    },
  };
}

// ============================================================================
// QA-01 & QA-11
// ============================================================================
test('QA-01 & QA-11：关闭个人材料时首轮、后续轮及重启后采集调用严格为 0；启用时跨页锁定首个 snapshotId 且读取授权正文片段', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'qa01-qa11-http-'));
  const dbPath = path.join(tmpDir, 'qa01.sqlite');
  const token = 'qtn_qa01_secret_token_123456';
  const noopOut = { write() {} };

  const SECRET_PERSONAL_MARKER = 'SYNTHETIC_PERSONAL_MARKER_QA01_独家收藏线索';
  const BODY_ONLY_PHRASE = 'BODY_EXCLUSIVE_SNIPPET_QA11_仅正文中出现的架构复盘细节';
  const UNRELATED_PERSONAL_PHRASE = 'UNRELATED_GARDENING_RECORD_QA11_园艺施肥笔记';

  const twelveSyntheticRecords = Array.from({ length: 12 }, (_, idx) => {
    if (idx === 0) {
      return {
        contentId: 'qa11_full_1',
        contentType: 'answer',
        title: '远程办公团队的异步评审实践',
        summary: `简要摘要：${SECRET_PERSONAL_MARKER}，讨论跨时区协作。`,
        summaryTruncated: false,
        bodyStatus: 'available',
        fullTextAvailable: true,
        bodyText: `简要摘要：${SECRET_PERSONAL_MARKER}，讨论跨时区协作。正文扩展段落：${BODY_ONLY_PHRASE}。`,
        author: '陈序',
        kinds: ['collections'],
        url: 'https://www.zhihu.com/question/100/answer/1',
      };
    }
    if (idx === 1) {
      return {
        contentId: 'qa11_sum_only_2',
        contentType: 'article',
        title: '远程办公沟通延迟观察',
        summary: '仅有摘要且已截断的远程办公观察记录……',
        summaryTruncated: true,
        bodyStatus: 'unavailable',
        fullTextAvailable: false,
        author: '裴知远',
        kinds: ['history'],
        url: 'https://zhuanlan.zhihu.com/p/2',
      };
    }
    return {
      contentId: `qa11_other_${idx + 1}`,
      contentType: 'pin',
      title: `无关领域笔记 ${idx + 1}`,
      summary: `${UNRELATED_PERSONAL_PHRASE}_${idx + 1}`,
      summaryTruncated: false,
      bodyStatus: 'unavailable',
      fullTextAvailable: false,
      author: `作者_${idx + 1}`,
      kinds: ['history'],
      url: `https://www.zhihu.com/pin/${idx + 1}`,
    };
  });

  const collectionCalls = [];
  const searchCalls = [];
  const { model, capturedCalls } = createCapturingModel();

  const boot = () => {
    const tools = buildCustomMcpTools({
      collectionRecords: twelveSyntheticRecords,
      snapshotId: 'snap_locked_qa01_first',
      searchItems: [],
      collectionCalls,
      searchCalls,
    });
    return startQuotationService(
      ['--allow-personal-data', '--host', '127.0.0.1', '--port', '0', '--db', dbPath, '--base-url', 'https://api.cloud-test.example/v1', '--model', 'mock-cloud'],
      {
        env: { AGENT_SERVER_TOKEN: token, AGENT_OWNER_ID: 'owner_qa01' },
        stdout: noopOut,
        stderr: noopOut,
        connectServers: async () => ({ tools, enabled: ['collection', 'search'], close: async () => {} }),
        createTurnOrchestrator: (opts) => createTurnOrchestrator({ ...opts, model }),
      },
    );
  };

  let runtime = null;
  try {
    runtime = await boot();

    // 1) 创建明确关闭个人材料的会话（即使允许云推理 cloudConsent: true）
    const disabledCreated = await createSessionHttp(runtime.origin, token, {
      usePersonalMaterials: false,
      cloudConsent: true,
    });
    assert.equal(disabledCreated.status, 201);
    assert.equal(disabledCreated.data.materialsStatus.state, 'disabled_by_user');
    assert.equal(disabledCreated.data.lockedSnapshotId, null);
    assert.equal(collectionCalls.length, 0, '创建关闭材料的会话不得调用采集');

    const disabledSessionId = disabledCreated.data.sessionId;

    // 第 1 轮：输入与合成片段高度相关的远程办公句子
    const dTurn1 = await submitTurnHttp(runtime.origin, token, disabledSessionId, {
      clientRequestId: 'qa01-dis-t1',
      baseGraphVersion: 0,
      text: '远程办公团队的异步评审必然降低跨时区协作效率。',
      cloudConsent: true,
    });
    assert.equal(collectionCalls.length, 0, 'QA-01：关闭个人材料后首轮绝不能补读采集记录');
    assert.equal(dTurn1.session.lockedSnapshotId, null);
    assert.ok(!serializePromptCall(capturedCalls.at(-1)).includes(SECRET_PERSONAL_MARKER));
    assert.ok(!JSON.stringify(dTurn1.events).includes(SECRET_PERSONAL_MARKER));
    assert.ok(!JSON.stringify(dTurn1.session.evidenceIndex).includes(SECRET_PERSONAL_MARKER));

    // 重启服务后继续提交第 2 轮，验证持久化材料开关仍然生效
    await runtime.close();
    runtime = await boot();

    const dTurn2 = await submitTurnHttp(runtime.origin, token, disabledSessionId, {
      clientRequestId: 'qa01-dis-t2',
      baseGraphVersion: dTurn1.session.graphVersion,
      text: '为什么先拆“必然”？',
      cloudConsent: true,
    });
    assert.equal(collectionCalls.length, 0, 'QA-01：重启恢复后的后续轮次仍必须保持零采集调用');
    assert.ok(!serializePromptCall(capturedCalls.at(-1)).includes(SECRET_PERSONAL_MARKER));
    assert.equal(dTurn2.session.evidenceIndex.some((e) => e.sourceType === 'collection_record'), false);

    // 2) 对照会话：明确开启个人材料并走两步先预览后确认获准云推理（验证跨页锁定首个 snapshotId + QA-11 读取正文片段）
    const enabledPreviewRes = await createSessionHttp(runtime.origin, token, {
      usePersonalMaterials: true,
    });
    assert.equal(enabledPreviewRes.status, 403);
    assert.equal(enabledPreviewRes.error.code, 'CLOUD_CONSENT_REQUIRED');
    const enabledPreview = enabledPreviewRes.error.details?.outboundPreview;
    assert.ok(enabledPreview?.outboundPreviewId);
    assert.equal(enabledPreview.previewConfirmed, false);
    assert.equal(enabledPreview.snapshotId, 'snap_locked_qa01_first');

    const enabledCreated = await createSessionHttp(runtime.origin, token, {
      usePersonalMaterials: true,
      cloudConsent: true,
      outboundPreviewId: enabledPreview.outboundPreviewId,
      snapshotId: enabledPreview.snapshotId,
    });
    assert.equal(enabledCreated.status, 201);
    assert.equal(enabledCreated.data.lockedSnapshotId, 'snap_locked_qa01_first');
    assert.ok(collectionCalls.length >= 2, '12 条记录默认分页应至少读取 2 页');
    // 从第 2 页起必须始终携带首个锁定的 snapshotId
    for (let i = 1; i < collectionCalls.length; i += 1) {
      assert.equal(
        collectionCalls[i].snapshotId,
        'snap_locked_qa01_first',
        `第 ${i + 1} 次分页请求必须固定携带首个 snapshotId`,
      );
    }

    const enabledSessionId = enabledCreated.data.sessionId;
    const eTurn1 = await submitTurnHttp(runtime.origin, token, enabledSessionId, {
      clientRequestId: 'qa01-en-t1',
      baseGraphVersion: 0,
      text: '远程办公团队的异步评审必然降低跨时区协作效率。',
      cloudConsent: true,
    });

    // QA-11：确认至少一次采集请求携带了正数的 bodyMaxChars，且正文专属短片段已被成功载入并可供模型引用
    assert.ok(
      collectionCalls.some((c) => Number.isInteger(c.bodyMaxChars) && c.bodyMaxChars > 0),
      `QA-11：分页请求参数应携带 bodyMaxChars > 0，实测：${JSON.stringify(collectionCalls)}`,
    );
    const fullTextEv = eTurn1.session.evidenceIndex.find((e) => String(e.contentKey).includes('qa11_full_1'));
    const summaryOnlyEv = eTurn1.session.evidenceIndex.find((e) => String(e.contentKey).includes('qa11_sum_only_2'));
    assert.ok(fullTextEv, '应包含有正文的采集证据');
    assert.match(fullTextEv.excerpt, new RegExp(BODY_ONLY_PHRASE), 'QA-11：有正文的记录应保留正文专属短片段');
    assert.equal(fullTextEv.textKind, 'full_text');
    assert.ok(summaryOnlyEv, '应包含仅摘要且截断的采集证据');
    assert.equal(summaryOnlyEv.textKind, 'summary');
    assert.equal(summaryOnlyEv.truncated, true);

    // 模型收到的片段严格以本轮外发范围为限（包含远程办公正文片段，不包含无关园艺笔记）
    const enPromptStr = serializePromptCall(capturedCalls.at(-1));
    assert.ok(enPromptStr.includes(BODY_ONLY_PHRASE));
    assert.ok(!enPromptStr.includes(UNRELATED_PERSONAL_PHRASE));
  } finally {
    if (runtime) await runtime.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// QA-02
// ============================================================================
test('QA-02：同一合成快照在回环模型免云同意、外部模型无同意拦截（0调用）、外部模型有同意最小化外发及后续轮撤回同意阻断', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'qa02-http-'));
  const token = 'qtn_qa02_secret_token_123456';
  const noopOut = { write() {} };

  const REMOTE_SNIPPET = 'QA02_REMOTE_WORK_SNIPPET_跨时区异步接口文档';
  const MUSIC_SNIPPET = 'QA02_UNRELATED_MUSIC_SNIPPET_后摇独立乐队专场';

  const syntheticRecords = [
    {
      contentId: 'qa02_remote',
      contentType: 'answer',
      title: '远程办公协作笔记',
      summary: REMOTE_SNIPPET,
      summaryTruncated: false,
      bodyStatus: 'unavailable',
      fullTextAvailable: false,
      author: '陈序',
      kinds: ['collections'],
      url: 'https://www.zhihu.com/question/200/answer/1',
    },
    {
      contentId: 'qa02_music',
      contentType: 'answer',
      title: '独立音乐歌单收藏',
      summary: MUSIC_SNIPPET,
      summaryTruncated: false,
      bodyStatus: 'unavailable',
      fullTextAvailable: false,
      author: '周牧',
      kinds: ['collections'],
      url: 'https://www.zhihu.com/question/201/answer/2',
    },
  ];

  async function bootWithBaseUrl(dbFile, baseURL, modelObj) {
    const tools = buildCustomMcpTools({
      collectionRecords: syntheticRecords,
      snapshotId: 'snap_qa02_shared',
      searchItems: [],
    });
    return startQuotationService(
      ['--allow-personal-data', '--host', '127.0.0.1', '--port', '0', '--db', dbFile, '--base-url', baseURL, '--model', 'qa02-model'],
      {
        env: { AGENT_SERVER_TOKEN: token, AGENT_OWNER_ID: 'owner_qa02' },
        stdout: noopOut,
        stderr: noopOut,
        connectServers: async () => ({ tools, enabled: ['collection', 'search'], close: async () => {} }),
        createTurnOrchestrator: (opts) => createTurnOrchestrator({ ...opts, model: modelObj }),
      },
    );
  }

  let rtLoopback = null;
  let rtCloudNoConsent = null;
  let rtCloudConsent = null;

  try {
    // 1) 回环模型（real 模式，cloudConsent 设为 false）：创建成功且轮次正常提交
    const loopModelPack = createCapturingModel();
    rtLoopback = await bootWithBaseUrl(
      path.join(tmpDir, 'loopback.sqlite'),
      'http://127.0.0.1:11434/v1',
      loopModelPack.model,
    );
    const loopSess = await createSessionHttp(rtLoopback.origin, token, {
      usePersonalMaterials: true,
      cloudConsent: false,
    });
    assert.equal(loopSess.status, 201);
    const loopTurn = await submitTurnHttp(rtLoopback.origin, token, loopSess.data.sessionId, {
      clientRequestId: 'qa02-loop-t1',
      baseGraphVersion: 0,
      text: '远程办公必然降低所有团队的协作效率。',
      cloudConsent: false,
    });
    assert.ok(loopTurn.committed, 'QA-02：回环模型在 cloudConsent=false 时必须允许正常提交');
    assert.equal(loopModelPack.capturedCalls.length, 1);

    // 2) 外部非回环模型无同意：被拒并返回实际非空未确认清单，模型调用严格为 0
    const noConsentModelPack = createCapturingModel();
    rtCloudNoConsent = await bootWithBaseUrl(
      path.join(tmpDir, 'cloud-noconsent.sqlite'),
      'https://api.external-cloud.example/v1',
      noConsentModelPack.model,
    );
    const blockedCreate = await createSessionHttp(rtCloudNoConsent.origin, token, {
      usePersonalMaterials: true,
      cloudConsent: false,
    });
    assert.equal(blockedCreate.status, 403);
    assert.equal(blockedCreate.error.code, 'CLOUD_CONSENT_REQUIRED');
    assert.equal(blockedCreate.error.details?.outboundPreview?.previewConfirmed, false);
    assert.ok((blockedCreate.error.details?.outboundPreview?.items?.length ?? 0) > 0);
    assert.equal(noConsentModelPack.capturedCalls.length, 0);

    // 3) 外部模型先预览后确认：只发送本轮需要的片段，outboundPreview 与实际发送片段一致；后续轮传 cloudConsent:false 被阻断
    const consentModelPack = createCapturingModel();
    rtCloudConsent = await bootWithBaseUrl(
      path.join(tmpDir, 'cloud-consent.sqlite'),
      'https://api.external-cloud.example/v1',
      consentModelPack.model,
    );
    const cloudPreviewRes = await createSessionHttp(rtCloudConsent.origin, token, {
      usePersonalMaterials: true,
    });
    assert.equal(cloudPreviewRes.status, 403);
    assert.equal(cloudPreviewRes.error.code, 'CLOUD_CONSENT_REQUIRED');
    const cloudPreview = cloudPreviewRes.error.details?.outboundPreview;
    assert.ok(cloudPreview?.outboundPreviewId);
    assert.equal(cloudPreview.previewConfirmed, false);
    assert.equal(consentModelPack.capturedCalls.length, 0);

    const cloudSess = await createSessionHttp(rtCloudConsent.origin, token, {
      usePersonalMaterials: true,
      cloudConsent: true,
      outboundPreviewId: cloudPreview.outboundPreviewId,
      snapshotId: cloudPreview.snapshotId,
    });
    assert.equal(cloudSess.status, 201);

    const cloudTurn1 = await submitTurnHttp(rtCloudConsent.origin, token, cloudSess.data.sessionId, {
      clientRequestId: 'qa02-cloud-t1',
      baseGraphVersion: 0,
      text: '远程办公必然降低所有团队的协作效率。',
      cloudConsent: true,
    });
    assert.equal(consentModelPack.capturedCalls.length, 1);
    const cloudPrompt1 = serializePromptCall(consentModelPack.capturedCalls[0]);
    assert.ok(cloudPrompt1.includes(REMOTE_SNIPPET), '应包含本轮远程办公相关片段');
    assert.ok(!cloudPrompt1.includes(MUSIC_SNIPPET), '不应外发与本轮无关的音乐收藏片段');

    const previewIds = (cloudTurn1.session.outboundPreview?.snippetPreview ?? []).map((s) => s.evidenceId);
    assert.deepEqual(previewIds, ['ev_col_answer_qa02_remote'], 'outboundPreview 应与真正发送给模型的个人片段完全一致');

    // 同一会话第 2 轮显式传 cloudConsent: false -> 立即阻断，模型调用不增加
    const cloudTurn2Blocked = await submitTurnHttp(
      rtCloudConsent.origin,
      token,
      cloudSess.data.sessionId,
      {
        clientRequestId: 'qa02-cloud-t2-revoke',
        baseGraphVersion: cloudTurn1.session.graphVersion,
        text: '推荐算法只会让人的兴趣越来越窄。',
        cloudConsent: false,
      },
      { expectCommitted: false },
    );
    const blockedCode = cloudTurn2Blocked.error?.code ?? cloudTurn2Blocked.failed?.code ?? cloudTurn2Blocked.failed?.error?.code;
    assert.equal(blockedCode, 'CLOUD_CONSENT_REQUIRED');
    assert.equal(consentModelPack.capturedCalls.length, 1, '后续轮显式传 cloudConsent:false 时模型调用必须为 0');
  } finally {
    if (rtLoopback) await rtLoopback.close();
    if (rtCloudNoConsent) await rtCloudNoConsent.close();
    if (rtCloudConsent) await rtCloudConsent.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// QA-03
// ============================================================================
test('QA-03：显式 targetId 精确撤回 A 保留 B、引用无事实的第一轮不误撤第二轮、重复撤回幂等，且重连与重启一致', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'qa03-http-'));
  const dbPath = path.join(tmpDir, 'qa03.sqlite');
  const token = 'qtn_qa03_secret_token_123456';
  const noopOut = { write() {} };
  const { model } = createCapturingModel();

  const boot = () =>
    startQuotationService(
      ['--demo', '--host', '127.0.0.1', '--port', '0', '--db', dbPath, '--base-url', 'http://127.0.0.1:11434/v1', '--model', 'mock-v4'],
      {
        env: { AGENT_SERVER_TOKEN: token, AGENT_OWNER_ID: 'owner_qa03' },
        stdout: noopOut,
        stderr: noopOut,
        connectServers: async () => ({ tools: {}, enabled: [], close: async () => {} }),
        createTurnOrchestrator: (opts) => createTurnOrchestrator({ ...opts, model }),
      },
    );

  let runtime = null;
  try {
    runtime = await boot();

    // 场景一：建立两条独立事实 A、B，点选 targetId = A.id 撤回
    const s1 = (await createSessionHttp(runtime.origin, token, { usePersonalMaterials: false })).data;
    let v = s1.graphVersion;

    const t1 = await submitTurnHttp(runtime.origin, token, s1.sessionId, {
      clientRequestId: 'qa03-s1-t1',
      baseGraphVersion: v,
      text: '这家工厂从不允许员工换班。',
    });
    v = t1.session.graphVersion;

    const t2 = await submitTurnHttp(runtime.origin, token, s1.sessionId, {
      clientRequestId: 'qa03-s1-t2',
      baseGraphVersion: v,
      text: '我曾经在这家工厂成功换班。',
    });
    v = t2.session.graphVersion;
    const factA = t2.session.facts.find((f) => f.turnId === t2.turnId);
    assert.ok(factA);

    const t3 = await submitTurnHttp(runtime.origin, token, s1.sessionId, {
      clientRequestId: 'qa03-s1-t3',
      baseGraphVersion: v,
      text: '我本人还在另一座仓库独立完成了夜班盘点。',
    });
    v = t3.session.graphVersion;
    const factB = t3.session.facts.find((f) => f.turnId === t3.turnId);
    assert.ok(factB);
    assert.notEqual(factA.id, factB.id);
    assert.equal(v, 2);

    // 显式指定 targetId: factA.id 撤回 A
    const t4 = await submitTurnHttp(runtime.origin, token, s1.sessionId, {
      clientRequestId: 'qa03-s1-t4',
      baseGraphVersion: v,
      text: '撤回选中的事实',
      action: { type: 'retract_fact', targetId: factA.id },
    });
    assert.equal(t4.session.graphVersion, 3, '成功撤回 A 时 graphVersion 只增一次');
    const afterT4FactA = t4.session.facts.find((f) => f.id === factA.id);
    const afterT4FactB = t4.session.facts.find((f) => f.id === factB.id);
    assert.equal(afterT4FactA.status, 'retracted');
    assert.equal(afterT4FactB.status, 'active', 'QA-03：显式撤回 A 时必须完整保留独立事实 B');
    const invalidatedIds = t4.committed.invalidatedItems.map((i) => i.id);
    assert.ok(invalidatedIds.includes(factA.id));
    assert.ok(!invalidatedIds.includes(factB.id));
    for (const bNodeId of factB.nodeIds ?? []) {
      assert.ok(!invalidatedIds.includes(bNodeId));
    }

    // 重复撤回 A：幂等无额外变更
    const t5 = await submitTurnHttp(runtime.origin, token, s1.sessionId, {
      clientRequestId: 'qa03-s1-t5-dup',
      baseGraphVersion: 3,
      text: '再次撤回选中的事实',
      action: { type: 'retract_fact', targetId: factA.id },
    });
    assert.equal(t5.session.graphVersion, 3, '重复撤回不得递增 graphVersion');
    assert.equal(t5.committed.invalidatedItems.length, 0);
    assert.equal(t5.session.facts.find((f) => f.id === factB.id).status, 'active');

    // 不存在或属于其他会话的目标 ID：无额外变更
    const t6 = await submitTurnHttp(runtime.origin, token, s1.sessionId, {
      clientRequestId: 'qa03-s1-t6-missing',
      baseGraphVersion: 3,
      text: '撤回不存在的事实',
      action: { type: 'retract_fact', targetId: 'fact_from_other_session_999' },
    });
    assert.equal(t6.session.graphVersion, 3);
    assert.equal(t6.committed.invalidatedItems.length, 0);
    assert.equal(t6.session.facts.find((f) => f.id === factB.id).status, 'active');

    // 场景二：第 1 轮只输入待分析句（无事实），第 2 轮确认事实，第 3 轮输入“我撤回第一轮提到的条件”
    const s2 = (await createSessionHttp(runtime.origin, token, { usePersonalMaterials: false })).data;
    const s2t1 = await submitTurnHttp(runtime.origin, token, s2.sessionId, {
      clientRequestId: 'qa03-s2-t1',
      baseGraphVersion: 0,
      text: '这家工厂从不允许员工换班。',
    });
    assert.equal(s2t1.session.facts.length, 0);
    assert.equal(s2t1.session.graphVersion, 0);

    const s2t2 = await submitTurnHttp(runtime.origin, token, s2.sessionId, {
      clientRequestId: 'qa03-s2-t2',
      baseGraphVersion: 0,
      text: '我曾经在这家工厂成功换班。',
    });
    assert.equal(s2t2.session.graphVersion, 1);
    assert.equal(s2t2.session.statements[0].quote.assessment, 'conflict');
    assert.equal(s2t2.session.statements[0].quote.rate, 100);

    const s2t3 = await submitTurnHttp(runtime.origin, token, s2.sessionId, {
      clientRequestId: 'qa03-s2-t3',
      baseGraphVersion: 1,
      text: '我撤回第一轮提到的条件',
    });
    assert.equal(s2t3.session.graphVersion, 1, 'QA-03：引用无事实的第一轮不得递增图版本');
    assert.equal(s2t3.committed.invalidatedItems.length, 0);
    assert.equal(s2t3.session.facts[0].status, 'active', 'QA-03：第二轮确认的事实不得被误撤');
    assert.equal(s2t3.session.statements[0].quote.assessment, 'conflict');
    assert.equal(s2t3.session.statements[0].quote.rate, 100);

    // Last-Event-ID 重连 SSE 与重启服务后复核一致
    const replayedSse = await readSseStream(`${runtime.origin}${s2t3.eventsUrl}`, { token, lastEventId: 1 });
    assert.equal(replayedSse.find((e) => e.event === 'turn.committed').data.graphVersion, 1);

    await runtime.close();
    runtime = await boot();

    const reloadedS1 = (await getSessionHttp(runtime.origin, token, s1.sessionId)).data;
    assert.equal(reloadedS1.graphVersion, 3);
    assert.equal(reloadedS1.facts.find((f) => f.id === factA.id).status, 'retracted');
    assert.equal(reloadedS1.facts.find((f) => f.id === factB.id).status, 'active');

    const reloadedS2 = (await getSessionHttp(runtime.origin, token, s2.sessionId)).data;
    assert.equal(reloadedS2.graphVersion, 1);
    assert.equal(reloadedS2.facts[0].status, 'active');
    assert.equal(reloadedS2.statements[0].quote.rate, 100);
  } finally {
    if (runtime) await runtime.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// QA-04
// ============================================================================
test('QA-04：显式 focusRef.nodeId 绑定节点证据范围且不增图版本；显式 adoptStatementId 采用指定改写并跨重启保持；无效引用不静默替换', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'qa04-http-'));
  const dbPath = path.join(tmpDir, 'qa04.sqlite');
  const token = 'qtn_qa04_secret_token_123456';
  const noopOut = { write() {} };
  const { model } = createCapturingModel();

  const boot = () =>
    startQuotationService(
      ['--demo', '--host', '127.0.0.1', '--port', '0', '--db', dbPath, '--base-url', 'http://127.0.0.1:11434/v1', '--model', 'mock-v4'],
      {
        env: { AGENT_SERVER_TOKEN: token, AGENT_OWNER_ID: 'owner_qa04' },
        stdout: noopOut,
        stderr: noopOut,
        connectServers: async () => ({ tools: {}, enabled: [], close: async () => {} }),
        createTurnOrchestrator: (opts) => createTurnOrchestrator({ ...opts, model }),
      },
    );

  let runtime = null;
  try {
    runtime = await boot();

    const sess = (await createSessionHttp(runtime.origin, token, { usePersonalMaterials: false })).data;
    let v = 0;

    // 原句 + 两条具有不同证据的节点 + 两份改写
    const r1 = await submitTurnHttp(runtime.origin, token, sess.sessionId, {
      clientRequestId: 'qa04-t1',
      baseGraphVersion: v,
      text: '推荐算法只会让人的兴趣越来越窄。',
    });
    v = r1.session.graphVersion;

    const r2 = await submitTurnHttp(runtime.origin, token, sess.sessionId, {
      clientRequestId: 'qa04-t2-nodeA',
      baseGraphVersion: v,
      text: '我自己确实通过推荐发现过以前没听过的新乐队。',
    });
    v = r2.session.graphVersion;
    const nodeA = r2.session.confirmedGraph.find((n) => n.kind === 'fact');
    assert.ok(nodeA && nodeA.evidenceIds.length === 1);

    const r3 = await submitTurnHttp(runtime.origin, token, sess.sessionId, {
      clientRequestId: 'qa04-t3-nodeB',
      baseGraphVersion: v,
      text: '我确认，我发现新乐队只发生在刚开始用的时候。',
    });
    v = r3.session.graphVersion;
    const nodeB = r3.session.confirmedGraph.find((n) => n.kind === 'condition');
    assert.ok(nodeB && nodeB.evidenceIds.length === 1);
    assert.notDeepEqual(nodeA.evidenceIds, nodeB.evidenceIds);

    // 1) 点选 nodeA 查询“这是谁说的？”，焦点必须绑定 nodeA 与其证据 ID，且 graphVersion 不变
    const r4 = await submitTurnHttp(runtime.origin, token, sess.sessionId, {
      clientRequestId: 'qa04-t4-focus-nodeA',
      baseGraphVersion: v,
      text: '这是谁说的？',
      focusRef: { nodeId: nodeA.id },
    });
    assert.equal(r4.session.graphVersion, v, '点选节点查询出处不得递增 graphVersion');
    const selectedFocus = r4.events.find((e) => e.event === 'focus.selected').data.focus;
    assert.equal(selectedFocus.nodeId, nodeA.id);
    assert.equal(selectedFocus.spanText, nodeA.text, 'QA-04：焦点不能落在提问文本“这是谁说的？”上');
    assert.deepEqual(r4.committed.verifiedEvidenceIds, nodeA.evidenceIds);

    // 2) 创建两份改写 rw1、rw2，显式采用第一份改写 rw1
    const r5 = await submitTurnHttp(runtime.origin, token, sess.sessionId, {
      clientRequestId: 'qa04-t5-rw1',
      baseGraphVersion: v,
      text: '如果改成：连续听同类歌曲之后，推荐里的新东西会越来越少。',
    });
    const rw1 = r5.session.statements.find((s) => s.createdTurnId === r5.turnId);
    assert.ok(rw1);

    const r6 = await submitTurnHttp(runtime.origin, token, sess.sessionId, {
      clientRequestId: 'qa04-t6-rw2',
      baseGraphVersion: v,
      text: '换个说法：缺乏主动搜索时，推荐列表的新鲜度可能逐步降低。',
    });
    const rw2 = r6.session.statements.find((s) => s.createdTurnId === r6.turnId);
    assert.ok(rw2 && rw1.statementId !== rw2.statementId);

    const r7 = await submitTurnHttp(runtime.origin, token, sess.sessionId, {
      clientRequestId: 'qa04-t7-converge-rw1',
      baseGraphVersion: v,
      text: '收束当前讨论并采用第一份改写版本。',
      action: { type: 'converge', adoptStatementId: rw1.statementId },
    });
    assert.equal(r7.committed.convergenceSummary.adoptedRewrite.statementId, rw1.statementId);
    assert.equal(r7.session.adoptedStatementId, rw1.statementId);
    assert.equal(r7.session.convergenceSummary.adoptedRewrite.statementId, rw1.statementId);

    // 重启后验证默认采用与快照仍是第一份改写 rw1
    await runtime.close();
    runtime = await boot();

    const afterRestart = (await getSessionHttp(runtime.origin, token, sess.sessionId)).data;
    assert.equal(afterRestart.adoptedStatementId, rw1.statementId);
    assert.equal(afterRestart.convergenceSummary.adoptedRewrite.statementId, rw1.statementId);

    // 重启后缺省再收束一次，仍保持已持久化的第一份改写 rw1
    const r8 = await submitTurnHttp(runtime.origin, token, sess.sessionId, {
      clientRequestId: 'qa04-t8-converge-default-persisted',
      baseGraphVersion: v,
      text: '再次汇总当前收束结果。',
      action: { type: 'converge' },
    });
    assert.equal(r8.committed.convergenceSummary.adoptedRewrite.statementId, rw1.statementId);

    // 3) 无效 nodeId 与无效 adoptStatementId：明确报错 INVALID_ARGUMENTS，绝不静默替换
    const badNodeTurn = await submitTurnHttp(
      runtime.origin,
      token,
      sess.sessionId,
      {
        clientRequestId: 'qa04-t9-bad-node',
        baseGraphVersion: v,
        text: '这是谁说的？',
        focusRef: { nodeId: 'node_nonexistent_999' },
      },
      { expectCommitted: false },
    );
    assert.equal(badNodeTurn.committed, null);
    assert.equal(
      badNodeTurn.error?.code ?? badNodeTurn.failed?.code ?? badNodeTurn.failed?.error?.code,
      'INVALID_ARGUMENTS',
    );

    const badAdoptTurn = await submitTurnHttp(
      runtime.origin,
      token,
      sess.sessionId,
      {
        clientRequestId: 'qa04-t10-bad-adopt',
        baseGraphVersion: v,
        text: '收束讨论',
        action: { type: 'converge', adoptStatementId: 'stmt_nonexistent_999' },
      },
      { expectCommitted: false },
    );
    assert.equal(badAdoptTurn.committed, null);
    assert.equal(
      badAdoptTurn.error?.code ?? badAdoptTurn.failed?.code ?? badAdoptTurn.failed?.error?.code,
      'INVALID_ARGUMENTS',
    );
    assert.equal(badAdoptTurn.session.adoptedStatementId, rw1.statementId, '无效 adoptStatementId 不得篡改已采纳版本');
  } finally {
    if (runtime) await runtime.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// QA-05
// ============================================================================
test('QA-05：覆盖同义复述、近似词不同对象、任意条件“雨天”、明确反例（工厂换班新领域）、双重否定与空材料防编造六组回归', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'qa05-http-'));
  const dbPath = path.join(tmpDir, 'qa05.sqlite');
  const token = 'qtn_qa05_secret_token_123456';
  const noopOut = { write() {} };
  const { model } = createCapturingModel();

  const emptyTools = buildCustomMcpTools({
    collectionRecords: [],
    searchItems: [],
  });

  const runtime = await startQuotationService(
    ['--host', '127.0.0.1', '--port', '0', '--db', dbPath, '--base-url', 'http://127.0.0.1:11434/v1', '--model', 'mock-v4'],
    {
      env: { AGENT_SERVER_TOKEN: token, AGENT_OWNER_ID: 'owner_qa05' },
      stdout: noopOut,
      stderr: noopOut,
      connectServers: async () => ({ tools: emptyTools, enabled: ['search'], close: async () => {} }),
      createTurnOrchestrator: (opts) => createTurnOrchestrator({ ...opts, model }),
    },
  );

  try {
    // ① 同义复述相容：“远程办公提高了交付速度，却降低了即时沟通效率” -> 本人同义经历应判为 compatible 而非 conflict
    const sSyn = (await createSessionHttp(runtime.origin, token, { usePersonalMaterials: false })).data;
    await submitTurnHttp(runtime.origin, token, sSyn.sessionId, {
      clientRequestId: 'qa05-syn-1',
      baseGraphVersion: 0,
      text: '远程办公提高了交付速度，却降低了即时沟通效率。',
    });
    const synT2 = await submitTurnHttp(runtime.origin, token, sSyn.sessionId, {
      clientRequestId: 'qa05-syn-2',
      baseGraphVersion: 0,
      text: '我亲身经历：远程办公提升了交付速度，但降低了即时沟通效率。',
    });
    const synQuote = synT2.session.statements[0].quote;
    assert.equal(synQuote.assessment, 'compatible', 'QA-05①：同义多子句本人表述应判为相容');
    assert.deepEqual(synQuote.directConflicts, []);
    assert.equal(synQuote.rate, 0);
    assert.ok(synQuote.verifiedEvidenceIds.length >= 1);

    // ② 近似词在不同对象上：“协作效率降低，但会议频率提高”绝不能当成“协作效率提高”
    const sObj = (await createSessionHttp(runtime.origin, token, { usePersonalMaterials: false })).data;
    await submitTurnHttp(runtime.origin, token, sObj.sessionId, {
      clientRequestId: 'qa05-obj-1',
      baseGraphVersion: 0,
      text: '团队协作效率提高了。',
    });
    const objT2 = await submitTurnHttp(runtime.origin, token, sObj.sessionId, {
      clientRequestId: 'qa05-obj-2',
      baseGraphVersion: 0,
      text: '我们在实际经历中团队协作效率降低，但会议频率提高。',
    });
    const objQuote = objT2.session.statements[0].quote;
    assert.equal(objQuote.assessment, 'conflict', 'QA-05②：会议频率提高不得掩盖协作效率降低的冲突');
    assert.ok(objQuote.directConflicts.length >= 1);

    // ③ 任意范围限定：“我确认，这个现象只发生在雨天” -> 证据、事实与图均保留“雨天”且不含“刚开始用的时候”
    const sRain = (await createSessionHttp(runtime.origin, token, { usePersonalMaterials: false })).data;
    await submitTurnHttp(runtime.origin, token, sRain.sessionId, {
      clientRequestId: 'qa05-rain-1',
      baseGraphVersion: 0,
      text: '户外传感器信号必然全天候稳定传输。',
    });
    const rainT2 = await submitTurnHttp(runtime.origin, token, sRain.sessionId, {
      clientRequestId: 'qa05-rain-2',
      baseGraphVersion: 0,
      text: '我曾经遇到户外传感器信号中断。',
    });
    const rainT3 = await submitTurnHttp(runtime.origin, token, sRain.sessionId, {
      clientRequestId: 'qa05-rain-3',
      baseGraphVersion: rainT2.session.graphVersion,
      text: '我确认，这个现象只发生在雨天',
    });
    const rainCondFact = rainT3.session.facts.find((f) => f.kind === 'condition');
    assert.ok(rainCondFact, '应生成雨天限定条件记录');
    assert.equal(rainCondFact.text, '我确认，这个现象只发生在雨天');
    assert.match(rainT3.session.confirmedGraph.map((n) => n.text).join(' '), /雨天/);
    assert.equal(
      JSON.stringify(rainT3.session).includes('刚开始用的时候'),
      false,
      'QA-05③：确认“雨天”的会话中严禁混入演示条件“刚开始用的时候”',
    );

    // ④ 明确反例（无关新领域：工厂换班，从空会话完整走到冲突报价）
    const sFactory = (await createSessionHttp(runtime.origin, token, { usePersonalMaterials: false })).data;
    const facT1 = await submitTurnHttp(runtime.origin, token, sFactory.sessionId, {
      clientRequestId: 'qa05-fac-1',
      baseGraphVersion: 0,
      text: '这家工厂从不允许员工换班。',
    });
    assert.equal(facT1.session.statements[0].quote.assessment, 'insufficient_evidence');
    assert.equal(facT1.session.statements[0].quote.rate, null);

    const facT2 = await submitTurnHttp(runtime.origin, token, sFactory.sessionId, {
      clientRequestId: 'qa05-fac-2',
      baseGraphVersion: 0,
      text: '我曾经在这家工厂成功换班。',
    });
    assert.equal(facT2.committed.graphPatch.addedNodes.length >= 1, true);
    const facQuote = facT2.session.statements[0].quote;
    assert.equal(facQuote.assessment, 'conflict');
    assert.ok(facQuote.directConflicts.length >= 1);
    assert.ok(facQuote.verifiedEvidenceIds.length >= 1);
    assert.equal(facQuote.rate, 100);

    // ⑤ 双重否定识别：“这家工厂允许员工换班” vs “我确认：这家工厂并非不允许员工换班” -> 相容
    const sDoubleNeg = (await createSessionHttp(runtime.origin, token, { usePersonalMaterials: false })).data;
    await submitTurnHttp(runtime.origin, token, sDoubleNeg.sessionId, {
      clientRequestId: 'qa05-dn-1',
      baseGraphVersion: 0,
      text: '这家工厂允许员工换班。',
    });
    const dnT2 = await submitTurnHttp(runtime.origin, token, sDoubleNeg.sessionId, {
      clientRequestId: 'qa05-dn-2',
      baseGraphVersion: 0,
      text: '我确认：这家工厂并非不允许员工换班。',
    });
    assert.equal(dnT2.session.statements[0].quote.assessment, 'compatible', 'QA-05⑤：双重否定同向表达应判为相容');
    assert.deepEqual(dnT2.session.statements[0].quote.directConflicts, []);

    // ⑥ 空图、空搜索核对初期适用范围：严禁编造无引文的确定性反例，维持 insufficient_evidence / null
    const sEmpty = (await createSessionHttp(runtime.origin, token, { usePersonalMaterials: false })).data;
    const empT1 = await submitTurnHttp(runtime.origin, token, sEmpty.sessionId, {
      clientRequestId: 'qa05-empty-check-1',
      baseGraphVersion: 0,
      text: '请帮我核对初期适用范围',
    });
    assert.equal(empT1.committed.conditionCheckResult.assessment, 'insufficient_evidence');
    assert.equal(empT1.committed.activeQuote.assessment, 'insufficient_evidence');
    assert.equal(empT1.committed.activeQuote.rate, null);
    assert.equal(empT1.committed.verifiedEvidenceIds.length, 0);
    assert.ok(!empT1.committed.conditionCheckResult.supportedScope.includes('确实存在拓宽或反例'));
  } finally {
    await runtime.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// QA-06
// ============================================================================
test('QA-06：可控流式模型阻塞后段时安全首段立即可见；拦截剔除虚构引文与错误“报价 72%”；拒绝归属错误与词面相似支撑候选入图', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'qa06-http-'));
  const dbPath = path.join(tmpDir, 'qa06.sqlite');
  const token = 'qtn_qa06_secret_token_123456';
  const noopOut = { write() {} };

  const FABRICATED_QUOTE = '推荐引擎会在每周三凌晨四点清空全部用户历史标签';
  const SAFE_FIRST_SEGMENT = '根据已核验记录，当前句子尚未发现本人确认的反例依据；';

  let notifyFirstChunkEnqueued;
  const firstChunkEnqueued = new Promise((resolve) => {
    notifyFirstChunkEnqueued = resolve;
  });
  let releaseSecondChunk;
  const secondChunkGate = new Promise((resolve) => {
    releaseSecondChunk = resolve;
  });

  let streamCallNum = 0;
  const gatedHallucinatingModel = new MockLanguageModelV4({
    doStream: async () => {
      streamCallNum += 1;
      if (streamCallNum === 1) {
        let pullPhase = 0;
        return {
          stream: new ReadableStream({
            async pull(controller) {
              if (pullPhase === 0) {
                pullPhase = 1;
                controller.enqueue({ type: 'text-start', id: 'qa06-1' });
                controller.enqueue({ type: 'text-delta', id: 'qa06-1', delta: SAFE_FIRST_SEGMENT });
                notifyFirstChunkEnqueued();
                return;
              }
              await secondChunkGate;
              controller.enqueue({
                type: 'text-delta',
                id: 'qa06-1',
                delta: `但外部材料写着“${FABRICATED_QUOTE}”，因此当前报价 72%。`,
              });
              controller.enqueue({ type: 'text-end', id: 'qa06-1' });
              controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE });
              controller.close();
            },
          }, { highWaterMark: 0 }),
        };
      }
      return {
        stream: convertArrayToReadableStream([
          { type: 'text-start', id: `qa06-${streamCallNum}` },
          { type: 'text-delta', id: `qa06-${streamCallNum}`, delta: '核验说明完成。' },
          { type: 'text-end', id: `qa06-${streamCallNum}` },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
        ]),
      };
    },
  });

  const boot = () =>
    startQuotationService(
      ['--demo', '--allow-personal-data', '--host', '127.0.0.1', '--port', '0', '--db', dbPath, '--base-url', 'http://127.0.0.1:11434/v1', '--model', 'mock-v4'],
      {
        env: { AGENT_SERVER_TOKEN: token, AGENT_OWNER_ID: 'owner_qa06' },
        stdout: noopOut,
        stderr: noopOut,
        connectServers: async () => ({ tools: {}, enabled: [], close: async () => {} }),
        createTurnOrchestrator: (opts) => createTurnOrchestrator({ ...opts, model: gatedHallucinatingModel }),
      },
    );

  let runtime = null;
  try {
    runtime = await boot();

    // 1) 流式守卫 + 受控门控信号验证首段实时可见，后段虚构引文与错误 72% 全程不出现
    const sess = (await createSessionHttp(runtime.origin, token, { usePersonalMaterials: true })).data;
    const postRes = await fetch(`${runtime.origin}/v1/sessions/${sess.sessionId}/turns`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientRequestId: 'qa06-stream-t1',
        baseGraphVersion: 0,
        text: '推荐算法只会让人的兴趣越来越窄。',
      }),
    });
    assert.equal(postRes.status, 202);
    const { eventsUrl } = (await postRes.json()).data;

    let sawSafeFirstBeforeRelease = false;
    let notifySawFirstOnSse;
    const sawFirstOnSsePromise = new Promise((resolve) => {
      notifySawFirstOnSse = resolve;
    });

    const ssePromise = readSseStream(`${runtime.origin}${eventsUrl}`, {
      token,
      onEvent: (ev) => {
        if (ev.event === 'text.delta' && ev.data?.delta?.includes(SAFE_FIRST_SEGMENT)) {
          sawSafeFirstBeforeRelease = true;
          notifySawFirstOnSse();
        }
      },
    });

    await firstChunkEnqueued;
    await sawFirstOnSsePromise;
    assert.equal(sawSafeFirstBeforeRelease, true, 'QA-06：受控信号阻塞第二段时，安全的首段已在模型完成前通过 SSE 可见');

    releaseSecondChunk();
    const allEvents = await ssePromise;
    const allDeltaText = allEvents
      .filter((e) => e.event === 'text.delta')
      .map((e) => e.data.delta)
      .join('');
    const committedData = allEvents.find((e) => e.event === 'turn.committed')?.data;
    assert.ok(committedData);

    assert.ok(!allDeltaText.includes(FABRICATED_QUOTE), 'SSE text.delta 绝不能出现虚构引文');
    assert.ok(!allDeltaText.includes('72%'), 'SSE text.delta 绝不能出现错误的 72%');
    assert.ok(!JSON.stringify(committedData).includes(FABRICATED_QUOTE));
    assert.ok(!JSON.stringify(committedData).includes('72%'));

    // 重启服务后复查会话持久化记录，同样不含虚构引文与错误百分比
    await runtime.close();
    runtime = await boot();
    const restartedSnap = (await getSessionHttp(runtime.origin, token, sess.sessionId)).data;
    assert.ok(!JSON.stringify(restartedSnap).includes(FABRICATED_QUOTE));
    assert.ok(!JSON.stringify(restartedSnap).includes('72%'));

    // 2) 引文真实但把他人归属伪造为本人（OTHER_AUTHOR_MISATTRIBUTED_AS_SELF）-> 拒绝提交候选
    const misattrSess = (
      await createSessionHttp(runtime.origin, token, {
        usePersonalMaterials: true,
        metadata: {
          proposalsByRequestId: {
            'qa06-misattr-req': {
              candidateNodes: [
                {
                  id: 'node_forged_self',
                  text: '把周牧的回答伪造成本人立场',
                  claimedAttribution: 'self',
                  claimedAuthor: 'self',
                  evidenceIds: ['ev_col_answer_201'],
                  quoteText: '发现了好几支以前从没听过的独立乐队',
                },
              ],
            },
          },
        },
      })
    ).data;

    const misattrTurn = await submitTurnHttp(
      runtime.origin,
      token,
      misattrSess.sessionId,
      {
        clientRequestId: 'qa06-misattr-req',
        baseGraphVersion: 0,
        text: '推荐算法只会让人的兴趣越来越窄。',
      },
      { expectCommitted: false },
    );
    assert.equal(misattrTurn.committed, null);
    assert.equal(
      misattrTurn.failed?.code ?? misattrTurn.failed?.error?.code,
      'VERIFICATION_REJECTED',
    );
    assert.equal(misattrTurn.session.confirmedGraph.length, 0);

    // 3) 仅有词面相似/同话题的支撑边候选 -> 拒绝提交候选
    const lexicalEdgeSess = (
      await createSessionHttp(runtime.origin, token, {
        usePersonalMaterials: false,
        metadata: {
          initialGraph: [
            { id: 'n_lex_1', text: '远程办公团队使用异步文档记录接口变更', cluster: 'remote', deps: [], attribution: 'self' },
            { id: 'n_lex_2', text: '远程办公团队每周在异步文档同步项目进度', cluster: 'remote', deps: [], attribution: 'self' },
          ],
          proposalsByRequestId: {
            'qa06-lexical-edge-req': {
              candidateEdges: [
                {
                  premiseId: 'n_lex_1',
                  dependentId: 'n_lex_2',
                  relationType: 'lexical_similarity',
                  reason: '两者都在讨论远程办公',
                },
              ],
            },
          },
        },
      })
    ).data;

    const lexicalTurn = await submitTurnHttp(
      runtime.origin,
      token,
      lexicalEdgeSess.sessionId,
      {
        clientRequestId: 'qa06-lexical-edge-req',
        baseGraphVersion: 0,
        text: '远程办公必然降低协作效率。',
      },
      { expectCommitted: false },
    );
    assert.equal(lexicalTurn.committed, null);
    assert.equal(
      lexicalTurn.failed?.code ?? lexicalTurn.failed?.error?.code,
      'VERIFICATION_REJECTED',
    );
  } finally {
    if (runtime) await runtime.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// QA-07
// ============================================================================
test('QA-07：无证据改写保持空差值与空已解决集合；正向核验改写进入 resolvedConflicts；撤回唯一冲突依据并保留无关支撑边后恢复未定且无旧理由', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'qa07-http-'));
  const dbPath = path.join(tmpDir, 'qa07.sqlite');
  const token = 'qtn_qa07_secret_token_123456';
  const noopOut = { write() {} };
  const { model } = createCapturingModel();

  const boot = () =>
    startQuotationService(
      ['--demo', '--host', '127.0.0.1', '--port', '0', '--db', dbPath, '--base-url', 'http://127.0.0.1:11434/v1', '--model', 'mock-v4'],
      {
        env: { AGENT_SERVER_TOKEN: token, AGENT_OWNER_ID: 'owner_qa07' },
        stdout: noopOut,
        stderr: noopOut,
        connectServers: async () => ({ tools: {}, enabled: [], close: async () => {} }),
        createTurnOrchestrator: (opts) => createTurnOrchestrator({ ...opts, model }),
      },
    );

  let runtime = null;
  try {
    runtime = await boot();

    const sess = (await createSessionHttp(runtime.origin, token, { usePersonalMaterials: false })).data;
    let v = 0;

    // 1) 输入原句
    const t1 = await submitTurnHttp(runtime.origin, token, sess.sessionId, {
      clientRequestId: 'qa07-t1',
      baseGraphVersion: v,
      text: '这家工厂从不允许员工换班。',
    });
    v = t1.session.graphVersion;

    // 2) 确认唯一冲突依据 factConflict + 一条无关领域的支撑边 factUnrelated（确保撤回冲突依据后分母仍 > 0）
    const t2 = await submitTurnHttp(runtime.origin, token, sess.sessionId, {
      clientRequestId: 'qa07-t2-conflict',
      baseGraphVersion: v,
      text: '我曾经在这家工厂成功换班。',
    });
    v = t2.session.graphVersion;
    const conflictFact = t2.session.facts.find((f) => f.turnId === t2.turnId);
    const conflictNodeId = conflictFact.nodeIds[0];

    const t3 = await submitTurnHttp(runtime.origin, token, sess.sessionId, {
      clientRequestId: 'qa07-t3-unrelated-edge',
      baseGraphVersion: v,
      text: '我自己去年在生鲜冷链仓库独立完成过盘点。',
    });
    v = t3.session.graphVersion;
    assert.equal(t3.session.statements[0].quote.assessment, 'conflict');
    assert.equal(t3.session.statements[0].quote.denominator, 2);
    assert.equal(t3.session.statements[0].quote.rate, 50);

    // 3) 提交一个证据不足的缩小范围改写 -> 同图同分母、deltaRate: null、resolvedConflicts: []、resolvedAffected: []
    const t4 = await submitTurnHttp(runtime.origin, token, sess.sessionId, {
      clientRequestId: 'qa07-t4-unverified-rw',
      baseGraphVersion: v,
      text: '如果改成：在年度停产检修期间，这家工厂不允许员工换班。',
    });
    const unverifiedRw = t4.session.statements.find((s) => s.createdTurnId === t4.turnId);
    assert.equal(unverifiedRw.quote.assessment, 'insufficient_evidence');
    assert.equal(unverifiedRw.quote.rate, null);
    assert.equal(unverifiedRw.quote.graphVersion, t4.session.statements[0].quote.graphVersion);
    assert.equal(unverifiedRw.quote.denominator, t4.session.statements[0].quote.denominator);

    const unverifiedCmp = t4.session.statementComparison.comparisons.find(
      (c) => c.statementId === unverifiedRw.statementId,
    );
    assert.ok(unverifiedCmp);
    assert.equal(unverifiedCmp.deltaRate, null, 'QA-07：证据不足改写的差值必须为空');
    assert.deepEqual(unverifiedCmp.resolvedConflicts, [], 'QA-07：证据不足改写不得将原冲突计入 resolvedConflicts');
    assert.deepEqual(unverifiedCmp.resolvedAffected, [], 'QA-07：证据不足改写不得将原受影响节点计入 resolvedAffected');

    // 4) 正向对照：提交有已核验本人依据支撑的相容改写 -> 真实解除进入 resolvedConflicts
    const t5 = await submitTurnHttp(runtime.origin, token, sess.sessionId, {
      clientRequestId: 'qa07-t5-verified-rw',
      baseGraphVersion: v,
      text: '如果改成：这家工厂曾有员工成功换班。',
    });
    const verifiedRw = t5.session.statements.find((s) => s.createdTurnId === t5.turnId);
    assert.equal(verifiedRw.quote.assessment, 'compatible');
    assert.equal(verifiedRw.quote.rate, 0);
    const verifiedCmp = t5.session.statementComparison.comparisons.find(
      (c) => c.statementId === verifiedRw.statementId,
    );
    assert.equal(verifiedCmp.deltaRate, -50);
    assert.ok(verifiedCmp.resolvedConflicts.includes(conflictNodeId), '正向已核验相容改写应进入 resolvedConflicts');

    // 5) 撤回唯一冲突依据 conflictFact，保留无关支撑边（此时图仍有节点且分母 = 1）
    const t6 = await submitTurnHttp(runtime.origin, token, sess.sessionId, {
      clientRequestId: 'qa07-t6-retract-only-conflict',
      baseGraphVersion: v,
      text: '撤回换班那条事实',
      action: { type: 'retract_fact', targetId: conflictFact.id },
    });
    assert.ok(t6.session.confirmedGraph.length >= 2, '无关支撑边必须保留在已确认图中');
    const origInCommitted = t6.committed.statements.find((s) => s.statementId === 'stmt_original');
    assert.equal(origInCommitted.quote.denominator, 1);
    assert.equal(origInCommitted.quote.assessment, 'insufficient_evidence', 'QA-07：撤回唯一冲突后不得误标为 compatible');
    assert.equal(origInCommitted.quote.rate, null, 'QA-07：缺证据时比例必须为 null');
    assert.deepEqual(origInCommitted.quote.conflictReasons, []);
    assert.ok(!origInCommitted.quote.reason.includes(conflictNodeId), '不得残留已撤回的旧冲突节点理由');

    // 快照、SSE 续读与重启后均保持未定且无旧理由
    assert.equal(t6.session.statements[0].quote.assessment, 'insufficient_evidence');
    assert.equal(t6.session.statements[0].quote.rate, null);
    assert.deepEqual(t6.session.statements[0].quote.conflictReasons, []);

    const reconnected = await readSseStream(`${runtime.origin}${t6.eventsUrl}`, { token, lastEventId: 1 });
    const reconOrig = reconnected.find((e) => e.event === 'turn.committed').data.statements[0];
    assert.equal(reconOrig.quote.assessment, 'insufficient_evidence');
    assert.equal(reconOrig.quote.rate, null);

    await runtime.close();
    runtime = await boot();
    const restarted = (await getSessionHttp(runtime.origin, token, sess.sessionId)).data;
    assert.equal(restarted.statements[0].quote.assessment, 'insufficient_evidence');
    assert.equal(restarted.statements[0].quote.rate, null);
    assert.deepEqual(restarted.statements[0].quote.conflictReasons, []);
    assert.ok(!restarted.statements[0].quote.reason.includes(conflictNodeId));
  } finally {
    if (runtime) await runtime.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// QA-08
// ============================================================================
test('QA-08：临时 SQLite 装入 200 条独立标记事实，紧凑预算下精确取回早期第 3 条引用且无关标记零外发，会话完整保留 200 条且算价基于完整图', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'qa08-http-'));
  const dbPath = path.join(tmpDir, 'qa08.sqlite');
  const token = 'qtn_qa08_secret_token_123456';
  const noopOut = { write() {} };
  const { model, capturedCalls } = createCapturingModel();

  const initialFacts = [];
  const initialGraph = [];
  const initialEvidence = [];

  for (let i = 1; i <= 200; i += 1) {
    const pad = String(i).padStart(3, '0');
    const fid = `fact_bulk_${pad}`;
    const eid = `ev_bulk_${pad}`;
    const marker = i === 3
      ? `TARGET_EARLY_MARKER_003_第3条关键排班事实_${'背景补充'.repeat(20)}`
      : `UNRELATED_BULK_MARKER_${pad}_${'无关历史长文本填充'.repeat(40)}`;
    initialEvidence.push({
      id: eid,
      evidenceId: eid,
      sourceType: 'session_turn',
      author: 'self',
      attribution: 'self',
      turnId: `turn_seed_${pad}`,
      excerpt: marker,
    });
    initialFacts.push({
      id: fid,
      kind: 'fact',
      text: marker,
      turnId: `turn_seed_${pad}`,
      turnNumber: i,
      attribution: 'self',
      status: 'active',
      evidenceIds: [eid],
    });
    const rootId = `node_root_${pad}`;
    const leafId = `node_leaf_${pad}`;
    initialGraph.push(
      {
        id: rootId,
        kind: 'fact',
        text: `根节点_${pad}：${marker}`,
        cluster: `cluster_${pad}`,
        deps: [],
        attribution: 'self',
        evidenceIds: [eid],
        sourceFactIds: [fid],
      },
      {
        id: leafId,
        kind: 'judgment',
        text: `叶判断_${pad}`,
        cluster: `cluster_${pad}`,
        deps: [rootId],
        attribution: 'self',
        evidenceIds: [eid],
        sourceFactIds: [fid],
      },
    );
  }

  const MAX_PROMPT_BUDGET = 4200;
  const runtime = await startQuotationService(
    ['--demo', '--host', '127.0.0.1', '--port', '0', '--db', dbPath, '--base-url', 'http://127.0.0.1:11434/v1', '--model', 'mock-v4'],
    {
      env: { AGENT_SERVER_TOKEN: token, AGENT_OWNER_ID: 'owner_qa08' },
      stdout: noopOut,
      stderr: noopOut,
      connectServers: async () => ({ tools: {}, enabled: [], close: async () => {} }),
      createTurnOrchestrator: (opts) => createTurnOrchestrator({ ...opts, model }),
    },
  );

  try {
    const created = await createSessionHttp(runtime.origin, token, {
      usePersonalMaterials: false,
      metadata: {
        initialFacts,
        initialGraph,
        initialEvidence,
        contextBudget: {
          maxLocalNodes: 2,
          maxEvidence: 2,
          maxFacts: 2,
          recentTurnsLimit: 1,
          maxPromptChars: MAX_PROMPT_BUDGET,
        },
      },
    });
    assert.equal(created.status, 201);
    const sessionId = created.data.sessionId;

    // 第 1 轮先登记一条待分析句（使后续报价基于完整 200 对 = 分母 200 的图计算）
    const t1 = await submitTurnHttp(runtime.origin, token, sessionId, {
      clientRequestId: 'qa08-t1-init',
      baseGraphVersion: 0,
      text: '请结合早期记录 fact_bulk_003 评估排班制度在特殊班次下是否成立。',
    });

    assert.equal(capturedCalls.length, 1);
    const rawPromptPayload = serializePromptCall(capturedCalls[0]);
    const promptChars = (capturedCalls[0].prompt ?? [])
      .map((msg) => (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)))
      .join('\n').length;

    assert.ok(
      promptChars <= MAX_PROMPT_BUDGET + 200,
      `QA-08：实际模型输入总长（${promptChars} 字符）必须在预设紧凑预算内`,
    );
    assert.ok(
      rawPromptPayload.includes('fact_bulk_003') && rawPromptPayload.includes('TARGET_EARLY_MARKER_003'),
      'QA-08：模型请求必须包含显式引用的第 3 条早期事实',
    );
    // 其余 199 条无关合成标记绝不进入模型请求
    for (let i = 1; i <= 200; i += 1) {
      if (i === 3) continue;
      const pad = String(i).padStart(3, '0');
      assert.equal(
        rawPromptPayload.includes(`UNRELATED_BULK_MARKER_${pad}`),
        false,
        `无关标记 UNRELATED_BULK_MARKER_${pad} 不得进入模型请求`,
      );
    }

    // 会话快照仍完整保留全部 200 条事实，按 lookupId 可取回其他早期事实，且算价分母基于完整 400 节点图（承重分母 = 200）
    assert.equal(t1.session.facts.length, 200);
    assert.equal(t1.session.statements[0].quote.denominator, 200, '报价分母必须继续基于完整已确认图（200）');

    const lookup150 = await getSessionHttp(runtime.origin, token, sessionId, 'lookupId=fact_bulk_150');
    assert.equal(lookup150.status, 200);
    assert.equal(lookup150.data.retrievedItem?.id, 'fact_bulk_150');
  } finally {
    await runtime.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// QA-10
// ============================================================================
test('QA-10：40 对根叶节点冲突 23 个根通过 HTTP 编排得出 23/40 与 58% 且通过 quote-v1.schema.json 校验；非法理由候选被拒绝', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'qa10-http-'));
  const dbPath = path.join(tmpDir, 'qa10.sqlite');
  const token = 'qtn_qa10_secret_token_123456';
  const noopOut = { write() {} };
  const { model } = createCapturingModel();

  const fortyPairNodes = [];
  for (let i = 0; i < 40; i += 1) {
    fortyPairNodes.push(
      {
        id: `R_${i}`,
        kind: 'fact',
        text: `本人根前提节点 ${i}`,
        cluster: `c_${i}`,
        deps: [],
        attribution: 'self',
        evidenceIds: ['ev_seed_qa10'],
      },
      {
        id: `L_${i}`,
        kind: 'judgment',
        text: `受支撑叶节点 ${i}`,
        cluster: `c_${i}`,
        deps: [`R_${i}`],
        attribution: 'self',
        evidenceIds: ['ev_seed_qa10'],
      },
    );
  }

  const twentyThreeConflicts = Array.from({ length: 23 }, (_, i) => ({
    nodeId: `R_${i}`,
    evidenceIds: ['ev_seed_qa10'],
    reason: `与本人根前提 R_${i} 发生有据冲突`,
  }));

  const runtime = await startQuotationService(
    ['--demo', '--host', '127.0.0.1', '--port', '0', '--db', dbPath, '--base-url', 'http://127.0.0.1:11434/v1', '--model', 'mock-v4'],
    {
      env: { AGENT_SERVER_TOKEN: token, AGENT_OWNER_ID: 'owner_qa10' },
      stdout: noopOut,
      stderr: noopOut,
      connectServers: async () => ({ tools: {}, enabled: [], close: async () => {} }),
      createTurnOrchestrator: (opts) => createTurnOrchestrator({ ...opts, model }),
    },
  );

  try {
    const created = await createSessionHttp(runtime.origin, token, {
      usePersonalMaterials: false,
      metadata: {
        initialEvidence: [
          {
            id: 'ev_seed_qa10',
            evidenceId: 'ev_seed_qa10',
            sourceType: 'session_turn',
            author: 'self',
            attribution: 'self',
            turnId: 'turn_seed_0',
            excerpt: '本人在四十项独立实验记录中确认了根前提集合。',
          },
        ],
        initialGraph: fortyPairNodes,
        proposalsByRequestId: {
          'qa10-23-of-40': {
            directConflicts: twentyThreeConflicts,
          },
          'qa10-invalid-empty-reason': {
            directConflicts: twentyThreeConflicts,
            conflictReasons: [{}],
          },
          'qa10-invalid-string-evids': {
            directConflicts: twentyThreeConflicts,
            conflictReasons: [{ nodeId: 'R_0', reason: '理由非空', evidenceIds: 'ev_seed_qa10' }],
          },
        },
      },
    });
    assert.equal(created.status, 201);
    const sessionId = created.data.sessionId;

    // 1) 23 / 40 = 57.5% -> Math.round((100 * 23) / 40) = 58%
    const validTurn = await submitTurnHttp(runtime.origin, token, sessionId, {
      clientRequestId: 'qa10-23-of-40',
      baseGraphVersion: 0,
      text: '所有实验环节在任何条件下都不会触发前二十三项根前提。',
    });

    const sseQuote = validTurn.committed.activeQuote;
    const snapQuote = validTurn.session.statements[0].quote;
    assert.equal(sseQuote.numerator, 23);
    assert.equal(sseQuote.denominator, 40);
    assert.equal(sseQuote.rate, 58, 'QA-10：23/40 必须舍入为 58% 而非 57%');
    assert.equal(snapQuote.numerator, 23);
    assert.equal(snapQuote.denominator, 40);
    assert.equal(snapQuote.rate, 58);
    assert.equal(sseQuote.graphVersion, snapQuote.graphVersion);

    assertValidQuoteV1(sseQuote);
    assertValidQuoteV1(snapQuote);

    // 2) 非法空对象理由 conflictReasons: [{}] 被拒绝
    const badReasonTurn1 = await submitTurnHttp(
      runtime.origin,
      token,
      sessionId,
      {
        clientRequestId: 'qa10-invalid-empty-reason',
        baseGraphVersion: validTurn.session.graphVersion,
        text: '测试非法空对象理由候选',
      },
      { expectCommitted: false },
    );
    assert.equal(badReasonTurn1.committed, null);
    assert.equal(
      badReasonTurn1.failed?.code ?? badReasonTurn1.failed?.error?.code,
      'VERIFICATION_REJECTED',
    );

    // 3) 非法字符串形式 evidenceIds 被拒绝
    const badReasonTurn2 = await submitTurnHttp(
      runtime.origin,
      token,
      sessionId,
      {
        clientRequestId: 'qa10-invalid-string-evids',
        baseGraphVersion: validTurn.session.graphVersion,
        text: '测试非法字符串 evidenceIds 候选',
      },
      { expectCommitted: false },
    );
    assert.equal(badReasonTurn2.committed, null);
    assert.equal(
      badReasonTurn2.failed?.code ?? badReasonTurn2.failed?.error?.code,
      'VERIFICATION_REJECTED',
    );
  } finally {
    await runtime.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
