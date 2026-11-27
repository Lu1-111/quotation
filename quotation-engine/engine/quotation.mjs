// 有据冲突算价与同图改写比较层。
// 遵循《「报价」后端实施方案与审查标准》第 2.4、2.5 节：判断（assessment）与数值（rate）分离表达。

import { collapseAfter, computeGraph } from './starfield.mjs';

export const PROTOCOL_VERSION = 'quotation-backend/v1';

export const QUOTE_SCHEMA_VERSION = 1;

export const ASSESSMENTS = Object.freeze([
  'conflict',
  'compatible',
  'insufficient_evidence',
]);

export const RATE_INTERPRETATION_NOTE =
  '数值仅解释当前已确认图上的承重结构影响比例，不能作为授权者会被说服的概率。';

const ASSESSMENT_SET = new Set(ASSESSMENTS);

function createQuotationError(code, message, details = null) {
  const err = new Error(message);
  err.name = 'QuotationEngineError';
  err.code = code;
  if (details) err.details = details;
  return err;
}

const weightOf = (nodes) => nodes.reduce((sum, n) => sum + n.S, 0);
const roundPercent = (numerator, denominator) => Math.round((100 * numerator) / denominator);

function isJsonSerializableValue(value) {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(value);
  if (t !== 'object') return false;
  if (Array.isArray(value)) {
    return value.every(isJsonSerializableValue);
  }
  if (Object.prototype.toString.call(value) !== '[object Object]') {
    return false;
  }
  return Object.values(value).every((v) => v === undefined || isJsonSerializableValue(v));
}

function ensureComputedGraph(graph) {
  if (!Array.isArray(graph)) {
    throw createQuotationError('INVALID_GRAPH', 'graph 必须是节点数组。');
  }
  if (graph.length === 0) return [];
  // 始终经 computeGraph 校验无环、无悬空引用、无重复依赖，并确保 S 与 d 与当前拓扑严格一致
  return computeGraph(graph);
}

function normalizeStringIdList(items, fieldName) {
  if (items == null) return [];
  const list = Array.isArray(items)
    ? items
    : (items instanceof Set ? [...items] : null);
  if (!list) {
    throw createQuotationError('INVALID_ARGUMENTS', `${fieldName} 必须是字符串数组。`);
  }
  const unique = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (typeof item !== 'string' || !item.trim()) {
      throw createQuotationError(
        'INVALID_ARGUMENTS',
        `${fieldName}[${i}] 必须是非空字符串。`,
      );
    }
    if (!seen.has(item)) {
      seen.add(item);
      unique.push(item);
    }
  }
  return unique;
}

function normalizeConflictReasons(conflictReasons) {
  if (conflictReasons == null) return [];
  if (!Array.isArray(conflictReasons)) {
    throw createQuotationError('INVALID_ARGUMENTS', 'conflictReasons 必须是数组。');
  }
  return conflictReasons.map((entry, idx) => {
    if (typeof entry === 'string') {
      if (!entry.trim()) {
        throw createQuotationError(
          'INVALID_ARGUMENTS',
          `conflictReasons[${idx}] 不能为空白字符串。`,
        );
      }
      return entry;
    }
    if (
      entry
      && typeof entry === 'object'
      && !Array.isArray(entry)
      && Object.prototype.toString.call(entry) === '[object Object]'
    ) {
      if (typeof entry.nodeId !== 'string' || !entry.nodeId.trim()) {
        throw createQuotationError(
          'INVALID_ARGUMENTS',
          `conflictReasons[${idx}].nodeId 必须是非空字符串。`,
        );
      }
      if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
        throw createQuotationError(
          'INVALID_ARGUMENTS',
          `conflictReasons[${idx}].reason 必须是非空字符串。`,
        );
      }

      const normalized = {
        nodeId: entry.nodeId,
        reason: entry.reason,
      };

      if (entry.evidenceIds !== undefined && entry.evidenceIds !== null) {
        normalized.evidenceIds = normalizeStringIdList(
          entry.evidenceIds,
          `conflictReasons[${idx}].evidenceIds`,
        );
      }

      for (const [k, v] of Object.entries(entry)) {
        if (k === 'nodeId' || k === 'reason' || k === 'evidenceIds' || v === undefined) {
          continue;
        }
        if (!isJsonSerializableValue(v)) {
          throw createQuotationError(
            'INVALID_ARGUMENTS',
            `conflictReasons[${idx}].${k} 包含非法的非 JSON 值。`,
          );
        }
        normalized[k] = v;
      }
      return normalized;
    }
    throw createQuotationError(
      'INVALID_ARGUMENTS',
      `conflictReasons[${idx}] 必须是非空字符串或有效原因对象。`,
    );
  });
}

/* ---------- 基础算价纯函数（保留旧版兼容签名） ---------- */
export function quote(graph, conflicts = []) {
  const computedGraph = ensureComputedGraph(graph);
  const validIds = new Set(computedGraph.map((n) => n.id));
  const input = Array.isArray(conflicts) ? conflicts : (conflicts ? [...conflicts] : []);
  const uniqueConflicts = [];
  const seen = new Set();
  for (const id of input) {
    if (typeof id === 'string' && validIds.has(id) && !seen.has(id)) {
      seen.add(id);
      uniqueConflicts.push(id);
    }
  }
  const dead = collapseAfter(seen, computedGraph);
  const lost = weightOf(computedGraph.filter((n) => dead.has(n.id)));
  const total = weightOf(computedGraph);
  return {
    conflicts: uniqueConflicts,
    dead: [...dead],
    collapsed: dead.size - uniqueConflicts.length,
    lost,
    total,
    rate: total ? roundPercent(lost, total) : 0,
  };
}

/* ---------- 单句协议化报价（严格分离 assessment 与 rate） ---------- */
export function evaluateStatementQuote({
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
    throw createQuotationError(
      'INVALID_ASSESSMENT',
      `无效的 assessment 取值：${String(assessment)}。允许值为 conflict、compatible 或 insufficient_evidence。`,
      { assessment },
    );
  }
  if (typeof statementId !== 'string' || !statementId.trim()) {
    throw createQuotationError('INVALID_ARGUMENTS', 'statementId 必须是非空字符串。');
  }
  if (typeof text !== 'string') {
    throw createQuotationError('INVALID_ARGUMENTS', 'text 必须是字符串。');
  }
  if (!Number.isInteger(graphVersion) || graphVersion < 0) {
    throw createQuotationError('INVALID_ARGUMENTS', 'graphVersion 必须是非负整数。');
  }
  if (typeof reason !== 'string') {
    throw createQuotationError('INVALID_ARGUMENTS', 'reason 必须是字符串。');
  }

  const normalizedGraphVersion = graphVersion === 0 ? 0 : graphVersion;
  const computedGraph = ensureComputedGraph(graph);
  const validIds = new Set(computedGraph.map((n) => n.id));
  const denominator = weightOf(computedGraph);

  // 校验并去重 directConflicts
  const rawConflicts = directConflicts == null
    ? []
    : (Array.isArray(directConflicts) || directConflicts instanceof Set ? [...directConflicts] : null);
  if (!rawConflicts) {
    throw createQuotationError('INVALID_ARGUMENTS', 'directConflicts 必须是数组或 Set。');
  }

  const validConflicts = [];
  const conflictSet = new Set();
  const unknownNodeIds = [];

  for (let i = 0; i < rawConflicts.length; i += 1) {
    const id = rawConflicts[i];
    if (typeof id !== 'string' || !id.trim()) {
      if (!ignoreUnknownConflicts) {
        throw createQuotationError(
          'INVALID_CONFLICT_NODE',
          `directConflicts[${i}] 不是有效的节点 ID。`,
          { index: i, nodeId: id },
        );
      }
      continue;
    }
    if (!validIds.has(id)) {
      if (!ignoreUnknownConflicts) {
        unknownNodeIds.push(id);
      }
      continue;
    }
    if (!conflictSet.has(id)) {
      conflictSet.add(id);
      validConflicts.push(id);
    }
  }

  if (unknownNodeIds.length > 0) {
    const err = createQuotationError(
      'INVALID_CONFLICT_NODE',
      `directConflicts 包含当前图中不存在的节点 ID：${unknownNodeIds.join(', ')}。`,
      { unknownNodeIds },
    );
    err.unknownNodeIds = unknownNodeIds;
    throw err;
  }

  const normalizedConflictReasons = normalizeConflictReasons(conflictReasons);
  const normalizedEvidenceIds = normalizeStringIdList(verifiedEvidenceIds, 'verifiedEvidenceIds');

  if (assessment === 'insufficient_evidence') {
    return {
      statementId,
      text,
      graphVersion: normalizedGraphVersion,
      assessment,
      rate: null,
      directConflicts: [],
      collateral: [],
      affected: [],
      numerator: 0,
      denominator,
      reason,
      conflictReasons: [],
      verifiedEvidenceIds: normalizedEvidenceIds,
      interpretationNote: RATE_INTERPRETATION_NOTE,
    };
  }

  if (assessment === 'compatible') {
    return {
      statementId,
      text,
      graphVersion: normalizedGraphVersion,
      assessment,
      rate: denominator === 0 ? null : 0,
      directConflicts: [],
      collateral: [],
      affected: [],
      numerator: 0,
      denominator,
      reason,
      conflictReasons: [],
      verifiedEvidenceIds: normalizedEvidenceIds,
      interpretationNote: RATE_INTERPRETATION_NOTE,
    };
  }

  // assessment === 'conflict'
  const dead = collapseAfter(conflictSet, computedGraph);
  const affected = [...dead];
  const collateral = affected.filter((id) => !conflictSet.has(id));
  const numerator = weightOf(computedGraph.filter((n) => dead.has(n.id)));
  const rate = denominator === 0 ? null : roundPercent(numerator, denominator);

  return {
    statementId,
    text,
    graphVersion: normalizedGraphVersion,
    assessment,
    rate,
    directConflicts: validConflicts,
    collateral,
    affected,
    numerator,
    denominator,
    reason,
    conflictReasons: normalizedConflictReasons,
    verifiedEvidenceIds: normalizedEvidenceIds,
    interpretationNote: RATE_INTERPRETATION_NOTE,
  };
}

/* ---------- 原句与多个改写版本在同一张已确认图、同一分母上的批量重算与对照 ---------- */
export function compareStatementsOnGraph({
  graph = [],
  graphVersion = 0,
  statements = [],
  baselineStatementId = null,
  ignoreUnknownConflicts = false,
} = {}) {
  if (!Number.isInteger(graphVersion) || graphVersion < 0) {
    throw createQuotationError('INVALID_ARGUMENTS', 'graphVersion 必须是非负整数。');
  }
  if (!Array.isArray(statements)) {
    throw createQuotationError('INVALID_ARGUMENTS', 'statements 必须是数组。');
  }

  const computedGraph = ensureComputedGraph(graph);
  const denominator = weightOf(computedGraph);
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

  const seenStatementIds = new Set();
  const quotes = statements.map((stmt, idx) => {
    if (!stmt || typeof stmt !== 'object' || Array.isArray(stmt)) {
      throw createQuotationError('INVALID_ARGUMENTS', `statements[${idx}] 必须是对象。`);
    }
    const sid = stmt.statementId ?? `stmt_${idx}`;
    if (seenStatementIds.has(sid)) {
      throw createQuotationError(
        'INVALID_ARGUMENTS',
        `statements 中存在重复的 statementId：${sid}。`,
        { statementId: sid },
      );
    }
    seenStatementIds.add(sid);

    return evaluateStatementQuote({
      statementId: sid,
      text: stmt.text ?? '',
      assessment: stmt.assessment ?? 'insufficient_evidence',
      directConflicts: stmt.directConflicts ?? [],
      conflictReasons: stmt.conflictReasons ?? [],
      reason: stmt.reason ?? '',
      verifiedEvidenceIds: stmt.verifiedEvidenceIds ?? [],
      ignoreUnknownConflicts: stmt.ignoreUnknownConflicts ?? ignoreUnknownConflicts,
      graph: computedGraph,
      graphVersion,
    });
  });

  let resolvedBaselineId = baselineStatementId;
  if (resolvedBaselineId == null) {
    const markedIndex = statements.findIndex(
      (s) => s && (s.isBaseline === true || s.role === 'original'),
    );
    resolvedBaselineId = markedIndex >= 0 ? quotes[markedIndex].statementId : quotes[0].statementId;
  }

  const baselineQuote = quotes.find((q) => q.statementId === resolvedBaselineId);
  if (!baselineQuote) {
    throw createQuotationError(
      'INVALID_ARGUMENTS',
      `未在 statements 中找到基准句子 baselineStatementId：${String(resolvedBaselineId)}。`,
      { baselineStatementId: resolvedBaselineId },
    );
  }

  const baseDirectSet = new Set(baselineQuote.directConflicts);
  const baseAffectedSet = new Set(baselineQuote.affected);

  const comparisons = quotes
    .filter((q) => q.statementId !== baselineQuote.statementId)
    .map((q) => {
      const qDirectSet = new Set(q.directConflicts);
      const qAffectedSet = new Set(q.affected);
      const bothVerified =
        baselineQuote.assessment !== 'insufficient_evidence'
        && q.assessment !== 'insufficient_evidence';
      const deltaRate =
        !bothVerified || baselineQuote.rate === null || q.rate === null
          ? null
          : q.rate - baselineQuote.rate;

      return {
        statementId: q.statementId,
        baselineStatementId: baselineQuote.statementId,
        baselineRate: baselineQuote.rate,
        rate: q.rate,
        deltaRate,
        baselineAssessment: baselineQuote.assessment,
        assessment: q.assessment,
        assessmentChanged: q.assessment !== baselineQuote.assessment,
        resolvedConflicts: bothVerified
          ? baselineQuote.directConflicts.filter((id) => !qDirectSet.has(id))
          : [],
        addedConflicts: q.assessment === 'insufficient_evidence'
          ? []
          : q.directConflicts.filter((id) => !baseDirectSet.has(id)),
        resolvedAffected: bothVerified
          ? baselineQuote.affected.filter((id) => !qAffectedSet.has(id))
          : [],
        addedAffected: q.assessment === 'insufficient_evidence'
          ? []
          : q.affected.filter((id) => !baseAffectedSet.has(id)),
      };
    });

  return {
    graphVersion,
    denominator,
    totalNodes,
    quotes,
    baselineStatementId: baselineQuote.statementId,
    comparisons,
  };
}
