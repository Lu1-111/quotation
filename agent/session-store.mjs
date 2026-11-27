// 本机 SQLite 版本化会话状态、单轮写入锁、原子事务提交、SSE 回放与精确撤回存储。
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSESSMENTS,
  ATTRIBUTIONS,
  BackendServiceError,
  DATA_MODES,
  EVIDENCE_SOURCE_TYPES,
  RATE_INTERPRETATION_NOTE,
  SSE_EVENT_TYPES,
  TURN_INTENTS,
} from './protocol.mjs';

const requireModule = createRequire(import.meta.url);
const QUOTATION_ENGINE_ENTRY = fileURLToPath(
  new URL('../quotation-engine/index.mjs', import.meta.url),
);

const DATA_MODE_SET = new Set(DATA_MODES);
const ASSESSMENT_SET = new Set(ASSESSMENTS);
const ATTRIBUTION_SET = new Set(ATTRIBUTIONS);
const EVIDENCE_SOURCE_SET = new Set(EVIDENCE_SOURCE_TYPES);
const TURN_INTENT_SET = new Set(TURN_INTENTS);
const SSE_EVENT_SET = new Set(SSE_EVENT_TYPES);

const CN_DIGIT_MAP = Object.freeze({
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
});

function parseChineseNumeral(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  if (/^\d+$/.test(s)) {
    const num = Number.parseInt(s, 10);
    return Number.isInteger(num) && num > 0 ? num : null;
  }
  if (s === '十') return 10;
  if (s.includes('十')) {
    const [tensPart, onesPart] = s.split('十');
    const tens = tensPart === '' ? 1 : CN_DIGIT_MAP[tensPart];
    const ones = onesPart === '' ? 0 : CN_DIGIT_MAP[onesPart];
    if (tens === undefined || ones === undefined) return null;
    const total = tens * 10 + ones;
    return total > 0 ? total : null;
  }
  if (s.length === 1 && CN_DIGIT_MAP[s] !== undefined && CN_DIGIT_MAP[s] > 0) {
    return CN_DIGIT_MAP[s];
  }
  let acc = 0;
  for (const ch of s) {
    if (CN_DIGIT_MAP[ch] === undefined) return null;
    acc = acc * 10 + CN_DIGIT_MAP[ch];
  }
  return acc > 0 ? acc : null;
}

// 解析如 6、'6'、'turn_6'、'第六轮'、'第 10 轮' 等轮次引用为正整数轮次号。
export function parseTurnNumberReference(ref) {
  if (typeof ref === 'number' && Number.isInteger(ref) && ref > 0) {
    return ref;
  }
  if (typeof ref !== 'string') return null;
  const trimmed = ref.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    return n > 0 ? n : null;
  }
  const turnIdMatch = /^turn_(\d+)$/i.exec(trimmed);
  if (turnIdMatch) {
    const n = Number.parseInt(turnIdMatch[1], 10);
    return n > 0 ? n : null;
  }
  const cnTurnMatch = /^第\s*([0-9零〇一二两三四五六七八九十]+)\s*轮$/.exec(trimmed);
  if (cnTurnMatch) {
    return parseChineseNumeral(cnTurnMatch[1]);
  }
  return null;
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function stableNormalize(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) {
        out[key] = stableNormalize(value[key]);
      }
    }
    return out;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableNormalize(value));
}

function pushMinHeap(heap, value) {
  heap.push(value);
  let idx = heap.length - 1;
  while (idx > 0) {
    const parent = (idx - 1) >> 1;
    if (heap[parent] <= heap[idx]) break;
    const tmp = heap[parent];
    heap[parent] = heap[idx];
    heap[idx] = tmp;
    idx = parent;
  }
}

function popMinHeap(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0) {
    heap[0] = last;
    let idx = 0;
    const len = heap.length;
    while (true) {
      const left = idx * 2 + 1;
      const right = left + 1;
      let smallest = idx;
      if (left < len && heap[left] < heap[smallest]) smallest = left;
      if (right < len && heap[right] < heap[smallest]) smallest = right;
      if (smallest === idx) break;
      const tmp = heap[idx];
      heap[idx] = heap[smallest];
      heap[smallest] = tmp;
      idx = smallest;
    }
  }
  return top;
}

/* ---------- 内置兜底纯算价引擎（与 quotation-engine 及实施方案 2.4/2.5 100% 对齐） ---------- */

function builtinValidateDag(nodes, { allowEmpty = true } = {}) {
  if (!Array.isArray(nodes)) {
    return {
      ok: false,
      errors: [allowEmpty ? '节点列表必须是数组。' : '节点列表必须是非空数组。'],
      sortedNodes: [],
    };
  }
  if (nodes.length === 0) {
    return allowEmpty
      ? { ok: true, errors: [], sortedNodes: [] }
      : { ok: false, errors: ['节点列表必须是非空数组。'], sortedNodes: [] };
  }

  const errors = [];
  const indexById = new Map();
  nodes.forEach((n, i) => {
    const at = `nodes[${i}]`;
    if (!n || typeof n !== 'object' || Array.isArray(n)) {
      errors.push(`${at} 不是对象。`);
      return;
    }
    if (typeof n.id !== 'string' || !n.id.trim()) {
      errors.push(`${at}.id 必须是非空字符串。`);
    } else if (indexById.has(n.id)) {
      errors.push(`${at}.id 重复：${n.id}。`);
    } else {
      indexById.set(n.id, i);
    }
    if (typeof n.text !== 'string' || !n.text.trim()) {
      errors.push(`${at}.text 必须是非空字符串。`);
    }
    const validCluster =
      (typeof n.cluster === 'string' && n.cluster.trim().length > 0) ||
      (typeof n.cluster === 'number' && Number.isFinite(n.cluster));
    if (!validCluster) {
      errors.push(`${at}.cluster 必须是非空字符串或有限数字。`);
    }
    if (!Array.isArray(n.deps)) {
      errors.push(`${at}.deps 必须是数组。`);
    }
  });

  const childrenByIndex = Array.from({ length: nodes.length }, () => []);
  const inDegree = new Int32Array(nodes.length);

  nodes.forEach((n, i) => {
    if (!n || typeof n !== 'object' || Array.isArray(n) || !Array.isArray(n.deps)) return;
    const seenDeps = new Set();
    n.deps.forEach((dep, j) => {
      if (typeof dep !== 'string' || !dep.trim()) {
        errors.push(`nodes[${i}].deps[${j}] 无效。`);
        return;
      }
      if (seenDeps.has(dep)) {
        errors.push(`nodes[${i}] 包含重复依赖：${dep}。`);
        return;
      }
      seenDeps.add(dep);
      if (dep === n.id) {
        errors.push(`nodes[${i}] 不能依赖自身（自环）：${dep}。`);
        return;
      }
      if (!indexById.has(dep)) {
        errors.push(`nodes[${i}] 依赖了不存在的节点：${dep}。`);
        return;
      }
      const depIdx = indexById.get(dep);
      if (depIdx !== undefined && indexById.get(n.id) === i) {
        childrenByIndex[depIdx].push(i);
        inDegree[i] += 1;
      }
    });
  });

  const color = new Uint8Array(nodes.length);
  const pathStack = [];
  const posInStack = new Int32Array(nodes.length).fill(-1);
  const childCursor = new Int32Array(nodes.length);
  const seenCycles = new Set();

  for (let start = 0; start < nodes.length; start += 1) {
    if (
      color[start] !== 0 ||
      !nodes[start] ||
      typeof nodes[start] !== 'object' ||
      Array.isArray(nodes[start])
    ) {
      continue;
    }
    color[start] = 1;
    posInStack[start] = 0;
    childCursor[start] = 0;
    pathStack.push(start);

    while (pathStack.length > 0) {
      const u = pathStack[pathStack.length - 1];
      const children = childrenByIndex[u];
      const cursor = childCursor[u];
      if (cursor < children.length) {
        childCursor[u] = cursor + 1;
        const v = children[cursor];
        if (color[v] === 0) {
          color[v] = 1;
          posInStack[v] = pathStack.length;
          childCursor[v] = 0;
          pathStack.push(v);
        } else if (color[v] === 1) {
          const startPos = posInStack[v];
          if (startPos >= 0) {
            const cycleIndices = pathStack.slice(startPos);
            const cycleIds = cycleIndices.map((idx) => nodes[idx].id);
            let minPos = 0;
            for (let k = 1; k < cycleIndices.length; k += 1) {
              if (cycleIndices[k] < cycleIndices[minPos]) minPos = k;
            }
            const canonical = [...cycleIds.slice(minPos), ...cycleIds.slice(0, minPos)];
            const key = canonical.join('->');
            if (!seenCycles.has(key)) {
              seenCycles.add(key);
              errors.push(`检测到循环依赖：${[...canonical, canonical[0]].join(' -> ')}。`);
            }
          }
        }
      } else {
        pathStack.pop();
        posInStack[u] = -1;
        color[u] = 2;
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, sortedNodes: [] };
  }

  const heap = [];
  for (let i = 0; i < nodes.length; i += 1) {
    if (inDegree[i] === 0) pushMinHeap(heap, i);
  }
  const sortedNodes = [];
  while (heap.length > 0) {
    const u = popMinHeap(heap);
    const node = nodes[u];
    sortedNodes.push({ ...node, deps: [...node.deps] });
    for (const v of childrenByIndex[u]) {
      inDegree[v] -= 1;
      if (inDegree[v] === 0) pushMinHeap(heap, v);
    }
  }
  if (sortedNodes.length !== nodes.length) {
    return {
      ok: false,
      errors: ['检测到有向图存在循环依赖，无法完成拓扑排序。'],
      sortedNodes: [],
    };
  }
  return { ok: true, errors: [], sortedNodes };
}

function popcount32(x) {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function builtinComputeGraph(nodes) {
  const dag = builtinValidateDag(nodes, { allowEmpty: true });
  if (!dag.ok) {
    const err = new Error(`图结构校验失败：${dag.errors.join(' ')}`);
    err.code = 'INVALID_GRAPH';
    err.errors = dag.errors;
    throw err;
  }
  const sorted = dag.sortedNodes;
  const nCount = sorted.length;
  if (nCount === 0) return [];

  const idxById = new Map();
  for (let i = 0; i < nCount; i += 1) {
    idxById.set(sorted[i].id, i);
  }

  const kidsIdx = Array.from({ length: nCount }, () => []);
  for (let i = 0; i < nCount; i += 1) {
    for (const dep of sorted[i].deps) {
      const depIdx = idxById.get(dep);
      if (depIdx !== undefined) {
        kidsIdx[depIdx].push(i);
      }
    }
  }

  const depth = new Float64Array(nCount);
  for (let i = 0; i < nCount; i += 1) {
    depth[i] = sorted[i].deps.length ? Infinity : 0;
  }
  for (let i = 0; i < nCount; i += 1) {
    const d = depth[i];
    const children = kidsIdx[i];
    for (let k = 0; k < children.length; k += 1) {
      const cIdx = children[k];
      if (d + 1 < depth[cIdx]) depth[cIdx] = d + 1;
    }
  }

  const wordsPerNode = Math.ceil(nCount / 32);
  const descBits = new Uint32Array(nCount * wordsPerNode);
  const supportWeights = new Int32Array(nCount);

  for (let i = nCount - 1; i >= 0; i -= 1) {
    const rowOffset = i * wordsPerNode;
    const children = kidsIdx[i];
    for (let k = 0; k < children.length; k += 1) {
      const cIdx = children[k];
      descBits[rowOffset + (cIdx >>> 5)] |= 1 << (cIdx & 31);
      const childOffset = cIdx * wordsPerNode;
      for (let w = 0; w < wordsPerNode; w += 1) {
        descBits[rowOffset + w] |= descBits[childOffset + w];
      }
    }
    let count = 0;
    for (let w = 0; w < wordsPerNode; w += 1) {
      const word = descBits[rowOffset + w];
      if (word !== 0) count += popcount32(word);
    }
    supportWeights[i] = count;
  }

  return sorted.map((n, i) => ({
    ...n,
    deps: [...n.deps],
    S: supportWeights[i],
    d: depth[i],
    depsOf: [...n.deps],
  }));
}

function builtinCollapseAfter(removed, graph) {
  const initial = removed == null
    ? []
    : (Array.isArray(removed) || removed instanceof Set ? removed : [...removed]);
  const dead = new Set(initial);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of graph) {
      if (dead.has(n.id) || !n.deps.length) continue;
      const alive = n.deps.filter((d) => !dead.has(d)).length;
      if (alive / n.deps.length < 0.5) {
        dead.add(n.id);
        changed = true;
      }
    }
  }
  return dead;
}

function validateStrictEvidenceIdList(items, fieldName = 'verifiedEvidenceIds') {
  if (items === undefined || items === null) return [];
  const list = Array.isArray(items)
    ? items
    : (items instanceof Set ? [...items] : null);
  if (!list) {
    throw new BackendServiceError(
      'VERIFICATION_REJECTED',
      `${fieldName} 必须是字符串数组。`,
      400,
      { field: fieldName },
    );
  }
  const unique = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const id = list[i];
    if (typeof id !== 'string' || !id.trim()) {
      throw new BackendServiceError(
        'VERIFICATION_REJECTED',
        `${fieldName}[${i}] 必须是非空字符串。`,
        400,
        { field: fieldName, index: i },
      );
    }
    const clean = id.trim();
    if (!seen.has(clean)) {
      seen.add(clean);
      unique.push(clean);
    }
  }
  return unique;
}

function validateStrictConflictReasons(conflictReasons) {
  if (conflictReasons === undefined || conflictReasons === null) return [];
  if (!Array.isArray(conflictReasons)) {
    throw new BackendServiceError(
      'VERIFICATION_REJECTED',
      'conflictReasons 必须是数组。',
      400,
      { field: 'conflictReasons' },
    );
  }
  return conflictReasons.map((entry, idx) => {
    if (typeof entry === 'string') {
      if (!entry.trim()) {
        throw new BackendServiceError(
          'VERIFICATION_REJECTED',
          `conflictReasons[${idx}] 必须是非空字符串。`,
          400,
          { field: 'conflictReasons', index: idx },
        );
      }
      return entry;
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const nodeId = typeof entry.nodeId === 'string' ? entry.nodeId.trim() : '';
      const reasonText = typeof entry.reason === 'string' ? entry.reason.trim() : '';
      if (!nodeId || !reasonText) {
        throw new BackendServiceError(
          'VERIFICATION_REJECTED',
          `conflictReasons[${idx}] 对象必须包含非空字符串 nodeId 与 reason。`,
          400,
          { field: 'conflictReasons', index: idx },
        );
      }
      const normalized = {
        ...cloneJson(entry),
        nodeId,
        reason: reasonText,
      };
      if (entry.evidenceIds !== undefined) {
        normalized.evidenceIds = validateStrictEvidenceIdList(
          entry.evidenceIds,
          `conflictReasons[${idx}].evidenceIds`,
        );
      }
      return normalized;
    }
    throw new BackendServiceError(
      'VERIFICATION_REJECTED',
      `conflictReasons[${idx}] 必须是非空字符串或包含 nodeId 与 reason 的对象。`,
      400,
      { field: 'conflictReasons', index: idx },
    );
  });
}

function computeStatementPairComparison(baselineQuote, q) {
  const baseDirectSet = new Set(baselineQuote.directConflicts);
  const baseAffectedSet = new Set(baselineQuote.affected);
  const qDirectSet = new Set(q.directConflicts);
  const qAffectedSet = new Set(q.affected);

  const bothGrounded =
    baselineQuote.assessment !== 'insufficient_evidence' &&
    q.assessment !== 'insufficient_evidence';

  const deltaRate =
    !bothGrounded || baselineQuote.rate === null || q.rate === null
      ? null
      : q.rate - baselineQuote.rate;

  const resolvedConflicts = bothGrounded
    ? baselineQuote.directConflicts.filter((id) => !qDirectSet.has(id))
    : [];
  const resolvedAffected = bothGrounded
    ? baselineQuote.affected.filter((id) => !qAffectedSet.has(id))
    : [];
  const addedConflicts =
    q.assessment === 'insufficient_evidence'
      ? []
      : q.directConflicts.filter((id) => !baseDirectSet.has(id));
  const addedAffected =
    q.assessment === 'insufficient_evidence'
      ? []
      : q.affected.filter((id) => !baseAffectedSet.has(id));

  return {
    statementId: q.statementId,
    baselineStatementId: baselineQuote.statementId,
    baselineRate: baselineQuote.rate,
    rate: q.rate,
    deltaRate,
    baselineAssessment: baselineQuote.assessment,
    assessment: q.assessment,
    assessmentChanged: q.assessment !== baselineQuote.assessment,
    resolvedConflicts,
    addedConflicts,
    resolvedAffected,
    addedAffected,
  };
}

function builtinEvaluateStatementQuote({
  graph = [],
  graphVersion = 0,
  statementId = 'stmt_default',
  text = '',
  assessment = 'insufficient_evidence',
  directConflicts = [],
  conflictReasons = [],
  reason = '',
  verifiedEvidenceIds = [],
  ignoreUnknownConflicts = false,
} = {}) {
  if (!ASSESSMENT_SET.has(assessment)) {
    const err = new Error(`无效的 assessment 取值：${String(assessment)}`);
    err.code = 'INVALID_ASSESSMENT';
    throw err;
  }
  if (directConflicts !== undefined && directConflicts !== null && !Array.isArray(directConflicts) && !(directConflicts instanceof Set)) {
    throw new BackendServiceError('VERIFICATION_REJECTED', 'directConflicts 必须是字符串数组。', 400);
  }
  const normalizedEvidenceIds = validateStrictEvidenceIdList(
    verifiedEvidenceIds,
    'verifiedEvidenceIds',
  );
  const normalizedReasons = validateStrictConflictReasons(conflictReasons);

  const computedGraph = graph.length === 0 ? [] : builtinComputeGraph(graph);
  const validIds = new Set(computedGraph.map((n) => n.id));
  const denominator = computedGraph.reduce((sum, n) => sum + n.S, 0);

  const rawConflicts = directConflicts == null ? [] : [...directConflicts];
  const validConflicts = [];
  const conflictSet = new Set();
  const unknownNodeIds = [];

  for (const id of rawConflicts) {
    if (typeof id !== 'string' || !id.trim()) {
      if (!ignoreUnknownConflicts) {
        const err = new Error('directConflicts 包含无效节点 ID。');
        err.code = 'INVALID_CONFLICT_NODE';
        throw err;
      }
      continue;
    }
    if (!validIds.has(id)) {
      if (!ignoreUnknownConflicts) unknownNodeIds.push(id);
      continue;
    }
    if (!conflictSet.has(id)) {
      conflictSet.add(id);
      validConflicts.push(id);
    }
  }

  if (unknownNodeIds.length > 0) {
    const err = new Error(`directConflicts 包含当前图中不存在的节点 ID：${unknownNodeIds.join(', ')}。`);
    err.code = 'INVALID_CONFLICT_NODE';
    err.unknownNodeIds = unknownNodeIds;
    throw err;
  }

  if (assessment === 'insufficient_evidence') {
    return {
      statementId,
      text,
      graphVersion,
      assessment,
      rate: null,
      directConflicts: [],
      collateral: [],
      affected: [],
      numerator: 0,
      denominator,
      reason: reason || '',
      conflictReasons: [],
      verifiedEvidenceIds: normalizedEvidenceIds,
      interpretationNote: RATE_INTERPRETATION_NOTE,
    };
  }

  if (assessment === 'compatible') {
    return {
      statementId,
      text,
      graphVersion,
      assessment,
      rate: denominator === 0 ? null : 0,
      directConflicts: [],
      collateral: [],
      affected: [],
      numerator: 0,
      denominator,
      reason: reason || '',
      conflictReasons: [],
      verifiedEvidenceIds: normalizedEvidenceIds,
      interpretationNote: RATE_INTERPRETATION_NOTE,
    };
  }

  const dead = builtinCollapseAfter(conflictSet, computedGraph);
  const affected = [...dead];
  const collateral = affected.filter((id) => !conflictSet.has(id));
  const numerator = computedGraph
    .filter((n) => dead.has(n.id))
    .reduce((sum, n) => sum + n.S, 0);
  const rate = denominator === 0 ? null : Math.round((100 * numerator) / denominator);

  return {
    statementId,
    text,
    graphVersion,
    assessment,
    rate,
    directConflicts: validConflicts,
    collateral,
    affected,
    numerator,
    denominator,
    reason: reason || '',
    conflictReasons: normalizedReasons,
    verifiedEvidenceIds: normalizedEvidenceIds,
    interpretationNote: RATE_INTERPRETATION_NOTE,
  };
}

function builtinCompareStatementsOnGraph({
  graph = [],
  graphVersion = 0,
  statements = [],
  baselineStatementId = null,
  ignoreUnknownConflicts = false,
} = {}) {
  const computedGraph = graph.length === 0 ? [] : builtinComputeGraph(graph);
  const denominator = computedGraph.reduce((sum, n) => sum + n.S, 0);
  const totalNodes = computedGraph.length;

  if (statements.length === 0) {
    return {
      graphVersion,
      denominator,
      totalNodes,
      quotes: [],
      baselineStatementId: null,
      comparisons: [],
    };
  }

  const quotes = statements.map((stmt, idx) =>
    builtinEvaluateStatementQuote({
      statementId: stmt.statementId ?? `stmt_${idx}`,
      text: stmt.text ?? '',
      assessment: stmt.assessment ?? 'insufficient_evidence',
      directConflicts: stmt.directConflicts ?? [],
      conflictReasons: stmt.conflictReasons ?? [],
      reason: stmt.reason ?? '',
      verifiedEvidenceIds: stmt.verifiedEvidenceIds ?? [],
      ignoreUnknownConflicts: stmt.ignoreUnknownConflicts ?? ignoreUnknownConflicts,
      graph: computedGraph,
      graphVersion,
    }),
  );

  let resolvedBaselineId = baselineStatementId;
  if (resolvedBaselineId == null) {
    const markedIdx = statements.findIndex(
      (s) => s && (s.isBaseline === true || s.role === 'original'),
    );
    resolvedBaselineId = markedIdx >= 0 ? quotes[markedIdx].statementId : quotes[0].statementId;
  }
  const baselineQuote = quotes.find((q) => q.statementId === resolvedBaselineId) ?? quotes[0];

  const comparisons = quotes
    .filter((q) => q.statementId !== baselineQuote.statementId)
    .map((q) => computeStatementPairComparison(baselineQuote, q));

  return {
    graphVersion,
    denominator,
    totalNodes,
    quotes,
    baselineStatementId: baselineQuote.statementId,
    comparisons,
  };
}

export const builtinPricingEngine = Object.freeze({
  validateDag: builtinValidateDag,
  computeGraph: builtinComputeGraph,
  collapseAfter: builtinCollapseAfter,
  evaluateStatementQuote: builtinEvaluateStatementQuote,
  compareStatementsOnGraph: builtinCompareStatementsOnGraph,
});

function createEngineAdapter(injectedPricingEngine) {
  let cachedExternal = null;

  function getActiveEngine() {
    if (injectedPricingEngine === 'builtin') {
      return builtinPricingEngine;
    }
    if (injectedPricingEngine) {
      if (typeof injectedPricingEngine === 'function') {
        return {
          ...builtinPricingEngine,
          evaluateStatementQuote: injectedPricingEngine,
        };
      }
      return {
        validateDag: injectedPricingEngine.validateDag ?? builtinValidateDag,
        computeGraph: injectedPricingEngine.computeGraph ?? builtinComputeGraph,
        collapseAfter: injectedPricingEngine.collapseAfter ?? builtinCollapseAfter,
        evaluateStatementQuote:
          injectedPricingEngine.evaluateStatementQuote ?? builtinEvaluateStatementQuote,
        compareStatementsOnGraph:
          injectedPricingEngine.compareStatementsOnGraph ?? builtinCompareStatementsOnGraph,
      };
    }
    if (cachedExternal) return cachedExternal;
    if (existsSync(QUOTATION_ENGINE_ENTRY)) {
      try {
        const mod = requireModule(QUOTATION_ENGINE_ENTRY);
        if (mod && typeof mod.computeGraph === 'function') {
          cachedExternal = {
            validateDag: mod.validateDag ?? builtinValidateDag,
            computeGraph: mod.computeGraph,
            collapseAfter: mod.collapseAfter ?? builtinCollapseAfter,
            evaluateStatementQuote:
              mod.evaluateStatementQuote ?? builtinEvaluateStatementQuote,
            compareStatementsOnGraph:
              mod.compareStatementsOnGraph ?? builtinCompareStatementsOnGraph,
          };
          return cachedExternal;
        }
      } catch {
        // quotation-engine 尚未就绪或加载失败时平滑回退到内置纯算价引擎
      }
    }
    return builtinPricingEngine;
  }

  return {
    computeGraph(nodes) {
      try {
        if (Array.isArray(nodes) && nodes.length >= 2000 && !injectedPricingEngine) {
          return builtinComputeGraph(nodes);
        }
        return getActiveEngine().computeGraph(nodes);
      } catch (err) {
        if (err instanceof RangeError && !injectedPricingEngine) {
          try {
            return builtinComputeGraph(nodes);
          } catch (fallbackErr) {
            throw new BackendServiceError(
              'VERIFICATION_REJECTED',
              fallbackErr?.message || '已确认图结构校验失败。',
              400,
              fallbackErr?.errors ? { errors: fallbackErr.errors } : (fallbackErr?.details ?? null),
            );
          }
        }
        throw new BackendServiceError(
          'VERIFICATION_REJECTED',
          err?.message || '已确认图结构校验失败。',
          400,
          err?.errors ? { errors: err.errors } : (err?.details ?? null),
        );
      }
    },
    collapseAfter(removed, graph) {
      return getActiveEngine().collapseAfter(removed, graph);
    },
    evaluateStatementQuote(spec = {}) {
      try {
        const validatedReasons = validateStrictConflictReasons(spec.conflictReasons);
        const validatedEvidenceIds = validateStrictEvidenceIdList(
          spec.verifiedEvidenceIds,
          'verifiedEvidenceIds',
        );
        const cleanSpec = {
          ...spec,
          conflictReasons: validatedReasons,
          verifiedEvidenceIds: validatedEvidenceIds,
        };
        const raw = getActiveEngine().evaluateStatementQuote(cleanSpec);
        const numerator = raw.numerator ?? 0;
        const denominator = raw.denominator ?? 0;
        const assessment = raw.assessment;
        let rate = raw.rate ?? null;
        if (assessment === 'insufficient_evidence' || denominator === 0) {
          rate = null;
        } else if (assessment === 'compatible') {
          rate = 0;
        } else if (assessment === 'conflict' && !injectedPricingEngine) {
          rate = Math.round((100 * numerator) / denominator);
        }
        return {
          statementId: raw.statementId ?? spec.statementId,
          text: raw.text ?? spec.text ?? '',
          graphVersion: raw.graphVersion ?? spec.graphVersion ?? 0,
          assessment,
          rate,
          directConflicts: Array.isArray(raw.directConflicts) ? [...raw.directConflicts] : [],
          collateral: Array.isArray(raw.collateral)
            ? [...raw.collateral]
            : (Array.isArray(raw.collateralAffected) ? [...raw.collateralAffected] : []),
          affected: Array.isArray(raw.affected)
            ? [...raw.affected]
            : (Array.isArray(raw.affectedNodeIds) ? [...raw.affectedNodeIds] : []),
          numerator,
          denominator,
          reason: raw.reason ?? spec.reason ?? '',
          conflictReasons:
            assessment === 'conflict'
              ? (Array.isArray(raw.conflictReasons) ? validateStrictConflictReasons(raw.conflictReasons) : validatedReasons)
              : [],
          verifiedEvidenceIds: Array.isArray(raw.verifiedEvidenceIds)
            ? [...raw.verifiedEvidenceIds]
            : validatedEvidenceIds,
          interpretationNote: raw.interpretationNote ?? RATE_INTERPRETATION_NOTE,
        };
      } catch (err) {
        if (err instanceof BackendServiceError) throw err;
        throw new BackendServiceError(
          'VERIFICATION_REJECTED',
          err?.message || '句子报价核验失败。',
          400,
          err?.details ?? null,
        );
      }
    },
    compareStatementsOnGraph(spec = {}) {
      try {
        const cleanStatements = Array.isArray(spec.statements)
          ? spec.statements.map((stmt) => ({
              ...stmt,
              conflictReasons: validateStrictConflictReasons(stmt.conflictReasons),
              verifiedEvidenceIds: validateStrictEvidenceIdList(
                stmt.verifiedEvidenceIds,
                'verifiedEvidenceIds',
              ),
            }))
          : spec.statements;
        const raw =
          Array.isArray(spec.graph) && spec.graph.length >= 2000 && !injectedPricingEngine
            ? builtinCompareStatementsOnGraph({ ...spec, statements: cleanStatements })
            : getActiveEngine().compareStatementsOnGraph({ ...spec, statements: cleanStatements });
        const quotes = Array.isArray(raw.quotes)
          ? raw.quotes.map((q) => {
              const numerator = q.numerator ?? 0;
              const denominator = q.denominator ?? 0;
              let rate = q.rate ?? null;
              if (q.assessment === 'insufficient_evidence' || denominator === 0) {
                rate = null;
              } else if (q.assessment === 'compatible') {
                rate = 0;
              } else if (q.assessment === 'conflict' && !injectedPricingEngine) {
                rate = Math.round((100 * numerator) / denominator);
              }
              return {
                ...q,
                rate,
                conflictReasons:
                  q.assessment === 'conflict' && Array.isArray(q.conflictReasons)
                    ? validateStrictConflictReasons(q.conflictReasons)
                    : [],
              };
            })
          : [];
        if (quotes.length === 0) {
          return { ...raw, quotes: [], comparisons: [] };
        }
        const baselineQuote =
          quotes.find((q) => q.statementId === raw.baselineStatementId) ?? quotes[0];
        const comparisons = quotes
          .filter((q) => q.statementId !== baselineQuote.statementId)
          .map((q) => computeStatementPairComparison(baselineQuote, q));
        return {
          ...raw,
          quotes,
          baselineStatementId: baselineQuote.statementId,
          comparisons,
        };
      } catch (err) {
        if (err instanceof BackendServiceError) throw err;
        throw new BackendServiceError(
          'VERIFICATION_REJECTED',
          err?.message || '多句比较核验失败。',
          400,
          err?.details ?? null,
        );
      }
    },
  };
}

/* ---------- 图、事实、证据、句子的标准化辅助函数 ---------- */

function normalizeNodeRecord(rawNode) {
  if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) {
    throw new BackendServiceError('VERIFICATION_REJECTED', '图节点必须是对象。', 400);
  }
  const id = typeof rawNode.id === 'string' ? rawNode.id.trim() : '';
  const text = typeof rawNode.text === 'string' ? rawNode.text.trim() : '';
  if (!id || !text) {
    throw new BackendServiceError(
      'VERIFICATION_REJECTED',
      '图节点的 id 与 text 必须是非空字符串。',
      400,
    );
  }
  const rawDeps = Array.isArray(rawNode.deps)
    ? rawNode.deps
    : (Array.isArray(rawNode.dependsOn) ? rawNode.dependsOn : []);
  const deps = [];
  const seen = new Set();
  for (const dep of rawDeps) {
    if (typeof dep !== 'string' || !dep.trim()) {
      throw new BackendServiceError(
        'VERIFICATION_REJECTED',
        `节点 ${id} 存在无效依赖项。`,
        400,
      );
    }
    const cleanDep = dep.trim();
    if (seen.has(cleanDep)) {
      throw new BackendServiceError(
        'VERIFICATION_REJECTED',
        `节点 ${id} 存在重复依赖：${cleanDep}。`,
        400,
      );
    }
    seen.add(cleanDep);
    deps.push(cleanDep);
  }

  const validCluster =
    (typeof rawNode.cluster === 'string' && rawNode.cluster.trim().length > 0) ||
    (typeof rawNode.cluster === 'number' && Number.isFinite(rawNode.cluster))
      ? rawNode.cluster
      : 'default';

  return {
    ...cloneJson(rawNode),
    id,
    name: typeof rawNode.name === 'string' && rawNode.name.trim() ? rawNode.name.trim() : id,
    text,
    kind: typeof rawNode.kind === 'string' && rawNode.kind.trim() ? rawNode.kind.trim() : 'judgment',
    cluster: validCluster,
    deps,
    evidenceIds: Array.isArray(rawNode.evidenceIds)
      ? [...new Set(rawNode.evidenceIds.filter((e) => typeof e === 'string' && e.trim()))]
      : [],
    sourceFactIds: Array.isArray(rawNode.sourceFactIds)
      ? [...new Set(rawNode.sourceFactIds.filter((f) => typeof f === 'string' && f.trim()))]
      : [],
    conditionFactId:
      typeof rawNode.conditionFactId === 'string' && rawNode.conditionFactId.trim()
        ? rawNode.conditionFactId.trim()
        : null,
    status: 'active',
  };
}

function extractRawNodesFromGraph(graphInput) {
  if (!graphInput) return [];
  if (Array.isArray(graphInput)) {
    return graphInput.map(normalizeNodeRecord);
  }
  if (typeof graphInput === 'object' && Array.isArray(graphInput.nodes)) {
    const nodes = graphInput.nodes.map(normalizeNodeRecord);
    if (Array.isArray(graphInput.edges) && graphInput.edges.length > 0) {
      const byId = new Map(nodes.map((n) => [n.id, n]));
      for (const edge of graphInput.edges) {
        if (
          edge &&
          typeof edge.from === 'string' &&
          typeof edge.to === 'string' &&
          byId.has(edge.to)
        ) {
          const target = byId.get(edge.to);
          if (!target.deps.includes(edge.from)) {
            target.deps.push(edge.from);
          }
        }
      }
    }
    return nodes;
  }
  throw new BackendServiceError('VERIFICATION_REJECTED', 'confirmedGraph 结构无效。', 400);
}

function attachGraphMetadata(computedNodes, edges, totalWeight, graphVersion) {
  const arr = computedNodes.map((n) => ({ ...n }));
  Object.defineProperties(arr, {
    nodes: { value: arr, enumerable: false, configurable: true },
    edges: { value: edges, enumerable: false, configurable: true },
    nodeCount: { value: arr.length, enumerable: false, configurable: true },
    totalNodes: { value: arr.length, enumerable: false, configurable: true },
    totalWeight: { value: totalWeight, enumerable: false, configurable: true },
    graphVersion: { value: graphVersion, enumerable: false, configurable: true },
  });
  return arr;
}

function buildConfirmedGraphObject(rawNodes, graphVersion, engineAdapter) {
  const normalized = rawNodes.map(normalizeNodeRecord);
  const computedNodes = normalized.length === 0 ? [] : engineAdapter.computeGraph(normalized);
  const edges = [];
  for (const n of computedNodes) {
    for (const dep of n.deps) {
      edges.push({ from: dep, to: n.id, kind: 'supports' });
    }
  }
  const totalWeight = computedNodes.reduce((sum, n) => sum + n.S, 0);
  return attachGraphMetadata(computedNodes, edges, totalWeight, graphVersion);
}

function computeGraphDiff(prevNodes, nextNodes) {
  const prevById = new Map(prevNodes.map((n) => [n.id, n]));
  const nextById = new Map(nextNodes.map((n) => [n.id, n]));
  const addedNodes = [];
  const updatedNodes = [];
  const removedNodeIds = [];

  for (const n of nextNodes) {
    if (!prevById.has(n.id)) {
      addedNodes.push(cloneJson(n));
    } else {
      const prev = prevById.get(n.id);
      const prevComparable = {
        text: prev.text,
        kind: prev.kind,
        cluster: prev.cluster,
        deps: prev.deps,
        evidenceIds: prev.evidenceIds,
        sourceFactIds: prev.sourceFactIds,
        conditionFactId: prev.conditionFactId,
      };
      const nextComparable = {
        text: n.text,
        kind: n.kind,
        cluster: n.cluster,
        deps: n.deps,
        evidenceIds: n.evidenceIds,
        sourceFactIds: n.sourceFactIds,
        conditionFactId: n.conditionFactId,
      };
      if (stableStringify(prevComparable) !== stableStringify(nextComparable)) {
        updatedNodes.push(cloneJson(n));
      }
    }
  }
  for (const prev of prevNodes) {
    if (!nextById.has(prev.id)) {
      removedNodeIds.push(prev.id);
    }
  }
  return {
    addedNodes,
    updatedNodes,
    removedNodeIds,
    changed: addedNodes.length > 0 || updatedNodes.length > 0 || removedNodeIds.length > 0,
  };
}

function normalizeEvidenceItem(rawItem, deniedSet, fallbackTs) {
  if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
    throw new BackendServiceError('INVALID_ARGUMENTS', '证据条目必须是对象。', 400);
  }
  const evidenceId =
    typeof rawItem.evidenceId === 'string' && rawItem.evidenceId.trim()
      ? rawItem.evidenceId.trim()
      : typeof rawItem.id === 'string' && rawItem.id.trim()
        ? rawItem.id.trim()
        : typeof rawItem.contentId === 'string' && rawItem.contentId.trim()
          ? rawItem.contentId.trim()
          : null;
  if (!evidenceId) {
    throw new BackendServiceError('INVALID_ARGUMENTS', '证据条目必须包含非空 evidenceId 或 id。', 400);
  }
  const sourceType = rawItem.sourceType ?? 'collection_record';
  if (!EVIDENCE_SOURCE_SET.has(sourceType)) {
    throw new BackendServiceError(
      'INVALID_ARGUMENTS',
      `无效的证据来源类型：${String(sourceType)}。`,
      400,
    );
  }
  let attribution = rawItem.attribution ?? 'other_author';
  if (!ATTRIBUTION_SET.has(attribution)) {
    throw new BackendServiceError(
      'INVALID_ARGUMENTS',
      `无效的证据归属主体：${String(attribution)}。`,
      400,
    );
  }
  const excerpt =
    typeof rawItem.excerpt === 'string'
      ? rawItem.excerpt
      : typeof rawItem.snippet === 'string'
        ? rawItem.snippet
        : typeof rawItem.quote === 'string'
          ? rawItem.quote
          : typeof rawItem.summary === 'string'
            ? rawItem.summary
            : typeof rawItem.bodyText === 'string'
              ? rawItem.bodyText
              : '';

  const contentKey =
    typeof rawItem.contentKey === 'string' && rawItem.contentKey.trim()
      ? rawItem.contentKey.trim()
      : evidenceId;
  const denial = deniedSet.get(evidenceId) ?? deniedSet.get(contentKey) ?? null;
  let deniedSelfAttribution = Boolean(rawItem.deniedSelfAttribution);
  let author = typeof rawItem.author === 'string' ? rawItem.author : 'unknown';
  if (denial) {
    attribution = 'other_author';
    deniedSelfAttribution = true;
    if (denial.originalAuthor && (!author || author === 'self' || author === 'unknown')) {
      author = denial.originalAuthor;
    }
  }

  return {
    ...cloneJson(rawItem),
    id: evidenceId,
    evidenceId,
    contentKey,
    sourceType,
    author,
    attribution,
    deniedSelfAttribution,
    excerpt,
    locator: rawItem.locator ?? null,
    textKind: rawItem.textKind ?? 'full_text',
    truncated: Boolean(rawItem.truncated ?? rawItem.summaryTruncated),
    snapshotId: rawItem.snapshotId ?? null,
    turnId: rawItem.turnId ?? null,
    url: rawItem.url ?? null,
    createdAt: Number.isInteger(rawItem.createdAt) ? rawItem.createdAt : fallbackTs,
  };
}

function normalizeFactItem(rawFact, defaultTurnId, defaultTurnNumber, seqIndex) {
  if (!rawFact || typeof rawFact !== 'object' || Array.isArray(rawFact)) {
    throw new BackendServiceError('INVALID_ARGUMENTS', '事实条目必须是对象。', 400);
  }
  const id =
    typeof rawFact.id === 'string' && rawFact.id.trim()
      ? rawFact.id.trim()
      : `fact_${defaultTurnNumber ?? 0}_${seqIndex}`;
  const kind = rawFact.kind === 'condition' ? 'condition' : 'fact';
  const text = typeof rawFact.text === 'string' ? rawFact.text.trim() : '';
  if (!text) {
    throw new BackendServiceError('INVALID_ARGUMENTS', `事实 ${id} 的 text 不能为空。`, 400);
  }
  const rawEvIds = Array.isArray(rawFact.evidenceIds)
    ? rawFact.evidenceIds
    : (typeof rawFact.evidenceId === 'string' && rawFact.evidenceId.trim() ? [rawFact.evidenceId] : []);
  const parsedTurnNum = Number.isInteger(rawFact.turnNumber)
    ? rawFact.turnNumber
    : (parseTurnNumberReference(rawFact.turnId) ?? defaultTurnNumber ?? null);
  return {
    ...cloneJson(rawFact),
    id,
    kind,
    text,
    turnId: rawFact.turnId ?? defaultTurnId ?? null,
    turnNumber: parsedTurnNum,
    status: rawFact.status === 'retracted' ? 'retracted' : 'active',
    retractedByTurnId: rawFact.retractedByTurnId ?? null,
    targetFactId: rawFact.targetFactId ?? null,
    dependsOnFactIds: Array.isArray(rawFact.dependsOnFactIds)
      ? [...new Set(rawFact.dependsOnFactIds.filter((x) => typeof x === 'string' && x.trim()))]
      : [],
    evidenceIds: [...new Set(rawEvIds.filter((x) => typeof x === 'string' && x.trim()))],
    supportsDescription:
      typeof rawFact.supportsDescription === 'string' && rawFact.supportsDescription.trim()
        ? rawFact.supportsDescription.trim()
        : null,
  };
}

const FALLBACK_INSUFFICIENT_REASON =
  '原有冲突依据已撤回或当前缺少针对该主张的本人核验依据，维持未定。';

function sanitizeStoredReasonEntry(entry) {
  if (typeof entry === 'string' && entry.trim()) {
    return entry;
  }
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const nodeId = typeof entry.nodeId === 'string' ? entry.nodeId.trim() : '';
    const reasonText = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (!nodeId || !reasonText) return null;
    const cleaned = { ...cloneJson(entry), nodeId, reason: reasonText };
    if (entry.evidenceIds !== undefined) {
      if (Array.isArray(entry.evidenceIds)) {
        cleaned.evidenceIds = [
          ...new Set(entry.evidenceIds.filter((id) => typeof id === 'string' && id.trim())),
        ];
      } else {
        delete cleaned.evidenceIds;
      }
    }
    return cleaned;
  }
  return null;
}

function recomputeAllStatementsAndComparison({
  storedStatements,
  confirmedGraph,
  graphVersion,
  adoptedStatementId,
  engineAdapter,
  strictConflictValidationIds = new Set(),
  explicitlyUpdatedStatementIds = new Set(),
  facts = [],
}) {
  const nodes = confirmedGraph.nodes;
  const activeNodeIds = new Set(nodes.map((n) => n.id));

  const activeFacts = Array.isArray(facts)
    ? facts.filter((f) => f && f.status !== 'retracted')
    : [];
  const retractedFacts = Array.isArray(facts)
    ? facts.filter((f) => f && f.status === 'retracted')
    : [];

  const activeReferencedEvidenceIds = new Set();
  for (const f of activeFacts) {
    for (const eid of f.evidenceIds ?? []) {
      if (typeof eid === 'string' && eid.trim()) activeReferencedEvidenceIds.add(eid.trim());
    }
  }
  for (const n of nodes) {
    for (const eid of n.evidenceIds ?? []) {
      if (typeof eid === 'string' && eid.trim()) activeReferencedEvidenceIds.add(eid.trim());
    }
  }

  const retractedOnlyEvidenceIds = new Set();
  const retractedMarkers = [];
  for (const rf of retractedFacts) {
    if (typeof rf.id === 'string' && rf.id.trim()) retractedMarkers.push(rf.id.trim());
    if (typeof rf.text === 'string' && rf.text.trim()) retractedMarkers.push(rf.text.trim());
    for (const eid of rf.evidenceIds ?? []) {
      if (typeof eid === 'string' && eid.trim() && !activeReferencedEvidenceIds.has(eid.trim())) {
        retractedOnlyEvidenceIds.add(eid.trim());
      }
    }
  }

  const normalizedInputs = storedStatements.map((stmt, idx) => {
    const statementId =
      stmt.statementId ?? stmt.id ?? (idx === 0 ? 'stmt_original' : `stmt_rewrite_${idx}`);
    const role = stmt.role ?? (statementId === 'stmt_original' ? 'original' : 'rewrite');
    const strictCheck = strictConflictValidationIds.has(statementId);

    if (strictCheck) {
      if (stmt.conflictReasons !== undefined) {
        validateStrictConflictReasons(stmt.conflictReasons);
      }
      if (stmt.verifiedEvidenceIds !== undefined) {
        validateStrictEvidenceIdList(stmt.verifiedEvidenceIds, 'verifiedEvidenceIds');
      }
      if (stmt.compatibleNodeIds !== undefined) {
        const validCompIds = validateStrictEvidenceIdList(
          stmt.compatibleNodeIds,
          'compatibleNodeIds',
        );
        const missingComp = validCompIds.filter((id) => !activeNodeIds.has(id));
        if (missingComp.length > 0) {
          throw new BackendServiceError(
            'VERIFICATION_REJECTED',
            `句子 ${statementId} 的 compatibleNodeIds 引用了不存在的节点：${missingComp.join(', ')}。`,
            400,
            { statementId, unknownNodeIds: missingComp },
          );
        }
      }
    }

    const rawConflictsSource = Array.isArray(stmt.directConflicts)
      ? stmt.directConflicts
      : (Array.isArray(stmt.quote?.directConflicts) ? stmt.quote.directConflicts : []);
    const rawConflicts = rawConflictsSource;

    if (strictCheck) {
      const missing = rawConflicts.filter((id) => !activeNodeIds.has(id));
      if (missing.length > 0) {
        throw new BackendServiceError(
          'VERIFICATION_REJECTED',
          `句子 ${statementId} 的 directConflicts 引用了不存在的节点：${missing.join(', ')}。`,
          400,
          { statementId, unknownNodeIds: missing },
        );
      }
    }

    const hasExplicitCompatibleNodes = Array.isArray(stmt.compatibleNodeIds);
    const rawCompatibleNodes = hasExplicitCompatibleNodes
      ? [...new Set(stmt.compatibleNodeIds.filter((id) => typeof id === 'string' && id.trim()))]
      : [];
    const activeCompatibleNodes = rawCompatibleNodes.filter((id) => activeNodeIds.has(id));
    const hadCompatibleNodeBacking = Boolean(
      stmt.hadCompatibleNodeBacking || rawCompatibleNodes.length > 0,
    );

    const activeConflicts = rawConflicts.filter((id) => activeNodeIds.has(id));
    const isPending = Boolean(stmt.pendingStatus || stmt.status === 'pending_analysis');
    const initialAssessment =
      stmt.assessment ?? stmt.quote?.assessment ?? 'insufficient_evidence';

    let effectiveAssessment = initialAssessment;
    let downgradedToInsufficient = false;
    let downgradedFromConflictToCompatible = false;

    if (isPending) {
      effectiveAssessment = 'insufficient_evidence';
    } else if (initialAssessment === 'conflict' && activeConflicts.length === 0) {
      if (activeCompatibleNodes.length > 0) {
        effectiveAssessment = 'compatible';
        downgradedFromConflictToCompatible = true;
      } else {
        effectiveAssessment = 'insufficient_evidence';
        downgradedToInsufficient = true;
      }
    } else if (
      initialAssessment === 'compatible' &&
      hadCompatibleNodeBacking &&
      activeCompatibleNodes.length === 0
    ) {
      effectiveAssessment = 'insufficient_evidence';
      downgradedToInsufficient = true;
    } else if (activeConflicts.length > 0 && initialAssessment !== 'insufficient_evidence') {
      effectiveAssessment = 'conflict';
    }

    const rawReasonsSource = Array.isArray(stmt.conflictReasons)
      ? stmt.conflictReasons
      : (Array.isArray(stmt.quote?.conflictReasons) ? stmt.quote.conflictReasons : []);

    const removedReasonEvidenceIds = new Set();
    const activeReasonEvidenceIds = new Set();
    const activeReasons = [];

    for (const rawEntry of rawReasonsSource) {
      const entry = strictCheck ? rawEntry : sanitizeStoredReasonEntry(rawEntry);
      if (!entry) continue;
      if (typeof entry === 'object' && typeof entry.nodeId === 'string') {
        const keep =
          effectiveAssessment === 'conflict' &&
          activeNodeIds.has(entry.nodeId) &&
          (activeConflicts.length === 0 || activeConflicts.includes(entry.nodeId));
        if (keep) {
          const nextEntry = { ...entry };
          if (Array.isArray(entry.evidenceIds)) {
            nextEntry.evidenceIds = entry.evidenceIds.filter(
              (eid) => !retractedOnlyEvidenceIds.has(eid),
            );
            for (const eid of nextEntry.evidenceIds) activeReasonEvidenceIds.add(eid);
          }
          activeReasons.push(nextEntry);
        } else if (Array.isArray(entry.evidenceIds)) {
          for (const eid of entry.evidenceIds) removedReasonEvidenceIds.add(eid);
        }
      } else if (
        typeof entry === 'string' &&
        effectiveAssessment === 'conflict' &&
        activeConflicts.length > 0 &&
        !retractedMarkers.some((m) => m && entry.includes(m))
      ) {
        activeReasons.push(entry);
      }
    }

    const rawReason =
      typeof stmt.reason === 'string'
        ? stmt.reason
        : (typeof stmt.quote?.reason === 'string' ? stmt.quote.reason : '');
    const wasExplicitlyGivenFreshReason =
      explicitlyUpdatedStatementIds.has(statementId) &&
      typeof stmt.reason === 'string' &&
      stmt.reason.trim().length > 0 &&
      stmt.assessment === effectiveAssessment;

    let effectiveReason = rawReason;
    if (downgradedToInsufficient) {
      effectiveReason = wasExplicitlyGivenFreshReason ? rawReason : FALLBACK_INSUFFICIENT_REASON;
    } else if (downgradedFromConflictToCompatible) {
      effectiveReason = wasExplicitlyGivenFreshReason
        ? rawReason
        : '原有直接冲突依据已撤回，当前基于仍有效的本人相容依据判为相容。';
    } else if (
      effectiveAssessment === 'insufficient_evidence' &&
      !wasExplicitlyGivenFreshReason &&
      rawReason &&
      (retractedMarkers.some((m) => m && rawReason.includes(m)) ||
        rawConflicts.some((cid) => cid && rawReason.includes(cid)))
    ) {
      effectiveReason = FALLBACK_INSUFFICIENT_REASON;
    } else if (
      effectiveAssessment === 'conflict' &&
      rawConflicts.length > activeConflicts.length &&
      !wasExplicitlyGivenFreshReason &&
      rawReason
    ) {
      const removedConflictIds = rawConflicts.filter((id) => !activeNodeIds.has(id));
      const mentionsRemoved =
        removedConflictIds.some((id) => id && rawReason.includes(id)) ||
        retractedMarkers.some((m) => m && rawReason.includes(m));
      if (mentionsRemoved) {
        const rebuilt = activeReasons
          .map((r) => (typeof r === 'string' ? r : r.reason))
          .filter(Boolean)
          .join('；');
        effectiveReason = rebuilt || '当前仍存在已核验的本人冲突依据。';
      }
    }

    const rawVerifiedEvIds = Array.isArray(stmt.verifiedEvidenceIds)
      ? stmt.verifiedEvidenceIds
      : (Array.isArray(stmt.quote?.verifiedEvidenceIds) ? stmt.quote.verifiedEvidenceIds : []);

    let cleanedEvidenceIds;
    if (downgradedToInsufficient && !explicitlyUpdatedStatementIds.has(statementId)) {
      cleanedEvidenceIds = [];
    } else {
      cleanedEvidenceIds = [
        ...new Set(
          rawVerifiedEvIds.filter((eid) => {
            if (typeof eid !== 'string' || !eid.trim()) return false;
            const clean = eid.trim();
            if (retractedOnlyEvidenceIds.has(clean)) return false;
            if (
              removedReasonEvidenceIds.has(clean) &&
              !activeReasonEvidenceIds.has(clean) &&
              !activeReferencedEvidenceIds.has(clean)
            ) {
              return false;
            }
            return true;
          }),
        ),
      ];
    }

    return {
      raw: stmt,
      statementId,
      role,
      text: stmt.text ?? '',
      createdTurnId: stmt.createdTurnId ?? null,
      assessment: effectiveAssessment,
      pendingStatus: stmt.pendingStatus ?? (isPending ? 'PENDING_ANALYSIS' : null),
      status: isPending ? 'pending_analysis' : 'evaluated',
      directConflicts: effectiveAssessment === 'conflict' ? activeConflicts : [],
      rawDirectConflicts: rawConflicts,
      hasExplicitCompatibleNodes,
      compatibleNodeIds: activeCompatibleNodes,
      hadCompatibleNodeBacking,
      conflictReasons: effectiveAssessment === 'conflict' ? activeReasons : [],
      reason: effectiveReason,
      verifiedEvidenceIds: cleanedEvidenceIds,
      ignoreUnknownConflicts: !strictCheck,
    };
  });

  const comparisonRaw = engineAdapter.compareStatementsOnGraph({
    graph: nodes,
    graphVersion,
    statements: normalizedInputs,
    ignoreUnknownConflicts: true,
  });

  const quoteById = new Map(comparisonRaw.quotes.map((q) => [q.statementId, q]));

  const statements = normalizedInputs.map((item) => {
    const q = quoteById.get(item.statementId);
    const quoteObj = {
      statementId: item.statementId,
      text: q.text ?? item.text ?? '',
      graphVersion,
      assessment: q.assessment,
      rate: item.pendingStatus ? null : q.rate,
      directConflicts: q.directConflicts,
      collateral: q.collateral,
      affected: q.affected,
      numerator: q.numerator,
      denominator: q.denominator,
      reason: q.reason,
      conflictReasons: q.conflictReasons,
      verifiedEvidenceIds: q.verifiedEvidenceIds,
      interpretationNote: q.interpretationNote ?? RATE_INTERPRETATION_NOTE,
    };
    Object.defineProperties(quoteObj, {
      collateralAffected: { value: q.collateral, enumerable: false },
      collapsedNodes: { value: q.collateral, enumerable: false },
      affectedNodeIds: { value: q.affected, enumerable: false },
      pendingStatus: { value: item.pendingStatus, enumerable: false },
    });

    return {
      ...(item.raw.label ? { label: item.raw.label } : {}),
      ...(item.raw.rewriteKind ? { rewriteKind: item.raw.rewriteKind } : {}),
      ...(item.raw.focus ? { focus: item.raw.focus } : {}),
      ...(item.hasExplicitCompatibleNodes || item.hadCompatibleNodeBacking
        ? {
            compatibleNodeIds: item.compatibleNodeIds,
            hadCompatibleNodeBacking: item.hadCompatibleNodeBacking,
          }
        : {}),
      id: item.statementId,
      statementId: item.statementId,
      role: item.role,
      text: item.text,
      createdTurnId: item.createdTurnId,
      status: item.status,
      assessment: quoteObj.assessment,
      pendingStatus: item.pendingStatus,
      reason: quoteObj.reason,
      verifiedEvidenceIds: quoteObj.verifiedEvidenceIds,
      directConflicts: quoteObj.directConflicts,
      conflictReasons: quoteObj.conflictReasons,
      quote: quoteObj,
    };
  });

  const statementComparison = {
    graphVersion,
    denominator: comparisonRaw.denominator,
    totalNodes: comparisonRaw.totalNodes,
    baselineStatementId: comparisonRaw.baselineStatementId,
    adoptedStatementId: adoptedStatementId ?? null,
    quotes: comparisonRaw.quotes,
    comparisons: comparisonRaw.comparisons,
  };

  return { statements, statementComparison };
}

/* ---------- 精确撤回纯函数（可由编排器或测试独立调用，也可在 commitTurn 内原子执行） ---------- */

export function retractFact(
  sessionState,
  { targetRef, targetId, factId, currentTurnId = null, pricingEngine = null } = {},
) {
  if (!sessionState || typeof sessionState !== 'object') {
    throw new BackendServiceError('INVALID_ARGUMENTS', 'sessionState 必须是有效会话状态对象。', 400);
  }
  const effectiveRef = targetRef ?? targetId ?? factId;
  if (effectiveRef === undefined || effectiveRef === null || String(effectiveRef).trim() === '') {
    throw new BackendServiceError('INVALID_ARGUMENTS', '撤回操作必须指定 targetRef。', 400);
  }

  const engineAdapter = createEngineAdapter(pricingEngine);
  const rawRef = String(effectiveRef).trim();
  const refTurnNumber = parseTurnNumberReference(effectiveRef);
  const normalizedTurnId = refTurnNumber !== null ? `turn_${refTurnNumber}` : rawRef;

  const currentFacts = Array.isArray(sessionState.facts) ? cloneJson(sessionState.facts) : [];
  const rawNodes = extractRawNodesFromGraph(sessionState.confirmedGraph);
  const graphVersion = Number.isInteger(sessionState.graphVersion) ? sessionState.graphVersion : 0;

  // 1. 严格定位显式目标（匹配 factId、turnId 或明确轮次号；排除不属于当前会话的条目）
  const matchedFacts = currentFacts.filter((fact) => {
    if (!fact || typeof fact !== 'object') return false;
    if (
      fact.sessionId &&
      sessionState.sessionId &&
      fact.sessionId !== sessionState.sessionId
    ) {
      return false;
    }
    const matchById = fact.id === rawRef;
    const matchByTurnId = Boolean(fact.turnId && fact.turnId === normalizedTurnId);
    const matchByTurnNum =
      refTurnNumber !== null &&
      Number.isInteger(fact.turnNumber) &&
      fact.turnNumber === refTurnNumber;
    return matchById || matchByTurnId || matchByTurnNum;
  });

  if (matchedFacts.length === 0) {
    const unchangedGraph = buildConfirmedGraphObject(rawNodes, graphVersion, engineAdapter);
    return {
      found: false,
      alreadyRetracted: false,
      reasonCode: 'TARGET_NOT_FOUND',
      targetRef: rawRef,
      currentTurnId,
      retractedFacts: [],
      directlyInvalidatedNodeIds: [],
      cascadeInvalidatedNodeIds: [],
      invalidatedNodeIds: [],
      invalidatedItems: [],
      facts: currentFacts,
      confirmedGraph: unchangedGraph,
      graphMutated: false,
    };
  }

  const newlyRetractedFactIds = new Set(
    matchedFacts.filter((f) => f.status !== 'retracted').map((f) => f.id),
  );

  if (newlyRetractedFactIds.size === 0) {
    const unchangedGraph = buildConfirmedGraphObject(rawNodes, graphVersion, engineAdapter);
    return {
      found: true,
      alreadyRetracted: true,
      reasonCode: 'ALREADY_RETRACTED',
      targetRef: rawRef,
      currentTurnId,
      retractedFacts: [],
      directlyInvalidatedNodeIds: [],
      cascadeInvalidatedNodeIds: [],
      invalidatedNodeIds: [],
      invalidatedItems: [],
      facts: currentFacts,
      confirmedGraph: unchangedGraph,
      graphMutated: false,
    };
  }

  // 2. 若其他尚未撤回的事实在 dependsOnFactIds 上显式依赖被撤回事实，一并传递标为已撤回
  let factChanged = true;
  while (factChanged) {
    factChanged = false;
    for (const fact of currentFacts) {
      if (fact.status === 'retracted' || newlyRetractedFactIds.has(fact.id)) continue;
      if (
        Array.isArray(fact.dependsOnFactIds) &&
        fact.dependsOnFactIds.length > 0 &&
        fact.dependsOnFactIds.some((fid) => newlyRetractedFactIds.has(fid))
      ) {
        newlyRetractedFactIds.add(fact.id);
        factChanged = true;
      }
    }
  }

  const retractedFacts = [];
  const invalidatedItems = [];
  const nextFacts = currentFacts.map((fact) => {
    if (!newlyRetractedFactIds.has(fact.id)) return fact;
    const updated = {
      ...fact,
      status: 'retracted',
      retractedByTurnId: currentTurnId,
    };
    retractedFacts.push(updated);
    invalidatedItems.push({
      id: updated.id,
      kind: updated.kind,
      text: updated.text,
      reason: '用户主动撤回该事实或限定条件。',
      invalidationType: 'retracted_fact',
    });
    return updated;
  });

  // 3. 在当前已确认图上定位直接依赖已撤回事实/条件的节点
  const computedCurrentNodes =
    rawNodes.length === 0 ? [] : engineAdapter.computeGraph(rawNodes);
  const directInvalidatedReasons = new Map();

  for (const node of computedCurrentNodes) {
    if (node.conditionFactId && newlyRetractedFactIds.has(node.conditionFactId)) {
      directInvalidatedReasons.set(
        node.id,
        `直接依赖已撤回的限定条件（${node.conditionFactId}）。`,
      );
      continue;
    }
    if (Array.isArray(node.sourceFactIds) && node.sourceFactIds.length > 0) {
      const hitIds = node.sourceFactIds.filter((fid) => newlyRetractedFactIds.has(fid));
      if (hitIds.length > 0) {
        // 若节点所有来源事实均被撤回，或该来源事实本身是限定条件，或失去过半来源事实，则节点直接失效
        const retractedKindIsCondition = hitIds.some((fid) => {
          const f = currentFacts.find((item) => item.id === fid);
          return f?.kind === 'condition';
        });
        const remainingSources = node.sourceFactIds.length - hitIds.length;
        if (
          retractedKindIsCondition ||
          remainingSources === 0 ||
          remainingSources / node.sourceFactIds.length < 0.5
        ) {
          directInvalidatedReasons.set(
            node.id,
            `直接依据已撤回的事实或限定条件（${hitIds.join(', ')}）。`,
          );
        }
      }
    }
  }

  // 4. 在依赖图上执行级联坍塌（失去过半上游支撑节点即连带失效；恰好保留一半则继续成立）
  const directSet = new Set(directInvalidatedReasons.keys());
  const deadNodeSet =
    directSet.size > 0
      ? engineAdapter.collapseAfter(directSet, computedCurrentNodes)
      : new Set();

  const directlyInvalidatedNodeIds = [];
  const cascadeInvalidatedNodeIds = [];

  for (const node of computedCurrentNodes) {
    if (!deadNodeSet.has(node.id)) continue;
    if (directSet.has(node.id)) {
      directlyInvalidatedNodeIds.push(node.id);
      invalidatedItems.push({
        id: node.id,
        kind: node.kind || 'judgment',
        text: node.text,
        reason: directInvalidatedReasons.get(node.id),
        invalidationType: 'direct_node',
      });
    } else {
      cascadeInvalidatedNodeIds.push(node.id);
      invalidatedItems.push({
        id: node.id,
        kind: node.kind || 'judgment',
        text: node.text,
        reason: '上游支撑节点失效超过半数，结论连带失效。',
        invalidationType: 'cascade_node',
      });
    }
  }

  // 5. 移除失效节点并清理幸存节点对已失效节点的悬空边，重算承重 S 与深度 d
  const survivingRawNodes = computedCurrentNodes
    .filter((n) => !deadNodeSet.has(n.id))
    .map((n) => {
      const cleaned = {
        ...n,
        deps: n.deps.filter((depId) => !deadNodeSet.has(depId)),
        sourceFactIds: Array.isArray(n.sourceFactIds)
          ? n.sourceFactIds.filter((fid) => !newlyRetractedFactIds.has(fid))
          : [],
      };
      delete cleaned.S;
      delete cleaned.d;
      delete cleaned.depsOf;
      return cleaned;
    });

  const nextGraphVersion = deadNodeSet.size > 0 ? graphVersion + 1 : graphVersion;
  const nextConfirmedGraph = buildConfirmedGraphObject(
    survivingRawNodes,
    nextGraphVersion,
    engineAdapter,
  );

  return {
    found: true,
    alreadyRetracted: false,
    reasonCode: null,
    targetRef: rawRef,
    currentTurnId,
    retractedFacts,
    directlyInvalidatedNodeIds,
    cascadeInvalidatedNodeIds,
    invalidatedNodeIds: [...deadNodeSet],
    invalidatedItems,
    facts: nextFacts,
    confirmedGraph: nextConfirmedGraph,
    graphMutated: deadNodeSet.size > 0,
  };
}

function normalizeUsePersonalMaterialsValue(rawVal, materialsStatus, metadata) {
  if (typeof rawVal === 'boolean') return rawVal;
  if (rawVal === 1) return true;
  if (rawVal === 0) return false;
  if (typeof metadata?.usePersonalMaterials === 'boolean') return metadata.usePersonalMaterials;
  if (materialsStatus && typeof materialsStatus === 'object' && materialsStatus.state === 'disabled_by_user') {
    return false;
  }
  return true;
}

function normalizeCloudConsentValue(rawVal, metadata) {
  if (typeof rawVal === 'boolean') return rawVal;
  if (rawVal === 1) return true;
  if (rawVal === 0) return false;
  if (rawVal === null) return null;
  if (typeof metadata?.cloudConsent === 'boolean') return metadata.cloudConsent;
  if (metadata?.cloudConsent === null) return null;
  return null;
}

function normalizeMaterialsStatusObject(
  rawStatus,
  { usePersonalMaterials = true, lockedSnapshotId = null, evidenceCount = 0 } = {},
) {
  if (rawStatus && typeof rawStatus === 'object' && !Array.isArray(rawStatus)) {
    const cloned = cloneJson(rawStatus);
    if (!cloned.state) {
      cloned.state =
        usePersonalMaterials === false
          ? 'disabled_by_user'
          : evidenceCount > 0 || lockedSnapshotId
            ? 'loaded'
            : 'unconfigured';
    }
    return cloned;
  }
  if (usePersonalMaterials === false) {
    return {
      state: 'disabled_by_user',
      source: 'none',
      count: 0,
      message: '本次会话已按请求跳过个人采集材料，直接从本人输入开始。',
    };
  }
  if (evidenceCount > 0 || lockedSnapshotId) {
    return {
      state: 'loaded',
      source: 'collection',
      count: evidenceCount,
      lockedSnapshotId: lockedSnapshotId ?? null,
    };
  }
  return {
    state: 'unconfigured',
    source: 'none',
    count: 0,
  };
}

function ensureSessionTableColumns(db) {
  const cols = new Set(
    db.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name),
  );
  if (!cols.has('use_personal_materials')) {
    db.exec('ALTER TABLE sessions ADD COLUMN use_personal_materials INTEGER');
  }
  if (!cols.has('cloud_consent')) {
    db.exec('ALTER TABLE sessions ADD COLUMN cloud_consent INTEGER');
  }
  if (!cols.has('materials_status_json')) {
    db.exec('ALTER TABLE sessions ADD COLUMN materials_status_json TEXT');
  }
  if (!cols.has('metadata_json')) {
    db.exec('ALTER TABLE sessions ADD COLUMN metadata_json TEXT');
  }
}

/* ---------- SQLite 会话存储主工厂 ---------- */

export function createSessionStore(filenameOrOptions = ':memory:', maybeOptions = {}) {
  let filename = filenameOrOptions;
  let options = maybeOptions ?? {};
  if (filenameOrOptions && typeof filenameOrOptions === 'object' && !Array.isArray(filenameOrOptions)) {
    options = filenameOrOptions;
    filename = filenameOrOptions.filename ?? filenameOrOptions.dbPath ?? ':memory:';
  }
  const { now = Date.now, pricingEngine = null } = options;

  if (typeof filename !== 'string' || !filename.trim()) {
    throw new BackendServiceError('INVALID_ARGUMENTS', '数据库路径必须是非空字符串。', 400);
  }
  const isMemoryDb = filename === ':memory:' || filename.startsWith('file::memory:');
  const resolvedPath = isMemoryDb ? filename : resolve(filename);
  if (!isMemoryDb) {
    mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  }

  const db = new DatabaseSync(resolvedPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      data_mode TEXT NOT NULL,
      locked_snapshot_id TEXT,
      use_personal_materials INTEGER,
      cloud_consent INTEGER,
      materials_status_json TEXT,
      metadata_json TEXT,
      graph_version INTEGER NOT NULL DEFAULT 0,
      active_turn_id TEXT,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_owner
      ON sessions (owner_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS session_evidence (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      evidence_id TEXT NOT NULL,
      dedupe_key TEXT,
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (session_id, evidence_id)
    );

    CREATE INDEX IF NOT EXISTS idx_session_evidence_order
      ON session_evidence (session_id, created_at ASC, sort_order ASC, evidence_id ASC);

    CREATE TABLE IF NOT EXISTS turns (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      client_request_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      intent TEXT,
      user_text TEXT NOT NULL,
      focus_ref_json TEXT,
      action_json TEXT,
      response_text TEXT NOT NULL DEFAULT '',
      base_graph_version INTEGER NOT NULL,
      committed_graph_version INTEGER,
      graph_mutated INTEGER NOT NULL DEFAULT 0,
      commit_payload_json TEXT,
      error_json TEXT,
      metrics_json TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY (session_id, turn_id),
      UNIQUE (session_id, client_request_id),
      UNIQUE (session_id, turn_number)
    );

    CREATE INDEX IF NOT EXISTS idx_turns_session_status
      ON turns (session_id, status, turn_number ASC);

    CREATE TABLE IF NOT EXISTS turn_events (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, turn_id, seq),
      FOREIGN KEY (session_id, turn_id) REFERENCES turns(session_id, turn_id) ON DELETE CASCADE
    );
  `);

  ensureSessionTableColumns(db);

  const engineAdapter = createEngineAdapter(pricingEngine);
  const listenersByTurnKey = new Map();
  let inTransaction = false;
  let pendingBroadcasts = [];
  let closed = false;

  const stmts = {
    insertSession: db.prepare(`
      INSERT INTO sessions (
        session_id, owner_id, data_mode, locked_snapshot_id,
        use_personal_materials, cloud_consent, materials_status_json, metadata_json,
        graph_version, active_turn_id, state_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getSessionById: db.prepare(`
      SELECT * FROM sessions WHERE session_id = ?
    `),
    updateSessionState: db.prepare(`
      UPDATE sessions
      SET locked_snapshot_id = ?,
          use_personal_materials = ?,
          cloud_consent = ?,
          materials_status_json = ?,
          metadata_json = ?,
          graph_version = ?,
          active_turn_id = ?,
          state_json = ?,
          updated_at = ?
      WHERE session_id = ?
    `),
    updateSessionActiveTurn: db.prepare(`
      UPDATE sessions
      SET active_turn_id = ?, state_json = ?, updated_at = ?
      WHERE session_id = ?
    `),
    clearActiveTurnOnly: db.prepare(`
      UPDATE sessions
      SET active_turn_id = NULL, updated_at = ?
      WHERE session_id = ?
    `),
    selectEvidenceBySession: db.prepare(`
      SELECT * FROM session_evidence
      WHERE session_id = ?
      ORDER BY created_at ASC, sort_order ASC, evidence_id ASC
    `),
    getEvidenceById: db.prepare(`
      SELECT * FROM session_evidence
      WHERE session_id = ? AND evidence_id = ?
    `),
    getEvidenceByDedupeKey: db.prepare(`
      SELECT * FROM session_evidence
      WHERE session_id = ? AND dedupe_key = ?
      ORDER BY sort_order ASC LIMIT 1
    `),
    maxEvidenceSortOrder: db.prepare(`
      SELECT COALESCE(MAX(sort_order), 0) AS max_order
      FROM session_evidence
      WHERE session_id = ?
    `),
    upsertEvidenceRow: db.prepare(`
      INSERT INTO session_evidence (
        session_id, evidence_id, dedupe_key, sort_order, created_at, updated_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, evidence_id) DO UPDATE SET
        dedupe_key = excluded.dedupe_key,
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json
    `),
    getTurnByClientReq: db.prepare(`
      SELECT * FROM turns
      WHERE session_id = ? AND client_request_id = ?
    `),
    getTurnById: db.prepare(`
      SELECT * FROM turns
      WHERE session_id = ? AND turn_id = ?
    `),
    listTurnsBySession: db.prepare(`
      SELECT * FROM turns
      WHERE session_id = ?
      ORDER BY turn_number ASC
    `),
    listRunningTurns: db.prepare(`
      SELECT * FROM turns
      WHERE status = 'running'
      ORDER BY created_at ASC, turn_number ASC
    `),
    listOrphanActiveSessions: db.prepare(`
      SELECT s.session_id, s.active_turn_id
      FROM sessions s
      LEFT JOIN turns t
        ON s.session_id = t.session_id AND s.active_turn_id = t.turn_id
      WHERE s.active_turn_id IS NOT NULL
        AND (t.turn_id IS NULL OR t.status != 'running')
    `),
    insertTurn: db.prepare(`
      INSERT INTO turns (
        session_id, turn_id, turn_number, client_request_id, request_fingerprint,
        status, intent, user_text, focus_ref_json, action_json, response_text,
        base_graph_version, committed_graph_version, graph_mutated,
        commit_payload_json, error_json, metrics_json, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateTurnCommitted: db.prepare(`
      UPDATE turns
      SET status = 'committed',
          intent = ?,
          response_text = ?,
          committed_graph_version = ?,
          graph_mutated = ?,
          commit_payload_json = ?,
          metrics_json = ?,
          completed_at = ?
      WHERE session_id = ? AND turn_id = ?
    `),
    updateTurnTerminated: db.prepare(`
      UPDATE turns
      SET status = ?,
          error_json = ?,
          metrics_json = COALESCE(?, metrics_json),
          completed_at = ?
      WHERE session_id = ? AND turn_id = ?
    `),
    maxEventSeq: db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS max_seq
      FROM turn_events
      WHERE session_id = ? AND turn_id = ?
    `),
    insertTurnEvent: db.prepare(`
      INSERT INTO turn_events (
        session_id, turn_id, seq, event_type, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `),
    listTurnEventsAfter: db.prepare(`
      SELECT seq, event_type, payload_json, created_at
      FROM turn_events
      WHERE session_id = ? AND turn_id = ? AND seq > ?
      ORDER BY seq ASC
    `),
    listDeltaEvents: db.prepare(`
      SELECT payload_json
      FROM turn_events
      WHERE session_id = ? AND turn_id = ? AND event_type = 'text.delta'
      ORDER BY seq ASC
    `),
    listSessionsByOwner: db.prepare(`
      SELECT session_id FROM sessions WHERE owner_id = ?
    `),
    deleteSessionsByOwner: db.prepare(`
      DELETE FROM sessions WHERE owner_id = ?
    `),
  };

  function ensureOpen() {
    if (closed) {
      throw new BackendServiceError('INTERNAL_ERROR', '会话存储已关闭。', 500);
    }
  }

  function runInImmediateTransaction(fn) {
    ensureOpen();
    if (inTransaction) {
      return fn();
    }
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    pendingBroadcasts = [];
    try {
      const result = fn();
      db.exec('COMMIT');
      inTransaction = false;
      const toDispatch = pendingBroadcasts;
      pendingBroadcasts = [];
      for (const item of toDispatch) {
        dispatchEventToSubscribers(item.sessionId, item.turnId, item.eventRecord);
      }
      return result;
    } catch (err) {
      inTransaction = false;
      pendingBroadcasts = [];
      try {
        db.exec('ROLLBACK');
      } catch {
        // 忽略回滚二次异常
      }
      throw err;
    }
  }

  function turnKey(sessionId, turnId) {
    return `${sessionId}::${turnId}`;
  }

  function dispatchEventToSubscribers(sessionId, turnId, eventRecord) {
    const key = turnKey(sessionId, turnId);
    const set = listenersByTurnKey.get(key);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      try {
        listener(cloneJson(eventRecord));
      } catch {
        // 单个订阅者异常不影响持久化状态或其他订阅者
      }
    }
  }

  function validateOwnerId(ownerId, forCreate = false) {
    if (typeof ownerId !== 'string' || !ownerId.trim()) {
      throw new BackendServiceError(
        forCreate ? 'INVALID_ARGUMENTS' : 'UNAUTHORIZED',
        forCreate ? 'ownerId 必须是非空字符串。' : '缺少有效的用户身份标识。',
        forCreate ? 400 : 401,
      );
    }
    return ownerId.trim();
  }

  function validateDataMode(dataMode) {
    if (!DATA_MODE_SET.has(dataMode)) {
      throw new BackendServiceError(
        'INVALID_ARGUMENTS',
        `无效的 dataMode：${String(dataMode)}。必须为 demo 或 real。`,
        400,
      );
    }
  }

  function requireSessionByIdInternal(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new BackendServiceError('SESSION_NOT_FOUND', '会话不存在。', 404);
    }
    const row = stmts.getSessionById.get(sessionId.trim());
    if (!row) {
      throw new BackendServiceError('SESSION_NOT_FOUND', '会话不存在。', 404);
    }
    return row;
  }

  function requireSessionAccess(ownerId, sessionId, expectedDataMode) {
    const cleanOwner = validateOwnerId(ownerId, false);
    const row = requireSessionByIdInternal(sessionId);
    if (row.owner_id !== cleanOwner) {
      throw new BackendServiceError(
        'SESSION_FORBIDDEN',
        '无权访问其他用户的会话。',
        403,
      );
    }
    if (expectedDataMode !== undefined && expectedDataMode !== null) {
      if (row.data_mode !== expectedDataMode) {
        throw new BackendServiceError(
          'DATA_MODE_MISMATCH',
          '演示数据与真实数据模式隔离，禁止混用。',
          403,
          { sessionDataMode: row.data_mode, expectedDataMode },
        );
      }
    }
    return row;
  }

  function formatTurnSummary(row) {
    if (!row) return null;
    return {
      turnId: row.turn_id,
      turnNumber: row.turn_number,
      clientRequestId: row.client_request_id,
      status: row.status,
      intent: row.intent ?? null,
      text: row.user_text,
      userText: row.user_text,
      focusRef: row.focus_ref_json ? JSON.parse(row.focus_ref_json) : null,
      action: row.action_json ? JSON.parse(row.action_json) : null,
      responseText: row.response_text ?? '',
      baseGraphVersion: row.base_graph_version,
      committedGraphVersion:
        row.committed_graph_version === null || row.committed_graph_version === undefined
          ? null
          : row.committed_graph_version,
      graphMutated: Boolean(row.graph_mutated),
      createdAt: row.created_at,
      completedAt: row.completed_at ?? null,
      error: row.error_json ? JSON.parse(row.error_json) : null,
    };
  }

  function buildDeniedMap(deniedAttributions = []) {
    const map = new Map();
    for (const entry of deniedAttributions) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.evidenceId === 'string' && entry.evidenceId.trim()) {
        map.set(entry.evidenceId.trim(), entry);
      }
      if (typeof entry.contentKey === 'string' && entry.contentKey.trim()) {
        map.set(entry.contentKey.trim(), entry);
      }
    }
    return map;
  }

  function computeEvidenceDedupeKey(item) {
    // 同一来源、同一作者与完全相同的摘要片段重复命中只算一份证据；不同作者严格区分
    const excerpt = typeof item.excerpt === 'string' ? item.excerpt.trim() : '';
    if (!excerpt) return null;
    const locatorKey = item.url || item.snapshotId || '';
    return `${item.sourceType}::${item.author}::${item.textKind}::${locatorKey}::${excerpt}`;
  }

  function upsertEvidenceInternal(sessionRow, state, evidenceItems, ts) {
    if (!Array.isArray(evidenceItems) || evidenceItems.length === 0) {
      return [];
    }
    const deniedMap = buildDeniedMap(state.deniedAttributions);
    let nextSortOrder = stmts.maxEvidenceSortOrder.get(sessionRow.session_id).max_order;
    const saved = [];

    for (const raw of evidenceItems) {
      const normalized = normalizeEvidenceItem(raw, deniedMap, ts);
      const dedupeKey = computeEvidenceDedupeKey(normalized);

      let existingRow = stmts.getEvidenceById.get(
        sessionRow.session_id,
        normalized.evidenceId,
      );
      if (!existingRow && dedupeKey) {
        const dupRow = stmts.getEvidenceByDedupeKey.get(
          sessionRow.session_id,
          dedupeKey,
        );
        if (dupRow) {
          existingRow = dupRow;
          normalized.id = dupRow.evidence_id;
          normalized.evidenceId = dupRow.evidence_id;
          // 再次检查已复用 ID 是否在否认归属列表中
          const dupDenial = deniedMap.get(dupRow.evidence_id);
          if (dupDenial) {
            normalized.attribution = 'other_author';
            normalized.deniedSelfAttribution = true;
            if (
              dupDenial.originalAuthor &&
              (!normalized.author || normalized.author === 'self' || normalized.author === 'unknown')
            ) {
              normalized.author = dupDenial.originalAuthor;
            }
          }
        }
      }

      let createdAt = normalized.createdAt;
      let sortOrder;
      if (existingRow) {
        const prevPayload = JSON.parse(existingRow.payload_json);
        createdAt = existingRow.created_at;
        sortOrder = existingRow.sort_order;
        if (prevPayload.deniedSelfAttribution) {
          normalized.attribution = 'other_author';
          normalized.deniedSelfAttribution = true;
          if (prevPayload.author && prevPayload.author !== 'self') {
            normalized.author = prevPayload.author;
          }
        }
        normalized.createdAt = createdAt;
      } else {
        nextSortOrder += 1;
        sortOrder = nextSortOrder;
      }

      stmts.upsertEvidenceRow.run(
        sessionRow.session_id,
        normalized.evidenceId,
        dedupeKey,
        sortOrder,
        createdAt,
        ts,
        JSON.stringify(normalized),
      );
      saved.push(normalized);
    }
    return saved;
  }

  function appendEventInternal(sessionId, turnId, eventType, payload, ts) {
    if (!SSE_EVENT_SET.has(eventType)) {
      throw new BackendServiceError(
        'INVALID_ARGUMENTS',
        `不支持的 SSE 事件类型：${String(eventType)}。`,
        400,
      );
    }
    const maxSeqRow = stmts.maxEventSeq.get(sessionId, turnId);
    const nextSeq = (maxSeqRow?.max_seq ?? 0) + 1;
    const cleanPayload = payload === undefined ? {} : cloneJson(payload);
    stmts.insertTurnEvent.run(
      sessionId,
      turnId,
      nextSeq,
      eventType,
      JSON.stringify(cleanPayload),
      ts,
    );
    const eventRecord = {
      id: nextSeq,
      seq: nextSeq,
      event: eventType,
      eventType,
      type: eventType,
      data: cleanPayload,
      payload: cleanPayload,
      createdAt: ts,
    };
    if (inTransaction) {
      pendingBroadcasts.push({ sessionId, turnId, eventRecord });
    } else {
      dispatchEventToSubscribers(sessionId, turnId, eventRecord);
    }
    return eventRecord;
  }

  function resolvePersistedSessionConfig(sessionRow, state) {
    const metadata =
      sessionRow.metadata_json
        ? JSON.parse(sessionRow.metadata_json)
        : (state.metadata && typeof state.metadata === 'object' ? state.metadata : {});
    const rawMaterialsStatus =
      sessionRow.materials_status_json
        ? JSON.parse(sessionRow.materials_status_json)
        : (state.materialsStatus ?? metadata?.materialsStatus ?? null);

    const usePersonalMaterials =
      sessionRow.use_personal_materials === 0 || sessionRow.use_personal_materials === 1
        ? sessionRow.use_personal_materials === 1
        : typeof state.usePersonalMaterials === 'boolean'
          ? state.usePersonalMaterials
          : normalizeUsePersonalMaterialsValue(undefined, rawMaterialsStatus, metadata);

    let cloudConsent;
    if (sessionRow.cloud_consent === 0 || sessionRow.cloud_consent === 1) {
      cloudConsent = sessionRow.cloud_consent === 1;
    } else if (typeof state.cloudConsent === 'boolean') {
      cloudConsent = state.cloudConsent;
    } else if (state.cloudConsent === null && sessionRow.cloud_consent === null) {
      cloudConsent = null;
    } else {
      cloudConsent = normalizeCloudConsentValue(undefined, metadata);
    }

    const materialsStatus = normalizeMaterialsStatusObject(rawMaterialsStatus, {
      usePersonalMaterials,
      lockedSnapshotId: sessionRow.locked_snapshot_id ?? null,
    });

    return {
      usePersonalMaterials,
      cloudConsent,
      materialsStatus,
      metadata: cloneJson(metadata ?? {}),
    };
  }

  function buildFullSessionSnapshot(sessionRow) {
    const state = JSON.parse(sessionRow.state_json);
    const graphVersion = sessionRow.graph_version;
    const rawNodes = extractRawNodesFromGraph(state.confirmedGraph);
    const confirmedGraph = buildConfirmedGraphObject(
      rawNodes,
      graphVersion,
      engineAdapter,
    );
    const storedFacts = Array.isArray(state.facts) ? state.facts : [];

    const { statements, statementComparison } = recomputeAllStatementsAndComparison({
      storedStatements: Array.isArray(state.statements) ? state.statements : [],
      confirmedGraph,
      graphVersion,
      adoptedStatementId: state.adoptedStatementId ?? null,
      engineAdapter,
      strictConflictValidationIds: new Set(),
      facts: storedFacts,
    });

    const evidenceRows = stmts.selectEvidenceBySession.all(sessionRow.session_id);
    const evidenceIndex = evidenceRows.map((r) => JSON.parse(r.payload_json));

    const turnRows = stmts.listTurnsBySession.all(sessionRow.session_id);
    const turns = turnRows.map(formatTurnSummary);

    const persistedCfg = resolvePersistedSessionConfig(sessionRow, state);
    if (
      persistedCfg.materialsStatus.state === 'unconfigured' &&
      persistedCfg.usePersonalMaterials !== false &&
      (evidenceIndex.length > 0 || sessionRow.locked_snapshot_id)
    ) {
      persistedCfg.materialsStatus = normalizeMaterialsStatusObject(null, {
        usePersonalMaterials: persistedCfg.usePersonalMaterials,
        lockedSnapshotId: sessionRow.locked_snapshot_id ?? null,
        evidenceCount: evidenceIndex.length,
      });
    }

    return {
      sessionId: sessionRow.session_id,
      ownerId: sessionRow.owner_id,
      dataMode: sessionRow.data_mode,
      snapshotId: sessionRow.locked_snapshot_id ?? null,
      lockedSnapshotId: sessionRow.locked_snapshot_id ?? null,
      usePersonalMaterials: persistedCfg.usePersonalMaterials,
      cloudConsent: persistedCfg.cloudConsent,
      allowCloudModel: persistedCfg.cloudConsent,
      materialsStatus: persistedCfg.materialsStatus,
      graphVersion,
      activeTurnId: sessionRow.active_turn_id ?? null,
      currentFocus: state.currentFocus ?? null,
      confirmedGraph,
      confirmedGraphSummary: {
        nodeCount: confirmedGraph.nodeCount,
        totalNodes: confirmedGraph.totalNodes,
        totalWeight: confirmedGraph.totalWeight,
        edges: confirmedGraph.edges,
        graphVersion,
      },
      pendingConfirmations: Array.isArray(state.pendingConfirmations)
        ? cloneJson(state.pendingConfirmations)
        : [],
      deniedAttributions: Array.isArray(state.deniedAttributions)
        ? cloneJson(state.deniedAttributions)
        : [],
      facts: cloneJson(storedFacts),
      evidenceIndex,
      statements,
      quotes: statements.map((s) => s.quote),
      statementComparison,
      adoptedStatementId: state.adoptedStatementId ?? null,
      invalidatedHistory: Array.isArray(state.invalidatedHistory)
        ? cloneJson(state.invalidatedHistory)
        : [],
      convergenceSummary: state.convergenceSummary ? cloneJson(state.convergenceSummary) : null,
      publicAnalysis: state.publicAnalysis ? cloneJson(state.publicAnalysis) : null,
      confirmedOutboundPreviewId:
        typeof state.confirmedOutboundPreviewId === 'string' && state.confirmedOutboundPreviewId.trim()
          ? state.confirmedOutboundPreviewId.trim()
          : null,
      confirmedOutboundSnippets: Array.isArray(state.confirmedOutboundSnippets)
        ? cloneJson(state.confirmedOutboundSnippets)
        : [],
      outboundPreview: state.outboundPreview ? cloneJson(state.outboundPreview) : null,
      metadata: persistedCfg.metadata,
      turns,
      createdAt: sessionRow.created_at,
      updatedAt: sessionRow.updated_at,
    };
  }

  /* ---------- 1. 启动崩溃恢复：recoverInterruptedTurns ---------- */
  function recoverInterruptedTurns() {
    return runInImmediateTransaction(() => {
      const ts = now();
      const runningTurns = stmts.listRunningTurns.all();
      const recoveredTurnIds = [];

      for (const turnRow of runningTurns) {
        const sessionRow = stmts.getSessionById.get(turnRow.session_id);
        const preservedGraphVersion = sessionRow?.graph_version ?? turnRow.base_graph_version;
        const interruptError = {
          code: 'INTERNAL_ERROR',
          reason: 'PROCESS_INTERRUPTED',
          message: '服务进程在提交前中断，已保留上一有效图版本。',
        };
        stmts.updateTurnTerminated.run(
          'interrupted',
          JSON.stringify(interruptError),
          null,
          ts,
          turnRow.session_id,
          turnRow.turn_id,
        );
        if (sessionRow) {
          stmts.clearActiveTurnOnly.run(ts, turnRow.session_id);
        }
        appendEventInternal(
          turnRow.session_id,
          turnRow.turn_id,
          'turn.failed',
          {
            turnId: turnRow.turn_id,
            turnNumber: turnRow.turn_number,
            status: 'interrupted',
            code: interruptError.code,
            reason: interruptError.reason,
            message: interruptError.message,
            graphVersion: preservedGraphVersion,
          },
          ts,
        );
        appendEventInternal(
          turnRow.session_id,
          turnRow.turn_id,
          'turn.done',
          {
            turnId: turnRow.turn_id,
            turnNumber: turnRow.turn_number,
            status: 'interrupted',
            graphVersion: preservedGraphVersion,
          },
          ts,
        );
        recoveredTurnIds.push(turnRow.turn_id);
      }

      const orphans = stmts.listOrphanActiveSessions.all();
      for (const orphan of orphans) {
        stmts.clearActiveTurnOnly.run(ts, orphan.session_id);
      }

      return {
        recoveredCount: recoveredTurnIds.length,
        turnIds: recoveredTurnIds,
      };
    });
  }

  // 启动即恢复残留 running 轮次
  recoverInterruptedTurns();

  /* ---------- 2. 创建会话 ---------- */
  function createSession({
    ownerId,
    dataMode = 'demo',
    lockedSnapshotId = null,
    usePersonalMaterials,
    initialEvidence,
    evidences,
    initialEvidences,
    materials,
    materialsStatus = null,
    cloudConsent,
    confirmedOutboundPreviewId = null,
    confirmedOutboundSnippets = null,
    initialText = null,
    initialGraph = null,
    outboundPreview = null,
    metadata = {},
    sessionId: customSessionId = null,
  } = {}) {
    const cleanOwner = validateOwnerId(ownerId, true);
    validateDataMode(dataMode);
    const resolvedInitialEvidence =
      initialEvidence ?? evidences ?? initialEvidences ?? materials ?? [];
    if (!Array.isArray(resolvedInitialEvidence)) {
      throw new BackendServiceError('INVALID_ARGUMENTS', 'initialEvidence 必须是数组。', 400);
    }

    const cleanMeta = metadata && typeof metadata === 'object' ? cloneJson(metadata) : {};
    const resolvedUsePersonalMaterials = normalizeUsePersonalMaterialsValue(
      usePersonalMaterials,
      materialsStatus,
      cleanMeta,
    );
    const resolvedCloudConsent = normalizeCloudConsentValue(cloudConsent, cleanMeta);
    const effectiveLockedSnapshotId =
      resolvedUsePersonalMaterials === false ? null : (lockedSnapshotId ?? null);
    const effectiveInitialEvidence =
      resolvedUsePersonalMaterials === false ? [] : resolvedInitialEvidence;
    const resolvedMaterialsStatus = normalizeMaterialsStatusObject(materialsStatus, {
      usePersonalMaterials: resolvedUsePersonalMaterials,
      lockedSnapshotId: effectiveLockedSnapshotId,
      evidenceCount: effectiveInitialEvidence.length,
    });
    const resolvedConfirmedPreviewId =
      resolvedCloudConsent === true
        ? (
            typeof confirmedOutboundPreviewId === 'string' && confirmedOutboundPreviewId.trim()
              ? confirmedOutboundPreviewId.trim()
              : (typeof outboundPreview?.confirmedOutboundPreviewId === 'string' && outboundPreview.confirmedOutboundPreviewId.trim()
                  ? outboundPreview.confirmedOutboundPreviewId.trim()
                  : null)
          )
        : null;
    const resolvedConfirmedSnippets =
      resolvedCloudConsent === true
        ? (
            Array.isArray(confirmedOutboundSnippets)
              ? cloneJson(confirmedOutboundSnippets)
              : (Array.isArray(outboundPreview?.items) ? cloneJson(outboundPreview.items) : [])
          )
        : [];
    cleanMeta.usePersonalMaterials = resolvedUsePersonalMaterials;
    cleanMeta.cloudConsent = resolvedCloudConsent;
    cleanMeta.materialsStatus = cloneJson(resolvedMaterialsStatus);

    return runInImmediateTransaction(() => {
      const ts = now();
      const sessionId =
        typeof customSessionId === 'string' && customSessionId.trim()
          ? customSessionId.trim()
          : `sess_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

      const initialNodes = extractRawNodesFromGraph(initialGraph);
      const confirmedGraph = buildConfirmedGraphObject(initialNodes, 0, engineAdapter);

      const initialState = {
        nextTurnNumber: 1,
        currentFocus: null,
        confirmedGraph,
        pendingConfirmations: [],
        deniedAttributions: [],
        facts: [],
        statements: [],
        adoptedStatementId: null,
        convergenceSummary: null,
        publicAnalysis: null,
        usePersonalMaterials: resolvedUsePersonalMaterials,
        cloudConsent: resolvedCloudConsent,
        allowCloudModel: resolvedCloudConsent,
        materialsStatus: resolvedMaterialsStatus,
        initialText: typeof initialText === 'string' ? initialText : null,
        confirmedOutboundPreviewId: resolvedConfirmedPreviewId,
        confirmedOutboundSnippets: resolvedConfirmedSnippets,
        outboundPreview: outboundPreview ? cloneJson(outboundPreview) : null,
        metadata: cleanMeta,
      };

      stmts.insertSession.run(
        sessionId,
        cleanOwner,
        dataMode,
        effectiveLockedSnapshotId,
        resolvedUsePersonalMaterials ? 1 : 0,
        resolvedCloudConsent === null ? null : (resolvedCloudConsent ? 1 : 0),
        JSON.stringify(resolvedMaterialsStatus),
        JSON.stringify(cleanMeta),
        0,
        null,
        JSON.stringify(initialState),
        ts,
        ts,
      );

      const sessionRow = stmts.getSessionById.get(sessionId);
      if (effectiveInitialEvidence.length > 0) {
        upsertEvidenceInternal(sessionRow, initialState, effectiveInitialEvidence, ts);
      }
      return buildFullSessionSnapshot(sessionRow);
    });
  }

  /* ---------- 3. 读取完整会话快照 ---------- */
  function getSession(ownerId, sessionId, { expectedDataMode } = {}) {
    ensureOpen();
    const sessionRow = requireSessionAccess(ownerId, sessionId, expectedDataMode);
    return buildFullSessionSnapshot(sessionRow);
  }

  /* ---------- 4. 证据与外发预览维护 ---------- */
  function upsertEvidence(sessionId, evidenceItems = []) {
    return runInImmediateTransaction(() => {
      const ts = now();
      const sessionRow = requireSessionByIdInternal(sessionId);
      const state = JSON.parse(sessionRow.state_json);
      return upsertEvidenceInternal(sessionRow, state, evidenceItems, ts);
    });
  }

  function getEvidenceMap(sessionId) {
    ensureOpen();
    const sessionRow = requireSessionByIdInternal(sessionId);
    const rows = stmts.selectEvidenceBySession.all(sessionRow.session_id);
    const map = new Map();
    for (const r of rows) {
      const item = JSON.parse(r.payload_json);
      map.set(item.evidenceId, item);
    }
    return map;
  }

  function updateOutboundPreview(sessionId, outboundPreview) {
    return runInImmediateTransaction(() => {
      const ts = now();
      const sessionRow = requireSessionByIdInternal(sessionId);
      const state = JSON.parse(sessionRow.state_json);
      const persistedCfg = resolvePersistedSessionConfig(sessionRow, state);
      let nextPreview = outboundPreview ? cloneJson(outboundPreview) : null;
      if (nextPreview && persistedCfg.cloudConsent === false) {
        nextPreview = {
          ...nextPreview,
          cloudConsentGranted: false,
          previewConfirmed: false,
          confirmedOutboundPreviewId: null,
        };
      }
      state.outboundPreview = nextPreview;
      stmts.updateSessionState.run(
        sessionRow.locked_snapshot_id ?? null,
        persistedCfg.usePersonalMaterials ? 1 : 0,
        persistedCfg.cloudConsent === null ? null : (persistedCfg.cloudConsent ? 1 : 0),
        JSON.stringify(persistedCfg.materialsStatus),
        JSON.stringify(persistedCfg.metadata),
        sessionRow.graph_version,
        sessionRow.active_turn_id,
        JSON.stringify(state),
        ts,
        sessionRow.session_id,
      );
      return cloneJson(state.outboundPreview);
    });
  }

  function updateSessionConsent(arg0, arg1, arg2 = {}) {
    let ownerId = null;
    let sessionId;
    let patch = {};

    if (arg0 && typeof arg0 === 'object' && !Array.isArray(arg0)) {
      ownerId = arg0.ownerId ?? null;
      sessionId = arg0.sessionId;
      patch = arg0;
    } else if (typeof arg1 === 'string') {
      ownerId = arg0;
      sessionId = arg1;
      patch = arg2 && typeof arg2 === 'object' ? arg2 : {};
    } else {
      sessionId = arg0;
      patch = arg1 && typeof arg1 === 'object' ? arg1 : {};
    }

    return runInImmediateTransaction(() => {
      const ts = now();
      const sessionRow = ownerId
        ? requireSessionAccess(ownerId, sessionId, patch.expectedDataMode)
        : requireSessionByIdInternal(sessionId);
      const state = JSON.parse(sessionRow.state_json);
      const persistedCfg = resolvePersistedSessionConfig(sessionRow, state);

      const nextCloudConsent =
        patch.cloudConsent === true || patch.cloudConsent === false || patch.cloudConsent === null
          ? patch.cloudConsent
          : persistedCfg.cloudConsent;

      let nextConfirmedPreviewId =
        typeof state.confirmedOutboundPreviewId === 'string' && state.confirmedOutboundPreviewId.trim()
          ? state.confirmedOutboundPreviewId.trim()
          : null;
      let nextConfirmedSnippets = Array.isArray(state.confirmedOutboundSnippets)
        ? cloneJson(state.confirmedOutboundSnippets)
        : [];
      let nextOutboundPreview = state.outboundPreview ? cloneJson(state.outboundPreview) : null;

      if (nextCloudConsent === false) {
        nextConfirmedPreviewId = null;
        nextConfirmedSnippets = [];
        if (patch.outboundPreview !== undefined) {
          nextOutboundPreview = patch.outboundPreview
            ? {
                ...cloneJson(patch.outboundPreview),
                cloudConsentGranted: false,
                previewConfirmed: false,
                confirmedOutboundPreviewId: null,
              }
            : null;
        } else if (nextOutboundPreview) {
          nextOutboundPreview = {
            ...nextOutboundPreview,
            cloudConsentGranted: false,
            previewConfirmed: false,
            confirmedOutboundPreviewId: null,
          };
        }
      } else {
        if (patch.confirmedOutboundPreviewId !== undefined) {
          nextConfirmedPreviewId =
            typeof patch.confirmedOutboundPreviewId === 'string' && patch.confirmedOutboundPreviewId.trim()
              ? patch.confirmedOutboundPreviewId.trim()
              : null;
        }
        if (patch.confirmedOutboundSnippets !== undefined) {
          nextConfirmedSnippets = Array.isArray(patch.confirmedOutboundSnippets)
            ? cloneJson(patch.confirmedOutboundSnippets)
            : [];
        }
        if (patch.outboundPreview !== undefined) {
          nextOutboundPreview = patch.outboundPreview ? cloneJson(patch.outboundPreview) : null;
        }
        if (nextOutboundPreview && typeof nextOutboundPreview === 'object') {
          const previewId = typeof nextOutboundPreview.outboundPreviewId === 'string'
            ? nextOutboundPreview.outboundPreviewId
            : null;
          nextOutboundPreview = {
            ...nextOutboundPreview,
            cloudConsentGranted: Boolean(nextCloudConsent === true),
            confirmedOutboundPreviewId: nextConfirmedPreviewId,
            previewConfirmed: Boolean(
              nextCloudConsent === true
              && nextConfirmedPreviewId
              && previewId
              && nextConfirmedPreviewId === previewId,
            ),
          };
        }
      }

      const nextMetadata = {
        ...(persistedCfg.metadata ?? {}),
        cloudConsent: nextCloudConsent,
      };
      if (Object.hasOwn(nextMetadata, 'allowCloudModel')) {
        nextMetadata.allowCloudModel = nextCloudConsent;
      }

      state.cloudConsent = nextCloudConsent;
      state.allowCloudModel = nextCloudConsent;
      state.confirmedOutboundPreviewId = nextConfirmedPreviewId;
      state.confirmedOutboundSnippets = nextConfirmedSnippets;
      state.outboundPreview = nextOutboundPreview;
      state.metadata = nextMetadata;

      // 严格保持 graph_version 与 active_turn_id 不变，保证撤回与重复撤回幂等。
      stmts.updateSessionState.run(
        sessionRow.locked_snapshot_id ?? null,
        persistedCfg.usePersonalMaterials ? 1 : 0,
        nextCloudConsent === null ? null : (nextCloudConsent ? 1 : 0),
        JSON.stringify(persistedCfg.materialsStatus),
        JSON.stringify(nextMetadata),
        sessionRow.graph_version,
        sessionRow.active_turn_id,
        JSON.stringify(state),
        ts,
        sessionRow.session_id,
      );

      const updatedRow = stmts.getSessionById.get(sessionRow.session_id);
      return buildFullSessionSnapshot(updatedRow);
    });
  }

  /* ---------- 5. 按 ID 或轮次号精确取回早期事实、轮次、证据或句子 ---------- */
  function getFactOrTurnById(arg0, arg1, arg2, arg3 = {}) {
    ensureOpen();
    let ownerId = null;
    let sessionId;
    let refId;
    let opts = {};
    if (arg2 === undefined) {
      // 兼容编排器内部二参调用 getFactOrTurnById(sessionId, refId)
      sessionId = arg0;
      refId = arg1;
    } else {
      ownerId = arg0;
      sessionId = arg1;
      refId = arg2;
      opts = arg3 ?? {};
    }
    const sessionRow = ownerId
      ? requireSessionAccess(ownerId, sessionId, opts.expectedDataMode)
      : requireSessionByIdInternal(sessionId);
    const snapshot = buildFullSessionSnapshot(sessionRow);
    if (refId === undefined || refId === null) return null;
    const rawRef = String(refId).trim();
    if (!rawRef) return null;

    // 1) 精确匹配 factId
    const exactFact = snapshot.facts.find((f) => f.id === rawRef);
    if (exactFact) {
      const relatedTurn = snapshot.turns.find((t) => t.turnId === exactFact.turnId) ?? null;
      const relatedEvidence = snapshot.evidenceIndex.filter((e) =>
        exactFact.evidenceIds.includes(e.evidenceId),
      );
      return {
        found: true,
        kind: 'fact',
        matchType: 'fact',
        refId: rawRef,
        id: exactFact.id,
        fact: exactFact,
        turn: relatedTurn,
        relatedEvidence,
        item: exactFact,
        record: exactFact,
      };
    }

    // 2) 匹配 evidenceId
    const exactEvidence = snapshot.evidenceIndex.find((e) => e.evidenceId === rawRef);
    if (exactEvidence) {
      return {
        found: true,
        kind: 'evidence',
        matchType: 'evidence',
        refId: rawRef,
        id: exactEvidence.evidenceId,
        evidence: exactEvidence,
        item: exactEvidence,
        record: exactEvidence,
      };
    }

    // 3) 匹配 statementId
    const exactStatement = snapshot.statements.find((s) => s.statementId === rawRef);
    if (exactStatement) {
      return {
        found: true,
        kind: 'statement',
        matchType: 'statement',
        refId: rawRef,
        id: exactStatement.statementId,
        statement: exactStatement,
        item: exactStatement,
        record: exactStatement,
      };
    }

    // 4) 匹配 turnId 或轮次序号（如 '6' / 6 / 'turn_6' / '第六轮'）
    const parsedTurnNum = parseTurnNumberReference(refId);
    const matchedTurn = snapshot.turns.find(
      (t) =>
        t.turnId === rawRef ||
        (parsedTurnNum !== null && t.turnNumber === parsedTurnNum),
    );
    if (matchedTurn) {
      const relatedFacts = snapshot.facts.filter(
        (f) => f.turnId === matchedTurn.turnId || f.turnNumber === matchedTurn.turnNumber,
      );
      const relatedEvidence = snapshot.evidenceIndex.filter(
        (e) => e.turnId === matchedTurn.turnId,
      );
      return {
        found: true,
        kind: 'turn',
        matchType: 'turn',
        refId: rawRef,
        id: matchedTurn.turnId,
        turn: matchedTurn,
        relatedFacts,
        relatedEvidence,
        item: matchedTurn,
        record: matchedTurn,
      };
    }

    // 5) 匹配已确认图节点 ID
    const exactNode = snapshot.confirmedGraph.nodes.find((n) => n.id === rawRef);
    if (exactNode) {
      return {
        found: true,
        kind: 'node',
        matchType: 'node',
        refId: rawRef,
        id: exactNode.id,
        node: exactNode,
        item: exactNode,
        record: exactNode,
      };
    }

    return null;
  }

  /* ---------- 6. 开启轮次：幂等重试、单轮写入锁与乐观版本校验 ---------- */
  function beginTurn(
    ownerId,
    sessionId,
    {
      clientRequestId,
      baseGraphVersion,
      text,
      focusRef = null,
      action = null,
      expectedDataMode,
    } = {},
  ) {
    return runInImmediateTransaction(() => {
      const sessionRow = requireSessionAccess(ownerId, sessionId, expectedDataMode);

      if (typeof clientRequestId !== 'string' || !clientRequestId.trim()) {
        throw new BackendServiceError(
          'INVALID_ARGUMENTS',
          'clientRequestId 必须是非空字符串。',
          400,
        );
      }
      if (!Number.isInteger(baseGraphVersion) || baseGraphVersion < 0) {
        throw new BackendServiceError(
          'INVALID_ARGUMENTS',
          'baseGraphVersion 必须是非负整数。',
          400,
        );
      }
      if (typeof text !== 'string' || (!text.trim() && !action)) {
        throw new BackendServiceError('INVALID_ARGUMENTS', 'text 必须是非空字符串。', 400);
      }

      const cleanReqId = clientRequestId.trim();
      const trimmedText = text.trim();
      const fingerprint = stableStringify({
        baseGraphVersion,
        text: trimmedText,
        focusRef: focusRef ?? null,
        action: action ?? null,
      });

      // 优先检查 clientRequestId 幂等性（即使该轮次正在运行或已提交也能原样复用）
      const existingTurn = stmts.getTurnByClientReq.get(sessionRow.session_id, cleanReqId);
      if (existingTurn) {
        if (existingTurn.request_fingerprint === fingerprint) {
          return {
            reused: true,
            turn: formatTurnSummary(existingTurn),
          };
        }
        throw new BackendServiceError(
          'CLIENT_REQUEST_ID_CONFLICT',
          '同一 clientRequestId 不能用于不同请求内容。',
          409,
          { clientRequestId: cleanReqId, existingTurnId: existingTurn.turn_id },
        );
      }

      // 单会话同时只允许一轮写入
      if (sessionRow.active_turn_id !== null) {
        throw new BackendServiceError(
          'TURN_IN_PROGRESS',
          '当前会话已有正在执行的轮次，同时只允许一轮写入。',
          409,
          { activeTurnId: sessionRow.active_turn_id },
        );
      }

      // 校验基准图版本未过期
      if (baseGraphVersion !== sessionRow.graph_version) {
        throw new BackendServiceError(
          'STALE_GRAPH_VERSION',
          'baseGraphVersion 已过期，请先刷新会话状态。',
          409,
          { currentGraphVersion: sessionRow.graph_version },
        );
      }

      const ts = now();
      const state = JSON.parse(sessionRow.state_json);
      const turnNumber = Number.isInteger(state.nextTurnNumber) ? state.nextTurnNumber : 1;
      const turnId = `turn_${turnNumber}`;
      state.nextTurnNumber = turnNumber + 1;

      stmts.insertTurn.run(
        sessionRow.session_id,
        turnId,
        turnNumber,
        cleanReqId,
        fingerprint,
        'running',
        null,
        trimmedText,
        focusRef !== null && focusRef !== undefined ? JSON.stringify(focusRef) : null,
        action !== null && action !== undefined ? JSON.stringify(action) : null,
        '',
        baseGraphVersion,
        null,
        0,
        null,
        null,
        null,
        ts,
        null,
      );

      stmts.updateSessionActiveTurn.run(
        turnId,
        JSON.stringify(state),
        ts,
        sessionRow.session_id,
      );

      const inserted = stmts.getTurnById.get(sessionRow.session_id, turnId);
      return {
        reused: false,
        turn: formatTurnSummary(inserted),
      };
    });
  }

  /* ---------- 7. SSE 事件写入、按 Last-Event-ID 查询与内存实时订阅 ---------- */
  function appendTurnEvent(sessionId, turnId, eventType, payload = {}) {
    return runInImmediateTransaction(() => {
      const sessionRow = requireSessionByIdInternal(sessionId);
      const turnRow = stmts.getTurnById.get(sessionRow.session_id, turnId);
      if (!turnRow) {
        throw new BackendServiceError('TURN_NOT_FOUND', '轮次不存在。', 404);
      }
      return appendEventInternal(sessionRow.session_id, turnRow.turn_id, eventType, payload, now());
    });
  }

  function listTurnEvents(
    ownerId,
    sessionId,
    turnId,
    optionsOrAfterSeq = 0,
  ) {
    ensureOpen();
    let effectiveOwner = ownerId;
    let effectiveSessionId = sessionId;
    let effectiveTurnId = turnId;
    let rawOpt = optionsOrAfterSeq;

    // 兼容内部无 ownerId 调用 listTurnEvents(sessionId, turnId, afterSeq)
    if (turnId === undefined || typeof turnId === 'number' || (turnId && typeof turnId === 'object')) {
      effectiveOwner = null;
      effectiveSessionId = ownerId;
      effectiveTurnId = sessionId;
      rawOpt = turnId ?? 0;
    }

    const expectedDataMode =
      rawOpt && typeof rawOpt === 'object' ? rawOpt.expectedDataMode : undefined;
    const afterSeq =
      typeof rawOpt === 'number'
        ? rawOpt
        : (rawOpt?.afterSeq ?? rawOpt?.afterEventId ?? 0);

    const sessionRow = effectiveOwner
      ? requireSessionAccess(effectiveOwner, effectiveSessionId, expectedDataMode)
      : requireSessionByIdInternal(effectiveSessionId);
    const turnRow = stmts.getTurnById.get(sessionRow.session_id, effectiveTurnId);
    if (!turnRow) {
      throw new BackendServiceError('TURN_NOT_FOUND', '轮次不存在。', 404);
    }
    const safeAfter =
      Number.isInteger(afterSeq) && afterSeq >= 0
        ? afterSeq
        : (Number.parseInt(String(afterSeq), 10) || 0);

    const rows = stmts.listTurnEventsAfter.all(
      sessionRow.session_id,
      turnRow.turn_id,
      Math.max(0, safeAfter),
    );
    return rows.map((r) => {
      const parsed = JSON.parse(r.payload_json);
      return {
        id: r.seq,
        seq: r.seq,
        eventId: r.seq,
        event: r.event_type,
        eventType: r.event_type,
        type: r.event_type,
        data: parsed,
        payload: parsed,
        createdAt: r.created_at,
      };
    });
  }

  function subscribeTurnEvents(
    sessionId,
    turnId,
    listener,
    { replayAfterSeq } = {},
  ) {
    ensureOpen();
    if (typeof listener !== 'function') {
      throw new BackendServiceError('INVALID_ARGUMENTS', 'listener 必须是函数。', 400);
    }
    const sessionRow = requireSessionByIdInternal(sessionId);
    const turnRow = stmts.getTurnById.get(sessionRow.session_id, turnId);
    if (!turnRow) {
      throw new BackendServiceError('TURN_NOT_FOUND', '轮次不存在。', 404);
    }

    if (replayAfterSeq !== undefined && replayAfterSeq !== null) {
      const safeAfter = Math.max(0, Number.parseInt(String(replayAfterSeq), 10) || 0);
      const rows = stmts.listTurnEventsAfter.all(
        sessionRow.session_id,
        turnRow.turn_id,
        safeAfter,
      );
      for (const r of rows) {
        const parsed = JSON.parse(r.payload_json);
        listener({
          id: r.seq,
          seq: r.seq,
          event: r.event_type,
          eventType: r.event_type,
          type: r.event_type,
          data: parsed,
          payload: parsed,
          createdAt: r.created_at,
        });
      }
    }

    const key = turnKey(sessionRow.session_id, turnRow.turn_id);
    let set = listenersByTurnKey.get(key);
    if (!set) {
      set = new Set();
      listenersByTurnKey.set(key, set);
    }
    set.add(listener);

    return () => {
      const current = listenersByTurnKey.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        listenersByTurnKey.delete(key);
      }
    };
  }

  /* ---------- 8. 原子提交轮次：commitTurn ---------- */
  function commitTurn(sessionId, turnId, commitSpec = {}) {
    return runInImmediateTransaction(() => {
      const sessionRow = requireSessionByIdInternal(sessionId);
      const turnRow = stmts.getTurnById.get(sessionRow.session_id, turnId);
      if (!turnRow) {
        throw new BackendServiceError('TURN_NOT_FOUND', '轮次不存在。', 404);
      }

      // 幂等提交与取消/中断竞态仲裁（由持久化状态决定）
      if (turnRow.status === 'committed') {
        const committedPayload = turnRow.commit_payload_json
          ? JSON.parse(turnRow.commit_payload_json)
          : null;
        return {
          outcome: 'committed',
          status: 'committed',
          committed: true,
          reused: true,
          emittedTerminalEvents: true,
          turn: formatTurnSummary(turnRow),
          committedPayload,
          graphVersion: turnRow.committed_graph_version,
        };
      }
      if (turnRow.status !== 'running') {
        return {
          outcome: turnRow.status,
          status: turnRow.status,
          committed: false,
          emittedTerminalEvents: true,
          turn: formatTurnSummary(turnRow),
          sessionGraphVersion: sessionRow.graph_version,
          graphVersion: sessionRow.graph_version,
        };
      }

      const ts = now();
      const state = JSON.parse(sessionRow.state_json);
      const persistedCfg = resolvePersistedSessionConfig(sessionRow, state);
      const prevGraphVersion = sessionRow.graph_version;
      const prevRawNodes = extractRawNodesFromGraph(state.confirmedGraph);
      const prevConfirmedGraph = buildConfirmedGraphObject(
        prevRawNodes,
        prevGraphVersion,
        engineAdapter,
      );

      // 计入变更前的旧报价，用于生成 quoteChanges
      const { statements: prevStatements } = recomputeAllStatementsAndComparison({
        storedStatements: Array.isArray(state.statements) ? state.statements : [],
        confirmedGraph: prevConfirmedGraph,
        graphVersion: prevGraphVersion,
        adoptedStatementId: state.adoptedStatementId ?? null,
        engineAdapter,
        facts: Array.isArray(state.facts) ? state.facts : [],
      });
      const prevStatementMap = new Map(prevStatements.map((s) => [s.statementId, s]));

      const intent = commitSpec.intent ?? 'analyze_statement';
      if (!TURN_INTENT_SET.has(intent)) {
        throw new BackendServiceError(
          'INVALID_ARGUMENTS',
          `无效的轮次 intent：${String(intent)}。`,
          400,
        );
      }

      // 1) 更新否认归属列表，并同步覆盖已存证据的归属
      const nextDeniedAttributions = Array.isArray(state.deniedAttributions)
        ? cloneJson(state.deniedAttributions)
        : [];
      if (Array.isArray(commitSpec.deniedAttributions) && commitSpec.deniedAttributions.length > 0) {
        const existingById = new Map(
          nextDeniedAttributions.map((d) => [d.evidenceId ?? d.contentKey, d]),
        );
        for (const rawDeny of commitSpec.deniedAttributions) {
          const rawKey = rawDeny?.evidenceId ?? rawDeny?.contentKey;
          if (!rawDeny || typeof rawKey !== 'string' || !rawKey.trim()) {
            throw new BackendServiceError(
              'INVALID_ARGUMENTS',
              'deniedAttributions 项必须包含非空 evidenceId 或 contentKey。',
              400,
            );
          }
          const evId = rawKey.trim();
          const record = {
            evidenceId: evId,
            contentKey: rawDeny.contentKey ?? evId,
            originalAuthor: rawDeny.originalAuthor ?? rawDeny.author ?? 'other_author',
            reason: rawDeny.reason ?? '本人否认该材料属于本人表达。',
            turnId: rawDeny.turnId ?? rawDeny.deniedByTurnId ?? turnRow.turn_id,
            deniedByTurnId: rawDeny.deniedByTurnId ?? rawDeny.turnId ?? turnRow.turn_id,
            turnNumber: turnRow.turn_number,
          };
          existingById.set(evId, record);

          // 立即修正已落库的该条证据归属
          const existingEvRow = stmts.getEvidenceById.get(sessionRow.session_id, evId);
          if (existingEvRow) {
            const evPayload = JSON.parse(existingEvRow.payload_json);
            evPayload.attribution = 'other_author';
            evPayload.deniedSelfAttribution = true;
            if (record.originalAuthor && record.originalAuthor !== 'other_author') {
              evPayload.author = record.originalAuthor;
            }
            stmts.upsertEvidenceRow.run(
              sessionRow.session_id,
              evId,
              existingEvRow.dedupe_key,
              existingEvRow.sort_order,
              existingEvRow.created_at,
              ts,
              JSON.stringify(evPayload),
            );
          }
        }
        state.deniedAttributions = [...existingById.values()];
      } else {
        state.deniedAttributions = nextDeniedAttributions;
      }

      // 2) 保存本轮已核验证据（自动应用 deniedAttributions 保护；若会话禁用个人材料则过滤个人采集条目）
      const nextUsePersonalMaterials =
        typeof commitSpec.usePersonalMaterials === 'boolean'
          ? commitSpec.usePersonalMaterials
          : persistedCfg.usePersonalMaterials;
      const filterAllowedEvidence = (items) =>
        nextUsePersonalMaterials === false
          ? items.filter((e) => e?.sourceType !== 'collection_record')
          : items;

      const rawIncomingEvidence = filterAllowedEvidence([
        ...(Array.isArray(commitSpec.evidenceIndex) ? commitSpec.evidenceIndex : []),
        ...(Array.isArray(commitSpec.verifiedEvidence) ? commitSpec.verifiedEvidence : []),
      ]);
      if (rawIncomingEvidence.length > 0) {
        upsertEvidenceInternal(sessionRow, state, rawIncomingEvidence, ts);
      }
      const verifiedEvidence = Array.isArray(commitSpec.verifiedEvidence)
        ? upsertEvidenceInternal(
            sessionRow,
            state,
            filterAllowedEvidence(commitSpec.verifiedEvidence),
            ts,
          )
        : [];

      // 3) 处理精确撤回（若 commitSpec 指定 retractTargetRef / retractTargets 或 retractionResult）
      let workingFacts = Array.isArray(commitSpec.facts)
        ? commitSpec.facts.map((f, idx) =>
            normalizeFactItem(f, turnRow.turn_id, turnRow.turn_number, idx + 1),
          )
        : (Array.isArray(state.facts) ? cloneJson(state.facts) : []);
      let workingRawNodes = cloneJson(prevRawNodes);
      const invalidatedItems = Array.isArray(commitSpec.invalidatedItems)
        ? cloneJson(commitSpec.invalidatedItems)
        : [];
      const customInvalidatedSummary =
        commitSpec.invalidatedItems &&
        typeof commitSpec.invalidatedItems === 'object' &&
        !Array.isArray(commitSpec.invalidatedItems)
          ? cloneJson(commitSpec.invalidatedItems)
          : null;

      let hadRetractionAttempt = false;
      let anyRetractionSucceeded = false;

      if (commitSpec.retractionResult && typeof commitSpec.retractionResult === 'object') {
        hadRetractionAttempt = true;
        if (
          commitSpec.retractionResult.found !== false &&
          commitSpec.retractionResult.alreadyRetracted !== true &&
          (commitSpec.retractionResult.graphMutated === true ||
            (Array.isArray(commitSpec.retractionResult.retractedFacts) &&
              commitSpec.retractionResult.retractedFacts.length > 0))
        ) {
          anyRetractionSucceeded = true;
        }
        if (Array.isArray(commitSpec.retractionResult.facts)) {
          workingFacts = cloneJson(commitSpec.retractionResult.facts);
        }
        if (commitSpec.retractionResult.confirmedGraph) {
          workingRawNodes = extractRawNodesFromGraph(commitSpec.retractionResult.confirmedGraph);
        }
        if (
          Array.isArray(commitSpec.retractionResult.invalidatedItems) &&
          invalidatedItems.length === 0
        ) {
          invalidatedItems.push(...cloneJson(commitSpec.retractionResult.invalidatedItems));
        }
      } else {
        const retractRefs = [];
        if (commitSpec.retractTargetRef !== undefined && commitSpec.retractTargetRef !== null) {
          retractRefs.push(commitSpec.retractTargetRef);
        }
        if (Array.isArray(commitSpec.retractTargets)) {
          retractRefs.push(...commitSpec.retractTargets);
        }
        if (retractRefs.length > 0) {
          hadRetractionAttempt = true;
        }
        for (const ref of retractRefs) {
          const ret = retractFact(
            {
              sessionId: sessionRow.session_id,
              facts: workingFacts,
              confirmedGraph: workingRawNodes,
              graphVersion: prevGraphVersion,
            },
            {
              targetRef: ref,
              currentTurnId: turnRow.turn_id,
              pricingEngine: engineAdapter,
            },
          );
          if (ret.found && !ret.alreadyRetracted) {
            anyRetractionSucceeded = true;
          }
          workingFacts = ret.facts;
          workingRawNodes = extractRawNodesFromGraph(ret.confirmedGraph);
          invalidatedItems.push(...ret.invalidatedItems);
        }
      }

      // 4) 合并本轮新增或更新的已确认事实 / 限定条件
      const incomingFacts = commitSpec.upsertedFacts ?? commitSpec.addedFacts ?? [];
      if (Array.isArray(incomingFacts) && incomingFacts.length > 0) {
        const factById = new Map(workingFacts.map((f) => [f.id, f]));
        incomingFacts.forEach((rawFact, idx) => {
          const norm = normalizeFactItem(
            rawFact,
            turnRow.turn_id,
            turnRow.turn_number,
            workingFacts.length + idx + 1,
          );
          factById.set(norm.id, norm);
        });
        workingFacts = [...factById.values()];
      }

      // 5) 应用整图替换或局部图补丁（graphPatch）
      if (commitSpec.confirmedGraph !== undefined && commitSpec.confirmedGraph !== null) {
        workingRawNodes = extractRawNodesFromGraph(commitSpec.confirmedGraph);
      }
      if (commitSpec.graphPatch && typeof commitSpec.graphPatch === 'object') {
        const patch = commitSpec.graphPatch;
        const removeSet = new Set([
          ...(Array.isArray(patch.removeNodeIds) ? patch.removeNodeIds : []),
          ...(Array.isArray(patch.removedNodeIds) ? patch.removedNodeIds : []),
        ]);
        const nodeMap = new Map();
        for (const n of workingRawNodes) {
          if (!removeSet.has(n.id)) {
            nodeMap.set(n.id, {
              ...n,
              deps: n.deps.filter((d) => !removeSet.has(d)),
            });
          }
        }
        const upserts = [
          ...(Array.isArray(patch.upsertNodes) ? patch.upsertNodes : []),
          ...(Array.isArray(patch.addedNodes) ? patch.addedNodes : []),
          ...(Array.isArray(patch.updatedNodes) ? patch.updatedNodes : []),
        ];
        for (const rawNode of upserts) {
          const normNode = normalizeNodeRecord({
            createdTurnId: turnRow.turn_id,
            ...rawNode,
          });
          nodeMap.set(normNode.id, normNode);
        }
        workingRawNodes = [...nodeMap.values()];
      }

      // 6) 计算实际图差异与 graphVersion 变更规则（重复撤回或目标不存在且图未变时绝不递增版本）
      const tentativeComputed = buildConfirmedGraphObject(
        workingRawNodes,
        prevGraphVersion,
        engineAdapter,
      );
      const graphDiff = computeGraphDiff(prevConfirmedGraph.nodes, tentativeComputed.nodes);

      let graphMutated;
      if (hadRetractionAttempt && !anyRetractionSucceeded && !graphDiff.changed) {
        graphMutated = false;
      } else if (typeof commitSpec.graphMutated === 'boolean') {
        graphMutated = commitSpec.graphMutated;
      } else if (commitSpec.incrementGraph === true) {
        graphMutated = true;
      } else {
        graphMutated = graphDiff.changed;
      }

      const nextGraphVersion = graphMutated ? prevGraphVersion + 1 : prevGraphVersion;
      const nextConfirmedGraph = buildConfirmedGraphObject(
        workingRawNodes,
        nextGraphVersion,
        engineAdapter,
      );

      let nextPublicAnalysis = state.publicAnalysis ? cloneJson(state.publicAnalysis) : null;
      if (commitSpec.publicAnalysis !== undefined) {
        nextPublicAnalysis = commitSpec.publicAnalysis ? cloneJson(commitSpec.publicAnalysis) : null;
        if (nextPublicAnalysis && typeof nextPublicAnalysis === 'object') {
          nextPublicAnalysis.graphVersion = nextGraphVersion;
        }
      }

      // 7) 合并句子版本并在同一最新图版本与同一分母上重算全部句子报价
      const existingStatements = Array.isArray(state.statements)
        ? cloneJson(state.statements)
        : [];
      const stmtMap = new Map(existingStatements.map((s) => [s.statementId, s]));
      const strictValidationIds = new Set();
      const explicitlyUpdatedIds = new Set();

      const incomingStatements =
        commitSpec.upsertedStatements ?? commitSpec.statements ?? [];
      if (Array.isArray(incomingStatements) && incomingStatements.length > 0) {
        incomingStatements.forEach((rawStmt, idx) => {
          if (!rawStmt || typeof rawStmt !== 'object') {
            throw new BackendServiceError('INVALID_ARGUMENTS', '句子条目必须是对象。', 400);
          }
          const defaultId =
            rawStmt.role === 'original' || (stmtMap.size === 0 && idx === 0)
              ? 'stmt_original'
              : `stmt_rewrite_${stmtMap.size + idx}`;
          const sid =
            typeof rawStmt.statementId === 'string' && rawStmt.statementId.trim()
              ? rawStmt.statementId.trim()
              : defaultId;
          const prev = stmtMap.get(sid);
          const merged = {
            ...(prev ?? {}),
            ...cloneJson(rawStmt),
            statementId: sid,
            role: rawStmt.role ?? prev?.role ?? (sid === 'stmt_original' ? 'original' : 'rewrite'),
            text: typeof rawStmt.text === 'string' ? rawStmt.text : (prev?.text ?? ''),
            createdTurnId: prev?.createdTurnId ?? rawStmt.createdTurnId ?? turnRow.turn_id,
            pendingStatus: null,
          };
          if (!merged.text.trim()) {
            throw new BackendServiceError(
              'INVALID_ARGUMENTS',
              `句子 ${sid} 的 text 不能为空。`,
              400,
            );
          }
          stmtMap.set(sid, merged);
          explicitlyUpdatedIds.add(sid);
          if (!rawStmt.ignoreUnknownConflicts) {
            strictValidationIds.add(sid);
          }
        });
      }

      // QA-04：显式 adoptStatementId / adoptedStatementId 存在性校验与严格保留
      const turnAction = turnRow.action_json ? JSON.parse(turnRow.action_json) : null;
      const rawActionAdoptId =
        turnAction && typeof turnAction === 'object'
          ? (turnAction.adoptStatementId ?? turnAction.adoptedStatementId)
          : undefined;
      const hasActionAdoptId =
        typeof rawActionAdoptId === 'string' && rawActionAdoptId.trim().length > 0;

      let hasExplicitAdoptParam = false;
      let rawRequestedAdoptId;
      if (commitSpec.adoptStatementId !== undefined) {
        hasExplicitAdoptParam = true;
        rawRequestedAdoptId = commitSpec.adoptStatementId;
      } else if (hasActionAdoptId) {
        hasExplicitAdoptParam = true;
        rawRequestedAdoptId = rawActionAdoptId;
      } else if (commitSpec.adoptedStatementId !== undefined) {
        hasExplicitAdoptParam = true;
        rawRequestedAdoptId = commitSpec.adoptedStatementId;
      }

      let nextAdoptedStatementId = state.adoptedStatementId ?? null;
      if (hasExplicitAdoptParam) {
        if (rawRequestedAdoptId === null) {
          nextAdoptedStatementId = null;
        } else if (typeof rawRequestedAdoptId === 'string') {
          const cleanAdoptId = rawRequestedAdoptId.trim();
          if (!cleanAdoptId) {
            if (commitSpec.strictAdoptValidation !== false && commitSpec.adoptStatementId !== undefined) {
              throw new BackendServiceError(
                'INVALID_ARGUMENTS',
                '指定的 adoptStatementId 不存在。',
                400,
              );
            }
            nextAdoptedStatementId = null;
          } else if (stmtMap.has(cleanAdoptId)) {
            nextAdoptedStatementId = cleanAdoptId;
          } else if (commitSpec.strictAdoptValidation !== false) {
            throw new BackendServiceError(
              'INVALID_ARGUMENTS',
              '指定的 adoptStatementId 不存在。',
              400,
              { adoptStatementId: cleanAdoptId },
            );
          }
        } else if (commitSpec.strictAdoptValidation !== false) {
          throw new BackendServiceError(
            'INVALID_ARGUMENTS',
            '指定的 adoptStatementId 不存在。',
            400,
          );
        }
      }

      const {
        statements: recomputedStatements,
        statementComparison,
      } = recomputeAllStatementsAndComparison({
        storedStatements: [...stmtMap.values()],
        confirmedGraph: nextConfirmedGraph,
        graphVersion: nextGraphVersion,
        adoptedStatementId: nextAdoptedStatementId,
        engineAdapter,
        strictConflictValidationIds: strictValidationIds,
        explicitlyUpdatedStatementIds: explicitlyUpdatedIds,
        facts: workingFacts,
      });

      const quoteChanges = [];
      for (const stmt of recomputedStatements) {
        const prev = prevStatementMap.get(stmt.statementId);
        const changed =
          !prev ||
          prev.quote.rate !== stmt.quote.rate ||
          prev.quote.assessment !== stmt.quote.assessment ||
          prev.quote.numerator !== stmt.quote.numerator ||
          prev.quote.denominator !== stmt.quote.denominator ||
          prev.quote.graphVersion !== stmt.quote.graphVersion ||
          stableStringify(prev.quote.directConflicts) !==
            stableStringify(stmt.quote.directConflicts);

        if (changed) {
          quoteChanges.push({
            statementId: stmt.statementId,
            role: stmt.role,
            previousAssessment: prev?.quote?.assessment ?? null,
            currentAssessment: stmt.quote.assessment,
            previousRate: prev?.quote?.rate ?? null,
            currentRate: stmt.quote.rate,
            numerator: stmt.quote.numerator,
            denominator: stmt.quote.denominator,
            directConflicts: stmt.quote.directConflicts,
            collateralAffected: stmt.quote.collateralAffected,
            graphVersion: nextGraphVersion,
          });
        }
      }

      // 8) 组装回答正文（未显式传入时从本轮已写入的 text.delta 拼接）
      let responseText =
        typeof commitSpec.responseText === 'string' ? commitSpec.responseText : null;
      if (responseText === null) {
        const deltas = stmts.listDeltaEvents.all(sessionRow.session_id, turnRow.turn_id);
        responseText = deltas
          .map((d) => {
            const parsed = JSON.parse(d.payload_json);
            return typeof parsed.delta === 'string'
              ? parsed.delta
              : (typeof parsed.text === 'string' ? parsed.text : '');
          })
          .join('');
      }

      const nextFocus =
        commitSpec.focus !== undefined ? cloneJson(commitSpec.focus) : (state.currentFocus ?? null);

      let nextConvergenceSummary =
        commitSpec.convergenceSummary !== undefined
          ? cloneJson(commitSpec.convergenceSummary)
          : (state.convergenceSummary ?? null);

      if (intent === 'converge') {
        const orig = recomputedStatements.find((s) => s.role === 'original') ?? null;
        const adopted =
          recomputedStatements.find((s) => s.statementId === nextAdoptedStatementId) ?? null;
        if (!nextConvergenceSummary) {
          nextConvergenceSummary = {
            turnId: turnRow.turn_id,
            graphVersion: nextGraphVersion,
            originalStatement: orig,
            adoptedStatement: adopted,
            adoptedRewrite: adopted
              ? {
                  statementId: adopted.statementId,
                  text: adopted.text,
                  assessment: adopted.quote?.assessment ?? 'insufficient_evidence',
                  rate: adopted.quote?.rate ?? null,
                  numerator: adopted.quote?.numerator ?? 0,
                  denominator: adopted.quote?.denominator ?? 0,
                }
              : null,
            activeFacts: workingFacts.filter((f) => f.status === 'active'),
            retractedFacts: workingFacts.filter((f) => f.status === 'retracted'),
            deniedAttributions: state.deniedAttributions,
          };
        } else if (adopted) {
          nextConvergenceSummary = {
            ...nextConvergenceSummary,
            adoptedStatement: adopted,
            adoptedRewrite: {
              statementId: adopted.statementId,
              text: adopted.text,
              assessment: adopted.quote?.assessment ?? 'insufficient_evidence',
              rate: adopted.quote?.rate ?? null,
              numerator: adopted.quote?.numerator ?? 0,
              denominator: adopted.quote?.denominator ?? 0,
            },
          };
        }
      }

      // QA-01 / QA-02：持久化更新会话级材料开关、云同意状态、材料状态与实际外发预览
      const nextCloudConsent =
        commitSpec.cloudConsent === true || commitSpec.cloudConsent === false || commitSpec.cloudConsent === null
          ? commitSpec.cloudConsent
          : persistedCfg.cloudConsent;
      const nextLockedSnapshotId =
        nextUsePersonalMaterials === false
          ? null
          : (commitSpec.lockedSnapshotId ?? sessionRow.locked_snapshot_id ?? null);
      const nextMaterialsStatus =
        commitSpec.materialsStatus && typeof commitSpec.materialsStatus === 'object'
          ? normalizeMaterialsStatusObject(commitSpec.materialsStatus, {
              usePersonalMaterials: nextUsePersonalMaterials,
              lockedSnapshotId: nextLockedSnapshotId,
            })
          : persistedCfg.materialsStatus;
      const nextOutboundPreview =
        commitSpec.outboundPreview !== undefined
          ? (commitSpec.outboundPreview ? cloneJson(commitSpec.outboundPreview) : null)
          : (state.outboundPreview ?? null);
      const nextConfirmedPreviewId =
        nextCloudConsent === false
          ? null
          : (commitSpec.confirmedOutboundPreviewId !== undefined
              ? (typeof commitSpec.confirmedOutboundPreviewId === 'string' && commitSpec.confirmedOutboundPreviewId.trim()
                  ? commitSpec.confirmedOutboundPreviewId.trim()
                  : null)
              : (state.confirmedOutboundPreviewId ?? null));
      const nextConfirmedSnippets =
        nextCloudConsent === false
          ? []
          : (Array.isArray(commitSpec.confirmedOutboundSnippets)
              ? cloneJson(commitSpec.confirmedOutboundSnippets)
              : (Array.isArray(state.confirmedOutboundSnippets) ? cloneJson(state.confirmedOutboundSnippets) : []));
      const nextMetadata = {
        ...(persistedCfg.metadata ?? {}),
        ...(commitSpec.metadata && typeof commitSpec.metadata === 'object' ? cloneJson(commitSpec.metadata) : {}),
        usePersonalMaterials: nextUsePersonalMaterials,
        cloudConsent: nextCloudConsent,
        materialsStatus: cloneJson(nextMaterialsStatus),
      };

      const nextState = {
        ...state,
        currentFocus: nextFocus,
        confirmedGraph: nextConfirmedGraph,
        pendingConfirmations:
          commitSpec.pendingConfirmations !== undefined
            ? cloneJson(commitSpec.pendingConfirmations)
            : (state.pendingConfirmations ?? []),
        facts: workingFacts,
        statements: recomputedStatements,
        adoptedStatementId: nextAdoptedStatementId,
        invalidatedHistory: Array.isArray(commitSpec.invalidatedHistory)
          ? cloneJson(commitSpec.invalidatedHistory)
          : (state.invalidatedHistory ?? []),
        convergenceSummary: nextConvergenceSummary,
        publicAnalysis: nextPublicAnalysis,
        usePersonalMaterials: nextUsePersonalMaterials,
        cloudConsent: nextCloudConsent,
        allowCloudModel: nextCloudConsent,
        materialsStatus: nextMaterialsStatus,
        confirmedOutboundPreviewId: nextConfirmedPreviewId,
        confirmedOutboundSnippets: nextConfirmedSnippets,
        outboundPreview: nextOutboundPreview,
        metadata: nextMetadata,
      };

      const nextActions = Array.isArray(commitSpec.nextActions)
        ? cloneJson(commitSpec.nextActions)
        : [];

      const extraEventFields =
        commitSpec.committedEventPayload && typeof commitSpec.committedEventPayload === 'object'
          ? cloneJson(commitSpec.committedEventPayload)
          : {};

      const committedPayload = {
        ...extraEventFields,
        turnId: turnRow.turn_id,
        sessionId: sessionRow.session_id,
        turnNumber: turnRow.turn_number,
        intent,
        focus: nextFocus,
        verifiedEvidence,
        graphPatch: {
          addedNodes: graphDiff.addedNodes,
          updatedNodes: graphDiff.updatedNodes,
          removedNodeIds: graphDiff.removedNodeIds,
        },
        quoteChanges,
        statements: recomputedStatements,
        quotes: recomputedStatements.map((s) => s.quote),
        statementComparison,
        adoptedStatementId: nextAdoptedStatementId,
        graphVersion: nextGraphVersion,
        graphMutated,
        invalidatedItems: customInvalidatedSummary ?? invalidatedItems,
        convergenceSummary: nextConvergenceSummary,
        ...(nextPublicAnalysis !== null || commitSpec.publicAnalysis !== undefined
          ? { publicAnalysis: nextPublicAnalysis }
          : {}),
        nextActions,
      };

      // 9) 在同一事务内落库会话状态、轮次记录及可恢复的 turn.committed / turn.done 事件
      stmts.updateSessionState.run(
        nextLockedSnapshotId,
        nextUsePersonalMaterials ? 1 : 0,
        nextCloudConsent === null ? null : (nextCloudConsent ? 1 : 0),
        JSON.stringify(nextMaterialsStatus),
        JSON.stringify(nextMetadata),
        nextGraphVersion,
        null,
        JSON.stringify(nextState),
        ts,
        sessionRow.session_id,
      );

      stmts.updateTurnCommitted.run(
        intent,
        responseText,
        nextGraphVersion,
        graphMutated ? 1 : 0,
        JSON.stringify(committedPayload),
        commitSpec.metrics ? JSON.stringify(commitSpec.metrics) : null,
        ts,
        sessionRow.session_id,
        turnRow.turn_id,
      );

      appendEventInternal(
        sessionRow.session_id,
        turnRow.turn_id,
        'turn.committed',
        committedPayload,
        ts,
      );
      appendEventInternal(
        sessionRow.session_id,
        turnRow.turn_id,
        'turn.done',
        {
          turnId: turnRow.turn_id,
          sessionId: sessionRow.session_id,
          turnNumber: turnRow.turn_number,
          status: 'committed',
          graphVersion: nextGraphVersion,
        },
        ts,
      );

      const updatedTurn = stmts.getTurnById.get(sessionRow.session_id, turnRow.turn_id);
      return {
        outcome: 'committed',
        status: 'committed',
        committed: true,
        reused: false,
        emittedTerminalEvents: true,
        turn: formatTurnSummary(updatedTurn),
        committedPayload,
        graphVersion: nextGraphVersion,
      };
    });
  }

  /* ---------- 9. 主动取消轮次：cancelTurn（对 committed / cancelled / failed / interrupted 四种终态均严格幂等） ---------- */
  function cancelTurn(
    ownerId,
    sessionId,
    turnId,
    { reason = '已根据用户请求停止当前轮次。', expectedDataMode } = {},
  ) {
    let effOwner = ownerId;
    let effSessionId = sessionId;
    let effTurnId = turnId;
    let effReason = reason;
    let effMode = expectedDataMode;
    if (ownerId && typeof ownerId === 'object' && !Array.isArray(ownerId)) {
      effOwner = ownerId.ownerId;
      effSessionId = ownerId.sessionId;
      effTurnId = ownerId.turnId;
      effReason = ownerId.reason ?? '已根据用户请求停止当前轮次。';
      effMode = ownerId.expectedDataMode;
    }

    return runInImmediateTransaction(() => {
      const sessionRow = requireSessionAccess(effOwner, effSessionId, effMode);
      const turnRow = stmts.getTurnById.get(sessionRow.session_id, effTurnId);
      if (!turnRow) {
        throw new BackendServiceError('TURN_NOT_FOUND', '指定的轮次不存在。', 404);
      }

      const TERMINAL_STATUSES = new Set(['committed', 'cancelled', 'failed', 'interrupted']);
      if (TERMINAL_STATUSES.has(turnRow.status)) {
        const currentStatus = turnRow.status;
        return {
          outcome: currentStatus,
          status: currentStatus,
          cancelled: currentStatus === 'cancelled',
          reused: true,
          emittedTerminalEvents: true,
          turn: formatTurnSummary(turnRow),
          sessionGraphVersion: sessionRow.graph_version,
          graphVersion: sessionRow.graph_version,
        };
      }

      const ts = now();
      const cancelError = { code: 'CANCELLED', message: effReason };
      stmts.updateTurnTerminated.run(
        'cancelled',
        JSON.stringify(cancelError),
        null,
        ts,
        sessionRow.session_id,
        turnRow.turn_id,
      );
      if (sessionRow.active_turn_id === turnRow.turn_id) {
        stmts.clearActiveTurnOnly.run(ts, sessionRow.session_id);
      }

      appendEventInternal(
        sessionRow.session_id,
        turnRow.turn_id,
        'turn.cancelled',
        {
          turnId: turnRow.turn_id,
          sessionId: sessionRow.session_id,
          turnNumber: turnRow.turn_number,
          reason: effReason,
          graphVersion: sessionRow.graph_version,
        },
        ts,
      );
      appendEventInternal(
        sessionRow.session_id,
        turnRow.turn_id,
        'turn.done',
        {
          turnId: turnRow.turn_id,
          sessionId: sessionRow.session_id,
          turnNumber: turnRow.turn_number,
          status: 'cancelled',
          graphVersion: sessionRow.graph_version,
        },
        ts,
      );

      const updatedTurn = stmts.getTurnById.get(sessionRow.session_id, turnRow.turn_id);
      return {
        outcome: 'cancelled',
        status: 'cancelled',
        cancelled: true,
        emittedTerminalEvents: true,
        turn: formatTurnSummary(updatedTurn),
        sessionGraphVersion: sessionRow.graph_version,
        graphVersion: sessionRow.graph_version,
      };
    });
  }

  /* ---------- 10. 轮次失败记录：failTurn（同时兼容 (sessionId, turnId, errorInfo, opts) 与 (ownerId, sessionId, turnId, errorInfo, opts)） ---------- */
  function failTurn(arg0, arg1, arg2, arg3 = {}, arg4 = {}) {
    let ownerId = null;
    let sessionId;
    let turnId;
    let errorInfo;
    let opts = {};

    if (arg0 && typeof arg0 === 'object' && !Array.isArray(arg0)) {
      ownerId = arg0.ownerId ?? null;
      sessionId = arg0.sessionId;
      turnId = arg0.turnId;
      errorInfo = arg0.error ?? arg0.errorInfo ?? arg0;
      opts = arg0;
    } else if (typeof arg2 === 'string') {
      ownerId = arg0;
      sessionId = arg1;
      turnId = arg2;
      errorInfo = arg3;
      opts = arg4 ?? {};
    } else {
      sessionId = arg0;
      turnId = arg1;
      errorInfo = arg2;
      opts = arg3 ?? {};
    }
    const effectivePendingStmt = opts.pendingStatement ?? errorInfo?.pendingStatement ?? null;
    const effectiveMetrics = opts.metrics ?? errorInfo?.metrics ?? null;

    return runInImmediateTransaction(() => {
      const sessionRow = ownerId
        ? requireSessionAccess(ownerId, sessionId, opts.expectedDataMode)
        : requireSessionByIdInternal(sessionId);
      const turnRow = stmts.getTurnById.get(sessionRow.session_id, turnId);
      if (!turnRow) {
        throw new BackendServiceError('TURN_NOT_FOUND', '轮次不存在。', 404);
      }

      if (turnRow.status !== 'running') {
        return {
          outcome: turnRow.status,
          status: turnRow.status,
          failed: turnRow.status === 'failed',
          emittedTerminalEvents: true,
          turn: formatTurnSummary(turnRow),
          sessionGraphVersion: sessionRow.graph_version,
          graphVersion: sessionRow.graph_version,
        };
      }

      const ts = now();
      const resolvedErrCode =
        typeof errorInfo?.code === 'string' && errorInfo.code
          ? errorInfo.code
          : typeof errorInfo?.errorCode === 'string' && errorInfo.errorCode
            ? errorInfo.errorCode
            : 'INTERNAL_ERROR';
      const normalizedError = {
        code: resolvedErrCode,
        message:
          typeof errorInfo?.message === 'string' && errorInfo.message
            ? errorInfo.message
            : '当前轮次处理失败，已保留已确认图版本。',
        ...(errorInfo?.details ? { details: cloneJson(errorInfo.details) } : {}),
      };

      const state = JSON.parse(sessionRow.state_json);
      let recordedPendingStatementId = null;

      if (effectivePendingStmt && typeof effectivePendingStmt === 'object') {
        const existingStatements = Array.isArray(state.statements)
          ? cloneJson(state.statements)
          : [];
        const stmtMap = new Map(
          existingStatements.map((s) => [s.statementId ?? s.id, s]),
        );
        const rawSid = effectivePendingStmt.statementId ?? effectivePendingStmt.id;
        const sid =
          typeof rawSid === 'string' && rawSid.trim()
            ? rawSid.trim()
            : (stmtMap.size === 0 ? 'stmt_original' : `stmt_pending_${turnRow.turn_number}`);
        const prev = stmtMap.get(sid);
        const rawText =
          typeof effectivePendingStmt.text === 'string' && effectivePendingStmt.text.trim()
            ? effectivePendingStmt.text.trim()
            : turnRow.user_text;
        stmtMap.set(sid, {
          ...(prev ?? {}),
          ...cloneJson(effectivePendingStmt),
          id: sid,
          statementId: sid,
          role:
            effectivePendingStmt.role ?? prev?.role ?? (sid === 'stmt_original' ? 'original' : 'rewrite'),
          text: rawText,
          createdTurnId: prev?.createdTurnId ?? turnRow.turn_id,
          status: 'pending_analysis',
          assessment: 'insufficient_evidence',
          pendingStatus: normalizedError.code,
          directConflicts: [],
          conflictReasons: [],
        });
        state.statements = [...stmtMap.values()];
        recordedPendingStatementId = sid;
      }

      const persistedCfg = resolvePersistedSessionConfig(sessionRow, state);
      // 保持 graph_version 与 confirmedGraph 完全不变，仅清空 active_turn_id（及必要时写入待分析新句状态）
      stmts.updateSessionState.run(
        sessionRow.locked_snapshot_id ?? null,
        persistedCfg.usePersonalMaterials ? 1 : 0,
        persistedCfg.cloudConsent === null ? null : (persistedCfg.cloudConsent ? 1 : 0),
        JSON.stringify(persistedCfg.materialsStatus),
        JSON.stringify(persistedCfg.metadata),
        sessionRow.graph_version,
        null,
        JSON.stringify(state),
        ts,
        sessionRow.session_id,
      );

      stmts.updateTurnTerminated.run(
        'failed',
        JSON.stringify(normalizedError),
        effectiveMetrics ? JSON.stringify(effectiveMetrics) : null,
        ts,
        sessionRow.session_id,
        turnRow.turn_id,
      );

      appendEventInternal(
        sessionRow.session_id,
        turnRow.turn_id,
        'turn.failed',
        {
          turnId: turnRow.turn_id,
          sessionId: sessionRow.session_id,
          turnNumber: turnRow.turn_number,
          code: normalizedError.code,
          message: normalizedError.message,
          error: normalizedError,
          pendingStatementId: recordedPendingStatementId,
          graphVersion: sessionRow.graph_version,
        },
        ts,
      );
      appendEventInternal(
        sessionRow.session_id,
        turnRow.turn_id,
        'turn.done',
        {
          turnId: turnRow.turn_id,
          sessionId: sessionRow.session_id,
          turnNumber: turnRow.turn_number,
          status: 'failed',
          graphVersion: sessionRow.graph_version,
        },
        ts,
      );

      const updatedTurn = stmts.getTurnById.get(sessionRow.session_id, turnRow.turn_id);
      return {
        outcome: 'failed',
        status: 'failed',
        failed: true,
        emittedTerminalEvents: true,
        turn: formatTurnSummary(updatedTurn),
        sessionGraphVersion: sessionRow.graph_version,
        graphVersion: sessionRow.graph_version,
      };
    });
  }

  /* ---------- 11. 按授权主体清除会话及事件回放数据 / 关闭连接 ---------- */
  function clearSessionData(ownerId) {
    const cleanOwner = validateOwnerId(ownerId, false);
    return runInImmediateTransaction(() => {
      const rows = stmts.listSessionsByOwner.all(cleanOwner);
      const sessionIds = rows.map((r) => r.session_id);
      stmts.deleteSessionsByOwner.run(cleanOwner);
      for (const key of [...listenersByTurnKey.keys()]) {
        if (sessionIds.some((sid) => key.startsWith(`${sid}::`))) {
          listenersByTurnKey.delete(key);
        }
      }
      return {
        clearedCount: sessionIds.length,
        sessionIds,
      };
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    listenersByTurnKey.clear();
    db.close();
  }

  return {
    recoverInterruptedTurns,
    createSession,
    getSession,
    upsertEvidence,
    getEvidenceMap,
    updateOutboundPreview,
    updateSessionConsent,
    getFactOrTurnById,
    beginTurn,
    appendTurnEvent,
    listTurnEvents,
    subscribeTurnEvents,
    commitTurn,
    cancelTurn,
    failTurn,
    retractFact: (arg0, opts = {}) => {
      // 兼容编排器 store.retractFact({ ownerId, sessionId, turnId, factId / targetId / targetRef }) 与纯状态 retractFact(sessionState, opts)
      if (
        arg0 &&
        typeof arg0 === 'object' &&
        typeof arg0.sessionId === 'string' &&
        !Array.isArray(arg0.facts) &&
        arg0.confirmedGraph === undefined &&
        (arg0.factId !== undefined || arg0.targetId !== undefined || arg0.targetRef !== undefined)
      ) {
        const sessionRow = arg0.ownerId
          ? requireSessionAccess(arg0.ownerId, arg0.sessionId, arg0.expectedDataMode)
          : requireSessionByIdInternal(arg0.sessionId);
        const snap = buildFullSessionSnapshot(sessionRow);
        return retractFact(snap, {
          targetRef: arg0.targetRef ?? arg0.targetId ?? arg0.factId,
          currentTurnId: arg0.currentTurnId ?? arg0.turnId ?? null,
          pricingEngine: engineAdapter,
        });
      }
      return retractFact(arg0, { ...opts, pricingEngine: engineAdapter });
    },
    clearSessionData,
    close,
  };
}
