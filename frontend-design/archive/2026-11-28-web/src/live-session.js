/* 「报价」正式前端 `/v1` 同源会话与 SSE 流式订阅控制器
   - 仅与本机同源宿主通信（credentials: 'same-origin'），绝不接触、存储或渲染任何 Bearer 令牌
   - 启动时通过 GET /health + POST /api/host/session 读取宿主模式（public | demo）、dataMode、usePersonalMaterials 与 capabilities
   - 支持公开对话（publicAnalysis 与 graphVersion 原子同版同步）、会话恢复（含生成中刷新续流无重发）、Last-Event-ID 去重续读与主动停止 */

const DEMO_SESSION_STORAGE_KEY = "quotation-demo-session-id";
const PUBLIC_SESSION_STORAGE_KEY = "quotation-public-session-id";
const MAX_SSE_RECONNECTS = 6;

export const STAGE_LABELS = Object.freeze({
  checking_local_graph: "核对本地已确认图",
  retrieving_evidence: "检索公开与候选依据",
  verifying_candidates: "核验候选证据与归属",
  streaming_explanation: "流式生成中文解释",
});

export const PUBLIC_STAGE_LABELS = Object.freeze({
  checking_local_graph: "先理清你这句话里的关键条件…",
  retrieving_evidence: "正在知乎公开讨论里找相关依据…",
  verifying_candidates: "正在逐条核对出处和适用范围…",
  streaming_explanation: "正在把看到的依据整理给你…",
});

export const TURN_STATUS_LABELS = Object.freeze({
  idle: "空闲",
  pending: "待确认",
  running: "运行中",
  committed: "已提交",
  cancelled: "已取消",
  failed: "失败",
});

export const PUBLIC_TURN_STATUS_LABELS = Object.freeze({
  idle: "随时可以继续",
  pending: "正在对齐结果…",
  running: "正在翻看资料…",
  committed: "这一轮已整理好",
  cancelled: "已先停下",
  failed: "这次没能完成",
});

export const ASSESSMENT_LABELS = Object.freeze({
  conflict: "直接冲突",
  compatible: "相容",
  insufficient_evidence: "暂未确定（证据不足）",
});

export const SOURCE_TYPE_LABELS = Object.freeze({
  collection_record: "合成个人采集",
  public_search: "公开检索",
  session_turn: "本轮本人陈述",
});

export const RELATION_LABELS = Object.freeze({
  supports: "支持",
  refutes: "反驳",
  qualifies: "限定",
  unknown: "待定",
});

export function normalizeRelation(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (!key) return "unknown";
  if (["supports", "support", "supported", "compatible", "agree", "agrees", "confirm", "confirms"].includes(key)) {
    return "supports";
  }
  if (["refutes", "refute", "refuted", "contradicts", "contradict", "conflict", "conflicts", "counterexample", "opposes", "oppose"].includes(key)) {
    return "refutes";
  }
  if (["qualifies", "qualify", "qualified", "limits", "limit", "limited", "narrows", "narrow", "partial", "scoped", "conditional", "nuance"].includes(key)) {
    return "qualifies";
  }
  return "unknown";
}

export function getRelationLabel(raw) {
  return RELATION_LABELS[normalizeRelation(raw)] || "待定";
}

export function formatRateDisplay(quote) {
  if (!quote || quote.rate === null || quote.rate === undefined || quote.assessment === "insufficient_evidence") {
    return { text: "暂未确定", numeric: null, hasUnit: false };
  }
  const num = Number(quote.rate);
  if (!Number.isFinite(num)) {
    return { text: "暂未确定", numeric: null, hasUnit: false };
  }
  return { text: String(Math.round(num)), numeric: Math.round(num), hasUnit: true };
}

export function formatGentleError(error) {
  const code = String(error?.code || "").toUpperCase();
  const rawMessage = typeof error?.message === "string" ? error.message.trim() : "";

  if (code.includes("RATE_LIMIT") || code.includes("QUOTA") || code === "HTTP_429") {
    return {
      title: "查资料的通道这会儿有点忙",
      message: "你的原句还留在这里，过一小会儿再试一次就好。",
      suggestDemo: false,
    };
  }
  if (code.includes("TIMEOUT") || code === "HTTP_408" || code === "HTTP_504") {
    return {
      title: "这次等待时间有点长",
      message: "资料还没传回来。你的原句还在这里，等一下可以再试。",
      suggestDemo: false,
    };
  }
  if (
    code.includes("NOT_CONFIGURED")
    || code.includes("MISSING_CONFIG")
    || code.includes("MISSING_API_KEY")
    || code.includes("MISSING_CREDENTIALS")
    || code.includes("UPSTREAM_NOT_READY")
  ) {
    return {
      title: "服务端还没有配好检索或模型通道",
      message: rawMessage || "你的原句还留在这里。配好服务后可以再试，如果想先体验界面，也可以自己切换到离线合成示例。",
      suggestDemo: true,
    };
  }
  if (code.includes("SEARCH") || code.includes("ZHIHU") || code.includes("RETRIEV")) {
    return {
      title: "这次没能查到资料",
      message: "你的原句还在这里，等一下可以再试。",
      suggestDemo: false,
    };
  }
  if (code.includes("MODEL") || code.includes("LLM") || code === "HTTP_502" || code === "HTTP_503") {
    return {
      title: "模型暂时没能接上话",
      message: "你的原句还留在这里，等一下可以再试一次。",
      suggestDemo: false,
    };
  }
  return {
    title: "这次没能顺利完成",
    message: rawMessage || "你的原句还在这里，等一下可以再试。",
    suggestDemo: false,
  };
}

export function analyzeHostCapabilities(capabilities, hostMode) {
  if (hostMode !== "public" || !capabilities || typeof capabilities !== "object") {
    return null;
  }

  const checkFlag = (obj, keys) => {
    for (const k of keys) {
      if (typeof obj[k] === "boolean") return obj[k];
      if (obj[k] && typeof obj[k] === "object") {
        if (typeof obj[k].ready === "boolean") return obj[k].ready;
        if (typeof obj[k].configured === "boolean") return obj[k].configured;
        if (typeof obj[k].available === "boolean") return obj[k].available;
        if (typeof obj[k].enabled === "boolean") return obj[k].enabled;
      }
    }
    return null;
  };

  const searchOk = checkFlag(capabilities, ["searchReady", "searchConfigured", "searchAvailable", "zhihuSearch", "search"]);
  const modelOk = checkFlag(capabilities, ["modelReady", "modelConfigured", "modelAvailable", "llm", "model"]);
  const missingSearch = searchOk === false;
  const missingModel = modelOk === false;
  const missingList = Array.isArray(capabilities.missingConfig)
    ? capabilities.missingConfig.filter(Boolean)
    : [];
  const degraded = Boolean(capabilities.degraded || missingSearch || missingModel || missingList.length > 0);

  if (!degraded) return null;

  const missingParts = [];
  if (missingSearch) missingParts.push("公开检索");
  if (missingModel) missingParts.push("语言模型");
  const customMsg = typeof capabilities.message === "string" && capabilities.message.trim()
    ? capabilities.message.trim()
    : (typeof capabilities.degradedReason === "string" && capabilities.degradedReason.trim()
      ? capabilities.degradedReason.trim()
      : "");

  const title = missingParts.length > 0
    ? `服务端的${missingParts.join("和")}还没有准备好`
    : "服务端的上游配置暂时不完整";
  const message = customMsg
    || "现在可能查不到真实资料或生成回复。你可以等配置好后再试，也可以按需要自己切换到离线合成体验。";

  return {
    missingSearch,
    missingModel,
    degraded: true,
    title,
    message,
    demoHint: typeof capabilities.demoHint === "string" && capabilities.demoHint.trim()
      ? capabilities.demoHint.trim()
      : "离线合成体验使用本地样例，需要时由你主动切换，不会悄悄替换你的输入。",
  };
}

function safeHttpUrl(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeUnknownEntry(entry) {
  if (typeof entry === "string") return entry.trim();
  if (entry && typeof entry === "object") {
    return String(entry.text || entry.reason || entry.question || entry.description || entry.label || "").trim();
  }
  return "";
}

export function normalizePublicAnalysis(raw, snap = null) {
  if (!raw || typeof raw !== "object") return null;

  const evidenceIndex = Array.isArray(snap?.evidenceIndex) ? snap.evidenceIndex : [];
  const evidenceById = new Map(
    evidenceIndex.map((ev) => [String(ev.id || ev.evidenceId || ""), ev]).filter(([k]) => Boolean(k)),
  );

  const graphVersion = Number.isInteger(raw.graphVersion)
    ? raw.graphVersion
    : (Number.isInteger(raw.version)
      ? raw.version
      : (Number.isInteger(snap?.graphVersion) ? snap.graphVersion : 0));

  const claimObj = raw.claim && typeof raw.claim === "object" ? raw.claim : null;
  const claimText = String(
    claimObj?.text
    || (typeof raw.claim === "string" ? raw.claim : "")
    || raw.currentClaim?.text
    || raw.statementText
    || snap?.statements?.at(-1)?.text
    || "",
  ).trim();

  const focus = raw.focus || raw.currentFocus || claimObj?.focus || snap?.currentFocus || null;

  const rawNodes = Array.isArray(raw.nodes)
    ? raw.nodes
    : (Array.isArray(raw.graph?.nodes) ? raw.graph.nodes : []);
  const rawEdges = Array.isArray(raw.edges)
    ? raw.edges
    : (Array.isArray(raw.graph?.edges)
      ? raw.graph.edges
      : (Array.isArray(raw.relations) ? raw.relations : []));

  const nodes = rawNodes.map((n, idx) => {
    const evIds = Array.isArray(n.evidenceIds)
      ? n.evidenceIds.map(String).filter(Boolean)
      : (n.evidenceId ? [String(n.evidenceId)] : []);
    const primaryEvId = n.evidenceId ? String(n.evidenceId) : (evIds[0] || null);
    const linkedEv = primaryEvId ? evidenceById.get(primaryEvId) : null;
    const kind = String(n.kind || n.type || n.role || (primaryEvId ? "evidence" : "claim")).toLowerCase();
    return {
      ...n,
      id: String(n.id || `pub_node_${idx + 1}`),
      kind,
      label: String(n.label || n.name || n.title || linkedEv?.title || n.text || n.id || `节点 ${idx + 1}`).trim(),
      text: String(n.text || n.summary || n.excerpt || linkedEv?.excerpt || n.label || "").trim(),
      author: String(n.author || linkedEv?.author || "").trim() || null,
      attribution: n.attribution || linkedEv?.attribution || (kind === "evidence" ? "other_author" : null),
      url: safeHttpUrl(n.url || n.canonicalUrl || linkedEv?.canonicalUrl || linkedEv?.url),
      evidenceId: primaryEvId,
      evidenceIds: evIds,
      relation: n.relation ? normalizeRelation(n.relation) : null,
      status: n.status || "active",
    };
  });

  const edges = rawEdges.map((e, idx) => {
    const rel = normalizeRelation(e.relation || e.kind || e.type || e.stance);
    const evIds = Array.isArray(e.evidenceIds)
      ? e.evidenceIds.map(String).filter(Boolean)
      : (e.evidenceId ? [String(e.evidenceId)] : []);
    return {
      ...e,
      id: String(e.id || `pub_edge_${idx + 1}`),
      from: String(e.from || e.source || e.sourceId || ""),
      to: String(e.to || e.target || e.targetId || ""),
      relation: rel,
      relationLabel: getRelationLabel(rel),
      reason: String(e.reason || e.explanation || e.summary || "").trim(),
      evidenceId: e.evidenceId ? String(e.evidenceId) : (evIds[0] || null),
      evidenceIds: evIds,
    };
  });

  // 为节点补齐从边推断的关系（方便星图与节点列表直接按关系着色）
  const edgeByFrom = new Map();
  const edgeByEvId = new Map();
  for (const edge of edges) {
    if (edge.from && !edgeByFrom.has(edge.from)) edgeByFrom.set(edge.from, edge);
    if (edge.to && !edgeByFrom.has(edge.to)) edgeByFrom.set(edge.to, edge);
    if (edge.evidenceId && !edgeByEvId.has(edge.evidenceId)) edgeByEvId.set(edge.evidenceId, edge);
    for (const eid of edge.evidenceIds) {
      if (!edgeByEvId.has(eid)) edgeByEvId.set(eid, edge);
    }
  }
  for (const node of nodes) {
    if (!node.relation && node.kind !== "claim") {
      const matchedEdge = (node.evidenceId && edgeByEvId.get(node.evidenceId)) || edgeByFrom.get(node.id) || null;
      if (matchedEdge) {
        node.relation = matchedEdge.relation;
      }
    }
    node.relationLabel = node.kind === "claim" ? "当前句子" : getRelationLabel(node.relation);
  }

  // 构建 nodeId 查找索引（按 evidenceId 定位对应星图节点）
  const nodeIdByEvId = new Map();
  for (const node of nodes) {
    if (node.evidenceId && !nodeIdByEvId.has(node.evidenceId)) {
      nodeIdByEvId.set(node.evidenceId, node.id);
    }
    for (const eid of node.evidenceIds) {
      if (!nodeIdByEvId.has(eid)) nodeIdByEvId.set(eid, node.id);
    }
  }

  const rawCitations = Array.isArray(raw.citations)
    ? raw.citations
    : (Array.isArray(raw.verifiedCitations) ? raw.verifiedCitations : []);

  const citationMap = new Map();
  const pushCitation = (c) => {
    if (!c) return;
    const evId = String(c.evidenceId || c.id || "").trim();
    if (!evId || citationMap.has(evId)) return;
    const ev = evidenceById.get(evId) || null;
    const matchedEdge = edgeByEvId.get(evId) || null;
    const rel = normalizeRelation(c.relation || matchedEdge?.relation || c.stance);
    const linkedNodeId = c.nodeId
      ? String(c.nodeId)
      : (nodeIdByEvId.get(evId) || (matchedEdge?.from && matchedEdge.from !== "claim" ? matchedEdge.from : null));
    const url = safeHttpUrl(c.canonicalUrl || c.url || ev?.canonicalUrl || ev?.url);
    citationMap.set(evId, {
      evidenceId: evId,
      nodeId: linkedNodeId || null,
      title: String(c.title || ev?.title || `公开依据 ${evId}`).trim(),
      author: String(c.author || ev?.author || "公开作者").trim(),
      attribution: c.attribution || ev?.attribution || "other_author",
      excerpt: String(c.excerpt || ev?.excerpt || c.quote || "").trim(),
      quote: String(c.quote || c.usedSnippet || c.excerpt || ev?.excerpt || "").trim(),
      url,
      relation: rel,
      relationLabel: getRelationLabel(rel),
      reason: String(c.reason || matchedEdge?.reason || "").trim(),
    });
  };

  for (const c of rawCitations) pushCitation(c);
  if (citationMap.size === 0) {
    for (const edge of edges) {
      if (edge.evidenceId) pushCitation({ evidenceId: edge.evidenceId, relation: edge.relation, reason: edge.reason });
    }
    for (const node of nodes) {
      if (node.kind !== "claim" && node.evidenceId) {
        pushCitation({ evidenceId: node.evidenceId, nodeId: node.id, relation: node.relation });
      }
    }
  }
  const citations = [...citationMap.values()];

  // 建议改写
  const rawRewrite = raw.suggestedRewrite ?? raw.rewrite ?? raw.recommendedRewrite ?? null;
  let suggestedRewrite = null;
  if (typeof rawRewrite === "string" && rawRewrite.trim()) {
    suggestedRewrite = {
      text: rawRewrite.trim(),
      explanation: "",
      preserved: "",
      narrowed: "",
      evidenceIds: [],
    };
  } else if (rawRewrite && typeof rawRewrite === "object") {
    const rewriteText = String(
      rawRewrite.text || rawRewrite.rewrittenText || rawRewrite.statement || rawRewrite.content || "",
    ).trim();
    if (rewriteText) {
      suggestedRewrite = {
        text: rewriteText,
        explanation: String(rawRewrite.explanation || rawRewrite.reason || rawRewrite.summary || rawRewrite.note || "").trim(),
        preserved: String(rawRewrite.preserved || rawRewrite.kept || rawRewrite.retains || rawRewrite.whatKept || "").trim(),
        narrowed: String(rawRewrite.narrowed || rawRewrite.narrowedScope || rawRewrite.changed || rawRewrite.whatNarrowed || rawRewrite.scopeChange || "").trim(),
        evidenceIds: Array.isArray(rawRewrite.evidenceIds) ? rawRewrite.evidenceIds.map(String) : [],
      };
    }
  }

  // 关系变化
  const rawChanges = Array.isArray(raw.relationChanges)
    ? raw.relationChanges
    : (Array.isArray(raw.edgeChanges) ? raw.edgeChanges : []);
  const relationChanges = rawChanges.map((item, idx) => {
    const evId = item.evidenceId ? String(item.evidenceId) : null;
    const ev = evId ? evidenceById.get(evId) : null;
    const beforeRaw = item.before ?? item.previousRelation ?? item.fromRelation ?? item.oldRelation ?? null;
    const afterRaw = item.after ?? item.currentRelation ?? item.nextRelation ?? item.newRelation ?? null;
    const before = beforeRaw ? normalizeRelation(beforeRaw) : null;
    const after = afterRaw ? normalizeRelation(afterRaw) : null;
    return {
      id: String(item.id || `change_${idx + 1}`),
      evidenceId: evId,
      nodeId: item.nodeId ? String(item.nodeId) : (evId ? nodeIdByEvId.get(evId) || null : null),
      title: String(item.title || item.label || ev?.title || (evId ? `依据 ${evId}` : `条目 ${idx + 1}`)).trim(),
      author: String(item.author || ev?.author || "").trim(),
      before,
      beforeLabel: before ? getRelationLabel(before) : "之前未判定",
      after,
      afterLabel: after ? getRelationLabel(after) : "待定",
      changed: typeof item.changed === "boolean" ? item.changed : (before !== after),
      reason: String(item.reason || item.explanation || item.summary || "").trim(),
    };
  });

  const changeSummary = String(
    raw.changeSummary || raw.diffSummary || raw.relationChangeSummary || raw.comparisonSummary || "",
  ).trim();

  // 材料边界与未知项
  const mb = raw.materialBoundary && typeof raw.materialBoundary === "object"
    ? raw.materialBoundary
    : (typeof raw.materialBoundary === "string" ? { state: "empty", message: raw.materialBoundary } : null);
  const rawUnknowns = [
    ...(Array.isArray(raw.unknowns) ? raw.unknowns : []),
    ...(Array.isArray(raw.unknownParts) ? raw.unknownParts : []),
    ...(Array.isArray(raw.uncertainItems) ? raw.uncertainItems : []),
    ...(Array.isArray(mb?.unknowns) ? mb.unknowns : []),
    ...(Array.isArray(mb?.unknownParts) ? mb.unknownParts : []),
    ...(Array.isArray(mb?.gaps) ? mb.gaps : []),
  ];
  const unknowns = [...new Set(rawUnknowns.map(normalizeUnknownEntry).filter(Boolean))];

  const materialBoundary = mb
    ? {
        state: String(mb.searchStatus || mb.state || "ok"),
        searchStatus: String(mb.searchStatus || mb.state || "ok"),
        code: mb.code || mb.errorCode || null,
        message: String(mb.message || "").trim(),
        unknowns,
        unknownParts: unknowns,
      }
    : null;

  const statementHistory = Array.isArray(raw.statementHistory) ? raw.statementHistory : [];

  return {
    version: Number.isInteger(raw.version) ? raw.version : graphVersion,
    graphVersion,
    turnId: raw.turnId || null,
    claimText,
    claim: claimObj,
    focus,
    nodes,
    edges,
    citations,
    suggestedRewrite,
    relationChanges,
    changeSummary,
    statementHistory,
    materialBoundary,
    unknowns,
  };
}

function buildConversationHistory(snap, publicAnalysis, fallbackFocus = null) {
  const turns = Array.isArray(snap?.turns) ? snap.turns : [];
  const latestCommittedIndex = (() => {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      if (turns[i]?.status === "committed") return i;
    }
    return -1;
  })();

  return turns.map((turn, idx) => {
    const turnId = turn.turnId || turn.id || `turn_${idx + 1}`;
    const isLatestCommitted = idx === latestCommittedIndex;
    const turnAnalysis = turn.publicAnalysis
      ? normalizePublicAnalysis(turn.publicAnalysis, snap)
      : (isLatestCommitted ? publicAnalysis : null);

    return {
      turnId,
      turnNumber: turn.turnNumber ?? idx + 1,
      status: turn.status || "committed",
      userText: String(turn.userText || turn.text || "").trim(),
      replyText: String(turn.responseText || turn.explanation || "").trim(),
      focus: turn.focus || turnAnalysis?.focus || (isLatestCommitted ? (snap?.currentFocus || fallbackFocus || null) : null),
      citations: turnAnalysis?.citations || [],
      changeSummary: turnAnalysis?.changeSummary || "",
      relationChanges: turnAnalysis?.relationChanges || [],
      suggestedRewrite: turnAnalysis?.suggestedRewrite || null,
      graphVersion: Number.isInteger(turn.committedGraphVersion)
        ? turn.committedGraphVersion
        : (Number.isInteger(turnAnalysis?.graphVersion) ? turnAnalysis.graphVersion : snap?.graphVersion ?? 0),
      error: turn.error || null,
    };
  });
}

function makeRequestId(prefix = "web") {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    }
  } catch {
    // 忽略降级
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function storageKeyForMode(hostMode) {
  return hostMode === "public" ? PUBLIC_SESSION_STORAGE_KEY : DEMO_SESSION_STORAGE_KEY;
}

function readStoredSessionId(hostMode = "demo") {
  try {
    const val = sessionStorage.getItem(storageKeyForMode(hostMode));
    return typeof val === "string" && val.trim() ? val.trim() : null;
  } catch {
    return null;
  }
}

function writeStoredSessionId(sessionId, hostMode = "demo") {
  try {
    const key = storageKeyForMode(hostMode);
    if (sessionId) sessionStorage.setItem(key, sessionId);
    else sessionStorage.removeItem(key);
  } catch {
    // 隐私模式可能禁用 sessionStorage
  }
}

export function parseSseBlock(rawBlock) {
  if (!rawBlock || !rawBlock.trim()) return null;
  const lines = rawBlock.split(/\r?\n/);
  let id = null;
  let event = "message";
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("id:")) {
      const parsedId = Number(line.slice(3).trim());
      if (Number.isInteger(parsedId) && parsedId > 0) id = parsedId;
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim() || "message";
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) return null;
  let data = null;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    data = { raw: dataLines.join("\n") };
  }
  return { id, event, data };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createLiveSessionController() {
  const listeners = new Set();

  let state = {
    hostAvailable: false,
    hostChecked: false,
    hostMode: "static", // 'public' | 'demo' | 'static'
    mode: "static", // 'static' | 'live'
    dataMode: "demo", // 由宿主握手决定（public -> 'real', demo -> 'demo'）
    defaultUsePersonalMaterials: true,
    capabilities: null,
    capabilityIssue: null,
    offlineDemoChosen: false,

    sessionId: null,
    ownerId: null,
    graphVersion: 0,
    lockedSnapshotId: null,
    materialsStatus: null,
    snapshot: null,
    confirmedGraph: [],
    facts: [],
    evidenceIndex: [],
    pendingConfirmations: [],
    deniedAttributions: [],
    statements: [],
    statementComparison: null,
    adoptedStatementId: null,
    invalidatedHistory: [],
    convergenceSummary: null,
    turns: [],

    // 公开体验分析与对话流（与 graphVersion 严格原子同版更新）
    publicAnalysis: null,
    conversationHistory: [],

    // 当前轮次流式状态（与结构化报价、公开分析图严格分离）
    turnStatus: "idle", // idle | pending | running | committed | cancelled | failed
    loading: false,
    activeTurnId: null,
    activeEventsUrl: null,
    activeTurnUserText: "",
    lastSubmittedText: "",
    lastFailedTurn: null, // { text, action, error }
    currentStage: null,
    currentFocus: null,
    lastVerifiedEvidence: [],
    explanationText: "",
    lastEventId: 0,
    reconnectCount: 0,
    lastTurnIntent: null,
    lastGraphDelta: null,
    error: null,
    staleConflict: null, // { payload, message, latestGraphVersion }
    boundFocusNodeId: null,
    busyAction: false,

    // 图账 / 公开分析原子快照同步状态（防止 turn.committed 与 GET /v1/sessions/:id 之间错版）
    syncStatus: "idle", // idle | syncing | error
    pendingSyncVersion: null,
    pendingSyncTurnId: null,
    syncError: null, // { code, message } | null
  };

  let sseAbortController = null;
  let activeStreamGeneration = 0;
  let snapshotRequestSeq = 0;
  let appliedSnapshotSeq = 0;
  let activeSnapshotSyncPromise = null;
  let activeSnapshotSyncKey = null;

  function resolveRunningTurn(snap) {
    if (!snap || typeof snap !== "object") return null;
    const turns = Array.isArray(snap.turns) ? snap.turns : [];
    if (typeof snap.activeTurnId === "string" && snap.activeTurnId.trim()) {
      const targetId = snap.activeTurnId.trim();
      const matched = turns.find((t) => (t?.turnId ?? t?.id) === targetId) ?? null;
      return { turnId: targetId, turn: matched };
    }
    const lastTurn = turns.at(-1) ?? null;
    if (lastTurn?.status === "running") {
      const tid = lastTurn.turnId ?? lastTurn.id ?? null;
      return tid ? { turnId: tid, turn: lastTurn } : null;
    }
    return null;
  }

  function buildTurnEventsUrl(sessionId, turnId) {
    return `/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events`;
  }

  function isSnapshotStaleForSync(snap, { minGraphVersion = null, requiredTurnId = null } = {}) {
    if (!snap || typeof snap !== "object") return true;
    const snapVersion = Number.isInteger(snap.graphVersion) ? snap.graphVersion : 0;
    if (Number.isInteger(minGraphVersion) && snapVersion < minGraphVersion) {
      return true;
    }
    if (requiredTurnId) {
      if (typeof snap.activeTurnId === "string" && snap.activeTurnId === requiredTurnId) {
        return true;
      }
      const turns = Array.isArray(snap.turns) ? snap.turns : [];
      const targetTurn = turns.find((t) => (t?.turnId ?? t?.id) === requiredTurnId);
      if (targetTurn && targetTurn.status !== "committed") {
        return true;
      }
    }
    return false;
  }

  function emit() {
    const view = getState();
    for (const fn of listeners) {
      try {
        fn(view);
      } catch (err) {
        console.error("[live-session] listener error:", err);
      }
    }
  }

  function setState(patch) {
    state = { ...state, ...patch };
    emit();
  }

  function getState() {
    return state;
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function stopSseLoop() {
    activeStreamGeneration += 1;
    if (sseAbortController) {
      try {
        sseAbortController.abort();
      } catch {
        // 忽略
      }
      sseAbortController = null;
    }
  }

  function applySnapshot(snap, { keepStreamMeta = true, atomicPatch = null } = {}) {
    if (!snap || typeof snap !== "object") return;
    const confirmedGraph = Array.isArray(snap.confirmedGraph) ? snap.confirmedGraph : [];
    const facts = Array.isArray(snap.facts) ? snap.facts : [];
    const evidenceIndex = Array.isArray(snap.evidenceIndex) ? snap.evidenceIndex : [];
    const pendingConfirmations = Array.isArray(snap.pendingConfirmations) ? snap.pendingConfirmations : [];
    const deniedAttributions = Array.isArray(snap.deniedAttributions) ? snap.deniedAttributions : [];
    const statements = Array.isArray(snap.statements) ? snap.statements : [];
    const turns = Array.isArray(snap.turns) ? snap.turns : [];

    // 若已绑定节点已被撤回移除，则自动解除绑定
    const boundStillExists = state.boundFocusNodeId
      ? confirmedGraph.some((n) => n.id === state.boundFocusNodeId)
      : false;

    const runningInfo = resolveRunningTurn(snap);
    const runningTurnId = runningInfo?.turnId ?? null;
    const latestCommittedTurn = [...turns].reverse().find((t) => t.status === "committed") ?? null;
    const restoredExplanation = !keepStreamMeta
      ? (runningTurnId ? "" : (latestCommittedTurn?.responseText || ""))
      : state.explanationText;

    const rawPublicAnalysis = snap.publicAnalysis ?? latestCommittedTurn?.publicAnalysis ?? null;
    const publicAnalysis = normalizePublicAnalysis(rawPublicAnalysis, snap);
    const resolvedFocus = snap.currentFocus ?? state.currentFocus;
    const conversationHistory = buildConversationHistory(snap, publicAnalysis, resolvedFocus);

    let nextTurnStatus = state.turnStatus;
    if (!keepStreamMeta) {
      if (runningTurnId) {
        nextTurnStatus = "running";
      } else if (turns.length > 0) {
        const lastTurn = turns.at(-1);
        nextTurnStatus = lastTurn?.status === "committed"
          ? "committed"
          : lastTurn?.status === "cancelled"
            ? "cancelled"
            : (lastTurn?.status === "failed" || lastTurn?.status === "interrupted")
              ? "failed"
              : "idle";
      } else {
        nextTurnStatus = "idle";
      }
    }

    const rawAdopted = snap.adoptedStatementId ?? snap.statementComparison?.adoptedStatementId ?? null;
    const adoptedStatementId = typeof rawAdopted === "string" && rawAdopted.trim()
      ? rawAdopted.trim()
      : null;

    setState({
      mode: "live",
      dataMode: snap.dataMode || state.dataMode,
      sessionId: snap.sessionId || state.sessionId,
      ownerId: snap.ownerId || state.ownerId,
      graphVersion: Number.isInteger(snap.graphVersion) ? snap.graphVersion : 0,
      lockedSnapshotId: snap.lockedSnapshotId ?? snap.snapshotId ?? null,
      materialsStatus: snap.materialsStatus ?? state.materialsStatus,
      snapshot: snap,
      confirmedGraph,
      facts,
      evidenceIndex,
      pendingConfirmations,
      deniedAttributions,
      statements,
      statementComparison: snap.statementComparison ?? null,
      adoptedStatementId,
      invalidatedHistory: Array.isArray(snap.invalidatedHistory) ? snap.invalidatedHistory : [],
      convergenceSummary: snap.convergenceSummary ?? null,
      turns,
      publicAnalysis,
      conversationHistory,
      currentFocus: snap.currentFocus ?? state.currentFocus,
      explanationText: restoredExplanation,
      turnStatus: nextTurnStatus,
      boundFocusNodeId: boundStillExists ? state.boundFocusNodeId : null,
      ...(atomicPatch && typeof atomicPatch === "object" ? atomicPatch : {}),
    });
  }

  async function apiJson(url, options = {}) {
    const res = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {}),
      },
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { res, json };
  }

  function resolveHandshakeState(healthData, handshakeData) {
    const rawMode = handshakeData?.mode || healthData?.mode || null;
    const rawDataMode = handshakeData?.dataMode || healthData?.dataMode || null;
    const resolvedHostMode = rawMode === "public"
      ? "public"
      : rawMode === "demo"
        ? "demo"
        : (rawDataMode === "real" ? "public" : "demo");
    const resolvedDataMode = rawDataMode || (resolvedHostMode === "public" ? "real" : "demo");
    const resolvedUsePersonal = resolvedHostMode === "public"
      ? false
      : (typeof handshakeData?.usePersonalMaterials === "boolean"
        ? handshakeData.usePersonalMaterials
        : true);
    const resolvedCapabilities = handshakeData?.capabilities ?? healthData?.capabilities ?? null;
    const capabilityIssue = analyzeHostCapabilities(resolvedCapabilities, resolvedHostMode);

    return {
      hostMode: resolvedHostMode,
      dataMode: resolvedDataMode,
      defaultUsePersonalMaterials: resolvedUsePersonal,
      capabilities: resolvedCapabilities,
      capabilityIssue,
    };
  }

  async function bootstrapHostSession() {
    const { res, json } = await apiJson("/api/host/session", { method: "POST" });
    if (!res.ok || !json?.ok) {
      throw new Error(json?.error?.message || "无法建立本机同源服务会话。");
    }
    const handshake = json.data || {};
    const resolved = resolveHandshakeState(null, handshake);
    setState({
      hostAvailable: true,
      hostChecked: true,
      ...resolved,
    });
    return { ...handshake, ...resolved };
  }

  async function checkHostAvailable() {
    try {
      const { res, json } = await apiJson("/health", { method: "GET" });
      const available = Boolean(res.ok && json?.ok && json?.data?.service === "quotation-agent-backend");
      if (!available) {
        setState({
          hostAvailable: false,
          hostChecked: true,
          hostMode: "static",
          capabilities: null,
          capabilityIssue: null,
        });
        return false;
      }

      const healthData = json.data || {};
      let handshakeData = null;
      try {
        const hs = await apiJson("/api/host/session", { method: "POST" });
        if (hs.res.ok && hs.json?.ok && hs.json?.data) {
          handshakeData = hs.json.data;
        }
      } catch {
        // 兼容未开启 /api/host/session 的独立 /v1 宿主
      }

      const resolved = resolveHandshakeState(healthData, handshakeData);
      setState({
        hostAvailable: true,
        hostChecked: true,
        ...resolved,
      });
      return true;
    } catch {
      setState({
        hostAvailable: false,
        hostChecked: true,
        hostMode: "static",
        capabilities: null,
        capabilityIssue: null,
      });
      return false;
    }
  }

  async function refreshSnapshot(
    targetSessionId = state.sessionId,
    {
      keepStreamMeta = true,
      minGraphVersion = null,
      requiredTurnId = null,
      atomicPatch = null,
      rejectStale = false,
    } = {},
  ) {
    if (!targetSessionId) return null;
    const requestSeq = ++snapshotRequestSeq;
    let res;
    let json;
    try {
      ({ res, json } = await apiJson(`/v1/sessions/${encodeURIComponent(targetSessionId)}`, {
        method: "GET",
      }));
    } catch (netErr) {
      const sessionChanged = Boolean(state.sessionId && targetSessionId !== state.sessionId);
      const supersededByNewer = requestSeq < appliedSnapshotSeq || requestSeq < snapshotRequestSeq;
      if (sessionChanged || supersededByNewer) {
        const err = new Error("快照请求已被更新请求取代。");
        err.superseded = true;
        if (rejectStale) throw err;
        return null;
      }
      const err = new Error(netErr?.message || "网络异常，读取会话快照失败。");
      err.code = netErr?.code || "NETWORK_ERROR";
      throw err;
    }

    // 忽略乱序到达的旧响应或旧会话响应，防止覆盖新状态
    const sessionChanged = Boolean(state.sessionId && targetSessionId !== state.sessionId);
    const supersededByNewer = requestSeq < appliedSnapshotSeq || requestSeq < snapshotRequestSeq;
    if (sessionChanged || supersededByNewer) {
      const err = new Error("快照请求已被更新请求取代。");
      err.superseded = true;
      if (rejectStale) throw err;
      return null;
    }

    if (!res.ok || !json?.ok || !json?.data) {
      const errCode = json?.error?.code || `HTTP_${res.status}`;
      const errMsg = json?.error?.message || "读取会话快照失败。";
      const err = new Error(errMsg);
      err.code = errCode;
      err.status = res.status;
      throw err;
    }

    const snap = json.data;
    const effectiveMinVersion = Number.isInteger(minGraphVersion)
      ? minGraphVersion
      : state.pendingSyncVersion;
    const effectiveRequiredTurnId = requiredTurnId ?? state.pendingSyncTurnId;

    const snapVersion = Number.isInteger(snap.graphVersion) ? snap.graphVersion : 0;
    const sameSessionRollback = Boolean(
      state.mode === "live"
      && state.sessionId === (snap.sessionId || targetSessionId)
      && snapVersion < state.graphVersion,
    );
    const staleForSync = isSnapshotStaleForSync(snap, {
      minGraphVersion: effectiveMinVersion,
      requiredTurnId: effectiveRequiredTurnId,
    });

    if (sameSessionRollback || staleForSync) {
      if (rejectStale) {
        const expectedV = Number.isInteger(effectiveMinVersion) ? effectiveMinVersion : state.graphVersion;
        const err = new Error(`收到的快照版本（v${snapVersion}）落后于目标版本（v${expectedV}），已保留上一版本，请重试同步。`);
        err.code = "STALE_SNAPSHOT";
        throw err;
      }
      return null;
    }

    appliedSnapshotSeq = requestSeq;
    applySnapshot(snap, { keepStreamMeta, atomicPatch });
    return snap;
  }

  async function syncCommittedSnapshot({
    sessionId = state.sessionId,
    minGraphVersion = null,
    requiredTurnId = null,
  } = {}) {
    if (!sessionId) return null;
    const targetVersion = Number.isInteger(minGraphVersion)
      ? minGraphVersion
      : (Number.isInteger(state.pendingSyncVersion) ? state.pendingSyncVersion : state.graphVersion);
    const targetTurnId = requiredTurnId ?? state.pendingSyncTurnId ?? null;
    const syncKey = `${sessionId}:${targetTurnId || ""}:${targetVersion}`;
    if (activeSnapshotSyncPromise && activeSnapshotSyncKey === syncKey) {
      return activeSnapshotSyncPromise;
    }

    setState({
      syncStatus: "syncing",
      pendingSyncVersion: targetVersion,
      pendingSyncTurnId: targetTurnId,
      syncError: null,
      turnStatus: "pending",
      loading: true,
    });

    const run = (async () => {
      try {
        return await refreshSnapshot(sessionId, {
          keepStreamMeta: true,
          minGraphVersion: targetVersion,
          requiredTurnId: targetTurnId,
          atomicPatch: {
            syncStatus: "idle",
            pendingSyncVersion: null,
            pendingSyncTurnId: null,
            syncError: null,
            turnStatus: "committed",
            activeTurnUserText: "",
            lastFailedTurn: null,
            loading: false,
            busyAction: false,
          },
          rejectStale: true,
        });
      } catch (err) {
        if (err?.superseded) return null;
        setState({
          syncStatus: "error",
          syncError: {
            code: err?.code || "SNAPSHOT_SYNC_FAILED",
            message: err?.message || "同步最新结果失败，已保留上一版本，请点击重试。",
          },
          turnStatus: "pending",
          loading: false,
          busyAction: false,
        });
        return null;
      } finally {
        if (activeSnapshotSyncKey === syncKey) {
          activeSnapshotSyncPromise = null;
          activeSnapshotSyncKey = null;
        }
      }
    })();

    activeSnapshotSyncKey = syncKey;
    activeSnapshotSyncPromise = run;
    return run;
  }

  async function retrySnapshotSync() {
    if (!state.sessionId) return null;
    if (state.syncStatus === "syncing" && activeSnapshotSyncPromise) {
      return activeSnapshotSyncPromise;
    }
    return syncCommittedSnapshot({
      sessionId: state.sessionId,
      minGraphVersion: state.pendingSyncVersion,
      requiredTurnId: state.pendingSyncTurnId,
    });
  }

  async function createSession({ usePersonalMaterials = undefined } = {}) {
    stopSseLoop();
    snapshotRequestSeq += 1;
    activeSnapshotSyncPromise = null;
    activeSnapshotSyncKey = null;
    setState({
      turnStatus: "pending",
      loading: true,
      busyAction: true,
      error: null,
      lastFailedTurn: null,
      staleConflict: null,
      activeTurnId: null,
      activeEventsUrl: null,
      activeTurnUserText: "",
      currentStage: null,
      currentFocus: null,
      lastVerifiedEvidence: [],
      explanationText: "",
      lastEventId: 0,
      reconnectCount: 0,
      lastTurnIntent: null,
      lastGraphDelta: null,
      boundFocusNodeId: null,
      publicAnalysis: null,
      conversationHistory: [],
      syncStatus: "idle",
      pendingSyncVersion: null,
      pendingSyncTurnId: null,
      syncError: null,
      offlineDemoChosen: false,
    });

    try {
      const handshake = await bootstrapHostSession();
      const effectiveHostMode = handshake.hostMode || state.hostMode;
      const effectiveDataMode = effectiveHostMode === "public"
        ? "real"
        : (handshake.dataMode || state.dataMode || "demo");
      const effectiveUsePersonalMaterials = effectiveHostMode === "public"
        ? false
        : (typeof usePersonalMaterials === "boolean"
          ? usePersonalMaterials
          : Boolean(handshake.defaultUsePersonalMaterials));

      const { res, json } = await apiJson("/v1/sessions", {
        method: "POST",
        body: JSON.stringify({
          dataMode: effectiveDataMode,
          usePersonalMaterials: effectiveUsePersonalMaterials,
        }),
      });
      if (!res.ok || !json?.ok || !json?.data?.sessionId) {
        const err = new Error(json?.error?.message || "创建会话失败，请稍后重试。");
        err.code = json?.error?.code || `HTTP_${res.status}`;
        throw err;
      }

      const created = json.data;
      writeStoredSessionId(created.sessionId, effectiveHostMode);
      setState({
        mode: "live",
        hostMode: effectiveHostMode,
        dataMode: created.dataMode || effectiveDataMode,
        sessionId: created.sessionId,
        ownerId: created.ownerId || null,
        graphVersion: created.graphVersion ?? 0,
        lockedSnapshotId: created.lockedSnapshotId ?? null,
        materialsStatus: created.materialsStatus ?? null,
      });

      const snapshot = await refreshSnapshot(created.sessionId, { keepStreamMeta: false });
      setState({ turnStatus: "idle", loading: false, busyAction: false });
      return snapshot;
    } catch (err) {
      setState({
        turnStatus: "failed",
        loading: false,
        busyAction: false,
        error: {
          code: err?.code || "SESSION_CREATE_FAILED",
          message: err?.message || "创建会话失败，请稍后重试。",
        },
      });
      throw err;
    }
  }

  async function restoreSavedSession() {
    const savedId = readStoredSessionId(state.hostMode);
    if (!savedId) return null;

    stopSseLoop();
    setState({
      turnStatus: "pending",
      loading: true,
      busyAction: true,
      error: null,
      syncStatus: "idle",
      pendingSyncVersion: null,
      pendingSyncTurnId: null,
      syncError: null,
    });
    try {
      await bootstrapHostSession();
      const snap = await refreshSnapshot(savedId, { keepStreamMeta: false });
      if (!snap) {
        setState({ turnStatus: "idle", loading: false, busyAction: false });
        return null;
      }

      const runningInfo = resolveRunningTurn(snap);
      if (runningInfo?.turnId) {
        const runningTurnId = runningInfo.turnId;
        const resolvedSessionId = snap.sessionId || savedId;
        const activeEventsUrl = buildTurnEventsUrl(resolvedSessionId, runningTurnId);
        const restoredUserText = String(runningInfo.turn?.userText || runningInfo.turn?.text || "").trim();
        // 刷新恢复运行中轮次：绝不重新 POST，立即恢复运行态与停止按钮，并异步从头重放当前轮 SSE
        setState({
          turnStatus: "running",
          activeTurnId: runningTurnId,
          activeEventsUrl,
          activeTurnUserText: restoredUserText,
          lastSubmittedText: restoredUserText || state.lastSubmittedText,
          loading: false,
          busyAction: false,
          explanationText: "",
          lastEventId: 0,
          reconnectCount: 0,
          currentStage: null,
          error: null,
        });
        void subscribeSse(activeEventsUrl, runningTurnId).catch(() => {});
        return snap;
      }

      setState({
        activeTurnId: null,
        activeEventsUrl: null,
        activeTurnUserText: "",
        currentStage: null,
        loading: false,
        busyAction: false,
      });
      return snap;
    } catch (err) {
      if (
        err?.status === 404
        || err?.status === 403
        || err?.code === "SESSION_NOT_FOUND"
        || err?.code === "SESSION_FORBIDDEN"
        || err?.code === "DATA_MODE_MISMATCH"
      ) {
        writeStoredSessionId(null, state.hostMode);
      }
      setState({ turnStatus: "idle", loading: false, busyAction: false });
      return null;
    }
  }

  async function subscribeSse(eventsUrl, turnId) {
    stopSseLoop();
    const generation = activeStreamGeneration;
    const seenEventIds = new Set();
    let lastEventId = 0;
    let receivedDone = false;
    let reconnects = 0;
    let committedInStream = false;
    let committedTargetVersion = null;
    let committedTurnId = null;

    const handleEvent = async ({ id, event, data }) => {
      if (generation !== activeStreamGeneration) return;
      if (id !== null) {
        if (seenEventIds.has(id)) return;
        seenEventIds.add(id);
        if (id > lastEventId) lastEventId = id;
      }

      if (event === "turn.started") {
        setState({
          turnStatus: "running",
          activeTurnId: data?.turnId || turnId,
          activeEventsUrl: eventsUrl,
          lastEventId,
          error: null,
          syncStatus: "idle",
          syncError: null,
        });
      } else if (event === "focus.selected") {
        setState({
          currentFocus: data?.focus ?? null,
          lastEventId,
        });
      } else if (event === "stage.changed") {
        setState({
          currentStage: data?.stage ?? null,
          lastEventId,
        });
      } else if (event === "evidence.verified") {
        const verified = Array.isArray(data?.verifiedEvidence) ? data.verifiedEvidence : [];
        const pending = Array.isArray(data?.pendingConfirmations)
          ? data.pendingConfirmations
          : state.pendingConfirmations;
        // 合并到前端即时证据展示，随后在完整快照同步时对齐；publicAnalysis 仍严格等待快照原子更新
        const mergedMap = new Map(state.evidenceIndex.map((e) => [e.id || e.evidenceId, e]));
        for (const item of verified) {
          mergedMap.set(item.id || item.evidenceId, item);
        }
        setState({
          lastVerifiedEvidence: verified,
          evidenceIndex: [...mergedMap.values()],
          pendingConfirmations: pending,
          lastEventId,
        });
      } else if (event === "text.delta") {
        const piece = typeof data?.delta === "string" ? data.delta : "";
        if (piece) {
          setState({
            explanationText: state.explanationText + piece,
            lastEventId,
          });
        }
      } else if (event === "turn.committed") {
        // 严禁在此提前覆写 graphVersion / confirmedGraph / publicAnalysis / statements / statementComparison / adoptedStatementId / facts
        // 标记「正在同步结果」，以完整快照作为星图、公开分析与账单的共同原子渲染来源
        committedInStream = true;
        committedTargetVersion = Number.isInteger(data?.graphVersion)
          ? data.graphVersion
          : state.graphVersion;
        committedTurnId = data?.turnId || turnId || state.activeTurnId;
        setState({
          syncStatus: "syncing",
          pendingSyncVersion: committedTargetVersion,
          pendingSyncTurnId: committedTurnId,
          syncError: null,
          lastTurnIntent: data?.intent ?? state.lastTurnIntent,
          lastGraphDelta: data?.graphDelta ?? state.lastGraphDelta,
          activeTurnId: null,
          activeEventsUrl: null,
          currentStage: null,
          turnStatus: "pending",
          loading: true,
          lastEventId,
        });
      } else if (event === "turn.cancelled") {
        setState({
          turnStatus: "cancelled",
          activeTurnId: null,
          activeEventsUrl: null,
          currentStage: null,
          loading: false,
          lastEventId,
        });
      } else if (event === "turn.failed") {
        const errObj = data?.error || {
          code: data?.code || "TURN_FAILED",
          message: data?.message || "本轮处理失败，已保留上一有效版本。",
        };
        const failedText = state.activeTurnUserText || state.lastSubmittedText;
        setState({
          turnStatus: "failed",
          activeTurnId: null,
          activeEventsUrl: null,
          currentStage: null,
          loading: false,
          error: errObj,
          lastFailedTurn: failedText
            ? { text: failedText, action: state.lastFailedTurn?.action ?? null, error: errObj }
            : state.lastFailedTurn,
          lastEventId,
        });
      } else if (event === "turn.done") {
        receivedDone = true;
        const finalStatus = data?.status;
        if (finalStatus === "committed" || committedInStream) {
          committedInStream = true;
          if (!Number.isInteger(committedTargetVersion) && Number.isInteger(data?.graphVersion)) {
            committedTargetVersion = data.graphVersion;
          }
          if (!committedTurnId) {
            committedTurnId = data?.turnId || turnId || state.activeTurnId;
          }
          setState({
            activeTurnId: null,
            activeEventsUrl: null,
            currentStage: null,
            syncStatus: "syncing",
            pendingSyncVersion: committedTargetVersion,
            pendingSyncTurnId: committedTurnId,
            syncError: null,
            turnStatus: "pending",
            loading: true,
            lastEventId,
          });
        } else {
          setState({
            activeTurnId: null,
            activeEventsUrl: null,
            currentStage: null,
            loading: false,
            lastEventId,
            ...(finalStatus === "cancelled" ? { turnStatus: "cancelled" } : {}),
            ...(finalStatus === "failed" || finalStatus === "interrupted" ? { turnStatus: "failed" } : {}),
          });
        }
      }
    };

    while (!receivedDone && generation === activeStreamGeneration) {
      sseAbortController = new AbortController();
      const headers = {};
      if (lastEventId > 0) {
        headers["Last-Event-ID"] = String(lastEventId);
      }

      try {
        const res = await fetch(eventsUrl, {
          method: "GET",
          credentials: "same-origin",
          headers,
          signal: sseAbortController.signal,
        });

        if (!res.ok || !res.body) {
          let errMsg = `事件流订阅失败（HTTP ${res.status}）`;
          let errCode = `HTTP_${res.status}`;
          try {
            const errJson = await res.json();
            if (errJson?.error?.message) errMsg = errJson.error.message;
            if (errJson?.error?.code) errCode = errJson.error.code;
          } catch {
            // 忽略
          }
          if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
            const errObj = { code: errCode, message: errMsg };
            setState({
              turnStatus: "failed",
              activeTurnId: null,
              activeEventsUrl: null,
              currentStage: null,
              loading: false,
              error: errObj,
              lastFailedTurn: state.activeTurnUserText
                ? { text: state.activeTurnUserText, action: null, error: errObj }
                : state.lastFailedTurn,
            });
            return;
          }
          throw new Error(errMsg);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
            const rawBlock = buffer.slice(0, boundary);
            const sepLen = buffer[boundary] === "\r" ? 4 : 2;
            buffer = buffer.slice(boundary + sepLen);
            const parsed = parseSseBlock(rawBlock);
            if (parsed) {
              await handleEvent(parsed);
            }
          }
        }

        buffer += decoder.decode();
        if (buffer.trim()) {
          const parsed = parseSseBlock(buffer);
          if (parsed) {
            await handleEvent(parsed);
          }
        }
      } catch (err) {
        if (generation !== activeStreamGeneration || err?.name === "AbortError") {
          return;
        }
        // 流异常断开且未收到 turn.done，走下方 Last-Event-ID 自动重连
      }

      if (receivedDone || generation !== activeStreamGeneration) {
        break;
      }

      reconnects += 1;
      if (reconnects > MAX_SSE_RECONNECTS) {
        if (committedInStream) {
          break;
        }
        const errObj = {
          code: "SSE_DISCONNECTED",
          message: "连接中断了好几次，这次没能续上。你的原句还在这里，等一下可以再试。",
        };
        setState({
          turnStatus: "failed",
          activeTurnId: null,
          activeEventsUrl: null,
          currentStage: null,
          loading: false,
          error: errObj,
          lastFailedTurn: state.activeTurnUserText
            ? { text: state.activeTurnUserText, action: null, error: errObj }
            : state.lastFailedTurn,
        });
        return;
      }

      setState({ reconnectCount: reconnects });
      try {
        await sleep(Math.min(150 * reconnects, 600), sseAbortController?.signal);
      } catch {
        return;
      }
    }

    if (generation !== activeStreamGeneration) return;

    // 提交终态：统一走原子快照同步，失败保留旧版并暴露重试入口
    if (committedInStream) {
      await syncCommittedSnapshot({
        sessionId: state.sessionId,
        minGraphVersion: committedTargetVersion,
        requiredTurnId: committedTurnId,
      });
      return;
    }

    // 非提交终态（如取消/失败）：尽力刷新快照对齐服务端状态
    try {
      await refreshSnapshot(state.sessionId, { keepStreamMeta: true });
    } catch {
      // 忽略非提交终态的兜底刷新失败
    } finally {
      setState({ loading: false });
    }
  }

  async function submitTurn({ text, action = null, focusRef = undefined, clientRequestId = null, baseGraphVersion = undefined } = {}) {
    const cleanText = String(text ?? "").trim();
    if (!cleanText) {
      setState({
        error: { code: "EMPTY_INPUT", message: "先把你想说的那句话写下来吧。" },
      });
      return null;
    }

    setState({
      lastSubmittedText: cleanText,
      activeTurnUserText: cleanText,
      lastFailedTurn: null,
      error: null,
    });

    if (!state.sessionId) {
      try {
        await createSession();
      } catch (err) {
        const errObj = {
          code: err?.code || "SESSION_CREATE_FAILED",
          message: err?.message || "创建会话失败，你的原句还留在这里。",
        };
        setState({
          lastFailedTurn: { text: cleanText, action, error: errObj },
          activeTurnUserText: "",
        });
        return null;
      }
    }

    const effectiveFocusRef = focusRef !== undefined
      ? focusRef
      : (state.boundFocusNodeId ? { nodeId: state.boundFocusNodeId } : null);

    const reqPayload = {
      clientRequestId: clientRequestId || makeRequestId("turn"),
      baseGraphVersion: Number.isInteger(baseGraphVersion) ? baseGraphVersion : state.graphVersion,
      text: cleanText,
      ...(effectiveFocusRef ? { focusRef: effectiveFocusRef } : {}),
      ...(action ? { action } : {}),
    };

    setState({
      turnStatus: "running",
      loading: true,
      busyAction: true,
      error: null,
      staleConflict: null,
      syncStatus: "idle",
      pendingSyncVersion: null,
      pendingSyncTurnId: null,
      syncError: null,
      activeTurnUserText: cleanText,
      lastSubmittedText: cleanText,
      lastFailedTurn: null,
      explanationText: "",
      currentStage: null,
      lastEventId: 0,
      reconnectCount: 0,
    });

    try {
      const { res, json } = await apiJson(`/v1/sessions/${encodeURIComponent(state.sessionId)}/turns`, {
        method: "POST",
        body: JSON.stringify(reqPayload),
      });

      if (!res.ok || !json?.ok) {
        const code = json?.error?.code || `HTTP_${res.status}`;
        const message = json?.error?.message || `提交轮次失败（HTTP ${res.status}）。`;

        if (res.status === 409 && code === "STALE_GRAPH_VERSION") {
          try {
            await refreshSnapshot(state.sessionId, { keepStreamMeta: true });
          } catch {
            // 忽略
          }
          setState({
            turnStatus: "idle",
            loading: false,
            busyAction: false,
            staleConflict: {
              payload: { text: cleanText, action, focusRef: effectiveFocusRef },
              message: `${message} 已刷新至最新图版本 v${state.graphVersion}，请确认是否基于当前版本重试。`,
              latestGraphVersion: state.graphVersion,
            },
          });
          return { stale: true };
        }

        const errObj = { code, message };
        setState({
          turnStatus: "failed",
          loading: false,
          busyAction: false,
          activeTurnUserText: "",
          error: errObj,
          lastFailedTurn: { text: cleanText, action, error: errObj },
        });
        return null;
      }

      const accepted = json.data;
      setState({
        turnStatus: "running",
        loading: false,
        busyAction: false,
        activeTurnId: accepted.turnId,
        activeEventsUrl: accepted.eventsUrl,
      });

      await subscribeSse(accepted.eventsUrl, accepted.turnId);
      return accepted;
    } catch (err) {
      const errObj = {
        code: err?.code || "NETWORK_ERROR",
        message: err?.message || "网络请求失败，请检查本机服务连接状态后重试。",
      };
      setState({
        turnStatus: "failed",
        loading: false,
        busyAction: false,
        activeTurnId: null,
        activeEventsUrl: null,
        activeTurnUserText: "",
        error: errObj,
        lastFailedTurn: { text: cleanText, action, error: errObj },
      });
      return null;
    }
  }

  async function retryLastFailedTurn() {
    const failed = state.lastFailedTurn;
    if (failed?.text) {
      return submitTurn({ text: failed.text, action: failed.action || null });
    }
    const boundaryState = state.publicAnalysis?.materialBoundary?.searchStatus
      || state.publicAnalysis?.materialBoundary?.state
      || null;
    const savedText = state.lastSubmittedText || state.publicAnalysis?.claimText || "";
    if (
      savedText
      && ["timeout", "rate_limited", "error", "auth_error", "not_configured"].includes(boundaryState)
    ) {
      return submitTurn({ text: savedText });
    }
    if (state.syncStatus === "error") {
      return retrySnapshotSync();
    }
    return checkHostAvailable();
  }

  function resetPublicSession() {
    stopSseLoop();
    writeStoredSessionId(null, state.hostMode);
    setState({
      mode: "static",
      sessionId: null,
      graphVersion: 0,
      snapshot: null,
      confirmedGraph: [],
      facts: [],
      evidenceIndex: [],
      pendingConfirmations: [],
      deniedAttributions: [],
      statements: [],
      statementComparison: null,
      adoptedStatementId: null,
      turns: [],
      publicAnalysis: null,
      conversationHistory: [],
      turnStatus: "idle",
      loading: false,
      busyAction: false,
      activeTurnId: null,
      activeEventsUrl: null,
      activeTurnUserText: "",
      lastFailedTurn: null,
      currentStage: null,
      currentFocus: null,
      lastVerifiedEvidence: [],
      explanationText: "",
      error: null,
      staleConflict: null,
      syncStatus: "idle",
      pendingSyncVersion: null,
      pendingSyncTurnId: null,
      syncError: null,
    });
  }

  function chooseOfflineDemoPreview() {
    stopSseLoop();
    setState({
      hostMode: "static",
      mode: "static",
      offlineDemoChosen: true,
      error: null,
      lastFailedTurn: null,
    });
  }

  async function retryStaleTurn() {
    const conflict = state.staleConflict;
    if (!conflict?.payload) return null;
    setState({ staleConflict: null });
    return submitTurn({
      text: conflict.payload.text,
      action: conflict.payload.action,
      focusRef: conflict.payload.focusRef,
      baseGraphVersion: state.graphVersion,
    });
  }

  function dismissStaleConflict() {
    setState({ staleConflict: null });
  }

  function clearError() {
    setState({ error: null, lastFailedTurn: null });
  }

  async function cancelActiveTurn() {
    const sessionId = state.sessionId;
    const turnId = state.activeTurnId;
    if (!sessionId || !turnId) return null;

    setState({ busyAction: true });
    try {
      const { res, json } = await apiJson(
        `/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/cancel`,
        {
          method: "POST",
          body: JSON.stringify({ reason: "用户点击停止生成" }),
        },
      );
      if (!res.ok || !json?.ok) {
        const msg = json?.error?.message || "停止当前轮次失败。";
        setState({
          busyAction: false,
          error: { code: json?.error?.code || `HTTP_${res.status}`, message: msg },
        });
        return null;
      }
      const cancelled = json.data;
      stopSseLoop();
      if (cancelled?.status === "committed") {
        setState({
          activeTurnId: null,
          activeEventsUrl: null,
          currentStage: null,
          busyAction: false,
        });
        await syncCommittedSnapshot({
          sessionId,
          minGraphVersion: Number.isInteger(cancelled.graphVersion) ? cancelled.graphVersion : state.graphVersion,
          requiredTurnId: turnId,
        });
        return cancelled;
      }

      const nextStatus = cancelled?.status === "interrupted" ? "failed" : (cancelled?.status || "cancelled");
      setState({
        turnStatus: nextStatus,
        activeTurnId: null,
        activeEventsUrl: null,
        currentStage: null,
        loading: false,
        busyAction: false,
      });
      try {
        await refreshSnapshot(sessionId, { keepStreamMeta: true });
      } catch {
        // 忽略
      }
      return cancelled;
    } catch (err) {
      setState({
        busyAction: false,
        error: { code: "CANCEL_FAILED", message: err?.message || "请求停止生成失败。" },
      });
      return null;
    }
  }

  function setBoundFocusNode(nodeId) {
    const cleanId = typeof nodeId === "string" && nodeId.trim() ? nodeId.trim() : null;
    if (cleanId && !state.confirmedGraph.some((n) => n.id === cleanId)) {
      return;
    }
    setState({ boundFocusNodeId: cleanId });
  }

  return {
    getState,
    subscribe,
    checkHostAvailable,
    bootstrapHostSession,
    createSession,
    restoreSavedSession,
    refreshSnapshot,
    retrySnapshotSync,
    submitTurn,
    retryLastFailedTurn,
    resetPublicSession,
    chooseOfflineDemoPreview,
    retryStaleTurn,
    dismissStaleConflict,
    clearError,
    cancelActiveTurn,
    setBoundFocusNode,
  };
}
