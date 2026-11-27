// `/v1` HTTP/SSE 同源服务、多主体隔离、流式传输与取消/重连竞态集成测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { BackendServiceError, PROTOCOL_VERSION } from '../protocol.mjs';
import {
  cancelTurnBodySchema,
  createSessionBodySchema,
  createTurnBodySchema,
  parseContract,
  parseLastEventId,
} from '../http-contracts.mjs';
import { createPrincipalAuth, createQuotationServer } from '../server.mjs';
import { resolveDefaultDbPath, startQuotationService } from '../serve-cli.mjs';
import { createTurnOrchestrator } from '../turn-orchestrator.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const HTTP_API_SCHEMA_PATH = path.resolve(TEST_DIR, '../schemas/http-api-v1.schema.json');
const HTTP_API_SCHEMA = JSON.parse(readFileSync(HTTP_API_SCHEMA_PATH, 'utf8'));

// Draft 2020-12 JSON Schema 校验器：精确校验 $ref、oneOf 唯一分支计数、anyOf、allOf、not、const、enum、required、additionalProperties、type、minimum、items。
function resolveJsonPointer(rootSchema, ref) {
  assert.equal(typeof ref, 'string');
  assert.equal(ref.startsWith('#/'), true, `仅支持文档内 JSON Pointer 引用：${ref}`);
  const segments = ref
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current = rootSchema;
  for (const seg of segments) {
    assert.equal(
      current !== null && typeof current === 'object' && seg in current,
      true,
      `Schema $ref 未找到路径：${ref}`,
    );
    current = current[seg];
  }
  return current;
}

function matchesSchemaType(value, expectedType) {
  if (expectedType === 'null') return value === null;
  if (expectedType === 'boolean') return typeof value === 'boolean';
  if (expectedType === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (expectedType === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expectedType === 'string') return typeof value === 'string';
  if (expectedType === 'array') return Array.isArray(value);
  if (expectedType === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  return false;
}

function deepEqualJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validateDraft202012Node(rootSchema, schemaNode, value, instancePath = '$') {
  const errors = [];
  if (typeof schemaNode === 'boolean') {
    if (!schemaNode) errors.push(`${instancePath}: boolean false schema 拒绝任意值`);
    return errors;
  }
  if (!schemaNode || typeof schemaNode !== 'object') {
    return errors;
  }

  // Draft 2020-12 支持 $ref 与同级关键字并存校验
  if (typeof schemaNode.$ref === 'string') {
    const target = resolveJsonPointer(rootSchema, schemaNode.$ref);
    errors.push(...validateDraft202012Node(rootSchema, target, value, instancePath));
  }

  if ('const' in schemaNode) {
    if (!deepEqualJson(value, schemaNode.const)) {
      errors.push(`${instancePath}: 期望 const=${JSON.stringify(schemaNode.const)}，实际=${JSON.stringify(value)}`);
    }
  }

  if (Array.isArray(schemaNode.enum)) {
    const hit = schemaNode.enum.some((candidate) => deepEqualJson(value, candidate));
    if (!hit) {
      errors.push(`${instancePath}: 值 ${JSON.stringify(value)} 不在 enum ${JSON.stringify(schemaNode.enum)} 中`);
    }
  }

  if (schemaNode.type !== undefined) {
    const allowedTypes = Array.isArray(schemaNode.type) ? schemaNode.type : [schemaNode.type];
    const okType = allowedTypes.some((t) => matchesSchemaType(value, t));
    if (!okType) {
      errors.push(`${instancePath}: 类型不匹配，期望 ${JSON.stringify(allowedTypes)}，实际值=${JSON.stringify(value)}`);
      return errors;
    }
  }

  if (typeof value === 'number') {
    if (typeof schemaNode.minimum === 'number' && value < schemaNode.minimum) {
      errors.push(`${instancePath}: 数值 ${value} 小于 minimum ${schemaNode.minimum}`);
    }
    if (typeof schemaNode.maximum === 'number' && value > schemaNode.maximum) {
      errors.push(`${instancePath}: 数值 ${value} 大于 maximum ${schemaNode.maximum}`);
    }
  }

  if (Array.isArray(value) && schemaNode.items) {
    for (let i = 0; i < value.length; i += 1) {
      errors.push(...validateDraft202012Node(rootSchema, schemaNode.items, value[i], `${instancePath}[${i}]`));
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if (Array.isArray(schemaNode.required)) {
      for (const reqKey of schemaNode.required) {
        if (!Object.hasOwn(value, reqKey)) {
          errors.push(`${instancePath}: 缺少必需字段 "${reqKey}"`);
        }
      }
    }

    const props = schemaNode.properties && typeof schemaNode.properties === 'object'
      ? schemaNode.properties
      : {};
    for (const [propKey, propVal] of Object.entries(value)) {
      if (Object.hasOwn(props, propKey)) {
        errors.push(...validateDraft202012Node(rootSchema, props[propKey], propVal, `${instancePath}.${propKey}`));
      } else if (schemaNode.additionalProperties === false) {
        errors.push(`${instancePath}: 不允许未定义的额外字段 "${propKey}"`);
      } else if (schemaNode.additionalProperties && typeof schemaNode.additionalProperties === 'object') {
        errors.push(
          ...validateDraft202012Node(rootSchema, schemaNode.additionalProperties, propVal, `${instancePath}.${propKey}`),
        );
      }
    }
  }

  if (schemaNode.not !== undefined) {
    const notErrors = validateDraft202012Node(rootSchema, schemaNode.not, value, instancePath);
    if (notErrors.length === 0) {
      errors.push(`${instancePath}: 违反 not 约束 (${JSON.stringify(schemaNode.not)})`);
    }
  }

  if (Array.isArray(schemaNode.allOf)) {
    schemaNode.allOf.forEach((sub, idx) => {
      errors.push(...validateDraft202012Node(rootSchema, sub, value, `${instancePath}<allOf:${idx}>`));
    });
  }

  if (Array.isArray(schemaNode.anyOf)) {
    const anyPassed = schemaNode.anyOf.some(
      (sub) => validateDraft202012Node(rootSchema, sub, value, instancePath).length === 0,
    );
    if (!anyPassed) {
      errors.push(`${instancePath}: 未命中 anyOf 任一分支`);
    }
  }

  if (Array.isArray(schemaNode.oneOf)) {
    const matchedBranches = [];
    schemaNode.oneOf.forEach((sub, idx) => {
      const subErrs = validateDraft202012Node(rootSchema, sub, value, instancePath);
      if (subErrs.length === 0) {
        matchedBranches.push(sub.$ref ?? sub.type ?? `branch_${idx}`);
      }
    });
    if (matchedBranches.length !== 1) {
      errors.push(
        `${instancePath}: oneOf 必须严格命中唯一 1 个分支，实际命中 ${matchedBranches.length} 个 (${JSON.stringify(matchedBranches)})`,
      );
    }
  }

  return errors;
}

function assertMatchesHttpApiSchema(payload, expectedDataBranch = null) {
  assert.equal(HTTP_API_SCHEMA.$schema, 'https://json-schema.org/draft/2020-12/schema');
  const dataOneOf = HTTP_API_SCHEMA.properties.data.oneOf;
  const matchedDataBranches = dataOneOf
    .filter((sub) => validateDraft202012Node(HTTP_API_SCHEMA, sub, payload.data, '$.data').length === 0)
    .map((sub) => sub.$ref ?? sub.type);

  if (expectedDataBranch !== null && matchedDataBranches.length === 0) {
    const targetBranch = dataOneOf.find((sub) => (sub.$ref ?? sub.type) === expectedDataBranch);
    const branchDiag = targetBranch
      ? validateDraft202012Node(HTTP_API_SCHEMA, targetBranch, payload.data, '$.data').join('\n')
      : '';
    assert.fail(`$.data 未命中期望分支 ${expectedDataBranch}：\n${branchDiag}`);
  }

  const errors = validateDraft202012Node(HTTP_API_SCHEMA, HTTP_API_SCHEMA, payload, '$');
  assert.deepEqual(errors, [], `HTTP 响应违反 http-api-v1.schema.json：\n${errors.join('\n')}`);

  assert.equal(
    matchedDataBranches.length,
    1,
    `data.oneOf 必须且只能命中 1 个分支，实际命中：${JSON.stringify(matchedDataBranches)}`,
  );
  if (expectedDataBranch !== null) {
    assert.equal(matchedDataBranches[0], expectedDataBranch);
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// 符合后端会话存储契约的内存级事务桩：精确模拟版本锁、单并发写锁、clientRequestId 幂等与事件序列。
function createContractMemoryStore({ dataMode = 'demo' } = {}) {
  const sessions = new Map();
  const listeners = new Map(); // `${sessionId}:${turnId}` -> Set<fn>
  let closed = false;

  function listenerKey(sessionId, turnId) {
    return `${sessionId}:${turnId}`;
  }

  function requireOwnedSession(ownerId, sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new BackendServiceError('SESSION_NOT_FOUND', '会话不存在。', 404);
    }
    if (session.ownerId !== ownerId) {
      throw new BackendServiceError('SESSION_FORBIDDEN', '无权访问其他授权主体的会话。', 403);
    }
    return session;
  }

  function requireTurn(session, turnId) {
    const turn = session.turns.get(turnId);
    if (!turn) {
      throw new BackendServiceError('TURN_NOT_FOUND', '轮次不存在。', 404);
    }
    return turn;
  }

  function appendEvent(session, turn, eventType, payload) {
    turn.seqCounter += 1;
    const event = {
      seq: turn.seqCounter,
      eventType,
      payload,
      createdAt: new Date().toISOString(),
    };
    turn.events.push(event);
    const subs = listeners.get(listenerKey(session.sessionId, turn.turnId));
    if (subs) {
      for (const fn of [...subs]) {
        fn(event);
      }
    }
    return event;
  }

  return {
    dataMode,
    isClosed: () => closed,
    async close() {
      closed = true;
    },
    createSession(ownerId, options = {}) {
      const sessionId = `ses_${randomUUID()}`;
      const record = {
        sessionId,
        ownerId,
        dataMode: options.dataMode ?? dataMode,
        graphVersion: 0,
        usePersonalMaterials: typeof options.usePersonalMaterials === 'boolean'
          ? options.usePersonalMaterials
          : true,
        lockedSnapshotId: options.lockedSnapshotId ?? null,
        materialsStatus: options.materialsStatus ?? null,
        outboundPreview: options.outboundPreview ?? null,
        cloudConsent: options.cloudConsent ?? false,
        metadata: options.metadata ?? {},
        currentFocus: null,
        confirmedGraph: Array.isArray(options.initialGraph) ? [...options.initialGraph] : [],
        pendingConfirmations: [],
        deniedAttributions: [],
        pendingItems: [],
        evidences: [...(options.evidences ?? [])],
        statements: [],
        quotation: null,
        facts: new Map([
          ['fact-seed-1', { id: 'fact-seed-1', kind: 'fact', claim: '刚开始使用时发现过新乐队', ownerId }],
        ]),
        turns: new Map(),
        clientRequests: new Map(),
        activeTurnId: null,
      };
      sessions.set(sessionId, record);
      return {
        sessionId,
        ownerId,
        graphVersion: 0,
        dataMode: record.dataMode,
        usePersonalMaterials: record.usePersonalMaterials,
        lockedSnapshotId: record.lockedSnapshotId,
        materialsStatus: record.materialsStatus,
        outboundPreview: record.outboundPreview,
      };
    },
    getSession(ownerId, sessionId) {
      const s = requireOwnedSession(ownerId, sessionId);
      return {
        sessionId: s.sessionId,
        ownerId: s.ownerId,
        dataMode: s.dataMode,
        graphVersion: s.graphVersion,
        usePersonalMaterials: s.usePersonalMaterials,
        lockedSnapshotId: s.lockedSnapshotId,
        materialsStatus: s.materialsStatus,
        outboundPreview: s.outboundPreview,
        metadata: s.metadata,
        cloudConsent: s.cloudConsent,
        currentFocus: s.currentFocus,
        confirmedGraph: s.confirmedGraph,
        pendingConfirmations: s.pendingConfirmations,
        deniedAttributions: s.deniedAttributions,
        facts: [...s.facts.values()],
        evidenceIndex: s.evidences,
        pendingItems: s.pendingItems,
        evidences: s.evidences,
        statements: s.statements,
        quotation: s.quotation,
        turns: [...s.turns.values()].map((t) => ({
          turnId: t.turnId,
          turnNumber: t.turnNumber,
          status: t.status,
          baseGraphVersion: t.baseGraphVersion,
          committedGraphVersion: t.committedGraphVersion,
        })),
      };
    },
    getTurn(ownerId, sessionId, turnId) {
      const s = requireOwnedSession(ownerId, sessionId);
      const t = requireTurn(s, turnId);
      return {
        turnId: t.turnId,
        turnNumber: t.turnNumber,
        status: t.status,
        baseGraphVersion: t.baseGraphVersion,
        committedGraphVersion: t.committedGraphVersion,
      };
    },
    getFactOrTurnById(ownerId, sessionId, lookupId) {
      const s = requireOwnedSession(ownerId, sessionId);
      if (s.facts.has(lookupId)) return s.facts.get(lookupId);
      if (s.turns.has(lookupId)) {
        const t = s.turns.get(lookupId);
        return { id: t.turnId, kind: 'turn', turnNumber: t.turnNumber, text: t.text, status: t.status };
      }
      return null;
    },
    beginTurn(ownerId, sessionId, input) {
      const s = requireOwnedSession(ownerId, sessionId);
      const fingerprint = JSON.stringify({
        baseGraphVersion: input.baseGraphVersion,
        text: input.text,
        focusRef: input.focusRef ?? null,
        action: input.action ?? null,
      });

      const existing = s.clientRequests.get(input.clientRequestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new BackendServiceError(
            'CLIENT_REQUEST_ID_CONFLICT',
            '同一 clientRequestId 不能用于不同请求内容。',
            409,
          );
        }
        const reusedTurn = s.turns.get(existing.turnId);
        return { reused: true, turn: { ...reusedTurn } };
      }

      if (s.activeTurnId !== null) {
        throw new BackendServiceError(
          'TURN_IN_PROGRESS',
          '当前会话已有正在执行的写入轮次，请等待完成或先取消。',
          409,
        );
      }

      if (input.baseGraphVersion !== s.graphVersion) {
        throw new BackendServiceError(
          'STALE_GRAPH_VERSION',
          `基准图版本已过期（当前版本 ${s.graphVersion}，请求版本 ${input.baseGraphVersion}）。`,
          409,
        );
      }

      const turnId = `turn_${s.turns.size + 1}_${randomUUID().slice(0, 8)}`;
      const turn = {
        turnId,
        turnNumber: s.turns.size + 1,
        clientRequestId: input.clientRequestId,
        baseGraphVersion: input.baseGraphVersion,
        committedGraphVersion: null,
        text: input.text,
        status: 'running',
        seqCounter: 0,
        events: [],
      };
      s.turns.set(turnId, turn);
      s.clientRequests.set(input.clientRequestId, { turnId, fingerprint });
      s.activeTurnId = turnId;
      return { reused: false, turn: { ...turn } };
    },
    emitTurnEvent(ownerId, sessionId, turnId, eventType, payload) {
      const s = requireOwnedSession(ownerId, sessionId);
      const t = requireTurn(s, turnId);
      if (t.status !== 'running') return null;
      return appendEvent(s, t, eventType, payload);
    },
    commitTurn(ownerId, sessionId, turnId, { incrementGraph = true, focus = null, quotation = null, summary = '' } = {}) {
      const s = requireOwnedSession(ownerId, sessionId);
      const t = requireTurn(s, turnId);
      if (t.status !== 'running') {
        return { outcome: t.status, status: t.status, graphVersion: s.graphVersion };
      }
      if (incrementGraph) {
        s.graphVersion += 1;
      }
      if (focus) s.currentFocus = focus;
      if (quotation) s.quotation = quotation;
      t.status = 'committed';
      t.committedGraphVersion = s.graphVersion;
      if (s.activeTurnId === turnId) s.activeTurnId = null;

      appendEvent(s, t, 'turn.committed', {
        turnId,
        graphVersion: s.graphVersion,
        focus: s.currentFocus,
        quotation: s.quotation,
        summary,
      });
      appendEvent(s, t, 'turn.done', {
        turnId,
        status: 'committed',
        graphVersion: s.graphVersion,
      });
      return { outcome: 'committed', status: 'committed', graphVersion: s.graphVersion };
    },
    cancelTurn(ownerId, sessionId, turnId, { reason = '用户主动停止' } = {}) {
      const s = requireOwnedSession(ownerId, sessionId);
      const t = requireTurn(s, turnId);
      // 取消与提交竞态由持久化状态决定：若已 committed，直接返回实际已提交状态。
      if (t.status !== 'running') {
        return {
          outcome: t.status,
          status: t.status,
          graphVersion: s.graphVersion,
        };
      }
      t.status = 'cancelled';
      if (s.activeTurnId === turnId) s.activeTurnId = null;
      appendEvent(s, t, 'turn.cancelled', {
        turnId,
        reason,
        preservedGraphVersion: s.graphVersion,
      });
      appendEvent(s, t, 'turn.done', {
        turnId,
        status: 'cancelled',
        graphVersion: s.graphVersion,
      });
      return {
        outcome: 'cancelled',
        status: 'cancelled',
        graphVersion: s.graphVersion,
      };
    },
    failTurn(ownerId, sessionId, turnId, { code = 'INTERNAL_ERROR', message = '轮次失败' } = {}) {
      const s = requireOwnedSession(ownerId, sessionId);
      const t = requireTurn(s, turnId);
      if (t.status !== 'running') return;
      t.status = 'failed';
      if (s.activeTurnId === turnId) s.activeTurnId = null;
      appendEvent(s, t, 'turn.failed', { turnId, code, message, preservedGraphVersion: s.graphVersion });
      appendEvent(s, t, 'turn.done', { turnId, status: 'failed', graphVersion: s.graphVersion });
    },
    subscribeTurnEvents(sessionId, turnId, listener) {
      const key = listenerKey(sessionId, turnId);
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(key);
      };
    },
    listTurnEvents(ownerId, sessionId, turnId, { afterSeq = 0 } = {}) {
      const s = requireOwnedSession(ownerId, sessionId);
      const t = requireTurn(s, turnId);
      return t.events.filter((ev) => ev.seq > afterSeq);
    },
  };
}

async function listenRandomPort(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  return `http://127.0.0.1:${addr.port}`;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
  });
}

// 增量式真实 HTTP SSE 读取器：通过 fetch response.body.getReader() 逐帧解析事件。
async function openSseStream(url, { headers = {}, signal } = {}) {
  const response = await fetch(url, { headers, signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/i);
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pendingFrames = [];
  let streamDone = false;

  function extractFrames() {
    let sepIndex;
    while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
      const rawBlock = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      if (!rawBlock.trim() || rawBlock.startsWith(':')) continue;
      let id = null;
      let event = 'message';
      const dataLines = [];
      for (const line of rawBlock.split('\n')) {
        if (line.startsWith('id:')) id = Number(line.slice(3).trim());
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      pendingFrames.push({
        id,
        event,
        data: dataLines.length > 0 ? JSON.parse(dataLines.join('\n')) : null,
      });
    }
  }

  return {
    response,
    pendingCount: () => pendingFrames.length,
    async nextEvent() {
      while (pendingFrames.length === 0 && !streamDone) {
        const { value, done } = await reader.read();
        if (done) {
          streamDone = true;
          buffer += decoder.decode();
          extractFrames();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        extractFrames();
      }
      return pendingFrames.shift() ?? null;
    },
    async readAll() {
      const all = [];
      let item;
      while ((item = await this.nextEvent()) !== null) {
        all.push(item);
      }
      return all;
    },
    async cancel() {
      try {
        await reader.cancel();
      } catch {
        // 忽略客户端主动断开读取取消异常
      }
    },
  };
}

const TOKEN_A = 'tok_user_alpha_secret_1234567890';
const TOKEN_B = 'tok_user_bravo_secret_0987654321';
const MODEL_SECRET = 'sk-secret-model-credential-999999';

test('http-contracts.mjs：严格校验未知字段、合法载荷与 Last-Event-ID 边界', () => {
  const validSession = parseContract(createSessionBodySchema, {
    dataMode: 'demo',
    initialText: '  推荐算法只会让人的兴趣越来越窄  ',
    initialGraph: [{ id: 'n_root_1', text: '测试根节点', deps: [] }],
  });
  assert.equal(validSession.initialText, '推荐算法只会让人的兴趣越来越窄');
  assert.equal(validSession.initialGraph.length, 1);

  const validTurnWithProposal = parseContract(createTurnBodySchema, {
    clientRequestId: 'req-prop-1',
    baseGraphVersion: 0,
    text: '结构化核验候选提交',
    action: {
      type: 'retract_fact',
      factId: 'fact_turn_4',
      proposal: { directConflicts: ['n_root_1'] },
    },
  });
  assert.equal(validTurnWithProposal.action.factId, 'fact_turn_4');
  assert.deepEqual(validTurnWithProposal.action.proposal, { directConflicts: ['n_root_1'] });

  assert.throws(
    () => parseContract(createTurnBodySchema, {
      clientRequestId: 'req-bad-action',
      baseGraphVersion: 0,
      text: '未知动作字段校验',
      action: { type: 'retract_fact', unexpectedKey: true },
    }),
    (err) => err instanceof BackendServiceError && err.code === 'INVALID_ARGUMENTS' && err.status === 400,
  );

  assert.throws(
    () => parseContract(createSessionBodySchema, { unknownField: 1 }),
    (err) => err instanceof BackendServiceError && err.code === 'INVALID_ARGUMENTS' && err.status === 400,
  );

  assert.throws(
    () => parseContract(createTurnBodySchema, {
      clientRequestId: 'req-1',
      baseGraphVersion: 0,
      text: '测试句子',
      focusRef: { startOffset: 5, endOffset: 3 },
    }),
    (err) => err instanceof BackendServiceError && err.code === 'INVALID_ARGUMENTS',
  );

  assert.equal(parseContract(cancelTurnBodySchema, undefined), undefined);
  assert.deepEqual(parseContract(cancelTurnBodySchema, { reason: '  主动停止  ' }), { reason: '主动停止' });

  assert.equal(parseLastEventId(undefined), 0);
  assert.equal(parseLastEventId('3'), 3);
  for (const invalid of ['0', '-1', '1.5', 'abc', '']) {
    assert.throws(
      () => parseLastEventId(invalid),
      (err) => err instanceof BackendServiceError && err.code === 'INVALID_ARGUMENTS' && err.status === 400,
      `Last-Event-ID=${invalid}`,
    );
  }
});

test('同源/Host 防护、动态端口 0 识别、/health 与隐私安全日志脱敏', async (t) => {
  const store = createContractMemoryStore({ dataMode: 'demo' });
  const auth = createPrincipalAuth({
    tokens: [{ token: TOKEN_A, ownerId: 'user-a', dataMode: 'demo' }],
  });
  const logs = [];
  const server = createQuotationServer({
    store,
    auth,
    dataMode: 'demo',
    secrets: [MODEL_SECRET],
    logger: (entry) => logs.push(entry),
  });
  t.after(() => closeServer(server));

  const baseUrl = await listenRandomPort(server);

  // 1. /health 无需鉴权且不暴露敏感信息
  const healthRes = await fetch(`${baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.headers.get('cache-control'), 'no-store');
  assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
  const healthBody = await healthRes.json();
  assert.equal(healthBody.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(healthBody.data, { service: 'quotation-agent-backend', dataMode: 'demo' });

  // 2. 同源 OPTIONS 预检通过，异源 Origin 被 403 ORIGIN_DENIED 拒绝
  const preflightOk = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'OPTIONS',
    headers: { Origin: baseUrl },
  });
  assert.equal(preflightOk.status, 204);
  assert.equal(preflightOk.headers.get('access-control-allow-origin'), baseUrl);

  const badOriginRes = await fetch(`${baseUrl}/health`, {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(badOriginRes.status, 403);
  assert.equal((await badOriginRes.json()).error.code, 'ORIGIN_DENIED');

  // 3. 显式固定不同端口时拒绝不匹配的 Host 头（403 HOST_DENIED）
  const fixedOriginServer = createQuotationServer({
    store,
    auth,
    dataMode: 'demo',
    publicOrigin: 'http://127.0.0.1:65530',
  });
  t.after(() => closeServer(fixedOriginServer));
  const mismatchUrl = await listenRandomPort(fixedOriginServer);
  const badHostRes = await fetch(`${mismatchUrl}/health`);
  assert.equal(badHostRes.status, 403);
  assert.equal((await badHostRes.json()).error.code, 'HOST_DENIED');

  // 4. 创建含敏感原文的会话，断言运行日志只含结构化指标，绝不泄露原文或 Bearer token
  const secretUserSentence = '这是绝不能写入运行日志的本人私密原句内容';
  const createRes = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN_A}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ initialText: secretUserSentence }),
  });
  assert.equal(createRes.status, 201);

  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedLogs.includes(secretUserSentence), false);
  assert.equal(serializedLogs.includes(TOKEN_A), false);
  for (const logItem of logs) {
    assert.deepEqual(
      Object.keys(logItem).sort(),
      ['errorCode', 'latencyMs', 'method', 'route', 'status'],
    );
  }
});

test('分段流式硬核检验：第二段解锁前真实 HTTP 客户端已收到 turn.started、focus.selected 与首段 text.delta', async (t) => {
  const store = createContractMemoryStore({ dataMode: 'demo' });
  const auth = createPrincipalAuth({
    tokens: [{ token: TOKEN_A, ownerId: 'user-a', dataMode: 'demo' }],
  });

  const firstChunkSent = createDeferred();
  const unlockSecondChunk = createDeferred();

  const orchestrator = {
    async executeTurn({ ownerId, sessionId, turnId, text }) {
      store.emitTurnEvent(ownerId, sessionId, turnId, 'turn.started', { turnId });
      store.emitTurnEvent(ownerId, sessionId, turnId, 'focus.selected', {
        kind: 'quantifier',
        spanText: '只会',
        reason: '全称排他量词决定反例敏感度',
      });
      store.emitTurnEvent(ownerId, sessionId, turnId, 'stage.changed', { stage: 'verifying_evidence' });
      store.emitTurnEvent(ownerId, sessionId, turnId, 'text.delta', {
        delta: `第一段流式解释：正在核对「${text.slice(0, 4)}」中的量词（密钥脱敏检验：${MODEL_SECRET}）。`,
      });
      firstChunkSent.resolve();

      // 阻塞等待测试显式放行第二段！
      await unlockSecondChunk.promise;

      store.emitTurnEvent(ownerId, sessionId, turnId, 'text.delta', {
        delta: '第二段流式解释：已完成核验并更新局部影响。',
      });
      store.commitTurn(ownerId, sessionId, turnId, {
        incrementGraph: true,
        focus: { kind: 'quantifier', spanText: '只会' },
        quotation: { assessment: 'conflict', rate: 25, numerator: 1, denominator: 4 },
        summary: '发现直接反例',
      });
    },
  };

  const server = createQuotationServer({
    store,
    orchestrator,
    auth,
    dataMode: 'demo',
    secrets: [MODEL_SECRET],
  });
  t.after(() => closeServer(server));
  const baseUrl = await listenRandomPort(server);

  const sesRes = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(sesRes.status, 201);
  const { sessionId } = (await sesRes.json()).data;

  const turnRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'req-stream-1',
      baseGraphVersion: 0,
      text: '推荐算法只会让人的兴趣越来越窄',
    }),
  });
  assert.equal(turnRes.status, 202);
  const turnBody = (await turnRes.json()).data;
  assert.equal(turnBody.reused, false);

  const sse = await openSseStream(`${baseUrl}${turnBody.eventsUrl}`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });

  await firstChunkSent.promise;

  // 在第二段尚未解锁时，通过真实网络流逐帧读取前 4 个事件！
  const earlyEvents = [
    await sse.nextEvent(),
    await sse.nextEvent(),
    await sse.nextEvent(),
    await sse.nextEvent(),
  ];

  assert.deepEqual(
    earlyEvents.map((ev) => [ev.id, ev.event]),
    [
      [1, 'turn.started'],
      [2, 'focus.selected'],
      [3, 'stage.changed'],
      [4, 'text.delta'],
    ],
  );
  assert.match(earlyEvents[3].data.delta, /^第一段流式解释/);
  // 校验 SSE 流上的自动密钥脱敏兜底
  assert.equal(JSON.stringify(earlyEvents[3]).includes(MODEL_SECRET), false);
  assert.equal(JSON.stringify(earlyEvents[3]).includes('[已隐藏]'), true);

  // 确认解锁前会话尚未提交，仍保持 graphVersion = 0
  const midSnapRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  assert.equal((await midSnapRes.json()).data.graphVersion, 0);

  // 解锁第二段，收齐剩余事件并验证流正常结束
  unlockSecondChunk.resolve();
  const restEvents = await sse.readAll();

  assert.deepEqual(
    restEvents.map((ev) => [ev.id, ev.event]),
    [
      [5, 'text.delta'],
      [6, 'turn.committed'],
      [7, 'turn.done'],
    ],
  );
  assert.equal(restEvents[1].data.graphVersion, 1);
  assert.equal(restEvents[1].data.quotation.rate, 25);
});

test('Last-Event-ID 断线续读：读到第 3 个事件主动断开连接不中止后台轮次，重连精确补齐 4..N 无重复无遗漏', async (t) => {
  const store = createContractMemoryStore({ dataMode: 'demo' });
  const auth = createPrincipalAuth({
    tokens: [{ token: TOKEN_A, ownerId: 'user-a', dataMode: 'demo' }],
  });

  const allowFinishAfterDisconnect = createDeferred();
  const backgroundFinished = createDeferred();
  let signalAbortedOnDisconnect = false;

  const orchestrator = {
    async executeTurn({ ownerId, sessionId, turnId, signal }) {
      store.emitTurnEvent(ownerId, sessionId, turnId, 'turn.started', { turnId });
      store.emitTurnEvent(ownerId, sessionId, turnId, 'focus.selected', { kind: 'scope', spanText: '越来越窄' });
      store.emitTurnEvent(ownerId, sessionId, turnId, 'text.delta', { delta: '片段一' });

      await allowFinishAfterDisconnect.promise;
      signalAbortedOnDisconnect = signal.aborted;

      store.emitTurnEvent(ownerId, sessionId, turnId, 'evidence.verified', { evidenceId: 'ev-1', attribution: 'other_author' });
      store.emitTurnEvent(ownerId, sessionId, turnId, 'text.delta', { delta: '片段二' });
      store.commitTurn(ownerId, sessionId, turnId, { incrementGraph: true });
      backgroundFinished.resolve();
    },
  };

  const server = createQuotationServer({ store, orchestrator, auth, dataMode: 'demo' });
  t.after(() => closeServer(server));
  const baseUrl = await listenRandomPort(server);

  const { sessionId } = (await (await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: '{}',
  })).json()).data;

  const { eventsUrl } = (await (await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientRequestId: 'req-reconnect-1', baseGraphVersion: 0, text: '测试断线续传' }),
  })).json()).data;

  const abortConn = new AbortController();
  const firstSse = await openSseStream(`${baseUrl}${eventsUrl}`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
    signal: abortConn.signal,
  });

  const firstThree = [
    await firstSse.nextEvent(),
    await firstSse.nextEvent(),
    await firstSse.nextEvent(),
  ];
  assert.deepEqual(firstThree.map((e) => e.id), [1, 2, 3]);

  // 主动断开第一个 HTTP SSE 连接！
  abortConn.abort();
  await firstSse.cancel();

  // 放行后台轮次继续执行至 committed，断言断线绝不会触发取消信号！
  allowFinishAfterDisconnect.resolve();
  await backgroundFinished.promise;
  assert.equal(signalAbortedOnDisconnect, false);

  const snapAfterDisconnect = (await (await fetch(`${baseUrl}/v1/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  })).json()).data;
  assert.equal(snapAfterDisconnect.graphVersion, 1);
  assert.equal(snapAfterDisconnect.turns[0].status, 'committed');

  // 带 Last-Event-ID: 3 重新连接，必须精确收到 4..7 且正常结束
  const resumedSse = await openSseStream(`${baseUrl}${eventsUrl}`, {
    headers: {
      Authorization: `Bearer ${TOKEN_A}`,
      'Last-Event-ID': '3',
    },
  });
  const resumedEvents = await resumedSse.readAll();
  assert.deepEqual(
    resumedEvents.map((e) => [e.id, e.event]),
    [
      [4, 'evidence.verified'],
      [5, 'text.delta'],
      [6, 'turn.committed'],
      [7, 'turn.done'],
    ],
  );

  // 订阅不存在的 turnId 返回 404 TURN_NOT_FOUND
  const missingTurnRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns/turn_nonexistent/events`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  assert.equal(missingTurnRes.status, 404);
  assert.equal((await missingTurnRes.json()).error.code, 'TURN_NOT_FOUND');
});

test('后台编排器未捕获异常兜底：自动调用 store.failTurn 推送 turn.failed + turn.done，不触发进程崩溃', async (t) => {
  const store = createContractMemoryStore({ dataMode: 'demo' });
  const auth = createPrincipalAuth({
    tokens: [{ token: TOKEN_A, ownerId: 'user-a', dataMode: 'demo' }],
  });

  const orchestrator = {
    async executeTurn({ ownerId, sessionId, turnId }) {
      store.emitTurnEvent(ownerId, sessionId, turnId, 'turn.started', { turnId });
      throw new BackendServiceError('RATE_LIMITED', '上游公开检索达到频率限制。', 429);
    },
  };

  const server = createQuotationServer({ store, orchestrator, auth, dataMode: 'demo' });
  t.after(() => closeServer(server));
  const baseUrl = await listenRandomPort(server);

  const { sessionId } = (await (await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  })).json()).data;

  const { eventsUrl } = (await (await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientRequestId: 'req-fail-fallback', baseGraphVersion: 0, text: '触发限流异常' }),
  })).json()).data;

  const sse = await openSseStream(`${baseUrl}${eventsUrl}`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  const events = await sse.readAll();
  assert.deepEqual(
    events.map((e) => e.event),
    ['turn.started', 'turn.failed', 'turn.done'],
  );
  assert.equal(events[1].data.code, 'RATE_LIMITED');
});

test('提交前取消 vs 提交后取消竞态：提交前保留上一 graphVersion，提交后返回实际 committed', async (t) => {
  const store = createContractMemoryStore({ dataMode: 'demo' });
  const auth = createPrincipalAuth({
    tokens: [{ token: TOKEN_A, ownerId: 'user-a', dataMode: 'demo' }],
  });

  let mode = 'block_before_commit';
  const enteredRunning = createDeferred();
  let observedAbortSignal = false;

  const orchestrator = {
    async executeTurn({ ownerId, sessionId, turnId, signal }) {
      store.emitTurnEvent(ownerId, sessionId, turnId, 'turn.started', { turnId });
      if (mode === 'block_before_commit') {
        enteredRunning.resolve();
        await new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            observedAbortSignal = true;
            resolve();
          }, { once: true });
        });
        return;
      }
      store.commitTurn(ownerId, sessionId, turnId, { incrementGraph: true });
    },
  };

  const server = createQuotationServer({ store, orchestrator, auth, dataMode: 'demo' });
  t.after(() => closeServer(server));
  const baseUrl = await listenRandomPort(server);

  const { sessionId } = (await (await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  })).json()).data;

  // 1. 提交前取消
  const turn1 = (await (await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientRequestId: 'req-cancel-1', baseGraphVersion: 0, text: '待取消句子' }),
  })).json()).data;

  const sse1 = await openSseStream(`${baseUrl}${turn1.eventsUrl}`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  await enteredRunning.promise;

  const cancelRes1 = await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns/${turn1.turnId}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: '用户点击停止' }),
  });
  assert.equal(cancelRes1.status, 200);
  const cancelData1 = (await cancelRes1.json()).data;
  assert.equal(cancelData1.outcome, 'cancelled');
  assert.equal(cancelData1.status, 'cancelled');
  assert.equal(cancelData1.graphVersion, 0);
  assert.equal(observedAbortSignal, true);

  const events1 = await sse1.readAll();
  assert.deepEqual(
    events1.map((e) => e.event),
    ['turn.started', 'turn.cancelled', 'turn.done'],
  );

  const snapAfterCancel = (await (await fetch(`${baseUrl}/v1/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  })).json()).data;
  assert.equal(snapAfterCancel.graphVersion, 0);

  // 2. 提交后再发起取消（竞态：持久化已 committed 胜出）
  mode = 'commit_immediately';
  const turn2 = (await (await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientRequestId: 'req-commit-2', baseGraphVersion: 0, text: '立即提交句子' }),
  })).json()).data;

  const sse2 = await openSseStream(`${baseUrl}${turn2.eventsUrl}`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  await sse2.readAll();

  const cancelAfterCommitRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns/${turn2.turnId}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  assert.equal(cancelAfterCommitRes.status, 200);
  const cancelData2 = (await cancelAfterCommitRes.json()).data;
  assert.equal(cancelData2.outcome, 'committed');
  assert.equal(cancelData2.status, 'committed');
  assert.equal(cancelData2.graphVersion, 1);
});

test('重复请求幂等复用与并发/过期版本冲突：同键重试 200、换内容 409、双标签页并发 409、过期版本 409', async (t) => {
  const store = createContractMemoryStore({ dataMode: 'demo' });
  const auth = createPrincipalAuth({
    tokens: [{ token: TOKEN_A, ownerId: 'user-a', dataMode: 'demo' }],
  });

  const holdTurn = createDeferred();
  let executeCount = 0;

  const orchestrator = {
    async executeTurn({ ownerId, sessionId, turnId }) {
      executeCount += 1;
      store.emitTurnEvent(ownerId, sessionId, turnId, 'turn.started', { turnId });
      await holdTurn.promise;
      store.commitTurn(ownerId, sessionId, turnId, { incrementGraph: true });
    },
  };

  const server = createQuotationServer({ store, orchestrator, auth, dataMode: 'demo' });
  t.after(() => closeServer(server));
  const baseUrl = await listenRandomPort(server);

  const { sessionId } = (await (await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  })).json()).data;

  // 首次提交 -> 202
  const firstRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientRequestId: 'idem-key-1', baseGraphVersion: 0, text: '原句内容' }),
  });
  assert.equal(firstRes.status, 202);
  const firstTurn = (await firstRes.json()).data;

  // 相同 clientRequestId + 相同内容重试 -> 200 复用原轮次，不重复触发编排器
  const retryRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientRequestId: 'idem-key-1', baseGraphVersion: 0, text: '原句内容' }),
  });
  assert.equal(retryRes.status, 200);
  const retryTurn = (await retryRes.json()).data;
  assert.equal(retryTurn.reused, true);
  assert.equal(retryTurn.turnId, firstTurn.turnId);
  assert.equal(retryTurn.eventsUrl, firstTurn.eventsUrl);
  assert.equal(executeCount, 1);

  // 相同 clientRequestId 换内容 -> 409 CLIENT_REQUEST_ID_CONFLICT
  const conflictKeyRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientRequestId: 'idem-key-1', baseGraphVersion: 0, text: '篡改后的另一句话' }),
  });
  assert.equal(conflictKeyRes.status, 409);
  assert.equal((await conflictKeyRes.json()).error.code, 'CLIENT_REQUEST_ID_CONFLICT');

  // 第二个标签页并发写入新 clientRequestId -> 409 TURN_IN_PROGRESS
  const concurrentRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientRequestId: 'tab-2-req', baseGraphVersion: 0, text: '另一标签页并发输入' }),
  });
  assert.equal(concurrentRes.status, 409);
  assert.equal((await concurrentRes.json()).error.code, 'TURN_IN_PROGRESS');

  // 完成第 1 轮使 graphVersion 升至 1
  const sse = await openSseStream(`${baseUrl}${firstTurn.eventsUrl}`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  holdTurn.resolve();
  await sse.readAll();

  // 携带旧版本 baseGraphVersion: 0 再次写入 -> 409 STALE_GRAPH_VERSION
  const staleRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientRequestId: 'req-stale-version', baseGraphVersion: 0, text: '基于过期版本的修改' }),
  });
  assert.equal(staleRes.status, 409);
  assert.equal((await staleRes.json()).error.code, 'STALE_GRAPH_VERSION');
});

test('跨主体隔离、令牌立即吊销、demo/real 严禁混用、云推理授权校验与 lookupId 回溯', async (t) => {
  const store = createContractMemoryStore({ dataMode: 'demo' });
  const realModeToken = 'tok_user_real_mode_only_11112222';
  const auth = createPrincipalAuth({
    tokens: [
      { token: TOKEN_A, ownerId: 'user-a', dataMode: 'demo' },
      { token: TOKEN_B, ownerId: 'user-b', dataMode: 'demo' },
      { token: realModeToken, ownerId: 'user-real', dataMode: 'real' },
    ],
  });

  let loaderCallCount = 0;
  const materialLoader = {
    async loadMaterials({ snapshotId }) {
      loaderCallCount += 1;
      if (snapshotId === 'snap-real-leak') {
        return { snapshotId, source: 'zhihu_selected_data', evidences: [] };
      }
      return {
        snapshotId: snapshotId ?? 'snap-demo-locked-001',
        source: 'demo_history',
        evidences: [
          {
            evidenceId: 'ev-col-1',
            sourceType: 'collection_record',
            title: '通过推荐发现独立乐队的经历',
            author: '某答主',
            attribution: 'other_author',
            excerpt: '刚注册那段时间推荐流推过没听过的后摇乐队。',
          },
        ],
      };
    },
  };

  let orchestratorCallCount = 0;
  const orchestrator = {
    async executeTurn({ ownerId, sessionId, turnId }) {
      orchestratorCallCount += 1;
      store.emitTurnEvent(ownerId, sessionId, turnId, 'turn.started', { turnId });
      store.commitTurn(ownerId, sessionId, turnId, { incrementGraph: false });
    },
  };

  // 配置为远端云推理模型地址（https://api.cloud-llm.example/v1），检验 CLOUD_CONSENT_REQUIRED
  const server = createQuotationServer({
    store,
    orchestrator,
    auth,
    materialLoader,
    dataMode: 'demo',
    modelConfig: {
      providerName: 'openai-compatible',
      baseURL: 'https://api.cloud-llm.example/v1',
      modelName: 'cloud-reasoner',
    },
  });
  t.after(() => closeServer(server));
  const baseUrl = await listenRandomPort(server);

  // 1. 缺失或未知凭证 -> 401 UNAUTHORIZED
  const noAuthRes = await fetch(`${baseUrl}/v1/sessions`, { method: 'POST' });
  assert.equal(noAuthRes.status, 401);
  assert.equal((await noAuthRes.json()).error.code, 'UNAUTHORIZED');

  // 2. 云端模型未确认预览时先在本机生成实际非空预览清单并返回 403 CLOUD_CONSENT_REQUIRED（云模型/编排器调用为 0）
  const noCloudConsentRes = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ usePersonalMaterials: true }),
  });
  assert.equal(noCloudConsentRes.status, 403);
  const noCloudConsentJson = await noCloudConsentRes.json();
  assertMatchesHttpApiSchema(noCloudConsentJson, 'null');
  assert.equal(noCloudConsentJson.error.code, 'CLOUD_CONSENT_REQUIRED');
  const initialCloudPreview = noCloudConsentJson.error.details?.outboundPreview;
  assert.ok(initialCloudPreview?.outboundPreviewId);
  assert.equal(initialCloudPreview.previewConfirmed, false);
  assert.equal(initialCloudPreview.cloudConsentGranted, false);
  assert.equal(initialCloudPreview.snapshotId, 'snap-demo-locked-001');
  assert.equal(initialCloudPreview.items.length, 1);
  assert.equal(loaderCallCount, 1);
  assert.equal(orchestratorCallCount, 0);

  // 3. demo 与 real 混用保护 -> 403 DATA_MODE_MISMATCH（请求体、凭证、采集快照三层拦截）
  const bodyModeMismatch = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataMode: 'real', usePersonalMaterials: false }),
  });
  assert.equal(bodyModeMismatch.status, 403);
  assert.equal((await bodyModeMismatch.json()).error.code, 'DATA_MODE_MISMATCH');

  const tokenModeMismatch = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${realModeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ usePersonalMaterials: false }),
  });
  assert.equal(tokenModeMismatch.status, 403);
  assert.equal((await tokenModeMismatch.json()).error.code, 'DATA_MODE_MISMATCH');

  const snapshotModeMismatch = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cloudConsent: true, snapshotId: 'snap-real-leak' }),
  });
  assert.equal(snapshotModeMismatch.status, 403);
  assert.equal((await snapshotModeMismatch.json()).error.code, 'DATA_MODE_MISMATCH');

  // 4. User A 显式同意 cloudConsent: true 并携带匹配的 outboundPreviewId + snapshotId 创建会话，锁定首个 snapshotId
  const userASessionRes = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cloudConsent: true,
      outboundPreviewId: initialCloudPreview.outboundPreviewId,
      snapshotId: initialCloudPreview.snapshotId,
    }),
  });
  assert.equal(userASessionRes.status, 201);
  const userASessionJson = await userASessionRes.json();
  assertMatchesHttpApiSchema(userASessionJson, '#/$defs/SessionCreated');
  const userASession = userASessionJson.data;
  assert.equal(userASession.lockedSnapshotId, 'snap-demo-locked-001');
  assert.equal(userASession.outboundPreview.isCloudModel, true);
  assert.equal(userASession.outboundPreview.cloudConsentGranted, true);
  assert.equal(userASession.outboundPreview.previewConfirmed, true);
  assert.equal(userASession.outboundPreview.outboundPreviewId, initialCloudPreview.outboundPreviewId);

  const userATurnRes = await fetch(`${baseUrl}/v1/sessions/${userASession.sessionId}/turns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientRequestId: 'ua-turn-1', baseGraphVersion: 0, text: '这是谁说的？' }),
  });
  assert.equal(userATurnRes.status, 202);
  const { turnId } = (await userATurnRes.json()).data;

  // 5. User B 交叉访问 User A 的四大接口全部被 403 SESSION_FORBIDDEN 拒绝！
  const crossChecks = await Promise.all([
    fetch(`${baseUrl}/v1/sessions/${userASession.sessionId}`, {
      headers: { Authorization: `Bearer ${TOKEN_B}` },
    }),
    fetch(`${baseUrl}/v1/sessions/${userASession.sessionId}/turns`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN_B}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientRequestId: 'ub-hijack', baseGraphVersion: 0, text: '越权写入' }),
    }),
    fetch(`${baseUrl}/v1/sessions/${userASession.sessionId}/turns/${turnId}/events`, {
      headers: { Authorization: `Bearer ${TOKEN_B}` },
    }),
    fetch(`${baseUrl}/v1/sessions/${userASession.sessionId}/turns/${turnId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN_B}` },
    }),
  ]);
  for (const res of crossChecks) {
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'SESSION_FORBIDDEN');
  }

  // 6. User A 正常按 lookupId 取回早期事实
  const lookupRes = await fetch(`${baseUrl}/v1/sessions/${userASession.sessionId}?lookupId=fact-seed-1`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  assert.equal(lookupRes.status, 200);
  const lookupData = (await lookupRes.json()).data;
  assert.equal(lookupData.retrievedItem.id, 'fact-seed-1');

  // 7. 吊销 User A 令牌后立即生效 -> 401 TOKEN_REVOKED
  auth.revokeToken(TOKEN_A);
  const afterRevokeRes = await fetch(`${baseUrl}/v1/sessions/${userASession.sessionId}`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  assert.equal(afterRevokeRes.status, 401);
  assert.equal((await afterRevokeRes.json()).error.code, 'TOKEN_REVOKED');
});

test('serve-cli.mjs：demo 与 real 默认数据库物理隔离，支持随机令牌生成与优雅关闭', async (t) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'quotation-serve-cli-'));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const demoDb = resolveDefaultDbPath('demo', undefined, tmpDir);
  const realDb = resolveDefaultDbPath('real', undefined, tmpDir);
  assert.notEqual(demoDb, realDb);
  assert.match(demoDb, /sessions-demo\.sqlite$/);
  assert.match(realDb, /sessions-real\.sqlite$/);

  let mcpClosed = false;
  let createdStore = null;
  const stderrChunks = [];

  const runtime = await startQuotationService(['--host', '127.0.0.1', '--port', '0', '--demo'], {
    env: {},
    stdout: { write: () => true },
    stderr: { write: (chunk) => { stderrChunks.push(String(chunk)); return true; } },
    createSessionStore: (filename, opts) => {
      createdStore = createContractMemoryStore({ dataMode: opts.dataMode });
      createdStore.filename = filename;
      return createdStore;
    },
    connectServers: async () => ({
      tools: {},
      enabled: ['search'],
      async close() { mcpClosed = true; },
    }),
    createMaterialLoader: async () => null,
    createTurnOrchestrator: async () => ({
      async executeTurn() {},
    }),
  });

  // 未传 AGENT_SERVER_TOKEN 时自动生成安全令牌，且日志中不泄露该令牌明文
  assert.equal(typeof runtime.bootstrapToken, 'string');
  assert.equal(stderrChunks.join('').includes(runtime.bootstrapToken), false);

  // 空材料无采集配置下可直接创建本人输入会话
  const res = await fetch(`${runtime.origin}/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${runtime.bootstrapToken}` },
  });
  assert.equal(res.status, 201);
  const created = (await res.json()).data;
  assert.equal(created.dataMode, 'demo');
  assert.equal(created.materialsStatus.state, 'unconfigured');

  await runtime.close();
  assert.equal(mcpClosed, true);
  assert.equal(createdStore.isClosed(), true);
});

test('真实 SQLite createSessionStore + HTTP/SSE 端到端贯通验证', async (t) => {
  const { createSessionStore } = await import('../session-store.mjs');

  const store = createSessionStore(':memory:');
  t.after(() => store.close());

  const orchestrator = {
    async executeTurn({ sessionId, turnId, text }) {
      store.appendTurnEvent(sessionId, turnId, 'turn.started', { turnId, sessionId });
      store.appendTurnEvent(sessionId, turnId, 'focus.selected', {
        kind: 'quantifier',
        spanText: '只会',
        reason: '核验绝对排他量词',
      });
      store.appendTurnEvent(sessionId, turnId, 'text.delta', {
        delta: `已针对「${text}」完成结构核验。`,
      });
      store.commitTurn(sessionId, turnId, {
        intent: 'analyze_statement',
        focus: { kind: 'quantifier', spanText: '只会' },
        graphPatch: {
          addedNodes: [
            { id: 'n_self_1', text: '初期推荐曾帮本人发现新乐队', cluster: 'music', deps: [] },
          ],
        },
        upsertedStatements: [
          {
            statementId: 'stmt_original',
            role: 'original',
            text,
            assessment: 'conflict',
            directConflicts: ['n_self_1'],
            reason: '存在本人初期反例',
          },
        ],
      });
    },
  };

  const auth = createPrincipalAuth({
    tokens: [{ token: TOKEN_A, ownerId: 'user-e2e', dataMode: 'demo' }],
  });

  const server = createQuotationServer({
    store,
    orchestrator,
    auth,
    dataMode: 'demo',
  });
  t.after(() => closeServer(server));
  const baseUrl = await listenRandomPort(server);

  const sesRes = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataMode: 'demo' }),
  });
  assert.equal(sesRes.status, 201);
  const { sessionId } = (await sesRes.json()).data;

  const turnRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'e2e-req-1',
      baseGraphVersion: 0,
      text: '推荐算法只会让人的兴趣越来越窄',
    }),
  });
  assert.equal(turnRes.status, 202);
  const { eventsUrl } = (await turnRes.json()).data;

  const sse = await openSseStream(`${baseUrl}${eventsUrl}`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  const events = await sse.readAll();
  const types = events.map((ev) => ev.event);

  assert.equal(types[0], 'turn.started');
  assert.equal(types[1], 'focus.selected');
  assert.equal(types.includes('text.delta'), true);
  assert.equal(types.at(-2), 'turn.committed');
  assert.equal(types.at(-1), 'turn.done');

  const committedEv = events.find((ev) => ev.event === 'turn.committed');
  assert.equal(committedEv.data.turnId, 'turn_1');

  const snapRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}?lookupId=turn_1`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  assert.equal(snapRes.status, 200);
  const snapData = (await snapRes.json()).data;
  assert.equal(snapData.turns.length, 1);
  assert.equal(snapData.turns[0].status, 'committed');
  assert.equal(snapData.retrievedItem.matchType, 'turn');
});

const MOCK_USAGE = {
  inputTokens: { total: 42, noCache: 42, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

function createCapturingMockModel(capturedCalls) {
  let seq = 0;
  return new MockLanguageModelV4({
    doStream: async (options) => {
      seq += 1;
      const serializedPrompt = JSON.stringify(options?.prompt ?? options ?? {});
      capturedCalls.push({ seq, serializedPrompt, options });
      return {
        stream: convertArrayToReadableStream([
          { type: 'text-start', id: `qa_txt_${seq}` },
          { type: 'text-delta', id: `qa_txt_${seq}`, delta: '已按核验依据与程序算价结果完成本轮结构分析。' },
          { type: 'text-end', id: `qa_txt_${seq}` },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: MOCK_USAGE },
        ]),
      };
    },
  });
}

test('QA-01：关闭个人材料（usePersonalMaterials: false）提交多轮并重启后零采集零外发；开启个人材料会话跨页固定携带首个 snapshotId', async (t) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'quotation-qa01-http-'));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const dbPath = path.join(tmpDir, 'qa01-real.sqlite');
  const token = 'tok_qa01_real_owner_secret_123456';
  const PERSONAL_MARKER_P1 = 'QA01_PERSONAL_SNIPPET_PAGE1_远程团队异步周报';
  const PERSONAL_MARKER_P2 = 'QA01_PERSONAL_SNIPPET_PAGE2_跨时区交接清单';
  const PUBLIC_MARKER = 'QA01_PUBLIC_SEARCH_SNIPPET_公开讨论异步工程规范';

  const collectionCalls = [];
  const searchCalls = [];
  const modelCalls = [];

  function buildStubMcpTools() {
    return {
      zhihu_knowledge_profile: {
        async execute(args = {}) {
          collectionCalls.push({ ...args });
          const offset = Number(args.offset ?? 0);
          const resolvedSnap = args.snapshotId ?? 'snap_qa01_locked_first';
          if (offset === 0) {
            return {
              schemaVersion: 1,
              ok: true,
              data: {
                snapshotId: resolvedSnap,
                coverage: { totalRecords: 2 },
                page: { offset: 0, limit: args.limit ?? 10, hasMore: true, nextOffset: 1 },
                records: [
                  {
                    contentType: 'answer',
                    contentId: 'qa01_101',
                    title: '远程办公异步协作实录（第一页）',
                    author: '林澈',
                    kinds: ['collections'],
                    summary: `${PERSONAL_MARKER_P1}：异步书面化设计评审缩短了跨时区团队交付周期。`,
                    bodyText: `${PERSONAL_MARKER_P1}：异步书面化设计评审缩短了跨时区团队交付周期。`,
                    bodyStatus: 'available',
                    url: 'https://www.zhihu.com/question/9101/answer/101',
                  },
                ],
              },
              error: null,
            };
          }
          return {
            schemaVersion: 1,
            ok: true,
            data: {
              snapshotId: resolvedSnap,
              coverage: { totalRecords: 2 },
              page: { offset, limit: args.limit ?? 10, hasMore: false, nextOffset: null },
              records: [
                {
                  contentType: 'article',
                  contentId: 'qa01_102',
                  title: '跨时区交接清单复盘（第二页）',
                  author: '顾怀',
                  kinds: ['history'],
                  summary: `${PERSONAL_MARKER_P2}：每日交接单避免了重复同步会议。`,
                  bodyText: `${PERSONAL_MARKER_P2}：每日交接单避免了重复同步会议。`,
                  bodyStatus: 'available',
                  url: 'https://zhuanlan.zhihu.com/p/9102',
                },
              ],
            },
            error: null,
          };
        },
      },
      zhihu_search: {
        async execute(args = {}) {
          searchCalls.push({ ...args });
          return {
            schemaVersion: 1,
            ok: true,
            data: {
              requestId: 'req_pub_qa01',
              items: [
                {
                  contentType: 'answer',
                  contentId: 'pub_901',
                  title: '远程办公对研发协作的影响有哪些边界？',
                  author: '许衡',
                  excerpt: `${PUBLIC_MARKER}：缺少书面规范的团队更容易出现沟通延迟。`,
                  url: 'https://www.zhihu.com/question/9901/answer/901',
                },
              ],
            },
            error: null,
          };
        },
      },
    };
  }

  async function bootQa01Runtime() {
    const noop = { write: () => true };
    return startQuotationService(
      [
        '--allow-personal-data',
        '--host',
        '127.0.0.1',
        '--port',
        '0',
        '--db',
        dbPath,
        '--base-url',
        'https://api.cloud-llm.example/v1',
        '--model',
        'cloud-mock-v4',
      ],
      {
        env: {
          AGENT_SERVER_TOKEN: token,
          AGENT_OWNER_ID: 'owner-qa01',
          AGENT_API_KEY: 'sk-qa01-test-key-000000',
          DATA_SERVICE_AGENT_TOKEN: 'agt_qa01_readonly_token',
          ZHIHU_ACCESS_SECRET: 'zh_qa01_public_secret',
        },
        stdout: noop,
        stderr: noop,
        connectServers: async () => ({
          tools: buildStubMcpTools(),
          enabled: ['search', 'collection'],
          close: async () => {},
        }),
        createTurnOrchestrator: (opts) =>
          createTurnOrchestrator({
            ...opts,
            model: createCapturingMockModel(modelCalls),
          }),
      },
    );
  }

  let runtime = await bootQa01Runtime();
  t.after(async () => {
    if (runtime) await runtime.close();
  });

  // 1. 创建明确关闭个人材料的会话（允许云模型推理）
  const createOffRes = await fetch(`${runtime.origin}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ usePersonalMaterials: false, cloudConsent: true }),
  });
  assert.equal(createOffRes.status, 201);
  const createOffJson = await createOffRes.json();
  assertMatchesHttpApiSchema(createOffJson, '#/$defs/SessionCreated');
  assert.equal(createOffJson.data.usePersonalMaterials, false);
  assert.equal(createOffJson.data.lockedSnapshotId, null);
  assert.equal(createOffJson.data.materialsStatus.state, 'disabled_by_user');
  assert.equal(collectionCalls.length, 0, '创建关闭材料的会话时采集调用必须为 0');

  const offSessionId = createOffJson.data.sessionId;

  // 第 1 轮：提交与合成采集片段同议题的句子（不传 cloudConsent 亦允许走云模型处理公开与本人输入）
  const turn1Res = await fetch(`${runtime.origin}/v1/sessions/${offSessionId}/turns`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      clientRequestId: 'qa01-off-turn-1',
      baseGraphVersion: 0,
      text: '远程办公必然降低所有团队的异步协作与跨时区交接效率。',
    }),
  });
  assert.equal(turn1Res.status, 202);
  const turn1Json = await turn1Res.json();
  assertMatchesHttpApiSchema(turn1Json, '#/$defs/TurnAccepted');

  const sse1 = await openSseStream(`${runtime.origin}${turn1Json.data.eventsUrl}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const sse1Events = await sse1.readAll();
  assert.equal(sse1Events.at(-1).event, 'turn.done');

  assert.equal(collectionCalls.length, 0, '第 1 轮执行期间采集调用必须为 0');
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].serializedPrompt.includes(PERSONAL_MARKER_P1), false);
  assert.equal(modelCalls[0].serializedPrompt.includes(PERSONAL_MARKER_P2), false);
  assert.equal(JSON.stringify(sse1Events).includes(PERSONAL_MARKER_P1), false);
  assert.equal(JSON.stringify(sse1Events).includes(PERSONAL_MARKER_P2), false);

  const snapAfterT1 = await (await fetch(`${runtime.origin}/v1/sessions/${offSessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  assertMatchesHttpApiSchema(snapAfterT1, '#/$defs/SessionSnapshot');
  assert.equal(snapAfterT1.data.usePersonalMaterials, false);
  assert.equal(snapAfterT1.data.lockedSnapshotId, null);
  assert.equal(
    snapAfterT1.data.evidenceIndex.some((ev) => ev.sourceType === 'collection_record'),
    false,
  );

  // 重启服务（清空内存态 sessionRuntimeMeta，从 SQLite 恢复持久化的 usePersonalMaterials: false）
  await runtime.close();
  runtime = await bootQa01Runtime();

  const snapAfterRestart = await (await fetch(`${runtime.origin}/v1/sessions/${offSessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  assertMatchesHttpApiSchema(snapAfterRestart, '#/$defs/SessionSnapshot');
  assert.equal(snapAfterRestart.data.usePersonalMaterials, false);
  assert.equal(snapAfterRestart.data.materialsStatus.state, 'disabled_by_user');

  // 第 2 轮（重启后）：再次提交本人经历与追问，确认依旧零采集调用、零合成采集片段进入模型或会话
  const turn2Res = await fetch(`${runtime.origin}/v1/sessions/${offSessionId}/turns`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      clientRequestId: 'qa01-off-turn-2',
      baseGraphVersion: snapAfterRestart.data.graphVersion,
      text: '我自己带远程团队做异步书面评审时，交付速度反而更快了。',
    }),
  });
  assert.equal(turn2Res.status, 202);
  const turn2Json = await turn2Res.json();
  const sse2 = await openSseStream(`${runtime.origin}${turn2Json.data.eventsUrl}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const sse2Events = await sse2.readAll();
  assert.equal(sse2Events.at(-1).event, 'turn.done');

  assert.equal(collectionCalls.length, 0, '重启后第 2 轮采集调用仍必须严格为 0');
  assert.equal(modelCalls.length, 2);
  assert.equal(modelCalls[1].serializedPrompt.includes(PERSONAL_MARKER_P1), false);
  assert.equal(modelCalls[1].serializedPrompt.includes(PERSONAL_MARKER_P2), false);
  assert.equal(JSON.stringify(sse2Events).includes(PERSONAL_MARKER_P1), false);

  const snapAfterT2 = await (await fetch(`${runtime.origin}/v1/sessions/${offSessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  assert.equal(
    snapAfterT2.data.evidenceIndex.some((ev) => ev.sourceType === 'collection_record'),
    false,
  );
  assert.equal(JSON.stringify(snapAfterT2).includes(PERSONAL_MARKER_P1), false);

  // 2. 对照会话：明确启用个人材料并走两步先预览后确认获准云推理，验证能读到合成片段且从第 2 页起始终固定携带首个 snapshotId
  const previewOnRes = await fetch(`${runtime.origin}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ usePersonalMaterials: true }),
  });
  assert.equal(previewOnRes.status, 403);
  const previewOnJson = await previewOnRes.json();
  assertMatchesHttpApiSchema(previewOnJson, 'null');
  assert.equal(previewOnJson.error.code, 'CLOUD_CONSENT_REQUIRED');
  const previewOnManifest = previewOnJson.error.details?.outboundPreview;
  assert.ok(previewOnManifest?.outboundPreviewId);
  assert.equal(previewOnManifest.previewConfirmed, false);
  assert.equal(previewOnManifest.snapshotId, 'snap_qa01_locked_first');

  const createOnRes = await fetch(`${runtime.origin}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      usePersonalMaterials: true,
      cloudConsent: true,
      outboundPreviewId: previewOnManifest.outboundPreviewId,
      snapshotId: previewOnManifest.snapshotId,
    }),
  });
  assert.equal(createOnRes.status, 201);
  const createOnJson = await createOnRes.json();
  assertMatchesHttpApiSchema(createOnJson, '#/$defs/SessionCreated');
  assert.equal(createOnJson.data.usePersonalMaterials, true);
  assert.equal(createOnJson.data.lockedSnapshotId, 'snap_qa01_locked_first');
  assert.ok(collectionCalls.length >= 2, '对照会话应完成跨页采集读取');
  assert.equal(collectionCalls[0].offset, 0);
  for (let i = 1; i < collectionCalls.length; i += 1) {
    assert.equal(
      collectionCalls[i].snapshotId,
      'snap_qa01_locked_first',
      `第 ${i + 1} 次分页/后续采集请求必须固定携带首个 snapshotId`,
    );
  }

  const onSnap = await (await fetch(`${runtime.origin}/v1/sessions/${createOnJson.data.sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  assertMatchesHttpApiSchema(onSnap, '#/$defs/SessionSnapshot');
  assert.equal(onSnap.data.usePersonalMaterials, true);
  assert.equal(JSON.stringify(onSnap.data.evidenceIndex).includes(PERSONAL_MARKER_P1), true);
  assert.equal(JSON.stringify(onSnap.data.evidenceIndex).includes(PERSONAL_MARKER_P2), true);
});

test('QA-02：real 模式下同一合成快照走回环模型（cloudConsent: false 成功）、外部云模型无同意被拒（403 且模型调用为 0）、有同意对齐外发预览，以及后续轮次传 cloudConsent: false 被阻止', async (t) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'quotation-qa02-http-'));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const localDbPath = path.join(tmpDir, 'qa02-local-real.sqlite');
  const cloudDbPath = path.join(tmpDir, 'qa02-cloud-real.sqlite');
  const token = 'tok_qa02_real_owner_secret_654321';
  const RELEVANT_PERSONAL_EXCERPT = 'QA02_REAL_SNIPPET_REMOTE：跨时区研发团队借助异步设计文档缩短了版本交付周期。';
  const UNRELATED_PERSONAL_EXCERPT = 'QA02_REAL_SNIPPET_BAKING：铸铁锅酸面团欧包烘烤湿度控制记录。';

  let collectionCallCount = 0;
  function buildQa02Tools() {
    return {
      zhihu_knowledge_profile: {
        async execute(args = {}) {
          collectionCallCount += 1;
          return {
            schemaVersion: 1,
            ok: true,
            data: {
              snapshotId: args.snapshotId ?? 'snap_qa02_real_001',
              coverage: { totalRecords: 2 },
              page: { offset: 0, limit: args.limit ?? 10, hasMore: false, nextOffset: null },
              records: [
                {
                  contentType: 'answer',
                  contentId: 'qa02_201',
                  title: '远程研发团队异步协作复盘',
                  author: '陈序',
                  kinds: ['collections'],
                  summary: RELEVANT_PERSONAL_EXCERPT,
                  bodyText: RELEVANT_PERSONAL_EXCERPT,
                  bodyStatus: 'available',
                  url: 'https://www.zhihu.com/question/9201/answer/201',
                },
                {
                  contentType: 'article',
                  contentId: 'qa02_202',
                  title: '家庭烘焙发酵实验笔记',
                  author: '苏禾',
                  kinds: ['history'],
                  summary: UNRELATED_PERSONAL_EXCERPT,
                  bodyText: UNRELATED_PERSONAL_EXCERPT,
                  bodyStatus: 'available',
                  url: 'https://zhuanlan.zhihu.com/p/9202',
                },
              ],
            },
            error: null,
          };
        },
      },
      zhihu_search: {
        async execute() {
          return {
            schemaVersion: 1,
            ok: true,
            data: { requestId: 'req_pub_qa02', items: [] },
            error: null,
          };
        },
      },
    };
  }

  async function bootQa02Service({ dbPath, baseURL, capturedModelCalls }) {
    const noop = { write: () => true };
    return startQuotationService(
      [
        '--allow-personal-data',
        '--host',
        '127.0.0.1',
        '--port',
        '0',
        '--db',
        dbPath,
        '--base-url',
        baseURL,
        '--model',
        'qa02-controllable-model',
      ],
      {
        env: {
          AGENT_SERVER_TOKEN: token,
          AGENT_OWNER_ID: 'owner-qa02',
          AGENT_API_KEY: 'sk-qa02-secret-key-999999',
          DATA_SERVICE_AGENT_TOKEN: 'agt_qa02_readonly_token',
          ZHIHU_ACCESS_SECRET: 'zh_qa02_public_secret',
        },
        stdout: noop,
        stderr: noop,
        connectServers: async () => ({
          tools: buildQa02Tools(),
          enabled: ['search', 'collection'],
          close: async () => {},
        }),
        createTurnOrchestrator: (opts) =>
          createTurnOrchestrator({
            ...opts,
            model: createCapturingMockModel(capturedModelCalls),
          }),
      },
    );
  }

  // 分支 A：本机回环推理地址（127.0.0.0/8），real 模式下显式传 cloudConsent: false 一律允许使用个人材料
  const loopbackModelCalls = [];
  const loopbackRuntime = await bootQa02Service({
    dbPath: localDbPath,
    baseURL: 'http://127.0.0.2:11434/v1',
    capturedModelCalls: loopbackModelCalls,
  });
  t.after(() => loopbackRuntime.close());

  const localCreateRes = await fetch(`${loopbackRuntime.origin}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ usePersonalMaterials: true, cloudConsent: false }),
  });
  assert.equal(localCreateRes.status, 201);
  const localCreateJson = await localCreateRes.json();
  assertMatchesHttpApiSchema(localCreateJson, '#/$defs/SessionCreated');
  assert.equal(localCreateJson.data.dataMode, 'real');
  assert.equal(localCreateJson.data.outboundPreview.isLocalModel, true);
  assert.equal(localCreateJson.data.outboundPreview.cloudConsentGranted, false);
  assert.equal(localCreateJson.data.lockedSnapshotId, 'snap_qa02_real_001');

  const localTurnRes = await fetch(
    `${loopbackRuntime.origin}/v1/sessions/${localCreateJson.data.sessionId}/turns`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientRequestId: 'qa02-local-turn-1',
        baseGraphVersion: 0,
        text: '远程研发团队异步协作必然拖慢版本交付周期。',
        cloudConsent: false,
      }),
    },
  );
  assert.equal(localTurnRes.status, 202);
  const localTurnJson = await localTurnRes.json();
  const localSse = await openSseStream(`${loopbackRuntime.origin}${localTurnJson.data.eventsUrl}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const localEvents = await localSse.readAll();
  assert.equal(localEvents.some((e) => e.event === 'turn.committed'), true);
  assert.equal(localEvents.at(-1).event, 'turn.done');
  assert.equal(loopbackModelCalls.length, 1, '本机回环模型应正常完成推理调用');
  assert.equal(loopbackModelCalls[0].serializedPrompt.includes(RELEVANT_PERSONAL_EXCERPT), true);

  // 分支 B：非本机外部云模型，宿主开启 --allow-personal-data 但请求无同意 / cloudConsent: false / 只传同意缺预览 ID -> 403 返回实际未确认预览且模型调用为 0
  collectionCallCount = 0;
  const cloudModelCalls = [];
  const cloudRuntime = await bootQa02Service({
    dbPath: cloudDbPath,
    baseURL: 'https://api.cloud-llm.example/v1',
    capturedModelCalls: cloudModelCalls,
  });
  t.after(() => cloudRuntime.close());

  const denyOmittedRes = await fetch(`${cloudRuntime.origin}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ usePersonalMaterials: true }),
  });
  assert.equal(denyOmittedRes.status, 403);
  const denyOmittedJson = await denyOmittedRes.json();
  assertMatchesHttpApiSchema(denyOmittedJson, 'null');
  assert.equal(denyOmittedJson.error.code, 'CLOUD_CONSENT_REQUIRED');
  const firstCloudPreview = denyOmittedJson.error.details?.outboundPreview;
  assert.ok(firstCloudPreview?.outboundPreviewId, '首次云创建被拒必须返回实际非空 outboundPreviewId');
  assert.equal(firstCloudPreview.previewConfirmed, false);
  assert.equal(firstCloudPreview.cloudConsentGranted, false);
  assert.equal(firstCloudPreview.confirmedOutboundPreviewId, null);
  assert.equal(firstCloudPreview.snapshotId, 'snap_qa02_real_001');
  assert.equal(firstCloudPreview.items.length, 2);
  assert.ok(collectionCallCount >= 1, '本机只读加载快照用于生成实际拟外发预览');
  assert.equal(cloudModelCalls.length, 0, '云模型未同意时模型调用次数必须为 0');

  const denyFalseRes = await fetch(`${cloudRuntime.origin}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ usePersonalMaterials: true, cloudConsent: false }),
  });
  assert.equal(denyFalseRes.status, 403);
  const denyFalseJson = await denyFalseRes.json();
  assertMatchesHttpApiSchema(denyFalseJson, 'null');
  assert.equal(denyFalseJson.error.code, 'CLOUD_CONSENT_REQUIRED');
  assert.equal(denyFalseJson.error.details?.outboundPreview?.previewConfirmed, false);
  assert.equal(cloudModelCalls.length, 0);

  const denyWithoutPreviewIdRes = await fetch(`${cloudRuntime.origin}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ usePersonalMaterials: true, cloudConsent: true }),
  });
  assert.equal(denyWithoutPreviewIdRes.status, 403);
  const denyWithoutPreviewIdJson = await denyWithoutPreviewIdRes.json();
  assertMatchesHttpApiSchema(denyWithoutPreviewIdJson, 'null');
  assert.equal(denyWithoutPreviewIdJson.error.code, 'CLOUD_CONSENT_REQUIRED');
  assert.equal(denyWithoutPreviewIdJson.error.details?.outboundPreview?.previewConfirmed, false);
  assert.equal(cloudModelCalls.length, 0, '缺少 outboundPreviewId 时不得调用云模型');

  // 分支 C：外部云模型显式同意 cloudConsent: true 并携带匹配的 outboundPreviewId + snapshotId -> 成功，只发送本轮需要片段且与预览一致
  const cloudAllowRes = await fetch(`${cloudRuntime.origin}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      usePersonalMaterials: true,
      cloudConsent: true,
      outboundPreviewId: firstCloudPreview.outboundPreviewId,
      snapshotId: firstCloudPreview.snapshotId,
    }),
  });
  assert.equal(cloudAllowRes.status, 201);
  const cloudAllowJson = await cloudAllowRes.json();
  assertMatchesHttpApiSchema(cloudAllowJson, '#/$defs/SessionCreated');
  const previewBeforeTurn = cloudAllowJson.data.outboundPreview;
  assert.equal(previewBeforeTurn.isCloudModel, true);
  assert.equal(previewBeforeTurn.cloudConsentGranted, true);
  assert.equal(previewBeforeTurn.previewConfirmed, true);
  assert.equal(previewBeforeTurn.outboundPreviewId, firstCloudPreview.outboundPreviewId);
  const previewExcerpts = previewBeforeTurn.snippetPreview.map((item) => item.excerpt);
  assert.equal(previewExcerpts.includes(RELEVANT_PERSONAL_EXCERPT), true);

  const cloudSessionId = cloudAllowJson.data.sessionId;
  const cloudTurn1Res = await fetch(`${cloudRuntime.origin}/v1/sessions/${cloudSessionId}/turns`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      clientRequestId: 'qa02-cloud-turn-1',
      baseGraphVersion: 0,
      text: '远程研发团队异步协作必然拖慢版本交付周期。',
    }),
  });
  assert.equal(cloudTurn1Res.status, 202);
  const cloudTurn1Json = await cloudTurn1Res.json();
  const cloudSse1 = await openSseStream(`${cloudRuntime.origin}${cloudTurn1Json.data.eventsUrl}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const cloudEvents1 = await cloudSse1.readAll();
  assert.equal(cloudEvents1.some((e) => e.event === 'turn.committed'), true);
  assert.equal(cloudModelCalls.length, 1);

  // 核对外发预览与真正发送给外部模型的个人片段一致，且无关烘焙片段未混入本轮模型请求
  const sentPrompt1 = cloudModelCalls[0].serializedPrompt;
  assert.equal(sentPrompt1.includes(RELEVANT_PERSONAL_EXCERPT), true);
  assert.equal(sentPrompt1.includes(UNRELATED_PERSONAL_EXCERPT), false);
  for (const snippet of [RELEVANT_PERSONAL_EXCERPT, UNRELATED_PERSONAL_EXCERPT]) {
    if (sentPrompt1.includes(snippet)) {
      assert.equal(
        previewExcerpts.some((p) => snippet.startsWith(p) || p.includes(snippet)),
        true,
        '实际外发给云模型的个人片段必须包含在可见 outboundPreview 清单内',
      );
    }
  }

  // 分支 D：已有个人材料的已同意会话在后续轮次显式传 cloudConsent: false -> 该轮立即被 403 阻止，模型零新增调用
  const snapBeforeRevokeTurn = await (
    await fetch(`${cloudRuntime.origin}/v1/sessions/${cloudSessionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();

  const revokeTurnRes = await fetch(`${cloudRuntime.origin}/v1/sessions/${cloudSessionId}/turns`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      clientRequestId: 'qa02-cloud-turn-revoke',
      baseGraphVersion: snapBeforeRevokeTurn.data.graphVersion,
      text: '为什么先拆“必然”这个词？',
      cloudConsent: false,
    }),
  });
  assert.equal(revokeTurnRes.status, 403);
  const revokeTurnJson = await revokeTurnRes.json();
  assertMatchesHttpApiSchema(revokeTurnJson, 'null');
  assert.equal(revokeTurnJson.error.code, 'CLOUD_CONSENT_REQUIRED');
  assert.equal(cloudModelCalls.length, 1, '后续轮显式传 cloudConsent: false 时不得触发模型调用');

  const snapAfterRevokeTurn = await (
    await fetch(`${cloudRuntime.origin}/v1/sessions/${cloudSessionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  assert.equal(snapAfterRevokeTurn.data.turns.length, 1, '被门禁拦截的轮次不得写入 turns 表');
});

test('QA-09：http-api-v1.schema.json Draft 2020-12 全端点唯一 oneOf 分支校验与四种终态（cancelled/committed/failed/interrupted）幂等取消及续读验证', async (t) => {
  const { createSessionStore } = await import('../session-store.mjs');
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'quotation-qa09-schema-'));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const dbPath = path.join(tmpDir, 'qa09-sessions.sqlite');
  let store = createSessionStore(dbPath, { dataMode: 'demo' });
  t.after(() => {
    try { store.close(); } catch { /* ignore */ }
  });

  const auth = createPrincipalAuth({
    tokens: [{ token: TOKEN_A, ownerId: 'user-qa09', dataMode: 'demo' }],
  });

  let turnBehavior = 'commit';
  const enteredCancelWait = createDeferred();
  const enteredCrashHang = createDeferred();

  function buildOrchestrator(activeStore) {
    return {
      async executeTurn({ sessionId, turnId, text, signal }) {
        activeStore.appendTurnEvent(sessionId, turnId, 'turn.started', { turnId, sessionId });
        if (turnBehavior === 'wait_cancel') {
          enteredCancelWait.resolve();
          await new Promise((resolve) => {
            signal.addEventListener('abort', resolve, { once: true });
          });
          return;
        }
        if (turnBehavior === 'fail_upstream') {
          throw new BackendServiceError('MODEL_ERROR', '可控上游模型连接中断。', 502);
        }
        if (turnBehavior === 'hang_for_crash') {
          enteredCrashHang.resolve();
          await new Promise(() => {});
          return;
        }
        const focus = {
          id: `focus_${turnId}`,
          kind: 'quantifier',
          spanText: '只会',
          startOffset: 4,
          endOffset: 6,
          reason: '检验排他量词',
        };
        activeStore.appendTurnEvent(sessionId, turnId, 'focus.selected', { sentence: text, focus });
        activeStore.appendTurnEvent(sessionId, turnId, 'text.delta', { delta: '已完成核验说明。' });
        activeStore.commitTurn(sessionId, turnId, {
          intent: 'analyze_statement',
          focus,
          verifiedEvidence: [
            {
              evidenceId: 'ev_turn_qa09_1',
              sourceType: 'session_turn',
              author: 'self',
              attribution: 'self',
              excerpt: text,
              turnId,
            },
          ],
          upsertedFacts: [
            {
              id: 'fact_qa09_1',
              kind: 'fact',
              text: '本人初期通过推荐发现过冷门独立乐队',
              turnId,
              evidenceIds: ['ev_turn_qa09_1'],
              nodeIds: ['node_qa09_1'],
            },
          ],
          graphPatch: {
            addedNodes: [
              {
                id: 'node_qa09_1',
                text: '本人初期通过推荐发现过冷门独立乐队',
                cluster: 'music',
                deps: [],
                evidenceIds: ['ev_turn_qa09_1'],
                sourceFactIds: ['fact_qa09_1'],
              },
            ],
          },
          upsertedStatements: [
            {
              statementId: 'stmt_original',
              role: 'original',
              text,
              assessment: 'conflict',
              directConflicts: ['node_qa09_1'],
              conflictReasons: [
                {
                  nodeId: 'node_qa09_1',
                  reason: '与本人已确认经历直接冲突',
                  evidenceIds: ['ev_turn_qa09_1'],
                },
              ],
              reason: '存在本人直接反例',
            },
          ],
        });
      },
    };
  }

  let server = createQuotationServer({
    store,
    orchestrator: buildOrchestrator(store),
    auth,
    dataMode: 'demo',
  });
  t.after(async () => {
    await closeServer(server);
  });
  let baseUrl = await listenRandomPort(server);

  // 1. GET /health -> HealthStatus 唯一分支
  const healthRes = await fetch(`${baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  const healthJson = await healthRes.json();
  assertMatchesHttpApiSchema(healthJson, '#/$defs/HealthStatus');

  // 2. 错误响应（401 UNAUTHORIZED） -> data: null 唯一分支
  const unauthRes = await fetch(`${baseUrl}/v1/sessions`, { method: 'POST' });
  assert.equal(unauthRes.status, 401);
  assertMatchesHttpApiSchema(await unauthRes.json(), 'null');

  // 3. POST /v1/sessions -> SessionCreated 唯一分支（绝不同时命中 SessionSnapshot）
  const createRes = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataMode: 'demo' }),
  });
  assert.equal(createRes.status, 201);
  const createJson = await createRes.json();
  assertMatchesHttpApiSchema(createJson, '#/$defs/SessionCreated');
  const sessionId = createJson.data.sessionId;

  // 4. GET /v1/sessions/:id（空快照） -> SessionSnapshot 唯一分支（修复前会同时命中 SessionCreated！）
  const emptySnapRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  assert.equal(emptySnapRes.status, 200);
  const emptySnapJson = await emptySnapRes.json();
  assertMatchesHttpApiSchema(emptySnapJson, '#/$defs/SessionSnapshot');

  // 对不存在的 turnId 调用 cancel -> 404 TURN_NOT_FOUND 且通过错误 Schema
  const missingCancelRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns/turn_missing/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  assert.equal(missingCancelRes.status, 404);
  const missingCancelJson = await missingCancelRes.json();
  assertMatchesHttpApiSchema(missingCancelJson, 'null');
  assert.equal(missingCancelJson.error.code, 'TURN_NOT_FOUND');

  // 5. 终态一：cancelled（运行中主动取消） + TurnAccepted（202） + 幂等复用（200）
  turnBehavior = 'wait_cancel';
  const acceptCancelRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'qa09-req-cancel',
      baseGraphVersion: 0,
      text: '推荐算法只会让人的兴趣越来越窄',
    }),
  });
  assert.equal(acceptCancelRes.status, 202);
  const acceptCancelJson = await acceptCancelRes.json();
  assertMatchesHttpApiSchema(acceptCancelJson, '#/$defs/TurnAccepted');

  // 同 clientRequestId 幂等复用（200）
  const reuseRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'qa09-req-cancel',
      baseGraphVersion: 0,
      text: '推荐算法只会让人的兴趣越来越窄',
    }),
  });
  assert.equal(reuseRes.status, 200);
  const reuseJson = await reuseRes.json();
  assert.equal(reuseJson.data.reused, true);
  assertMatchesHttpApiSchema(reuseJson, '#/$defs/TurnAccepted');

  await enteredCancelWait.promise;
  const cancelTurn1Res = await fetch(
    `${baseUrl}/v1/sessions/${sessionId}/turns/${acceptCancelJson.data.turnId}/cancel`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'QA-09 主动取消' }),
    },
  );
  assert.equal(cancelTurn1Res.status, 200);
  const cancelTurn1Json = await cancelTurn1Res.json();
  assertMatchesHttpApiSchema(cancelTurn1Json, '#/$defs/TurnCancelled');
  assert.equal(cancelTurn1Json.data.outcome, 'cancelled');
  assert.equal(cancelTurn1Json.data.status, 'cancelled');

  // 6. 终态二：committed（正常提交非空快照后再调 cancel）
  turnBehavior = 'commit';
  const commitTurnRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'qa09-req-commit',
      baseGraphVersion: 0,
      text: '推荐算法只会让人的兴趣越来越窄',
    }),
  });
  assert.equal(commitTurnRes.status, 202);
  const commitTurnJson = await commitTurnRes.json();
  assertMatchesHttpApiSchema(commitTurnJson, '#/$defs/TurnAccepted');

  const commitSse = await openSseStream(`${baseUrl}${commitTurnJson.data.eventsUrl}`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  const commitEvents = await commitSse.readAll();
  assert.equal(commitEvents.at(-2).event, 'turn.committed');
  assert.equal(commitEvents.at(-1).event, 'turn.done');

  // 非空已提交快照 + lookupId 查询均只命中 SessionSnapshot 唯一分支
  const nonEmptySnapRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}?lookupId=fact_qa09_1`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  assert.equal(nonEmptySnapRes.status, 200);
  const nonEmptySnapJson = await nonEmptySnapRes.json();
  assertMatchesHttpApiSchema(nonEmptySnapJson, '#/$defs/SessionSnapshot');
  assert.equal(nonEmptySnapJson.data.graphVersion, 1);
  assert.equal(nonEmptySnapJson.data.retrievedItem.id, 'fact_qa09_1');

  const cancelCommittedRes = await fetch(
    `${baseUrl}/v1/sessions/${sessionId}/turns/${commitTurnJson.data.turnId}/cancel`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    },
  );
  assert.equal(cancelCommittedRes.status, 200);
  const cancelCommittedJson = await cancelCommittedRes.json();
  assertMatchesHttpApiSchema(cancelCommittedJson, '#/$defs/TurnCancelled');
  assert.equal(cancelCommittedJson.data.outcome, 'committed');
  assert.equal(cancelCommittedJson.data.status, 'committed');
  assert.equal(cancelCommittedJson.data.graphVersion, 1);

  // 7. 终态三：failed（上游故障发出 turn.failed -> turn.done 后重复 cancel 与 Last-Event-ID 续读，绝不产生第二个终态！）
  turnBehavior = 'fail_upstream';
  const failTurnRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'qa09-req-fail',
      baseGraphVersion: 1,
      text: '触发上游故障的测试句子',
    }),
  });
  assert.equal(failTurnRes.status, 202);
  const failTurnJson = await failTurnRes.json();

  const failSseInitial = await openSseStream(`${baseUrl}${failTurnJson.data.eventsUrl}`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  const failInitialEvents = await failSseInitial.readAll();
  assert.deepEqual(
    failInitialEvents.map((e) => [e.id, e.event]),
    [
      [1, 'turn.started'],
      [2, 'turn.failed'],
      [3, 'turn.done'],
    ],
  );

  // 连续两次对 failed 轮次调用 cancel：均幂等返回 200 + outcome: "failed"，通过 TurnCancelled Schema
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const cancelFailedRes = await fetch(
      `${baseUrl}/v1/sessions/${sessionId}/turns/${failTurnJson.data.turnId}/cancel`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: `失败后重复点击停止 #${attempt}` }),
      },
    );
    assert.equal(cancelFailedRes.status, 200);
    const cancelFailedJson = await cancelFailedRes.json();
    assertMatchesHttpApiSchema(cancelFailedJson, '#/$defs/TurnCancelled');
    assert.equal(cancelFailedJson.data.outcome, 'failed');
    assert.equal(cancelFailedJson.data.status, 'failed');
    assert.equal(cancelFailedJson.data.graphVersion, 1);
  }

  // Last-Event-ID: 1 续读与全量重放：事件序列严格保持原样，无第二个终态事件
  const failResumeFrom1 = await openSseStream(`${baseUrl}${failTurnJson.data.eventsUrl}`, {
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Last-Event-ID': '1' },
  });
  const failResumedEvents = await failResumeFrom1.readAll();
  assert.deepEqual(
    failResumedEvents.map((e) => [e.id, e.event]),
    [
      [2, 'turn.failed'],
      [3, 'turn.done'],
    ],
  );

  const failResumeAtEnd = await openSseStream(`${baseUrl}${failTurnJson.data.eventsUrl}`, {
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Last-Event-ID': '3' },
  });
  assert.deepEqual(await failResumeAtEnd.readAll(), []);

  // 8. 终态四：interrupted（模拟进程崩溃重启恢复 running -> interrupted 后调用 cancel）
  turnBehavior = 'hang_for_crash';
  const hangTurnRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'qa09-req-interrupted',
      baseGraphVersion: 1,
      text: '模拟进程中断前挂起的轮次',
    }),
  });
  assert.equal(hangTurnRes.status, 202);
  const hangTurnJson = await hangTurnRes.json();
  await enteredCrashHang.promise;

  // 关闭原 HTTP 服务与 SQLite 连接，重新打开同一数据库触发 recoverInterruptedTurns()
  await closeServer(server);
  store.close();

  store = createSessionStore(dbPath, { dataMode: 'demo' });
  server = createQuotationServer({
    store,
    orchestrator: buildOrchestrator(store),
    auth,
    dataMode: 'demo',
  });
  baseUrl = await listenRandomPort(server);

  const cancelInterruptedRes = await fetch(
    `${baseUrl}/v1/sessions/${sessionId}/turns/${hangTurnJson.data.turnId}/cancel`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    },
  );
  assert.equal(cancelInterruptedRes.status, 200);
  const cancelInterruptedJson = await cancelInterruptedRes.json();
  assertMatchesHttpApiSchema(cancelInterruptedJson, '#/$defs/TurnCancelled');
  assert.equal(cancelInterruptedJson.data.outcome, 'interrupted');
  assert.equal(cancelInterruptedJson.data.status, 'interrupted');
  assert.equal(cancelInterruptedJson.data.graphVersion, 1);

  const interruptedSse = await openSseStream(`${baseUrl}${hangTurnJson.data.eventsUrl}`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  const interruptedEvents = await interruptedSse.readAll();
  assert.deepEqual(
    interruptedEvents.map((e) => e.event),
    ['turn.started', 'turn.failed', 'turn.done'],
  );
  assert.equal(interruptedEvents.at(-1).data.status, 'interrupted');
});
