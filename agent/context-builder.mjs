// 有界模型上下文组装器：严禁将全部多轮完整历史或全量无关材料塞入提示词，按需精确取回早期记录。
import { parseTurnNumberReference } from './session-store.mjs';

const DEFAULT_MAX_LOCAL_NODES = 12;
const DEFAULT_MAX_EVIDENCE = 8;
const DEFAULT_RECENT_TURNS_LIMIT = 4;
const DEFAULT_MAX_FACTS = 8;
const DEFAULT_MAX_RETRACTED_FACTS = 4;
const DEFAULT_MAX_TOTAL_CHARS = 6000;
const MAX_RESPONSE_SNIPPET_CHARS = 240;

function truncateText(text, maxChars = MAX_RESPONSE_SNIPPET_CHARS) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  if (maxChars <= 1) return trimmed.slice(0, Math.max(0, maxChars));
  return `${trimmed.slice(0, maxChars - 1)}…`;
}

function extractQueryTerms(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const raw = text.trim();
  const terms = new Set();

  // 提取英文/数字标识与中文双字以上片段，用于无额外依赖的轻量局部相关性排序
  const tokenMatches = raw.match(/[A-Za-z0-9_-]{2,}|[\u4e00-\u9fa5]{2,}/g) ?? [];
  for (const token of tokenMatches) {
    terms.add(token.toLowerCase());
    if (/^[\u4e00-\u9fa5]{4,}$/.test(token)) {
      for (let i = 0; i <= token.length - 2; i += 1) {
        terms.add(token.slice(i, i + 2));
      }
    }
  }
  return [...terms];
}

function extractReferencedIdsFromText(userText) {
  if (typeof userText !== 'string' || !userText.trim()) return [];
  const refs = new Set();

  // 1. 显式结构化 ID（fact_*, turn_*, ev_*, stmt_*, node_*）
  const idPattern = /\b(?:fact|turn|ev|evidence|stmt|node)_[A-Za-z0-9_-]+\b/g;
  for (const match of userText.matchAll(idPattern)) {
    refs.add(match[0]);
  }

  // 2. 中文或数字轮次指代（如“第三轮”、“第六轮”、“第 10 轮”、“turn 4”）
  const cnTurnPattern = /第\s*([0-9零〇一二两三四五六七八九十]+)\s*轮/g;
  for (const match of userText.matchAll(cnTurnPattern)) {
    const turnNum = parseTurnNumberReference(match[0]);
    if (turnNum !== null) {
      refs.add(`turn_${turnNum}`);
    }
  }

  const enTurnPattern = /\bturn\s*#?\s*(\d+)\b/gi;
  for (const match of userText.matchAll(enTurnPattern)) {
    const num = Number.parseInt(match[1], 10);
    if (Number.isInteger(num) && num > 0) {
      refs.add(`turn_${num}`);
    }
  }

  return [...refs];
}

function scoreTextOverlap(text, terms) {
  if (!text || terms.length === 0) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lower.includes(term)) {
      score += term.length >= 3 ? 3 : 1;
    }
  }
  return score;
}

function compactEarlyFact(fact) {
  return {
    id: fact.id,
    kind: fact.kind,
    status: fact.status,
    turnId: fact.turnId ?? null,
    turnNumber: fact.turnNumber ?? null,
    retractedByTurnId: fact.retractedByTurnId ?? null,
    targetFactId: fact.targetFactId ?? null,
    evidenceIds: Array.isArray(fact.evidenceIds) ? fact.evidenceIds.slice(0, 6) : [],
    text: truncateText(fact.text, 280),
  };
}

function lookupEarlyItem(snapshot, rawRef, maxTurnFacts = 4) {
  if (rawRef === undefined || rawRef === null) return [];
  const ref = String(rawRef).trim();
  if (!ref) return [];

  const matched = [];
  const facts = Array.isArray(snapshot.facts) ? snapshot.facts : [];
  const turns = Array.isArray(snapshot.turns) ? snapshot.turns : [];
  const evidenceIndex = Array.isArray(snapshot.evidenceIndex) ? snapshot.evidenceIndex : [];
  const statements = Array.isArray(snapshot.statements) ? snapshot.statements : [];
  const graphNodes = Array.isArray(snapshot.confirmedGraph?.nodes)
    ? snapshot.confirmedGraph.nodes
    : (Array.isArray(snapshot.confirmedGraph) ? snapshot.confirmedGraph : []);

  const exactFact = facts.find((f) => f.id === ref);
  if (exactFact) {
    matched.push({
      matchType: 'fact',
      id: exactFact.id,
      requestedBy: ref,
      item: compactEarlyFact(exactFact),
    });
  }

  const exactEvidence = evidenceIndex.find((e) => e.evidenceId === ref || e.id === ref);
  if (exactEvidence) {
    const eid = exactEvidence.evidenceId ?? exactEvidence.id;
    matched.push({
      matchType: 'evidence',
      id: eid,
      requestedBy: ref,
      item: {
        evidenceId: eid,
        sourceType: exactEvidence.sourceType,
        author: exactEvidence.author,
        attribution: exactEvidence.attribution,
        excerpt: truncateText(exactEvidence.excerpt, 280),
        turnId: exactEvidence.turnId ?? null,
        url: exactEvidence.url ?? null,
      },
    });
  }

  const exactStmt = statements.find((s) => s.statementId === ref);
  if (exactStmt) {
    matched.push({
      matchType: 'statement',
      id: exactStmt.statementId,
      requestedBy: ref,
      item: {
        statementId: exactStmt.statementId,
        role: exactStmt.role,
        text: truncateText(exactStmt.text, 260),
        assessment: exactStmt.assessment,
        rate: exactStmt.quote?.rate ?? null,
        directConflicts: (exactStmt.directConflicts ?? []).slice(0, 8),
      },
    });
  }

  const exactNode = graphNodes.find((n) => n.id === ref);
  if (exactNode) {
    matched.push({
      matchType: 'node',
      id: exactNode.id,
      requestedBy: ref,
      item: {
        id: exactNode.id,
        text: truncateText(exactNode.text, 260),
        cluster: exactNode.cluster,
        S: exactNode.S ?? 0,
        deps: (exactNode.deps ?? []).slice(0, 8),
      },
    });
  }

  const turnNum = parseTurnNumberReference(ref);
  const exactTurn = turns.find(
    (t) => t.turnId === ref || (turnNum !== null && t.turnNumber === turnNum),
  );
  if (exactTurn) {
    const turnFactsRaw = facts.filter(
      (f) => f.turnId === exactTurn.turnId || f.turnNumber === exactTurn.turnNumber,
    );
    const turnFacts = turnFactsRaw.slice(0, Math.max(1, maxTurnFacts)).map(compactEarlyFact);
    const turnEvidence = evidenceIndex
      .filter((e) => e.turnId === exactTurn.turnId)
      .slice(0, 6);
    matched.push({
      matchType: 'turn',
      id: exactTurn.turnId,
      requestedBy: ref,
      item: {
        turnId: exactTurn.turnId,
        turnNumber: exactTurn.turnNumber,
        intent: exactTurn.intent,
        status: exactTurn.status,
        userText: truncateText(exactTurn.userText ?? exactTurn.text ?? '', 240),
        responseText: truncateText(exactTurn.responseText, 280),
        baseGraphVersion: exactTurn.baseGraphVersion,
        committedGraphVersion: exactTurn.committedGraphVersion,
        facts: turnFacts,
        evidenceIds: turnEvidence.map((e) => e.evidenceId ?? e.id),
      },
    });
    for (const tf of turnFacts) {
      matched.push({
        matchType: 'fact',
        id: tf.id,
        requestedBy: ref,
        item: tf,
      });
    }
  }

  return matched;
}

export function buildTurnContext(arg0, arg1 = {}) {
  let sessionSnapshot = arg0;
  let options = arg1 ?? {};
  // 兼容 buildTurnContext({ session, focus, userText, ... }) 单对象调用与 buildTurnContext(sessionSnapshot, options) 标准调用
  if (
    arg0 &&
    typeof arg0 === 'object' &&
    arg0.session &&
    typeof arg0.session === 'object' &&
    !arg0.sessionId
  ) {
    sessionSnapshot = arg0.session;
    options = arg0;
  }

  const hasTightLegacyBudgets =
    options.maxFacts === undefined &&
    options.maxLocalNodes !== undefined &&
    options.maxEvidence !== undefined &&
    options.recentTurnsLimit !== undefined;
  const inferredMaxFacts = hasTightLegacyBudgets
    ? Math.min(
        DEFAULT_MAX_FACTS,
        Math.max(0, options.maxLocalNodes, options.maxEvidence, options.recentTurnsLimit),
      )
    : DEFAULT_MAX_FACTS;
  const inferredMaxRetracted = hasTightLegacyBudgets
    ? Math.min(DEFAULT_MAX_RETRACTED_FACTS, Math.max(0, inferredMaxFacts))
    : DEFAULT_MAX_RETRACTED_FACTS;

  const {
    focus = null,
    userText = '',
    recentTurnsLimit = DEFAULT_RECENT_TURNS_LIMIT,
    maxEvidence = DEFAULT_MAX_EVIDENCE,
    maxLocalNodes = DEFAULT_MAX_LOCAL_NODES,
    maxFacts = inferredMaxFacts,
    maxRetractedFacts = inferredMaxRetracted,
    maxTotalChars = DEFAULT_MAX_TOTAL_CHARS,
    requestedIds = [],
  } = options;

  if (!sessionSnapshot || typeof sessionSnapshot !== 'object') {
    throw new TypeError('sessionSnapshot 必须是有效的会话快照对象。');
  }

  const safeTurnsLimit = Math.max(0, Math.floor(recentTurnsLimit));
  const safeMaxEvidence = Math.max(0, Math.floor(maxEvidence));
  const safeMaxNodes = Math.max(0, Math.floor(maxLocalNodes));
  const safeMaxFacts = Math.max(0, Math.floor(maxFacts));
  const safeMaxRetractedFacts = Math.max(0, Math.floor(maxRetractedFacts));
  const safeMaxTotalChars = Math.max(120, Math.floor(maxTotalChars));

  const effectiveFocus = focus ?? sessionSnapshot.currentFocus ?? null;
  const allNodes = Array.isArray(sessionSnapshot.confirmedGraph?.nodes)
    ? sessionSnapshot.confirmedGraph.nodes
    : (Array.isArray(sessionSnapshot.confirmedGraph) ? sessionSnapshot.confirmedGraph : []);
  const allEvidence = Array.isArray(sessionSnapshot.evidenceIndex)
    ? sessionSnapshot.evidenceIndex
    : [];
  const allFacts = Array.isArray(sessionSnapshot.facts) ? sessionSnapshot.facts : [];
  const allTurns = Array.isArray(sessionSnapshot.turns) ? sessionSnapshot.turns : [];
  const allStatements = Array.isArray(sessionSnapshot.statements)
    ? sessionSnapshot.statements
    : [];
  const allDeniedAttributions = Array.isArray(sessionSnapshot.deniedAttributions)
    ? sessionSnapshot.deniedAttributions
    : [];

  const focusTextParts = [
    userText,
    effectiveFocus?.span ?? '',
    effectiveFocus?.spanText ?? '',
    effectiveFocus?.text ?? '',
    effectiveFocus?.reason ?? '',
  ].filter(Boolean);
  const queryTerms = extractQueryTerms(focusTextParts.join(' '));

  // ---------- ② 解析显式 requestedIds 与 userText 中的早期引用并按 ID 优先取回 ----------
  const combinedRequestedRefs = [
    ...(Array.isArray(requestedIds) ? requestedIds : []),
    ...(effectiveFocus?.nodeId ? [effectiveFocus.nodeId] : []),
    ...(effectiveFocus?.factId ? [effectiveFocus.factId] : []),
    ...extractReferencedIdsFromText(userText),
  ];
  const rawRetrievedEarlyItems = [];
  const seenEarlyKeys = new Set();
  for (const ref of combinedRequestedRefs) {
    const foundList = lookupEarlyItem(sessionSnapshot, ref, Math.max(1, safeMaxFacts || 2));
    for (const entry of foundList) {
      const dedupeKey = `${entry.matchType}::${entry.id}`;
      if (!seenEarlyKeys.has(dedupeKey)) {
        seenEarlyKeys.add(dedupeKey);
        rawRetrievedEarlyItems.push(entry);
      }
    }
  }

  // ---------- ⑤a 组装当前局部图（焦点/冲突节点及其上下游一跳邻居 + 全图承重统计摘要） ----------
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));
  const childrenById = new Map(allNodes.map((n) => [n.id, []]));
  for (const n of allNodes) {
    for (const dep of n.deps ?? []) {
      if (childrenById.has(dep)) {
        childrenById.get(dep).push(n.id);
      }
    }
  }

  const seedNodeIds = new Set();
  if (effectiveFocus) {
    if (typeof effectiveFocus.nodeId === 'string' && nodeById.has(effectiveFocus.nodeId)) {
      seedNodeIds.add(effectiveFocus.nodeId);
    }
    for (const listField of ['nodeIds', 'targetNodeIds', 'conflictNodeIds']) {
      if (Array.isArray(effectiveFocus[listField])) {
        for (const nid of effectiveFocus[listField]) {
          if (nodeById.has(nid)) seedNodeIds.add(nid);
        }
      }
    }
  }
  for (const stmt of allStatements) {
    for (const cid of stmt.directConflicts ?? []) {
      if (nodeById.has(cid)) seedNodeIds.add(cid);
    }
  }
  for (const item of rawRetrievedEarlyItems) {
    if (item.matchType === 'node' && nodeById.has(item.id)) {
      seedNodeIds.add(item.id);
    }
    if (item.matchType === 'fact') {
      for (const n of allNodes) {
        if (
          n.conditionFactId === item.id ||
          (Array.isArray(n.sourceFactIds) && n.sourceFactIds.includes(item.id))
        ) {
          seedNodeIds.add(n.id);
        }
      }
    }
  }

  // 若尚无明确种子节点，优先选有词面重合的节点；若全图庞大且无重合则仅选极少量代表柱子
  if (seedNodeIds.size === 0 && allNodes.length > 0 && safeMaxNodes > 0) {
    const scoredNodes = allNodes
      .map((n) => ({
        id: n.id,
        overlap: scoreTextOverlap(`${n.name ?? ''} ${n.text}`, queryTerms),
        S: n.S ?? 0,
      }))
      .sort((a, b) => b.overlap - a.overlap || b.S - a.S);
    const matchedNodes = scoredNodes.filter((n) => n.overlap > 0);
    const pool =
      matchedNodes.length > 0
        ? matchedNodes
        : (rawRetrievedEarlyItems.length > 0 && allNodes.length > safeMaxNodes ? [] : scoredNodes);
    const initialPickCount = Math.min(Math.min(3, safeMaxNodes), pool.length);
    for (let i = 0; i < initialPickCount; i += 1) {
      seedNodeIds.add(pool[i].id);
    }
  }

  const localSelectedIds = new Set();
  for (const sid of seedNodeIds) {
    if (localSelectedIds.size >= safeMaxNodes) break;
    localSelectedIds.add(sid);
  }
  for (const sid of seedNodeIds) {
    if (localSelectedIds.size >= safeMaxNodes) break;
    const seedNode = nodeById.get(sid);
    if (!seedNode) continue;
    for (const upId of seedNode.deps ?? []) {
      if (localSelectedIds.size >= safeMaxNodes) break;
      if (nodeById.has(upId)) localSelectedIds.add(upId);
    }
    for (const downId of childrenById.get(sid) ?? []) {
      if (localSelectedIds.size >= safeMaxNodes) break;
      if (nodeById.has(downId)) localSelectedIds.add(downId);
    }
  }

  let candidateLocalNodes = allNodes
    .filter((n) => localSelectedIds.has(n.id))
    .slice(0, safeMaxNodes)
    .map((n) => ({
      id: n.id,
      name: n.name ?? n.id,
      text: truncateText(n.text, 220),
      kind: n.kind ?? 'judgment',
      cluster: n.cluster,
      deps: (n.deps ?? []).slice(0, 8),
      S: n.S ?? 0,
      d: n.d ?? 0,
      evidenceIds: (n.evidenceIds ?? []).slice(0, 6),
      sourceFactIds: (n.sourceFactIds ?? []).slice(0, 6),
      conditionFactId: n.conditionFactId ?? null,
    }));

  // ---------- ⑤b 相关有效事实与已撤回事实摘要（按相关性打分排序并受 maxFacts / maxRetractedFacts 约束） ----------
  const allActiveFacts = allFacts.filter((f) => f && f.status === 'active');
  const allRetractedFacts = allFacts.filter((f) => f && f.status === 'retracted');

  const retrievedFactIds = new Set(
    rawRetrievedEarlyItems.filter((i) => i.matchType === 'fact').map((i) => i.id),
  );
  const retrievedTurnIds = new Set(
    rawRetrievedEarlyItems.filter((i) => i.matchType === 'turn').map((i) => i.id),
  );
  const retrievedTargetFactIds = new Set();
  for (const item of rawRetrievedEarlyItems) {
    if (item.matchType === 'fact' && item.item?.targetFactId) {
      retrievedTargetFactIds.add(item.item.targetFactId);
    }
  }

  const localSourceFactIds = new Set();
  for (const ln of candidateLocalNodes) {
    if (ln.conditionFactId) localSourceFactIds.add(ln.conditionFactId);
    for (const fid of ln.sourceFactIds ?? []) localSourceFactIds.add(fid);
  }

  const scoredActiveFacts = allActiveFacts
    .map((f, idx) => {
      let score = 0;
      if (retrievedFactIds.has(f.id)) score += 1000;
      if (f.turnId && retrievedTurnIds.has(f.turnId)) score += 600;
      if (effectiveFocus?.factId && effectiveFocus.factId === f.id) score += 500;
      if (localSourceFactIds.has(f.id)) score += 250;
      if (retrievedTargetFactIds.has(f.id)) score += 180;
      if (f.targetFactId && retrievedFactIds.has(f.targetFactId)) score += 150;
      if (Array.isArray(f.nodeIds) && f.nodeIds.some((nid) => localSelectedIds.has(nid))) {
        score += 200;
      }
      score += scoreTextOverlap(
        `${f.text ?? ''} ${f.scopeText ?? ''} ${f.supportsDescription ?? ''}`,
        queryTerms,
      ) * 10;
      return { f, score, idx };
    })
    .sort((a, b) => b.score - a.score || b.idx - a.idx);

  let selectedActiveFactEntries;
  if (safeMaxFacts === 0) {
    selectedActiveFactEntries = [];
  } else if (allActiveFacts.length <= safeMaxFacts) {
    selectedActiveFactEntries = scoredActiveFacts.slice(0, safeMaxFacts);
  } else {
    // 长会话超过 maxFacts 上限时：仅保留有明确关联得分（score > 0）的事实，绝不填充无关历史标记！
    const positiveMatches = scoredActiveFacts.filter((entry) => entry.score > 0);
    if (positiveMatches.length > 0 || rawRetrievedEarlyItems.length > 0) {
      selectedActiveFactEntries = positiveMatches.slice(0, safeMaxFacts);
    } else {
      selectedActiveFactEntries = scoredActiveFacts.slice(0, Math.min(1, safeMaxFacts));
    }
  }

  let candidateActiveFacts = selectedActiveFactEntries.map(({ f }) => ({
    id: f.id,
    kind: f.kind,
    text: truncateText(f.text, 220),
    turnId: f.turnId,
    turnNumber: f.turnNumber,
    evidenceIds: (f.evidenceIds ?? []).slice(0, 6),
    supportsDescription: f.supportsDescription ? truncateText(f.supportsDescription, 140) : null,
  }));

  const scoredRetractedFacts = allRetractedFacts
    .map((f, idx) => {
      let score = 0;
      if (retrievedFactIds.has(f.id)) score += 1000;
      if (f.turnId && retrievedTurnIds.has(f.turnId)) score += 600;
      if (f.retractedByTurnId && retrievedTurnIds.has(f.retractedByTurnId)) score += 400;
      score += scoreTextOverlap(f.text ?? '', queryTerms) * 10;
      return { f, score, idx };
    })
    .sort((a, b) => b.score - a.score || b.idx - a.idx);

  let selectedRetractedEntries;
  if (safeMaxRetractedFacts === 0) {
    selectedRetractedEntries = [];
  } else if (allRetractedFacts.length <= safeMaxRetractedFacts) {
    selectedRetractedEntries = scoredRetractedFacts.slice(0, safeMaxRetractedFacts);
  } else {
    selectedRetractedEntries = scoredRetractedFacts
      .filter((entry) => entry.score > 0)
      .slice(0, safeMaxRetractedFacts);
  }

  let candidateRetractedFacts = selectedRetractedEntries.map(({ f }) => ({
    id: f.id,
    kind: f.kind,
    text: truncateText(f.text, 100),
    turnId: f.turnId,
    retractedByTurnId: f.retractedByTurnId,
  }));

  // ---------- ③ 相关已核验证据（严格不超过 maxEvidence 条；长会话过滤零相关噪音） ----------
  const priorityEvidenceIds = new Set();
  if (Array.isArray(effectiveFocus?.evidenceIds)) {
    for (const eid of effectiveFocus.evidenceIds) priorityEvidenceIds.add(eid);
  }
  for (const n of candidateLocalNodes) {
    for (const eid of n.evidenceIds ?? []) priorityEvidenceIds.add(eid);
  }
  for (const f of candidateActiveFacts) {
    for (const eid of f.evidenceIds ?? []) priorityEvidenceIds.add(eid);
  }
  for (const item of rawRetrievedEarlyItems) {
    if (item.matchType === 'evidence') priorityEvidenceIds.add(item.id);
    if (item.matchType === 'fact') {
      for (const eid of item.item.evidenceIds ?? []) priorityEvidenceIds.add(eid);
    }
    if (item.matchType === 'turn') {
      for (const eid of item.item.evidenceIds ?? []) priorityEvidenceIds.add(eid);
    }
  }

  const deniedEvidenceIds = new Set(allDeniedAttributions.map((d) => d.evidenceId ?? d.contentKey));

  const scoredEvidence = allEvidence
    .map((ev, index) => {
      const evId = ev.evidenceId ?? ev.id;
      let score = 0;
      if (priorityEvidenceIds.has(evId)) score += 100;
      score += scoreTextOverlap(`${ev.author ?? ''} ${ev.excerpt ?? ''}`, queryTerms) * 5;
      if (ev.attribution === 'self' && !deniedEvidenceIds.has(evId) && allEvidence.length <= 24) {
        score += 4;
      }
      return { ev, evId, score, index };
    })
    .sort((a, b) => b.score - a.score || b.index - a.index);

  const filteredEvidencePool =
    allEvidence.length > 24 && scoredEvidence.some((x) => x.score > 0)
      ? scoredEvidence.filter((x) => x.score > 0)
      : scoredEvidence;

  let candidateEvidence = filteredEvidencePool.slice(0, safeMaxEvidence).map(({ ev, evId }) => ({
    evidenceId: evId,
    sourceType: ev.sourceType,
    author: ev.author,
    attribution: deniedEvidenceIds.has(evId) ? 'other_author' : ev.attribution,
    deniedSelfAttribution: Boolean(
      ev.deniedSelfAttribution || deniedEvidenceIds.has(evId),
    ),
    excerpt: truncateText(ev.excerpt, 280),
    locator: ev.locator ?? null,
    textKind: ev.textKind ?? 'full_text',
    truncated: Boolean(ev.truncated),
    turnId: ev.turnId ?? null,
    url: ev.url ?? null,
  }));

  // ---------- ④ 最近 recentTurnsLimit 轮精简问答摘要（绝不附带全部历史轮次） ----------
  const completedOrCommittedTurns = allTurns.filter((t) => t.status !== 'running');
  const recentTurnSlice =
    safeTurnsLimit === 0 ? [] : completedOrCommittedTurns.slice(-safeTurnsLimit);

  let candidateRecentTurns = recentTurnSlice.map((t) => ({
    turnId: t.turnId,
    turnNumber: t.turnNumber,
    intent: t.intent,
    status: t.status,
    userText: truncateText(t.userText ?? t.text ?? '', 180),
    responseSummary: truncateText(t.responseText, MAX_RESPONSE_SNIPPET_CHARS),
    baseGraphVersion: t.baseGraphVersion,
    committedGraphVersion: t.committedGraphVersion,
  }));

  const totalWeight = allNodes.reduce((sum, n) => sum + (n.S ?? 0), 0);

  const statementsSummary = allStatements.slice(-6).map((s) => ({
    statementId: s.statementId,
    role: s.role,
    text: truncateText(s.text, 220),
    assessment: s.assessment,
    pendingStatus: s.pendingStatus ?? null,
    rate: s.quote?.rate ?? null,
    numerator: s.quote?.numerator ?? 0,
    denominator: s.quote?.denominator ?? totalWeight,
    directConflicts: (s.directConflicts ?? []).slice(0, 8),
  }));

  const deniedAttributionsBounded = allDeniedAttributions.slice(-6).map((d) => ({
    evidenceId: d.evidenceId ?? d.contentKey,
    contentKey: d.contentKey ?? d.evidenceId,
    originalAuthor: d.originalAuthor,
    deniedByTurnId: d.deniedByTurnId ?? d.turnId ?? null,
    reason: truncateText(d.reason ?? '', 120),
  }));

  const pendingConfirmationsBounded = (sessionSnapshot.pendingConfirmations ?? [])
    .slice(0, 6)
    .map((p) => ({
      ...p,
      text: truncateText(p?.text ?? '', 180),
    }));

  // ---------- 严格按优先级施加 maxTotalChars 总字符预算 ----------
  // 优先级：① 本轮焦点与句子 → ② retrievedEarlyItems → ③ 核验证据 → ④ 近期对话 → ⑤ 局部图节点与相关事实摘要
  let remainingChars = safeMaxTotalChars;
  const promptSections = [];

  const pushBoundedLine = (line, forceKeepTruncated = false) => {
    const cost = line.length + 1;
    if (cost <= remainingChars) {
      promptSections.push(line);
      remainingChars -= cost;
      return true;
    }
    if (forceKeepTruncated && remainingChars > 16) {
      const sliced = truncateText(line, remainingChars - 1);
      promptSections.push(sliced);
      remainingChars = Math.max(0, remainingChars - sliced.length - 1);
      return true;
    }
    return false;
  };

  // ① 本轮焦点与句子 + 全图承重头部
  const headerLine = `图版本 v${sessionSnapshot.graphVersion ?? 0}（局部节点 ${candidateLocalNodes.length}/${allNodes.length}，全图总承重 ${totalWeight}，历史有效事实 ${allActiveFacts.length} 条）`;
  pushBoundedLine(headerLine, true);
  if (userText && String(userText).trim()) {
    pushBoundedLine(`当前输入：“${truncateText(String(userText), 240)}”`, true);
  }
  if (effectiveFocus) {
    const focusSpan = effectiveFocus.spanText ?? effectiveFocus.span ?? effectiveFocus.nodeId ?? '';
    pushBoundedLine(
      `当前焦点：${focusSpan}（${effectiveFocus.kind ?? 'focus'}）${effectiveFocus.reason ? ` - ${truncateText(effectiveFocus.reason, 120)}` : ''}`,
      true,
    );
  }
  if (statementsSummary.length > 0) {
    const primaryStmt = statementsSummary[0];
    pushBoundedLine(
      `主句(${primaryStmt.statementId})：assessment=${primaryStmt.assessment}, rate=${primaryStmt.rate ?? 'null'} (${primaryStmt.numerator}/${primaryStmt.denominator})`,
      false,
    );
  }

  // ② 显式引用的早期记录（优先保留！）
  const finalRetrievedEarlyItems = [];
  for (let i = 0; i < rawRetrievedEarlyItems.length; i += 1) {
    const entry = rawRetrievedEarlyItems[i];
    const itemText =
      entry.item?.text ?? entry.item?.excerpt ?? entry.item?.userText ?? '';
    const line = `早期引用[${entry.matchType}:${entry.id}]：${truncateText(itemText, 220)}`;
    if (pushBoundedLine(line, i === 0)) {
      finalRetrievedEarlyItems.push(entry);
    }
  }

  // ③ 对应已核验证据
  const finalEvidence = [];
  for (const ev of candidateEvidence) {
    const line = `证据[${ev.evidenceId}] (${ev.author ?? '未知'}/${ev.attribution})：“${truncateText(ev.excerpt, 180)}”`;
    if (pushBoundedLine(line, false)) {
      finalEvidence.push(ev);
    }
  }

  // ④ 近期对话（优先保留最近一轮，再保持时间正序）
  const keptRecentReversed = [];
  for (let i = candidateRecentTurns.length - 1; i >= 0; i -= 1) {
    const t = candidateRecentTurns[i];
    const line = `第${t.turnNumber}轮(${t.turnId}, ${t.intent ?? 'turn'}) 用户：“${t.userText}”`;
    if (pushBoundedLine(line, false)) {
      keptRecentReversed.push(t);
    }
  }
  const finalRecentTurns = keptRecentReversed.reverse();

  // ⑤ 局部图节点与相关事实摘要（超出 maxTotalChars 时截断丢弃）
  const finalLocalNodes = [];
  for (const node of candidateLocalNodes) {
    const line = `节点[${node.id}] S=${node.S}：“${truncateText(node.text, 150)}”`;
    if (pushBoundedLine(line, false)) {
      finalLocalNodes.push(node);
    }
  }

  const finalActiveFacts = [];
  for (const fact of candidateActiveFacts) {
    const line = `事实[${fact.id}] (${fact.kind}, ${fact.turnId ?? '-'})：“${truncateText(fact.text, 160)}”`;
    if (pushBoundedLine(line, false)) {
      finalActiveFacts.push(fact);
    }
  }

  const finalRetractedFacts = [];
  for (const rf of candidateRetractedFacts) {
    const line = `已撤回[${rf.id}] (撤回于 ${rf.retractedByTurnId ?? '-'})：“${rf.text}”`;
    if (pushBoundedLine(line, false)) {
      finalRetractedFacts.push(rf);
    }
  }

  const finalLocalIdSet = new Set(finalLocalNodes.map((n) => n.id));
  const localEdges = [];
  for (const n of finalLocalNodes) {
    for (const dep of n.deps) {
      if (finalLocalIdSet.has(dep)) {
        localEdges.push({ from: dep, to: n.id, kind: 'supports' });
      }
    }
  }

  const pillarPool =
    allNodes.length > safeMaxNodes && finalLocalNodes.length > 0 ? finalLocalNodes : allNodes;
  const topPillars = [...pillarPool]
    .sort((a, b) => (b.S ?? 0) - (a.S ?? 0))
    .slice(0, Math.min(3, safeMaxNodes))
    .map((n) => ({ id: n.id, text: truncateText(n.text, 80), S: n.S ?? 0 }));

  const localGraph = {
    seedNodeIds: [...seedNodeIds].filter((id) => finalLocalIdSet.has(id)),
    nodes: finalLocalNodes,
    edges: localEdges,
    omittedNodeCount: Math.max(0, allNodes.length - finalLocalNodes.length),
    summary: {
      graphVersion: sessionSnapshot.graphVersion ?? 0,
      totalNodes: allNodes.length,
      includedLocalNodes: finalLocalNodes.length,
      totalWeight,
      rootCount: allNodes.filter((n) => (n.deps?.length ?? 0) === 0).length,
      maxDepth: allNodes.reduce(
        (max, n) => (Number.isFinite(n.d) && n.d > max ? n.d : max),
        0,
      ),
      topPillars,
    },
  };

  const summaryLines = [
    `图版本 v${sessionSnapshot.graphVersion ?? 0}（局部节点 ${finalLocalNodes.length}/${allNodes.length}，全图总承重 ${totalWeight}）`,
  ];
  if (finalRecentTurns.length > 0) {
    summaryLines.push(
      ...finalRecentTurns.map(
        (t) => `第${t.turnNumber}轮(${t.turnId}, ${t.intent ?? 'turn'}) 用户：“${t.userText}”`,
      ),
    );
  }
  if (finalRetrievedEarlyItems.length > 0) {
    summaryLines.push(
      `按引用取回早期记录：${finalRetrievedEarlyItems.map((i) => `${i.matchType}:${i.id}`).join(', ')}`,
    );
  }

  const promptText = truncateText(promptSections.join('\n'), safeMaxTotalChars);
  const summary = truncateText(summaryLines.join('\n'), safeMaxTotalChars);
  const omittedFactCount = Math.max(0, allActiveFacts.length - finalActiveFacts.length);
  const omittedRetractedFactCount = Math.max(
    0,
    allRetractedFacts.length - finalRetractedFacts.length,
  );

  const rawComparison = sessionSnapshot.statementComparison;
  const compactComparison = rawComparison
    ? {
        graphVersion: rawComparison.graphVersion ?? sessionSnapshot.graphVersion ?? 0,
        denominator: rawComparison.denominator ?? totalWeight,
        totalNodes: rawComparison.totalNodes ?? allNodes.length,
        baselineStatementId: rawComparison.baselineStatementId ?? null,
        adoptedStatementId: rawComparison.adoptedStatementId ?? null,
        comparisons: Array.isArray(rawComparison.comparisons)
          ? rawComparison.comparisons.slice(-6)
          : [],
      }
    : null;

  return {
    sessionId: sessionSnapshot.sessionId,
    dataMode: sessionSnapshot.dataMode,
    graphVersion: sessionSnapshot.graphVersion ?? 0,
    currentFocus: effectiveFocus,
    localGraph,
    relevantEvidence: finalEvidence,
    activeFacts: finalActiveFacts,
    omittedFactCount,
    retractedFactsDigest: finalRetractedFacts,
    deniedAttributions: deniedAttributionsBounded,
    statements: statementsSummary,
    statementComparison: compactComparison,
    pendingConfirmations: pendingConfirmationsBounded,
    recentTurns: finalRecentTurns,
    retrievedEarlyItems: finalRetrievedEarlyItems,
    promptText,
    summary,
    budgetStats: {
      maxTotalChars: safeMaxTotalChars,
      promptChars: promptText.length,
      totalNodes: allNodes.length,
      includedLocalNodes: finalLocalNodes.length,
      omittedNodeCount: Math.max(0, allNodes.length - finalLocalNodes.length),
      totalFacts: allActiveFacts.length,
      includedFacts: finalActiveFacts.length,
      omittedFactCount,
      totalRetractedFacts: allRetractedFacts.length,
      includedRetractedFacts: finalRetractedFacts.length,
      omittedRetractedFactCount,
      totalEvidence: allEvidence.length,
      includedEvidence: finalEvidence.length,
      omittedEvidenceCount: Math.max(0, allEvidence.length - finalEvidence.length),
      totalHistoricalTurns: completedOrCommittedTurns.length,
      includedRecentTurns: finalRecentTurns.length,
      omittedEarlierTurns: Math.max(0, completedOrCommittedTurns.length - finalRecentTurns.length),
      retrievedEarlyCount: finalRetrievedEarlyItems.length,
    },
  };
}
