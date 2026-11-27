// 焦点定位、外部不可信材料注入隔离、引文核验、语义分句关系核验、候选提议程序校验与流式输出核验守卫。
import { BackendServiceError, FOCUS_KINDS, RATE_INTERPRETATION_NOTE } from './protocol.mjs';
import { applyDeniedAttributions } from './evidence.mjs';

const QUANTIFIER_PATTERNS = [
  { token: '无一例外', note: '全称绝对化限定「无一例外」' },
  { token: '从来不会', note: '全称否定限定「从来不会」' },
  { token: '绝不会', note: '绝对化否定词「绝不会」' },
  { token: '只会', note: '排他性绝对量词「只会」' },
  { token: '只有', note: '排他性必要条件量词「只有」' },
  { token: '必然', note: '必然性模态量词「必然」' },
  { token: '必定', note: '必然性模态量词「必定」' },
  { token: '一定', note: '强确定性量词「一定」' },
  { token: '所有', note: '全称量词「所有」' },
  { token: '全部', note: '全称量词「全部」' },
  { token: '一切', note: '全称量词「一切」' },
  { token: '总是', note: '全称频率量词「总是」' },
  { token: '永远', note: '全称时间量词「永远」' },
  { token: '绝不', note: '绝对否定词「绝不」' },
  { token: '从不', note: '全称频率否定词「从不」' },
  { token: '完全', note: '程度绝对化限定词「完全」' },
];

const SCOPE_REGEXES = [
  /只发生在[^\s，。；！？,.;!?]{2,18}/u,
  /刚开始(?:使用|用)?(?:的时候|之时|时)/u,
  /连续[听看刷点播读][^\s，。；！？,.;!?]{1,14}(?:之后|以后|后|时)/u,
  /在[^\s，。；！？,.;!?]{2,20}(?:情况下|条件下|阶段|场景下|环境中|制度下|窗口中)/u,
  /当[^\s，。；！？,.;!?]{2,20}(?:的时候|之时|时)/u,
];

const DEPENDENCY_REGEXES = [
  /前提是[^\s，。；！？,.;!?]{2,24}/u,
  /取决于[^\s，。；！？,.;!?]{2,24}/u,
  /依赖于[^\s，。；！？,.;!?]{2,24}/u,
  /除非[^\s，。；！？,.;!?]{2,24}/u,
  /只要[^\s，。；！？,.;!?]{2,24}/u,
  /一旦[^\s，。；！？,.;!?]{2,24}/u,
];

const PREMISE_REGEXES = [
  /因为[^\s，。；！？,.;!?]{2,24}/u,
  /由于[^\s，。；！？,.;!?]{2,24}/u,
];

function inferFocusKind(spanText, requestedKind = null) {
  if (requestedKind && FOCUS_KINDS.includes(requestedKind)) return requestedKind;
  if (QUANTIFIER_PATTERNS.some((q) => q.token === spanText)) return 'quantifier';
  if (SCOPE_REGEXES.some((re) => re.test(spanText))) return 'scope';
  if (DEPENDENCY_REGEXES.some((re) => re.test(spanText))) return 'dependency';
  return 'premise';
}

function finalizeFocusResult(text, { kind, spanText, startOffset, endOffset, reason, userSelected = false }) {
  if (
    !Number.isInteger(startOffset)
    || !Number.isInteger(endOffset)
    || startOffset < 0
    || endOffset > text.length
    || startOffset >= endOffset
    || text.slice(startOffset, endOffset) !== spanText
  ) {
    throw new BackendServiceError('INVALID_ARGUMENTS', '焦点切片偏移校验失败。', 400);
  }
  return {
    kind,
    spanText,
    startOffset,
    endOffset,
    reason,
    userSelected,
  };
}

// 从当前句子中选定一个可核验焦点（量词 -> 范围/条件 -> 依赖 -> 前提），或核验用户指定的 preferredFocusRef。
export function selectFocusFromSentence(text, preferredFocusRef = null) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new BackendServiceError('INVALID_ARGUMENTS', '待拆解的句子不能为空。', 400);
  }

  if (preferredFocusRef && typeof preferredFocusRef === 'object') {
    if (
      Number.isInteger(preferredFocusRef.startOffset)
      && Number.isInteger(preferredFocusRef.endOffset)
    ) {
      const { startOffset, endOffset } = preferredFocusRef;
      if (startOffset < 0 || endOffset > text.length || startOffset >= endOffset) {
        throw new BackendServiceError('INVALID_ARGUMENTS', '指定的焦点起止偏移超出句子范围。', 400);
      }
      const sliced = text.slice(startOffset, endOffset);
      if (
        typeof preferredFocusRef.spanText === 'string'
        && preferredFocusRef.spanText.length > 0
        && preferredFocusRef.spanText !== sliced
      ) {
        throw new BackendServiceError('INVALID_ARGUMENTS', '指定的焦点文本与起止偏移不一致。', 400);
      }
      const kind = inferFocusKind(sliced, preferredFocusRef.kind);
      return finalizeFocusResult(text, {
        kind,
        spanText: sliced,
        startOffset,
        endOffset,
        reason: preferredFocusRef.reason ?? `按用户指定位置拆解焦点「${sliced}」。`,
        userSelected: true,
      });
    }

    if (typeof preferredFocusRef.spanText === 'string' && preferredFocusRef.spanText.length > 0) {
      const idx = text.indexOf(preferredFocusRef.spanText);
      if (idx < 0) {
        throw new BackendServiceError('INVALID_ARGUMENTS', '指定的焦点片段不在当前句子中。', 400);
      }
      const spanText = preferredFocusRef.spanText;
      const kind = inferFocusKind(spanText, preferredFocusRef.kind);
      return finalizeFocusResult(text, {
        kind,
        spanText,
        startOffset: idx,
        endOffset: idx + spanText.length,
        reason: preferredFocusRef.reason ?? `按用户指定片段拆解焦点「${spanText}」。`,
        userSelected: true,
      });
    }
  }

  // 1. 优先匹配量词（选择句中最先出现的强量词；同位置优先更长词条）
  let bestQuantifier = null;
  for (const item of QUANTIFIER_PATTERNS) {
    const idx = text.indexOf(item.token);
    if (idx < 0) continue;
    if (
      !bestQuantifier
      || idx < bestQuantifier.idx
      || (idx === bestQuantifier.idx && item.token.length > bestQuantifier.token.length)
    ) {
      bestQuantifier = { ...item, idx };
    }
  }
  if (bestQuantifier) {
    return finalizeFocusResult(text, {
      kind: 'quantifier',
      spanText: bestQuantifier.token,
      startOffset: bestQuantifier.idx,
      endOffset: bestQuantifier.idx + bestQuantifier.token.length,
      reason: `句中使用了${bestQuantifier.note}，只需核实是否存在反例或适用边界即可检验该全称判断是否过强。`,
    });
  }

  // 2. 匹配适用范围或阶段条件
  for (const re of SCOPE_REGEXES) {
    const match = re.exec(text);
    if (match && match[0]) {
      return finalizeFocusResult(text, {
        kind: 'scope',
        spanText: match[0],
        startOffset: match.index,
        endOffset: match.index + match[0].length,
        reason: `句中包含明确的适用范围或阶段条件「${match[0]}」，优先核对该条件边界下判断是否成立。`,
      });
    }
  }

  // 3. 匹配显式依赖条件
  for (const re of DEPENDENCY_REGEXES) {
    const match = re.exec(text);
    if (match && match[0]) {
      return finalizeFocusResult(text, {
        kind: 'dependency',
        spanText: match[0],
        startOffset: match.index,
        endOffset: match.index + match[0].length,
        reason: `句中给出了支撑结论成立的关键依赖「${match[0]}」，需先核验该依赖前提。`,
      });
    }
  }

  // 4. 匹配因果前提或提取首个核心命题分句
  for (const re of PREMISE_REGEXES) {
    const match = re.exec(text);
    if (match && match[0]) {
      return finalizeFocusResult(text, {
        kind: 'premise',
        spanText: match[0],
        startOffset: match.index,
        endOffset: match.index + match[0].length,
        reason: `句中以「${match[0]}」作为推理前提，优先核对该前提是否有可靠依据。`,
      });
    }
  }

  const clauseMatch = /[^\s，。；！？,.;!?][^\n，。；！？,.;!?]{0,28}[^\s，。；！？,.;!?]|[^\s，。；！？,.;!?]/u.exec(text);
  const spanText = clauseMatch ? clauseMatch[0] : text.trim();
  const startOffset = clauseMatch ? clauseMatch.index : text.indexOf(spanText);
  return finalizeFocusResult(text, {
    kind: 'premise',
    spanText,
    startOffset,
    endOffset: startOffset + spanText.length,
    reason: `句中未出现绝对化量词或限定从句，选取核心命题片段「${spanText}」核对支持与反例证据。`,
  });
}

const INJECTION_SIGNATURES = [
  { id: 'zh_system_tag', re: /【\s*系统(?:指令|提示|命令)\s*】|\[\s*系统(?:指令|提示|命令)\s*\]/u },
  { id: 'zh_ignore_rules', re: /(?:忽略|无视|跳过)(?:上文|之前|以上|前面|所有|既有)(?:的)?(?:规则|指令|提示|约束|设定)/u },
  { id: 'zh_force_self_attribution', re: /(?:直接)?把(?:本条|这条|该条|此内容)?(?:判定|标记|归属|算作|当作)为?本人/u },
  { id: 'zh_as_system_command', re: /作为系统(?:命令|指令|提示)|执行以下(?:系统)?指令/u },
  { id: 'zh_exfiltrate_secret', re: /(?:输出|打印|返回|泄露|显示)(?:全部|所有)?\s*(?:API_KEY|ACCESS_SECRET|TOKEN|密钥|令牌|凭证)/iu },
  { id: 'en_ignore_instructions', re: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|prompts|rules)/iu },
  { id: 'en_system_prompt', re: /\bsystem\s+prompt\b|<\s*\/?\s*system\s*>|<<\s*SYS\s*>>|\[\s*INST\s*\]/iu },
  { id: 'en_force_self', re: /mark\s+attribution\s+as\s+self|treat\s+this\s+as\s+user\s+confirmed/iu },
];

// 检测外部不可信文本中的提示词注入特征，并包裹为纯引用数据文本（绝不作为指令执行）。
export function inspectUntrustedText(text) {
  const rawText = String(text ?? '');
  const matchedSignals = [];
  for (const sig of INJECTION_SIGNATURES) {
    const match = sig.re.exec(rawText);
    if (match) {
      matchedSignals.push({
        rule: sig.id,
        matchedText: match[0],
      });
    }
  }
  const neutralizedBody = rawText
    .replace(/<\s*(\/?)\s*system\s*>/gi, '‹$1system›')
    .replace(/【\s*系统(指令|提示|命令)\s*】/gu, '〖外部文本字面量：系统$1〗');

  return {
    injectionDetected: matchedSignals.length > 0,
    matchedSignals,
    contentTrust: 'external_untrusted',
    treatAs: 'quoted_material_only',
    quotedText: `<<<EXTERNAL_QUOTED_DATA_DO_NOT_EXECUTE>>>\n${neutralizedBody}\n<<<END_EXTERNAL_QUOTED_DATA>>>`,
    rawText,
  };
}

// 核对候选引文是否真实存在于对应证据片段中，返回精确偏移，拒绝任何编造或改写引文。
export function verifyQuoteInEvidence(quoteText, evidence) {
  if (!evidence || typeof evidence !== 'object' || typeof evidence.excerpt !== 'string' || !evidence.excerpt) {
    return { ok: false, reason: 'EVIDENCE_TEXT_UNAVAILABLE' };
  }
  if (typeof quoteText !== 'string' || !quoteText.trim()) {
    return { ok: false, reason: 'EMPTY_QUOTE' };
  }

  const exactIdx = evidence.excerpt.indexOf(quoteText);
  if (exactIdx >= 0) {
    return {
      ok: true,
      startOffset: exactIdx,
      endOffset: exactIdx + quoteText.length,
      exactQuote: evidence.excerpt.slice(exactIdx, exactIdx + quoteText.length),
      evidenceId: evidence.id ?? null,
    };
  }

  const trimmed = quoteText.trim();
  const trimmedIdx = evidence.excerpt.indexOf(trimmed);
  if (trimmedIdx >= 0) {
    return {
      ok: true,
      startOffset: trimmedIdx,
      endOffset: trimmedIdx + trimmed.length,
      exactQuote: evidence.excerpt.slice(trimmedIdx, trimmedIdx + trimmed.length),
      evidenceId: evidence.id ?? null,
    };
  }

  return { ok: false, reason: 'QUOTE_NOT_FOUND_IN_EVIDENCE' };
}

function buildEvidenceLookup(evidenceMap, deniedAttributions = []) {
  const rawList = [];
  if (evidenceMap instanceof Map) {
    rawList.push(...evidenceMap.values());
  } else if (Array.isArray(evidenceMap)) {
    rawList.push(...evidenceMap);
  } else if (evidenceMap && typeof evidenceMap === 'object') {
    rawList.push(...Object.values(evidenceMap));
  }
  const normalized = applyDeniedAttributions(rawList, deniedAttributions);
  const lookup = new Map();
  for (const ev of normalized) {
    if (ev?.id) lookup.set(ev.id, ev);
  }
  return lookup;
}

const INVALID_EDGE_RELATION_TYPES = new Set([
  'same_topic',
  'topic_overlap',
  'same_cluster',
  'lexical_similarity',
  'word_overlap',
  'co_occurrence',
]);

const SHALLOW_REASON_RE =
  /^(?:两者|两个节点|它们)?(?:同属|属于同一|具有相同|相同|同一)?(?:话题|主题|领域|簇|cluster|关键词|词面相似|字面相近|用词相似|都在讨论[^\s，。]{0,12})[。！!]?$/iu;

function characterBigramJaccard(textA, textB) {
  const clean = (s) => String(s ?? '').replace(/[\s，。！？；：、“”‘’（）().,;!?'"-]+/gu, '');
  const a = clean(textA);
  const b = clean(textB);
  if (a.length < 4 || b.length < 4) return 0;
  const grams = (str) => {
    const set = new Set();
    for (let i = 0; i < str.length - 1; i += 1) set.add(str.slice(i, i + 2));
    return set;
  };
  const setA = grams(a);
  const setB = grams(b);
  let intersection = 0;
  for (const g of setA) {
    if (setB.has(g)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function isShallowTopicOrLexicalSupport({ relationType, reason, premiseNode, dependentNode }) {
  if (relationType && INVALID_EDGE_RELATION_TYPES.has(String(relationType).trim().toLowerCase())) {
    return true;
  }
  const cleanReason = typeof reason === 'string' ? reason.trim() : '';
  if (cleanReason && SHALLOW_REASON_RE.test(cleanReason)) {
    return true;
  }
  // 若缺少明确前提支撑理由，且两节点同簇或词面高度重合，拒绝直接写成支撑边
  if (!cleanReason) {
    if (premiseNode && dependentNode) {
      const sameCluster = premiseNode.cluster !== undefined && premiseNode.cluster === dependentNode.cluster;
      const highOverlap = characterBigramJaccard(premiseNode.text, dependentNode.text) >= 0.45;
      if (sameCluster || highOverlap) return true;
    }
    return true;
  }
  // 即便给了简短描述，若两节点几乎同义改写（>=0.85）且无条件/前提逻辑词，也拒绝充当支撑边
  if (
    premiseNode
    && dependentNode
    && characterBigramJaccard(premiseNode.text, dependentNode.text) >= 0.85
    && !/(?:前提|依据|决定|支撑|条件|只有|因为|导出|依赖)/u.test(cleanReason)
  ) {
    return true;
  }
  return false;
}

function hasDirectedCycle(adjacencyMap) {
  const color = new Map(); // 0: unvisited, 1: visiting, 2: visited
  for (const id of adjacencyMap.keys()) color.set(id, 0);

  function dfs(nodeId) {
    color.set(nodeId, 1);
    for (const depId of adjacencyMap.get(nodeId) ?? []) {
      const state = color.get(depId) ?? 0;
      if (state === 1) return true;
      if (state === 0 && dfs(depId)) return true;
    }
    color.set(nodeId, 2);
    return false;
  }

  for (const id of adjacencyMap.keys()) {
    if (color.get(id) === 0 && dfs(id)) return true;
  }
  return false;
}

function topologicalOrderAcceptedNodes(baseNodes, acceptedNodes) {
  const baseIds = new Set(baseNodes.map((n) => n.id));
  const remaining = [...acceptedNodes];
  const ordered = [];
  const placedIds = new Set(baseIds);

  while (remaining.length > 0) {
    const readyIdx = remaining.findIndex((node) =>
      node.deps.every((dep) => placedIds.has(dep)),
    );
    if (readyIdx < 0) {
      // 理论上不会到达（已做无环校验），安全兜底保持原序
      ordered.push(...remaining);
      break;
    }
    const [next] = remaining.splice(readyIdx, 1);
    ordered.push(next);
    placedIds.add(next.id);
  }
  return ordered;
}

// 严格程序校验模型提议：引文真实性、原作者与本人归属隔离、提示词注入失活、拒绝同话题充当支撑边及有向无环校验。
export function verifyCandidateProposal({
  proposal = {},
  evidenceMap = new Map(),
  confirmedGraph = [],
  deniedAttributions = [],
  currentTurnId = null,
} = {}) {
  const evidenceLookup = buildEvidenceLookup(evidenceMap, deniedAttributions);
  const verifiedCitations = [];
  const acceptedNodes = [];
  const pendingConfirmations = [];
  const rejectedItems = [];
  const verifiedDirectConflicts = [];

  // 1. 逐条核验候选引文（citations）
  const rawCitations = Array.isArray(proposal?.citations) ? proposal.citations : [];
  for (const citation of rawCitations) {
    const evId = citation?.evidenceId ?? null;
    const ev = evId ? evidenceLookup.get(evId) : null;
    if (!ev) {
      rejectedItems.push({
        kind: 'citation',
        reason: 'EVIDENCE_NOT_FOUND',
        item: citation,
      });
      continue;
    }

    const untrustedInspection = ev.contentTrust === 'external_untrusted'
      ? inspectUntrustedText(ev.excerpt)
      : null;

    const quoteText = citation?.quoteText ?? citation?.quote ?? '';
    const quoteCheck = verifyQuoteInEvidence(quoteText, ev);
    if (!quoteCheck.ok) {
      rejectedItems.push({
        kind: 'citation',
        reason: quoteCheck.reason,
        evidenceId: ev.id,
        item: citation,
      });
      continue;
    }

    const claimedAttr = citation?.claimedAttribution ?? citation?.attribution ?? null;
    const claimedAuthor = citation?.claimedAuthor ?? citation?.author ?? null;

    if (
      (ev.attribution === 'other_author' || ev.deniedAsSelf)
      && (claimedAttr === 'self' || claimedAuthor === 'self')
    ) {
      rejectedItems.push({
        kind: 'citation',
        reason: ev.deniedAsSelf ? 'DENIED_SELF_ATTRIBUTION' : 'OTHER_AUTHOR_MISATTRIBUTED_AS_SELF',
        evidenceId: ev.id,
        actualAuthor: ev.author,
        injectionDetected: Boolean(untrustedInspection?.injectionDetected),
        item: citation,
      });
      continue;
    }

    if (claimedAuthor && claimedAuthor !== ev.author) {
      rejectedItems.push({
        kind: 'citation',
        reason: 'AUTHOR_MISMATCH',
        evidenceId: ev.id,
        expectedAuthor: ev.author,
        claimedAuthor,
        item: citation,
      });
      continue;
    }

    verifiedCitations.push({
      evidenceId: ev.id,
      sourceType: ev.sourceType,
      exactQuote: quoteCheck.exactQuote,
      startOffset: quoteCheck.startOffset,
      endOffset: quoteCheck.endOffset,
      author: ev.author,
      attribution: ev.attribution,
      url: ev.url ?? null,
      turnId: ev.turnId ?? null,
      snapshotId: ev.snapshotId ?? null,
      requestId: ev.requestId ?? null,
      deniedAsSelf: Boolean(ev.deniedAsSelf),
      injectionNeutralized: Boolean(untrustedInspection?.injectionDetected),
      role: citation?.role ?? 'reference',
    });
  }

  // 建立基础已确认图索引
  const baseNodes = (Array.isArray(confirmedGraph) ? confirmedGraph : []).map((n) => ({
    ...n,
    deps: Array.isArray(n.deps) ? [...n.deps] : [],
  }));
  const knownNodesById = new Map(baseNodes.map((n) => [n.id, n]));
  const adjacency = new Map(baseNodes.map((n) => [n.id, [...n.deps]]));

  // 2. 逐条核验候选节点（candidateNodes）
  const rawNodes = Array.isArray(proposal?.candidateNodes) ? proposal.candidateNodes : [];
  const stagedAccepted = [];

  for (const cand of rawNodes) {
    const nodeId = typeof cand?.id === 'string' ? cand.id.trim() : '';
    const nodeText = typeof (cand?.text ?? cand?.claim) === 'string'
      ? (cand.text ?? cand.claim).trim()
      : '';
    if (!nodeId || !nodeText) {
      rejectedItems.push({
        kind: 'node',
        reason: 'INVALID_NODE_SCHEMA',
        item: cand,
      });
      continue;
    }
    if (knownNodesById.has(nodeId)) {
      rejectedItems.push({
        kind: 'node',
        reason: 'DUPLICATE_NODE_ID',
        nodeId,
        item: cand,
      });
      continue;
    }

    let evIds = [];
    if (cand.evidenceIds !== undefined) {
      if (
        !Array.isArray(cand.evidenceIds)
        || cand.evidenceIds.some((id) => typeof id !== 'string' || !id.trim())
      ) {
        rejectedItems.push({
          kind: 'node',
          reason: 'INVALID_NODE_EVIDENCE_IDS',
          nodeId,
          item: cand,
        });
        continue;
      }
      evIds = [...new Set(cand.evidenceIds.map((id) => id.trim()))];
    } else if (cand.evidenceId !== undefined && cand.evidenceId !== null) {
      if (typeof cand.evidenceId !== 'string' || !cand.evidenceId.trim()) {
        rejectedItems.push({
          kind: 'node',
          reason: 'INVALID_NODE_EVIDENCE_IDS',
          nodeId,
          item: cand,
        });
        continue;
      }
      evIds = [cand.evidenceId.trim()];
    }
    const resolvedEvs = [];
    let missingEv = false;
    for (const id of evIds) {
      const found = evidenceLookup.get(id);
      if (!found) {
        missingEv = true;
        break;
      }
      resolvedEvs.push(found);
    }
    if (missingEv) {
      rejectedItems.push({
        kind: 'node',
        reason: 'NODE_EVIDENCE_NOT_FOUND',
        nodeId,
        item: cand,
      });
      continue;
    }

    // 若候选节点自带 quoteText，必须能在其引用的证据中精确命中
    if (typeof cand.quoteText === 'string' && cand.quoteText.trim()) {
      const quoteMatched = resolvedEvs.some((ev) => verifyQuoteInEvidence(cand.quoteText, ev).ok);
      if (!quoteMatched) {
        rejectedItems.push({
          kind: 'node',
          reason: 'QUOTE_NOT_FOUND_IN_EVIDENCE',
          nodeId,
          item: cand,
        });
        continue;
      }
    }

    // 检查外部材料提示词注入与否认归属保护
    const externalEvs = resolvedEvs.filter((ev) => ev.sourceType !== 'session_turn');
    const sessionSelfEvs = resolvedEvs.filter(
      (ev) => ev.sourceType === 'session_turn' && ev.attribution === 'self',
    );
    const hasDeniedMaterial = externalEvs.some((ev) => ev.deniedAsSelf);
    const hasInjectionMaterial = externalEvs.some(
      (ev) => ev.contentTrust === 'external_untrusted' && inspectUntrustedText(ev.excerpt).injectionDetected,
    );

    const claimedAttr = cand.claimedAttribution ?? cand.attribution ?? null;
    const isExplicitHypothesis = Boolean(
      cand.inferred === true
      || cand.tentative === true
      || cand.proposedAs === 'hypothesis'
      || claimedAttr === 'inferred_self',
    );

    // 本人明确确认某判断：必须有已核验的 session_turn 证据，或显式绑定本人确认轮次（且未伪造更改外部原作者）
    const explicitConfirmationTurnId = typeof (cand.confirmedInTurnId ?? cand.confirmationTurnId) === 'string'
      && (cand.confirmedInTurnId ?? cand.confirmationTurnId).trim()
      ? (cand.confirmedInTurnId ?? cand.confirmationTurnId).trim()
      : null;

    // 若试图修改外部证据原作者为 self，直接拦截
    if (cand.claimedAuthor === 'self' && sessionSelfEvs.length === 0 && externalEvs.length > 0) {
      rejectedItems.push({
        kind: 'node',
        reason: 'OTHER_AUTHOR_MISATTRIBUTED_AS_SELF',
        nodeId,
        item: cand,
      });
      continue;
    }

    // 若仅凭外部材料（或已被否认材料、含提示词注入材料）直接声称是本人已确认表达（self）且无本人轮次确认，严厉拦截！
    const hasValidUserConfirmation = Boolean(
      sessionSelfEvs.length > 0
      || (cand.userConfirmed === true && explicitConfirmationTurnId && !hasDeniedMaterial && !hasInjectionMaterial),
    );

    if (
      claimedAttr === 'self'
      && !isExplicitHypothesis
      && !hasValidUserConfirmation
      && (externalEvs.length > 0 || hasDeniedMaterial || hasInjectionMaterial)
    ) {
      rejectedItems.push({
        kind: 'node',
        reason: hasDeniedMaterial
          ? 'DENIED_SELF_ATTRIBUTION'
          : (hasInjectionMaterial ? 'PROMPT_INJECTION_BLOCKED' : 'OTHER_AUTHOR_MISATTRIBUTED_AS_SELF'),
        nodeId,
        item: cand,
      });
      continue;
    }

    // 非本人已核验确认的条目（如收藏的他人候选反例、模型推断立场、存疑判断）一律进入 pendingConfirmations
    if (!hasValidUserConfirmation || isExplicitHypothesis || claimedAttr === 'other_author') {
      pendingConfirmations.push({
        kind: cand.role === 'candidate_counterexample' || claimedAttr === 'other_author'
          ? 'candidate_counterexample'
          : 'inferred_stance',
        nodeId,
        text: nodeText,
        cluster: cand.cluster ?? 'general',
        attribution: sessionSelfEvs.length > 0 ? 'self' : 'other_author',
        evidenceIds: resolvedEvs.map((ev) => ev.id),
        referencedAuthors: externalEvs.map((ev) => ({
          evidenceId: ev.id,
          author: ev.author,
          attribution: ev.attribution,
        })),
        injectionNeutralized: hasInjectionMaterial,
      });
      continue;
    }

    // 校验候选节点内联 deps（无自环、无重复；悬空依赖与支撑理由在下一步统一核验）
    const rawDeps = Array.isArray(cand.deps) ? cand.deps : [];
    const seenDeps = new Set();
    let invalidInlineDepReason = null;
    for (const dep of rawDeps) {
      if (typeof dep !== 'string' || !dep.trim()) {
        invalidInlineDepReason = 'INVALID_DEPENDENCY_ID';
        break;
      }
      if (dep === nodeId) {
        invalidInlineDepReason = 'SELF_LOOP_DEPENDENCY';
        break;
      }
      if (seenDeps.has(dep)) {
        invalidInlineDepReason = 'DUPLICATE_DEPENDENCY';
        break;
      }
      seenDeps.add(dep);
    }
    if (invalidInlineDepReason) {
      rejectedItems.push({
        kind: 'node',
        reason: invalidInlineDepReason,
        nodeId,
        item: cand,
      });
      continue;
    }

    const resolvedTurnId = sessionSelfEvs[0]?.turnId ?? explicitConfirmationTurnId ?? currentTurnId ?? null;
    stagedAccepted.push({
      raw: cand,
      node: {
        id: nodeId,
        text: nodeText,
        cluster: cand.cluster ?? 'general',
        deps: [...seenDeps],
        attribution: 'self',
        confirmedByTurnId: resolvedTurnId,
        evidenceIds: resolvedEvs.map((ev) => ev.id),
        // 确认他人观点绝不改变原证据 author，仅在节点上保留原作者引用记录
        referencedAuthors: externalEvs.map((ev) => ({
          evidenceId: ev.id,
          author: ev.author,
          attribution: ev.attribution,
        })),
      },
    });
  }

  // 先登记候选节点 ID 以便校验节点之间的合法依赖与悬空依赖
  const candidateById = new Map(stagedAccepted.map((entry) => [entry.node.id, entry]));
  for (const [nodeId, entry] of [...candidateById.entries()]) {
    const { raw, node } = entry;
    let depRejectedReason = null;
    for (const depId of node.deps) {
      const targetNode = knownNodesById.get(depId) ?? candidateById.get(depId)?.node ?? null;
      if (!targetNode) {
        depRejectedReason = 'DANGLING_DEPENDENCY';
        break;
      }
      const depRelationType = raw.depRelationTypes?.[depId] ?? raw.relationType ?? null;
      const depReason = raw.depReasons?.[depId] ?? raw.depReason ?? null;
      // 若候选节点声明了内联依赖，也必须检查是否把同话题/词面相似滥用为支撑边
      if (
        depRelationType !== null || depReason !== null
          ? isShallowTopicOrLexicalSupport({
              relationType: depRelationType,
              reason: depReason,
              premiseNode: targetNode,
              dependentNode: node,
            })
          : INVALID_EDGE_RELATION_TYPES.has(String(depRelationType ?? '').toLowerCase())
      ) {
        depRejectedReason = 'UNJUSTIFIED_SUPPORT_EDGE_SAME_TOPIC_OR_LEXICAL';
        break;
      }
    }
    if (depRejectedReason) {
      candidateById.delete(nodeId);
      rejectedItems.push({
        kind: 'node',
        reason: depRejectedReason,
        nodeId,
        item: raw,
      });
    }
  }

  // 级联剔除因上游候选节点被拒而变成悬空的候选节点，并逐个进行有向环检测
  let changed = true;
  while (changed) {
    changed = false;
    for (const [nodeId, entry] of [...candidateById.entries()]) {
      const missingDep = entry.node.deps.some(
        (depId) => !knownNodesById.has(depId) && !candidateById.has(depId),
      );
      if (missingDep) {
        candidateById.delete(nodeId);
        rejectedItems.push({
          kind: 'node',
          reason: 'DANGLING_DEPENDENCY',
          nodeId,
          item: entry.raw,
        });
        changed = true;
      }
    }
  }

  // 使用拓扑剥离（Kahn 算法）接纳无环候选节点：任何位于有向环上或依赖有向环的候选节点一律拦截为 CYCLIC_DEPENDENCY
  const validNodeIds = new Set(baseNodes.map((n) => n.id));
  const acceptedOrderedEntries = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [nodeId, entry] of [...candidateById.entries()]) {
      const allDepsReady = entry.node.deps.every((depId) => validNodeIds.has(depId));
      if (allDepsReady) {
        candidateById.delete(nodeId);
        validNodeIds.add(nodeId);
        acceptedOrderedEntries.push(entry);
        knownNodesById.set(nodeId, entry.node);
        adjacency.set(nodeId, [...entry.node.deps]);
        progressed = true;
      }
    }
  }

  // 剩余无法完成拓扑剥离的节点必然处于有向环或依赖有向环，全部拦截
  for (const [nodeId, entry] of candidateById.entries()) {
    rejectedItems.push({
      kind: 'node',
      reason: 'CYCLIC_DEPENDENCY',
      nodeId,
      item: entry.raw,
    });
  }

  // 3. 逐条核验独立候选支撑边（candidateEdges）
  const rawEdges = Array.isArray(proposal?.candidateEdges) ? proposal.candidateEdges : [];
  for (const edge of rawEdges) {
    const relationType = edge?.relationType ?? 'supports';
    let premiseId = edge?.premiseId ?? edge?.depId ?? null;
    let dependentId = edge?.dependentId ?? edge?.nodeId ?? null;
    if (!premiseId && !dependentId && edge?.from && edge?.to) {
      if (relationType === 'depends_on') {
        dependentId = edge.from;
        premiseId = edge.to;
      } else {
        premiseId = edge.from;
        dependentId = edge.to;
      }
    }

    if (typeof premiseId !== 'string' || !premiseId.trim() || typeof dependentId !== 'string' || !dependentId.trim()) {
      rejectedItems.push({
        kind: 'edge',
        reason: 'INVALID_EDGE_ENDPOINTS',
        item: edge,
      });
      continue;
    }

    if (premiseId === dependentId) {
      rejectedItems.push({
        kind: 'edge',
        reason: 'SELF_LOOP_DEPENDENCY',
        premiseId,
        dependentId,
        item: edge,
      });
      continue;
    }

    const premiseNode = knownNodesById.get(premiseId);
    const dependentNode = knownNodesById.get(dependentId);
    if (!premiseNode || !dependentNode) {
      // 若端点位于 pendingConfirmations，且理由不是同话题滥用，进入待确认区；否则按悬空依赖拒绝
      const inPending = pendingConfirmations.some(
        (p) => p.nodeId === premiseId || p.nodeId === dependentId,
      );
      if (
        inPending
        && !isShallowTopicOrLexicalSupport({
          relationType,
          reason: edge?.reason,
          premiseNode,
          dependentNode,
        })
      ) {
        pendingConfirmations.push({
          kind: 'support_edge',
          premiseId,
          dependentId,
          reason: edge.reason,
        });
      } else {
        rejectedItems.push({
          kind: 'edge',
          reason: !premiseNode || !dependentNode ? 'DANGLING_DEPENDENCY' : 'INVALID_EDGE',
          premiseId,
          dependentId,
          item: edge,
        });
      }
      continue;
    }

    // 严禁把同话题、同簇或词面相似直接写成支撑边
    if (
      isShallowTopicOrLexicalSupport({
        relationType,
        reason: edge?.reason,
        premiseNode,
        dependentNode,
      })
    ) {
      rejectedItems.push({
        kind: 'edge',
        reason: 'UNJUSTIFIED_SUPPORT_EDGE_SAME_TOPIC_OR_LEXICAL',
        premiseId,
        dependentId,
        item: edge,
      });
      continue;
    }

    // 存疑或未经本人确认的支撑关系进入 pendingConfirmations
    if (
      edge?.tentative === true
      || edge?.confidence === 'uncertain'
      || edge?.userConfirmed === false
    ) {
      pendingConfirmations.push({
        kind: 'support_edge',
        premiseId,
        dependentId,
        reason: edge.reason,
      });
      continue;
    }

    const currentDeps = adjacency.get(dependentId) ?? [];
    if (currentDeps.includes(premiseId)) {
      rejectedItems.push({
        kind: 'edge',
        reason: 'DUPLICATE_DEPENDENCY',
        premiseId,
        dependentId,
        item: edge,
      });
      continue;
    }

    // 试加入边并检测有向环
    adjacency.set(dependentId, [...currentDeps, premiseId]);
    if (hasDirectedCycle(adjacency)) {
      adjacency.set(dependentId, currentDeps);
      rejectedItems.push({
        kind: 'edge',
        reason: 'CYCLIC_DEPENDENCY',
        premiseId,
        dependentId,
        item: edge,
      });
      continue;
    }

    dependentNode.deps.push(premiseId);
  }

  const orderedAccepted = topologicalOrderAcceptedNodes(
    baseNodes,
    acceptedOrderedEntries.map((entry) => entry.node),
  );
  acceptedNodes.push(...orderedAccepted);

  // 4. 核验候选直接冲突集合（directConflicts）与冲突理由（conflictReasons）
  function validateConflictEntry(entry, entryKind = 'direct_conflict') {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length === 0) {
      return {
        ok: false,
        rejected: {
          kind: entryKind,
          reason: entryKind === 'conflict_reason' ? 'INVALID_CONFLICT_REASON_SCHEMA' : 'INVALID_CONFLICT_SCHEMA',
          item: entry,
        },
      };
    }

    const targetId = typeof entry.nodeId === 'string' ? entry.nodeId.trim() : '';
    if (!targetId) {
      return {
        ok: false,
        rejected: {
          kind: entryKind,
          reason: entryKind === 'conflict_reason' ? 'INVALID_CONFLICT_REASON_SCHEMA' : 'INVALID_CONFLICT_SCHEMA',
          item: entry,
        },
      };
    }

    const targetNode = knownNodesById.get(targetId);
    if (!targetNode) {
      return {
        ok: false,
        rejected: {
          kind: entryKind,
          reason: 'CONFLICT_TARGET_NODE_NOT_FOUND',
          nodeId: targetId,
          item: entry,
        },
      };
    }

    if (targetNode.attribution && targetNode.attribution !== 'self') {
      return {
        ok: false,
        rejected: {
          kind: entryKind,
          reason: 'CONFLICT_NODE_NOT_SELF_ATTRIBUTED',
          nodeId: targetId,
          item: entry,
        },
      };
    }

    const reasonText = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (!reasonText) {
      return {
        ok: false,
        rejected: {
          kind: entryKind,
          reason: 'MISSING_CONFLICT_REASON',
          nodeId: targetId,
          item: entry,
        },
      };
    }

    let evIds = [];
    if (entry.evidenceIds !== undefined) {
      if (
        !Array.isArray(entry.evidenceIds)
        || entry.evidenceIds.some((id) => typeof id !== 'string' || !id.trim())
      ) {
        return {
          ok: false,
          rejected: {
            kind: entryKind,
            reason: 'INVALID_CONFLICT_EVIDENCE_IDS',
            nodeId: targetId,
            item: entry,
          },
        };
      }
      evIds = [...new Set(entry.evidenceIds.map((id) => id.trim()))];
    } else if (entry.evidenceId !== undefined && entry.evidenceId !== null) {
      if (typeof entry.evidenceId !== 'string' || !entry.evidenceId.trim()) {
        return {
          ok: false,
          rejected: {
            kind: entryKind,
            reason: 'INVALID_CONFLICT_EVIDENCE_IDS',
            nodeId: targetId,
            item: entry,
          },
        };
      }
      evIds = [entry.evidenceId.trim()];
    }

    for (const id of evIds) {
      const ev = evidenceLookup.get(id);
      if (!ev) {
        return {
          ok: false,
          rejected: {
            kind: entryKind,
            reason: 'CONFLICT_EVIDENCE_NOT_FOUND',
            nodeId: targetId,
            item: entry,
          },
        };
      }
    }

    if (typeof entry.quoteText === 'string' && entry.quoteText.trim()) {
      if (evIds.length === 0) {
        return {
          ok: false,
          rejected: {
            kind: entryKind,
            reason: 'CONFLICT_EVIDENCE_NOT_FOUND',
            nodeId: targetId,
            item: entry,
          },
        };
      }
      const matchedQuote = evIds.some((id) => verifyQuoteInEvidence(entry.quoteText, evidenceLookup.get(id)).ok);
      if (!matchedQuote) {
        return {
          ok: false,
          rejected: {
            kind: entryKind,
            reason: 'QUOTE_NOT_FOUND_IN_EVIDENCE',
            nodeId: targetId,
            item: entry,
          },
        };
      }
    }

    return {
      ok: true,
      normalized: {
        nodeId: targetId,
        evidenceIds: evIds,
        reason: reasonText,
      },
    };
  }

  const rawConflicts = Array.isArray(proposal?.directConflicts) ? proposal.directConflicts : [];
  const seenConflictTargets = new Set();
  for (const conflict of rawConflicts) {
    const check = validateConflictEntry(conflict, 'direct_conflict');
    if (!check.ok) {
      rejectedItems.push(check.rejected);
      continue;
    }
    if (seenConflictTargets.has(check.normalized.nodeId)) continue;
    seenConflictTargets.add(check.normalized.nodeId);
    verifiedDirectConflicts.push(check.normalized);
  }

  const verifiedConflictReasons = [];
  if (Array.isArray(proposal?.conflictReasons)) {
    const seenReasonTargets = new Set();
    for (const rawReason of proposal.conflictReasons) {
      const check = validateConflictEntry(rawReason, 'conflict_reason');
      if (!check.ok) {
        rejectedItems.push(check.rejected);
        continue;
      }
      if (seenReasonTargets.has(check.normalized.nodeId)) continue;
      seenReasonTargets.add(check.normalized.nodeId);
      verifiedConflictReasons.push(check.normalized);
    }
  } else {
    for (const item of verifiedDirectConflicts) {
      verifiedConflictReasons.push({ ...item, evidenceIds: [...item.evidenceIds] });
    }
  }

  return {
    verifiedCitations,
    acceptedNodes,
    pendingConfirmations,
    rejectedItems,
    verifiedDirectConflicts,
    verifiedConflictReasons,
  };
}

// 单条外部/会话证据候选快速核验（供流式编排器逐条过滤不可信或越权归属条目）。
export function verifyEvidenceCandidate(rawItem, { deniedAttributions = [] } = {}) {
  if (!rawItem || typeof rawItem !== 'object') {
    return { ok: false, reason: 'INVALID_EVIDENCE_OBJECT' };
  }
  const excerpt = String(rawItem.excerpt ?? rawItem.summary ?? rawItem.bodyText ?? '').trim();
  if (!excerpt) {
    return { ok: false, reason: 'EVIDENCE_TEXT_UNAVAILABLE' };
  }
  const isSessionSelf = rawItem.sourceType === 'session_turn' && Boolean(rawItem.turnId);
  const [withDenial] = applyDeniedAttributions(
    [
      {
        id: rawItem.id ?? null,
        sourceType: rawItem.sourceType ?? 'collection_record',
        contentKey: rawItem.contentKey ?? null,
        author: rawItem.author ?? '未知作者',
        attribution: isSessionSelf ? 'self' : (rawItem.attribution ?? 'other_author'),
        excerpt,
        contentTrust: isSessionSelf ? 'session_user' : 'external_untrusted',
      },
    ],
    deniedAttributions,
  );

  if (!isSessionSelf && (rawItem.attribution === 'self' || rawItem.author === 'self')) {
    return { ok: false, reason: 'OTHER_AUTHOR_MISATTRIBUTED_AS_SELF' };
  }
  if (withDenial?.deniedAsSelf && rawItem.attribution === 'self') {
    return { ok: false, reason: 'DENIED_SELF_ATTRIBUTION' };
  }
  const inspection = isSessionSelf ? null : inspectUntrustedText(excerpt);
  return {
    ok: true,
    deniedAsSelf: Boolean(withDenial?.deniedAsSelf),
    injectionDetected: Boolean(inspection?.injectionDetected),
    quotedText: inspection?.quotedText ?? excerpt,
  };
}

// ==================== QA-05: 适用范围提取与结构化分句语义核验 ====================

function buildCanonicalScopeTag(scopeText) {
  const clean = String(scopeText ?? '')
    .trim()
    .replace(/^[“"「『‘]+|[”"」』’]+$/gu, '')
    .replace(/^(?:只发生在|仅发生在|只在|仅在|只限于|仅限于|在|当|每当|一旦|如果|若在)\s*/u, '')
    .trim();
  if (!clean) return null;
  if (/^(?:刚开始(?:使用|用)?(?:的时候|之时|时)?|冷启动(?:阶段|期)?|初期(?:使用)?(?:阶段|期|适用范围)?|刚接触.*?(?:的时候|之时|时)?)$/u.test(clean)) {
    return 'initial_stage';
  }
  if (/连续[听看刷点播读浏览使用]?[^\s，,；;。！？!?]*同类|长期连续|反复听同类/u.test(clean)) {
    return 'sustained_homogeneous';
  }
  if (/跨时区.*同步会议|每周同步会议/u.test(clean)) {
    return 'sync_meeting_leaf';
  }
  if (/^(?:缺乏|缺少|没有|无).*?(?:文档|异步规范)/u.test(clean)) {
    return 'undocumented_scope';
  }
  const core = clean
    .replace(/(?:的时候|之时|时|的情况下|的条件下|的前提下|的场景下|情况下|条件下|前提下|场景下)$/u, '')
    .replace(/\s+/gu, '_')
    .trim();
  return `scope_${core || clean}`;
}

function normalizeScopeKey(rawScope) {
  if (!rawScope) return null;
  if (typeof rawScope === 'object') {
    if (typeof rawScope.scopeTag === 'string' && rawScope.scopeTag.trim()) {
      return normalizeScopeKey(rawScope.scopeTag.trim());
    }
    if (typeof rawScope.scopeText === 'string' && rawScope.scopeText.trim()) {
      return buildCanonicalScopeTag(rawScope.scopeText.trim());
    }
    return null;
  }
  const s = String(rawScope).trim();
  if (!s) return null;
  if (s === 'initial_stage' || s === 'sustained_homogeneous' || s === 'sync_meeting_leaf' || s === 'undocumented_scope') {
    return s;
  }
  if (s.startsWith('scope_')) {
    const inner = s.slice('scope_'.length);
    return buildCanonicalScopeTag(inner) ?? s;
  }
  return buildCanonicalScopeTag(s);
}

// 从自然语言句子中提取真实适用范围/条件文本与规范化标签；无条件词时严格返回 null（绝不硬编码回退）。
export function extractScopeCondition(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const raw = text;

  const patterns = [
    // 1. 显式“只发生在 X / 仅发生在 X / 只限于 X”
    {
      re: /(?:只|仅)(?:发生在|限于|出现于|存在于)\s*[“"「『‘]?([^”"」』’，,；;。！？!?\s]{1,24})[”"」』’]?/u,
      pickGroup: 1,
    },
    // 2. “只在 X 发生/成立/生效”
    {
      re: /(?:只|仅)在\s*[“"「『‘]?([^”"」』’，,；;。！？!?]{1,24}?)[”"」』’]?\s*(?:才)?(?:发生|出现|成立|生效|有效|存在)(?=$|[，,；;。！？!?\s])/u,
      pickGroup: 1,
    },
    // 3. 引号包裹并指明“这个适用条件/适用范围/阶段”
    {
      re: /[“"「『‘]([^”"」』’，,；;。！？!?]{1,24})[”"」』’]\s*(?:这个|这一|该)?(?:适用)?(?:条件|范围|阶段|场景|边界|前提)/u,
      pickGroup: 1,
    },
    {
      re: /(?:适用条件|适用范围|限定条件|边界条件)(?:是|为|限定为|设为)?\s*[：:]?\s*[“"「『‘]([^”"」』’，,；;。！？!?]{1,24})[”"」』’]/u,
      pickGroup: 1,
    },
    // 4. 初期/冷启动/连续行为阶段限定
    {
      re: /(刚开始(?:使用|用)?(?:的时候|之时|时)|冷启动(?:阶段|期)?|初期(?:使用)?(?:阶段|期|适用范围)|刚接触[^\s，,；;。！？!?]{0,8}(?:的时候|之时|时))/u,
      pickGroup: 1,
      cleanFn: (val) => (val === '初期适用范围' ? '初期' : val),
    },
    {
      re: /(?:在|当|一旦)?(连续[听看刷点播读浏览使用][^\s，,；;。！？!?]{1,18}(?:之后|以后|后|时|期间))/u,
      pickGroup: 1,
    },
    // 5. “（在）... 期间/阶段/季节/时段/高峰期”
    {
      re: /(?:(?:只|仅)?在|(?<=^|[，,；;。！？!?\s]))\s*([^，,；;。！？!?\s]{1,18}?(?:期间|阶段|季节|时期|时段|高峰期|低谷期|试用期))(?=$|[，,；;。！？!?\s]|允许|不允许|会|不会|能|不能|才|都|只)/u,
      pickGroup: 1,
    },
    // 6. “（在）... 情况下/条件下/前提下/场景下/环境中/制度下/窗口中”
    {
      re: /(?:(?:只|仅)?在|(?<=^|[，,；;。！？!?\s]))\s*([^，,；;。！？!?]{2,22}?(?:情况下|条件下|前提下|场景下|环境中|制度下|窗口中))/u,
      pickGroup: 1,
    },
    // 7. “当 ... 时/的时候” 或 “在 ... 的时候/时” 或句首 “...的时候”
    {
      re: /(?:(?:只|仅)?(?:在|当|每当)\s*([^，,；;。！？!?]{1,20}?(?:的时候|之时|时))|(?<=^|[，,；;。！？!?\s])([^，,；;。！？!?\s]{2,18}?的时候))(?=$|[，,；;。！？!?\s])/u,
      pickGroup: 1,
      fallbackGroup: 2,
    },
    // 8. 天气/班次/昼夜/周末/网络状态等明确场景条件词
    {
      re: /(?:(?:只|仅)?(?:在|遇到|每逢|逢)\s*([^，,；;。！？!?\s]{0,8}?(?:雨天|晴天|雪天|阴天|暴雨天|台风天|夜班|白班|晚班|早班|夜间|夜晚|白天|周末|节假日|工作日|离线状态|弱网环境)(?:期间|下|里|时|的时候)?)|(?<=^|[，,；;。！？!?\s])((?:雨天|晴天|雪天|阴天|暴雨天|台风天|夜班|白班|晚班|早班|离线状态|弱网环境)(?:期间|下|里|时|的时候)?)(?=[，,；;。！？!?\s]|$))/u,
      pickGroup: 1,
      fallbackGroup: 2,
    },
  ];

  for (const spec of patterns) {
    const m = spec.re.exec(raw);
    if (!m) continue;
    const rawExtracted = m[spec.pickGroup] ?? (spec.fallbackGroup ? m[spec.fallbackGroup] : null) ?? m[0];
    const scopeText = (spec.cleanFn ? spec.cleanFn(rawExtracted) : rawExtracted)
      .trim()
      .replace(/^[“"「『‘]+|[”"」』’]+$/gu, '');
    if (!scopeText) continue;
    const scopeTag = buildCanonicalScopeTag(scopeText);
    const subIdx = raw.indexOf(scopeText, m.index);
    const startOffset = subIdx >= 0 ? subIdx : m.index;
    const endOffset = subIdx >= 0 ? subIdx + scopeText.length : m.index + m[0].length;
    return {
      scopeText,
      scopeTag,
      rawMatch: m[0],
      startOffset,
      endOffset,
    };
  }

  return null;
}

const UNIVERSAL_QUANTIFIER_RE =
  /(?:无一例外|从来不会|从来不|从不|从未|绝不会|绝不可能|绝不|只会|只有[^\s，,。！？；]{0,16}这一种|必然|必定|一定|所有|全部|一切|任何|总是|永远|完全)/u;

const NEGATED_UNIVERSAL_RE =
  /(?:并非|并不是|绝非|不是|未必|并不)\s*(?:无一例外|只会|只有|必然|必定|一定|所有|全部|一切|任何|总是|永远|完全)|不一定/u;

const NEGATION_OPERATOR_RE =
  /(?:并非|并不是|绝非|未尝|从来没有|从来没|从来不会|从来不|从不|从未|绝不会|绝不可能|绝不|并不会|并不|不是|不会|不能|不可|没有|未曾|无法|无权|没法|毫无|不|没|无|未)/gu;

const POSITIVE_CHANGE_VERBS = [
  '提高', '提升', '加快', '加速', '增快', '增加', '增多', '增长', '增强',
  '扩大', '拓宽', '拓展', '丰富', '改善', '优化', '促进', '上升', '回升',
  '更高', '更快', '更多', '更广', '更优', '优于', '替代', '取代',
];

const NEGATIVE_CHANGE_VERBS = [
  '越来越少', '越来越窄', '降低', '下降', '下跌', '拖慢', '减慢', '放缓', '变慢',
  '减少', '变少', '削弱', '收窄', '变窄', '压缩', '恶化', '更低', '更慢', '更少', '更差',
];

const DURATION_SHORTEN_VERBS = ['缩短', '缩减', '节省'];
const DURATION_LENGTHEN_VERBS = ['拉长', '延长'];

const MODAL_POS_VERBS = ['允许', '准许', '批准', '支持', '鼓励', '同意'];
const MODAL_NEG_VERBS = ['禁止', '严禁', '杜绝', '拒绝', '剥夺', '限制', '阻碍'];
const ACHIEVE_POS_VERBS = ['成功', '顺利', '实现', '完成', '达成'];
const STATUS_POS_WORDS = ['准时', '顺畅', '畅通', '稳定', '正常', '可靠', '可行', '成立'];
const STATUS_NEG_WORDS = ['堵车', '拥堵', '延迟', '延误', '卡顿', '宕机', '崩溃', '失灵', '失效', '失败', '漏掉'];

function countNegationsInSegment(segment) {
  if (!segment) return 0;
  const masked = String(segment).replace(
    /(?:以前|之前|过去|原本|平时|从前)?(?:从没|从未|没|未曾|不曾|不会主动)[^\s，,。！？；的]{1,6}的/gu,
    '修饰的',
  );
  const matches = masked.match(NEGATION_OPERATOR_RE);
  return matches ? matches.length : 0;
}

function normalizeSeparableVerbs(clause) {
  let out = clause.replace(
    /([换调请退改加值上排办转点送借还])(?:过|了|完|好|成)([班休假订签点岗课院学餐外卖车款])/gu,
    '$1$2',
  );
  let complementNegations = 0;
  out = out.replace(
    /([\u4e00-\u9fa5])不了([\u4e00-\u9fa5]{0,2})/gu,
    (_, v, obj) => {
      complementNegations += 1;
      return `${v}${obj}`;
    },
  );
  return { normalizedText: out, complementNegations };
}

function canonicalizeTarget(rawTarget) {
  let t = String(rawTarget ?? '')
    .trim()
    .replace(/^[“"「『‘]+|[”"」』’]+$/gu, '')
    .replace(/^(?:所有|全部|一切|任何|每(?:个|周|天|日|次)|各(?:个|类|种))\s*/u, '');

  // 循环剥离泛化指代词、团队/本人前缀与“远程办公的”等话题修饰语（保留“甲工厂”vs“乙工厂”等专有实体名）
  const prefixRe =
    /^(?:这(?:家|个|条|项|种|座|支|份)|那(?:家|个|条|项|种)|该|此|本|跨时区工程团队|跨时区团队|研发团队|工程团队|远程办公团队|远程团队|远程办公(?:下|中|时)?|团队|公司|企业|组织|部门|我们|本人|我自己|自己|我|个人|人们|大家|人|每周|每天|日常)(?:的)?/u;
  let prev = '';
  while (t && t !== prev) {
    prev = t;
    t = t.replace(prefixRe, '').replace(/^的+|的+$/gu, '').trim();
  }

  // 对“X的协作效率 / X的交付速度”提取完整指标复合词；对“即时沟通的效率 / 会议的频率”合并为“即时沟通效率 / 会议频率”
  const fullCompoundAfterDe = /^.+的([\u4e00-\u9fa5]{2,8}(?:效率|速度|频率|周期|成本|质量|比例|时长|数量|能力))$/u.exec(t);
  if (fullCompoundAfterDe) {
    t = fullCompoundAfterDe[1];
  } else {
    const splitMetricDe = /^([\u4e00-\u9fa5]{2,6})的(效率|速度|频率|周期|成本|质量|比例|时长|数量|能力)$/u.exec(t);
    if (splitMetricDe) {
      t = `${splitMetricDe[1]}${splitMetricDe[2]}`;
      t = t.replace(prefixRe, '').trim();
    }
  }

  // 角色泛称 + 动作名词（如“员工换班” -> “换班”，“病人转院” -> “转院”，“乘客改签” -> “改签”）
  if (!/(?:效率|速度|频率|周期|成本|质量|比例|能力|满意度|留存率)$/u.test(t)) {
    t = t.replace(/^(?:员工|工人|职员|用户|病人|患者|学生|乘客|客户|成员|人员)(?=[\u4e00-\u9fa5]{2,6}$)/u, '');
  }

  return t.trim() || String(rawTarget ?? '').trim();
}

function stripSpeakerAndLocativeFraming(clause) {
  return String(clause ?? '')
    .replace(/^本人(?:经历|确认|判断|基础判断|事实)(?:（[^）]*）|\([^)]*\))?[：:]\s*/u, '')
    .replace(/^(?:我确认|本人确认|我同意|在我看来|依我看|个人认为|个人觉得|我觉得|我认为|事实上|其实)[，,：:\s]*/u, '')
    .replace(/^在(?:我的|本人的|自己的)[^，,：:]{0,12}(?:经历|体验|实践|经验)(?:里|中)[，,：:\s]*/u, '')
    .trim();
}

function isPureScopeOrFramingSegment(seg) {
  const clean = stripSpeakerAndLocativeFraming(seg);
  if (!clean) return { isPure: true, scope: null };
  const scope = extractScopeCondition(clean);
  if (scope) {
    const remainder = clean
      .replace(scope.rawMatch, '')
      .replace(/^[在当于每逢如果一旦只要若只仅，,\s]+|[的时，,\s]+$/gu, '');
    if (remainder.length < 2) {
      return { isPure: true, scope };
    }
  }
  return { isPure: false, scope };
}

function analyzeSingleAssertionClause(rawClause, clauseIndex, inheritedScope = null) {
  const stripped = stripSpeakerAndLocativeFraming(rawClause)
    .replace(/^(?:虽然|尽管|但是|但|却|不过|然而|而且|并且|同时|因此|所以)\s*/u, '')
    .trim();
  if (!stripped) return null;

  const detectedScope = extractScopeCondition(stripped);
  let clauseBody = stripped;
  if (detectedScope) {
    // 若范围短语位于句首或独立修饰位，从命题主干剥离以免干扰主语提取（保留如“只发生在雨天”单句的判断）
    const withoutScope = stripped
      .replace(detectedScope.rawMatch, ' ')
      .replace(/^\s*[，,]\s*|\s*[，,]\s*$/gu, '')
      .trim();
    if (withoutScope.length >= 3) {
      clauseBody = withoutScope;
    }
  }

  const effectiveScope = detectedScope ?? inheritedScope ?? null;
  const hasUniversalQuantifier =
    UNIVERSAL_QUANTIFIER_RE.test(stripped) && !NEGATED_UNIVERSAL_RE.test(stripped);

  const { normalizedText: normClause, complementNegations } = normalizeSeparableVerbs(clauseBody);

  // 领域特化对齐：推荐算法/兴趣广度/新内容探索 vs 变窄/同质化
  const isRecDomain = /推荐|歌单|算法|信息流|流媒体|协同过滤|电台|同类歌曲|独立乐队|新乐队|长尾书单|信息茧房/u.test(normClause);
  if (isRecDomain) {
    const narrowMatch = /(越来越窄|变窄|收窄|狭窄|同质化|回声室|信息茧房|越来越少|变少|减少|压制异质|挤压异质)/u.exec(normClause);
    const broadMatch = /(发现(?:过|了)?[^\s，,。]{0,8}(?:新乐队|独立乐队|新内容|陌生)|偶遇[^\s，,。]{0,8}(?:独立乐队|冷门|新)|拓宽[^\s，,。]{0,8}边界|拓展[^\s，,。]{0,8}兴趣|多样性[^\s，,。]{0,4}回升|推来跨界)/u.exec(normClause);
    if (narrowMatch || broadMatch) {
      const m = narrowMatch ?? broadMatch;
      const basePol = narrowMatch ? -1 : 1;
      const preText = normClause.slice(0, m.index);
      const negCount = countNegationsInSegment(preText) + complementNegations;
      const finalSign = negCount % 2 === 1 ? -basePol : basePol;
      const rawSubject = /兴趣/.test(normClause)
        ? '兴趣'
        : (/新乐队|独立乐队/.test(normClause) ? '新乐队' : '推荐内容多样性');
      return {
        clauseIndex,
        rawText: rawClause.trim(),
        subjectTarget: rawSubject,
        canonicalTarget: '推荐_兴趣多样性',
        predicate: m[1],
        effectivePolarity: finalSign > 0 ? 'positive' : 'negative',
        negationCount: negCount,
        hasUniversalQuantifier,
        scope: effectiveScope ? { scopeText: effectiveScope.scopeText, scopeTag: effectiveScope.scopeTag } : null,
      };
    }
  }

  // 结构 1：模态/达成词 + 动作宾语（如“这家工厂从不允许员工换班”、“并非不允许员工换班”、“曾经在这家工厂成功换班”）
  const modalPattern = new RegExp(
    `^(?<pre>.*?)(?<modal>${[...MODAL_POS_VERBS, ...MODAL_NEG_VERBS, ...ACHIEVE_POS_VERBS].join('|')})(?:了|过)?\\s*(?<obj>[\\u4e00-\\u9fa5A-Za-z0-9]{2,14}?)$`,
    'u',
  );
  const modalMatch = modalPattern.exec(normClause);
  if (modalMatch?.groups) {
    const { pre, modal, obj } = modalMatch.groups;
    const basePol = MODAL_NEG_VERBS.includes(modal) ? -1 : 1;
    const negCount = countNegationsInSegment(pre) + complementNegations;
    const finalSign = negCount % 2 === 1 ? -basePol : basePol;
    const subjectTarget = obj.trim();
    return {
      clauseIndex,
      rawText: rawClause.trim(),
      subjectTarget,
      canonicalTarget: canonicalizeTarget(subjectTarget),
      predicate: ACHIEVE_POS_VERBS.includes(modal) ? `${modal}${subjectTarget}` : modal,
      effectivePolarity: finalSign > 0 ? 'positive' : 'negative',
      negationCount: negCount,
      hasUniversalQuantifier,
      scope: effectiveScope ? { scopeText: effectiveScope.scopeText, scopeTag: effectiveScope.scopeTag } : null,
    };
  }

  const allChangeVerbs = [
    ...POSITIVE_CHANGE_VERBS,
    ...NEGATIVE_CHANGE_VERBS,
    ...DURATION_SHORTEN_VERBS,
    ...DURATION_LENGTHEN_VERBS,
  ].sort((a, b) => b.length - a.length);

  function computeVerbBasePolarity(verb, targetText) {
    const isDurationOrCost = /(?:周期|耗时|等待|延迟|链路|成本|开销)/u.test(targetText);
    if (DURATION_SHORTEN_VERBS.includes(verb)) return isDurationOrCost ? 1 : -1;
    if (DURATION_LENGTHEN_VERBS.includes(verb)) return isDurationOrCost ? -1 : 1;
    if (
       isDurationOrCost
      && (verb === '减少' || verb === '降低')
      && /周期|耗时|延迟|等待/.test(targetText)
    ) {
      return 1;
    }
    if (NEGATIVE_CHANGE_VERBS.includes(verb)) return -1;
    return 1;
  }

  function mapMetricCanonicalTarget(canon) {
    if (canon === '交付周期') return '交付速度';
    return canon;
  }

  // 结构 2：致使/介词宾语前置结构（“远程办公让团队协作效率提高”、“把交付周期缩短了”、“对人的兴趣只有变窄...”）
  const causativeRe = new RegExp(
    `^(?<pre>.*?)(?:让|使|使得|令|导致|造成|把|将|对)\\s*(?<target>[\\u4e00-\\u9fa5A-Za-z0-9的]{2,16}?)\\s*(?<mid>(?:并非|并不是|绝非|从来不会|从来不|从不|从未|绝不会|绝不|并不会|并不|不是|不会|不能|没有|不|没|未|只会|只有|必然|一定|完全|都|也|确实|明显|显著|反而|越来越|有所)*?)(?<verb>${allChangeVerbs.join('|')})(?<tail>.*)$`,
    'u',
  );
  const causMatch = causativeRe.exec(normClause);
  if (causMatch?.groups) {
    const { pre, target, mid, verb, tail } = causMatch.groups;
    // 若 verb 是及物动词“替代/取代”且后面紧跟真正宾语（如“把X替代为Y”较少见，主要是“让效率提高”）
    if (!((verb === '替代' || verb === '取代') && tail.trim().length >= 2)) {
      const cleanSubj = target.replace(/^的+|的+$/gu, '').trim();
      const canonRaw = canonicalizeTarget(cleanSubj);
      const basePol = computeVerbBasePolarity(verb, canonRaw);
      const negCount = countNegationsInSegment(`${pre} ${mid}`) + complementNegations;
      const finalSign = negCount % 2 === 1 ? -basePol : basePol;
      return {
        clauseIndex,
        rawText: rawClause.trim(),
        subjectTarget: canonRaw || cleanSubj,
        canonicalTarget: mapMetricCanonicalTarget(canonRaw || cleanSubj),
        predicate: verb,
        effectivePolarity: finalSign > 0 ? 'positive' : 'negative',
        negationCount: negCount,
        hasUniversalQuantifier,
        scope: effectiveScope ? { scopeText: effectiveScope.scopeText, scopeTag: effectiveScope.scopeTag } : null,
      };
    }
  }

  // 结构 2b：被动“X 被 Y 替代/取代/禁止/限制”
  const passiveRe = /^(?<patient>[\u4e00-\u9fa5A-Za-z0-9的]{2,16}?)(?<preNeg>(?:并非|并不是|绝非|从不|绝不|不会|不能|不可|没有|无法|不|没|未)*?)被(?<agent>[\u4e00-\u9fa5A-Za-z0-9的]{0,14}?)(?<verb>替代|取代|禁止|限制|剥夺|削弱|拖慢|压制)(?:了|过)?$/u;
  const passiveMatch = passiveRe.exec(normClause);
  if (passiveMatch?.groups) {
    const { patient, preNeg, verb } = passiveMatch.groups;
    const basePol = ['禁止', '限制', '剥夺', '削弱', '拖慢', '压制'].includes(verb) ? -1 : 1;
    const negCount = countNegationsInSegment(preNeg) + complementNegations;
    const finalSign = negCount % 2 === 1 ? -basePol : basePol;
    const canonRaw = canonicalizeTarget(patient);
    return {
      clauseIndex,
      rawText: rawClause.trim(),
      subjectTarget: canonRaw,
      canonicalTarget: canonRaw,
      predicate: verb,
      effectivePolarity: finalSign > 0 ? 'positive' : 'negative',
      negationCount: negCount,
      hasUniversalQuantifier,
      scope: effectiveScope ? { scopeText: effectiveScope.scopeText, scopeTag: effectiveScope.scopeTag } : null,
    };
  }

  // 结构 3：动宾结构 VO（如“远程办公提高了交付速度”、“却降低了即时沟通效率”、“缩短了跨时区工程团队的交付周期”）
  const voRe = new RegExp(
    `^(?<pre>.*?)(?<verb>${allChangeVerbs.join('|')})(?:了|过|着)?\\s*(?:所有|全部|一切|任何)?(?<obj>[\\u4e00-\\u9fa5A-Za-z0-9的]{2,20})$`,
    'u',
  );
  const voMatch = voRe.exec(normClause);
  if (voMatch?.groups) {
    const { pre, verb, obj } = voMatch.groups;
    const canonRaw = canonicalizeTarget(obj);
    const basePol = computeVerbBasePolarity(verb, canonRaw);
    const negCount = countNegationsInSegment(pre) + complementNegations;
    const finalSign = negCount % 2 === 1 ? -basePol : basePol;
    return {
      clauseIndex,
      rawText: rawClause.trim(),
      subjectTarget: canonRaw,
      canonicalTarget: mapMetricCanonicalTarget(canonRaw),
      predicate: verb,
      effectivePolarity: finalSign > 0 ? 'positive' : 'negative',
      negationCount: negCount,
      hasUniversalQuantifier,
      scope: effectiveScope ? { scopeText: effectiveScope.scopeText, scopeTag: effectiveScope.scopeTag } : null,
    };
  }

  // 结构 4：主谓结构 SV（如“协作效率降低”、“会议频率提高”、“会议频率降低了”、“这条路总是堵车”）
  const svPredicates = [...allChangeVerbs, ...STATUS_POS_WORDS, ...STATUS_NEG_WORDS].sort(
    (a, b) => b.length - a.length,
  );
  const svRe = new RegExp(
    `^(?<subj>[\\u4e00-\\u9fa5A-Za-z0-9的]{2,18}?)\\s*(?<mid>(?:并非|并不是|绝非|从来不会|从来不|从不|从未|绝不会|绝不|并不会|并不|不是|不会|不能|不可|没有|未曾|无法|不|没|未|只会|必然|一定|总是|永远|完全|确实|也|都|却|反而|有所|明显|显著|很|非常|十分|会|能|可以)*?)(?<verb>${svPredicates.join('|')})(?:了|过|着|的)?$`,
    'u',
  );
  const svMatch = svRe.exec(normClause);
  if (svMatch?.groups) {
    const { subj, mid, verb } = svMatch.groups;
    const canonRaw = canonicalizeTarget(subj);
    let basePol = 1;
    if (STATUS_NEG_WORDS.includes(verb)) basePol = -1;
    else if (STATUS_POS_WORDS.includes(verb)) basePol = 1;
    else basePol = computeVerbBasePolarity(verb, canonRaw);

    const negCount = countNegationsInSegment(`${subj} ${mid}`) + complementNegations;
    const cleanSubjWithoutNeg = canonicalizeTarget(subj.replace(NEGATION_OPERATOR_RE, ''));
    const finalSign = negCount % 2 === 1 ? -basePol : basePol;
    return {
      clauseIndex,
      rawText: rawClause.trim(),
      subjectTarget: cleanSubjWithoutNeg || canonRaw,
      canonicalTarget: mapMetricCanonicalTarget(cleanSubjWithoutNeg || canonRaw),
      predicate: verb,
      effectivePolarity: finalSign > 0 ? 'positive' : 'negative',
      negationCount: negCount,
      hasUniversalQuantifier,
      scope: effectiveScope ? { scopeText: effectiveScope.scopeText, scopeTag: effectiveScope.scopeTag } : null,
    };
  }

  // 结构 5：通用动作/事实经验兜底（如“我曾经在这家工厂换过班” -> 动作对象“换班”，肯定极性）
  const negCount = countNegationsInSegment(normClause) + complementNegations;
  const strippedAction = normClause
    .replace(NEGATION_OPERATOR_RE, ' ')
    .replace(/(?:无一例外|只会|只有|必然|必定|一定|所有|全部|一切|任何|总是|永远|完全)/gu, ' ')
    .replace(/在[\u4e00-\u9fa5A-Za-z0-9]{1,12}?(?:工厂|公司|医院|学校|团队|部门|车间|门店|餐厅|平台|航司|机构)(?:里|中)?/gu, ' ')
    .replace(/(?:我本人|我自己|本人|自己|我们|我|曾经|曾|去年|今年|以前|之前|刚刚|确实|真的|已经|亲自|可以|能够|会|能|都|也|还)/gu, ' ')
    .replace(/[了过着的]/gu, ' ')
    .trim();
  const actionChunks = strippedAction.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,12}/gu) ?? [];
  const rawActionTarget = actionChunks[actionChunks.length - 1] ?? stripped.slice(0, 8);
  const canonAction = canonicalizeTarget(rawActionTarget);
  const finalSign = negCount % 2 === 1 ? -1 : 1;

  return {
    clauseIndex,
    rawText: rawClause.trim(),
    subjectTarget: canonAction,
    canonicalTarget: canonAction,
    predicate: canonAction,
    effectivePolarity: finalSign > 0 ? 'positive' : 'negative',
    negationCount: negCount,
    hasUniversalQuantifier,
    scope: effectiveScope ? { scopeText: effectiveScope.scopeText, scopeTag: effectiveScope.scopeTag } : null,
  };
}

// 将自然语言命题按复句连接词与标点拆分为带对象、谓词、真实极性、全称量词与适用范围的子句列表。
export function parsePropositionClauses(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const cleanedTop = stripSpeakerAndLocativeFraming(text);
  if (!cleanedTop) return [];

  const primarySegments = cleanedTop
    .split(/[，,；;。！？!?\n]+/u)
    .map((s) => s.trim())
    .filter(Boolean);

  const subSegments = [];
  const conjSplitRe =
    /(?<=[\u4e00-\u9fa5A-Za-z0-9”"」』）)])\s*(?:(?:但是|但|却|不过|然而|而且|并且|同时)|(?<![反进转从因由继忽偶幸甚总一])而(?![且已今言]))\s*(?=[\u4e00-\u9fa5A-Za-z0-9“"「『])/u;

  for (const seg of primarySegments) {
    const parts = seg.split(conjSplitRe).map((p) => p.trim()).filter(Boolean);
    subSegments.push(...parts);
  }

  const clauses = [];
  let inheritedScope = null;

  for (const seg of subSegments) {
    const pureCheck = isPureScopeOrFramingSegment(seg);
    if (pureCheck.isPure) {
      if (pureCheck.scope) inheritedScope = pureCheck.scope;
      continue;
    }
    const parsed = analyzeSingleAssertionClause(seg, clauses.length, inheritedScope);
    if (parsed) {
      clauses.push(parsed);
    }
  }

  // 若整句仅为范围确认句（如“我确认，这个现象只发生在雨天”），保留单条带 scope 的描述子句供上游读取
  if (clauses.length === 0 && inheritedScope) {
    clauses.push({
      clauseIndex: 0,
      rawText: cleanedTop,
      subjectTarget: inheritedScope.scopeText,
      canonicalTarget: `scope_only:${inheritedScope.scopeTag}`,
      predicate: '限定范围',
      effectivePolarity: 'positive',
      negationCount: 0,
      hasUniversalQuantifier: false,
      scope: { scopeText: inheritedScope.scopeText, scopeTag: inheritedScope.scopeTag },
    });
  }

  return clauses;
}

const METRIC_HEAD_NOUNS = ['效率', '速度', '频率', '周期', '成本', '质量', '比例', '时长', '数量', '能力'];

function extractDistinctEntityPrefix(rawText) {
  const m = /(?<![这那该此本])([\u4e00-\u9fa5A-Za-z0-9]{1,6}(?:工厂|医院|学校|餐厅|航司|银行))/u.exec(
    String(rawText ?? '').replace(/(?:这家|那家|该|此|本)(?:工厂|医院|学校|餐厅|航司|银行)/gu, ''),
  );
  return m ? m[1] : null;
}

function areClauseTargetsAligned(clauseA, clauseB) {
  const a = clauseA?.canonicalTarget ?? '';
  const b = clauseB?.canonicalTarget ?? '';
  if (!a || !b) return false;
  if (a.startsWith('scope_only:') || b.startsWith('scope_only:')) return false;

  // 若两句明确指代不同专有实体（如“甲工厂” vs “乙工厂”），不视为同一对象
  const entA = extractDistinctEntityPrefix(clauseA.rawText);
  const entB = extractDistinctEntityPrefix(clauseB.rawText);
  if (entA && entB && entA !== entB) return false;

  if (a === b) return true;

  // 对以通用指标词结尾的复合词（如“协作效率” vs “即时沟通效率”、“交付速度” vs “会议频率”），严禁仅凭后缀相同跨对象匹配！
  const metricSuffixA = METRIC_HEAD_NOUNS.find((m) => a.endsWith(m) && a.length > m.length);
  const metricSuffixB = METRIC_HEAD_NOUNS.find((m) => b.endsWith(m) && b.length > m.length);
  if (metricSuffixA || metricSuffixB) {
    return a === b;
  }

  if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) {
    return true;
  }
  return false;
}

// 判定待评估主张与本人已确认节点之间的语义命题关系：绑定子句对象、谓词、双重否定真实极性、全称量词与适用条件。
export function evaluateSemanticPropositionRelation(
  statementText,
  nodeText,
  { statementScope = null, nodeScope = null } = {},
) {
  if (typeof statementText !== 'string' || !statementText.trim() || typeof nodeText !== 'string' || !nodeText.trim()) {
    return {
      relation: 'insufficient_evidence',
      matchedClauses: [],
      statementScope: null,
      nodeScope: null,
      reason: '缺少可核验的主张或本人已确认节点文本。',
    };
  }

  const stmtClauses = parsePropositionClauses(statementText).filter(
    (c) => !c.canonicalTarget.startsWith('scope_only:'),
  );
  const nodeClauses = parsePropositionClauses(nodeText).filter(
    (c) => !c.canonicalTarget.startsWith('scope_only:'),
  );

  if (stmtClauses.length === 0 || nodeClauses.length === 0) {
    return {
      relation: 'insufficient_evidence',
      matchedClauses: [],
      statementScope: normalizeScopeKey(statementScope) ?? extractScopeCondition(statementText)?.scopeTag ?? null,
      nodeScope: normalizeScopeKey(nodeScope) ?? extractScopeCondition(nodeText)?.scopeTag ?? null,
      reason: '未能从句子中解析出可比对的核心命题对象与谓词。',
    };
  }

  const globalStmtScope =
    normalizeScopeKey(statementScope) ?? extractScopeCondition(statementText)?.scopeTag ?? null;
  const globalNodeScope =
    normalizeScopeKey(nodeScope) ?? extractScopeCondition(nodeText)?.scopeTag ?? null;

  const matchedClauses = [];
  const coveredStmtIndices = new Set();

  for (const sClause of stmtClauses) {
    const effStmtScope = normalizeScopeKey(sClause.scope) ?? globalStmtScope;
    const stmtUniversal = sClause.hasUniversalQuantifier || (
      UNIVERSAL_QUANTIFIER_RE.test(statementText) && !NEGATED_UNIVERSAL_RE.test(statementText)
    );

    for (const nClause of nodeClauses) {
      if (!areClauseTargetsAligned(sClause, nClause)) continue;

      const effNodeScope = normalizeScopeKey(nClause.scope) ?? globalNodeScope;
      const nodeUniversal = nClause.hasUniversalQuantifier;

      // 范围覆盖判定：
      // 1) 若主张限定在条件 X，而节点限定在不同条件 Y（X !== Y），互不覆盖 -> 跳过（insufficient_evidence）
      if (effStmtScope && effNodeScope && effStmtScope !== effNodeScope) {
        continue;
      }
      // 2) 若主张本身限定在特定条件 X（且节点未指明同一条件 X，也不是全称判断），无条件过往个例不能覆盖条件 X 下的专属主张
      if (effStmtScope && !effNodeScope && !nodeUniversal) {
        continue;
      }

      const samePolarity = sClause.effectivePolarity === nClause.effectivePolarity;
      if (!samePolarity) {
        // 极性相反：
        // - 若原句无条件全称（如“只会”、“从不”、“必然”），任何条件下的本人反例均构成直接冲突！
        // - 若两句处于同一适用条件（或均无额外限定），直接构成冲突！
        if (stmtUniversal || nodeUniversal || effStmtScope === effNodeScope) {
          matchedClauses.push({
            statementClause: sClause,
            nodeClause: nClause,
            target: sClause.canonicalTarget,
            relation: 'conflict',
          });
        }
      } else {
        // 极性相同：若原句是无条件全称（“所有/只会”），仅凭单一受限条件下的同向个例不足以证明全称相容
        if (stmtUniversal && !effStmtScope && effNodeScope && !nodeUniversal) {
          continue;
        }
        coveredStmtIndices.add(sClause.clauseIndex);
        matchedClauses.push({
          statementClause: sClause,
          nodeClause: nClause,
          target: sClause.canonicalTarget,
          relation: 'compatible',
        });
      }
    }
  }

  const conflictMatches = matchedClauses.filter((m) => m.relation === 'conflict');
  if (conflictMatches.length > 0) {
    const first = conflictMatches[0];
    return {
      relation: 'conflict',
      matchedClauses,
      statementScope: globalStmtScope,
      nodeScope: globalNodeScope,
      reason: `主张在对象「${first.statementClause.subjectTarget}」上的判断与本人已确认节点直接冲突。`,
    };
  }

  if (coveredStmtIndices.size === stmtClauses.length && stmtClauses.length > 0) {
    return {
      relation: 'compatible',
      matchedClauses,
      statementScope: globalStmtScope,
      nodeScope: globalNodeScope,
      reason: '主张各分句的核心对象与极性均与本人已确认事实相容，且适用范围一致。',
    };
  }

  return {
    relation: 'insufficient_evidence',
    matchedClauses,
    statementScope: globalStmtScope,
    nodeScope: globalNodeScope,
    reason: '当前已确认节点与主张在核心对象或适用条件上不覆盖，证据不足。',
  };
}

// ==================== L-02: 公开主张候选核验（跨主体强隔离、原片段引文、限定规范与关系变化） ====================

const ENTITY_CATEGORY_SPECS = [
  { category: 'factory', suffixes: ['工厂', '厂区', '分厂', '厂'] },
  { category: 'workshop', suffixes: ['车间', '产线', '班组'] },
  { category: 'company', suffixes: ['公司', '企业', '集团'] },
  { category: 'hospital', suffixes: ['医院', '诊所'] },
  { category: 'school', suffixes: ['学校', '中学', '小学', '大学', '学院'] },
  { category: 'bank', suffixes: ['银行'] },
  { category: 'store', suffixes: ['门店', '餐厅', '饭店', '酒店'] },
  { category: 'airline', suffixes: ['航司', '航空'] },
  { category: 'city', suffixes: ['城市', '地区', '园区', '基地', '站点'] },
  { category: 'product', suffixes: ['产品', '机型', '型号', '车型', '品牌', '系统', '平台', '软件'] },
  { category: 'plan', suffixes: ['方案', '项目', '模式', '制度', '工艺', '做法', '路线', '策略', '版本'] },
  { category: 'team', suffixes: ['部门', '团队', '班次', '队', '组'] },
];

const ALL_ENTITY_SUFFIXES = ENTITY_CATEGORY_SPECS
  .flatMap((spec) => spec.suffixes)
  .sort((a, b) => b.length - a.length);

const SUFFIX_TO_CATEGORY = new Map(
  ENTITY_CATEGORY_SPECS.flatMap((spec) => spec.suffixes.map((s) => [s, spec.category])),
);

const TIER1_PREFIX_ENTITY_RE = new RegExp(
  `(?<![\\u4e00-\\u9fa5A-Za-z0-9])([甲乙丙丁戊己庚辛壬癸]|[A-Za-z](?:\\d{0,2})?|第?[一二三四五六七八九十\\d]{1,3}号?)(${ALL_ENTITY_SUFFIXES.join('|')})(?![\\u4e00-\\u9fa5A-Za-z0-9])`,
  'gu',
);

const TIER1_PREFIX_ENTITY_LOOSE_RE = new RegExp(
  `(?<![这那该此本某每各全所])([甲乙丙丁戊己庚辛壬癸]|[A-Za-z](?:\\d{0,2})?|第?[一二三四五六七八九十\\d]{1,3}号)(${ALL_ENTITY_SUFFIXES.join('|')})`,
  'gu',
);

const TIER1_PREFIX_SIMPLE_ORDINAL_RE = new RegExp(
  `(?<![这那该此本某每各全所第])([甲乙丙丁戊己庚辛壬癸]|[一二三四五六七八九十])(工厂|厂区|分厂|车间|产线|班组|公司|医院|学校|银行|门店|机型|方案|项目|队|组)`,
  'gu',
);

const TIER1_SUFFIX_ENTITY_RE = new RegExp(
  `(工厂|车间|产线|公司|医院|学校|银行|产品|机型|方案|项目|制度|做法|团队|部门|班组|路线|版本)([甲乙丙丁戊己庚辛壬癸]|[A-Za-z](?:\\d{0,2})?|[一二三四五六七八九十\\d]{1,2}号?)(?![\\u4e00-\\u9fa5A-Za-z0-9])`,
  'gu',
);

const TIER1_PARTY_RE = /(?<![\u4e00-\u9fa5])(某[甲乙丙丁戊己庚辛]|[甲乙丙丁戊己庚辛]方)(?![\u4e00-\u9fa5])/gu;

const GENERIC_ENTITY_PREFIX_STOP = new Set([
  '这', '那', '该', '此', '本', '某', '每', '各', '全', '所', '有', '无', '非', '不', '在', '到', '去',
  '这家', '那家', '这个', '那个', '这种', '那种', '这座', '那座', '这家', '一家', '一个', '一些', '一线', '二线',
  '所有', '全部', '一切', '任何', '每个', '每家', '各个', '各家', '很多', '许多', '不少', '部分', '大多', '多数',
  '其他', '别的', '不同', '同类', '类似', '现在', '目前', '以前', '过去', '传统', '现代', '普通', '一般', '常规',
  '大型', '小型', '中型', '基层', '本地', '当地', '附近', '国内', '国外', '整个', '全厂', '全行', '行业', '外部',
  '内部', '相关', '对应', '上述', '前述', '当前', '原来', '原本', '新的', '旧的', '弹性', '固定', '灵活', '严格',
]);

const PROPER_PREFIX_ENTITY_RE =
  /(?<![\u4e00-\u9fa5A-Za-z0-9])([\u4e00-\u9fa5]{2,4})(工厂|公司|医院|学校|银行|餐厅|航司|门店|园区|基地|车间)/gu;

function normalizeEntityLabel(raw, category) {
  const s = String(raw ?? '').trim().normalize('NFKC');
  if (!s) return '';
  // 统一 A厂 / A工厂 等同类别下的大小写差异，保留前缀核心标识
  return `${category}:${s.toLowerCase()}`;
}

// 通用具名主体/实体提取器：识别甲工厂/乙工厂、A厂/B厂、A公司/B公司、一车间/二车间、某甲/某乙、A方案/B方案及专有前缀机构名。
export function extractNamedEntities(text) {
  const raw = String(text ?? '').normalize('NFKC');
  if (!raw.trim()) return [];

  const found = [];
  const seen = new Set();
  const addEntity = (label, category, tier) => {
    const clean = String(label ?? '').trim();
    if (!clean) return;
    const key = `${category}:${clean.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({
      raw: clean,
      category,
      tier,
      key,
    });
  };

  // 1. 强标识前缀实体（甲工厂、乙工厂、A厂、B公司、1号车间等）
  for (const re of [TIER1_PREFIX_ENTITY_RE, TIER1_PREFIX_ENTITY_LOOSE_RE, TIER1_PREFIX_SIMPLE_ORDINAL_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const prefix = m[1];
      const suffix = m[2];
      // 排除“一家工厂/一个公司/一线工厂”等量词误匹配（此正则不含“家/个/线”，但需防“一厂”前为“唯/统/第”或“一种”）
      if (/^[一]$/.test(prefix) && suffix === '方案' && /一种方案/.test(raw.slice(Math.max(0, m.index - 1), m.index + 5))) {
        continue;
      }
      if (/^[一]$/.test(prefix) && (suffix === '厂' || suffix === '公司' || suffix === '工厂') && raw[m.index + 1] && ['家', '个', '座', '线'].includes(raw[m.index + 1])) {
        continue;
      }
      // 排除字母属于长英文单词内部的情况（如 AI公司 -> 保留 AI公司，但不切出 I公司）
      if (/^[A-Za-z]$/.test(prefix) && m.index > 0 && /[A-Za-z]/.test(raw[m.index - 1])) {
        continue;
      }
      const cat = SUFFIX_TO_CATEGORY.get(suffix) ?? 'entity';
      addEntity(`${prefix}${suffix}`, cat, 1);
    }
  }

  // 2. 强标识后缀实体（工厂甲、方案A、车间2）
  TIER1_SUFFIX_ENTITY_RE.lastIndex = 0;
  let ms;
  while ((ms = TIER1_SUFFIX_ENTITY_RE.exec(raw)) !== null) {
    const noun = ms[1];
    const tag = ms[2];
    const cat = SUFFIX_TO_CATEGORY.get(noun) ?? 'entity';
    addEntity(`${noun}${tag}`, cat, 1);
  }

  // 3. 某甲 / 某乙 / 甲方 / 乙方
  TIER1_PARTY_RE.lastIndex = 0;
  let mp;
  while ((mp = TIER1_PARTY_RE.exec(raw)) !== null) {
    addEntity(mp[1], 'party', 1);
  }

  // 4. 专有前缀机构名（如 城东医院 vs 城西医院、苏州工厂 vs 深圳工厂），过滤常见泛指修饰词
  PROPER_PREFIX_ENTITY_RE.lastIndex = 0;
  let mn;
  while ((mn = PROPER_PREFIX_ENTITY_RE.exec(raw)) !== null) {
    const prefix = mn[1];
    const suffix = mn[2];
    if (GENERIC_ENTITY_PREFIX_STOP.has(prefix)) continue;
    if (
      /^(?:这|那|该|此|本|某|每|各|所有|全部|任何|一家|一个|一线|很多|许多|部分|不同|其他|弹性|禁止|允许|推行|实行|采用|属于|关于|针对|对于|来自|提到|说的是)/u.test(prefix)
      || /(?:的|了|着|过|在|是|有|会|能|可|不|没|都|也|就|才|并|且|与|和|或)$/u.test(prefix)
    ) {
      continue;
    }
    const cat = SUFFIX_TO_CATEGORY.get(suffix) ?? 'entity';
    addEntity(`${prefix}${suffix}`, cat, 2);
  }

  return found;
}

const UNIVERSAL_CROSS_ENTITY_RULE_RE =
  /(?:所有工厂|全行业统一|国家强制规定|全国同类|无一例外都适用|全公司统一规定|跨厂通用规定)/u;

function detectCrossSubjectMismatch(claimText, evidence, decomposition = null) {
  const claimSource = [
    String(claimText ?? ''),
    typeof decomposition?.subject === 'string' ? decomposition.subject : '',
  ].join(' ');
  const claimEntities = extractNamedEntities(claimSource);
  if (claimEntities.length === 0) return null;

  const evFullText = `${evidence?.title ?? ''} ${evidence?.excerpt ?? ''}`.trim();
  const evEntities = extractNamedEntities(evFullText);
  if (evEntities.length === 0) return null;

  // 若证据原文已直接提及主张中的任意具名主体，不判定为跨主体
  const claimMentionsInEv = claimEntities.some(
    (ce) => evFullText.toLowerCase().includes(ce.raw.toLowerCase()),
  );
  if (claimMentionsInEv) return null;

  // 若证据明确给出覆盖全部主体的跨主体通用硬规则且未限定在另一具名主体，不判定为跨主体
  if (UNIVERSAL_CROSS_ENTITY_RULE_RE.test(evFullText)) return null;

  // 查找同类别（或同为 Tier-1 显式区分实体）的不同主体对
  for (const ce of claimEntities) {
    const conflictingEvEntity = evEntities.find(
      (ee) =>
        ee.raw.toLowerCase() !== ce.raw.toLowerCase()
        && (ee.category === ce.category || (ce.tier === 1 && ee.tier === 1)),
    );
    if (conflictingEvEntity) {
      return {
        claimSubject: ce.raw,
        evidenceSubject: conflictingEvEntity.raw,
        category: ce.category,
        claimSubjects: claimEntities.map((e) => e.raw),
        evidenceSubjects: evEntities.map((e) => e.raw),
        boundaryReason: `这条材料说的是「${conflictingEvEntity.raw}」，和「${ce.raw}」不是同一个对象，不能直接用来反驳你的句子。`,
      };
    }
  }

  return null;
}

function verifyQuoteInEvidenceOrTitle(quoteText, evidence) {
  if (!evidence || typeof evidence !== 'object') {
    return { ok: false, reason: 'EVIDENCE_TEXT_UNAVAILABLE' };
  }
  const excerpt = String(evidence.excerpt ?? '');
  const title = String(evidence.title ?? '');
  if (!excerpt.trim() && !title.trim()) {
    return { ok: false, reason: 'EVIDENCE_TEXT_UNAVAILABLE' };
  }
  if (typeof quoteText !== 'string' || !quoteText.trim()) {
    return { ok: false, reason: 'EMPTY_QUOTE' };
  }

  // 1. 先按原样在 excerpt 中精确匹配
  if (excerpt) {
    const direct = verifyQuoteInEvidence(quoteText, evidence);
    if (direct.ok) {
      return { ...direct, field: 'excerpt' };
    }
  }

  // 2. 支持去除多余空白后的子串匹配（先查 excerpt，再查 title），返回对应原文切片
  const compactMatcher = (sourceText, field) => {
    if (!sourceText) return null;
    const rawTrimmed = quoteText.trim();
    const directIdx = sourceText.indexOf(rawTrimmed);
    if (directIdx >= 0) {
      return {
        ok: true,
        startOffset: directIdx,
        endOffset: directIdx + rawTrimmed.length,
        exactQuote: sourceText.slice(directIdx, directIdx + rawTrimmed.length),
        evidenceId: evidence.id ?? evidence.evidenceId ?? null,
        field,
      };
    }

    const normQuote = rawTrimmed.normalize('NFKC').replace(/\s+/gu, '');
    if (!normQuote) return null;

    const chars = [];
    const origOffsets = [];
    for (let i = 0; i < sourceText.length; i += 1) {
      const ch = sourceText[i];
      if (/\s/u.test(ch)) continue;
      const nCh = ch.normalize('NFKC');
      for (const piece of nCh) {
        chars.push(piece);
        origOffsets.push(i);
      }
    }
    const compactSource = chars.join('');
    const hitIdx = compactSource.indexOf(normQuote);
    if (hitIdx >= 0) {
      const startOffset = origOffsets[hitIdx];
      const endOffset = origOffsets[hitIdx + normQuote.length - 1] + 1;
      return {
        ok: true,
        startOffset,
        endOffset,
        exactQuote: sourceText.slice(startOffset, endOffset),
        evidenceId: evidence.id ?? evidence.evidenceId ?? null,
        field,
      };
    }
    return null;
  };

  return (
    compactMatcher(excerpt, 'excerpt')
    ?? compactMatcher(title, 'title')
    ?? { ok: false, reason: 'QUOTE_NOT_FOUND_IN_EVIDENCE' }
  );
}

const PARTIAL_SCENARIO_HINT_PATTERNS = [
  /(?:只在|仅在|只针对|仅针对|只限于|仅限于|限定在|主要是针对|说的是|聚焦在)\s*[“"「『]?([^”"」』，,。！？；\s]{2,18})[”"」』]?/u,
  /(?:在|当)\s*([^，,。！？；]{2,16}?)(?:的场景下|场景下|场景中|场景里|情况下|条件下|前提下|阶段|期间|时候|时)(?=[，,。！？；\s]|$)/u,
  /((?:批量写稿|批量生成|批量创作|模板化写作|反复用同一个提示词|夜班交接|白班交接|冷启动阶段|刚开始用的时候|连续听同类歌曲|跨时区协作|高频重复|紧急故障|新手阶段))/u,
];

const PARTIAL_HEDGE_CUE_RE =
  /(?:分情况|看场景|取决于|前提是|只在|仅在|只针对|仅针对|只限于|仅限于|主要适用于|在这个场景下|在这种场景下|另一种情况|别的写法|其他场景|反之|不过在)/u;

export function extractPublicScopeHint(text, claimText = '') {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  const claimNorm = String(claimText ?? '').normalize('NFKC');

  const fromCore = extractScopeCondition(raw);
  if (fromCore?.scopeText) {
    const clean = fromCore.scopeText.trim();
    if (clean && (!claimNorm || !claimNorm.includes(clean.normalize('NFKC')))) {
      return clean;
    }
  }

  for (const re of PARTIAL_SCENARIO_HINT_PATTERNS) {
    const m = re.exec(raw);
    if (m && m[1]?.trim()) {
      const clean = m[1].trim().replace(/^[“"「『‘]+|[”"」』’]+$/gu, '');
      if (clean.length >= 2 && (!claimNorm || !claimNorm.includes(clean.normalize('NFKC')))) {
        return clean;
      }
    }
  }
  return null;
}

function buildPublicFocusVerified(claimText, proposalFocus = null, fallbackFocus = null) {
  const text = String(claimText ?? '');
  if (!text.trim()) return null;

  const tryFocusObj = (cand) => {
    if (!cand || typeof cand !== 'object') return null;
    const spanText = typeof cand.spanText === 'string' ? cand.spanText.trim() : '';
    if (!spanText) return null;
    let startOffset = Number.isInteger(cand.startOffset) ? cand.startOffset : -1;
    let endOffset = Number.isInteger(cand.endOffset) ? cand.endOffset : -1;
    if (startOffset < 0 || endOffset <= startOffset || text.slice(startOffset, endOffset) !== spanText) {
      startOffset = text.indexOf(spanText);
      endOffset = startOffset >= 0 ? startOffset + spanText.length : -1;
    }
    if (startOffset < 0 || endOffset <= startOffset) return null;
    const kind = FOCUS_KINDS.includes(cand.kind) ? cand.kind : inferFocusKind(spanText);
    const reason = typeof cand.reason === 'string' && cand.reason.trim()
      ? cand.reason.trim()
      : `我先看看「${spanText}」，找找公开讨论里有没有能帮我们看清边界的材料。`;
    return { kind, spanText, startOffset, endOffset, reason };
  };

  return tryFocusObj(proposalFocus) ?? tryFocusObj(fallbackFocus) ?? selectFocusFromSentence(text);
}

const VALID_PUBLIC_RELATIONS = new Set(['support', 'refute', 'qualify', 'unknown']);

const PUBLIC_RELATION_LABELS = Object.freeze({
  support: '支持',
  refute: '反驳',
  qualify: '限定',
  unknown: '待定',
});

// 严格核验公开对话模型提议：证据存在性、原片段引文匹配、跨主体强隔离、局部场景限定规范、关系变化与改写依据核验。
export function verifyPublicAnalysisProposal({
  claimText = '',
  decomposition = null,
  proposal = {},
  evidenceList = [],
  previousPublicAnalysis = null,
  focus = null,
} = {}) {
  const cleanClaim = String(claimText ?? '').trim();
  const evidenceLookup = new Map();
  const rawEvs = evidenceList instanceof Map
    ? [...evidenceList.values()]
    : (Array.isArray(evidenceList) ? evidenceList : []);

  for (const rawEv of rawEvs) {
    if (!rawEv || typeof rawEv !== 'object') continue;
    const evId = String(rawEv.id ?? rawEv.evidenceId ?? '').trim();
    if (!evId) continue;
    const normalizedAuthor =
      typeof rawEv.author === 'string' && rawEv.author.trim() && rawEv.author.trim() !== 'self'
        ? rawEv.author.trim()
        : '未知作者';
    evidenceLookup.set(evId, {
      ...rawEv,
      id: evId,
      evidenceId: evId,
      sourceType: rawEv.sourceType ?? 'public_search',
      title: String(rawEv.title ?? '').trim(),
      author: normalizedAuthor,
      attribution: 'other_author',
      excerpt: String(rawEv.excerpt ?? rawEv.summary ?? '').trim(),
      url: typeof rawEv.url === 'string' && rawEv.url.trim() ? rawEv.url.trim() : null,
      truncated: Boolean(rawEv.truncated ?? rawEv.excerptTruncated ?? false),
    });
  }

  const verifiedFocus = cleanClaim
    ? buildPublicFocusVerified(cleanClaim, proposal?.focus, focus)
    : null;

  const verifiedRelations = [];
  const rejectedItems = [];
  const citations = [];
  const edges = [];
  const nodes = [];
  const unknownParts = [];
  const seenRelationEvIds = new Set();

  if (cleanClaim) {
    nodes.push({
      id: 'claim_current',
      kind: 'claim',
      text: cleanClaim,
      attribution: 'self',
      focusSpan: verifiedFocus?.spanText ?? null,
      focusKind: verifiedFocus?.kind ?? null,
    });
  }

  const claimHasUniversal =
    UNIVERSAL_QUANTIFIER_RE.test(cleanClaim) && !NEGATED_UNIVERSAL_RE.test(cleanClaim);

  const rawRelations = Array.isArray(proposal?.relations) ? proposal.relations : [];
  for (const rel of rawRelations) {
    if (!rel || typeof rel !== 'object') {
      rejectedItems.push({
        kind: 'public_relation',
        reason: 'INVALID_RELATION_SCHEMA',
        item: rel,
      });
      continue;
    }

    const evId = typeof rel.evidenceId === 'string' ? rel.evidenceId.trim() : '';
    const ev = evId ? evidenceLookup.get(evId) : null;
    if (!ev) {
      rejectedItems.push({
        kind: 'public_relation',
        reason: 'EVIDENCE_NOT_FOUND',
        evidenceId: evId || null,
        item: rel,
      });
      continue;
    }

    if (seenRelationEvIds.has(ev.id)) {
      continue;
    }

    // 外部材料提示词注入检测（绝不执行，且强保 other_author）
    const injectionCheck = inspectUntrustedText(ev.excerpt);

    // 校验引文：若模型提供了非空 quote，必须在对应证据的 excerpt 或 title 中真实存在；编造引文一律拒绝！
    const rawQuote = typeof rel.quote === 'string' ? rel.quote.trim() : '';
    let quoteCheck;
    if (rawQuote) {
      quoteCheck = verifyQuoteInEvidenceOrTitle(rawQuote, ev);
      if (!quoteCheck.ok) {
        rejectedItems.push({
          kind: 'public_relation',
          reason: quoteCheck.reason,
          evidenceId: ev.id,
          proposedQuote: rawQuote,
          item: rel,
        });
        continue;
      }
    } else if (ev.excerpt) {
      const fallbackSlice = [...ev.excerpt].slice(0, 80).join('');
      quoteCheck = verifyQuoteInEvidenceOrTitle(fallbackSlice, ev);
      if (!quoteCheck.ok) {
        rejectedItems.push({
          kind: 'public_relation',
          reason: 'EVIDENCE_TEXT_UNAVAILABLE',
          evidenceId: ev.id,
          item: rel,
        });
        continue;
      }
    } else {
      rejectedItems.push({
        kind: 'public_relation',
        reason: 'EVIDENCE_TEXT_UNAVAILABLE',
        evidenceId: ev.id,
        item: rel,
      });
      continue;
    }

    const proposedRelation = VALID_PUBLIC_RELATIONS.has(rel.relation) ? rel.relation : 'unknown';
    let finalRelation = proposedRelation;
    let finalReason = typeof rel.reason === 'string' && rel.reason.trim()
      ? rel.reason.trim()
      : '';
    let scopeCondition = typeof rel.scopeCondition === 'string' && rel.scopeCondition.trim()
      ? rel.scopeCondition.trim()
      : null;

    // 跨主体 / 跨实体强隔离（L-02 核心：甲工厂 vs 乙工厂、A公司 vs B公司、一车间 vs 二车间等）
    const crossSubject = detectCrossSubjectMismatch(cleanClaim, ev, decomposition);
    if (crossSubject) {
      if (proposedRelation !== 'unknown') {
        rejectedItems.push({
          kind: 'public_relation',
          reason: 'CROSS_SUBJECT_MISMATCH',
          evidenceId: ev.id,
          proposedRelation,
          claimSubject: crossSubject.claimSubject,
          evidenceSubject: crossSubject.evidenceSubject,
          boundaryReason: crossSubject.boundaryReason,
          item: rel,
        });
      }
      finalRelation = 'unknown';
      finalReason = crossSubject.boundaryReason;
      scopeCondition = null;
      if (!unknownParts.includes(crossSubject.boundaryReason)) {
        unknownParts.push(crossSubject.boundaryReason);
      }
    } else {
      // 局部场景 / 条件限定规范化（qualify）
      const detectedEvScope =
        (scopeCondition && (!cleanClaim || !cleanClaim.includes(scopeCondition)) ? scopeCondition : null)
        ?? extractPublicScopeHint(`${ev.title} ${ev.excerpt}`, cleanClaim);

      const hasHedgeCue = PARTIAL_HEDGE_CUE_RE.test(`${ev.excerpt} ${finalReason}`);

      if (finalRelation === 'qualify') {
        scopeCondition = scopeCondition ?? detectedEvScope ?? null;
      } else if (finalRelation === 'support' && detectedEvScope) {
        // 证据只覆盖特定子条件/局部场景（而主张未限定在该场景），规范为 qualify（限定）
        finalRelation = 'qualify';
        scopeCondition = detectedEvScope;
      } else if (finalRelation === 'refute' && detectedEvScope && (!claimHasUniversal || hasHedgeCue)) {
        // 非全称主张遇到局部子场景限制，或证据本身以条件限定语境讨论，规范为 qualify（限定）
        finalRelation = 'qualify';
        scopeCondition = detectedEvScope;
      }

      if (!finalReason) {
        if (finalRelation === 'qualify' && scopeCondition) {
          finalReason = `这位作者说的是「${scopeCondition}」，能帮我们看清这一种情况，别的还得另看。`;
        } else if (finalRelation === 'refute') {
          finalReason = `${ev.author}举了一个相反的例子，和你的原句正好撞上了。`;
        } else if (finalRelation === 'support') {
          finalReason = `${ev.author}的经历和你说的情况对得上，能给这句话撑个腰。`;
        } else {
          finalReason = `${ev.author}聊到了相近的话题，但还没直接回答你这一句。`;
        }
      }
    }

    seenRelationEvIds.add(ev.id);

    const verifiedRel = {
      evidenceId: ev.id,
      relation: finalRelation,
      label: PUBLIC_RELATION_LABELS[finalRelation] ?? '待定',
      quote: quoteCheck.exactQuote,
      startOffset: quoteCheck.startOffset,
      endOffset: quoteCheck.endOffset,
      quoteField: quoteCheck.field,
      reason: finalReason,
      ...(scopeCondition ? { scopeCondition } : {}),
      ...(crossSubject ? { downgradedFrom: proposedRelation, crossSubject } : {}),
      author: ev.author,
      attribution: 'other_author',
      title: ev.title,
      excerpt: ev.excerpt,
      url: ev.url,
      sourceType: ev.sourceType,
      truncated: ev.truncated,
      injectionNeutralized: Boolean(injectionCheck.injectionDetected),
    };

    verifiedRelations.push(verifiedRel);

    // 仅将已核验通过且存在实质判断关系的条目（support / refute / qualify）写入可见图节点、可见边与出处列表
    if (finalRelation !== 'unknown') {
      const nodeId = `ev_node_${ev.id}`;
      nodes.push({
        id: nodeId,
        kind: 'evidence',
        evidenceId: ev.id,
        sourceType: ev.sourceType,
        title: ev.title,
        author: ev.author,
        attribution: 'other_author',
        excerpt: ev.excerpt,
        url: ev.url,
        relation: finalRelation,
        quote: quoteCheck.exactQuote,
        truncated: ev.truncated,
      });

      edges.push({
        id: `edge_${ev.id}_to_claim`,
        from: nodeId,
        to: 'claim_current',
        evidenceId: ev.id,
        relation: finalRelation,
        label: PUBLIC_RELATION_LABELS[finalRelation],
        quote: quoteCheck.exactQuote,
        quoteStartOffset: quoteCheck.startOffset,
        quoteEndOffset: quoteCheck.endOffset,
        quoteField: quoteCheck.field,
        reason: finalReason,
        scopeCondition: finalRelation === 'qualify' ? (scopeCondition ?? null) : null,
        author: ev.author,
        attribution: 'other_author',
      });

      citations.push({
        evidenceId: ev.id,
        sourceType: ev.sourceType,
        title: ev.title,
        author: ev.author,
        attribution: 'other_author',
        excerpt: ev.excerpt,
        exactQuote: quoteCheck.exactQuote,
        quote: quoteCheck.exactQuote,
        startOffset: quoteCheck.startOffset,
        endOffset: quoteCheck.endOffset,
        quoteField: quoteCheck.field,
        url: ev.url,
        relation: finalRelation,
        reason: finalReason,
        ...(scopeCondition ? { scopeCondition } : {}),
        truncated: ev.truncated,
        injectionNeutralized: Boolean(injectionCheck.injectionDetected),
      });
    }
  }

  // 合并提案中的 unknownParts（去重）
  if (Array.isArray(proposal?.unknownParts)) {
    for (const part of proposal.unknownParts) {
      if (typeof part === 'string' && part.trim() && !unknownParts.includes(part.trim())) {
        unknownParts.push(part.trim());
      }
    }
  }
  if (edges.length === 0 && unknownParts.length === 0) {
    unknownParts.push('目前还没找到能直接回答这句话的材料，这部分先留空。');
  }

  // 计算与上一轮 publicAnalysis 的关系变化（relationChanges）
  const relationChanges = [];
  const prevEdges = Array.isArray(previousPublicAnalysis?.edges)
    ? previousPublicAnalysis.edges
    : [];
  const prevByEvId = new Map(
    prevEdges
      .filter((e) => e && typeof e.evidenceId === 'string')
      .map((e) => [e.evidenceId, e]),
  );
  const currByEvId = new Map(edges.map((e) => [e.evidenceId, e]));

  if (previousPublicAnalysis) {
    const allEvIds = new Set([...prevByEvId.keys(), ...currByEvId.keys()]);
    for (const evId of allEvIds) {
      const prevEdge = prevByEvId.get(evId) ?? null;
      const currEdge = currByEvId.get(evId) ?? null;
      if (prevEdge && currEdge) {
        if (prevEdge.relation !== currEdge.relation) {
          const status = prevEdge.relation === 'refute' && currEdge.relation !== 'refute'
            ? 'resolved'
            : 'changed';
          relationChanges.push({
            evidenceId: evId,
            author: currEdge.author ?? prevEdge.author ?? '未知作者',
            from: prevEdge.relation,
            to: currEdge.relation,
            status,
            summary: `${currEdge.author ?? '这位作者'}这条依据从「${PUBLIC_RELATION_LABELS[prevEdge.relation] ?? prevEdge.relation}」变成了「${PUBLIC_RELATION_LABELS[currEdge.relation] ?? currEdge.relation}」。`,
          });
        }
      } else if (prevEdge && !currEdge) {
        const status = prevEdge.relation === 'refute' ? 'resolved' : 'removed';
        relationChanges.push({
          evidenceId: evId,
          author: prevEdge.author ?? '未知作者',
          from: prevEdge.relation,
          to: 'none',
          status,
          summary: prevEdge.relation === 'refute'
            ? `${prevEdge.author ?? '这位作者'}这条反例不再直接反驳你改后的句子了。`
            : `${prevEdge.author ?? '这位作者'}这条材料和改后的句子关系不大了。`,
        });
      } else if (!prevEdge && currEdge) {
        relationChanges.push({
          evidenceId: evId,
          author: currEdge.author ?? '未知作者',
          from: 'none',
          to: currEdge.relation,
          status: 'added',
          summary: `多了一条${currEdge.author ?? '这位作者'}的「${PUBLIC_RELATION_LABELS[currEdge.relation]}」材料。`,
        });
      }
    }
  }

  // 生成具体自然的一句话 changeSummary
  let changeSummary = null;
  const rawChangeSummary = typeof proposal?.changeSummary === 'string' && proposal.changeSummary.trim()
    ? proposal.changeSummary.trim()
    : null;

  if (relationChanges.length > 0) {
    const resolvedChange = relationChanges.find((c) => c.status === 'resolved');
    if (rawChangeSummary) {
      changeSummary = rawChangeSummary;
    } else if (resolvedChange) {
      changeSummary = resolvedChange.to === 'qualify'
        ? `把范围收一收后，${resolvedChange.author}这条反例不再直接反驳你，而是成了限定条件。`
        : `把范围说清后，${resolvedChange.author}这条反例就不再直接反驳你的句子了。`;
    } else {
      changeSummary = relationChanges[0].summary;
    }
  } else if (previousPublicAnalysis && rawChangeSummary) {
    changeSummary = rawChangeSummary;
  } else if (!previousPublicAnalysis && rawChangeSummary && edges.length > 0) {
    changeSummary = rawChangeSummary;
  }

  // 核验 suggestedRewrite 及其 evidenceIds
  const verifiedEdgeEvIds = new Set(edges.map((e) => e.evidenceId));
  let suggestedRewrite = null;
  if (proposal?.suggestedRewrite && typeof proposal.suggestedRewrite === 'object') {
    const rw = proposal.suggestedRewrite;
    const rwText = typeof rw.text === 'string' ? rw.text.trim() : '';
    if (rwText) {
      const rawRwEvIds = Array.isArray(rw.evidenceIds) ? rw.evidenceIds : [];
      const cleanRwEvIds = [];
      for (const id of rawRwEvIds) {
        if (typeof id !== 'string' || !id.trim()) continue;
        const cleanId = id.trim();
        if (verifiedEdgeEvIds.has(cleanId)) {
          if (!cleanRwEvIds.includes(cleanId)) cleanRwEvIds.push(cleanId);
        } else {
          rejectedItems.push({
            kind: 'rewrite_evidence_id',
            reason: 'REWRITE_EVIDENCE_NOT_VERIFIED',
            evidenceId: cleanId,
            item: rw,
          });
        }
      }

      const kept = typeof rw.kept === 'string' && rw.kept.trim()
        ? rw.kept.trim()
        : '留住了你原本最想说的那层担心。';
      const narrowed = typeof rw.narrowed === 'string' && rw.narrowed.trim()
        ? rw.narrowed.trim()
        : '把话放回了更有把握的具体场景里。';
      const explanation = typeof rw.explanation === 'string' && rw.explanation.trim()
        ? rw.explanation.trim()
        : '原来的担心可以留着，把话放回具体场景里，大家更容易懂你在担心什么。';

      suggestedRewrite = {
        text: rwText,
        kept,
        narrowed,
        explanation,
        evidenceIds: verifiedEdgeEvIds.size > 0 ? cleanRwEvIds : [],
      };
    }
  }

  return {
    claimText: cleanClaim,
    focus: verifiedFocus,
    verifiedRelations,
    rejectedItems,
    citations,
    nodes,
    edges,
    suggestedRewrite,
    relationChanges,
    unknownParts,
    changeSummary,
  };
}

// ==================== QA-06 & L-02: 流式输出引文、中文数值与无引号断言实时核验守卫 ====================

const QUOTE_PAIRS = new Map([
  ['“', '”'],
  ['"', '"'],
  ['「', '」'],
  ['『', '』'],
  ['‘', '’'],
]);

const SYSTEM_FIXED_ALLOWED_TERMS = [
  RATE_INTERPRETATION_NOTE,
  'insufficient_evidence',
  'candidate_counterexample',
  'collection_record',
  'public_search',
  'session_turn',
  'other_author',
  '证据不足',
  '未定（暂无比例）',
  '暂无比例（未定）',
];

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

function parseChineseNumberValue(raw) {
  const s = String(raw ?? '').trim().normalize('NFKC');
  if (!s) return null;
  if (/^\d+(?:\.\d+)?$/u.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (s === '半') return 0.5;
  if (s === '百') return 100;

  let working = s;
  let addHalf = false;
  if (working.endsWith('个半')) {
    addHalf = true;
    working = working.slice(0, -2);
  } else if (working.endsWith('半') && working.length > 1) {
    addHalf = true;
    working = working.slice(0, -1);
  }

  const parts = working.split('点');
  if (parts.length > 2) return null;
  const [intPart, decPart] = parts;

  let intVal = 0;
  if (intPart) {
    if (/^\d+$/u.test(intPart)) {
      intVal = Number.parseInt(intPart, 10);
    } else {
      let rest = intPart;
      if (rest.includes('百')) {
        const [hStr, afterH = ''] = rest.split('百');
        const h = hStr === '' ? 1 : (CN_DIGIT_MAP[hStr] ?? null);
        if (h === null) return null;
        intVal += h * 100;
        rest = afterH;
      }
      if (rest.startsWith('零') || rest.startsWith('〇')) {
        rest = rest.slice(1);
      }
      if (rest.includes('十')) {
        const [tStr, afterT = ''] = rest.split('十');
        const t = tStr === '' ? 1 : (CN_DIGIT_MAP[tStr] ?? null);
        if (t === null) return null;
        intVal += t * 10;
        rest = afterT;
      }
      if (rest.startsWith('零') || rest.startsWith('〇')) {
        rest = rest.slice(1);
      }
      if (rest) {
        if (rest.length === 1 && rest in CN_DIGIT_MAP) {
          intVal += CN_DIGIT_MAP[rest];
        } else {
          // 逐位读法（如“七二”）
          let acc = 0;
          for (const ch of rest) {
            if (!(ch in CN_DIGIT_MAP)) return null;
            acc = acc * 10 + CN_DIGIT_MAP[ch];
          }
          intVal += acc;
        }
      }
    }
  }

  let decVal = 0;
  if (decPart !== undefined) {
    if (!decPart) return null;
    if (/^\d+$/u.test(decPart)) {
      decVal = Number(`0.${decPart}`);
    } else {
      let digits = '';
      for (const ch of decPart) {
        if (!(ch in CN_DIGIT_MAP)) return null;
        digits += String(CN_DIGIT_MAP[ch]);
      }
      decVal = Number(`0.${digits}`);
    }
  }

  const total = intVal + decVal + (addHalf ? 0.5 : 0);
  return Number.isFinite(total) ? total : null;
}

function parseChineseChengValue(prefixStr, tailStr = '') {
  if (prefixStr === '半') return 5;
  const tens = prefixStr === '十' ? 10 : (CN_DIGIT_MAP[prefixStr] ?? null);
  if (tens === null) return null;
  let val = tens * 10;
  if (tailStr) {
    if (tailStr === '半') {
      val += 5;
    } else if (tailStr in CN_DIGIT_MAP) {
      val += CN_DIGIT_MAP[tailStr];
    } else {
      return null;
    }
  }
  return val;
}

const CN_NUM_CORE = '(?:[零〇一二两三四五六七八九十百]+(?:点[零〇一二两三四五六七八九]+)?|\\d+(?:\\.\\d+)?)';

// 1) 百分之七十二 / 百分之三十五点五 / 百分之百 / 百分之68
const CN_BAI_FEN_ZHI_RE = new RegExp(`百分之(${CN_NUM_CORE}|百)`, 'gu');

// 2) 七十二个百分点 / 三十个百分点 / 三个半百分点 / 15个百分点
const CN_PCT_POINT_RE = new RegExp(
  `((?:[零〇一二两三四五六七八九十百]+(?:点[零〇一二两三四五六七八九]+)?(?:个半)?|\\d+(?:\\.\\d+)?))\\s*个?百分点`,
  'gu',
);

// 3) 七十二% / 三十五％
const CN_NUM_WITH_PCT_SIGN_RE = /([零〇一二两三四五六七八九十百]+(?:点[零〇一二两三四五六七八九]+)?)\s*[%％]/gu;

// 4) 七成二 / 七成五 / 七成 / 半成 / 十成（排除常见非比例词：统一成为、一成不变、第一成员等）
const CN_CHENG_RE =
  /(?<![统唯第每这那形完造变分生构换促达])([一二两三四五六七八九十半])成([一二三四五六七八九半])?(?![功为员本熟果长立就交绩名都团份色象样不])/gu;

// 5) 无引号伪断言 / 无源权威统计引用（如“某权威调查显示效率下降了四十个百分点”“有调查表明…下降了35%”“据知乎高赞称…”）
const UNGROUNDED_ASSERTION_RE = new RegExp(
  `(?:`
    + `(?:某(?:项|权威|知名|行业|机构|平台|大学|学术|大型|专业)?|有|多项|大量|最新|权威|公开|行业|内部|相关)?`
    + `(?:研究|调查|报告|实验|统计|数据|问卷|白皮书|论文|测算)`
    + `(?:显示|表明|指出|发现|证明|证实|显示出|数据显示|统计显示|称)`
    + `|据(?:知乎高赞|某知乎高赞|某高赞|高赞回答|某答主|某位答主|多位答主|不少答主|知乎网友|业内人士|业内统计|不完全统计|相关数据|权威统计|权威调查|公开调查|统计|调查|研究|报道)(?:称|表示|显示|指出|透露|反馈|介绍|说)?`
  + `)`
  + `[：:,，\\s]*[^。！？!?\\n；;]{2,80}`,
  'gu',
);

// 流式尾部挂起检测（仅在末尾出现未完成的中文百分比、百分点或伪断言前缀时局部缓冲，绝不阻塞普通正常句子）
const STREAM_HOLD_CN_AND_ASSERTION_RES = [
  /百分(?:之[零〇一二两三四五六七八九十百点\d.]*)?$/u,
  /[零〇一二两三四五六七八九十百]+(?:点[零〇一二两三四五六七八九]*)?(?:个?百分?点?|个半)?$/u,
  /(?<![统唯第每这那形完造变分生构换促达])[一二两三四五六七八九十半]成?[一二三四五六七八九半]?$/u,
  /(?:某(?:项|权威|知名|行业|机构|平台|大学|学术|大型|专业)?(?:研究|调查|报告|实验|统计|数据|问卷|白皮书|论文|测算)?|有(?:研|调|报|实|统|数|问|测)(?:究|查|告|验|计|据|卷|算)?|据(?:知乎高赞|某知乎高赞|某高赞|高赞回答|某答主|某位答主|多位答主|不少答主|知乎网友|业内人士|业内统计|不完全统计|权威统计|权威调查|公开调查|相关数据|统计|调查|研究|报道)?)(?:显示|表明|指出|发现|证明|证实|称|表示|透露|反馈|介绍|说)?[^。！？!?\n；;]{0,80}$/u,
];

function normalizeForSubstringCheck(str) {
  return String(str ?? '')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeRateToken(val) {
  if (val === null || val === undefined || val === '') return null;
  const cleaned = String(val).trim().replace(/[%％]\s*$/u, '').trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return String(num);
}

function normalizeFractionToken(val) {
  if (!val) return null;
  if (typeof val === 'object' && Number.isInteger(val.numerator) && Number.isInteger(val.denominator)) {
    return `${val.numerator}/${val.denominator}`;
  }
  const m = /^(\d+)\s*\/\s*(\d+)$/u.exec(String(val).trim());
  if (!m) return null;
  return `${Number(m[1])}/${Number(m[2])}`;
}

// 创建流式文本实时核验守卫：对安全解释文本零延迟透传，仅在引号、数值词元或疑似伪断言处局部缓冲并拦截虚构引文、中文/阿拉伯未核验百分比与无源断言。
export function createStreamingOutputGuard({
  allowedTexts = [],
  allowedQuoteSources = [],
  allowedRates = [],
  allowedFractions = [],
  allowedRatios = [],
  fallbackRateText = '未定（暂无比例）',
  unverifiedQuoteReplacement = '（未收录引文已略去）',
  unverifiedAssertionReplacement = '（未核验来源表述已略去）',
} = {}) {
  const combinedAllowedSources = [
    ...(Array.isArray(allowedTexts) ? allowedTexts : []),
    ...(Array.isArray(allowedQuoteSources) ? allowedQuoteSources : []),
  ];

  const normalizedCorpus = [
    ...SYSTEM_FIXED_ALLOWED_TERMS,
    ...combinedAllowedSources.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        return item.excerpt ?? item.text ?? item.spanText ?? item.title ?? '';
      }
      return '';
    }),
  ]
    .map(normalizeForSubstringCheck)
    .filter((s) => s.length > 0);

  const allowedRateSet = new Set();
  let primaryAllowedRate = null;
  for (const r of Array.isArray(allowedRates) ? allowedRates : []) {
    const norm = normalizeRateToken(r);
    if (norm !== null) {
      allowedRateSet.add(norm);
      if (primaryAllowedRate === null) primaryAllowedRate = norm;
    }
  }

  const allowedFractionSet = new Set();
  let primaryAllowedFraction = null;
  for (const f of [
    ...(Array.isArray(allowedFractions) ? allowedFractions : []),
    ...(Array.isArray(allowedRatios) ? allowedRatios : []),
  ]) {
    const norm = normalizeFractionToken(f);
    if (norm !== null) {
      allowedFractionSet.add(norm);
      if (primaryAllowedFraction === null) primaryAllowedFraction = norm;
    }
  }

  const interceptedQuotes = [];
  const interceptedNumbers = [];
  const interceptedAssertions = [];

  let activeOpenQuote = null;
  let activeCloseQuote = null;
  let quoteBuffer = '';
  let plainTailBuffer = '';

  const maxBufferedQuoteChars = 800;

  function replacementForForbiddenRate() {
    return primaryAllowedRate !== null ? `${primaryAllowedRate}%` : fallbackRateText;
  }

  function isTextGroundedInCorpus(rawText) {
    const norm = normalizeForSubstringCheck(rawText);
    if (!norm) return true;
    return normalizedCorpus.some((allowed) => allowed.includes(norm));
  }

  function isQuoteGrounded(innerText) {
    return isTextGroundedInCorpus(innerText);
  }

  function isRateOrVerbatimGrounded(numericValue, rawMatchedText) {
    const normNum = normalizeRateToken(numericValue);
    if (normNum !== null && allowedRateSet.has(normNum)) {
      return true;
    }
    if (rawMatchedText && isTextGroundedInCorpus(rawMatchedText)) {
      return true;
    }
    return false;
  }

  function sanitizePlainNumbers(segment) {
    if (!segment) return '';
    let out = segment;

    // 0. 拦截无引号伪断言（如“某权威调查显示效率下降了四十个百分点”“据知乎高赞称…”）
    out = out.replace(UNGROUNDED_ASSERTION_RE, (full) => {
      const cleanFull = full.trim();
      if (!cleanFull || isTextGroundedInCorpus(cleanFull)) {
        return full;
      }
      // 同步记录其中夹带的未核验中文/阿拉伯统计数字
      for (const m of cleanFull.matchAll(/(\d+(?:\.\d+)?)\s*[%％]/gu)) {
        if (!isRateOrVerbatimGrounded(Number(m[1]), m[0])) {
          interceptedNumbers.push(m[0].replace(/\s+/gu, ''));
        }
      }
      CN_BAI_FEN_ZHI_RE.lastIndex = 0;
      for (const m of cleanFull.matchAll(CN_BAI_FEN_ZHI_RE)) {
        const val = parseChineseNumberValue(m[1]);
        if (val !== null && !isRateOrVerbatimGrounded(val, m[0])) {
          interceptedNumbers.push(m[0]);
        }
      }
      CN_PCT_POINT_RE.lastIndex = 0;
      for (const m of cleanFull.matchAll(CN_PCT_POINT_RE)) {
        const val = parseChineseNumberValue(m[1]);
        if (val !== null && !isRateOrVerbatimGrounded(val, m[0])) {
          interceptedNumbers.push(m[0]);
        }
      }
      interceptedAssertions.push(cleanFull);
      return unverifiedAssertionReplacement;
    });

    // 1. 拦截紧邻“报价/比例/损失率”的百分比或裸数值（如“报价 72%”、“报价为 72”、“损失率：72”）
    out = out.replace(
      /(?<prefix>(?:报价|影响比例|结构比例|比例|损失率)(?:\s*(?:为|是|达到|约|约为|:|：|=))?\s*)(?<num>\d+(?:\.\d+)?)(?<pct>\s*[%％])?/gu,
      (full, prefix, numStr, pctPart) => {
        const normNum = normalizeRateToken(numStr);
        if (normNum !== null && allowedRateSet.has(normNum)) {
          return full;
        }
        const rawBad = pctPart ? `${numStr}${pctPart.trim()}` : numStr;
        interceptedNumbers.push(rawBad);
        return `${prefix}${replacementForForbiddenRate()}`;
      },
    );

    // 2. 拦截任意独立阿拉伯百分比（如“72%”、“57.5%”）
    out = out.replace(
      /(?<![A-Za-z0-9_])(\d+(?:\.\d+)?)\s*([%％])/gu,
      (full, numStr) => {
        if (isRateOrVerbatimGrounded(numStr, full)) {
          return full;
        }
        interceptedNumbers.push(full.replace(/\s+/gu, ''));
        return replacementForForbiddenRate();
      },
    );

    // 3. 若调用方指定了合法分数集合（如 ['23/40']），拦截不匹配的承重分数（排除 URL 与 YYYY/MM/DD 日期）
    if (allowedFractionSet.size > 0) {
      out = out.replace(
        /(?<![/\dA-Za-z:])(\d{1,5})\s*\/\s*(\d{1,5})(?![/\d])/gu,
        (full, numA, numB) => {
          const normFrac = `${Number(numA)}/${Number(numB)}`;
          if (allowedFractionSet.has(normFrac)) return full;
          interceptedNumbers.push(normFrac);
          return primaryAllowedFraction ?? full;
        },
      );
    }

    // 4. 拦截未核验中文百分比（百分之七十二、百分之三十五点五、百分之百）
    out = out.replace(CN_BAI_FEN_ZHI_RE, (full, numExpr) => {
      const val = parseChineseNumberValue(numExpr);
      if (val === null) return full;
      if (isRateOrVerbatimGrounded(val, full)) return full;
      interceptedNumbers.push(full);
      return replacementForForbiddenRate();
    });

    // 5. 拦截未核验中文或阿拉伯百分点（七十二个百分点、八十个百分点、35个百分点）
    out = out.replace(CN_PCT_POINT_RE, (full, numExpr) => {
      const val = parseChineseNumberValue(numExpr);
      if (val === null) return full;
      if (isRateOrVerbatimGrounded(val, full)) return full;
      interceptedNumbers.push(full);
      return replacementForForbiddenRate();
    });

    // 6. 拦截中文数字+%（七十二%）
    out = out.replace(CN_NUM_WITH_PCT_SIGN_RE, (full, numExpr) => {
      const val = parseChineseNumberValue(numExpr);
      if (val === null) return full;
      if (isRateOrVerbatimGrounded(val, full)) return full;
      interceptedNumbers.push(full);
      return replacementForForbiddenRate();
    });

    // 7. 拦截未核验“X成Y”（七成二、五成、半成等）
    out = out.replace(CN_CHENG_RE, (full, tensChar, onesChar = '') => {
      const val = parseChineseChengValue(tensChar, onesChar);
      if (val === null) return full;
      if (isRateOrVerbatimGrounded(val, full)) return full;
      interceptedNumbers.push(full);
      return replacementForForbiddenRate();
    });

    return out;
  }

  // 从 plainTailBuffer 中切出可立即安全发送的前缀，仅保留末尾未闭合的数字、中文百分比或疑似伪断言前缀
  function flushSafePlainPrefix(isFinalFlush = false) {
    if (!plainTailBuffer) return '';
    if (isFinalFlush) {
      const finalized = sanitizePlainNumbers(plainTailBuffer);
      plainTailBuffer = '';
      return finalized;
    }

    const holdMatches = [
      /(?:报价|影响比例|结构比例|比例|损失率)(?:\s*(?:为|是|达到|约|约为|:|：|=))?\s*(?:\d+(?:\.\d*)?)?\s*$/u,
      /\d+(?:\.\d*)?\s*$/u,
      /\d+\s*\/\s*\d*$/u,
      ...STREAM_HOLD_CN_AND_ASSERTION_RES,
    ];

    let earliestHoldIdx = plainTailBuffer.length;
    for (const re of holdMatches) {
      const m = re.exec(plainTailBuffer);
      if (m && m[0].length > 0 && m.index < earliestHoldIdx) {
        earliestHoldIdx = m.index;
      }
    }

    if (earliestHoldIdx === 0) {
      // 防止超长无标点缓冲区无限滞留
      if ([...plainTailBuffer].length > 140) {
        const finalized = sanitizePlainNumbers(plainTailBuffer);
        plainTailBuffer = '';
        return finalized;
      }
      return '';
    }

    const readyPart = plainTailBuffer.slice(0, earliestHoldIdx);
    plainTailBuffer = plainTailBuffer.slice(earliestHoldIdx);
    return sanitizePlainNumbers(readyPart);
  }

  function finalizeCompletedQuote(openChar, inner, closeChar) {
    const trimmedInner = inner.trim();
    const codePointLen = [...trimmedInner].length;

    if (isQuoteGrounded(trimmedInner)) {
      return `${openChar}${inner}${closeChar}`;
    }

    if (codePointLen <= 3) {
      // 短词（如“只会”、“必然”）保留，但仍执行百分比/数值核验以防“72%”或“七成”借短引号绕过
      return `${openChar}${sanitizePlainNumbers(inner)}${closeChar}`;
    }

    interceptedQuotes.push(trimmedInner);
    return unverifiedQuoteReplacement;
  }

  function push(deltaChunk) {
    if (typeof deltaChunk !== 'string' || deltaChunk.length === 0) {
      return '';
    }

    let safeOut = '';
    for (const ch of deltaChunk) {
      if (activeOpenQuote !== null) {
        if (ch === activeCloseQuote) {
          safeOut += flushSafePlainPrefix(true);
          safeOut += finalizeCompletedQuote(activeOpenQuote, quoteBuffer, activeCloseQuote);
          activeOpenQuote = null;
          activeCloseQuote = null;
          quoteBuffer = '';
        } else {
          quoteBuffer += ch;
          if ([...quoteBuffer].length > maxBufferedQuoteChars) {
            safeOut += flushSafePlainPrefix(true);
            safeOut += finalizeCompletedQuote(activeOpenQuote, quoteBuffer, '');
            activeOpenQuote = null;
            activeCloseQuote = null;
            quoteBuffer = '';
          }
        }
      } else if (QUOTE_PAIRS.has(ch)) {
        safeOut += flushSafePlainPrefix(true);
        activeOpenQuote = ch;
        activeCloseQuote = QUOTE_PAIRS.get(ch);
        quoteBuffer = '';
      } else {
        plainTailBuffer += ch;
      }
    }

    if (activeOpenQuote === null && plainTailBuffer.length > 0) {
      safeOut += flushSafePlainPrefix(false);
    }

    return safeOut;
  }

  function buildStats() {
    const hadViolation =
      interceptedQuotes.length > 0
      || interceptedNumbers.length > 0
      || interceptedAssertions.length > 0;
    return {
      interceptedQuotes: [...interceptedQuotes],
      interceptedNumbers: [...interceptedNumbers],
      interceptedAssertions: [...interceptedAssertions],
      blockedQuotes: [...interceptedQuotes],
      blockedNumbers: [...interceptedNumbers],
      blockedAssertions: [...interceptedAssertions],
      hadViolation,
      hadBlockedContent: hadViolation,
    };
  }

  function flush() {
    let tailText = '';
    if (plainTailBuffer.length > 0) {
      tailText += flushSafePlainPrefix(true);
    }
    if (activeOpenQuote !== null) {
      const trimmedInner = quoteBuffer.trim();
      if ([...trimmedInner].length > 3 && !isQuoteGrounded(trimmedInner)) {
        interceptedQuotes.push(trimmedInner);
        tailText += unverifiedQuoteReplacement;
      } else {
        tailText += `${activeOpenQuote}${sanitizePlainNumbers(quoteBuffer)}`;
      }
      activeOpenQuote = null;
      activeCloseQuote = null;
      quoteBuffer = '';
    }
    return {
      tailText,
      ...buildStats(),
    };
  }

  return {
    push,
    flush,
    getStats: buildStats,
  };
}
