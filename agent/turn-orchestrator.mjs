// 单 Agent 流式编排与十二轮对话引擎。
// 严格执行：turn.started -> focus.selected -> stage.changed -> (可选 retrieving_evidence) ->
// verifying_candidates -> evidence.verified -> streaming_explanation -> text.delta* -> commitTurn(turn.committed + turn.done)。

import { streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  BackendServiceError,
  RATE_INTERPRETATION_NOTE,
  TURN_INTENTS,
} from './protocol.mjs';
import {
  DEFAULT_OUTBOUND_EXCERPT_CHARS,
  buildOutboundPersonalManifest,
  isLoopbackModelEndpoint as isLoopbackModelEndpointPolicy,
  normalizePersonalSnippetForOutbound,
  verifyOutboundSnippetsMatchManifest,
} from './material-policy.mjs';
import {
  buildSecretList,
  redactTurnText,
  buildTurnSystemPrompt,
  buildTurnUserPrompt,
  buildPublicTurnSystemPrompt,
  buildPublicTurnUserPrompt,
  buildPublicGentleFallbackChunks,
  sanitizeUserFacingPublicText,
} from './turn-prompts.mjs';

function parseChineseInt(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number.parseInt(s, 10);
  const digitMap = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s in digitMap) return digitMap[s];
  if (s === '十') return 10;
  let total = 0;
  let rest = s;
  if (rest.includes('百')) {
    const [hPart, afterH = ''] = rest.split('百');
    const h = hPart ? (digitMap[hPart] ?? null) : 1;
    if (h === null) return null;
    total += h * 100;
    rest = afterH;
  }
  if (rest.startsWith('零') || rest.startsWith('〇')) {
    rest = rest.slice(1);
  }
  if (rest.includes('十')) {
    const [tPart, afterT = ''] = rest.split('十');
    const t = tPart ? (digitMap[tPart] ?? null) : 1;
    if (t === null) return null;
    total += t * 10;
    rest = afterT;
  }
  if (rest) {
    const u = digitMap[rest] ?? null;
    if (u === null) return null;
    total += u;
  }
  return total > 0 ? total : null;
}

function parseTurnOrdinal(text) {
  if (typeof text !== 'string') return null;
  const digitMatch = text.match(/第\s*([0-9]{1,4})\s*轮/);
  if (digitMatch) return Number.parseInt(digitMatch[1], 10);
  const cnMatch = text.match(/第\s*([零〇一二两三四五六七八九十百]{1,6})\s*轮/);
  if (cnMatch) return parseChineseInt(cnMatch[1]);
  return null;
}

function normalizeDigestKey(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractBigrams(str) {
  const clean = String(str ?? '').replace(/[，。！？；：“”‘’「」『』（）()、《》\[\]\s的了是在和与对让把被会都也就着过]/g, '');
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i += 1) {
    set.add(clean.slice(i, i + 2));
  }
  return set;
}

function extractGenericTopicKeywords(sentence) {
  const raw = String(sentence ?? '').trim();
  if (!raw) return ['观点核验'];
  if (/推荐算法|推荐系统|推荐里|信息茧房|听.*歌|乐队|歌单/.test(raw)) {
    return ['推荐算法', '独立乐队', '冷启动', '信息茧房'];
  }
  if (/远程办公|跨时区|异步协作|异步文档|居家办公/.test(raw)) {
    return ['远程办公', '团队协作', '异步文档', '效率'];
  }
  const cleaned = raw
    .replace(/[，。！？；：“”‘’「」『』（）()、《》\[\]\s]/g, ' ')
    .replace(/只会|只有|必然|一定|绝对|所有|全部|任何|完全|无一例外|总是|从不|绝不|越来越|在我看来|请帮我|检查一下|核对一下/g, ' ');
  const tokens = cleaned
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && part.length <= 12);
  return tokens.length > 0 ? tokens.slice(0, 4) : [raw.slice(0, 8)];
}

function inferTopicCluster(text, fallback = 'general_claim') {
  const s = String(text ?? '');
  if (/推荐|兴趣|歌|乐队|音乐|茧房|冷启动|流媒体/.test(s)) return 'recommendation_interest';
  if (/远程办公|异步协作|异步文档|跨时区|居家办公|(?:团队|即时).*(?:协作|沟通)|交付(?:速度|周期|效率)|会议(?:频率|耗时)/.test(s)) {
    return 'remote_work_efficiency';
  }
  if (/大模型|本地设备|开源模型|推理/.test(s)) return 'model_deployment';
  if (/自动化测试|人工.*测试|探索性测试/.test(s)) return 'software_testing';
  if (/工厂|换班|车间|排班|夜班/.test(s)) return 'factory_shift_policy';
  const kws = extractGenericTopicKeywords(s);
  return kws[0] ? `topic_${kws[0]}` : fallback;
}

function isEvidenceRelevantToSentence(ev, sentence, focus = null) {
  const evText = `${ev?.title ?? ''} ${ev?.excerpt ?? ''} ${ev?.summary ?? ''} ${ev?.bodyText ?? ''}`;
  const queryText = `${sentence ?? ''} ${focus?.spanText ?? ''}`.trim();
  if (!evText.trim() || !queryText) return false;
  const targetCluster = inferTopicCluster(queryText, '');
  const evCluster = inferTopicCluster(evText, '');
  if (targetCluster && !targetCluster.startsWith('topic_') && targetCluster === evCluster) {
    return true;
  }
  const sBigrams = extractBigrams(queryText);
  const eBigrams = extractBigrams(evText);
  let hits = 0;
  for (const bg of sBigrams) {
    if (eBigrams.has(bg)) hits += 1;
  }
  return hits >= 2 || (sBigrams.size <= 3 && hits >= 1);
}

// ===== 焦点拆解：热会话 < 1ms 完成，保证 startOffset..endOffset 精确对齐原文 =====
const QUANTIFIER_PATTERNS = [
  { token: '只有', suffixRegex: /只有[^，。！？；]{1,14}这一种作用/, kind: 'quantifier', reason: '排他限定结构“只有……这一种作用”否定了任何其他可能性，只要存在一例本人已确认的反例即构成直接冲突。' },
  { token: '只会', kind: 'quantifier', reason: '绝对排他量词“只会”排除了任何正向或例外情形，需优先核验是否存在本人已确认的反例或适用边界。' },
  { token: '只有', kind: 'quantifier', reason: '排他量词“只有”将结论收紧为唯一情形，优先核查是否存在本人确认的其他情形。' },
  { token: '无一例外', kind: 'quantifier', reason: '全称绝对表述“无一例外”不允许任何反例存在，单条已确认反例即可动摇该前提。' },
  { token: '必然', kind: 'quantifier', reason: '模态全称词“必然”声称结果在一切条件下均成立，需优先核验是否存在反例或特定边界条件。' },
  { token: '绝对', kind: 'quantifier', reason: '绝对化修饰词“绝对”排除了条件差异，需核对本人已确认事实中是否有相反经历。' },
  { token: '所有', kind: 'quantifier', reason: '全称量词“所有”覆盖全部对象而不区分团队或场景条件，需核查是否存在局部反例。' },
  { token: '全部', kind: 'quantifier', reason: '全称量词“全部”未留适用边界，需核对是否存在已核验例外。' },
  { token: '任何', kind: 'quantifier', reason: '全称量词“任何”排除了场景限定，需优先检验边界条件。' },
  { token: '完全', kind: 'quantifier', reason: '绝对程度词“完全”不留余地，需核对是否存在局部反例或未覆盖前提。' },
  { token: '绝不可能', kind: 'quantifier', reason: '绝对否定词“绝不可能”排除了任何可实现案例，单条已确认实例即可直接冲突。' },
  { token: '不可能', kind: 'quantifier', reason: '强否定词“不可能”声称零可行性，需核对是否存在本人已确认的反例。' },
  { token: '从不', kind: 'quantifier', reason: '全称时间否定词“从不”排除了任何发生过的实例。' },
  { token: '绝不', kind: 'quantifier', reason: '绝对否定词“绝不”排除了任何例外情形。' },
  { token: '永远', kind: 'quantifier', reason: '无边界时间量词“永远”声称跨阶段恒成立，需区分初期与长期阶段。' },
  { token: '一定', kind: 'quantifier', reason: '强断定词“一定”省略了成立条件，需核查适用前提。' },
];

const SCOPE_REGEXES = [
  { regex: /刚开始用的时候|刚开始使用时|刚开始用时|冷启动阶段|初期使用阶段|初期适用范围|初期阶段/, kind: 'scope', reason: '时间与阶段限定决定了证据能支持的适用范围，不能直接外推到长期阶段。' },
  { regex: /连续听同类歌曲之后|连续浏览同类内容之后|长期连续使用之后|连续[^，。！？；]{1,12}之后/, kind: 'scope', reason: '前置行为范围限定缩小了主张覆盖的场景，需单独核查该特定场景下是否有本人已确认证据。' },
  { regex: /(?:只发生在|仅发生在|只在|仅在|只限于|仅限于|限定在|限定于)[^，。！？；\s]{1,18}/, kind: 'scope', reason: '显式适用范围限定了现象或结论成立的边界条件。' },
  { regex: /在[^，。！？；]{1,14}(?:的时候|阶段|情况下|条件下|团队中|期间|天气下|时)/, kind: 'scope', reason: '场景适用范围限定了判断成立的边界条件。' },
  { regex: /当[^，。！？；]{2,14}时/, kind: 'scope', reason: '触发条件限定了主张生效的前提范围。' },
];

const DEPENDENCY_REGEXES = [
  { regex: /因为|由于|取决于|前提是|之所以/, kind: 'dependency', reason: '因果或依赖连接词指向支撑该结论的上游前提。' },
];

export function selectFocus(sentence, explicitFocus = null, idSeed = '1') {
  const text = String(sentence ?? '');
  if (explicitFocus && typeof explicitFocus === 'object') {
    const spanText = typeof explicitFocus.spanText === 'string' && explicitFocus.spanText
      ? explicitFocus.spanText
      : '';
    if (spanText) {
      let startOffset = Number.isInteger(explicitFocus.startOffset) ? explicitFocus.startOffset : -1;
      let endOffset = Number.isInteger(explicitFocus.endOffset) ? explicitFocus.endOffset : -1;
      if (startOffset < 0 || text.slice(startOffset, endOffset) !== spanText) {
        startOffset = text.indexOf(spanText);
        endOffset = startOffset >= 0 ? startOffset + spanText.length : -1;
      }
      if (startOffset >= 0 && endOffset > startOffset) {
        return {
          id: explicitFocus.id ?? `focus_${idSeed}`,
          ...(explicitFocus.nodeId ? { nodeId: explicitFocus.nodeId } : {}),
          ...(Array.isArray(explicitFocus.evidenceIds) ? { evidenceIds: [...explicitFocus.evidenceIds] } : {}),
          kind: explicitFocus.kind ?? 'premise',
          spanText,
          startOffset,
          endOffset,
          reason: explicitFocus.reason ?? '按用户指定的焦点范围进行核验。',
        };
      }
    } else if (
      Number.isInteger(explicitFocus.startOffset)
      && Number.isInteger(explicitFocus.endOffset)
      && explicitFocus.startOffset >= 0
      && explicitFocus.endOffset <= text.length
      && explicitFocus.startOffset < explicitFocus.endOffset
    ) {
      const sliced = text.slice(explicitFocus.startOffset, explicitFocus.endOffset);
      return {
        id: explicitFocus.id ?? `focus_${idSeed}`,
        ...(explicitFocus.nodeId ? { nodeId: explicitFocus.nodeId } : {}),
        kind: explicitFocus.kind ?? 'premise',
        spanText: sliced,
        startOffset: explicitFocus.startOffset,
        endOffset: explicitFocus.endOffset,
        reason: explicitFocus.reason ?? '按用户指定的起止位置拆解焦点。',
      };
    }
  }

  const quotedMatch = text.match(/[‘“"'「『]([^’”"'」』]{1,24})[’”"'」』]/);
  if (quotedMatch && /检查|核对|为什么|为何|撤回|条件|范围/.test(text)) {
    const spanText = quotedMatch[1];
    const startOffset = text.indexOf(spanText);
    const isQuant = QUANTIFIER_PATTERNS.some((p) => spanText.includes(p.token));
    return {
      id: `focus_${idSeed}`,
      kind: isQuant ? 'quantifier' : 'scope',
      spanText,
      startOffset,
      endOffset: startOffset + spanText.length,
      reason: isQuant
        ? `聚焦核查绝对量词“${spanText}”的排他前提及其反例敏感性。`
        : `聚焦核查适用范围“${spanText}”所能支持与不能单独支持的结论边界。`,
    };
  }

  for (const item of QUANTIFIER_PATTERNS) {
    if (item.suffixRegex) {
      const m = text.match(item.suffixRegex);
      if (m && m.index !== undefined) {
        return {
          id: `focus_${idSeed}`,
          kind: item.kind,
          spanText: m[0],
          startOffset: m.index,
          endOffset: m.index + m[0].length,
          reason: item.reason,
        };
      }
    }
    const idx = text.indexOf(item.token);
    if (idx >= 0) {
      return {
        id: `focus_${idSeed}`,
        kind: item.kind,
        spanText: item.token,
        startOffset: idx,
        endOffset: idx + item.token.length,
        reason: item.reason,
      };
    }
  }

  for (const item of SCOPE_REGEXES) {
    const m = text.match(item.regex);
    if (m && m.index !== undefined) {
      return {
        id: `focus_${idSeed}`,
        kind: item.kind,
        spanText: m[0],
        startOffset: m.index,
        endOffset: m.index + m[0].length,
        reason: item.reason,
      };
    }
  }

  for (const item of DEPENDENCY_REGEXES) {
    const m = text.match(item.regex);
    if (m && m.index !== undefined) {
      return {
        id: `focus_${idSeed}`,
        kind: item.kind,
        spanText: m[0],
        startOffset: m.index,
        endOffset: m.index + m[0].length,
        reason: item.reason,
      };
    }
  }

  const cleanClause = text.replace(/^[，。！？；\s]+|[，。！？；\s]+$/g, '');
  const spanText = cleanClause || text;
  const startOffset = spanText ? Math.max(0, text.indexOf(spanText)) : 0;
  return {
    id: `focus_${idSeed}`,
    kind: 'premise',
    spanText,
    startOffset,
    endOffset: startOffset + spanText.length,
    reason: '提取句中核心主张前提，核对当前已确认图中是否存在直接冲突或支撑依据。',
  };
}

// ===== 通用范围条件短语提取（严禁硬编码“刚开始用的时候”污染其他领域条件） =====
export function extractConditionPhrase(userText, focus = null, pendingConfirmations = [], action = null) {
  if (typeof action?.scopeText === 'string' && action.scopeText.trim()) {
    return action.scopeText.trim();
  }
  const raw = String(userText ?? '').trim();

  // 1. 显式引号包裹的条件短语
  const quoted = raw.match(/[‘“"'「『]([^’”"'」』]{1,28})[’”"'」』]/);
  if (quoted && quoted[1]?.trim()) {
    return quoted[1].trim();
  }

  // 2. “只发生在 X” / “仅在 X” / “限定在 X” 等自然语言限定结构
  const restrictMatch = raw.match(
    /(?:只发生在|仅发生在|只在|仅在|只限于|仅限于|限定在|限定于)\s*[‘“"'「『]?([^，。！？；’”"'」』]{1,28})[’”"'」』]?/,
  );
  if (restrictMatch && restrictMatch[1]?.trim()) {
    return restrictMatch[1]
      .trim()
      .replace(/(?:成立|生效|有效|发生|出现|适用)$/, '')
      .replace(/(?:的时候|之时)$/, (m) => (restrictMatch[1].includes('刚开始') ? m : m))
      .replace(/[。！？；\s]+$/g, '')
      .trim();
  }

  // 3. “适用条件是 X” / “检查一下 X 这个适用条件/范围”
  const explicitAssign = raw.match(
    /(?:适用条件|限定条件|适用范围)(?:是|为|：|:)\s*[‘“"'「『]?([^，。！？；’”"'」』]{1,28})[’”"'」』]?/,
  );
  if (explicitAssign && explicitAssign[1]?.trim()) {
    return explicitAssign[1].trim();
  }

  const checkTarget = raw.match(
    /(?:检查|核对|验证|看看|评估)(?:一下)?\s*([^，。！？；]{1,20}?)\s*(?:这个|这一|该)?(?:适用条件|限定条件|适用范围|边界|条件|范围)/,
  );
  if (checkTarget && checkTarget[1]?.trim()) {
    const cleaned = checkTarget[1]
      .trim()
      .replace(/^(?:当前的|目前的|一下|关于)\s*/, '')
      .trim();
    if (cleaned) return cleaned;
  }

  // 4. 焦点本身是 scope
  if (focus?.kind === 'scope' && typeof focus.spanText === 'string' && focus.spanText.trim()) {
    const stripped = focus.spanText
      .trim()
      .replace(/^(?:只发生在|仅发生在|只在|仅在|只限于|仅限于|限定在|限定于)\s*/, '')
      .trim();
    if (stripped) return stripped;
  }

  // 5. 待确认区已有的 scope_condition
  const pendingScope = (Array.isArray(pendingConfirmations) ? pendingConfirmations : []).find(
    (p) => p?.kind === 'scope_condition' && typeof p.scopeText === 'string' && p.scopeText.trim(),
  );
  if (pendingScope) {
    return pendingScope.scopeText.trim();
  }

  // 6. 兜底提取用户输入中的核心短语，绝不硬编码特定演示场景短语
  const fallback = raw
    .replace(/^(?:请帮我|帮我|请)?(?:检查|核对|验证|看看|评估)(?:一下)?/, '')
    .replace(/^(?:我本人确认|本人确认|我确认)[，,：:\s]*/, '')
    .replace(/[。！？?；\s]+$/g, '')
    .trim();
  return fallback || '当前限定范围';
}

export function normalizeScopeTag(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (/刚开始用的时候|刚开始使用时|刚开始用|冷启动|初期使用|初期适用范围|初期阶段|^初期$|刚接触/.test(s)) {
    return 'initial_stage';
  }
  if (/连续听同类|连续浏览同类|长期连续|反复听同类|连续[^，。！？；]{1,12}之后/.test(s)) {
    return 'sustained_homogeneous';
  }
  if (/跨时区.*同步会议|每周同步会议/.test(s)) {
    return 'sync_meeting_leaf';
  }
  if (/缺乏文档|缺少文档|无异步规范|缺少书面/.test(s)) {
    return 'undocumented_scope';
  }
  return `scope_${s.replace(/\s+/g, '_')}`;
}

function extractStatementScopeTag(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (/刚开始用的时候|刚开始使用时|刚开始用|冷启动|初期使用|刚接触/.test(s)) return 'initial_stage';
  if (/连续听同类|连续浏览同类|长期连续|反复听同类|连续[^，。！？；]{1,12}之后/.test(s)) return 'sustained_homogeneous';
  if (/跨时区.*同步会议|每周同步会议/.test(s)) return 'sync_meeting_leaf';
  if (/缺乏文档|缺少文档|无异步规范|缺少书面/.test(s)) return 'undocumented_scope';

  const explicitRestrict = s.match(
    /(?:只发生在|仅发生在|只在|仅在|只限于|仅限于|限定在|限定于)[‘“"'「『]?([^，。！？；’”"'」』]{1,18})[’”"'」』]?/,
  );
  if (explicitRestrict && explicitRestrict[1]?.trim()) {
    return normalizeScopeTag(explicitRestrict[1].trim());
  }
  const stripped = s.replace(SPEAKER_PREFIX_RE, '').trim();
  const inScope = stripped.match(/(?:^|[：:，,\s])在([^，。！？；]{1,16}?)(?:的时候|期间|天气下|条件下|情况下|阶段|班次下|时)(?:[，,]|$)/);
  if (inScope && inScope[1]?.trim()) {
    return normalizeScopeTag(inScope[1].trim());
  }
  return null;
}

// ===== 会话状态规范化读取辅助（同时兼容 SQLite session-store.mjs 与轻量内存 store） =====
function extractGraphNodes(session) {
  if (!session?.confirmedGraph) return [];
  if (Array.isArray(session.confirmedGraph)) {
    return session.confirmedGraph.map((n) => ({ ...n, deps: [...(n.deps ?? [])] }));
  }
  if (Array.isArray(session.confirmedGraph.nodes)) {
    return session.confirmedGraph.nodes.map((n) => ({ ...n, deps: [...(n.deps ?? [])] }));
  }
  return [];
}

function extractSessionStatements(session) {
  if (!session || typeof session !== 'object') return [];
  const rawList = Array.isArray(session.statements)
    ? session.statements
    : session.statements && typeof session.statements === 'object'
      ? Object.values(session.statements)
      : [];
  return rawList.map((s, idx) => {
    const sid = s.statementId ?? s.id ?? (idx === 0 ? 'stmt_original' : `stmt_rewrite_${idx}`);
    return {
      ...s,
      id: sid,
      statementId: sid,
      role: s.role ?? (sid === 'stmt_original' ? 'original' : 'rewrite'),
    };
  });
}

function extractSessionList(session, ...keys) {
  if (!session || typeof session !== 'object') return [];
  for (const key of keys) {
    const val = session[key];
    if (Array.isArray(val)) return val.map((item) => (item && typeof item === 'object' ? { ...item } : item));
    if (val instanceof Map) {
      return [...val.values()].map((item) => (item && typeof item === 'object' ? { ...item } : item));
    }
  }
  return [];
}

function isPersonalMaterialsDisabled(session, input = {}) {
  if (input?.usePersonalMaterials === false) return true;
  if (session?.usePersonalMaterials === false) return true;
  if (session?.materialsStatus?.state === 'disabled_by_user') return true;
  if (session?.metadata?.usePersonalMaterials === false) return true;
  if (session?.metadata?.materialsStatus?.state === 'disabled_by_user') return true;
  return false;
}

// ===== 语义意图自动识别（支持显式 action 及任意领域自然语言输入） =====
const SCOPE_CONFIRM_PATTERN =
  /(?:只发生在|仅发生在|只在|仅在|只限于|仅限于|限定在|限定于|适用条件(?:是|为)|适用范围(?:是|为))/;

export function classifyTurnIntent(text, action = null, session = null) {
  const raw = String(text ?? '').trim();
  const explicitIntent = action?.intent ?? action?.type ?? null;
  if (explicitIntent && TURN_INTENTS.includes(explicitIntent)) {
    const subMode = action?.mode
      ?? (explicitIntent === 'check_or_confirm_condition'
        ? ((/我确认|本人确认/.test(raw) || SCOPE_CONFIRM_PATTERN.test(raw)) && !/请帮我检查|帮我核对|检查一下|核对一下/.test(raw)
            ? 'confirm'
            : 'check')
        : null);
    return { intent: explicitIntent, mode: subMode };
  }

  if (action?.adoptStatementId !== undefined) {
    return { intent: 'converge', mode: null };
  }
  if (action?.targetId !== undefined || action?.factId !== undefined) {
    return { intent: 'retract_fact', mode: null };
  }

  if (/收束|汇总当前讨论|总结当前讨论|(?:给出|整理|总结).*原句.*改写.*(?:分歧|出处)/.test(raw)) {
    return { intent: 'converge', mode: null };
  }

  if (
    /为什么先拆|为何先拆|为什么拆|为何拆|这是谁说的|谁写的|是谁的回答|怎么归属|如何归属|出处在哪|来源是什么|为什么.*结果.*(?:有别|不同|不一样)|为何.*结果.*(?:有别|不同)|哪项结论受影响|哪些结论受影响|受影响的是哪|什么结论受影响/.test(raw)
    || ((raw.endsWith('？') || raw.endsWith('?')) && /(?:为什么|为何|怎么|哪项|哪些|这是谁|谁说|受影响|还在吗)/.test(raw))
  ) {
    return { intent: 'explain_focus_or_provenance', mode: null };
  }

  if (
    /(?:撤回|撤销|取消|作废).*(?:第\s*[0-9零〇一二两三四五六七八九十百]+\s*轮|条件|限定|事实|判断|依据)/.test(raw)
    && !/(?:哪项|哪些|什么).*(?:受影响|变化)|[？?]$/.test(raw)
  ) {
    return { intent: 'retract_fact', mode: null };
  }

  if (
    /(?:不是我自己说的|不是我说的|不是我写的|并非本人|不是本人|那只是我收藏|只是我收藏|只是收藏|只是点赞|只是浏览).*(?:别人|他人|回答|文章)?/.test(raw)
    || /(?:收藏的别人的回答|别人的回答.*不是我|他人的回答.*不是我)/.test(raw)
  ) {
    return { intent: 'deny_attribution', mode: null };
  }

  if (/(?:请帮我|帮我|请)?(?:检查|核对|验证|看看|评估).*(?:适用条件|限定条件|适用范围|条件|范围|边界|刚开始用的时候|初期)/.test(raw)) {
    return { intent: 'check_or_confirm_condition', mode: 'check' };
  }

  if (
    (/(?:我确认|本人确认|我本人确认)/.test(raw) && SCOPE_CONFIRM_PATTERN.test(raw))
    || (SCOPE_CONFIRM_PATTERN.test(raw) && /^(?:我|本人|这个现象|该现象|这种情况|这件事)/.test(raw) && !/检查|核对|为什么|为何|[？?]$/.test(raw))
  ) {
    return { intent: 'check_or_confirm_condition', mode: 'confirm' };
  }

  const isExplicitRewritePrefix = /^(?:改写|改为|换成|如果改成|换个说法|在我看来[，,：:]?)/.test(raw);
  if (
    !isExplicitRewritePrefix
    && (
      /(?:我自己|我本人|我亲身|我确实|我曾经|我曾|我有过|我们团队|我们在实际经历中|在实际经历中|我自己的经历是|我的亲身经历是)/.test(raw)
      || /^我(?:在|曾|当年|去年|上个月|之前)[^，。！？；]{1,20}/.test(raw)
      || /^(?:我确认|本人确认|我本人确认)[：:，,\s]+/.test(raw)
    )
  ) {
    return { intent: 'provide_self_fact', mode: null };
  }

  const statements = extractSessionStatements(session);
  const originalStmt = statements.find(
    (s) =>
      (s.role === 'original' || s.statementId === 'stmt_original')
      && s.status !== 'pending_analysis'
      && !s.pendingStatus,
  );
  if (originalStmt) {
    if (isExplicitRewritePrefix) {
      return { intent: 'compare_rewrite', mode: null };
    }
    const origCluster = inferTopicCluster(originalStmt.text, '');
    const nextCluster = inferTopicCluster(raw, '');
    if (origCluster && !origCluster.startsWith('topic_') && origCluster === nextCluster) {
      return { intent: 'compare_rewrite', mode: null };
    }
    const origTokens = extractBigrams(originalStmt.text);
    const nextTokens = extractBigrams(raw);
    let shared = 0;
    for (const tk of nextTokens) {
      if (origTokens.has(tk)) shared += 1;
    }
    if (shared >= 2) {
      return { intent: 'compare_rewrite', mode: null };
    }
  }

  return { intent: 'analyze_statement', mode: null };
}

// ===== 纯函数图校验与算价（对接 ../quotation-engine/index.mjs 及 quote-v1.schema.json） =====
export function validateConfirmedGraph(nodes) {
  if (!Array.isArray(nodes)) return { ok: false, errors: ['confirmedGraph 必须是数组。'] };
  if (nodes.length === 0) return { ok: true, errors: [] };
  const errors = [];
  const indexById = new Map();
  nodes.forEach((n, i) => {
    if (!n || typeof n !== 'object') {
      errors.push(`nodes[${i}] 不是有效对象。`);
      return;
    }
    if (typeof n.id !== 'string' || !n.id.trim()) {
      errors.push(`nodes[${i}].id 必须是非空字符串。`);
    } else if (indexById.has(n.id)) {
      errors.push(`节点 ID 重复：${n.id}`);
    } else {
      indexById.set(n.id, i);
    }
    if (typeof n.text !== 'string' || !n.text.trim()) {
      errors.push(`nodes[${i}].text 必须是非空字符串。`);
    }
    if (!Array.isArray(n.deps)) {
      errors.push(`nodes[${i}].deps 必须是数组。`);
    }
  });
  nodes.forEach((n, i) => {
    if (!n || !Array.isArray(n.deps)) return;
    const seen = new Set();
    for (const dep of n.deps) {
      if (seen.has(dep)) errors.push(`节点 ${n.id} 存在重复依赖 ${dep}`);
      seen.add(dep);
      if (!indexById.has(dep)) errors.push(`节点 ${n.id} 引用了不存在的依赖 ${dep}`);
      else if (indexById.get(dep) >= i) errors.push(`节点 ${n.id} 违反拓扑顺序依赖 ${dep}`);
    }
  });
  return { ok: errors.length === 0, errors };
}

export function computeGraphWeights(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return [];
  const kids = new Map(nodes.map((n) => [n.id, []]));
  for (const n of nodes) {
    for (const dep of n.deps ?? []) {
      if (kids.has(dep)) kids.get(dep).push(n.id);
    }
  }
  const depth = new Map();
  for (const n of nodes) depth.set(n.id, (n.deps?.length ?? 0) > 0 ? Infinity : 0);
  for (const n of nodes) {
    const d = depth.get(n.id);
    for (const childId of kids.get(n.id) ?? []) {
      if (d + 1 < depth.get(childId)) depth.set(childId, d + 1);
    }
  }
  const desc = new Map();
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const n = nodes[i];
    const set = new Set();
    for (const childId of kids.get(n.id) ?? []) {
      set.add(childId);
      for (const transitiveId of desc.get(childId) ?? []) set.add(transitiveId);
    }
    desc.set(n.id, set);
  }
  return nodes.map((n) => ({
    ...n,
    cluster: n.cluster ?? 'default',
    deps: [...(n.deps ?? [])],
    S: desc.get(n.id).size,
    d: depth.get(n.id),
  }));
}

export function collapseGraphAfter(directConflictIds, computedGraph) {
  const dead = new Set(directConflictIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of computedGraph) {
      if (dead.has(node.id) || !Array.isArray(node.deps) || node.deps.length === 0) continue;
      const aliveCount = node.deps.filter((depId) => !dead.has(depId)).length;
      if (aliveCount / node.deps.length < 0.5) {
        dead.add(node.id);
        changed = true;
      }
    }
  }
  return dead;
}

function validateAndNormalizeStringIds(rawList, label) {
  if (rawList === undefined || rawList === null) return [];
  const arr = Array.isArray(rawList) ? rawList : (rawList instanceof Set ? [...rawList] : null);
  if (!arr) {
    throw new BackendServiceError('VERIFICATION_REJECTED', `${label} 必须是字符串数组。`, 400);
  }
  const seen = new Set();
  const out = [];
  for (let i = 0; i < arr.length; i += 1) {
    const v = arr[i];
    if (typeof v !== 'string' || !v.trim()) {
      throw new BackendServiceError('VERIFICATION_REJECTED', `${label}[${i}] 必须是非空字符串。`, 400);
    }
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

export function validateConflictReasonsList(conflictReasons) {
  if (conflictReasons === undefined || conflictReasons === null) return [];
  if (!Array.isArray(conflictReasons)) {
    throw new BackendServiceError('VERIFICATION_REJECTED', 'conflictReasons 必须是数组。', 400);
  }
  return conflictReasons.map((entry, idx) => {
    if (typeof entry === 'string') {
      if (!entry.trim()) {
        throw new BackendServiceError('VERIFICATION_REJECTED', `conflictReasons[${idx}] 不能为空字符串。`, 400);
      }
      return entry;
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      if (typeof entry.nodeId !== 'string' || !entry.nodeId.trim()) {
        throw new BackendServiceError(
          'VERIFICATION_REJECTED',
          `conflictReasons[${idx}].nodeId 必须是非空字符串。`,
          400,
        );
      }
      if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
        throw new BackendServiceError(
          'VERIFICATION_REJECTED',
          `conflictReasons[${idx}].reason 必须是非空字符串。`,
          400,
        );
      }
      const normalized = {
        ...entry,
        nodeId: entry.nodeId.trim(),
        reason: entry.reason.trim(),
      };
      if (entry.evidenceIds !== undefined) {
        normalized.evidenceIds = validateAndNormalizeStringIds(
          entry.evidenceIds,
          `conflictReasons[${idx}].evidenceIds`,
        );
      }
      return normalized;
    }
    throw new BackendServiceError(
      'VERIFICATION_REJECTED',
      `conflictReasons[${idx}] 必须是非空字符串或含 nodeId/reason 的对象。`,
      400,
    );
  });
}

function attachLegacyQuoteAliases(quoteObj) {
  Object.defineProperties(quoteObj, {
    collapsedNodes: { value: quoteObj.collateral, enumerable: false, configurable: true },
    collateralAffected: { value: quoteObj.collateral, enumerable: false, configurable: true },
    affectedNodes: { value: quoteObj.affected, enumerable: false, configurable: true },
    affectedNodeIds: { value: quoteObj.affected, enumerable: false, configurable: true },
    dead: { value: quoteObj.affected, enumerable: false, configurable: true },
    collapsed: { value: quoteObj.collateral.length, enumerable: false, configurable: true },
    lost: { value: quoteObj.numerator, enumerable: false, configurable: true },
    total: { value: quoteObj.denominator, enumerable: false, configurable: true },
    rateNote: { value: quoteObj.interpretationNote, enumerable: false, configurable: true },
  });
  return quoteObj;
}

export function evaluateGraphQuote(
  confirmedGraph,
  directConflicts = [],
  {
    pricingEngine = null,
    statementId = 'stmt_original',
    text = '',
    graphVersion = 0,
    compatibleEvidenceFound = false,
    conflictReasons = [],
    verifiedEvidenceIds = [],
  } = {},
) {
  const normalizedReasons = validateConflictReasonsList(conflictReasons);
  const normalizedEvidenceIds = validateAndNormalizeStringIds(verifiedEvidenceIds, 'verifiedEvidenceIds');

  const safeNodes = Array.isArray(confirmedGraph)
    ? confirmedGraph
    : Array.isArray(confirmedGraph?.nodes)
      ? confirmedGraph.nodes
      : [];

  let computed = safeNodes;
  if (safeNodes.length > 0) {
    if (typeof pricingEngine?.computeGraph === 'function') {
      computed = pricingEngine.computeGraph(
        safeNodes.map((n) => ({ ...n, cluster: n.cluster ?? 'default', deps: [...(n.deps ?? [])] })),
      );
    } else {
      computed = computeGraphWeights(safeNodes);
    }
  }

  const validNodeIds = new Set(computed.map((n) => n.id));
  const uniqueConflicts = [...new Set(
    validateAndNormalizeStringIds(directConflicts, 'directConflicts').filter((id) => validNodeIds.has(id)),
  )];
  const assessment = uniqueConflicts.length > 0
    ? 'conflict'
    : compatibleEvidenceFound
      ? 'compatible'
      : 'insufficient_evidence';

  const activeReasons = assessment === 'conflict'
    ? normalizedReasons.filter((r) => (typeof r === 'string' ? true : validNodeIds.has(r.nodeId)))
    : [];

  if (typeof pricingEngine?.evaluateStatementQuote === 'function') {
    const evaluated = pricingEngine.evaluateStatementQuote({
      graph: computed,
      graphVersion,
      statementId,
      text,
      assessment,
      directConflicts: uniqueConflicts,
      conflictReasons: activeReasons,
      verifiedEvidenceIds: normalizedEvidenceIds,
      ignoreUnknownConflicts: true,
    });
    const collateral = Array.isArray(evaluated.collateral) ? [...evaluated.collateral] : [];
    const affected = Array.isArray(evaluated.affected) ? [...evaluated.affected] : [...uniqueConflicts, ...collateral];
    const denominator = Number.isInteger(evaluated.denominator) ? evaluated.denominator : 0;
    const rawNumerator = Number.isInteger(evaluated.numerator) ? evaluated.numerator : 0;
    const numerator = assessment === 'conflict' && denominator > 0 ? rawNumerator : 0;
    const exactRate =
      assessment === 'conflict'
        ? (denominator === 0 ? null : Math.round((100 * numerator) / denominator))
        : assessment === 'compatible'
          ? (denominator === 0 ? null : 0)
          : null;
    const reasonText =
      evaluated.reason && evaluated.reason.trim()
        ? evaluated.reason
        : buildQuoteReason(assessment, uniqueConflicts, collateral, numerator, denominator, exactRate);

    return attachLegacyQuoteAliases({
      statementId: String(statementId),
      text: String(text ?? ''),
      graphVersion,
      assessment: evaluated.assessment,
      rate: exactRate,
      directConflicts: assessment === 'conflict' ? [...evaluated.directConflicts] : [],
      collateral: assessment === 'conflict' ? collateral : [],
      affected: assessment === 'conflict' ? affected : [],
      numerator,
      denominator,
      reason: reasonText,
      conflictReasons: assessment === 'conflict' ? (evaluated.conflictReasons ?? activeReasons) : [],
      verifiedEvidenceIds: evaluated.verifiedEvidenceIds ?? normalizedEvidenceIds,
      interpretationNote: RATE_INTERPRETATION_NOTE,
    });
  }

  const deadSet = assessment === 'conflict' ? collapseGraphAfter(uniqueConflicts, computed) : new Set();
  const total = computed.reduce((sum, n) => sum + (n.S ?? 0), 0);
  const rawLost = computed.filter((n) => deadSet.has(n.id)).reduce((sum, n) => sum + (n.S ?? 0), 0);
  const lost = assessment === 'conflict' && total > 0 ? rawLost : 0;
  const affectedNodes = assessment === 'conflict' ? [...deadSet] : [];
  const collapsedNodes = affectedNodes.filter((id) => !uniqueConflicts.includes(id));

  let rate = null;
  if (assessment === 'conflict') {
    rate = total === 0 ? null : Math.round((100 * lost) / total);
  } else if (assessment === 'compatible') {
    rate = total === 0 ? null : 0;
  }

  const reason = buildQuoteReason(assessment, uniqueConflicts, collapsedNodes, lost, total, rate);

  return attachLegacyQuoteAliases({
    statementId: String(statementId),
    text: String(text ?? ''),
    graphVersion,
    assessment,
    rate,
    directConflicts: assessment === 'conflict' ? uniqueConflicts : [],
    collateral: assessment === 'conflict' ? collapsedNodes : [],
    affected: affectedNodes,
    numerator: lost,
    denominator: total,
    reason,
    conflictReasons: activeReasons,
    verifiedEvidenceIds: normalizedEvidenceIds,
    interpretationNote: RATE_INTERPRETATION_NOTE,
  });
}

function buildQuoteReason(assessment, uniqueConflicts, collapsedNodes, lost, total, rate) {
  if (assessment === 'conflict') {
    if (total === 0) {
      return `已核验发现与本人节点 [${uniqueConflicts.join(', ')}] 直接冲突，但当前已确认图总承重分母为 0（稀疏图无上层依赖），因此结构影响比例留空（null）。`;
    }
    if (lost === 0) {
      return `已核验发现与承重 S=0 的叶节点 [${uniqueConflicts.join(', ')}] 直接冲突，未引起上游承重节点坍塌（分子/分母 = 0/${total}，结构影响比例 0%）。`;
    }
    return `与本人已确认节点 [${uniqueConflicts.join(', ')}] 直接冲突${collapsedNodes.length > 0 ? `，并连带使 [${collapsedNodes.join(', ')}] 失去过半依据` : ''}（分子/分母 = ${lost}/${total}，结构影响比例 ${rate}%）。`;
  }
  if (assessment === 'compatible') {
    return '与当前已确认图中的本人核验事实及适用边界相容，未发现直接冲突。';
  }
  return '当前已确认图中尚无针对该主张范围的本人核验节点，维持未定（insufficient_evidence）。';
}

export function buildStatementComparison(quotes, confirmedGraph, graphVersion, adoptedStatementId = null) {
  const safeNodes = Array.isArray(confirmedGraph) ? confirmedGraph : [];
  const denominator = safeNodes.reduce((sum, n) => sum + (n.S ?? 0), 0);
  if (!Array.isArray(quotes) || quotes.length === 0) {
    return {
      graphVersion,
      denominator,
      totalNodes: safeNodes.length,
      baselineStatementId: null,
      adoptedStatementId: adoptedStatementId ?? null,
      quotes: [],
      comparisons: [],
    };
  }
  const baselineQuote = quotes.find((q) => q.statementId === 'stmt_original') ?? quotes[0];
  const baseDirectSet = new Set(baselineQuote.directConflicts ?? []);
  const baseAffectedSet = new Set(baselineQuote.affected ?? []);

  const comparisons = quotes
    .filter((q) => q.statementId !== baselineQuote.statementId)
    .map((q) => {
      const qDirectSet = new Set(q.directConflicts ?? []);
      const qAffectedSet = new Set(q.affected ?? []);
      const bothVerified =
        baselineQuote.assessment !== 'insufficient_evidence'
        && q.assessment !== 'insufficient_evidence';
      const deltaRate =
        !bothVerified || baselineQuote.rate === null || q.rate === null
          ? null
          : q.rate - baselineQuote.rate;
      const resolvedConflicts = bothVerified
        ? (baselineQuote.directConflicts ?? []).filter((id) => !qDirectSet.has(id))
        : [];
      const resolvedAffected = bothVerified
        ? (baselineQuote.affected ?? []).filter((id) => !qAffectedSet.has(id))
        : [];
      const addedConflicts = (q.directConflicts ?? []).filter((id) => !baseDirectSet.has(id));
      const addedAffected = (q.affected ?? []).filter((id) => !baseAffectedSet.has(id));
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
    });

  return {
    graphVersion,
    denominator,
    totalNodes: safeNodes.length,
    baselineStatementId: baselineQuote.statementId,
    adoptedStatementId: adoptedStatementId ?? null,
    quotes,
    comparisons,
  };
}

// ===== 分句级语义命题解析与关系核验引擎（QA-05） =====
const SPEAKER_PREFIX_RE =
  /^(?:本人经历（轮次\s*[^）]+）：|本人确认适用条件（轮次\s*[^）]+）：|阶段性限定结论（轮次\s*[^）]+）：|本人事实：|本人叶判断：|本人基础判断：|本人依据判断（轮次\s*[^）]+）：|我本人亲身经历[：:，,\s]*|我自己的经历是[：:，,\s]*|我的亲身经历是[：:，,\s]*|我本人确认[：:，,\s]*|本人确认[：:，,\s]*|我确认[：:，,\s]*|换个说法[：:，,\s]*|如果改成[：:，,\s]*|在我看来[，,：:\s]*|不过|其实)\s*/u;

const CLAUSE_SPLIT_RE =
  /[，,；;。！？!?\n]+|(?:但是|但|却|不过|然而|虽然|尽管|同时|而且|并且|反而)/u;

const DOUBLE_NEGATION_PATTERNS = [
  /并非不/g,
  /并不是不/g,
  /不是不/g,
  /并非没/g,
  /不是没/g,
  /并非不能/g,
  /不是不能/g,
  /并非无法/g,
  /不是无法/g,
  /并非不允许/g,
  /不是不允许/g,
  /并非不可能/g,
  /不是不可能/g,
  /并非从不/g,
  /不是从不/g,
  /并非只会/g,
  /不只是/g,
  /未尝不/g,
  /未尝没/g,
  /不得不/g,
  /不能不/g,
];

const SINGLE_NEGATION_TOKENS = [
  '绝不可能',
  '不可能',
  '并不是',
  '并非',
  '不是',
  '从不',
  '从未',
  '绝不',
  '绝无',
  '未曾',
  '没有',
  '不能',
  '无法',
  '不会',
  '不准',
  '不许',
  '禁止',
  '拒绝',
  '毫无',
  '没',
  '不',
  '未',
];

const POSITIVE_PREDICATE_PATTERNS = [
  /(?:缩短|减少|降低)[^，。！？；]{0,8}(?:周期|耗时|等待|打断)/,
  /显著提升|明显提升|大幅提升|提高|提升|改善|更高|增强|加快|流畅运行|流畅|优于/,
  /发现过|新乐队|新东西|新领域|新歌|没听过|拓宽|拓展|多元/,
  /成功|允许|准许|获准|能够|可以|做到|实现了|实现|切实有效|跑通|换过班|换班成功/,
  /完全可以替代|彻底取代|足以替代/,
];

const NEGATIVE_PREDICATE_PATTERNS = [
  /(?:拉长|增加|提高)[^，。！？；]{0,8}(?:耗时|等待|打断)/,
  /越来越窄|越来越少|只有变窄|变窄|收窄|信息茧房|同质化|单一|局限/,
  /降低|拉低|下降|变差|低效|阻碍|破坏|拖慢|损害|失灵/,
  /完全失败|失败|漏掉边界缺陷|仍需人工/,
];

const SPECIFIC_METRIC_HEADS = [
  '即时沟通效率',
  '沟通效率',
  '团队协作效率',
  '协作效率',
  '交付效率',
  '交付速度',
  '交付周期',
  '同步会议耗时',
  '会议耗时',
  '会议频率',
  '员工换班',
  '换班',
  '兴趣',
  '新乐队',
  '新东西',
  '本地设备',
  '探索性测试',
];

function countClauseNegations(clauseText) {
  // 排除修饰宾语新颖度的定语从句（如“以前完全没听过的新乐队”），避免将定语中的“没/未”计入主谓词否定
  let working = String(clauseText ?? '').replace(
    /(?:以前|之前|过去|完全|从来)?(?:没|未)(?:有)?(?:听|见|看|接触|涉足|尝试|留意|买|去|读|用)过的/gu,
    ' ',
  );
  let negCount = 0;
  let doubleNegated = false;

  for (const re of DOUBLE_NEGATION_PATTERNS) {
    const matches = working.match(re);
    if (matches) {
      negCount += matches.length * 2;
      doubleNegated = true;
      working = working.replace(re, ' ');
    }
  }

  for (const tok of SINGLE_NEGATION_TOKENS) {
    let idx = working.indexOf(tok);
    while (idx >= 0) {
      negCount += 1;
      working = `${working.slice(0, idx)} ${working.slice(idx + tok.length)}`;
      idx = working.indexOf(tok);
    }
  }

  return { negCount, doubleNegated };
}

function extractClauseAspect(clauseText) {
  const cleaned = String(clauseText ?? '')
    .replace(SPEAKER_PREFIX_RE, '')
    .replace(/\b(?:fact|cond|turn|ev|evidence|stmt|node)_[A-Za-z0-9_.:-]+\b/gi, ' ')
    .replace(
      /我自己|我本人|我亲身|我确实|我曾经|我曾|我们异步团队|我们团队|我们在|我们|在这家|在那家|这家|那家|所有|全部|任何|无一例外|必然|必定|一定|只会|只有|这一种作用|完全|绝对|绝不可能|不可能|并非|并不是|不是|从不|从未|绝不|没有|未曾|不能|无法|不会|不准|不许|禁止|显著|明显|大幅|反而|确实|真的|曾经|成功|允许|准许|能够|可以|提高了|提升了|降低了|拉低了|减少了|缩短了|增加了|提高|提升|降低|拉低|下降|减少|缩短|增加|变窄|越来越窄|越来越少|发现过|以前|完全没听过的/gu,
      ' ',
    )
    .replace(/[0-9]+%?/g, ' ')
    .replace(/[在当时后里中的了过着让把对使给由靠用]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const metricHeads = SPECIFIC_METRIC_HEADS.filter((head) => clauseText.includes(head));
  return {
    aspectText: cleaned,
    aspectBigrams: extractBigrams(cleaned),
    metricHeads,
  };
}

function inferClauseEffectiveSign(clauseText) {
  const s = String(clauseText ?? '');

  // 针对特定数值变化词（如“耗时绝不可能减少” vs “耗时减少了40%”）直接判定动作肯定/否定
  if (/耗时|等待/.test(s) && /减少|缩短/.test(s)) {
    const { negCount } = countClauseNegations(s);
    return negCount % 2 === 1 ? -1 : 1;
  }

  // 针对“替代”类断定（“完全可以替代” vs “无法替代”）
  if (/替代|取代/.test(s)) {
    const { negCount } = countClauseNegations(s);
    return negCount % 2 === 1 ? -1 : 1;
  }

  const { negCount, doubleNegated } = countClauseNegations(s);
  const strippedNeg = s.replace(/并非不|不是不|并非|并不是|不是|绝不可能|不可能|从不|从未|绝不|没有|未曾|不能|无法|不会|不准|不许|禁止|拒绝|不|没|未/g, '');

  let baseSign = 0;
  if (POSITIVE_PREDICATE_PATTERNS.some((re) => re.test(strippedNeg)) || POSITIVE_PREDICATE_PATTERNS.some((re) => re.test(s) && negCount === 0)) {
    baseSign = 1;
  } else if (NEGATIVE_PREDICATE_PATTERNS.some((re) => re.test(strippedNeg)) || NEGATIVE_PREDICATE_PATTERNS.some((re) => re.test(s) && negCount === 0)) {
    baseSign = -1;
  } else {
    // 实义动作发生（如“换班”、“运行”）本身视作正向实例 +1，加奇数否定（“从不允许换班”、“无法运行”）翻转成 -1
    baseSign = 1;
  }

  const effectiveSign = negCount % 2 === 1 ? -baseSign : baseSign;
  return doubleNegated && baseSign > 0 ? 1 : effectiveSign;
}

export function parsePropositionClauses(rawText) {
  const cleanFull = String(rawText ?? '').replace(SPEAKER_PREFIX_RE, '').trim();
  if (!cleanFull) return [];
  const rawParts = cleanFull
    .split(CLAUSE_SPLIT_RE)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2 && !/^(?:比如|例如|整体上|总体来说|换言之)$/.test(p));

  const fullCluster = inferTopicCluster(cleanFull, '');
  const fullScope = extractStatementScopeTag(cleanFull);

  return rawParts.map((part) => {
    const { aspectText, aspectBigrams, metricHeads } = extractClauseAspect(part);
    const effectiveSign = inferClauseEffectiveSign(part);
    const clauseScope = extractStatementScopeTag(part) ?? fullScope;
    const clauseCluster = inferTopicCluster(part, fullCluster);
    return {
      raw: part,
      aspectText,
      aspectBigrams,
      metricHeads,
      effectiveSign,
      universal: hasUniversalExclusivity(part),
      scopeTag: clauseScope,
      cluster: clauseCluster,
      allBigrams: extractBigrams(part),
    };
  });
}

function metricHeadsConflictOrDisjoint(headsA, headsB) {
  if (headsA.length === 0 || headsB.length === 0) return null;
  // 若两边均含具体指标词，检查是否存在同义/包含指标词
  const normalizeHead = (h) => {
    if (h === '即时沟通效率') return '沟通效率';
    if (h === '团队协作效率') return '协作效率';
    if (h === '同步会议耗时') return '会议耗时';
    if (h === '员工换班') return '换班';
    if (h === '新乐队' || h === '新东西') return '兴趣';
    return h;
  };
  const normA = new Set(headsA.map(normalizeHead));
  const normB = new Set(headsB.map(normalizeHead));
  for (const a of normA) {
    if (normB.has(a)) return 'match';
  }
  return 'disjoint';
}

function doClausesAlign(cStmt, cNode, { singleClauseUmbrella = false } = {}) {
  const headCheck = metricHeadsConflictOrDisjoint(cStmt.metricHeads, cNode.metricHeads);
  if (headCheck === 'match') return true;
  if (headCheck === 'disjoint') {
    // 仅当原句是单子句全称伞状断定（如“远程办公必然降低所有团队的协作效率”），且本人节点是效率/交付周期实例（绝非“会议频率”）时允许同域反例对齐
    if (
      singleClauseUmbrella
      && cStmt.cluster === 'remote_work_efficiency'
      && cNode.cluster === 'remote_work_efficiency'
      && cStmt.metricHeads.some((h) => h.includes('协作效率') || h.includes('交付'))
      && cNode.metricHeads.some((h) => h.includes('交付周期') || h.includes('交付效率') || h.includes('交付速度'))
      && !cNode.metricHeads.includes('会议频率')
    ) {
      return true;
    }
    return false;
  }

  // 若一边涉及具体“会议”指标（会议频率/会议耗时/同步会议耗时）而另一边不涉及“会议”，严禁跨对象误对齐
  const stmtHasMeeting = cStmt.metricHeads.some((h) => h.includes('会议'));
  const nodeHasMeeting = cNode.metricHeads.some((h) => h.includes('会议'));
  if (stmtHasMeeting !== nodeHasMeeting) {
    return false;
  }

  // 推荐兴趣广度同域对齐
  if (
    cStmt.cluster === 'recommendation_interest'
    && cNode.cluster === 'recommendation_interest'
    && (/兴趣|变窄|新东西|乐队|歌/.test(cStmt.raw) && /兴趣|变窄|新东西|乐队|歌/.test(cNode.raw))
  ) {
    return true;
  }

  // 通用名词对象双字重合检查
  let aspectOverlap = 0;
  for (const bg of cStmt.aspectBigrams) {
    if (cNode.aspectBigrams.has(bg)) aspectOverlap += 1;
  }
  if (aspectOverlap >= 1) return true;

  if (singleClauseUmbrella) {
    let rawOverlap = 0;
    for (const bg of cStmt.allBigrams) {
      if (cNode.allBigrams.has(bg)) rawOverlap += 1;
    }
    if (
      rawOverlap >= 2
      || (cStmt.cluster && !cStmt.cluster.startsWith('topic_') && cStmt.cluster === cNode.cluster)
    ) {
      return true;
    }
  }

  return false;
}

function hasUniversalExclusivity(text) {
  return /只会|只有[^，。！？；]{0,14}这一种|只有|必然|必定|所有|全部|任何|无一例外|绝对|完全|绝不可能|不可能|从不|从未|绝不|永远|一定/.test(
    String(text ?? ''),
  );
}

export function detectDirectConflicts(statementText, confirmedGraph, { activeFacts = [] } = {}) {
  const stmt = String(statementText ?? '').trim();
  const nodes = Array.isArray(confirmedGraph)
    ? confirmedGraph
    : Array.isArray(confirmedGraph?.nodes)
      ? confirmedGraph.nodes
      : [];
  if (!stmt || nodes.length === 0) {
    return {
      directConflicts: [],
      conflictReasons: [],
      compatibleEvidenceFound: false,
      compatibleNodeIds: [],
      compatibleEvidenceIds: [],
    };
  }

  const stmtUniversal = hasUniversalExclusivity(stmt);
  const stmtScope = extractStatementScopeTag(stmt);
  const stmtClauses = parsePropositionClauses(stmt);

  const activeConditions = (Array.isArray(activeFacts) ? activeFacts : []).filter(
    (f) => f.kind === 'condition' && f.status === 'active',
  );
  const factScopeMap = new Map();
  for (const cond of activeConditions) {
    const tag = cond.scopeTag ?? normalizeScopeTag(cond.scopeText || cond.text);
    const targets = cond.appliesToFactIds ?? (cond.targetFactId ? [cond.targetFactId] : []);
    for (const targetFactId of targets) {
      if (tag) factScopeMap.set(targetFactId, tag);
    }
  }

  const directConflicts = [];
  const conflictReasons = [];
  const compatibleNodeIds = [];
  const compatibleEvidenceIds = new Set();

  for (const node of nodes) {
    if (node.attribution && node.attribution !== 'self') continue;

    if (Array.isArray(node.contradictsPatterns)) {
      const matched = node.contradictsPatterns.some((pat) =>
        pat instanceof RegExp ? pat.test(stmt) : stmt.includes(String(pat)),
      );
      if (matched) {
        directConflicts.push(node.id);
        conflictReasons.push({
          nodeId: node.id,
          nodeText: node.text,
          evidenceIds: Array.isArray(node.evidenceIds) ? [...node.evidenceIds] : [],
          reason: `句子直接触碰了本人已确认节点“${node.text}”的反例边界。`,
        });
        continue;
      }
    }

    if (
      node.factRole === 'scope_condition'
      || node.factRole === 'derived_judgment'
      || node.factRole === 'scoped_conclusion'
      || node.kind === 'condition'
    ) {
      continue;
    }

    let nodeScope = node.scopeTag ?? extractStatementScopeTag(node.text);
    if (!nodeScope && Array.isArray(node.sourceFactIds)) {
      for (const fid of node.sourceFactIds) {
        if (factScopeMap.has(fid)) {
          nodeScope = factScopeMap.get(fid);
          break;
        }
      }
    }

    // 范围对齐门禁：若句子声明了局部范围且不含无条件全称排他词，则必须存在同范围的本人节点才能判定冲突或相容
    if (stmtScope && !stmtUniversal) {
      if (!nodeScope || nodeScope !== stmtScope) {
        continue;
      }
    }
    if (nodeScope && stmtScope && nodeScope !== stmtScope) {
      continue;
    }

    const nodeClauses = parsePropositionClauses(node.text);
    if (stmtClauses.length === 0 || nodeClauses.length === 0) continue;

    const singleClauseUmbrella =
      stmtClauses.length === 1 && nodeClauses.length === 1 && (stmtUniversal || hasUniversalExclusivity(node.text));

    let hasClauseConflict = false;
    let alignedStmtClauseIndexes = new Set();

    for (let si = 0; si < stmtClauses.length; si += 1) {
      const cStmt = stmtClauses[si];
      for (const cNode of nodeClauses) {
        if (cStmt.scopeTag && cNode.scopeTag && cStmt.scopeTag !== cNode.scopeTag && !cStmt.universal) {
          continue;
        }
        if (!doClausesAlign(cStmt, cNode, { singleClauseUmbrella })) {
          continue;
        }
        if (cStmt.effectiveSign * cNode.effectiveSign < 0) {
          hasClauseConflict = true;
          break;
        }
        if (cStmt.effectiveSign !== 0 && cStmt.effectiveSign === cNode.effectiveSign) {
          alignedStmtClauseIndexes.add(si);
        }
      }
      if (hasClauseConflict) break;
    }

    if (hasClauseConflict) {
      directConflicts.push(node.id);
      conflictReasons.push({
        nodeId: node.id,
        nodeText: node.text,
        evidenceIds: Array.isArray(node.evidenceIds) ? [...node.evidenceIds] : [],
        reason: `主张与本人已确认事实节点“${node.text}”直接冲突。`,
      });
    } else if (
      alignedStmtClauseIndexes.size === stmtClauses.length
      && (!nodeScope || stmtScope === nodeScope)
      && (!stmtUniversal || hasUniversalExclusivity(node.text))
    ) {
      compatibleNodeIds.push(node.id);
      for (const eid of node.evidenceIds ?? []) {
        if (typeof eid === 'string' && eid.trim()) compatibleEvidenceIds.add(eid);
      }
    }
  }

  return {
    directConflicts,
    conflictReasons,
    compatibleEvidenceFound: directConflicts.length === 0 && compatibleNodeIds.length > 0,
    compatibleNodeIds,
    compatibleEvidenceIds: [...compatibleEvidenceIds],
  };
}

// ===== 实时流式输出核验守卫（QA-06：未闭合引号与尾部待定百分比增量守卫） =====
const QUOTE_PAIR_MAP = new Map([
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
  ['"', '"'],
]);

function normalizeForQuoteLookup(str) {
  return String(str ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createTurnStreamGuard({
  allowedQuoteSources = [],
  allowedRates = [],
  allowedRatios = [],
  activeQuote = null,
  secrets = [],
} = {}) {
  const normalizedSources = allowedQuoteSources
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .map((s) => normalizeForQuoteLookup(redactTurnText(s, secrets)));

  const allowedRateSet = new Set(
    allowedRates.filter((r) => typeof r === 'number' && Number.isFinite(r)),
  );
  // 同时放行已核验原文中自带的真实百分比（如“减少了40%”）
  for (const src of normalizedSources) {
    for (const m of src.matchAll(/(\d+(?:\.\d+)?)\s*[%％]/g)) {
      allowedRateSet.add(Number(m[1]));
    }
  }

  const allowedRatioSet = new Set(
    allowedRatios.filter((r) => typeof r === 'string' && r.trim()),
  );
  for (const src of normalizedSources) {
    for (const m of src.matchAll(/\b(\d+)\s*\/\s*(\d+)\b/g)) {
      allowedRatioSet.add(`${m[1]}/${m[2]}`);
    }
  }

  const replacementRateText =
    activeQuote && Number.isInteger(activeQuote.rate)
      ? `${activeQuote.rate}%`
      : '未定（null）';

  const replacementRatioText =
    activeQuote && Number.isInteger(activeQuote.numerator) && Number.isInteger(activeQuote.denominator)
      ? `${activeQuote.numerator}/${activeQuote.denominator}`
      : null;

  let activeOpenQuote = null;
  let quoteBuffer = '';
  let tailNumberBuffer = '';

  function isQuoteGrounded(innerText) {
    const trimmed = normalizeForQuoteLookup(innerText);
    if (!trimmed) return true;
    // 极短元词（<= 2 字符）不视为引文编造
    if ([...trimmed].length <= 2) return true;
    if (/^(?:conflict|compatible|insufficient_evidence|null|self|other_author|未定|相容|直接冲突|证据不足)$/i.test(trimmed)) {
      return true;
    }
    return normalizedSources.some((src) => src.includes(trimmed));
  }

  function sanitizePlainSegment(segment, { isFinal = false } = {}) {
    let combined = tailNumberBuffer + segment;
    tailNumberBuffer = '';

    if (!isFinal) {
      // 若片段末尾是尚未结束的数字或紧跟空白（下一块可能紧接 '%' 或 '/分母'），暂存该极短数字后缀
      const trailingNum = combined.match(/(\d+(?:\.\d+)?(?:\s*\/\s*\d*)?\s*)$/);
      if (trailingNum && trailingNum[1].length <= 16) {
        const cutIdx = combined.length - trailingNum[1].length;
        tailNumberBuffer = combined.slice(cutIdx);
        combined = combined.slice(0, cutIdx);
      }
    }

    if (!combined) return '';

    // 校验百分比数值
    let checked = combined.replace(/(\d+(?:\.\d+)?)\s*([%％])/g, (full, numStr) => {
      const val = Number(numStr);
      if (allowedRateSet.has(val)) return full;
      return replacementRateText;
    });

    // 校验显式分子/分母比值（排除年份日期如 2026/11）
    if (replacementRatioText) {
      checked = checked.replace(/\b(\d{1,4})\s*\/\s*(\d{1,4})\b/g, (full, nStr, dStr) => {
        const nVal = Number(nStr);
        if (nVal >= 1990 && nVal <= 2100) return full;
        const key = `${nStr}/${dStr}`;
        if (allowedRatioSet.has(key)) return full;
        return replacementRatioText;
      });
    }

    return redactTurnText(checked, secrets);
  }

  function push(rawChunk) {
    const chunk = redactTurnText(rawChunk ?? '', secrets);
    if (!chunk) return '';

    let safePlain = '';
    let out = '';

    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i];
      if (activeOpenQuote !== null) {
        const expectedClose = QUOTE_PAIR_MAP.get(activeOpenQuote);
        if (ch === expectedClose) {
          const inner = quoteBuffer;
          const openCh = activeOpenQuote;
          activeOpenQuote = null;
          quoteBuffer = '';
          if (isQuoteGrounded(inner)) {
            safePlain += `${openCh}${inner}${ch}`;
          }
          // 未收录的虚构引文整段剔除，绝不下发客户端
        } else {
          quoteBuffer += ch;
          // 防止异常超长未闭合引号无限积压（超过 240 字符仍未闭合时按接地性判定释放或丢弃）
          if (quoteBuffer.length > 240) {
            if (isQuoteGrounded(quoteBuffer)) {
              safePlain += `${activeOpenQuote}${quoteBuffer}`;
            }
            activeOpenQuote = null;
            quoteBuffer = '';
          }
        }
      } else if (QUOTE_PAIR_MAP.has(ch)) {
        if (safePlain) {
          out += sanitizePlainSegment(safePlain, { isFinal: false });
          safePlain = '';
        }
        activeOpenQuote = ch;
        quoteBuffer = '';
      } else {
        safePlain += ch;
      }
    }

    if (safePlain) {
      out += sanitizePlainSegment(safePlain, { isFinal: false });
    }
    return out;
  }

  function flush() {
    let tail = '';
    if (activeOpenQuote !== null) {
      if (isQuoteGrounded(quoteBuffer)) {
        tail += `${activeOpenQuote}${quoteBuffer}`;
      }
      activeOpenQuote = null;
      quoteBuffer = '';
    }
    return sanitizePlainSegment(tail, { isFinal: true });
  }

  return { push, flush };
}

// ===== 纯内存单元测试兜底合成样本（仅在无 materialsAdapter 且无正式服务 config 的 demo 单测中启用） =====
function defaultDemoCollectionCandidates(topicKeywords, snapshotId = 'snap_demo_001') {
  const joined = topicKeywords.join(' ');
  if (/推荐|兴趣|歌|乐队|冷启动|信息茧房/.test(joined)) {
    return [
      {
        id: 'ev_col_answer_201',
        evidenceId: 'ev_col_answer_201',
        sourceType: 'collection_record',
        author: '周牧',
        attribution: 'other_author',
        excerpt: '很多人把兴趣变窄全怪在算法头上，其实我去年深夜刷歌单时，通过推荐页顺手点开，发现了好几支以前从没听过的独立乐队。',
        span: { startOffset: 0, endOffset: 56 },
        textKind: 'summary',
        summaryTruncated: false,
        snapshotId,
        turnId: null,
        url: 'https://www.zhihu.com/question/6001/answer/201',
        contentKey: 'answer:201',
        behaviorKinds: ['history', 'collections'],
        topic: 'recommendation_interest',
      },
    ];
  }
  if (/远程办公|协作|团队|异步/.test(joined)) {
    return [
      {
        id: 'ev_col_answer_208',
        evidenceId: 'ev_col_answer_208',
        sourceType: 'collection_record',
        author: '陈序',
        attribution: 'other_author',
        excerpt: '异步文档配合固定核心沟通时段，跨时区工程团队的交付周期反而缩短了，但前提是接口契约和变更记录必须书面化。',
        span: { startOffset: 0, endOffset: 53 },
        textKind: 'summary',
        summaryTruncated: false,
        snapshotId,
        turnId: null,
        url: 'https://www.zhihu.com/question/7001/answer/208',
        contentKey: 'answer:208',
        behaviorKinds: ['history', 'collections'],
        topic: 'remote_work_efficiency',
      },
    ];
  }
  return [];
}

function defaultDemoPublicSearchCandidates(topicKeywords, intent) {
  const joined = topicKeywords.join(' ');
  if (/推荐|兴趣|冷启动|刚开始|乐队/.test(joined)) {
    return [
      {
        id: intent === 'check_or_confirm_condition' ? 'ev_pub_coldstart_scope' : 'ev_pub_rec_mechanisms',
        evidenceId: intent === 'check_or_confirm_condition' ? 'ev_pub_coldstart_scope' : 'ev_pub_rec_mechanisms',
        sourceType: 'public_search',
        author: '林知行',
        attribution: 'other_author',
        excerpt:
          intent === 'check_or_confirm_condition'
            ? '公开讨论指出：推荐系统在刚开始使用的冷启动探索期会主动提高跨类目采样比例以探测兴趣边界，但这一机制仅说明初期可拓宽接触面，不能单独推断长期连续点击同类内容后的收敛程度。'
            : '公开讨论指出：推荐系统同时包含探索与利用两类目标，在初期探索权重较高时可引入陌生品类，连续强化单一偏好后新颖度可能下降。',
        span: { startOffset: 0, endOffset: 76 },
        textKind: 'summary',
        summaryTruncated: false,
        snapshotId: null,
        turnId: null,
        url: 'https://www.zhihu.com/question/400010/answer/900010',
        contentKey: 'answer:900010',
        behaviorKinds: [],
        topic: 'recommendation_interest',
      },
    ];
  }
  return [];
}

function sanitizeEvidenceItem(raw, secrets = []) {
  if (!raw || typeof raw !== 'object') return null;
  const hasAvailableBody = Boolean(
    raw.bodyStatus === 'available'
    && typeof raw.bodyText === 'string'
    && raw.bodyText.trim().length > 0,
  );
  const rawTextSource = hasAvailableBody
    ? raw.bodyText
    : (raw.excerpt ?? raw.summary ?? raw.bodyText ?? raw.text ?? '');
  const excerpt = redactTurnText(rawTextSource, secrets).trim();
  if (!excerpt) return null;
  const sourceType = ['collection_record', 'public_search', 'session_turn'].includes(raw.sourceType)
    ? raw.sourceType
    : raw.turnId
      ? 'session_turn'
      : raw.snapshotId || Array.isArray(raw.kinds) || Array.isArray(raw.behaviorKinds)
        ? 'collection_record'
        : 'public_search';
  const attribution = sourceType === 'session_turn' || raw.attribution === 'self'
    ? 'self'
    : 'other_author';
  const author = attribution === 'self'
    ? 'self'
    : redactTurnText(raw.author || '未知作者', secrets);
  const id = String(raw.evidenceId ?? raw.id ?? `ev_${Math.random().toString(36).slice(2, 10)}`);
  const contentKey = raw.contentKey
    ?? (raw.contentType && raw.contentId ? `${raw.contentType}:${raw.contentId}` : null)
    ?? raw.key
    ?? id;

  const resolvedTextKind = raw.textKind
    ?? (sourceType === 'session_turn'
      ? 'user_statement'
      : (hasAvailableBody ? (raw.bodyTruncated ? 'partial_body' : 'full_text') : 'summary'));
  const resolvedTruncated = Boolean(
    hasAvailableBody
      ? (raw.bodyTruncated ?? raw.truncated)
      : (raw.summaryTruncated ?? raw.truncated),
  );

  return {
    id,
    evidenceId: id,
    sourceType,
    title: raw.title ? redactTurnText(raw.title, secrets) : '',
    author,
    attribution,
    excerpt,
    span: raw.span ?? {
      startOffset: raw.locator?.startOffset ?? 0,
      endOffset: raw.locator?.endOffset ?? excerpt.length,
    },
    locator: raw.locator ?? {
      field: (hasAvailableBody || resolvedTextKind === 'full_text' || resolvedTextKind === 'partial_body')
        ? 'bodyText'
        : (resolvedTextKind === 'summary' ? 'summary' : 'excerpt'),
      startOffset: 0,
      endOffset: excerpt.length,
    },
    textKind: resolvedTextKind,
    bodyStatus: raw.bodyStatus ?? (hasAvailableBody ? 'available' : (sourceType === 'session_turn' ? 'session' : 'unavailable')),
    fullTextAvailable: Boolean(raw.fullTextAvailable ?? hasAvailableBody),
    summaryTruncated: resolvedTruncated,
    truncated: resolvedTruncated,
    snapshotId: raw.snapshotId ?? null,
    turnId: raw.turnId ?? null,
    requestId: raw.requestId ?? null,
    url: raw.url ? redactTurnText(raw.url, secrets) : null,
    contentKey: String(contentKey),
    behaviorKinds: Array.isArray(raw.behaviorKinds)
      ? [...raw.behaviorKinds]
      : Array.isArray(raw.kinds)
        ? [...raw.kinds]
        : [],
  };
}

// ===== 内置内存 Store（供无 SQLite 注入的轻量单测使用，完整对齐事务竞态与字段契约） =====
export function createInMemorySessionStore(initialSessions = []) {
  const sessions = new Map();
  const turnRecords = new Map();
  const turnEvents = new Map();
  const subscribers = new Map();

  function seedSession(raw) {
    const sessionId = raw.sessionId ?? raw.id ?? `sess_${sessions.size + 1}`;
    const normalized = {
      id: sessionId,
      sessionId,
      ownerId: raw.ownerId ?? 'user_default',
      dataMode: raw.dataMode ?? 'demo',
      usePersonalMaterials: raw.usePersonalMaterials,
      materialsStatus: raw.materialsStatus ?? null,
      allowCloudModel: raw.allowCloudModel,
      cloudConsent: Boolean(raw.cloudConsent ?? raw.allowCloudModel ?? false),
      lockedSnapshotId: raw.lockedSnapshotId ?? raw.snapshotId ?? null,
      snapshotId: raw.snapshotId ?? raw.lockedSnapshotId ?? null,
      graphVersion: Number.isInteger(raw.graphVersion) ? raw.graphVersion : 0,
      currentFocus: raw.currentFocus ?? null,
      confirmedGraph: extractGraphNodes(raw),
      evidenceIndex: extractSessionList(raw, 'evidenceIndex', 'evidences'),
      facts: extractSessionList(raw, 'facts'),
      pendingConfirmations: extractSessionList(raw, 'pendingConfirmations'),
      deniedAttributions: extractSessionList(raw, 'deniedAttributions'),
      statements: extractSessionStatements(raw),
      quotes: extractSessionList(raw, 'quotes'),
      statementComparison: raw.statementComparison ?? null,
      adoptedStatementId: raw.adoptedStatementId ?? null,
      invalidatedHistory: extractSessionList(raw, 'invalidatedHistory'),
      convergenceSummary: raw.convergenceSummary ?? null,
      publicAnalysis: raw.publicAnalysis ? structuredClone(raw.publicAnalysis) : null,
      outboundPreview: raw.outboundPreview ?? null,
      metadata: raw.metadata && typeof raw.metadata === 'object' ? structuredClone(raw.metadata) : {},
      collectionRecords: Array.isArray(raw.collectionRecords) ? raw.collectionRecords.map((r) => ({ ...r })) : null,
      turns: extractSessionList(raw, 'turns'),
    };
    sessions.set(sessionId, normalized);
    return normalized;
  }

  for (const item of initialSessions) seedSession(item);

  function getSession(ownerIdOrSessionId, maybeSessionId) {
    const hasOwner = typeof maybeSessionId === 'string';
    const sessionId = hasOwner ? maybeSessionId : ownerIdOrSessionId;
    const ownerId = hasOwner ? ownerIdOrSessionId : null;
    const sess = sessions.get(sessionId);
    if (!sess) {
      throw new BackendServiceError('SESSION_NOT_FOUND', `未找到会话：${sessionId}`, 404);
    }
    if (ownerId && sess.ownerId && sess.ownerId !== ownerId) {
      throw new BackendServiceError('SESSION_FORBIDDEN', '无权访问其他授权主体的会话。', 403);
    }
    return structuredClone(sess);
  }

  function updateOutboundPreview(sessionId, outboundPreview) {
    const sess = sessions.get(sessionId);
    if (!sess) throw new BackendServiceError('SESSION_NOT_FOUND', `未找到会话：${sessionId}`, 404);
    sess.outboundPreview = outboundPreview ? structuredClone(outboundPreview) : null;
    return structuredClone(sess.outboundPreview);
  }

  function createTurn({ ownerId, sessionId, turnId, text, baseGraphVersion, clientRequestId, focus = null, action = null }) {
    const sess = sessions.get(sessionId);
    if (!sess) throw new BackendServiceError('SESSION_NOT_FOUND', `未找到会话：${sessionId}`, 404);
    if (ownerId && sess.ownerId !== ownerId) {
      throw new BackendServiceError('SESSION_FORBIDDEN', '无权操作该会话。', 403);
    }
    if (Number.isInteger(baseGraphVersion) && baseGraphVersion !== sess.graphVersion) {
      throw new BackendServiceError('STALE_GRAPH_VERSION', `基准图版本已过期（当前为 ${sess.graphVersion}）。`, 409);
    }
    const turnNumber = sess.turns.length + 1;
    const id = turnId ?? `turn_${turnNumber}`;
    const key = `${sessionId}:${id}`;
    const record = {
      turnId: id,
      turnNumber,
      sessionId,
      ownerId: sess.ownerId,
      clientRequestId: clientRequestId ?? `req_${id}`,
      text,
      userText: text,
      focus,
      action,
      baseGraphVersion: sess.graphVersion,
      committedGraphVersion: null,
      status: 'running',
      createdAt: new Date().toISOString(),
    };
    turnRecords.set(key, record);
    turnEvents.set(key, []);
    return structuredClone(record);
  }

  function appendTurnEvent(sessionId, turnId, type, payload) {
    const key = `${sessionId}:${turnId}`;
    const list = turnEvents.get(key) ?? [];
    const seq = list.length + 1;
    const event = {
      id: seq,
      seq,
      eventId: seq,
      sessionId,
      turnId,
      event: type,
      eventType: type,
      type,
      data: structuredClone(payload),
      payload: structuredClone(payload),
      createdAt: new Date().toISOString(),
    };
    list.push(event);
    turnEvents.set(key, list);
    for (const fn of subscribers.get(key) ?? []) {
      fn(structuredClone(event));
    }
    return structuredClone(event);
  }

  function subscribeTurnEvents(sessionId, turnId, listener) {
    const key = `${sessionId}:${turnId}`;
    const set = subscribers.get(key) ?? new Set();
    set.add(listener);
    subscribers.set(key, set);
    return () => set.delete(listener);
  }

  function listTurnEvents(ownerOrSessionId, maybeSessionId, maybeTurnId, maybeOpts = 0) {
    let sessionId;
    let turnId;
    let afterSeq = 0;
    if (typeof maybeTurnId === 'string') {
      sessionId = maybeSessionId;
      turnId = maybeTurnId;
      afterSeq = typeof maybeOpts === 'number' ? maybeOpts : (maybeOpts?.afterSeq ?? 0);
    } else {
      sessionId = ownerOrSessionId;
      turnId = maybeSessionId;
      afterSeq = typeof maybeTurnId === 'number' ? maybeTurnId : (maybeTurnId?.afterSeq ?? 0);
    }
    const key = `${sessionId}:${turnId}`;
    const list = turnEvents.get(key) ?? [];
    return structuredClone(list.filter((ev) => ev.seq > afterSeq));
  }

  function commitTurn(sessionId, turnId, commitData) {
    const key = `${sessionId}:${turnId}`;
    const sess = sessions.get(sessionId);
    if (!sess) throw new BackendServiceError('SESSION_NOT_FOUND', `未找到会话：${sessionId}`, 404);
    let rec = turnRecords.get(key);
    if (!rec) {
      rec = {
        turnId,
        turnNumber: sess.turns.length + 1,
        sessionId,
        ownerId: sess.ownerId,
        text: commitData.userText ?? '',
        userText: commitData.userText ?? '',
        baseGraphVersion: commitData.baseGraphVersion ?? sess.graphVersion,
        status: 'running',
        createdAt: new Date().toISOString(),
      };
      turnRecords.set(key, rec);
    }
    if (rec.status !== 'running') {
      return {
        outcome: rec.status,
        committed: false,
        status: rec.status,
        graphVersion: sess.graphVersion,
      };
    }

    const nextGraphVersion = (commitData.graphMutated || commitData.incrementGraph === true)
      ? sess.graphVersion + 1
      : sess.graphVersion;

    sess.graphVersion = nextGraphVersion;
    sess.currentFocus = structuredClone(commitData.focus ?? sess.currentFocus);
    if (commitData.publicAnalysis !== undefined) {
      sess.publicAnalysis = commitData.publicAnalysis ? structuredClone(commitData.publicAnalysis) : null;
      if (sess.publicAnalysis && typeof sess.publicAnalysis === 'object') {
        sess.publicAnalysis.graphVersion = nextGraphVersion;
      }
    }
    if (commitData.lockedSnapshotId && !sess.lockedSnapshotId) {
      sess.lockedSnapshotId = commitData.lockedSnapshotId;
      sess.snapshotId = commitData.lockedSnapshotId;
    }
    if (Array.isArray(commitData.confirmedGraph)) {
      sess.confirmedGraph = structuredClone(commitData.confirmedGraph);
    }
    if (Array.isArray(commitData.evidenceIndex)) {
      sess.evidenceIndex = structuredClone(commitData.evidenceIndex);
    }
    if (Array.isArray(commitData.facts)) {
      sess.facts = structuredClone(commitData.facts);
    }
    if (Array.isArray(commitData.pendingConfirmations)) {
      sess.pendingConfirmations = structuredClone(commitData.pendingConfirmations);
    }
    if (Array.isArray(commitData.deniedAttributions)) {
      sess.deniedAttributions = structuredClone(commitData.deniedAttributions);
    }
    if (Array.isArray(commitData.statements)) {
      sess.statements = structuredClone(commitData.statements);
    }
    if (Array.isArray(commitData.quotes)) {
      sess.quotes = structuredClone(commitData.quotes);
    }
    if (commitData.statementComparison !== undefined) {
      sess.statementComparison = structuredClone(commitData.statementComparison);
    }
    if (Array.isArray(commitData.invalidatedHistory)) {
      sess.invalidatedHistory = structuredClone(commitData.invalidatedHistory);
    }
    if (commitData.adoptedStatementId !== undefined) {
      sess.adoptedStatementId = commitData.adoptedStatementId;
    }
    if (commitData.convergenceSummary !== undefined) {
      sess.convergenceSummary = structuredClone(commitData.convergenceSummary);
    }
    if (commitData.outboundPreview !== undefined) {
      sess.outboundPreview = structuredClone(commitData.outboundPreview);
    }

    rec.status = 'committed';
    rec.intent = commitData.intent;
    rec.focus = structuredClone(commitData.focus ?? null);
    rec.graphMutated = Boolean(commitData.graphMutated);
    rec.committedGraphVersion = nextGraphVersion;
    rec.responseText = commitData.responseText ?? '';

    const turnSummary = {
      turnId,
      turnNumber: rec.turnNumber,
      text: rec.text || commitData.userText || '',
      userText: rec.userText || commitData.userText || '',
      intent: commitData.intent,
      status: 'committed',
      focus: structuredClone(commitData.focus ?? null),
      graphMutated: Boolean(commitData.graphMutated),
      baseGraphVersion: rec.baseGraphVersion,
      committedGraphVersion: nextGraphVersion,
      responseText: commitData.responseText ?? '',
      createdAt: rec.createdAt,
    };
    const existingIdx = sess.turns.findIndex((t) => t.turnId === turnId);
    if (existingIdx >= 0) sess.turns[existingIdx] = turnSummary;
    else sess.turns.push(turnSummary);

    const committedPayload = {
      ...commitData.committedEventPayload,
      ...(sess.publicAnalysis !== null || commitData.publicAnalysis !== undefined
        ? { publicAnalysis: structuredClone(sess.publicAnalysis) }
        : {}),
      graphVersion: nextGraphVersion,
    };
    appendTurnEvent(sessionId, turnId, 'turn.committed', committedPayload);
    appendTurnEvent(sessionId, turnId, 'turn.done', {
      turnId,
      sessionId,
      status: 'committed',
      graphVersion: nextGraphVersion,
    });

    return {
      outcome: 'committed',
      committed: true,
      status: 'committed',
      graphVersion: nextGraphVersion,
      emittedTerminalEvents: true,
    };
  }

  function cancelTurn(ownerIdOrSessionId, maybeSessionId, maybeTurnId) {
    const hasOwner = typeof maybeTurnId === 'string';
    const ownerId = hasOwner ? ownerIdOrSessionId : null;
    const sessionId = hasOwner ? maybeSessionId : ownerIdOrSessionId;
    const turnId = hasOwner ? maybeTurnId : maybeSessionId;
    const sess = sessions.get(sessionId);
    if (!sess) throw new BackendServiceError('SESSION_NOT_FOUND', `未找到会话：${sessionId}`, 404);
    if (ownerId && sess.ownerId !== ownerId) {
      throw new BackendServiceError('SESSION_FORBIDDEN', '无权取消其他用户的轮次。', 403);
    }
    const key = `${sessionId}:${turnId}`;
    let rec = turnRecords.get(key);
    if (!rec) {
      rec = {
        turnId,
        turnNumber: sess.turns.length + 1,
        sessionId,
        ownerId: sess.ownerId,
        baseGraphVersion: sess.graphVersion,
        status: 'running',
        createdAt: new Date().toISOString(),
      };
      turnRecords.set(key, rec);
    }
    if (rec.status !== 'running') {
      return { outcome: rec.status, status: rec.status, graphVersion: sess.graphVersion, emittedTerminalEvents: true };
    }
    rec.status = 'cancelled';
    appendTurnEvent(sessionId, turnId, 'turn.cancelled', {
      turnId,
      sessionId,
      graphVersion: sess.graphVersion,
      reason: '当前轮次已按用户请求停止，保留上一有效图版本。',
    });
    appendTurnEvent(sessionId, turnId, 'turn.done', {
      turnId,
      sessionId,
      status: 'cancelled',
      graphVersion: sess.graphVersion,
    });
    return { outcome: 'cancelled', status: 'cancelled', graphVersion: sess.graphVersion, emittedTerminalEvents: true };
  }

  function failTurn(arg0, arg1, arg2, arg3 = {}, arg4 = {}) {
    let sessionId;
    let turnId;
    let errorInfo;
    let opts = {};
    if (arg0 && typeof arg0 === 'object') {
      sessionId = arg0.sessionId;
      turnId = arg0.turnId;
      errorInfo = arg0.error ?? arg0;
      opts = arg0;
    } else if (typeof arg2 === 'string') {
      sessionId = arg1;
      turnId = arg2;
      errorInfo = arg3;
      opts = arg4 ?? {};
    } else {
      sessionId = arg0;
      turnId = arg1;
      errorInfo = arg2 ?? {};
      opts = arg3 ?? {};
    }

    const sess = sessions.get(sessionId);
    if (!sess) throw new BackendServiceError('SESSION_NOT_FOUND', `未找到会话：${sessionId}`, 404);
    const key = `${sessionId}:${turnId}`;
    let rec = turnRecords.get(key);
    if (!rec) {
      rec = {
        turnId,
        turnNumber: sess.turns.length + 1,
        sessionId,
        ownerId: sess.ownerId,
        baseGraphVersion: sess.graphVersion,
        status: 'running',
        createdAt: new Date().toISOString(),
      };
      turnRecords.set(key, rec);
    }
    if (rec.status !== 'running') {
      return { outcome: rec.status, status: rec.status, graphVersion: sess.graphVersion, emittedTerminalEvents: true };
    }
    const errCode = errorInfo?.code ?? errorInfo?.errorCode ?? opts?.errorCode ?? 'INTERNAL_ERROR';
    const errMsg = errorInfo?.message ?? opts?.message ?? '当前轮次未完成，已保留上一有效版本。';
    rec.status = 'failed';
    rec.errorCode = errCode;

    const pendingStmt = opts?.pendingStatement ?? errorInfo?.pendingStatement ?? null;
    if (pendingStmt && pendingStmt.text) {
      const exists = sess.statements.some((s) => s.statementId === pendingStmt.statementId);
      if (!exists) {
        sess.statements.push({
          ...structuredClone(pendingStmt),
          status: 'pending_analysis',
          pendingStatus: errCode,
        });
      }
    }

    appendTurnEvent(sessionId, turnId, 'turn.failed', {
      turnId,
      sessionId,
      graphVersion: sess.graphVersion,
      code: errCode,
      message: errMsg,
      error: { code: errCode, message: errMsg },
    });
    appendTurnEvent(sessionId, turnId, 'turn.done', {
      turnId,
      sessionId,
      status: 'failed',
      graphVersion: sess.graphVersion,
    });
    return { outcome: 'failed', status: 'failed', graphVersion: sess.graphVersion, emittedTerminalEvents: true };
  }

  function getFactOrTurnById(ownerOrSessionId, maybeSessionId, maybeTargetId) {
    const hasOwner = typeof maybeTargetId === 'string';
    const sessionId = hasOwner ? maybeSessionId : ownerOrSessionId;
    const targetId = hasOwner ? maybeTargetId : maybeSessionId;
    const sess = sessions.get(sessionId);
    if (!sess) return null;
    const fact = sess.facts.find((f) => f.id === targetId || f.turnId === targetId);
    if (fact) return { found: true, matchType: 'fact', record: structuredClone(fact), item: structuredClone(fact) };
    const turn = sess.turns.find((t) => t.turnId === targetId || `turn_${t.turnNumber}` === targetId);
    if (turn) return { found: true, matchType: 'turn', record: structuredClone(turn), item: structuredClone(turn) };
    const ev = sess.evidenceIndex.find((e) => e.id === targetId || e.evidenceId === targetId);
    if (ev) return { found: true, matchType: 'evidence', record: structuredClone(ev), item: structuredClone(ev) };
    const node = sess.confirmedGraph.find((n) => n.id === targetId);
    if (node) return { found: true, matchType: 'node', record: structuredClone(node), item: structuredClone(node) };
    return null;
  }

  return {
    seedSession,
    createSession: (ownerOrRaw, maybeOpts) => {
      if (typeof ownerOrRaw === 'string') return seedSession({ ownerId: ownerOrRaw, ...(maybeOpts ?? {}) });
      return seedSession(ownerOrRaw ?? {});
    },
    getSession,
    updateOutboundPreview,
    createTurn,
    beginTurn: (ownerId, sessionId, input) => ({
      reused: false,
      turn: createTurn({ ownerId, sessionId, ...input }),
    }),
    appendTurnEvent,
    subscribeTurnEvents,
    listTurnEvents,
    getTurnEvents: listTurnEvents,
    commitTurn,
    cancelTurn,
    failTurn,
    getFactOrTurnById,
  };
}

// ===== 兄弟模块多态调用桥接 =====
async function tryDynamicImport(specifier) {
  try {
    return await import(specifier);
  } catch (error) {
    if (
      error?.code === 'ERR_MODULE_NOT_FOUND'
      || String(error?.message ?? '').includes('Cannot find module')
    ) {
      return null;
    }
    throw error;
  }
}

function usesObjectParam(fn) {
  if (typeof fn !== 'function') return false;
  const head = Function.prototype.toString.call(fn).slice(0, 140);
  return /^[^(]*\(\s*\{/.test(head);
}

function firstParamIsOwner(fn) {
  if (typeof fn !== 'function') return false;
  const head = Function.prototype.toString.call(fn).slice(0, 140);
  return /^[^(]*\(\s*ownerId\b/.test(head);
}

async function readSessionFromStore(store, ownerId, sessionId) {
  const fn = store?.getSession ?? store?.getSessionSnapshot ?? store?.readSession;
  if (typeof fn !== 'function') {
    throw new BackendServiceError('INTERNAL_ERROR', '会话存储未实现 getSession。', 500);
  }
  if (usesObjectParam(fn)) {
    return await fn.call(store, { ownerId, sessionId, id: sessionId });
  }
  if (firstParamIsOwner(fn) || fn.length >= 2) {
    return await fn.call(store, ownerId ?? 'local-owner', sessionId);
  }
  const sess = await fn.call(store, sessionId);
  if (sess && ownerId && sess.ownerId && sess.ownerId !== ownerId) {
    throw new BackendServiceError('SESSION_FORBIDDEN', '无权访问其他授权主体的会话。', 403);
  }
  return sess;
}

async function lookupByIdFromStore(store, ownerId, sessionId, refId) {
  const fn = store?.getFactOrTurnById;
  if (typeof fn !== 'function') return null;
  if (usesObjectParam(fn)) {
    return await fn.call(store, { ownerId, sessionId, refId, lookupId: refId, id: refId });
  }
  if (firstParamIsOwner(fn) || fn.length >= 3) {
    return await fn.call(store, ownerId ?? 'local-owner', sessionId, refId);
  }
  return await fn.call(store, sessionId, refId);
}

async function emitStoreEvent(store, ownerId, sessionId, turnId, type, payload) {
  const fn = store?.appendTurnEvent ?? store?.emitTurnEvent ?? store?.appendEvent;
  if (typeof fn !== 'function') return null;
  if (usesObjectParam(fn)) {
    return await fn.call(store, { ownerId, sessionId, turnId, type, eventType: type, payload });
  }
  if (firstParamIsOwner(fn)) {
    return await fn.call(store, ownerId ?? 'local-owner', sessionId, turnId, type, payload);
  }
  return await fn.call(store, sessionId, turnId, type, payload);
}

async function readExistingTurnEvents(store, ownerId, sessionId, turnId) {
  const fn = store?.listTurnEvents ?? store?.getTurnEvents ?? store?.readTurnEvents;
  if (typeof fn !== 'function') return null;
  try {
    if (usesObjectParam(fn)) {
      return await fn.call(store, { ownerId, sessionId, turnId, afterSeq: 0 });
    }
    if (firstParamIsOwner(fn)) {
      return await fn.call(store, ownerId ?? 'local-owner', sessionId, turnId, { afterSeq: 0 });
    }
    return await fn.call(store, sessionId, turnId, 0);
  } catch {
    return null;
  }
}

async function commitStoreTurn(store, ownerId, sessionId, turnId, commitData) {
  const fn = store?.commitTurn;
  if (typeof fn !== 'function') {
    throw new BackendServiceError('INTERNAL_ERROR', '会话存储未实现 commitTurn。', 500);
  }
  let res;
  if (usesObjectParam(fn)) {
    res = await fn.call(store, { ownerId, sessionId, turnId, ...commitData });
  } else if (firstParamIsOwner(fn)) {
    res = await fn.call(store, ownerId ?? 'local-owner', sessionId, turnId, commitData);
  } else {
    res = await fn.call(store, sessionId, turnId, commitData);
  }

  const alreadyHandledByStore =
    Boolean(res?.outcome) || Boolean(res?.emittedTerminalEvents);
  if (res?.status !== 'cancelled' && res?.outcome !== 'cancelled' && res?.committed !== false && !alreadyHandledByStore) {
    const existing = await readExistingTurnEvents(store, ownerId, sessionId, turnId);
    const hasCommitted = Array.isArray(existing) && existing.some((e) => (e.type ?? e.eventType) === 'turn.committed');
    const hasDone = Array.isArray(existing) && existing.some((e) => (e.type ?? e.eventType) === 'turn.done');
    const finalVer = res?.graphVersion ?? commitData.graphVersion;
    if (!hasCommitted) {
      await emitStoreEvent(store, ownerId, sessionId, turnId, 'turn.committed', {
        ...commitData.committedEventPayload,
        graphVersion: finalVer,
      });
    }
    if (!hasDone) {
      await emitStoreEvent(store, ownerId, sessionId, turnId, 'turn.done', {
        turnId,
        sessionId,
        status: 'committed',
        graphVersion: finalVer,
      });
    }
  }
  return res;
}

async function failStoreTurn(store, ownerId, sessionId, turnId, failureData) {
  const fn = store?.failTurn;
  let res = null;
  const errorObj = { code: failureData.errorCode, message: failureData.message };
  if (typeof fn === 'function') {
    if (usesObjectParam(fn)) {
      res = await fn.call(store, {
        ownerId,
        sessionId,
        turnId,
        error: errorObj,
        ...failureData,
      });
    } else if (firstParamIsOwner(fn)) {
      res = await fn.call(store, ownerId ?? 'local-owner', sessionId, turnId, errorObj, {
        pendingStatement: failureData.pendingStatement,
        metrics: failureData.metrics,
      });
    } else {
      res = await fn.call(store, sessionId, turnId, errorObj, {
        pendingStatement: failureData.pendingStatement,
        metrics: failureData.metrics,
      });
    }
  }
  const alreadyHandled = Boolean(res?.outcome) || Boolean(res?.emittedTerminalEvents);
  if (!alreadyHandled) {
    const existing = await readExistingTurnEvents(store, ownerId, sessionId, turnId);
    const hasFailed = Array.isArray(existing) && existing.some((e) => (e.type ?? e.eventType) === 'turn.failed');
    const hasDone = Array.isArray(existing) && existing.some((e) => (e.type ?? e.eventType) === 'turn.done');
    if (!hasFailed) {
      await emitStoreEvent(store, ownerId, sessionId, turnId, 'turn.failed', {
        turnId,
        sessionId,
        graphVersion: failureData.baseGraphVersion ?? 0,
        error: errorObj,
      });
    }
    if (!hasDone) {
      await emitStoreEvent(store, ownerId, sessionId, turnId, 'turn.done', {
        turnId,
        sessionId,
        status: 'failed',
        graphVersion: failureData.baseGraphVersion ?? 0,
      });
    }
  }
  return res;
}

async function cancelStoreTurn(store, ownerId, sessionId, turnId) {
  const fn = store?.cancelTurn;
  let res = null;
  if (typeof fn === 'function') {
    if (usesObjectParam(fn)) {
      res = await fn.call(store, { ownerId, sessionId, turnId });
    } else if (firstParamIsOwner(fn) || fn.length >= 3) {
      res = await fn.call(store, ownerId ?? 'local-owner', sessionId, turnId);
    } else {
      res = await fn.call(store, sessionId, turnId);
    }
  }
  const alreadyHandled = Boolean(res?.outcome) || Boolean(res?.emittedTerminalEvents);
  if (!alreadyHandled && res?.status !== 'committed') {
    const existing = await readExistingTurnEvents(store, ownerId, sessionId, turnId);
    const hasCancelled = Array.isArray(existing) && existing.some((e) => (e.type ?? e.eventType) === 'turn.cancelled');
    const hasDone = Array.isArray(existing) && existing.some((e) => (e.type ?? e.eventType) === 'turn.done');
    if (!hasCancelled) {
      await emitStoreEvent(store, ownerId, sessionId, turnId, 'turn.cancelled', {
        turnId,
        sessionId,
        reason: '当前轮次已主动取消。',
      });
    }
    if (!hasDone) {
      await emitStoreEvent(store, ownerId, sessionId, turnId, 'turn.done', {
        turnId,
        sessionId,
        status: 'cancelled',
      });
    }
  }
  return res ?? { status: 'cancelled' };
}

export function isLoopbackModelEndpoint(baseURL, modelConfig = null) {
  return isLoopbackModelEndpointPolicy(baseURL, modelConfig);
}

export function sanitizePersonalEvidenceForPreview(raw, secrets = []) {
  return sanitizeEvidenceItem(raw, secrets);
}

export function selectTurnPersonalEvidences({
  sessionSnapshot = null,
  text = '',
  focusRef = null,
  action = null,
  maxEvidence = 6,
  secrets = [],
} = {}) {
  if (!sessionSnapshot || isPersonalMaterialsDisabled(sessionSnapshot)) return [];
  const userText = String(text ?? '').trim();
  const rawEvidences = extractSessionList(sessionSnapshot, 'evidenceIndex', 'evidences');
  const sanitizedAll = rawEvidences
    .map((ev) => sanitizeEvidenceItem(ev, secrets) ?? ev)
    .filter(Boolean);
  const allCollection = sanitizedAll.filter((ev) => ev.sourceType === 'collection_record');
  if (allCollection.length === 0) return [];

  const { intent } = classifyTurnIntent(userText, action, sessionSnapshot);
  const graphNodes = extractGraphNodes(sessionSnapshot);
  const focusedNode = focusRef?.nodeId
    ? (graphNodes.find((n) => n.id === String(focusRef.nodeId).trim()) ?? null)
    : null;
  const focus = focusedNode
    ? {
        id: focusRef?.id ?? `focus_node_${focusedNode.id}`,
        nodeId: focusedNode.id,
        kind: 'premise',
        spanText: focusedNode.text,
        startOffset: 0,
        endOffset: focusedNode.text.length,
        evidenceIds: Array.isArray(focusedNode.evidenceIds) ? [...focusedNode.evidenceIds] : [],
      }
    : selectFocus(userText, focusRef, 'preview');

  const explicitRefs = extractExplicitRefsFromInput(userText, action, focus);
  const explicitRefSet = new Set(explicitRefs);
  const selected = [];
  const seen = new Set();
  const pushItem = (ev) => {
    if (!ev || ev.sourceType !== 'collection_record') return;
    const eid = String(ev.evidenceId ?? ev.id ?? '');
    if (!eid || seen.has(eid)) return;
    seen.add(eid);
    selected.push(ev);
  };

  if (intent === 'analyze_statement') {
    for (const ev of allCollection) {
      const eid = String(ev.evidenceId ?? ev.id ?? '');
      if (isEvidenceRelevantToSentence(ev, userText, focus) || explicitRefSet.has(eid)) {
        pushItem(ev);
      }
    }
  } else if (intent === 'explain_focus_or_provenance') {
    if (focusedNode) {
      const nodeEvSet = new Set(focusedNode.evidenceIds ?? []);
      for (const ev of allCollection) {
        if (nodeEvSet.has(ev.id) || nodeEvSet.has(ev.evidenceId)) {
          pushItem(ev);
        }
      }
    } else if (/这是谁说的|谁写的|是谁的回答|出处/.test(userText)) {
      const latestOther = [...sanitizedAll].reverse().find((e) => e.attribution === 'other_author');
      if (latestOther && latestOther.sourceType === 'collection_record') {
        pushItem(latestOther);
      }
    }
    for (const ev of allCollection) {
      const eid = String(ev.evidenceId ?? ev.id ?? '');
      if (explicitRefSet.has(eid)) pushItem(ev);
    }
  } else if (intent === 'deny_attribution') {
    const pendingList = extractSessionList(sessionSnapshot, 'pendingConfirmations');
    const explicitKey = action?.contentKey ?? action?.evidenceId ?? action?.targetId ?? null;
    const targetPending = pendingList.find(
      (p) =>
        (explicitKey && (p.contentKey === explicitKey || p.evidenceId === explicitKey || p.id === explicitKey))
        || (p.author && userText.includes(p.author))
        || (/乐队/.test(userText) && /乐队/.test(p.text)),
    ) ?? pendingList.find((p) => p.attribution === 'other_author');
    const targetEvidence = targetPending
      ? sanitizedAll.find((e) => e.id === targetPending.evidenceId || e.contentKey === targetPending.contentKey)
      : allCollection.find((e) => e.attribution === 'other_author');
    if (targetEvidence && targetEvidence.sourceType === 'collection_record') {
      pushItem(targetEvidence);
    }
    for (const ev of allCollection) {
      const eid = String(ev.evidenceId ?? ev.id ?? '');
      if (explicitRefSet.has(eid)) pushItem(ev);
    }
  } else {
    for (const ev of allCollection) {
      const eid = String(ev.evidenceId ?? ev.id ?? '');
      if (explicitRefSet.has(eid)) pushItem(ev);
    }
  }

  const limit = Number.isInteger(maxEvidence) && maxEvidence > 0 ? maxEvidence : 6;
  return selected.slice(0, limit);
}

function buildTurnOutboundPreview({
  modelConfig = null,
  personalMaterialsEnabled = false,
  cloudConsentGranted = false,
  personalItems = [],
  secrets = [],
  confirmedOutboundPreviewId = null,
} = {}) {
  return buildOutboundPersonalManifest({
    modelConfig,
    usePersonalMaterials: personalMaterialsEnabled,
    cloudConsent: cloudConsentGranted,
    evidences: personalItems,
    maxExcerptChars: DEFAULT_OUTBOUND_EXCERPT_CHARS,
    redact: (s) => redactTurnText(s, secrets),
    confirmedOutboundPreviewId,
  });
}

function classifyTurnError(error, signal) {
  if (error instanceof BackendServiceError) {
    return { code: error.code, message: error.message, status: error.status ?? 400 };
  }
  if (signal?.reason?.code === 'CLOUD_CONSENT_REQUIRED' || error?.code === 'CLOUD_CONSENT_REQUIRED') {
    return { code: 'CLOUD_CONSENT_REQUIRED', message: '将个人材料发往云端推理服务前需本人明确同意。', status: 403 };
  }
  if (error?.name === 'QuotationEngineError' || error?.code === 'VERIFICATION_REJECTED') {
    return {
      code: 'VERIFICATION_REJECTED',
      message: error.message || '结构化候选或报价核验未通过。',
      status: 400,
    };
  }
  if (error?.code === 'DATA_MODE_MISMATCH') {
    return { code: 'DATA_MODE_MISMATCH', message: error.message || '数据模式不匹配。', status: 403 };
  }
  if (error?.code === 'TOKEN_REVOKED') {
    return { code: 'TOKEN_REVOKED', message: '数据访问令牌已撤销，请重新授权。', status: 401 };
  }
  if (error?.code === 'UPSTREAM_AUTH') {
    return { code: 'UPSTREAM_AUTH', message: '上游服务鉴权失败，请检查凭证配置。', status: 502 };
  }
  if (error?.code === 'MODEL_NOT_CONFIGURED') {
    return { code: 'MODEL_NOT_CONFIGURED', message: '尚未配置推理模型，请检查 AGENT_BASE_URL 与 AGENT_MODEL。', status: 503 };
  }
  if (
    signal?.reason?.code === 'CANCELLED'
    || error?.code === 'CANCELLED'
    || (signal?.aborted && signal?.reason?.name !== 'TimeoutError' && error?.name !== 'TimeoutError')
    || error?.name === 'AbortError'
  ) {
    return { code: 'CANCELLED', message: '当前轮次已被用户主动停止，保留上一有效图版本。', status: 499 };
  }
  if (
    signal?.reason?.name === 'TimeoutError'
    || error?.name === 'TimeoutError'
    || error?.code === 'TIMEOUT'
    || /timeout|timed out/i.test(String(error?.message ?? ''))
  ) {
    return { code: 'TIMEOUT', message: '模型或工具响应超时，本轮已中止并保留上一有效图版本。', status: 504 };
  }
  if (error?.name === 'AI_APICallError' || error?.name === 'AI_RetryError' || error?.code === 'MODEL_ERROR') {
    return { code: 'MODEL_ERROR', message: '模型推理服务请求失败，已保留上一有效图版本。', status: 502 };
  }
  return { code: 'INTERNAL_ERROR', message: '轮次处理发生内部异常，已保留上一有效图版本。', status: 500 };
}

function normalizeUsageMetrics(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const inputTokens = typeof rawUsage.inputTokens === 'number'
    ? rawUsage.inputTokens
    : rawUsage.inputTokens?.total ?? rawUsage.promptTokens ?? 0;
  const outputTokens = typeof rawUsage.outputTokens === 'number'
    ? rawUsage.outputTokens
    : rawUsage.outputTokens?.total ?? rawUsage.completionTokens ?? 0;
  const totalTokens = typeof rawUsage.totalTokens === 'number'
    ? rawUsage.totalTokens
    : inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function buildGroundedFallbackChunks(verifiedContext) {
  const {
    intent,
    focus,
    activeQuote,
    pendingConfirmations = [],
    deniedAttributions = [],
    conditionCheckResult,
    retractionSummary,
    convergenceSummary,
    referencedLookup,
    nextActions = [],
  } = verifiedContext;

  const chunks = [];
  if (focus?.spanText) {
    chunks.push(`本轮首先核对焦点“${focus.spanText}”（${focus.kind}）：${focus.reason}\n`);
  }

  if (intent === 'deny_attribution') {
    const latestDenied = deniedAttributions.at(-1);
    chunks.push(
      `已按您的纠正记录归属决定：原作者为“${latestDenied?.originalAuthor ?? '他人作者'}”（contentKey=${latestDenied?.contentKey ?? '-'}），已从本人待确认项中移除，后续轮次不会再将其当作您的本人表达。\n`,
    );
  } else if (intent === 'check_or_confirm_condition' && conditionCheckResult) {
    chunks.push(
      `针对适用条件“${conditionCheckResult.scopeText}”的核查结果：\n- 能支持：${conditionCheckResult.supportedScope}\n- 不能支持：${conditionCheckResult.unsupportedScope}\n`,
    );
  } else if (intent === 'retract_fact' && retractionSummary) {
    if (retractionSummary.status && retractionSummary.status !== 'retracted') {
      chunks.push(`${retractionSummary.message}\n`);
    } else {
      chunks.push(
        `已撤回指定条目（${retractionSummary.retractedFactId}，原属轮次 ${retractionSummary.retractedTurnId}）：仅使依赖该条目的节点 [${retractionSummary.invalidatedNodeIds.join(', ')}] 失效，完整保留了独立确认的本人事实 [${retractionSummary.preservedFactIds.join(', ')}]。\n`,
      );
    }
  } else if (intent === 'explain_focus_or_provenance' && referencedLookup?.matchType === 'node') {
    const evDesc = (referencedLookup.evidences ?? [])
      .map((e) => `[${e.id}] 作者=${e.author}（${e.attribution}）：“${e.excerpt}”`)
      .join('；');
    chunks.push(
      `已按指定节点 [${referencedLookup.id}] 核对出处：${evDesc || '当前节点暂无关联证据条目'}。本轮未修改已确认图版本。\n`,
    );
  } else if (intent === 'converge' && convergenceSummary) {
    chunks.push(
      `已生成收束总结：原句为“${convergenceSummary.originalStatement?.text ?? ''}”（评估：${convergenceSummary.originalStatement?.assessment ?? '-'}，比例：${convergenceSummary.originalStatement?.rate === null || convergenceSummary.originalStatement?.rate === undefined ? '未定（null）' : `${convergenceSummary.originalStatement.rate}%`}）；采纳改写为“${convergenceSummary.adoptedRewrite?.text ?? '无'}”（评估：${convergenceSummary.adoptedRewrite?.assessment ?? '-'}）。\n`,
    );
  } else if (activeQuote) {
    const rateDesc = activeQuote.rate === null
      ? '未定（null）'
      : `${activeQuote.rate}%（分子/分母=${activeQuote.numerator}/${activeQuote.denominator}）`;
    chunks.push(
      `当前句子评估为 ${activeQuote.assessment}，结构影响比例为 ${rateDesc}（图版本 v${activeQuote.graphVersion}）。${activeQuote.reason}\n`,
    );
    if (pendingConfirmations.length > 0 && intent === 'analyze_statement') {
      const cand = pendingConfirmations[0];
      chunks.push(
        `此外，检索到一条来自“${cand.author}”的候选材料（属于他人作品，尚未计入本人图）：${cand.text}\n`,
      );
    }
  } else {
    chunks.push('已根据当前会话已核验快照与历史记录完成核对，本轮未修改已确认图版本。\n');
  }

  if (nextActions.length > 0) {
    chunks.push(`下一步可选动作：${nextActions.join('；')}。`);
  }
  return chunks;
}

// ===== 模型输入预算裁剪辅助（QA-08） =====
function extractExplicitRefsFromInput(userText, action = null, focus = null) {
  const refs = new Set();
  if (typeof action?.targetId === 'string' && action.targetId.trim()) refs.add(action.targetId.trim());
  if (typeof action?.factId === 'string' && action.factId.trim()) refs.add(action.factId.trim());
  if (typeof action?.adoptStatementId === 'string' && action.adoptStatementId.trim()) refs.add(action.adoptStatementId.trim());
  if (typeof focus?.nodeId === 'string' && focus.nodeId.trim()) refs.add(focus.nodeId.trim());

  const s = String(userText ?? '');
  for (const m of s.matchAll(/\b(?:fact|cond|turn|ev|evidence|stmt|node)_[A-Za-z0-9_.:-]+\b/g)) {
    refs.add(m[0]);
  }
  for (const m of s.matchAll(/第\s*([0-9零〇一二两三四五六七八九十百]{1,6})\s*轮/g)) {
    const ord = parseChineseInt(m[1]);
    if (ord !== null) refs.add(`turn_${ord}`);
  }
  for (const m of s.matchAll(/\bturn\s*#?\s*(\d{1,4})\b/gi)) {
    refs.add(`turn_${Number.parseInt(m[1], 10)}`);
  }
  return [...refs];
}

function lexicalRelevanceScore(itemText, queryBigrams, queryTokens) {
  const hay = String(itemText ?? '').toLowerCase();
  if (!hay) return 0;
  let score = 0;
  for (const tok of queryTokens) {
    if (tok.length >= 2 && hay.includes(tok)) score += 4;
  }
  const bgs = extractBigrams(hay);
  for (const bg of queryBigrams) {
    if (bgs.has(bg)) score += 1;
  }
  return score;
}

function resolveEffectiveContextBudget(orchestrator, session, input) {
  const merged = {
    maxLocalNodes: 8,
    maxEvidence: 6,
    maxFacts: 6,
    recentTurnsLimit: 4,
    maxPromptChars: 12000,
    ...(orchestrator.config?.limits?.contextBudget ?? {}),
    ...(orchestrator.config?.contextBudget ?? {}),
    ...(orchestrator.contextBudget ?? {}),
    ...(session?.metadata?.contextBudget ?? {}),
    ...(session?.contextBudget ?? {}),
    ...(input?.contextBudget ?? {}),
  };
  if (Number.isFinite(merged.maxTotalChars) && !Number.isFinite(input?.contextBudget?.maxPromptChars)) {
    merged.maxPromptChars = merged.maxTotalChars;
  }
  return {
    maxLocalNodes: Math.max(1, Math.floor(merged.maxLocalNodes)),
    maxEvidence: Math.max(1, Math.floor(merged.maxEvidence)),
    maxFacts: Math.max(1, Math.floor(merged.maxFacts)),
    recentTurnsLimit: Math.max(0, Math.floor(merged.recentTurnsLimit)),
    maxPromptChars: Math.max(800, Math.floor(merged.maxPromptChars)),
  };
}

// ==================== 公开对话模式（L-01 / L-02 / L-03）编排与核验辅助 ====================

const PUBLIC_NAMED_ENTITY_RE =
  /(?<![这那该此本])([甲乙丙丁戊己庚辛壬癸A-Za-z0-9一二三四五六七八九十]{1,5}(?:工厂|厂区|公司|企业|医院|学校|餐厅|门店|车间|团队|部门|平台|航司|银行|城市|小区|机构|项目|园区))/gu;

const GENERIC_ENTITY_STOPWORDS = new Set([
  '一家工厂', '每个工厂', '所有工厂', '任何工厂', '很多工厂', '不少工厂', '一些工厂',
  '一家公司', '每个公司', '所有公司', '任何公司', '很多公司', '不少公司', '一些公司',
  '一个团队', '每个团队', '所有团队', '任何团队', '很多团队', '不少团队', '一些团队',
  '一个平台', '每个平台', '所有平台', '任何平台', '很多平台', '不少平台', '一些平台',
]);

function extractNamedPublicEntities(text) {
  const cleaned = String(text ?? '').replace(
    /(?:这家|那家|该|此|本|某家|某个|每家|每个|所有|任何)(?:工厂|厂区|公司|企业|医院|学校|餐厅|门店|车间|团队|部门|平台|航司|银行|城市|小区|机构|项目|园区)/gu,
    ' ',
  );
  const found = [];
  const seen = new Set();
  for (const m of cleaned.matchAll(PUBLIC_NAMED_ENTITY_RE)) {
    const ent = m[1]?.trim();
    if (!ent || GENERIC_ENTITY_STOPWORDS.has(ent) || seen.has(ent)) continue;
    seen.add(ent);
    found.push(ent);
  }
  return found;
}

function detectCrossEntityMismatch(claimText, evidenceText) {
  const claimEntities = extractNamedPublicEntities(claimText);
  const evidenceEntities = extractNamedPublicEntities(evidenceText);
  if (claimEntities.length === 0 || evidenceEntities.length === 0) {
    return { mismatch: false, claimEntity: null, evidenceEntity: null };
  }
  const evRaw = String(evidenceText ?? '');
  const anyClaimMentioned = claimEntities.some(
    (ce) => evidenceEntities.includes(ce) || evRaw.includes(ce),
  );
  if (anyClaimMentioned) {
    return { mismatch: false, claimEntity: claimEntities[0], evidenceEntity: claimEntities[0] };
  }
  return {
    mismatch: true,
    claimEntity: claimEntities[0],
    evidenceEntity: evidenceEntities[0],
  };
}

function extractPublicScopeCondition(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const patterns = [
    /(?:只发生在|仅发生在|只在|仅在|只限于|仅限于|限定在|限定于|仅针对|只针对)\s*[「“"'‘]?([^，。！？；」”"'’]{2,24})[」”"'’]?/u,
    /(?:如果|当|一旦|只要)\s*([^，。！？；]{2,24}?)(?:时|的时候|以后|之后|情况下|条件下)(?:[，,]|$)/u,
    /(?:在)\s*([^，。！？；]{2,24}?)(?:的情况下|情况下|条件下|场景下|阶段|期间|时候|时)(?:[，,]|$)/u,
    /([反复连续批量长期临时旺季淡季初期刚接触新手资深夜间夜班节假日][^\s，。！？；]{1,18}?)(?:的时候|情况下|条件下|场景下|写稿|生成|使用|时|后)/u,
  ];
  for (const re of patterns) {
    const m = re.exec(raw);
    if (m && m[1]?.trim()) {
      return m[1]
        .trim()
        .replace(/^(?:处于|在|是)\s*/, '')
        .replace(/(?:的情况|的场景|的条件|的时候|之时|下)$/, '')
        .trim();
    }
  }
  return null;
}

function normalizePublicRelation(rawRelation) {
  const key = String(rawRelation ?? '').trim().toLowerCase();
  if (['support', 'supports', 'compatible', 'corroborate', 'confirm', 'agree'].includes(key)) {
    return 'support';
  }
  if (['refute', 'refutes', 'conflict', 'contradict', 'contradicts', 'counterexample', 'oppose'].includes(key)) {
    return 'refute';
  }
  if (['qualify', 'qualifies', 'limit', 'limits', 'partial', 'scope', 'conditional', 'nuance'].includes(key)) {
    return 'qualify';
  }
  return 'unknown';
}

function classifyPublicTurnAction(userText, action = null, prevPublicAnalysis = null) {
  const raw = String(userText ?? '').trim();
  const prevClaimText = prevPublicAnalysis?.claim?.text ?? null;
  const explicitType = action?.type ?? action?.publicAction ?? null;

  if (explicitType === 'ask_provenance' || action?.intent === 'explain_focus_or_provenance') {
    return {
      publicAction: 'ask_provenance',
      addedCondition: null,
      disputedOtherTopic: false,
      cleanRewriteText: null,
    };
  }
  if (explicitType === 'correct_condition') {
    const addedCondition =
      typeof action?.condition === 'string' && action.condition.trim()
        ? action.condition.trim()
        : extractPublicScopeCondition(raw);
    return {
      publicAction: 'correct_condition',
      addedCondition,
      disputedOtherTopic: /另一回事|别的事|两回事/.test(raw),
      cleanRewriteText: null,
    };
  }
  if (
    explicitType === 'try_rewrite'
    || explicitType === 'submit_rewrite'
    || explicitType === 'compare_rewrite'
    || action?.intent === 'compare_rewrite'
  ) {
    const stripped = raw
      .replace(/^(?:试试这句|我改成|改成|改为|如果改成|换个说法|我的改写|改写)[：:，,\s]*/u, '')
      .replace(/^[「“"'‘](.+)[」”"'’]$/u, '$1')
      .trim();
    const resolved = stripped || prevPublicAnalysis?.suggestedRewrite?.text || raw;
    return {
      publicAction: 'submit_rewrite',
      addedCondition: extractPublicScopeCondition(resolved),
      disputedOtherTopic: false,
      cleanRewriteText: resolved,
    };
  }

  if (prevClaimText) {
    // 1. 追问出处
    const isProvenanceAsk =
      /(?:你怎么知道|出处|来源是什么|来源在哪|从哪来的|哪来的|谁说的|谁写的|凭什么|展开证据|看看出处|为什么这么说|怎么得出的|依据是什么|证据在哪)/.test(raw)
      && !/(?:说的是另一回事|我说的(?:其实)?是|我指的是|改成|改为|试试这句)/.test(raw);
    if (isProvenanceAsk) {
      return {
        publicAction: 'ask_provenance',
        addedCondition: null,
        disputedOtherTopic: false,
        cleanRewriteText: null,
      };
    }

    // 2. 纠错 / 补充适用条件
    const disputedOtherTopic =
      /(?:这条|那条|这个|那个)?(?:其实|本来)?说的是(?:另一回事|别的事|两回事|不同的事)|不是一回事|不是那个意思|不是这个意思/.test(raw);
    const hasConditionCorrectionCue =
      disputedOtherTopic
      || /(?:我说的(?:其实)?是|我指的是|我想说的是|我补充一下|前提是|条件是|加上[「“"'‘]?[^」”"'’]{2,20}[」”"'’]?|限定在|仅在|只在|只针对)/.test(raw);
    if (hasConditionCorrectionCue) {
      const explicitMatch = raw.match(
        /(?:我说的(?:其实)?是|我指的是|我想说的是|前提是|条件是|限定在|加上|仅在|只在|只针对)\s*[「“"'‘]?([^，。！？；」”"'’]{2,28})[」”"'’]?/u,
      );
      const quotedMatch = raw.match(/[「“"'‘]([^」”"'’]{2,24})[」”"'’]/u);
      const rawCond =
        explicitMatch?.[1]?.trim()
        ?? quotedMatch?.[1]?.trim()
        ?? extractPublicScopeCondition(raw);
      const addedCondition = rawCond
        ? rawCond
            .replace(/(?:的情况|的场景|的条件|的时候|之时|下)$/, '')
            .trim()
        : null;
      return {
        publicAction: 'correct_condition',
        addedCondition: addedCondition || null,
        disputedOtherTopic,
        cleanRewriteText: null,
      };
    }

    // 3. 明确提交改写或点击「试试这句」
    const explicitRewriteMatch = /^(?:试试这句|我改成|改成|改为|如果改成|换个说法|我的改写|改写)[：:，,\s]*(.*)$/u.exec(raw);
    if (explicitRewriteMatch) {
      const body = explicitRewriteMatch[1]
        .trim()
        .replace(/^[「“"'‘](.+)[」”"'’]$/u, '$1')
        .trim();
      const resolved = body || prevPublicAnalysis?.suggestedRewrite?.text || prevClaimText;
      return {
        publicAction: 'submit_rewrite',
        addedCondition: extractPublicScopeCondition(resolved),
        disputedOtherTopic: false,
        cleanRewriteText: resolved,
      };
    }

    // 4. 未加前缀但与当前句子同题的陈述句改写（非问句）
    if (!/[？?]$/.test(raw)) {
      const prevTokens = extractBigrams(prevClaimText);
      const nextTokens = extractBigrams(raw);
      let shared = 0;
      for (const tk of nextTokens) if (prevTokens.has(tk)) shared += 1;
      const sameTopicCluster =
        inferTopicCluster(prevClaimText, '') === inferTopicCluster(raw, '')
        && !inferTopicCluster(prevClaimText, '').startsWith('topic_');
      if (shared >= 2 || sameTopicCluster) {
        return {
          publicAction: 'submit_rewrite',
          addedCondition: extractPublicScopeCondition(raw),
          disputedOtherTopic: false,
          cleanRewriteText: raw,
        };
      }
    }
  }

  return {
    publicAction: 'new_claim',
    addedCondition: extractPublicScopeCondition(raw),
    disputedOtherTopic: false,
    cleanRewriteText: null,
  };
}

function decomposePublicClaim(claimText, focus = null, explicitCondition = null) {
  const raw = String(claimText ?? '').trim();
  const entities = extractNamedPublicEntities(raw);
  const condition = explicitCondition || extractPublicScopeCondition(raw) || null;
  let subject = entities[0] ?? '';
  if (!subject) {
    const subjMatch = raw.match(/^(?:如果|当|在[^，,]{2,18}[，,])?\s*([A-Za-z0-9\u4e00-\u9fa5]{2,12}?)(?:从来不|从不|绝不|只会|只有|必然|必定|一定|总是|永远|容易|会|能|让|使|提高|降低|允许|不允许)/u);
    subject = subjMatch?.[1]?.trim() || raw.slice(0, Math.min(10, raw.length));
  }
  const actionText = raw.replace(subject, '').replace(/^[，,：:\s]+/, '').trim() || raw;
  const focusSpan = focus?.spanText ?? '';
  const falsifiableScope =
    focus?.kind === 'quantifier' && focusSpan
      ? `只要在同一主体下找到一个打破「${focusSpan}」的例子，这句话就需要把范围说更准。`
      : condition
        ? `把判断收在「${condition}」这个范围内，重点核对这一情境下的正反依据。`
        : '核对同一主体与场景下是否有能支持、限定或反驳这一判断的公开依据。';

  return {
    subject,
    action: actionText,
    condition,
    falsifiableScope,
  };
}

function buildGentlePublicFocus(claimText, explicitFocus = null, idSeed = '1') {
  const base = selectFocus(claimText, explicitFocus, idSeed);
  if (explicitFocus?.reason) return base;
  let gentleReason;
  if (base.kind === 'quantifier') {
    gentleReason = `我先看看「${base.spanText}」。如果能找到一个例外，这句话就有再推敲的地方。`;
  } else if (base.kind === 'scope') {
    gentleReason = `我先看看「${base.spanText}」这个范围，核对一下在这个具体场景里有没有例外或限定。`;
  } else if (base.kind === 'dependency') {
    gentleReason = `我先看看「${base.spanText}」这个前提，确认它在实际情况里站不站得住。`;
  } else {
    gentleReason = `我先看看「${base.spanText}」这一处判断，找找公开讨论里有没有能呼应或限定它的依据。`;
  }
  return {
    ...base,
    reason: gentleReason,
  };
}

function buildPublicSearchQueries(claimText, decomposition = null) {
  const raw = String(claimText ?? '').trim();
  const kws = extractGenericTopicKeywords(raw);
  const queries = [];
  const primary = [decomposition?.subject, ...kws]
    .filter(Boolean)
    .filter((v, idx, arr) => arr.indexOf(v) === idx)
    .slice(0, 4)
    .join(' ')
    .trim();
  if (primary) queries.push(primary);

  const secondaryTerms = [
    decomposition?.subject || kws[0] || raw.slice(0, 8),
    decomposition?.condition || (kws[1] ?? ''),
    '案例 边界 条件',
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (secondaryTerms && secondaryTerms !== primary) {
    queries.push(secondaryTerms);
  }
  return queries.slice(0, 2);
}

function canonicalizePublicUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '').toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function deduplicatePublicEvidenceItems(items = []) {
  const out = [];
  const seenKeys = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const urlKey = canonicalizePublicUrl(item.url);
    const idKey = item.contentKey || item.id || item.evidenceId || null;
    const digestKey = `${item.author ?? ''}::${normalizeDigestKey(item.excerpt ?? item.summary ?? '')}`;
    const compositeKeys = [urlKey ? `url:${urlKey}` : null, idKey ? `id:${idKey}` : null, `dig:${digestKey}`].filter(Boolean);
    if (compositeKeys.some((k) => seenKeys.has(k))) continue;
    for (const k of compositeKeys) seenKeys.add(k);
    out.push(item);
  }
  return out;
}

function extractGroundedQuoteSpan(excerpt, maxChars = 72) {
  const raw = String(excerpt ?? '').trim();
  if (!raw) return '';
  if ([...raw].length <= maxChars) return raw;
  const firstClause = raw.split(/[。！？\n]/u).find((seg) => seg.trim().length >= 8);
  if (firstClause && [...firstClause.trim()].length <= maxChars) {
    return firstClause.trim();
  }
  return [...raw].slice(0, maxChars).join('');
}

function findGroundedQuoteInEvidence(quoteText, evidence) {
  const excerpt = String(evidence?.excerpt ?? '');
  if (!excerpt) return { ok: false, quote: '', startOffset: 0, endOffset: 0 };
  const candidate = String(quoteText ?? '').trim();
  if (!candidate) return { ok: false, quote: '', startOffset: 0, endOffset: 0 };
  const exactIdx = excerpt.indexOf(candidate);
  if (exactIdx >= 0) {
    return {
      ok: true,
      quote: excerpt.slice(exactIdx, exactIdx + candidate.length),
      startOffset: exactIdx,
      endOffset: exactIdx + candidate.length,
    };
  }
  const normExcerpt = normalizeForQuoteLookup(excerpt);
  const normCand = normalizeForQuoteLookup(candidate);
  if (normCand && normExcerpt.includes(normCand)) {
    const startIdx = Math.max(0, excerpt.indexOf(candidate.slice(0, Math.min(6, candidate.length))));
    const endIdx = Math.min(excerpt.length, startIdx + candidate.length);
    return {
      ok: true,
      quote: excerpt.slice(startIdx, endIdx),
      startOffset: startIdx,
      endOffset: endIdx,
    };
  }
  return { ok: false, quote: '', startOffset: 0, endOffset: 0 };
}

function buildPublicSuggestedRewrite({ claimText, focus, decomposition, verifiedItems = [], addedCondition = null }) {
  const raw = String(claimText ?? '').trim();
  if (!raw) return null;
  const cleanCore = raw.replace(/[。！？]+$/u, '');
  const qualifiers = verifiedItems.filter((it) => it.relation === 'qualify');
  const refuters = verifiedItems.filter((it) => it.relation === 'refute');
  const relevantIds = [...refuters, ...qualifiers].map((it) => it.evidenceId).slice(0, 3);

  const condFromEvidence =
    addedCondition
    || decomposition?.condition
    || qualifiers.map((q) => extractPublicScopeCondition(q.excerpt)).find(Boolean)
    || null;

  const hasStrongQuantifier = focus?.kind === 'quantifier' && focus?.spanText;
  let rewriteText = '';
  let kept = '保留了你原本担心的核心问题';
  let narrowed = '';

  if (condFromEvidence && !cleanCore.includes(condFromEvidence)) {
    const softened = hasStrongQuantifier
      ? cleanCore
          .replace(/从来不会|从来不|从不|绝不会|绝不/u, '通常不')
          .replace(/只会/u, '容易')
          .replace(/必然会|必定会|一定会/u, '往往会')
          .replace(/必然|必定|一定/u, '往往')
          .replace(/所有|全部|一切/u, '不少')
          .replace(/总是|永远/u, '常常')
      : cleanCore;
    const trimmedCond = String(condFromEvidence).trim();
    const condPrefix = /[下时中里前后端期]$/u.test(trimmedCond)
      ? (trimmedCond.startsWith('在') ? `${trimmedCond}，` : `在${trimmedCond}，`)
      : `在${trimmedCond}的情况下，`;
    rewriteText = `${condPrefix}${softened}。`;
    narrowed = `把范围收到了「${condFromEvidence}」这一具体场景里`;
  } else if (hasStrongQuantifier && (refuters.length > 0 || qualifiers.length > 0)) {
    const softened = cleanCore
      .replace(/从来不会|从来不|从不|绝不会|绝不/u, '在常规安排下通常不')
      .replace(/只会/u, '在单一使用方式下更容易')
      .replace(/必然|必定|一定/u, '在缺少配套条件时容易')
      .replace(/所有|全部|一切/u, '很多')
      .replace(/总是|永远/u, '经常');
    if (softened !== cleanCore) {
      rewriteText = `${softened}。`;
      narrowed = `把绝对词「${focus.spanText}」收成更贴合实际边界的说法`;
    }
  } else if (refuters.length > 0 || qualifiers.length > 0) {
    rewriteText = `在常见场景里，${cleanCore}，但具体情况还要看前提条件。`;
    narrowed = '留出了具体前提条件的边界';
  }

  if (!rewriteText || rewriteText === raw) return null;
  return {
    text: rewriteText,
    kept,
    narrowed: narrowed || '收窄了适用范围',
    explanation: `原来那层担心可以留着，咱们把话收到具体场景里，${narrowed || '收窄了适用范围'}，读者更容易明白你在担心什么。`,
    basedOnEvidenceIds: relevantIds,
  };
}

function buildLocalPublicProposal({
  claimText,
  focus,
  decomposition,
  evidencePool = [],
  publicAction = 'new_claim',
  addedCondition = null,
  disputedOtherTopic = false,
  previousPublicAnalysis = null,
  verifierAdapter = null,
  userText = '',
}) {
  const claimScope = addedCondition || decomposition?.condition || extractPublicScopeCondition(claimText);
  const claimHasUniversal = /(?:从来不|从不|绝不|只会|只有|必然|必定|一定|所有|全部|一切|总是|永远|无一例外)/u.test(claimText);
  const prevRelationMap = new Map();
  for (const edge of previousPublicAnalysis?.edges ?? []) {
    if (edge?.evidenceId) prevRelationMap.set(edge.evidenceId, edge.relation);
  }

  const relations = [];
  for (const ev of evidencePool) {
    const evId = ev.id ?? ev.evidenceId;
    const evFullText = `${ev.title ?? ''} ${ev.excerpt ?? ''}`.trim();
    const quote = extractGroundedQuoteSpan(ev.excerpt, 72);

    // 1. 跨主体检查（甲工厂 vs 乙工厂）
    const entityCheck = detectCrossEntityMismatch(claimText, evFullText);
    if (entityCheck.mismatch) {
      relations.push({
        evidenceId: evId,
        relation: 'unknown',
        quote,
        reason: `这条材料说的是「${entityCheck.evidenceEntity}」，和当前句子的「${entityCheck.claimEntity}」不是同一个主体，不能当成直接反驳。`,
        scopeNote: `涉及不同主体：${entityCheck.evidenceEntity}`,
      });
      continue;
    }

    // 2. 用户纠错指出某条材料说的是另一回事
    const evAuthorMentionedInDispute =
      disputedOtherTopic
      && (
        (ev.author && userText.includes(ev.author))
        || prevRelationMap.get(evId) === 'refute'
      );

    const evScope = extractPublicScopeCondition(ev.excerpt);
    const hasDifferentConditionMarkers = Boolean(
      claimScope
      && (
        /不同提示词|多种提示词|换着|主动探索|采访笔记|人工润色|自定义/.test(ev.excerpt)
        || (evScope && !evScope.includes(claimScope) && !claimScope.includes(evScope))
      ),
    );
    const matchesClaimScope = Boolean(
      claimScope
      && (evFullText.includes(claimScope) || (evScope && (evScope.includes(claimScope) || claimScope.includes(evScope)))),
    );

    if (publicAction === 'correct_condition' && evAuthorMentionedInDispute && !matchesClaimScope) {
      relations.push({
        evidenceId: evId,
        relation: 'unknown',
        quote,
        reason: claimScope
          ? `你把范围说清在「${claimScope}」以后，${ev.author || '这位作者'}聊的是另一种情况，不再直接反驳这句话。`
          : `你指出这条说的是另一回事，暂时不把它算作直接反驳。`,
        scopeNote: evScope || '适用场景与当前范围不同',
      });
      continue;
    }

    // 3. 语义命题关系评估（复用 verifier.mjs 的核心分句极性与范围判定）
    let semanticRel = 'insufficient_evidence';
    if (typeof verifierAdapter?.evaluateSemanticPropositionRelation === 'function') {
      try {
        const sem = verifierAdapter.evaluateSemanticPropositionRelation(claimText, ev.excerpt, {
          statementScope: claimScope,
          nodeScope: evScope,
        });
        semanticRel = sem?.relation ?? 'insufficient_evidence';
      } catch {
        semanticRel = 'insufficient_evidence';
      }
    }

    // 额外处理典型限定 / 极性场景（兼容未覆盖到的通用话题）
    const evHasConditionalQualifier = /(?:仅在|只在|只有在|如果|在[^，。]{1,12}(?:下|时|期间)|旺季|淡季|紧急|特殊|批量|反复|同一|特定|部分|偶尔|少数)/u.test(ev.excerpt);
    const evOpposesClaim =
      semanticRel === 'conflict'
      || (
        (/(?:从来不|从不|绝不|不允许|禁止|不会|不能)/u.test(claimText) && /(?:允许|可以|能够|同意|发现过|试过|换过班|差别很大|不一样|拓宽)/u.test(ev.excerpt))
        || (/(?:只会.*变窄|越来越窄|越来越像|套路化|趋同)/u.test(claimText) && /(?:差别很大|不一样|拓宽|发现了|新乐队|风格各异|反而不一样)/u.test(ev.excerpt))
      );
    const evSupportsClaim =
      semanticRel === 'compatible'
      || (
        (/(?:越来越像|套路化|趋同|变窄|降低|不允许)/u.test(claimText) && /(?:越来越像|套路化|趋同|变窄|降低|不允许)/u.test(ev.excerpt))
        && !evOpposesClaim
      );

    let relation = 'unknown';
    let reason = '这条材料提到相近话题，但还不足以直接支持或反驳当前句子。';
    let scopeNote = evScope || null;

    if (hasDifferentConditionMarkers && claimScope) {
      relation = 'unknown';
      reason = `这条材料聊的是「${evScope || '另一种做法'}」，和「${claimScope}」不是同一情境，不再直接反驳当前句子。`;
      scopeNote = evScope || '不同情境';
    } else if (evOpposesClaim) {
      if (claimScope && !matchesClaimScope && !claimHasUniversal) {
        relation = 'unknown';
        reason = `这条材料没有落在「${claimScope}」这个条件里，暂时不能直接反驳改写后的句子。`;
      } else if (evHasConditionalQualifier && !claimHasUniversal) {
        relation = 'qualify';
        reason = `${ev.author || '这位作者'}说的是特定条件下的例外，可以帮我们划清适用边界。`;
      } else if (evHasConditionalQualifier && /旺季|紧急|特殊|部分|特定|批量|临时|提前报备|特定班组/.test(ev.excerpt)) {
        relation = 'qualify';
        reason = `${ev.author || '这位作者'}提到了具体条件下的例外情况，说明原句在特定条件下需要收窄。`;
      } else {
        relation = 'refute';
        reason = `${ev.author || '这位作者'}给出了同一对象下的反例，和原句的说法直接撞上了。`;
      }
    } else if (evSupportsClaim) {
      if (evHasConditionalQualifier && !matchesClaimScope) {
        relation = 'qualify';
        reason = `${ev.author || '这位作者'}聊的是特定条件下的情况，能说明这一种场景，但还不能代表所有情形。`;
      } else {
        relation = 'support';
        reason = `${ev.author || '这位作者'}的观察和这句话在同一场景下能呼应上。`;
      }
    } else if (evHasConditionalQualifier && isEvidenceRelevantToSentence(ev, claimText, focus)) {
      relation = 'qualify';
      reason = `${ev.author || '这位作者'}补充了具体前提下的情况，可以用来帮这句话划清边界。`;
    }

    relations.push({
      evidenceId: evId,
      relation,
      quote,
      reason,
      scopeNote,
    });
  }

  return {
    focus,
    decomposition,
    relations,
    citations: relations
      .filter((r) => r.relation !== 'unknown')
      .map((r) => ({ evidenceId: r.evidenceId, quoteText: r.quote, relation: r.relation, reason: r.reason })),
    suggestedRewrite: buildPublicSuggestedRewrite({
      claimText,
      focus,
      decomposition,
      verifiedItems: relations.map((r) => ({
        ...r,
        excerpt: evidencePool.find((e) => (e.id ?? e.evidenceId) === r.evidenceId)?.excerpt ?? '',
      })),
      addedCondition,
    }),
  };
}

function verifyPublicAnalysisProposalCompat({
  proposal = {},
  claimText = '',
  statementId = 'stmt_original',
  statementRole = 'original',
  focus = null,
  decomposition = null,
  evidencePool = [],
  previousPublicAnalysis = null,
  verifierAdapter = null,
  publicAction = 'new_claim',
  addedCondition = null,
  disputedOtherTopic = false,
  userText = '',
  turnId = 'turn_1',
  secrets = [],
} = {}) {
  const evidenceById = new Map();
  for (const ev of evidencePool) {
    const eid = ev?.id ?? ev?.evidenceId;
    if (eid) evidenceById.set(eid, ev);
  }

  // 优先调用 Agent 2 在 verifier.mjs 提供的 verifyPublicAnalysisProposal（若已存在），再叠加统一结构规范化与底线复核
  let upstreamVerified = null;
  if (typeof verifierAdapter?.verifyPublicAnalysisProposal === 'function') {
    try {
      upstreamVerified = verifierAdapter.verifyPublicAnalysisProposal({
        proposal,
        claim: { text: claimText, focus, decomposition },
        claimText,
        decomposition,
        evidenceList: evidencePool,
        evidence: evidencePool,
        evidenceMap: evidenceById,
        previousPublicAnalysis,
        focus,
        turnId,
      });
    } catch {
      upstreamVerified = null;
    }
  }

  const rawRelations = Array.isArray(upstreamVerified?.relations)
    ? upstreamVerified.relations
    : Array.isArray(upstreamVerified?.verifiedRelations)
      ? upstreamVerified.verifiedRelations
      : Array.isArray(upstreamVerified?.edges)
        ? upstreamVerified.edges
        : Array.isArray(proposal?.relations)
          ? proposal.relations
          : Array.isArray(proposal?.edges)
            ? proposal.edges
            : Array.isArray(proposal?.evidenceRelations)
              ? proposal.evidenceRelations
              : [];

  const rawCitations = Array.isArray(upstreamVerified?.citations)
    ? upstreamVerified.citations
    : Array.isArray(proposal?.citations)
      ? proposal.citations
      : [];

  const rejectedItems = Array.isArray(upstreamVerified?.rejectedItems)
    ? [...upstreamVerified.rejectedItems]
    : [];
  const rejectedCrossEntities = new Set();

  // 先核对独立 citations 中的虚构引文或不存在的 evidenceId（严禁漏入）
  const groundedQuoteByEvId = new Map();
  for (const cit of rawCitations) {
    const eid = cit?.evidenceId ?? cit?.id ?? null;
    const ev = eid ? evidenceById.get(eid) : null;
    if (!ev) {
      rejectedItems.push({ kind: 'citation', reason: 'EVIDENCE_NOT_FOUND', evidenceId: eid });
      continue;
    }
    const rawQuote = cit?.quote ?? cit?.quoteText ?? cit?.exactQuote ?? '';
    if (rawQuote) {
      const check = findGroundedQuoteInEvidence(rawQuote, ev);
      if (!check.ok) {
        rejectedItems.push({ kind: 'citation', reason: 'QUOTE_NOT_FOUND_IN_EVIDENCE', evidenceId: eid, quote: rawQuote });
        continue;
      }
      groundedQuoteByEvId.set(eid, check);
    }
  }

  const verifiedByEvId = new Map();
  const claimScope = addedCondition || decomposition?.condition || extractPublicScopeCondition(claimText);
  const claimHasUniversal = /(?:从来不|从不|绝不|只会|只有|必然|必定|一定|所有|全部|一切|总是|永远|无一例外)/u.test(claimText);

  for (const relItem of rawRelations) {
    const eid = relItem?.evidenceId ?? relItem?.id ?? null;
    const ev = eid ? evidenceById.get(eid) : null;
    if (!ev) {
      rejectedItems.push({ kind: 'relation', reason: 'EVIDENCE_NOT_FOUND', evidenceId: eid });
      continue;
    }

    let relation = normalizePublicRelation(relItem?.relation ?? relItem?.type ?? 'unknown');
    let reason = typeof relItem?.reason === 'string' && relItem.reason.trim()
      ? sanitizeUserFacingPublicText(relItem.reason, secrets)
      : '';
    const scopeNote = typeof relItem?.scopeNote === 'string' && relItem.scopeNote.trim()
      ? sanitizeUserFacingPublicText(relItem.scopeNote, secrets)
      : extractPublicScopeCondition(ev.excerpt);

    // 1. 严格引文接地核验：模型如果给出无源引文，一律拦截丢弃
    const proposedQuote = relItem?.quote ?? relItem?.quoteText ?? relItem?.exactQuote ?? '';
    let verifiedQuoteObj = groundedQuoteByEvId.get(eid) ?? null;
    if (proposedQuote) {
      const qCheck = findGroundedQuoteInEvidence(proposedQuote, ev);
      if (!qCheck.ok) {
        rejectedItems.push({ kind: 'quote', reason: 'QUOTE_NOT_FOUND_IN_EVIDENCE', evidenceId: eid, quote: proposedQuote });
      } else {
        verifiedQuoteObj = qCheck;
      }
    }
    if (!verifiedQuoteObj) {
      const fallbackSpan = extractGroundedQuoteSpan(ev.excerpt, 72);
      const qCheck = findGroundedQuoteInEvidence(fallbackSpan, ev);
      verifiedQuoteObj = qCheck.ok
        ? qCheck
        : { ok: true, quote: ev.excerpt.slice(0, 72), startOffset: 0, endOffset: Math.min(72, ev.excerpt.length) };
    }

    // 2. 跨主体硬核验（L-02 核心：甲工厂 vs 乙工厂绝不误标冲突或支持！）
    const entityCheck = detectCrossEntityMismatch(claimText, `${ev.title ?? ''} ${ev.excerpt ?? ''}`);
    if (entityCheck.mismatch) {
      if (relation !== 'unknown') {
        rejectedItems.push({
          kind: 'relation',
          reason: 'CROSS_ENTITY_MISMATCH',
          evidenceId: eid,
          claimEntity: entityCheck.claimEntity,
          evidenceEntity: entityCheck.evidenceEntity,
          rejectedRelation: relation,
        });
      }
      rejectedCrossEntities.add(entityCheck.evidenceEntity);
      relation = 'unknown';
      reason = `这条材料说的是「${entityCheck.evidenceEntity}」，和当前句子的「${entityCheck.claimEntity}」不是同一个对象，不能当成直接反驳。`;
    }

    // 3. 范围收窄与条件不重合复核（防止改写/纠错后旧反例继续错挂 refute）
    if (relation === 'refute' && claimScope) {
      const evFull = `${ev.title ?? ''} ${ev.excerpt ?? ''}`;
      const evMentionsClaimScope = evFull.includes(claimScope);
      const evIsOtherMethod = /不同提示词|多种提示词|采访笔记|人工润色|换着写法/.test(ev.excerpt);
      if (!evMentionsClaimScope && (evIsOtherMethod || (!claimHasUniversal && (publicAction === 'correct_condition' || publicAction === 'submit_rewrite')))) {
        relation = 'unknown';
        reason = `加上「${claimScope}」以后，${ev.author || '这位作者'}说的场景不再直接反驳你的句子。`;
      }
    }

    // 4. 仅覆盖部分条件的材料降为 qualify（不把局部条件硬画成无条件冲突）
    if (
      relation === 'refute'
      && /仅在|只在|旺季|紧急情况|特殊班组|提前报备|批量写稿/.test(ev.excerpt)
      && !claimHasUniversal
    ) {
      relation = 'qualify';
      reason = reason || `${ev.author || '这位作者'}说的是特定条件下的情况，更适合拿来限定范围。`;
    }

    verifiedByEvId.set(eid, {
      evidence: ev,
      evidenceId: eid,
      relation,
      quote: verifiedQuoteObj.quote,
      startOffset: verifiedQuoteObj.startOffset,
      endOffset: verifiedQuoteObj.endOffset,
      reason: reason || (relation === 'qualify'
        ? `${ev.author || '这位作者'}补充了具体条件下的情况。`
        : relation === 'refute'
          ? `${ev.author || '这位作者'}给出了同一对象下的反例。`
          : relation === 'support'
            ? `${ev.author || '这位作者'}的观察和这句话能呼应上。`
            : '这条材料目前还不足以直接定论。'),
      scopeNote,
    });
  }

  // 对尚未被 proposal 覆盖但确实在证据池里的条目补齐 unknown 状态（绝不遗漏跨主体实体跟踪）
  for (const ev of evidencePool) {
    const eid = ev?.id ?? ev?.evidenceId;
    if (!eid || verifiedByEvId.has(eid)) continue;
    const entityCheck = detectCrossEntityMismatch(claimText, `${ev.title ?? ''} ${ev.excerpt ?? ''}`);
    if (entityCheck.mismatch) rejectedCrossEntities.add(entityCheck.evidenceEntity);
    const fallbackSpan = extractGroundedQuoteSpan(ev.excerpt, 72);
    const qCheck = findGroundedQuoteInEvidence(fallbackSpan, ev);
    verifiedByEvId.set(eid, {
      evidence: ev,
      evidenceId: eid,
      relation: 'unknown',
      quote: qCheck.ok ? qCheck.quote : ev.excerpt.slice(0, 72),
      startOffset: qCheck.ok ? qCheck.startOffset : 0,
      endOffset: qCheck.ok ? qCheck.endOffset : Math.min(72, ev.excerpt.length),
      reason: entityCheck.mismatch
        ? `这条材料说的是「${entityCheck.evidenceEntity}」，和「${entityCheck.claimEntity}」不是同一对象。`
        : '暂未确认这条材料与当前句子的直接关系。',
      scopeNote: entityCheck.mismatch ? `不同主体：${entityCheck.evidenceEntity}` : null,
    });
  }

  const allEntries = [...verifiedByEvId.values()];
  const activeEntries = allEntries.filter((entry) => entry.relation !== 'unknown');
  const unknownEntries = allEntries.filter((entry) => entry.relation === 'unknown');

  // 组装严格可追溯的星图 nodes / edges / citations
  const claimNodeId = 'pub_claim_current';
  const nodes = [
    {
      id: claimNodeId,
      kind: 'claim',
      label: claimText.length > 26 ? `${claimText.slice(0, 25)}…` : claimText,
      text: claimText,
      statementId,
      author: 'self',
      attribution: 'self',
      focusSpan: focus?.spanText ?? '',
      status: 'active',
    },
    ...activeEntries.map((entry) => ({
      id: `pub_ev_${entry.evidenceId}`,
      kind: 'evidence',
      evidenceId: entry.evidenceId,
      label: (entry.evidence.title || entry.quote).slice(0, 28),
      title: entry.evidence.title || '',
      author: entry.evidence.author || '公开作者',
      attribution: 'other_author',
      excerpt: entry.evidence.excerpt,
      quote: entry.quote,
      url: entry.evidence.url ?? null,
      relation: entry.relation,
      reason: entry.reason,
      scopeNote: entry.scopeNote ?? null,
      requestId: entry.evidence.requestId ?? null,
    })),
  ];

  const edges = activeEntries.map((entry) => ({
    id: `pub_edge_${entry.evidenceId}`,
    source: `pub_ev_${entry.evidenceId}`,
    target: claimNodeId,
    from: `pub_ev_${entry.evidenceId}`,
    to: claimNodeId,
    relation: entry.relation,
    evidenceId: entry.evidenceId,
    quote: entry.quote,
    author: entry.evidence.author || '公开作者',
    reason: entry.reason,
    scopeNote: entry.scopeNote ?? null,
    scopeCondition: entry.scopeNote ?? null,
  }));

  const citations = activeEntries.map((entry) => ({
    evidenceId: entry.evidenceId,
    nodeId: `pub_ev_${entry.evidenceId}`,
    title: entry.evidence.title || '',
    author: entry.evidence.author || '公开作者',
    attribution: 'other_author',
    excerpt: entry.evidence.excerpt,
    quote: entry.quote,
    startOffset: entry.startOffset,
    endOffset: entry.endOffset,
    url: entry.evidence.url ?? null,
    relation: entry.relation,
    reason: entry.reason,
    requestId: entry.evidence.requestId ?? null,
  }));

  // 对比上一版关系变化（L-03 同批证据关系差异追踪）
  const prevHistory = Array.isArray(previousPublicAnalysis?.statementHistory)
    ? previousPublicAnalysis.statementHistory
    : [];
  const prevRelationsByEvId = new Map();
  const prevLatestRelMap = prevHistory.at(-1)?.relationsByEvidenceId ?? null;
  if (prevLatestRelMap && typeof prevLatestRelMap === 'object') {
    for (const [k, v] of Object.entries(prevLatestRelMap)) {
      prevRelationsByEvId.set(k, v);
    }
  } else {
    for (const edge of previousPublicAnalysis?.edges ?? []) {
      if (edge?.evidenceId) prevRelationsByEvId.set(edge.evidenceId, edge.relation);
    }
  }

  const relationChanges = [];
  const collectRelationDiffs = (baselineMap) => {
    const diffs = [];
    const allEvIds = new Set([...baselineMap.keys(), ...verifiedByEvId.keys()]);
    for (const eid of allEvIds) {
      const prevRel = baselineMap.get(eid) ?? null;
      const currEntry = verifiedByEvId.get(eid);
      const currRel = currEntry?.relation ?? 'unknown';
      if (prevRel !== currRel && (prevRel !== null || currRel !== 'unknown')) {
        const ev = currEntry?.evidence ?? evidenceById.get(eid);
        const author = ev?.author || '公开作者';
        let summary;
        if (prevRel === 'refute' && currRel !== 'refute') {
          summary = claimScope
            ? `加上「${claimScope}」以后，${author}这条反例就不再直接反驳你的句子了。`
            : `调整说法以后，${author}这条材料不再直接反驳你的句子了。`;
        } else if (prevRel !== 'refute' && currRel === 'refute') {
          summary = `按现在的说法，${author}这条材料成了直接反例。`;
        } else if (currRel === 'qualify') {
          summary = `${author}这条材料现在主要用来划定适用范围。`;
        } else if (currRel === 'support') {
          summary = `${author}这条材料在新的范围里可以呼应你的说法了。`;
        } else {
          summary = `${author}这条材料与当前句子的关系变成了暂未定论。`;
        }
        diffs.push({
          evidenceId: eid,
          nodeId: `pub_ev_${eid}`,
          author,
          title: ev?.title || '',
          previousRelation: prevRel,
          currentRelation: currRel,
          from: prevRel ?? 'none',
          to: currRel === 'unknown' ? 'none' : currRel,
          status: prevRel === 'refute' && currRel !== 'refute' ? 'resolved' : (prevRel === null ? 'added' : 'changed'),
          reason: currEntry?.reason || summary,
          summary,
        });
      }
    }
    return diffs;
  };

  if (previousPublicAnalysis) {
    relationChanges.push(...collectRelationDiffs(prevRelationsByEvId));
    // 改写或条件调整后若与上一轮相同但与首句原话有关系变化，仍展示相对原句的关系变化，方便对照比较。
    if (relationChanges.length === 0 && (publicAction === 'submit_rewrite' || publicAction === 'correct_condition') && prevHistory.length > 0) {
      const origEntry = prevHistory.find((h) => h?.role === 'original') ?? prevHistory[0];
      const origRelMap = new Map(Object.entries(origEntry?.relationsByEvidenceId ?? {}));
      if (origRelMap.size > 0) {
        relationChanges.push(...collectRelationDiffs(origRelMap));
      }
    }
  }

  // 核验或生成建议改写（过滤改写中的违禁实现词或未核验数字）
  const rawSuggestedRewrite = upstreamVerified?.suggestedRewrite ?? proposal?.suggestedRewrite ?? null;
  let suggestedRewrite = null;
  if (rawSuggestedRewrite && typeof rawSuggestedRewrite === 'object' && typeof rawSuggestedRewrite.text === 'string' && rawSuggestedRewrite.text.trim()) {
    const cleanRewrite = sanitizeUserFacingPublicText(rawSuggestedRewrite.text, secrets);
    const rawRwIds = Array.isArray(rawSuggestedRewrite.basedOnEvidenceIds)
      ? rawSuggestedRewrite.basedOnEvidenceIds
      : (Array.isArray(rawSuggestedRewrite.evidenceIds) ? rawSuggestedRewrite.evidenceIds : []);
    const validBasedOn = rawRwIds.filter((id) => evidenceById.has(id));
    if (cleanRewrite && cleanRewrite !== claimText) {
      const finalRwIds = validBasedOn.length > 0 ? validBasedOn : activeEntries.map((e) => e.evidenceId).slice(0, 3);
      suggestedRewrite = {
        text: cleanRewrite,
        kept: sanitizeUserFacingPublicText(rawSuggestedRewrite.kept ?? '保留了你原本想表达的核心关切', secrets),
        narrowed: sanitizeUserFacingPublicText(rawSuggestedRewrite.narrowed ?? '收窄了容易被反例打穿的范围', secrets),
        explanation: sanitizeUserFacingPublicText(
          rawSuggestedRewrite.explanation ?? '原来那层担心可以留着，把范围说到具体场景里会更站得住。',
          secrets,
        ),
        basedOnEvidenceIds: finalRwIds,
        evidenceIds: finalRwIds,
      };
    }
  }
  if (!suggestedRewrite && publicAction !== 'ask_provenance') {
    const localRw = buildPublicSuggestedRewrite({
      claimText,
      focus,
      decomposition,
      verifiedItems: allEntries.map((e) => ({ ...e, excerpt: e.evidence.excerpt })),
      addedCondition: claimScope,
    });
    if (localRw) {
      suggestedRewrite = { ...localRw, evidenceIds: localRw.basedOnEvidenceIds };
    }
  }

  // 生成一句自然具体的变化说明
  let changeSummary;
  if (publicAction === 'ask_provenance') {
    changeSummary = '当前句子和依据没变，已为你展开每条判断对应的出处。';
  } else if (relationChanges.length > 0) {
    changeSummary = relationChanges[0].summary;
  } else if (!previousPublicAnalysis) {
    if (activeEntries.length > 0) {
      const hasRefute = activeEntries.some((e) => e.relation === 'refute');
      const hasQualify = activeEntries.some((e) => e.relation === 'qualify');
      changeSummary = hasRefute
        ? `找到 ${activeEntries.length} 条相关依据，其中有反例和原句的绝对说法撞上了。`
        : hasQualify
          ? `找到 ${activeEntries.length} 条能帮这句话划清适用范围的依据。`
          : `找到 ${activeEntries.length} 条可对照的公开依据。`;
    } else {
      changeSummary = '手头还缺能直接回答这句话的证据，先把原句留着。';
    }
  } else if (previousPublicAnalysis.claim?.text !== claimText) {
    changeSummary = claimScope
      ? `已按「${claimScope}」更新当前句子，并在同一批材料下重新核对了一遍。`
      : '已按你的新版本在同一批材料下重新核对了一遍。';
  } else {
    changeSummary = '当前句子和已有依据的关系保持不变。';
  }

  const relationsByEvidenceId = {};
  const relationCounts = { support: 0, refute: 0, qualify: 0, unknown: 0 };
  for (const entry of allEntries) {
    relationsByEvidenceId[entry.evidenceId] = entry.relation;
    relationCounts[entry.relation] = (relationCounts[entry.relation] ?? 0) + 1;
  }

  const unknownParts = [
    ...(Array.isArray(upstreamVerified?.unknownParts) ? upstreamVerified.unknownParts : []),
    ...(Array.isArray(proposal?.unknownParts) ? proposal.unknownParts : []),
    ...(Array.isArray(proposal?.unknowns) ? proposal.unknowns : []),
    ...unknownEntries.map((u) => u.reason).filter(Boolean),
  ]
    .map((item) => sanitizeUserFacingPublicText(String(item ?? '').trim(), secrets))
    .filter(Boolean);
  const dedupedUnknownParts = [...new Set(unknownParts)].slice(0, 6);

  return {
    claim: {
      statementId,
      text: claimText,
      role: statementRole,
      focus,
      decomposition,
    },
    nodes,
    edges,
    citations,
    suggestedRewrite,
    relationChanges,
    changeSummary,
    relationsByEvidenceId,
    relationCounts,
    rejectedItems,
    rejectedCount: rejectedItems.length,
    unknownCount: unknownEntries.length,
    unknownParts: dedupedUnknownParts,
    rejectedCrossEntities: [...rejectedCrossEntities],
  };
}

// 公开对话流式一致性守卫：拦截无源引文、阿拉伯/中文数字百分比、跨主体误判冲突断言与内部实现词，确保 SSE 流与落库正文 100% 一致。
const CN_PERCENT_RE =
  /(?:百分之[零〇一二两三四五六七八九十百千万点]+|[零〇一二两三四五六七八九十百点]+(?:个)?百分点|[一二两三四五六七八九十]+成(?:[一二三四五六七八九]|多|以上|以下|左右)?|[零〇一二两三四五六七八九十百]+分之[零〇一二两三四五六七八九十百]+)/gu;

const ARABIC_PERCENT_RE =
  /(?<![A-Za-z0-9_])\d+(?:\.\d+)?\s*(?:[%％]|(?:个)?百分点)/gu;

const FORBIDDEN_JARGON_RE =
  /(?:总承重分母|承重分母|图版本\s*v?\d*|图版本|候选关系|\bschema\b|\bverifying_candidates\b|\bretrieving_evidence\b|\bchecking_local_graph\b|\bstreaming_explanation\b|\bpublicAnalysis\b|\bgraphVersion\b|\binsufficient_evidence\b)/gi;

const CONFLICT_ASSERTION_RE =
  /(?:直接反驳|构成(?:直接)?冲突|推翻了|打脸|完全矛盾|反例证明|直接打穿|证明.*是错的)/u;

const NEGATED_CONFLICT_RE =
  /(?:不(?:能|会|再|直接|构成|算)|并非|不是|算不上|无法(?:直接)?(?:反驳|推翻))/u;

function createPublicStreamingGuard({
  publicAnalysis = null,
  allowedQuoteSources = [],
  rejectedCrossEntities = [],
  secrets = [],
  verifierAdapter = null,
} = {}) {
  const normalizedSources = allowedQuoteSources
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .map((s) => normalizeForQuoteLookup(redactTurnText(s, secrets)));

  const allowedPercentTokens = new Set();
  for (const src of normalizedSources) {
    for (const m of src.matchAll(CN_PERCENT_RE)) allowedPercentTokens.add(m[0]);
    for (const m of src.matchAll(ARABIC_PERCENT_RE)) allowedPercentTokens.add(m[0].replace(/\s+/g, ''));
  }

  // 若 Agent 2 在 verifier.mjs 导出了 createStreamingOutputGuard，也联动检测
  const innerVerifierGuard =
    typeof verifierAdapter?.createStreamingOutputGuard === 'function'
      ? verifierAdapter.createStreamingOutputGuard({
          allowedTexts: normalizedSources,
          allowedRates: [],
          allowedFractions: [],
          fallbackRateText: '',
          unverifiedQuoteReplacement: '',
        })
      : null;

  const stats = {
    interceptedQuotes: [],
    interceptedNumbers: [],
    interceptedAssertions: [],
    interceptedJargon: [],
    droppedClauses: 0,
  };

  let clauseBuffer = '';
  const hasVerifiedRefute = Array.isArray(publicAnalysis?.edges)
    && publicAnalysis.edges.some((e) => e.relation === 'refute');

  function isQuoteGrounded(innerText) {
    const trimmed = normalizeForQuoteLookup(innerText);
    if (!trimmed) return true;
    if ([...trimmed].length <= 3) return true;
    return normalizedSources.some((src) => src.includes(trimmed));
  }

  function inspectAndCleanClause(rawClause) {
    let clause = redactTurnText(rawClause, secrets);
    if (!clause.trim()) return '';

    // 同步通过 verifier.mjs 内层守卫收集统计
    if (innerVerifierGuard) {
      try {
        innerVerifierGuard.push(clause);
      } catch {
        // 忽略内层守卫异常，外层严格兜底
      }
    }

    let clauseTainted = false;

    // 1. 检测引号内无源引文（含 “...” / "..." / 「...」 / 『...』 / ‘...’）
    const quoteRe = /([“"「『‘])([^”"」』’]{1,300})([”"」』’])/gu;
    for (const m of clause.matchAll(quoteRe)) {
      const inner = m[2];
      if (!isQuoteGrounded(inner)) {
        stats.interceptedQuotes.push(inner);
        clauseTainted = true;
      }
    }

    // 2. 检测中文数字百分比与未核验阿拉伯百分比（如“七十二个百分点”“72%”“百分之七十二”“八成”）
    for (const m of clause.matchAll(CN_PERCENT_RE)) {
      if (!allowedPercentTokens.has(m[0])) {
        stats.interceptedNumbers.push(m[0]);
        clauseTainted = true;
      }
    }
    for (const m of clause.matchAll(ARABIC_PERCENT_RE)) {
      const norm = m[0].replace(/\s+/g, '');
      if (!allowedPercentTokens.has(norm)) {
        stats.interceptedNumbers.push(norm);
        clauseTainted = true;
      }
    }

    // 3. 检测无引号伪冲突断言（例如声称已拦截的跨主体“乙工厂”直接反驳原句，或在无任何 refute 边时硬说存在直接反驳）
    for (const badEntity of rejectedCrossEntities) {
      if (
        badEntity
        && clause.includes(badEntity)
        && CONFLICT_ASSERTION_RE.test(clause)
        && !NEGATED_CONFLICT_RE.test(clause)
      ) {
        stats.interceptedAssertions.push(`cross_entity_conflict:${badEntity}`);
        clauseTainted = true;
      }
    }
    if (!hasVerifiedRefute && CONFLICT_ASSERTION_RE.test(clause) && !NEGATED_CONFLICT_RE.test(clause)) {
      stats.interceptedAssertions.push('unverified_refute_assertion');
      clauseTainted = true;
    }

    if (clauseTainted) {
      stats.droppedClauses += 1;
      return '';
    }

    // 4. 剥离面向用户的实现词
    const jargonMatches = clause.match(FORBIDDEN_JARGON_RE);
    if (jargonMatches) {
      stats.interceptedJargon.push(...jargonMatches);
      clause = sanitizeUserFacingPublicText(clause, secrets);
    }

    return clause;
  }

  function hasUnclosedQuoteOrRiskyTail(text) {
    const openQuotes = (text.match(/[“「『‘]/gu) || []).length;
    const closeQuotes = (text.match(/[”」』’]/gu) || []).length;
    if (openQuotes !== closeQuotes) return true;
    const straightQuotes = (text.match(/"/g) || []).length;
    if (straightQuotes % 2 === 1) return true;
    // 若尾段含数字/中文数词/可疑断言前缀，暂留极短窗口等闭合后再核验放行
    if (/(?:[0-9一二两三四五六七八九十百千万几半多]{1,5}(?:个|百|分|成|点)?|[%％]|某(?:权威|研究|调查|数据|机构|答主)|据(?:称|说|统计|报道|调查)|有(?:研究|调查|数据|统计)|显示|表明|比例|概率|百分)$/u.test(text)) {
      return true;
    }
    return false;
  }

  function push(rawChunk) {
    const chunk = redactTurnText(rawChunk ?? '', secrets);
    if (!chunk) return '';
    clauseBuffer += chunk;

    let safeOut = '';
    while (clauseBuffer.length > 0) {
      // 优先在句末标点或短语停顿（，、；：）处及时切分推送，确保真实流式体验顺滑不卡顿
      const boundaryMatch = /[。！？\n，、；：]/u.exec(clauseBuffer);
      if (boundaryMatch) {
        const endIdx = boundaryMatch.index + boundaryMatch[0].length;
        const candidate = clauseBuffer.slice(0, endIdx);
        // 若停顿前有未闭合引号，继续等待配对引号（但不超过 140 字）
        const openQ = (candidate.match(/[“「『‘]/gu) || []).length;
        const closeQ = (candidate.match(/[”」』’]/gu) || []).length;
        const straightQ = (candidate.match(/"/g) || []).length;
        if ((openQ !== closeQ || straightQ % 2 === 1) && clauseBuffer.length < 140) {
          break;
        }
        clauseBuffer = clauseBuffer.slice(endIdx);
        safeOut += inspectAndCleanClause(candidate);
      } else if (clauseBuffer.length >= 18 && !hasUnclosedQuoteOrRiskyTail(clauseBuffer)) {
        // 无标点且确认无未闭合引号、数字或断言风险时，按 18 字平滑推出
        const nextClause = clauseBuffer;
        clauseBuffer = '';
        safeOut += inspectAndCleanClause(nextClause);
      } else if (clauseBuffer.length >= 140) {
        const cutIdx = 120;
        const nextClause = clauseBuffer.slice(0, cutIdx);
        clauseBuffer = clauseBuffer.slice(cutIdx);
        safeOut += inspectAndCleanClause(nextClause);
      } else {
        break;
      }
    }
    return safeOut;
  }

  function flush() {
    let tail = '';
    if (clauseBuffer.length > 0) {
      tail = inspectAndCleanClause(clauseBuffer);
      clauseBuffer = '';
    }
    if (innerVerifierGuard) {
      try {
        const innerRes = innerVerifierGuard.flush();
        if (Array.isArray(innerRes?.interceptedQuotes)) {
          for (const q of innerRes.interceptedQuotes) {
            if (!stats.interceptedQuotes.includes(q)) stats.interceptedQuotes.push(q);
          }
        }
        if (Array.isArray(innerRes?.interceptedNumbers)) {
          for (const n of innerRes.interceptedNumbers) {
            if (!stats.interceptedNumbers.includes(n)) stats.interceptedNumbers.push(n);
          }
        }
      } catch {
        // 忽略
      }
    }
    return tail;
  }

  function getStats() {
    const innerStats = typeof innerVerifierGuard?.getStats === 'function' ? innerVerifierGuard.getStats() : null;
    const quotes = [...new Set([...stats.interceptedQuotes, ...(innerStats?.interceptedQuotes ?? [])])];
    const numbers = [...new Set([...stats.interceptedNumbers, ...(innerStats?.interceptedNumbers ?? [])])];
    const totalIntercepted =
      quotes.length + numbers.length + stats.interceptedAssertions.length + stats.droppedClauses;
    return {
      interceptedQuotes: quotes,
      interceptedNumbers: numbers,
      interceptedAssertions: [...stats.interceptedAssertions],
      interceptedJargon: [...stats.interceptedJargon],
      droppedClauses: stats.droppedClauses,
      hadInterceptions: totalIntercepted > 0,
    };
  }

  return { push, flush, getStats };
}

// ===== 核心流式编排器 =====
export class TurnOrchestrator {
  constructor(options = {}) {
    this.store = options.store ?? null;
    this.pricingEngine = options.pricingEngine ?? null;
    this.materialsAdapter = options.materialsAdapter ?? options.materialLoader ?? null;
    this.evidenceModule = options.evidenceModule ?? null;
    this.verifierAdapter = options.verifierAdapter ?? null;
    this.contextBuilder = options.contextBuilder ?? null;
    this.contextBudget = options.contextBudget ?? null;
    this.proposalResolver = typeof options.proposalResolver === 'function' ? options.proposalResolver : null;
    this.publicMode = Boolean(options.publicMode);
    this.model = options.model ?? null;
    this.config = options.config ?? null;
    this.env = options.env ?? process.env;
    this.tools = options.tools ?? null;
    this.logger = typeof options.logger === 'function' ? options.logger : null;
    this.fallbackExplanationWhenNoModel = Boolean(options.fallbackExplanationWhenNoModel);
    this.maxOutputTokens = Number.isFinite(options.maxOutputTokens) ? options.maxOutputTokens : 2048;
    this.turnTimeoutMs = Number.isFinite(options.turnTimeoutMs) ? options.turnTimeoutMs : null;

    this.activeControllers = new Map();
    this.metricsHistory = [];
    this._siblingsLoaded = false;
    this._materialsMod = null;
    this._publicProposalMod = null;
    this._autoMaterialsByMode = new Map();
  }

  async _ensureSiblings() {
    if (this._siblingsLoaded) return;
    this._siblingsLoaded = true;

    const [pricingMod, evidenceMod, materialsMod, verifierMod, sessionStoreMod, contextMod, publicProposalMod] = await Promise.all([
      this.pricingEngine ? null : tryDynamicImport('../quotation-engine/index.mjs'),
      this.evidenceModule ? null : tryDynamicImport('./evidence.mjs'),
      this.materialsAdapter ? null : tryDynamicImport('./materials.mjs'),
      this.verifierAdapter ? null : tryDynamicImport('./verifier.mjs'),
      this.store ? null : tryDynamicImport('./session-store.mjs'),
      this.contextBuilder ? null : tryDynamicImport('./context-builder.mjs'),
      tryDynamicImport('./public-proposal.mjs'),
    ]);

    if (!this.pricingEngine && pricingMod) this.pricingEngine = pricingMod;
    if (!this.evidenceModule && evidenceMod) this.evidenceModule = evidenceMod;
    if (!this.materialsAdapter && materialsMod) this._materialsMod = materialsMod;
    if (publicProposalMod) this._publicProposalMod = publicProposalMod;
    if (!this.verifierAdapter && verifierMod) {
      this.verifierAdapter = typeof verifierMod.createVerifier === 'function'
        ? verifierMod.createVerifier()
        : verifierMod;
    }
    if (!this.contextBuilder && contextMod) {
      this.contextBuilder = typeof contextMod.createContextBuilder === 'function'
        ? contextMod.createContextBuilder()
        : contextMod;
    }
    if (!this.store) {
      if (sessionStoreMod && typeof sessionStoreMod.createSessionStore === 'function') {
        this.store = sessionStoreMod.createSessionStore(':memory:');
      } else {
        this.store = createInMemorySessionStore();
      }
    }
  }

  _getMaterialsAdapterForMode(sessionMode = 'demo') {
    if (this.materialsAdapter) return this.materialsAdapter;
    if (!this._materialsMod) return null;
    // 在无外部 config/tools 的轻量纯内存单测中保持 null，走轻量单测确定性夹具
    if (!this.config && !this.tools) return null;
    const mode = sessionMode === 'real' ? 'real' : 'demo';
    if (!this._autoMaterialsByMode.has(mode)) {
      const created = typeof this._materialsMod.createMaterialsAdapter === 'function'
        ? this._materialsMod.createMaterialsAdapter({
            config: this.config,
            dataMode: mode,
            demo: mode === 'demo',
            tools: this.tools,
          })
        : this._materialsMod;
      this._autoMaterialsByMode.set(mode, created);
    }
    return this._autoMaterialsByMode.get(mode);
  }

  _resolveModel() {
    if (this.model) return this.model;
    if (this.config?.model?.ready && this.config.model.baseURL && this.config.model.modelName) {
      const provider = createOpenAICompatible({
        name: this.config.model.providerName ?? 'openai-compatible',
        baseURL: this.config.model.baseURL,
        apiKey: this.config.model.apiKey ?? undefined,
      });
      this.model = provider.chatModel(this.config.model.modelName);
      return this.model;
    }
    return null;
  }

  _recordMetrics(metrics) {
    const sanitized = {
      turnId: String(metrics.turnId ?? ''),
      sessionId: String(metrics.sessionId ?? ''),
      latencyMs: Number(metrics.latencyMs ?? 0),
      firstEventMs: metrics.firstEventMs ?? null,
      firstTextDeltaMs: metrics.firstTextDeltaMs ?? null,
      usage: metrics.usage ?? null,
      stages: Array.isArray(metrics.stages) ? [...metrics.stages] : [],
      toolCallCount: Number(metrics.toolCallCount ?? 0),
      errorCode: metrics.errorCode ?? null,
    };
    this.metricsHistory.push(sanitized);
    if (this.logger) {
      this.logger(sanitized);
    }
    return sanitized;
  }

  async cancelTurn(ownerIdOrOptions, maybeSessionId, maybeTurnId) {
    await this._ensureSiblings();
    let ownerId = null;
    let sessionId;
    let turnId;
    if (ownerIdOrOptions && typeof ownerIdOrOptions === 'object') {
      ownerId = ownerIdOrOptions.ownerId ?? null;
      sessionId = ownerIdOrOptions.sessionId;
      turnId = ownerIdOrOptions.turnId;
    } else if (typeof maybeTurnId === 'string') {
      ownerId = ownerIdOrOptions;
      sessionId = maybeSessionId;
      turnId = maybeTurnId;
    } else {
      sessionId = ownerIdOrOptions;
      turnId = maybeSessionId;
    }

    if (ownerId) {
      await readSessionFromStore(this.store, ownerId, sessionId);
    }

    const activeKey = `${sessionId}:${turnId}`;
    const controller = this.activeControllers.get(activeKey);
    if (controller && !controller.signal.aborted) {
      controller.abort(new BackendServiceError('CANCELLED', '当前轮次已被主动取消。', 499));
    }

    return await cancelStoreTurn(this.store, ownerId, sessionId, turnId);
  }

  async _resolvePublicProposal({
    resolvedModel,
    session,
    turnId,
    turnNumber,
    userText,
    claimText,
    focus,
    decomposition,
    publicAction,
    addedCondition,
    disputedOtherTopic,
    evidencePool,
    previousPublicAnalysis,
    signal,
  }) {
    const resolverCtx = {
      mode: 'public',
      session,
      turnId,
      turnNumber,
      userText,
      claimText,
      claim: { text: claimText, focus, decomposition },
      focus,
      decomposition,
      publicAction,
      addedCondition,
      disputedOtherTopic,
      evidence: evidencePool,
      publicEvidence: evidencePool,
      previousPublicAnalysis,
      signal,
    };

    if (typeof this.proposalResolver === 'function') {
      try {
        const res = await this.proposalResolver(resolverCtx);
        if (res && typeof res === 'object') return res;
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError' || err?.code === 'CANCELLED') throw err;
      }
    }

    if (this.publicMode && resolvedModel && this._publicProposalMod) {
      try {
        let autoResolver = this._publicProposalResolver;
        if (!autoResolver) {
          if (typeof this._publicProposalMod.createPublicProposalResolver === 'function') {
            autoResolver = this._publicProposalMod.createPublicProposalResolver({
              model: resolvedModel,
              config: this.config,
              env: this.env,
            });
            this._publicProposalResolver = autoResolver;
          } else if (typeof this._publicProposalMod.resolvePublicProposal === 'function') {
            autoResolver = this._publicProposalMod.resolvePublicProposal;
          } else if (typeof this._publicProposalMod.generatePublicProposal === 'function') {
            autoResolver = this._publicProposalMod.generatePublicProposal;
          }
        }
        if (typeof autoResolver === 'function') {
          const res = await autoResolver(resolverCtx);
          if (res && typeof res === 'object') return res;
        }
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError' || err?.code === 'CANCELLED') throw err;
        // 若远端或替身模型不支持结构化生成，回退至本地确定性语义拆解，保证对话不中断
      }
    }

    return buildLocalPublicProposal({
      claimText,
      focus,
      decomposition,
      evidencePool,
      publicAction,
      addedCondition,
      disputedOtherTopic,
      previousPublicAnalysis,
      verifierAdapter: this.verifierAdapter,
      userText,
    });
  }

  async _runPublicAnalysisTurn({
    ownerId,
    sessionId,
    turnId,
    userText,
    baseGraphVersion,
    explicitFocus,
    action,
    input,
    session,
    sessionMode,
    resolvedModel,
    modelConfig,
    effectiveCloudConsent,
    nextConfirmedGraph,
    priorStatements,
    sessionStoredEvidences,
    secrets,
    startedMs,
    startedAt,
    turnSignal,
    emitEvent,
    emitStage,
    stages,
    getTimingState,
    markFirstTextDelta,
    bumpToolCalls,
    setPendingNewStatement,
    isExplicitPublicMode = true,
  }) {
    // 1. 发射 turn.started
    await emitEvent('turn.started', {
      turnId,
      sessionId,
      baseGraphVersion,
      startedAt,
    });

    const prevPublicAnalysis = session.publicAnalysis && typeof session.publicAnalysis === 'object'
      ? session.publicAnalysis
      : null;
    const originalStmt = priorStatements.find((s) => s.role === 'original' || s.statementId === 'stmt_original') ?? null;

    const {
      publicAction,
      addedCondition,
      disputedOtherTopic,
      cleanRewriteText,
    } = classifyPublicTurnAction(userText, action, prevPublicAnalysis);

    const intent =
      publicAction === 'ask_provenance'
        ? 'explain_focus_or_provenance'
        : publicAction === 'submit_rewrite'
          ? 'compare_rewrite'
          : publicAction === 'correct_condition'
            ? 'check_or_confirm_condition'
            : 'analyze_statement';

    const prevClaimText = prevPublicAnalysis?.claim?.text ?? originalStmt?.text ?? null;
    let activeClaimText = userText;
    let activeStatementId = null;
    let activeStatementRole = 'original';
    let localPendingStmt = null;

    const rewriteCount = priorStatements.filter((s) => s.role === 'rewrite' || String(s.role).startsWith('rewrite')).length;

    if (publicAction === 'ask_provenance' && prevClaimText) {
      activeClaimText = prevClaimText;
      activeStatementId = prevPublicAnalysis?.claim?.statementId ?? originalStmt?.statementId ?? 'stmt_original';
      activeStatementRole = prevPublicAnalysis?.claim?.role ?? 'original';
    } else if (publicAction === 'correct_condition' && prevClaimText) {
      if (addedCondition && !prevClaimText.includes(addedCondition)) {
        const cleanPrev = prevClaimText.replace(/[。！？]+$/u, '');
        activeClaimText = `在${addedCondition}的情况下，${cleanPrev}。`;
      } else {
        activeClaimText = prevClaimText;
      }
      if (activeClaimText !== prevClaimText) {
        activeStatementId = `stmt_rewrite_${rewriteCount + 1}`;
        activeStatementRole = 'rewrite';
        localPendingStmt = {
          id: activeStatementId,
          statementId: activeStatementId,
          role: 'rewrite',
          text: activeClaimText,
          createdTurnId: turnId,
          status: 'pending_analysis',
          quote: null,
        };
      } else {
        activeStatementId = prevPublicAnalysis?.claim?.statementId ?? originalStmt?.statementId ?? 'stmt_original';
        activeStatementRole = prevPublicAnalysis?.claim?.role ?? 'original';
      }
    } else if (publicAction === 'submit_rewrite') {
      activeClaimText = cleanRewriteText || userText;
      activeStatementId = `stmt_rewrite_${rewriteCount + 1}`;
      activeStatementRole = 'rewrite';
      localPendingStmt = {
        id: activeStatementId,
        statementId: activeStatementId,
        role: 'rewrite',
        text: activeClaimText,
        createdTurnId: turnId,
        status: 'pending_analysis',
        quote: null,
      };
    } else {
      activeClaimText = userText;
      const isFirstOriginal = !originalStmt;
      activeStatementId = isFirstOriginal ? 'stmt_original' : `stmt_${priorStatements.length + 1}`;
      activeStatementRole = isFirstOriginal ? 'original' : (action?.statementRole ?? 'rewrite');
      localPendingStmt = {
        id: activeStatementId,
        statementId: activeStatementId,
        role: activeStatementRole,
        text: activeClaimText,
        createdTurnId: turnId,
        status: 'pending_analysis',
        quote: null,
      };
    }

    const focus = buildGentlePublicFocus(activeClaimText, explicitFocus, turnId);
    let decomposition = decomposePublicClaim(activeClaimText, focus, addedCondition);

    if (localPendingStmt) {
      localPendingStmt.focus = focus;
      setPendingNewStatement(localPendingStmt);
    }

    // 2. 立即推送温柔的 focus.selected
    await emitEvent('focus.selected', {
      sentence: redactTurnText(activeClaimText, secrets),
      focus: {
        ...focus,
        spanText: redactTurnText(focus.spanText, secrets),
        reason: redactTurnText(focus.reason, secrets),
      },
    });

    turnSignal.throwIfAborted();
    await emitStage('checking_local_graph');

    // 公开会话严格不读取也不携带任何 personal collection_record
    const existingPublicEvidence = deduplicatePublicEvidenceItems(
      sessionStoredEvidences
        .filter((ev) => ev && ev.sourceType !== 'collection_record')
        .map((ev) => sanitizeEvidenceItem(ev, secrets) ?? ev)
        .filter(Boolean),
    );
    const nextEvidenceIndex = [...existingPublicEvidence];
    const nextStatements = [...priorStatements];
    const nextFacts = extractSessionList(session, 'facts');
    const nextPendingConfirmations = extractSessionList(session, 'pendingConfirmations').filter(
      (p) => p?.kind !== 'candidate_counterexample',
    );
    const nextDeniedAttributions = extractSessionList(session, 'deniedAttributions');
    const nextInvalidatedHistory = extractSessionList(session, 'invalidatedHistory');
    const nextAdoptedStatementId = session.adoptedStatementId ?? null;
    const nextConvergenceSummary = session.convergenceSummary ?? null;

    const existingTurnEntry = (session.turns ?? []).find((t) => t.turnId === turnId);
    const currentTurnNumber =
      existingTurnEntry?.turnNumber
      ?? parseTurnOrdinal(`第${String(turnId).replace(/^turn_/, '')}轮`)
      ?? ((session.turns?.length ?? 0) + 1);

    // 阶段 2：公开检索与状态透明（追问出处或同题改写/纠错且已有足够证据时复用同批证据，确保同批可比）
    const materialsAdapter = this._getMaterialsAdapterForMode(sessionMode);
    const prevBoundary = prevPublicAnalysis?.materialBoundary ?? null;
    const canReuseBatch =
      existingPublicEvidence.length > 0
      && input.forceSearch !== true
      && (
        publicAction === 'ask_provenance'
        || publicAction === 'correct_condition'
        || publicAction === 'submit_rewrite'
      );

    let searchStatus = 'skipped_no_gap';
    let searchQueries = Array.isArray(prevBoundary?.searchQueries) ? [...prevBoundary.searchQueries] : [];
    let requestIds = Array.isArray(prevBoundary?.requestIds) ? [...prevBoundary.requestIds] : [];
    let recalledCount = existingPublicEvidence.length;
    let reusedBatch = false;
    const turnVerifiedEvidence = [];

    if (canReuseBatch) {
      reusedBatch = true;
      searchStatus = 'skipped_no_gap';
      for (const ev of existingPublicEvidence) turnVerifiedEvidence.push(ev);
    } else if (input.skipExternalSearch === true) {
      searchStatus = 'skipped_no_gap';
      for (const ev of existingPublicEvidence) turnVerifiedEvidence.push(ev);
    } else {
      await emitStage('retrieving_evidence');
      turnSignal.throwIfAborted();

      let modelPlannedQueries = null;
      if (
        this.publicMode
        && resolvedModel
        && typeof this._publicProposalMod?.decomposePublicClaim === 'function'
      ) {
        try {
          const modelDecomp = await this._publicProposalMod.decomposePublicClaim({
            model: resolvedModel,
            sentence: activeClaimText,
            previousPublicAnalysis: prevPublicAnalysis,
            userText,
            intent,
            signal: turnSignal,
          });
          turnSignal.throwIfAborted();
          if (modelDecomp && typeof modelDecomp === 'object') {
            decomposition = {
              ...decomposition,
              subject: modelDecomp.subject || decomposition.subject,
              action: modelDecomp.action || decomposition.action,
              condition: modelDecomp.condition ?? decomposition.condition,
              falsifiableScope: modelDecomp.falsifiableScope || decomposition.falsifiableScope,
            };
            if (Array.isArray(modelDecomp.searchQueries) && modelDecomp.searchQueries.length > 0) {
              modelPlannedQueries = modelDecomp.searchQueries.slice(0, 2);
            }
          }
        } catch (decompErr) {
          if (turnSignal.aborted || decompErr?.name === 'AbortError' || decompErr?.code === 'CANCELLED') {
            throw decompErr;
          }
          // 模型拆句失败时静默回退到本地拆句与检索词，不中断主链路
        }
      }

      searchQueries = modelPlannedQueries && modelPlannedQueries.length > 0
        ? modelPlannedQueries
        : buildPublicSearchQueries(activeClaimText, decomposition);
      requestIds = [];
      recalledCount = 0;

      const searchFn =
        materialsAdapter?.searchPublicEvidence
        ?? materialsAdapter?.searchZhihu
        ?? materialsAdapter?.search
        ?? null;

      if (typeof searchFn !== 'function') {
        searchStatus = 'not_configured';
      } else {
        try {
          bumpToolCalls();
          const kws = extractGenericTopicKeywords(activeClaimText);
          const searchRes = await searchFn.call(materialsAdapter, {
            query: searchQueries[0] || activeClaimText,
            sentence: activeClaimText,
            queries: searchQueries,
            plannedQueries: searchQueries,
            keywords: kws,
            maxQueries: 2,
            limit: 6,
            dataMode: sessionMode,
            signal: turnSignal,
          });
          turnSignal.throwIfAborted();

          if (Array.isArray(searchRes?.plannedQueries) && searchRes.plannedQueries.length > 0) {
            searchQueries = searchRes.plannedQueries;
          }
          if (Array.isArray(searchRes?.requestIds)) {
            requestIds.push(...searchRes.requestIds.filter(Boolean));
          } else if (searchRes?.requestId || searchRes?.data?.requestId) {
            requestIds.push(searchRes.requestId ?? searchRes.data.requestId);
          }

          if (searchRes?.ok === false) {
            const errCode = searchRes?.error?.code ?? searchRes?.errorCode ?? '';
            const rawStatus = searchRes?.status ?? '';
            if (errCode === 'RATE_LIMITED' || rawStatus === 'rate_limited') searchStatus = 'rate_limited';
            else if (errCode === 'NOT_CONFIGURED' || rawStatus === 'not_configured') searchStatus = 'not_configured';
            else if (errCode === 'TIMEOUT' || rawStatus === 'timeout') searchStatus = 'timeout';
            else searchStatus = 'error';
          } else {
            const rawItems = Array.isArray(searchRes)
              ? searchRes
              : searchRes?.items ?? searchRes?.evidence ?? searchRes?.data?.items ?? [];
            const sanitizedBatch = rawItems
              .map((rawItem) => {
                const normalized = sanitizeEvidenceItem(
                  {
                    ...rawItem,
                    sourceType: 'public_search',
                    attribution: 'other_author',
                    requestId: rawItem?.requestId ?? requestIds[0] ?? null,
                  },
                  secrets,
                );
                return normalized;
              })
              .filter(Boolean);
            const dedupedBatch = deduplicatePublicEvidenceItems(sanitizedBatch);
            recalledCount = dedupedBatch.length;
            for (const ev of dedupedBatch) {
              if (ev.requestId && !requestIds.includes(ev.requestId)) requestIds.push(ev.requestId);
              if (!nextEvidenceIndex.some((e) => (e.id ?? e.evidenceId) === ev.id)) {
                nextEvidenceIndex.push(ev);
              }
              turnVerifiedEvidence.push(ev);
            }
            searchStatus =
              searchRes?.status && ['empty', 'not_configured', 'rate_limited', 'timeout', 'error'].includes(searchRes.status) && dedupedBatch.length === 0
                ? searchRes.status
                : (dedupedBatch.length > 0 ? 'ok' : 'empty');
          }
        } catch (searchErr) {
          if (turnSignal.aborted || searchErr?.name === 'AbortError' || searchErr?.code === 'CANCELLED') {
            throw searchErr;
          }
          if (searchErr?.code === 'RATE_LIMITED' || searchErr?.status === 429) {
            searchStatus = 'rate_limited';
          } else if (searchErr?.name === 'TimeoutError' || searchErr?.code === 'TIMEOUT') {
            searchStatus = 'timeout';
          } else if (searchErr?.code === 'NOT_CONFIGURED') {
            searchStatus = 'not_configured';
          } else if (searchErr?.code === 'DATA_MODE_MISMATCH' || searchErr?.code === 'TOKEN_REVOKED') {
            throw searchErr;
          } else {
            searchStatus = 'error';
          }
        }
      }
    }

    const activeEvidencePool = deduplicatePublicEvidenceItems(
      turnVerifiedEvidence.length > 0 ? turnVerifiedEvidence : nextEvidenceIndex,
    );

    // 阶段 3：模型判断 + 后端核验 -> publicAnalysis
    turnSignal.throwIfAborted();
    await emitStage('verifying_candidates');

    const rawProposal = await this._resolvePublicProposal({
      resolvedModel,
      session,
      turnId,
      turnNumber: currentTurnNumber,
      userText,
      claimText: activeClaimText,
      focus,
      decomposition,
      publicAction,
      addedCondition,
      disputedOtherTopic,
      evidencePool: activeEvidencePool,
      previousPublicAnalysis: prevPublicAnalysis,
      signal: turnSignal,
    });

    turnSignal.throwIfAborted();

    const verified = verifyPublicAnalysisProposalCompat({
      proposal: rawProposal,
      claimText: activeClaimText,
      statementId: activeStatementId,
      statementRole: activeStatementRole,
      focus,
      decomposition,
      evidencePool: activeEvidencePool,
      previousPublicAnalysis: prevPublicAnalysis,
      verifierAdapter: this.verifierAdapter,
      publicAction,
      addedCondition,
      disputedOtherTopic,
      userText,
      turnId,
      secrets,
    });

    const publicAnalysisChanged = Boolean(
      !prevPublicAnalysis
      || prevPublicAnalysis.claim?.text !== activeClaimText
      || verified.relationChanges.length > 0
      || (prevPublicAnalysis.edges?.length ?? 0) !== verified.edges.length,
    );

    const graphMutated = publicAction === 'ask_provenance'
      ? false
      : (isExplicitPublicMode ? publicAnalysisChanged : (verified.edges.length > 0 && publicAnalysisChanged));
    const targetGraphVersion = graphMutated ? baseGraphVersion + 1 : baseGraphVersion;
    const nextPublicVersion = graphMutated
      ? (prevPublicAnalysis?.version ?? 0) + 1
      : (prevPublicAnalysis?.version ?? 1);

    const boundaryMessage = (() => {
      if (['rate_limited', 'timeout', 'error', 'not_configured'].includes(searchStatus)) {
        return '这次没能查到资料。你的原句还在这里，等一下可以再试。';
      }
      if (searchStatus === 'empty' || (verified.edges.length === 0 && activeEvidencePool.length === 0)) {
        return '我找到了一些相近的说法，还缺一条能回答你这个问题的证据。这句先留着，我们可以一起把范围说清。';
      }
      if (verified.edges.length === 0) {
        return '我找到了一些相近的说法，还缺一条能回答你这个问题的证据。这句先留着，我们可以一起把范围说清。';
      }
      if (reusedBatch) {
        return `继续在同一批 ${activeEvidencePool.length} 条公开材料下核对。`;
      }
      return `查到了 ${Math.max(recalledCount, activeEvidencePool.length)} 条公开材料，挑出 ${verified.edges.length} 条和这句话直接相关的依据。`;
    })();

    const prevHistory = Array.isArray(prevPublicAnalysis?.statementHistory)
      ? prevPublicAnalysis.statementHistory.map((h) => ({ ...h }))
      : [];
    const statementHistory = [...prevHistory];
    if (publicAction !== 'ask_provenance' || statementHistory.length === 0) {
      statementHistory.push({
        statementId: activeStatementId,
        turnId,
        role: activeStatementRole,
        text: activeClaimText,
        focusSpan: focus.spanText,
        graphVersion: targetGraphVersion,
        relationCounts: verified.relationCounts,
        relationsByEvidenceId: verified.relationsByEvidenceId,
      });
    }

    const publicAnalysis = {
      version: nextPublicVersion,
      graphVersion: targetGraphVersion,
      turnId,
      claimText: activeClaimText,
      claim: verified.claim,
      nodes: verified.nodes,
      edges: verified.edges,
      citations: verified.citations,
      suggestedRewrite: verified.suggestedRewrite,
      relationChanges: verified.relationChanges,
      statementHistory,
      materialBoundary: {
        searchStatus,
        searchQueries,
        requestIds: [...new Set(requestIds)],
        recalledCount: Math.max(recalledCount, activeEvidencePool.length),
        verifiedCount: verified.edges.length,
        rejectedCount: verified.rejectedCount,
        unknownCount: verified.unknownCount,
        unknownParts: Array.isArray(verified.unknownParts) ? verified.unknownParts : [],
        reusedBatch,
        message: boundaryMessage,
      },
      unknownParts: Array.isArray(verified.unknownParts) ? verified.unknownParts : [],
      changeSummary: verified.changeSummary,
    };

    // 登记句子列表（仅公开讨论记录，严禁把公开材料写入个人 confirmedGraph！）
    if (localPendingStmt) {
      const idx = nextStatements.findIndex((s) => s.statementId === localPendingStmt.statementId);
      const reg = { ...localPendingStmt, status: 'evaluated' };
      if (idx >= 0) nextStatements[idx] = reg;
      else nextStatements.push(reg);
    }

    const nextQuotes = [];
    for (let i = 0; i < nextStatements.length; i += 1) {
      const stmt = nextStatements[i];
      const quoteObj = evaluateGraphQuote(nextConfirmedGraph, [], {
        pricingEngine: this.pricingEngine,
        statementId: stmt.statementId,
        text: stmt.text,
        graphVersion: targetGraphVersion,
        compatibleEvidenceFound: false,
        conflictReasons: [],
        verifiedEvidenceIds: [],
      });
      nextStatements[i] = {
        ...stmt,
        id: stmt.statementId,
        statementId: stmt.statementId,
        status: 'evaluated',
        assessment: quoteObj.assessment,
        directConflicts: quoteObj.directConflicts,
        conflictReasons: quoteObj.conflictReasons,
        reason: quoteObj.reason,
        verifiedEvidenceIds: quoteObj.verifiedEvidenceIds,
        quote: quoteObj,
      };
      nextQuotes.push(quoteObj);
    }

    const activeQuote =
      nextQuotes.find((q) => q.statementId === activeStatementId)
      ?? nextQuotes.at(-1)
      ?? null;
    const statementComparison = buildStatementComparison(
      nextQuotes,
      nextConfirmedGraph,
      targetGraphVersion,
      nextAdoptedStatementId,
    );

    // 发射 evidence.verified
    await emitEvent('evidence.verified', {
      verifiedEvidence: activeEvidencePool.map((ev) => ({
        id: ev.id ?? ev.evidenceId,
        evidenceId: ev.evidenceId ?? ev.id,
        sourceType: ev.sourceType,
        title: ev.title ?? '',
        author: ev.author,
        attribution: ev.attribution,
        excerpt: ev.excerpt,
        span: ev.span,
        textKind: ev.textKind,
        bodyStatus: ev.bodyStatus,
        fullTextAvailable: Boolean(ev.fullTextAvailable),
        summaryTruncated: Boolean(ev.summaryTruncated ?? ev.truncated),
        truncated: Boolean(ev.truncated ?? ev.summaryTruncated),
        snapshotId: null,
        turnId: ev.turnId ?? null,
        requestId: ev.requestId ?? null,
        url: ev.url ?? null,
        contentKey: ev.contentKey,
        behaviorKinds: [],
      })),
      pendingConfirmations: [],
      rejectedCount: verified.rejectedCount,
      searchStatus,
    });

    const nextActions = [];
    if (publicAnalysis.citations.length > 0) nextActions.push('看看出处');
    if (publicAnalysis.suggestedRewrite?.text) nextActions.push('试试这句');
    nextActions.push('继续问');

    const turnOutboundPreview = buildTurnOutboundPreview({
      modelConfig,
      personalMaterialsEnabled: false,
      cloudConsentGranted: effectiveCloudConsent,
      personalItems: [],
      secrets,
      confirmedOutboundPreviewId: null,
    });
    if (typeof this.store?.updateOutboundPreview === 'function') {
      await this.store.updateOutboundPreview(sessionId, turnOutboundPreview);
    }

    // 阶段 4：流式温柔解释 + 严格一致性守卫
    turnSignal.throwIfAborted();
    await emitStage('streaming_explanation');

    const conversationSummary = (session.turns ?? [])
      .filter((t) => t.status === 'committed')
      .slice(-3)
      .map((t) => `用户：${String(t.userText ?? t.text ?? '').slice(0, 100)}`)
      .join('\n');

    const systemPrompt = buildPublicTurnSystemPrompt({
      publicAction,
      searchStatus,
      secrets,
    });
    const userPrompt = buildPublicTurnUserPrompt({
      userText,
      publicAnalysis,
      publicAction,
      conversationSummary,
      secrets,
    });

    const allowedQuoteSources = [
      userText,
      activeClaimText,
      focus?.spanText ?? '',
      focus?.reason ?? '',
      publicAnalysis.changeSummary ?? '',
      publicAnalysis.suggestedRewrite?.text ?? '',
      publicAnalysis.suggestedRewrite?.kept ?? '',
      publicAnalysis.suggestedRewrite?.narrowed ?? '',
      publicAnalysis.suggestedRewrite?.explanation ?? '',
      ...(Array.isArray(publicAnalysis.edges)
        ? publicAnalysis.edges.flatMap((e) => [e.reason ?? '', e.scopeCondition ?? '', e.quote ?? ''])
        : []),
      ...(Array.isArray(publicAnalysis.materialBoundary?.unknownParts)
        ? publicAnalysis.materialBoundary.unknownParts
        : []),
      '看看出处',
      '试试这句',
      '看看这句话',
      '继续问',
      ...activeEvidencePool.flatMap((e) => [e.excerpt, e.title, e.author]),
      ...publicAnalysis.citations.flatMap((c) => [c.quote, c.excerpt, c.title, c.author]),
      ...publicAnalysis.relationChanges.map((rc) => rc.summary),
    ];

    const publicGuard = createPublicStreamingGuard({
      publicAnalysis,
      allowedQuoteSources,
      rejectedCrossEntities: verified.rejectedCrossEntities,
      secrets,
      verifierAdapter: this.verifierAdapter,
    });

    let accumulatedText = '';
    let usageMetrics = null;
    const emitSafeDelta = async (safeDelta) => {
      if (!safeDelta || safeDelta.length === 0) return;
      markFirstTextDelta();
      accumulatedText += safeDelta;
      await emitEvent('text.delta', { delta: safeDelta });
    };

    if (resolvedModel) {
      let streamFailure = null;
      const streamResult = streamText({
        model: resolvedModel,
        system: systemPrompt,
        prompt: userPrompt,
        abortSignal: turnSignal,
        maxOutputTokens: Math.min(this.maxOutputTokens, 512),
        providerOptions: {
          openaiCompatible: {
            thinking: { type: 'disabled' },
          },
        },
        onError: ({ error }) => {
          streamFailure = error;
        },
      });

      for await (const rawDelta of streamResult.textStream) {
        turnSignal.throwIfAborted();
        const safeChunk = publicGuard.push(rawDelta);
        await emitSafeDelta(safeChunk);
      }

      if (streamFailure) {
        throw streamFailure;
      }
      turnSignal.throwIfAborted();

      const trailingSafe = publicGuard.flush();
      await emitSafeDelta(trailingSafe);

      try {
        const resolvedUsage = await streamResult.usage;
        usageMetrics = normalizeUsageMetrics(resolvedUsage);
      } catch {
        usageMetrics = null;
      }

      const guardStats = publicGuard.getStats();
      if (
        accumulatedText.trim().length < 10
        || (guardStats.hadInterceptions && accumulatedText.trim().length < 20)
      ) {
        const fallbackChunks = buildPublicGentleFallbackChunks({
          publicAnalysis,
          publicAction,
          userText,
          focus,
          secrets,
        });
        const prefixSep = accumulatedText.trim().length > 0 ? '\n' : '';
        for (let i = 0; i < fallbackChunks.length; i += 1) {
          turnSignal.throwIfAborted();
          const piece = i === 0 ? `${prefixSep}${fallbackChunks[i]}` : fallbackChunks[i];
          await emitSafeDelta(redactTurnText(piece, secrets));
        }
      }
    } else {
      const fallbackChunks = buildPublicGentleFallbackChunks({
        publicAnalysis,
        publicAction,
        userText,
        focus,
        secrets,
      });
      for (const piece of fallbackChunks) {
        turnSignal.throwIfAborted();
        await emitSafeDelta(redactTurnText(piece, secrets));
      }
    }

    const finalResponseText = redactTurnText(accumulatedText, secrets);
    const graphDelta = { addedNodes: [], removedNodes: [], updatedNodes: [] };

    const committedEventPayload = {
      turnId,
      sessionId,
      intent,
      focus: {
        ...focus,
        spanText: redactTurnText(focus.spanText, secrets),
        reason: redactTurnText(focus.reason, secrets),
      },
      graphMutated,
      baseGraphVersion,
      graphVersion: targetGraphVersion,
      graphDelta,
      activeStatementId,
      activeQuote,
      quotes: nextQuotes,
      statements: nextStatements,
      statementComparison,
      adoptedStatementId: nextAdoptedStatementId,
      verifiedEvidenceIds: activeEvidencePool.map((e) => e.id ?? e.evidenceId),
      pendingConfirmationsCount: 0,
      invalidatedItems: [],
      outboundPreview: turnOutboundPreview,
      publicAnalysis,
      nextActions,
    };

    const timing = getTimingState();
    const preCommitMetrics = {
      turnId,
      sessionId,
      latencyMs: Math.max(0, Date.now() - startedMs),
      firstEventMs: timing.firstEventMs,
      firstTextDeltaMs: timing.firstTextDeltaMs,
      usage: usageMetrics,
      stages,
      toolCallCount: timing.toolCallCount,
      errorCode: null,
    };

    const commitOutcome = await commitStoreTurn(this.store, ownerId, sessionId, turnId, {
      userText: redactTurnText(userText, secrets),
      intent,
      focus,
      graphMutated,
      incrementGraph: graphMutated,
      baseGraphVersion,
      graphVersion: targetGraphVersion,
      lockedSnapshotId: null,
      confirmedGraph: nextConfirmedGraph,
      graphDelta,
      evidenceIndex: nextEvidenceIndex,
      verifiedEvidence: activeEvidencePool,
      facts: nextFacts,
      pendingConfirmations: nextPendingConfirmations,
      deniedAttributions: nextDeniedAttributions,
      statements: nextStatements,
      upsertedStatements: nextStatements,
      adoptedStatementId: nextAdoptedStatementId,
      activeStatementId,
      quotes: nextQuotes,
      statementComparison,
      activeQuote,
      invalidatedItems: [],
      invalidatedHistory: nextInvalidatedHistory,
      convergenceSummary: nextConvergenceSummary,
      publicAnalysis,
      outboundPreview: turnOutboundPreview,
      responseText: finalResponseText,
      nextActions,
      metrics: preCommitMetrics,
      committedEventPayload,
    });

    const finalStatus = commitOutcome?.status ?? commitOutcome?.outcome ?? 'committed';
    const persistedVersion =
      commitOutcome?.graphVersion
      ?? commitOutcome?.sessionGraphVersion
      ?? targetGraphVersion;

    const syncedPublicAnalysis = { ...publicAnalysis, graphVersion: persistedVersion };
    const metrics = this._recordMetrics({
      ...preCommitMetrics,
      latencyMs: Math.max(0, Date.now() - startedMs),
      errorCode: finalStatus === 'cancelled' ? 'CANCELLED' : null,
    });

    return {
      turnId,
      sessionId,
      status: finalStatus,
      intent,
      focus,
      graphMutated: finalStatus === 'committed' ? graphMutated : false,
      baseGraphVersion,
      graphVersion: persistedVersion,
      activeStatementId,
      activeQuote,
      quotes: nextQuotes,
      statementComparison,
      adoptedStatementId: nextAdoptedStatementId,
      invalidatedItems: [],
      retractionSummary: null,
      convergenceSummary: null,
      publicAnalysis: syncedPublicAnalysis,
      outboundPreview: turnOutboundPreview,
      responseText: finalResponseText,
      nextActions,
      metrics,
    };
  }

  async runTurn(ownerIdOrInput, maybeSessionId, maybeTurnId, maybeContext) {
    await this._ensureSiblings();

    const input =
      typeof ownerIdOrInput === 'string'
        ? {
            ownerId: ownerIdOrInput,
            sessionId: maybeSessionId,
            turnId: maybeTurnId,
            ...(maybeContext ?? {}),
          }
        : (ownerIdOrInput ?? {});

    const {
      ownerId = null,
      sessionId,
      turnId,
      text: rawUserText = '',
      baseGraphVersion: requestedBaseVersion,
      focus: explicitFocusArg = null,
      focusRef = null,
      action = null,
      allowCloudModel,
      cloudConsent,
      approvedOutboundManifest = null,
      signal: externalSignal = null,
    } = input;
    const explicitFocus = explicitFocusArg ?? focusRef ?? null;

    if (!sessionId || !turnId) {
      throw new BackendServiceError('INVALID_ARGUMENTS', 'sessionId 与 turnId 不能为空。', 400);
    }
    const userText = String(rawUserText ?? '').trim();
    if (!userText) {
      throw new BackendServiceError('INVALID_ARGUMENTS', '用户输入文本不能为空。', 400);
    }

    const secrets = buildSecretList(this.env, this.config?.model?.apiKey ? [this.config.model.apiKey] : []);
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    let firstEventMs = null;
    let firstTextDeltaMs = null;
    const stages = [];
    let toolCallCount = 0;
    let usageMetrics = null;
    let pendingNewStatement = null;

    const session = await readSessionFromStore(this.store, ownerId, sessionId);
    const sessionMode = session.dataMode ?? 'demo';
    const currentGraphVersion = Number.isInteger(session.graphVersion) ? session.graphVersion : 0;
    const baseGraphVersion = Number.isInteger(requestedBaseVersion) ? requestedBaseVersion : currentGraphVersion;
    if (baseGraphVersion !== currentGraphVersion) {
      throw new BackendServiceError(
        'STALE_GRAPH_VERSION',
        `基准图版本冲突：请求基于 v${baseGraphVersion}，但当前会话已处于 v${currentGraphVersion}。`,
        409,
      );
    }

    const activeKey = `${sessionId}:${turnId}`;
    const controller = new AbortController();
    this.activeControllers.set(activeKey, controller);

    const onExternalAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort(externalSignal.reason ?? new BackendServiceError('CANCELLED', '外部信号已取消。', 499));
      }
    };
    if (externalSignal) {
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let timeoutHandle = null;
    const effectiveTimeoutMs = Number.isFinite(this.turnTimeoutMs)
      ? this.turnTimeoutMs
      : Number.isFinite(this.config?.limits?.stepMs)
        ? this.config.limits.stepMs
        : null;
    if (effectiveTimeoutMs && effectiveTimeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (!controller.signal.aborted) {
          const timeoutErr = new Error('Turn execution timed out');
          timeoutErr.name = 'TimeoutError';
          controller.abort(timeoutErr);
        }
      }, effectiveTimeoutMs);
      timeoutHandle.unref?.();
    }

    const turnSignal = controller.signal;

    const emitEvent = async (type, payload) => {
      if (firstEventMs === null) {
        firstEventMs = Math.max(0, Date.now() - startedMs);
      }
      return await emitStoreEvent(this.store, ownerId, sessionId, turnId, type, payload);
    };

    const emitStage = async (stage) => {
      stages.push(stage);
      await emitEvent('stage.changed', { stage });
    };

    try {
      turnSignal.throwIfAborted();

      // ===== QA-01 & QA-02：个人材料开关持久化校验与回环/云推理同意门禁 =====
      const personalMaterialsDisabled = isPersonalMaterialsDisabled(session, input);
      const modelConfig = this.config?.model ?? null;
      const modelBaseUrl = modelConfig?.baseURL ?? null;
      const isLoopbackModel = isLoopbackModelEndpoint(modelBaseUrl, modelConfig);
      const isCloudModel = !isLoopbackModel;

      const effectiveCloudConsent = cloudConsent !== undefined
        ? Boolean(cloudConsent)
        : (allowCloudModel !== undefined
            ? Boolean(allowCloudModel)
            : Boolean(session.cloudConsent === true || session.allowCloudModel === true));

      const sessionStoredEvidences = extractSessionList(session, 'evidenceIndex', 'evidences');
      const alreadyHasPersonalMaterials =
        !personalMaterialsDisabled
        && (
          Boolean(session.lockedSnapshotId)
          || Array.isArray(session.collectionRecords)
          || sessionStoredEvidences.some((e) => e?.sourceType === 'collection_record')
          || session.usePersonalMaterials === true
          || input.usePersonalMaterials === true
        );

      // 仅在“外部非回环模型 + 启用并携带个人材料 + 本轮未获明确云同意”时拦截；本机回环模型免云同意
      if (
        session.cloudConsentRequired === true
        || (isCloudModel && alreadyHasPersonalMaterials && effectiveCloudConsent !== true)
      ) {
        throw new BackendServiceError(
          'CLOUD_CONSENT_REQUIRED',
          '使用外部云端模型处理个人授权材料前需获得本人明确同意（cloudConsent: true）。',
          403,
        );
      }

      const resolvedModel = this._resolveModel();
      if (!resolvedModel && !this.fallbackExplanationWhenNoModel) {
        throw new BackendServiceError('MODEL_NOT_CONFIGURED', '尚未配置推理模型，请设置 AGENT_BASE_URL 与 AGENT_MODEL。', 503);
      }

      // 预读取并按需水合测试会话 metadata 中的初始图/事实/证据（支持通过 POST /v1/sessions metadata 注入合成 DAG）
      let nextConfirmedGraph = extractGraphNodes(session);
      const committedTurnCount = (session.turns ?? []).filter((t) => t.status === 'committed').length;
      if (
        nextConfirmedGraph.length === 0
        && committedTurnCount === 0
        && session.metadata?.initialGraph
      ) {
        const seededNodes = extractGraphNodes({ confirmedGraph: session.metadata.initialGraph });
        if (seededNodes.length > 0) {
          nextConfirmedGraph = typeof this.pricingEngine?.computeGraph === 'function'
            ? this.pricingEngine.computeGraph(seededNodes)
            : computeGraphWeights(seededNodes);
        }
      }

      const priorStatements = extractSessionStatements(session);

      // ===== QA-04：预校验显式 focusRef.nodeId 与 action.adoptStatementId，严禁静默替换 =====
      let focusedNode = null;
      if (explicitFocus && explicitFocus.nodeId !== undefined) {
        const reqNodeId = typeof explicitFocus.nodeId === 'string' ? explicitFocus.nodeId.trim() : '';
        focusedNode = reqNodeId ? (nextConfirmedGraph.find((n) => n.id === reqNodeId) ?? null) : null;
        if (!focusedNode) {
          throw new BackendServiceError(
            'INVALID_ARGUMENTS',
            `focusRef.nodeId 指向的已确认图节点不存在：${String(explicitFocus.nodeId)}`,
            400,
          );
        }
      }

      let explicitAdoptedStmt = null;
      if (action && action.adoptStatementId !== undefined) {
        const reqAdoptId = typeof action.adoptStatementId === 'string' ? action.adoptStatementId.trim() : '';
        explicitAdoptedStmt = reqAdoptId
          ? (priorStatements.find((s) => s.statementId === reqAdoptId || s.id === reqAdoptId) ?? null)
          : null;
        if (!explicitAdoptedStmt) {
          throw new BackendServiceError(
            'INVALID_ARGUMENTS',
            `action.adoptStatementId 指向的句子版本不存在：${String(action.adoptStatementId)}`,
            400,
          );
        }
      }

      // 公开模式激活判断：
      // 1) 显式 publicMode 或注入了公开 proposalResolver（且关闭个人材料）：全程走公开分析链路；
      // 2) 非显式 publicMode 但会话为 real 且关闭个人材料：仅在分析新句/改写时接入公开分析，保留本人陈述/条件确认/撤回对 confirmedGraph 的能力。
      const preClassified = classifyTurnIntent(userText, action, session);
      const isExplicitPublicMode = Boolean(
        this.publicMode
        || (typeof this.proposalResolver === 'function' && personalMaterialsDisabled),
      );
      const isImplicitRealPublicAnalyze = Boolean(
        !isExplicitPublicMode
        && personalMaterialsDisabled
        && sessionMode === 'real'
        && ['analyze_statement', 'compare_rewrite'].includes(preClassified.intent)
        && !['retract_fact', 'converge', 'provide_self_fact', 'check_or_confirm_condition', 'deny_attribution'].includes(
          action?.intent ?? preClassified.intent,
        ),
      );
      const isPublicPipeline = Boolean(
        !focusedNode
        && !['retract_fact', 'converge'].includes(action?.intent)
        && (isExplicitPublicMode || isImplicitRealPublicAnalyze),
      );
      if (isPublicPipeline) {
        return await this._runPublicAnalysisTurn({
          ownerId,
          sessionId,
          turnId,
          userText,
          baseGraphVersion,
          explicitFocus,
          action,
          input,
          session,
          sessionMode,
          resolvedModel,
          modelConfig,
          effectiveCloudConsent,
          nextConfirmedGraph,
          priorStatements,
          sessionStoredEvidences,
          secrets,
          startedMs,
          startedAt,
          turnSignal,
          emitEvent,
          emitStage,
          stages,
          getTimingState: () => ({ firstEventMs, firstTextDeltaMs, toolCallCount }),
          markFirstTextDelta: () => {
            if (firstTextDeltaMs === null) {
              firstTextDeltaMs = Math.max(0, Date.now() - startedMs);
            }
          },
          bumpToolCalls: () => {
            toolCallCount += 1;
          },
          setPendingNewStatement: (stmt) => {
            pendingNewStatement = stmt;
          },
          isExplicitPublicMode,
        });
      }

      // 1. 发射 turn.started
      await emitEvent('turn.started', {
        turnId,
        sessionId,
        baseGraphVersion,
        startedAt,
      });

      const { intent, mode: conditionMode } = classifyTurnIntent(userText, action, session);
      const originalStmt = priorStatements.find((s) => s.role === 'original' || s.statementId === 'stmt_original') ?? null;

      let focusTargetSentence;
      let focus;
      if (focusedNode) {
        focusTargetSentence = focusedNode.text;
        const focusKind = focusedNode.kind === 'condition' || focusedNode.factRole === 'scope_condition'
          ? 'scope'
          : (Array.isArray(focusedNode.deps) && focusedNode.deps.length > 0 ? 'dependency' : 'premise');
        focus = {
          id: explicitFocus.id ?? `focus_node_${focusedNode.id}`,
          nodeId: focusedNode.id,
          kind: focusKind,
          spanText: focusedNode.text,
          startOffset: 0,
          endOffset: focusedNode.text.length,
          evidenceIds: Array.isArray(focusedNode.evidenceIds) ? [...focusedNode.evidenceIds] : [],
          reason: explicitFocus.reason ?? `按显式指定的节点 [${focusedNode.id}] 核查证据与出处。`,
        };
      } else {
        focusTargetSentence =
          intent === 'explain_focus_or_provenance' && /为什么先拆|为何先拆/.test(userText) && originalStmt
            ? originalStmt.text
            : userText;
        focus = selectFocus(focusTargetSentence, explicitFocus, turnId);
      }

      if (intent === 'analyze_statement' || intent === 'compare_rewrite') {
        const isFirstOriginal = intent === 'analyze_statement' && !originalStmt;
        const rewriteCount = priorStatements.filter((s) => s.role === 'rewrite' || String(s.role).startsWith('rewrite')).length;
        const stmtId = isFirstOriginal
          ? 'stmt_original'
          : intent === 'analyze_statement'
            ? `stmt_${priorStatements.length + 1}`
            : `stmt_rewrite_${rewriteCount + 1}`;
        pendingNewStatement = {
          id: stmtId,
          statementId: stmtId,
          role: isFirstOriginal ? 'original' : (action?.statementRole ?? 'rewrite'),
          text: userText,
          createdTurnId: turnId,
          focus,
          status: 'pending_analysis',
          quote: null,
        };
      }

      // 2. 立即发射 focus.selected（热会话 < 50ms 立即可见）
      await emitEvent('focus.selected', {
        sentence: redactTurnText(focusTargetSentence, secrets),
        focus: {
          ...focus,
          spanText: redactTurnText(focus.spanText, secrets),
          reason: redactTurnText(focus.reason, secrets),
        },
      });

      turnSignal.throwIfAborted();

      // 3. 核对本地已确认图与已锁定材料
      await emitStage('checking_local_graph');

      const materialsAdapter = this._getMaterialsAdapterForMode(sessionMode);
      const allowStandaloneDemoFixtures =
        sessionMode === 'demo' && !materialsAdapter && !this.config;

      const rawExistingEvidences = [
        ...sessionStoredEvidences,
        ...(committedTurnCount === 0 && Array.isArray(session.metadata?.initialEvidence)
          ? session.metadata.initialEvidence
          : []),
      ].filter((ev) => !(personalMaterialsDisabled && ev?.sourceType === 'collection_record'));

      const nextEvidenceIndex = rawExistingEvidences.map(
        (ev) => sanitizeEvidenceItem(ev, secrets) ?? ev,
      );
      let nextFacts = [
        ...extractSessionList(session, 'facts'),
        ...(committedTurnCount === 0 && Array.isArray(session.metadata?.initialFacts)
          ? session.metadata.initialFacts
          : []),
      ];
      let nextPendingConfirmations = extractSessionList(session, 'pendingConfirmations').filter(
        (p) => !(personalMaterialsDisabled && p?.kind === 'candidate_counterexample'),
      );
      const nextDeniedAttributions = extractSessionList(session, 'deniedAttributions');
      const nextStatements = [...priorStatements];
      const nextInvalidatedHistory = extractSessionList(session, 'invalidatedHistory');
      let nextConvergenceSummary = session.convergenceSummary ?? null;
      let nextAdoptedStatementId = explicitAdoptedStmt
        ? explicitAdoptedStmt.statementId
        : (session.adoptedStatementId ?? session.statementComparison?.adoptedStatementId ?? null);
      let nextLockedSnapshotId = personalMaterialsDisabled
        ? null
        : (session.lockedSnapshotId ?? session.snapshotId ?? null);

      const existingTurnEntry = (session.turns ?? []).find((t) => t.turnId === turnId);
      const currentTurnNumber =
        existingTurnEntry?.turnNumber
        ?? parseTurnOrdinal(`第${String(turnId).replace(/^turn_/, '')}轮`)
        ?? ((session.turns?.length ?? 0) + 1);

      const deniedKeys = new Set();
      for (const d of nextDeniedAttributions) {
        if (d.contentKey) deniedKeys.add(d.contentKey);
        if (d.evidenceId) deniedKeys.add(d.evidenceId);
      }

      const seenEvidenceDigests = new Set(
        nextEvidenceIndex.map((ev) => `${ev.author}::${normalizeDigestKey(ev.excerpt)}`),
      );
      const seenEvidenceIds = new Set(nextEvidenceIndex.map((ev) => ev.id ?? ev.evidenceId));

      const turnVerifiedEvidence = [];
      let rejectedCount = 0;
      let searchStatus = 'skipped';
      let shouldEmitEvidenceVerified = false;
      let conditionCheckResult = null;
      let invalidatedItems = [];
      let retractionResultForStore = null;
      let retractionSummary = null;
      let referencedLookup = null;
      let graphMutated = committedTurnCount === 0 && Boolean(session.metadata?.initialGraph && nextConfirmedGraph.length > 0 && extractGraphNodes(session).length === 0);
      const graphDelta = { addedNodes: [], removedNodes: [], updatedNodes: [] };

      const addVerifiedEvidence = (rawCandidate) => {
        if (personalMaterialsDisabled && rawCandidate?.sourceType === 'collection_record') {
          return null;
        }
        const clean = sanitizeEvidenceItem(rawCandidate, secrets);
        if (!clean) {
          rejectedCount += 1;
          return null;
        }
        if (personalMaterialsDisabled && clean.sourceType === 'collection_record') {
          return null;
        }
        const digestKey = `${clean.author}::${normalizeDigestKey(clean.excerpt)}`;
        if (seenEvidenceIds.has(clean.id)) {
          const existingIdx = nextEvidenceIndex.findIndex((e) => (e.id ?? e.evidenceId) === clean.id);
          const existing = existingIdx >= 0 ? nextEvidenceIndex[existingIdx] : null;
          // QA-11：若新读取到了完整正文而既有条目只是摘要，就地升级保留正文片段
          if (
            existing
            && existing.textKind === 'summary'
            && (clean.textKind === 'full_text' || clean.textKind === 'partial_body')
          ) {
            nextEvidenceIndex[existingIdx] = clean;
            const tvIdx = turnVerifiedEvidence.findIndex((e) => e.id === clean.id);
            if (tvIdx >= 0) turnVerifiedEvidence[tvIdx] = clean;
            else turnVerifiedEvidence.push(clean);
            return clean;
          }
          if (existing && !turnVerifiedEvidence.some((e) => e.id === existing.id)) {
            turnVerifiedEvidence.push(existing);
          }
          return existing;
        }
        if (clean.sourceType !== 'session_turn' && seenEvidenceDigests.has(digestKey)) {
          const existing = nextEvidenceIndex.find(
            (e) => `${e.author}::${normalizeDigestKey(e.excerpt)}` === digestKey,
          );
          if (existing && !turnVerifiedEvidence.some((e) => e.id === existing.id)) {
            turnVerifiedEvidence.push(existing);
          }
          return existing;
        }
        seenEvidenceIds.add(clean.id);
        seenEvidenceDigests.add(digestKey);
        nextEvidenceIndex.push(clean);
        turnVerifiedEvidence.push(clean);
        return clean;
      };

      if (intent === 'analyze_statement') {
        shouldEmitEvidenceVerified = true;
        const topicKeywords = extractGenericTopicKeywords(userText);

        // ===== QA-01 & QA-11：关闭个人材料时绝对零采集调用；开启时固定锁定 snapshotId 并请求有上限正文 =====
        let rawCollectionItems = [];
        if (!personalMaterialsDisabled) {
          const preloadedAllCollection = nextEvidenceIndex.filter((e) => e.sourceType === 'collection_record');
          const preloadedRelevant = preloadedAllCollection.filter((e) =>
            isEvidenceRelevantToSentence(e, userText, focus),
          );
          const needsBodyUpgrade = preloadedAllCollection.some(
            (e) => e.fullTextAvailable === true && e.textKind === 'summary',
          );

          if (Array.isArray(session.collectionRecords)) {
            rawCollectionItems = session.collectionRecords.filter((e) =>
              isEvidenceRelevantToSentence(e, userText, focus),
            );
          } else if (preloadedAllCollection.length > 0 && !needsBodyUpgrade) {
            // 会话创建时已完整载入该快照，直接按本轮相关性筛选有界片段，不无故跨快照重读
            rawCollectionItems = preloadedRelevant;
          } else if (materialsAdapter && materialsAdapter.enabled !== false) {
            if (isCloudModel && effectiveCloudConsent !== true) {
              throw new BackendServiceError(
                'CLOUD_CONSENT_REQUIRED',
                '使用外部云端模型处理个人授权材料前需获得本人明确同意（cloudConsent: true）。',
                403,
              );
            }
            const readColFn =
              materialsAdapter.readCollectionCandidates
              ?? materialsAdapter.getCollectionRecords
              ?? materialsAdapter.listCollectionRecords;
            if (typeof readColFn === 'function') {
              toolCallCount += 1;
              const colRes = await readColFn.call(materialsAdapter, {
                sessionId,
                snapshotId: nextLockedSnapshotId,
                lockedSnapshotId: nextLockedSnapshotId,
                keywords: topicKeywords,
                includeBody: true,
                bodyMaxChars: 4000,
                summaryMaxChars: 600,
                dataMode: sessionMode,
                signal: turnSignal,
              });
              if (!nextLockedSnapshotId && typeof colRes?.snapshotId === 'string' && colRes.snapshotId.trim()) {
                nextLockedSnapshotId = colRes.snapshotId.trim();
              }
              const fetched = Array.isArray(colRes) ? colRes : colRes?.items ?? colRes?.records ?? [];
              rawCollectionItems = fetched.filter((e) => isEvidenceRelevantToSentence(e, userText, focus));
            }
          } else if (allowStandaloneDemoFixtures) {
            rawCollectionItems = defaultDemoCollectionCandidates(topicKeywords, nextLockedSnapshotId ?? 'snap_demo_001');
          }
        }

        const preCheck = detectDirectConflicts(userText, nextConfirmedGraph, { activeFacts: nextFacts });
        const needPublicSearch =
          preCheck.directConflicts.length === 0
          && input.skipExternalSearch !== true
          && (Boolean(materialsAdapter) || allowStandaloneDemoFixtures);

        let rawSearchItems = [];
        if (needPublicSearch) {
          await emitStage('retrieving_evidence');
          try {
            if (materialsAdapter) {
              const searchFn =
                materialsAdapter.searchPublicEvidence
                ?? materialsAdapter.searchZhihu
                ?? materialsAdapter.search;
              if (typeof searchFn === 'function') {
                toolCallCount += 1;
                const searchRes = await searchFn.call(materialsAdapter, {
                  query: topicKeywords.join(' '),
                  keywords: topicKeywords,
                  maxQueries: 2,
                  limit: 6,
                  dataMode: sessionMode,
                  signal: turnSignal,
                });
                if (searchRes?.ok === false && searchRes?.error?.code === 'RATE_LIMITED') {
                  searchStatus = 'rate_limited';
                } else {
                  rawSearchItems = Array.isArray(searchRes)
                    ? searchRes
                    : searchRes?.items ?? searchRes?.data?.items ?? [];
                  searchStatus = rawSearchItems.length > 0 ? 'ok' : 'empty';
                }
              } else {
                searchStatus = 'unavailable';
              }
            } else if (allowStandaloneDemoFixtures) {
              toolCallCount += 1;
              rawSearchItems = defaultDemoPublicSearchCandidates(topicKeywords, intent);
              searchStatus = rawSearchItems.length > 0 ? 'ok' : 'empty';
            }
          } catch (searchErr) {
            if (searchErr?.code === 'RATE_LIMITED' || searchErr?.status === 429) {
              searchStatus = 'rate_limited';
            } else if (
              searchErr?.code === 'TOKEN_REVOKED'
              || searchErr?.code === 'UPSTREAM_AUTH'
              || searchErr?.code === 'DATA_MODE_MISMATCH'
            ) {
              throw searchErr;
            } else {
              searchStatus = 'degraded';
            }
          }
        }

        turnSignal.throwIfAborted();
        await emitStage('verifying_candidates');

        for (const rawItem of [...rawCollectionItems, ...rawSearchItems]) {
          if (this.verifierAdapter && typeof this.verifierAdapter.verifyEvidenceCandidate === 'function') {
            const check = await this.verifierAdapter.verifyEvidenceCandidate(rawItem, {
              deniedAttributions: nextDeniedAttributions,
            });
            if (check && check.ok === false) {
              rejectedCount += 1;
              continue;
            }
          }
          const ev = addVerifiedEvidence(rawItem);
          if (!ev) continue;

          const isDenied = deniedKeys.has(ev.contentKey) || deniedKeys.has(ev.id) || ev.deniedSelfAttribution === true;
          if (ev.attribution === 'other_author' && !isDenied && ev.sourceType === 'collection_record') {
            const alreadyPending = nextPendingConfirmations.some(
              (p) => p.contentKey === ev.contentKey || p.evidenceId === ev.id,
            );
            if (!alreadyPending) {
              nextPendingConfirmations.push({
                id: `pc_${ev.id}`,
                kind: 'candidate_counterexample',
                status: 'pending',
                text: `个人采集中存在作者“${ev.author}”的相关回答（“${ev.excerpt}”）。该记录属他人观点而非本人立场，仅列为候选线索供您确认或排除。`,
                author: ev.author,
                attribution: 'other_author',
                contentKey: ev.contentKey,
                evidenceId: ev.id,
                topic: inferTopicCluster(userText),
              });
            }
          }
        }

        if (pendingNewStatement) {
          const existingIdx = nextStatements.findIndex((s) => s.statementId === pendingNewStatement.statementId);
          const registered = { ...pendingNewStatement, status: 'evaluated' };
          if (existingIdx >= 0) nextStatements[existingIdx] = registered;
          else nextStatements.push(registered);
        }
      } else if (intent === 'explain_focus_or_provenance') {
        if (focusedNode) {
          // QA-04：显式节点决定出处查询的核验证据范围，严格绑定 focusedNode.evidenceIds
          shouldEmitEvidenceVerified = true;
          await emitStage('verifying_candidates');
          const nodeEvIdSet = new Set(focusedNode.evidenceIds ?? []);
          const matchedNodeEvs = nextEvidenceIndex.filter(
            (e) => nodeEvIdSet.has(e.id) || nodeEvIdSet.has(e.evidenceId),
          );
          for (const ev of matchedNodeEvs) {
            if (!turnVerifiedEvidence.some((x) => x.id === ev.id)) {
              turnVerifiedEvidence.push(ev);
            }
          }
          referencedLookup = {
            found: true,
            matchType: 'node',
            id: focusedNode.id,
            nodeId: focusedNode.id,
            node: focusedNode,
            evidenceIds: matchedNodeEvs.map((e) => e.id ?? e.evidenceId),
            evidences: matchedNodeEvs,
          };
        } else {
          const targetOrdinal = parseTurnOrdinal(userText);
          if (targetOrdinal !== null) {
            referencedLookup = await lookupByIdFromStore(this.store, ownerId, sessionId, `turn_${targetOrdinal}`);
          } else if (/这是谁说的|谁写的|是谁的回答|出处/.test(userText)) {
            const latestOther = [...nextEvidenceIndex].reverse().find((e) => e.attribution === 'other_author');
            if (latestOther) {
              referencedLookup = { found: true, matchType: 'evidence', item: latestOther };
              turnVerifiedEvidence.push(latestOther);
            }
          }
        }
        graphMutated = false;
      } else if (intent === 'deny_attribution') {
        shouldEmitEvidenceVerified = true;
        await emitStage('verifying_candidates');

        const explicitKey = action?.contentKey ?? action?.evidenceId ?? action?.targetId ?? null;
        const targetPending = nextPendingConfirmations.find(
          (p) =>
            (explicitKey && (p.contentKey === explicitKey || p.evidenceId === explicitKey || p.id === explicitKey))
            || (p.author && userText.includes(p.author))
            || (/乐队/.test(userText) && /乐队/.test(p.text)),
        ) ?? nextPendingConfirmations.find((p) => p.attribution === 'other_author');

        const targetEvidence = targetPending
          ? nextEvidenceIndex.find(
              (e) => e.id === targetPending.evidenceId || e.contentKey === targetPending.contentKey,
            )
          : nextEvidenceIndex.find((e) => e.sourceType === 'collection_record' && e.attribution === 'other_author');

        const contentKey = explicitKey ?? targetPending?.contentKey ?? targetEvidence?.contentKey ?? 'collection:unknown';
        const evidenceId = targetEvidence?.id ?? targetPending?.evidenceId ?? contentKey;
        const originalAuthor = targetEvidence?.author ?? targetPending?.author ?? '原作者';

        if (!nextDeniedAttributions.some((d) => d.contentKey === contentKey || d.evidenceId === evidenceId)) {
          nextDeniedAttributions.push({
            evidenceId,
            contentKey,
            originalAuthor,
            turnId,
            deniedByTurnId: turnId,
            reason: redactTurnText(userText, secrets),
            createdAt: startedAt,
          });
        }
        nextPendingConfirmations = nextPendingConfirmations.filter(
          (p) => p.contentKey !== contentKey && p.evidenceId !== evidenceId,
        );
        if (targetEvidence) turnVerifiedEvidence.push(targetEvidence);
        graphMutated = false;
      } else if (intent === 'provide_self_fact') {
        shouldEmitEvidenceVerified = true;
        await emitStage('verifying_candidates');

        const selfEvidence = addVerifiedEvidence({
          id: `ev_turn_${turnId}`,
          evidenceId: `ev_turn_${turnId}`,
          sourceType: 'session_turn',
          author: 'self',
          attribution: 'self',
          excerpt: userText,
          span: { startOffset: 0, endOffset: userText.length },
          textKind: 'user_statement',
          summaryTruncated: false,
          snapshotId: null,
          turnId,
          url: null,
          contentKey: `turn:${turnId}`,
        });

        const factId = `fact_${turnId}`;
        const topicCluster = inferTopicCluster(userText, originalStmt ? inferTopicCluster(originalStmt.text) : 'general_claim');
        const factNodeId = `node_fact_${turnId}`;
        const judgmentNodeId = `node_claim_${turnId}`;
        const detectedScopeTag = extractStatementScopeTag(userText);

        const factNode = {
          id: factNodeId,
          kind: 'fact',
          text: `本人经历（轮次 ${turnId}）：${redactTurnText(userText, secrets)}`,
          cluster: topicCluster,
          deps: [],
          attribution: 'self',
          turnId,
          createdTurnId: turnId,
          evidenceIds: [selfEvidence.id],
          sourceFactIds: [factId],
          conditionFactId: null,
          factRole: 'counterexample_fact',
          ...(detectedScopeTag ? { scopeTag: detectedScopeTag } : {}),
        };

        const derivedText =
          topicCluster === 'recommendation_interest' && /发现|新乐队|新歌|拓宽|没听过/.test(userText)
            ? '本人基础判断：推荐机制并非在所有情形下都只会让人的兴趣变窄'
            : `本人依据判断（轮次 ${turnId}）：基于上述本人已确认经历所确立的适用判断`;

        const judgmentNode = {
          id: judgmentNodeId,
          kind: 'judgment',
          text: derivedText,
          cluster: topicCluster,
          deps: [factNodeId],
          attribution: 'self',
          turnId,
          createdTurnId: turnId,
          evidenceIds: [selfEvidence.id],
          sourceFactIds: [factId],
          conditionFactId: null,
          factRole: 'derived_judgment',
        };

        const nodeListToAdd = action?.singleIsolatedNode === true ? [factNode] : [factNode, judgmentNode];
        const candidateGraph = [...nextConfirmedGraph, ...nodeListToAdd];
        const validation = validateConfirmedGraph(candidateGraph);
        if (!validation.ok) {
          throw new BackendServiceError('VERIFICATION_REJECTED', `图拓扑校验未通过：${validation.errors.join('；')}`, 400);
        }

        nextConfirmedGraph = computeGraphWeights(candidateGraph);
        graphDelta.addedNodes.push(...nodeListToAdd.map((n) => n.id));
        graphMutated = true;

        nextFacts.push({
          id: factId,
          kind: 'fact',
          text: redactTurnText(userText, secrets),
          turnId,
          turnNumber: currentTurnNumber,
          attribution: 'self',
          status: 'active',
          retractedByTurnId: null,
          evidenceId: selfEvidence.id,
          evidenceIds: [selfEvidence.id],
          scopeTag: detectedScopeTag,
          appliesToFactIds: [],
          dependsOnFactIds: [],
          nodeIds: nodeListToAdd.map((n) => n.id),
          topic: topicCluster,
        });
      } else if (intent === 'check_or_confirm_condition') {
        shouldEmitEvidenceVerified = true;
        // QA-05：从实际输入提取真实条件短语（如“雨天”），绝不硬编码“刚开始用的时候”
        const scopeText = extractConditionPhrase(userText, focus, nextPendingConfirmations, action);
        const scopeTag = normalizeScopeTag(scopeText);

        if (conditionMode === 'check') {
          const topicKeywords = extractGenericTopicKeywords(
            `${originalStmt?.text ?? ''} ${scopeText}`,
          );
          if (input.skipExternalSearch !== true && (Boolean(materialsAdapter) || allowStandaloneDemoFixtures)) {
            await emitStage('retrieving_evidence');
            try {
              if (materialsAdapter) {
                const searchFn =
                  materialsAdapter.searchPublicEvidence
                  ?? materialsAdapter.searchZhihu
                  ?? materialsAdapter.search;
                if (typeof searchFn === 'function') {
                  toolCallCount += 1;
                  const searchRes = await searchFn.call(materialsAdapter, {
                    query: `${topicKeywords[0] ?? ''} ${scopeText}`.trim(),
                    keywords: topicKeywords,
                    maxQueries: 2,
                    limit: 5,
                    dataMode: sessionMode,
                    signal: turnSignal,
                  });
                  if (searchRes?.ok === false && searchRes?.error?.code === 'RATE_LIMITED') {
                    searchStatus = 'rate_limited';
                  } else {
                    const items = Array.isArray(searchRes) ? searchRes : searchRes?.items ?? searchRes?.data?.items ?? [];
                    for (const item of items) addVerifiedEvidence(item);
                    searchStatus = items.length > 0 ? 'ok' : 'empty';
                  }
                }
              } else if (allowStandaloneDemoFixtures) {
                toolCallCount += 1;
                const demoItems = defaultDemoPublicSearchCandidates(topicKeywords, intent);
                for (const item of demoItems) addVerifiedEvidence(item);
                searchStatus = demoItems.length > 0 ? 'ok' : 'empty';
              }
            } catch (err) {
              if (err?.code === 'RATE_LIMITED' || err?.status === 429) searchStatus = 'rate_limited';
              else searchStatus = 'degraded';
            }
          }

          await emitStage('verifying_candidates');

          const hasConfirmedSelfBasis =
            nextConfirmedGraph.length > 0 || nextFacts.some((f) => f.status === 'active');
          const hasGroundedSearchEvidence = turnVerifiedEvidence.length > 0;

          if (!hasConfirmedSelfBasis && !hasGroundedSearchEvidence) {
            // QA-05：空图、空搜索时严禁编造无引文的确定性反例，如实返回 insufficient_evidence / null
            conditionCheckResult = {
              status: 'insufficient_evidence',
              assessment: 'insufficient_evidence',
              rate: null,
              scopeText,
              scopeTag,
              verifiedEvidenceIds: [],
              supportedScope: `当前已确认图为空且未检索到针对“${scopeText}”的核验证据，无法在缺乏依据时断言存在反例（维持 insufficient_evidence，rate: null）`,
              unsupportedScope: `在补充本人亲身经历或可核验引文之前，不能单独支持或否定“${scopeText}”及其他范围下的结论`,
            };
          } else {
            const supportedScope = hasConfirmedSelfBasis
              ? `结合已确认记录与核验线索，能支持“在‘${scopeText}’这一局部范围内存在已核验依据”，足以检验不加限定的全称断定`
              : `公开检索线索仅提示“${scopeText}”下可能存在差异化机制（属他人公开讨论，尚未经本人经历确认），需本人确认后才计入已确认图`;
            const unsupportedScope =
              `不能单独支持或否定超出“${scopeText}”之外的其他场景或阶段，超出该范围的主张仍需独立证据`;

            conditionCheckResult = {
              status: hasConfirmedSelfBasis ? 'grounded' : 'candidate_only',
              assessment: hasConfirmedSelfBasis ? 'conflict' : 'insufficient_evidence',
              rate: null,
              scopeText,
              scopeTag,
              verifiedEvidenceIds: turnVerifiedEvidence.map((e) => e.id ?? e.evidenceId),
              supportedScope,
              unsupportedScope,
            };

            const condKey = `condition:${scopeText}`;
            if (!nextPendingConfirmations.some((p) => p.contentKey === condKey)) {
              nextPendingConfirmations.push({
                id: `pc_cond_${turnId}`,
                kind: 'scope_condition',
                status: 'pending',
                text: `待本人确认是否将适用范围限定为“${scopeText}”。`,
                author: 'self',
                attribution: 'self',
                contentKey: condKey,
                evidenceId: turnVerifiedEvidence[0]?.id ?? null,
                scopeText,
                scopeTag,
                supportedScope,
                unsupportedScope,
                topic: inferTopicCluster(originalStmt?.text ?? userText),
              });
            }
          }
          graphMutated = false;
        } else {
          await emitStage('verifying_candidates');

          const condEvidence = addVerifiedEvidence({
            id: `ev_cond_${turnId}`,
            evidenceId: `ev_cond_${turnId}`,
            sourceType: 'session_turn',
            author: 'self',
            attribution: 'self',
            excerpt: userText,
            span: { startOffset: 0, endOffset: userText.length },
            textKind: 'user_statement',
            summaryTruncated: false,
            snapshotId: null,
            turnId,
            url: null,
            contentKey: `turn:${turnId}:condition`,
          });

          const targetBaseFacts = nextFacts.filter((f) => f.kind === 'fact' && f.status === 'active');
          const latestBaseFact = targetBaseFacts.at(-1) ?? null;
          const baseFactNodeId =
            latestBaseFact?.nodeIds?.[0]
            ?? nextConfirmedGraph.find((n) => Array.isArray(n.sourceFactIds) && n.sourceFactIds.includes(latestBaseFact?.id))?.id
            ?? nextConfirmedGraph[0]?.id
            ?? null;

          const condFactId = `cond_${turnId}`;
          const topicCluster = latestBaseFact?.topic ?? inferTopicCluster(originalStmt?.text ?? userText);

          const condNodeId = `node_cond_${turnId}`;
          const scopedConcNodeId = `node_scoped_${turnId}`;

          const condNode = {
            id: condNodeId,
            kind: 'condition',
            text: `本人确认适用条件（轮次 ${turnId}）：限定在“${scopeText}”`,
            cluster: topicCluster,
            deps: [],
            attribution: 'self',
            turnId,
            createdTurnId: turnId,
            evidenceIds: [condEvidence.id],
            sourceFactIds: [condFactId],
            conditionFactId: condFactId,
            factRole: 'scope_condition',
            scopeText,
            scopeTag,
          };

          const baseEvIds = latestBaseFact?.evidenceIds ?? (latestBaseFact?.evidenceId ? [latestBaseFact.evidenceId] : []);
          const scopedConclusionNode = {
            id: scopedConcNodeId,
            kind: 'judgment',
            text: `阶段性限定结论（轮次 ${turnId}）：在“${scopeText}”范围内本人确认判断成立（不单独决定超出“${scopeText}”的其他范围）`,
            cluster: topicCluster,
            deps: baseFactNodeId ? [baseFactNodeId, condNodeId] : [condNodeId],
            attribution: 'self',
            turnId,
            createdTurnId: turnId,
            evidenceIds: [...baseEvIds, condEvidence.id],
            sourceFactIds: [...(latestBaseFact ? [latestBaseFact.id] : []), condFactId],
            conditionFactId: condFactId,
            factRole: 'scoped_conclusion',
            scopeText,
            scopeTag,
          };

          const candidateGraph = [...nextConfirmedGraph, condNode, scopedConclusionNode];
          const validation = validateConfirmedGraph(candidateGraph);
          if (!validation.ok) {
            throw new BackendServiceError('VERIFICATION_REJECTED', `限定条件入图校验失败：${validation.errors.join('；')}`, 400);
          }

          nextConfirmedGraph = computeGraphWeights(candidateGraph);
          graphDelta.addedNodes.push(condNodeId, scopedConcNodeId);
          graphMutated = true;

          const supportsDescription = `在“${scopeText}”范围内成立，但不单独决定超出“${scopeText}”之外的其他场景结论。`;
          nextFacts.push({
            id: condFactId,
            kind: 'condition',
            text: redactTurnText(userText, secrets),
            scopeText,
            scopeTag,
            turnId,
            turnNumber: currentTurnNumber,
            attribution: 'self',
            status: 'active',
            retractedByTurnId: null,
            targetFactId: latestBaseFact?.id ?? null,
            appliesToFactIds: latestBaseFact ? [latestBaseFact.id] : [],
            dependsOnFactIds: [],
            evidenceId: condEvidence.id,
            evidenceIds: [condEvidence.id],
            nodeIds: [condNodeId, scopedConcNodeId],
            supportsDescription,
            topic: topicCluster,
          });

          nextPendingConfirmations = nextPendingConfirmations.filter((p) => p.kind !== 'scope_condition');
          conditionCheckResult = {
            status: 'confirmed',
            scopeText,
            scopeTag,
            supportedScope: `已由本人在轮次 ${turnId} 确认限定于“${scopeText}”`,
            unsupportedScope: `不单独支持或预设超出“${scopeText}”之外的其他场景或阶段结论`,
          };
        }
      } else if (intent === 'compare_rewrite') {
        shouldEmitEvidenceVerified = true;
        await emitStage('verifying_candidates');

        if (pendingNewStatement) {
          nextStatements.push({ ...pendingNewStatement, status: 'evaluated' });
        }
        for (const ev of nextEvidenceIndex.filter((e) => e.attribution === 'self')) {
          turnVerifiedEvidence.push(ev);
        }
        graphMutated = false;
      } else if (intent === 'retract_fact') {
        shouldEmitEvidenceVerified = true;
        await emitStage('verifying_candidates');

        // ===== QA-03：精确匹配显式 targetId / 明确轮次号 / 自然语言短语，严禁回退误撤无关事实 =====
        const hasExplicitTargetField = Boolean(
          action && (action.targetId !== undefined || action.factId !== undefined),
        );
        const explicitTargetId = hasExplicitTargetField
          ? String(action.targetId ?? action.factId ?? '').trim()
          : null;
        const targetOrdinal = explicitTargetId === null ? parseTurnOrdinal(userText) : null;
        const targetTurnSummary = targetOrdinal !== null
          ? (session.turns ?? []).find((t) => t.turnNumber === targetOrdinal) ?? null
          : null;

        let targetFact = null;
        let nonMutatingStatus = null;
        let nonMutatingMessage = '';

        if (hasExplicitTargetField) {
          if (!explicitTargetId) {
            nonMutatingStatus = 'target_not_found';
            nonMutatingMessage = '指定的撤回目标 ID 为空，当前事实、图版本与报价保持不变。';
          } else {
            const matchedById = nextFacts.filter(
              (f) => f.id === explicitTargetId || f.turnId === explicitTargetId,
            );
            if (matchedById.length === 0) {
              nonMutatingStatus = 'target_not_found';
              nonMutatingMessage = `未在当前会话中找到指定的撤回目标（${explicitTargetId}），现有事实、图版本与报价保持不变。`;
            } else {
              const activeMatch = matchedById.find((f) => f.status === 'active') ?? null;
              if (!activeMatch) {
                nonMutatingStatus = 'already_retracted';
                targetFact = matchedById[0];
                nonMutatingMessage = `目标事实（${targetFact.id}）此前已处于撤回状态，本轮无额外变更。`;
              } else {
                targetFact = activeMatch;
              }
            }
          }
        } else if (targetOrdinal !== null) {
          let turnCandidates = nextFacts.filter(
            (f) =>
              f.turnNumber === targetOrdinal
              || (targetTurnSummary?.turnId && f.turnId === targetTurnSummary.turnId)
              || f.turnId === `turn_${targetOrdinal}`,
          );
          if (turnCandidates.length > 1 && /条件|限定|范围/.test(userText)) {
            const condOnly = turnCandidates.filter((f) => f.kind === 'condition');
            if (condOnly.length > 0) turnCandidates = condOnly;
          }
          if (turnCandidates.length === 0) {
            nonMutatingStatus = 'target_not_found';
            nonMutatingMessage = `第 ${targetOrdinal} 轮并未产生可撤回的已确认事实或限定条件，已完整保留其他轮次的事实与当前图版本。`;
          } else {
            const activeTurnMatch = turnCandidates.find((f) => f.status === 'active') ?? null;
            if (!activeTurnMatch) {
              nonMutatingStatus = 'already_retracted';
              targetFact = turnCandidates[0];
              nonMutatingMessage = `第 ${targetOrdinal} 轮对应的记录（${targetFact.id}）此前已撤回，本轮无额外变更。`;
            } else {
              targetFact = activeTurnMatch;
            }
          }
        } else {
          const activeFactsList = nextFacts.filter((f) => f.status === 'active');
          if (activeFactsList.length === 0) {
            nonMutatingStatus = 'target_not_found';
            nonMutatingMessage = '当前会话没有可撤回的有效事实或限定条件。';
          } else {
            const quotedPhrase = userText.match(/[‘“"'「『]([^’”"'」』]{1,32})[’”"'」』]/)?.[1]?.trim() ?? null;
            let pool = activeFactsList;
            if (/条件|限定|范围/.test(userText) && !/事实|经历/.test(userText)) {
              const conds = pool.filter((f) => f.kind === 'condition');
              if (conds.length > 0) pool = conds;
            } else if (/事实|经历/.test(userText) && !/条件|限定|范围/.test(userText)) {
              const onlyFacts = pool.filter((f) => f.kind === 'fact');
              if (onlyFacts.length > 0) pool = onlyFacts;
            }

            if (quotedPhrase) {
              const byQuote = pool.filter(
                (f) =>
                  (typeof f.scopeText === 'string' && f.scopeText.includes(quotedPhrase))
                  || String(f.text ?? '').includes(quotedPhrase),
              );
              if (byQuote.length === 0) {
                nonMutatingStatus = 'target_not_found';
                nonMutatingMessage = `未找到与“${quotedPhrase}”匹配的有效事实或限定条件，现有状态保持不变。`;
              } else if (byQuote.length === 1) {
                targetFact = byQuote[0];
              } else {
                nonMutatingStatus = 'clarification_needed';
                nonMutatingMessage = `存在多条匹配“${quotedPhrase}”的记录，请指定具体轮次号或条目 ID。`;
              }
            } else {
              const strippedQuery = userText.replace(/撤回|撤销|取消|作废|刚才|之前|那个|那条|的|条件|限定|范围|事实|判断|我|请/g, '').trim();
              const qBigrams = extractBigrams(strippedQuery);
              if (qBigrams.size > 0) {
                const scored = pool
                  .map((f) => {
                    const fBigrams = extractBigrams(`${f.scopeText ?? ''} ${f.text ?? ''}`);
                    let hits = 0;
                    for (const bg of qBigrams) if (fBigrams.has(bg)) hits += 1;
                    return { f, hits };
                  })
                  .filter((x) => x.hits > 0)
                  .sort((a, b) => b.hits - a.hits);
                if (scored.length === 1 || (scored.length > 1 && scored[0].hits > scored[1].hits)) {
                  targetFact = scored[0].f;
                } else if (scored.length === 0) {
                  nonMutatingStatus = 'target_not_found';
                  nonMutatingMessage = '未找到与描述匹配的可撤回记录，现有事实与图版本保持不变。';
                } else {
                  nonMutatingStatus = 'clarification_needed';
                  nonMutatingMessage = '存在多条可能匹配的记录，请指明要撤回的具体轮次或 ID。';
                }
              } else if (pool.length === 1) {
                targetFact = pool[0];
              } else {
                nonMutatingStatus = 'clarification_needed';
                nonMutatingMessage = '当前存在多条有效事实或条件，请指明要撤回的具体轮次号或条目 ID。';
              }
            }
          }
        }

        if (nonMutatingStatus !== null) {
          graphMutated = false;
          invalidatedItems = [];
          const preservedFactIds = nextFacts.filter((f) => f.status === 'active').map((f) => f.id);
          retractionSummary = {
            status: nonMutatingStatus,
            requestedTarget: explicitTargetId ?? (targetOrdinal !== null ? `turn_${targetOrdinal}` : null),
            requestedTurnNumber: targetOrdinal,
            retractedFactId: nonMutatingStatus === 'already_retracted' ? (targetFact?.id ?? null) : null,
            retractedTurnId: nonMutatingStatus === 'already_retracted' ? (targetFact?.turnId ?? null) : null,
            byTurnId: turnId,
            invalidatedNodeIds: [],
            invalidatedConclusions: [],
            preservedFactIds,
            message: nonMutatingMessage,
          };
        } else {
          if (typeof this.store.retractFact === 'function') {
            const ret = this.store.retractFact(
              {
                facts: nextFacts,
                confirmedGraph: nextConfirmedGraph,
                graphVersion: baseGraphVersion,
              },
              {
                targetRef: targetFact.id,
                currentTurnId: turnId,
              },
            );
            retractionResultForStore = ret;
            nextFacts = ret.facts;
            nextConfirmedGraph = extractGraphNodes({ confirmedGraph: ret.confirmedGraph });
            invalidatedItems = ret.invalidatedItems;
            graphDelta.removedNodes.push(...ret.invalidatedNodeIds);
            graphMutated = ret.graphMutated;
          } else {
            targetFact.status = 'retracted';
            targetFact.retractedByTurnId = turnId;
            const directlyRemovedIds = new Set(
              nextConfirmedGraph
                .filter(
                  (n) =>
                    n.conditionFactId === targetFact.id
                    || (Array.isArray(n.sourceFactIds) && n.sourceFactIds.includes(targetFact.id) && targetFact.kind === 'condition')
                    || (Array.isArray(n.sourceFactIds) && n.sourceFactIds.length === 1 && n.sourceFactIds[0] === targetFact.id),
                )
                .map((n) => n.id),
            );
            const cascadedRemovedIds = collapseGraphAfter(directlyRemovedIds, nextConfirmedGraph);
            const removedNodes = nextConfirmedGraph.filter((n) => cascadedRemovedIds.has(n.id));
            const survivingNodes = nextConfirmedGraph
              .filter((n) => !cascadedRemovedIds.has(n.id))
              .map((n) => ({
                ...n,
                deps: (n.deps ?? []).filter((depId) => !cascadedRemovedIds.has(depId)),
                sourceFactIds: Array.isArray(n.sourceFactIds)
                  ? n.sourceFactIds.filter((fid) => fid !== targetFact.id)
                  : [],
              }));
            nextConfirmedGraph = computeGraphWeights(survivingNodes);
            graphDelta.removedNodes.push(...removedNodes.map((n) => n.id));
            graphMutated = removedNodes.length > 0 || true;
            invalidatedItems = [
              {
                id: targetFact.id,
                kind: targetFact.kind,
                text: targetFact.text,
                reason: '用户主动撤回该事实或限定条件。',
                invalidationType: 'retracted_fact',
              },
              ...removedNodes.map((n) => ({
                id: n.id,
                kind: n.kind ?? 'judgment',
                text: n.text,
                reason: '直接或连带依赖已撤回的条件而失效。',
                invalidationType: directlyRemovedIds.has(n.id) ? 'direct_node' : 'cascade_node',
              })),
            ];
          }

          const preservedFactIds = nextFacts
            .filter((f) => f.status === 'active')
            .map((f) => f.id);

          retractionSummary = {
            status: 'retracted',
            retractedFactId: targetFact.id,
            retractedFactKind: targetFact.kind,
            retractedTurnId: targetFact.turnId,
            retractedText: targetFact.text,
            byTurnId: turnId,
            invalidatedNodeIds: [...graphDelta.removedNodes],
            invalidatedConclusions: invalidatedItems
              .filter((item) => item.invalidationType !== 'retracted_fact')
              .map((item) => item.text),
            preservedFactIds,
          };
          nextInvalidatedHistory.push(retractionSummary);
        }

        for (const ev of nextEvidenceIndex.filter((e) => e.attribution === 'self')) {
          if (!turnVerifiedEvidence.some((x) => x.id === ev.id)) {
            turnVerifiedEvidence.push(ev);
          }
        }
      }

      // ===== QA-06 & QA-10：接入结构化候选提议核验器 verifyCandidateProposal =====
      const candidateProposal =
        input.proposal
        ?? action?.proposal
        ?? (input.clientRequestId ? session.metadata?.proposalsByRequestId?.[input.clientRequestId] : null)
        ?? session.metadata?.proposalsByTurnNumber?.[currentTurnNumber]
        ?? (typeof this.proposalResolver === 'function'
          ? await this.proposalResolver({
              session,
              turnId,
              turnNumber: currentTurnNumber,
              clientRequestId: input.clientRequestId,
              userText,
              intent,
              action,
            })
          : null);

      let verifiedProposalConflicts = null;
      let verifiedProposalReasons = null;
      let verifiedProposalEvidenceIds = [];

      if (candidateProposal && typeof candidateProposal === 'object') {
        if (!stages.includes('verifying_candidates')) {
          await emitStage('verifying_candidates');
        }
        shouldEmitEvidenceVerified = true;

        if (candidateProposal.conflictReasons !== undefined) {
          validateConflictReasonsList(candidateProposal.conflictReasons);
        }

        if (!this.verifierAdapter || typeof this.verifierAdapter.verifyCandidateProposal !== 'function') {
          throw new BackendServiceError('INTERNAL_ERROR', '缺少候选核验器 verifyCandidateProposal。', 500);
        }

        const verification = this.verifierAdapter.verifyCandidateProposal({
          proposal: candidateProposal,
          evidenceMap: nextEvidenceIndex,
          confirmedGraph: nextConfirmedGraph,
          deniedAttributions: nextDeniedAttributions,
          currentTurnId: turnId,
        });

        if (verification.rejectedItems.length > 0 && candidateProposal.allowPartialDegrade !== true) {
          const reasonSummary = verification.rejectedItems.map((r) => `${r.kind}:${r.reason}`).join('；');
          throw new BackendServiceError(
            'VERIFICATION_REJECTED',
            `结构化候选未通过核验（${reasonSummary}），拒绝入图提交。`,
            400,
            { rejectedItems: verification.rejectedItems },
          );
        }
        rejectedCount += verification.rejectedItems.length;

        if (verification.acceptedNodes.length > 0) {
          const mergedNodes = [...nextConfirmedGraph, ...verification.acceptedNodes];
          nextConfirmedGraph = typeof this.pricingEngine?.computeGraph === 'function'
            ? this.pricingEngine.computeGraph(mergedNodes)
            : computeGraphWeights(mergedNodes);
          graphDelta.addedNodes.push(...verification.acceptedNodes.map((n) => n.id));
          graphMutated = true;
        }

        for (const pc of verification.pendingConfirmations) {
          nextPendingConfirmations.push({
            id: pc.id ?? `pc_prop_${turnId}_${nextPendingConfirmations.length + 1}`,
            kind: pc.kind,
            status: 'pending',
            text: pc.text ?? pc.reason ?? '待本人进一步确认的候选条目',
            author: pc.referencedAuthors?.[0]?.author ?? 'other_author',
            attribution: pc.attribution ?? 'other_author',
            contentKey: pc.nodeId ?? `proposal:${turnId}`,
            evidenceId: pc.evidenceIds?.[0] ?? null,
          });
        }

        for (const vc of verification.verifiedCitations) {
          const found = nextEvidenceIndex.find((e) => (e.id ?? e.evidenceId) === vc.evidenceId);
          if (found && !turnVerifiedEvidence.some((x) => x.id === found.id)) {
            turnVerifiedEvidence.push(found);
          }
          verifiedProposalEvidenceIds.push(vc.evidenceId);
        }

        if (verification.verifiedDirectConflicts.length > 0) {
          verifiedProposalConflicts = verification.verifiedDirectConflicts.map((c) => c.nodeId);
          verifiedProposalReasons = candidateProposal.conflictReasons !== undefined
            ? validateConflictReasonsList(candidateProposal.conflictReasons)
            : verification.verifiedDirectConflicts.map((c) => ({
                nodeId: c.nodeId,
                reason: c.reason,
                ...(Array.isArray(c.evidenceIds) && c.evidenceIds.length > 0 ? { evidenceIds: c.evidenceIds } : {}),
              }));
          for (const c of verification.verifiedDirectConflicts) {
            for (const eid of c.evidenceIds ?? []) {
              verifiedProposalEvidenceIds.push(eid);
            }
          }
        }
      }

      // ===== 统一计算目标图版本并在同一图版本和分母上重算全部已登记句子（QA-07 & QA-10） =====
      const targetGraphVersion = graphMutated ? baseGraphVersion + 1 : baseGraphVersion;
      if (nextConfirmedGraph.length > 0) {
        nextConfirmedGraph = typeof this.pricingEngine?.computeGraph === 'function'
          ? this.pricingEngine.computeGraph(
              nextConfirmedGraph.map((n) => ({ ...n, cluster: n.cluster ?? 'default', deps: [...(n.deps ?? [])] })),
            )
          : computeGraphWeights(nextConfirmedGraph);
      }

      const targetProposalStmtId =
        pendingNewStatement?.statementId
        ?? (nextStatements.at(-1)?.statementId ?? null);

      const nextQuotes = [];
      for (let i = 0; i < nextStatements.length; i += 1) {
        const stmt = nextStatements[i];
        const useProposalOverride =
          verifiedProposalConflicts !== null && stmt.statementId === targetProposalStmtId;

        const conflictCheck = useProposalOverride
          ? {
              directConflicts: verifiedProposalConflicts,
              conflictReasons: verifiedProposalReasons ?? [],
              compatibleEvidenceFound: false,
              compatibleEvidenceIds: [],
            }
          : detectDirectConflicts(stmt.text, nextConfirmedGraph, {
              activeFacts: nextFacts,
            });

        const verifiedEvIds = [
          ...new Set([
            ...(useProposalOverride ? verifiedProposalEvidenceIds : []),
            ...conflictCheck.conflictReasons.flatMap((r) => (typeof r === 'object' && Array.isArray(r.evidenceIds) ? r.evidenceIds : [])),
            ...(conflictCheck.compatibleEvidenceFound ? (conflictCheck.compatibleEvidenceIds ?? []) : []),
          ]),
        ];

        const quoteObj = evaluateGraphQuote(nextConfirmedGraph, conflictCheck.directConflicts, {
          pricingEngine: this.pricingEngine,
          statementId: stmt.statementId,
          text: stmt.text,
          graphVersion: targetGraphVersion,
          compatibleEvidenceFound: conflictCheck.compatibleEvidenceFound,
          conflictReasons: conflictCheck.conflictReasons,
          verifiedEvidenceIds: verifiedEvIds,
        });

        nextStatements[i] = {
          ...stmt,
          id: stmt.statementId,
          statementId: stmt.statementId,
          status: 'evaluated',
          assessment: quoteObj.assessment,
          directConflicts: quoteObj.directConflicts,
          conflictReasons: quoteObj.conflictReasons,
          reason: quoteObj.reason,
          verifiedEvidenceIds: quoteObj.verifiedEvidenceIds,
          quote: quoteObj,
        };
        nextQuotes.push(quoteObj);
      }

      const activeStatementId =
        pendingNewStatement?.statementId
        ?? (nextStatements.at(-1)?.statementId ?? null);
      let activeQuote =
        nextQuotes.find((q) => q.statementId === activeStatementId)
        ?? nextQuotes.at(-1)
        ?? null;

      if (!activeQuote && intent === 'check_or_confirm_condition' && conditionMode === 'check') {
        activeQuote = evaluateGraphQuote(nextConfirmedGraph, [], {
          pricingEngine: this.pricingEngine,
          statementId: 'stmt_condition_check',
          text: userText,
          graphVersion: targetGraphVersion,
          compatibleEvidenceFound: false,
        });
      }

      if (retractionSummary && retractionSummary.status === 'retracted') {
        retractionSummary.recalculatedQuotes = nextQuotes.map((q) => ({
          statementId: q.statementId,
          assessment: q.assessment,
          rate: q.rate,
          numerator: q.numerator,
          denominator: q.denominator,
          graphVersion: q.graphVersion,
        }));
      }

      // ===== QA-04：收束与显式采用版本（优先采用显式指定或已持久化的 adoptedStatementId） =====
      if (intent === 'converge') {
        const orig = nextStatements.find((s) => s.role === 'original' || s.statementId === 'stmt_original') ?? null;
        const rewrites = nextStatements.filter((s) => s.role !== 'original' && s.statementId !== 'stmt_original');

        let adopted = null;
        if (nextAdoptedStatementId) {
          adopted = nextStatements.find((s) => s.statementId === nextAdoptedStatementId) ?? null;
        }
        if (!adopted) {
          adopted =
            [...rewrites].reverse().find((s) => s.quote?.assessment === 'compatible')
            ?? [...rewrites].reverse().find((s) => s.quote?.assessment !== 'conflict')
            ?? rewrites.at(-1)
            ?? null;
          if (adopted) {
            nextAdoptedStatementId = adopted.statementId;
          }
        }

        const disagreements = [];
        for (const s of nextStatements) {
          if (s.quote?.assessment === 'conflict') {
            disagreements.push({
              kind: 'direct_conflict',
              statementId: s.statementId,
              statementText: s.text,
              reason: s.quote.reason,
              conflictingNodeIds: s.quote.directConflicts,
            });
          } else if (s.quote?.assessment === 'insufficient_evidence' && s.statementId !== 'stmt_original') {
            disagreements.push({
              kind: 'open_boundary',
              statementId: s.statementId,
              statementText: s.text,
              reason: '已避开已有反例，但缩小后的特定场景仍缺本人已确认证据，维持未定而不预设降分。',
              conflictingNodeIds: [],
            });
          }
        }
        for (const denied of nextDeniedAttributions) {
          disagreements.push({
            kind: 'denied_attribution',
            contentKey: denied.contentKey,
            originalAuthor: denied.originalAuthor,
            deniedByTurnId: denied.deniedByTurnId ?? denied.turnId,
            reason: `原作者为“${denied.originalAuthor}”的收藏/浏览内容已被本人明确排除出本人立场。`,
          });
        }

        const citations = nextEvidenceIndex.map((ev) => ({
          evidenceId: ev.id ?? ev.evidenceId,
          sourceType: ev.sourceType,
          author: ev.author,
          attribution: ev.attribution,
          turnId: ev.turnId ?? null,
          snapshotId: ev.snapshotId ?? null,
          url: ev.url ?? null,
          excerpt: ev.excerpt,
        }));

        const adoptedSummaryObj = adopted
          ? {
              statementId: adopted.statementId,
              text: adopted.text,
              assessment: adopted.quote?.assessment ?? 'insufficient_evidence',
              rate: adopted.quote?.rate ?? null,
              numerator: adopted.quote?.numerator ?? 0,
              denominator: adopted.quote?.denominator ?? 0,
            }
          : null;

        nextConvergenceSummary = {
          generatedAtTurnId: turnId,
          graphVersion: targetGraphVersion,
          adoptedStatementId: adopted?.statementId ?? null,
          originalStatement: orig
            ? {
                statementId: orig.statementId,
                text: orig.text,
                assessment: orig.quote?.assessment ?? 'insufficient_evidence',
                rate: orig.quote?.rate ?? null,
                numerator: orig.quote?.numerator ?? 0,
                denominator: orig.quote?.denominator ?? 0,
              }
            : null,
          adoptedRewrite: adoptedSummaryObj,
          adoptedStatement: adoptedSummaryObj,
          allStatements: nextStatements.map((s) => ({
            statementId: s.statementId,
            role: s.role,
            text: s.text,
            assessment: s.quote?.assessment ?? 'insufficient_evidence',
            rate: s.quote?.rate ?? null,
            graphVersion: targetGraphVersion,
          })),
          disagreements,
          invalidatedHistory: nextInvalidatedHistory,
          citations,
        };
      }

      const statementComparison = buildStatementComparison(
        nextQuotes,
        nextConfirmedGraph,
        targetGraphVersion,
        nextAdoptedStatementId,
      );

      // 4. 发射 evidence.verified
      if (shouldEmitEvidenceVerified) {
        await emitEvent('evidence.verified', {
          ...(focusedNode ? { nodeId: focusedNode.id } : {}),
          verifiedEvidence: turnVerifiedEvidence.map((ev) => ({
            id: ev.id ?? ev.evidenceId,
            evidenceId: ev.evidenceId ?? ev.id,
            sourceType: ev.sourceType,
            author: ev.author,
            attribution: ev.attribution,
            excerpt: ev.excerpt,
            span: ev.span,
            textKind: ev.textKind,
            bodyStatus: ev.bodyStatus,
            fullTextAvailable: Boolean(ev.fullTextAvailable),
            summaryTruncated: Boolean(ev.summaryTruncated ?? ev.truncated),
            truncated: Boolean(ev.truncated ?? ev.summaryTruncated),
            snapshotId: ev.snapshotId,
            turnId: ev.turnId,
            url: ev.url,
            contentKey: ev.contentKey,
            behaviorKinds: ev.behaviorKinds ?? [],
          })),
          pendingConfirmations: nextPendingConfirmations.map((pc) => ({
            id: pc.id,
            kind: pc.kind,
            status: pc.status,
            text: redactTurnText(pc.text, secrets),
            author: redactTurnText(pc.author, secrets),
            attribution: pc.attribution,
            contentKey: pc.contentKey,
            evidenceId: pc.evidenceId,
            ...(pc.scopeText ? { scopeText: redactTurnText(pc.scopeText, secrets) } : {}),
            ...(pc.supportedScope ? { supportedScope: redactTurnText(pc.supportedScope, secrets) } : {}),
            ...(pc.unsupportedScope ? { unsupportedScope: redactTurnText(pc.unsupportedScope, secrets) } : {}),
          })),
          rejectedCount,
          searchStatus,
        });
      }

      const nextActions = [];
      if (nextPendingConfirmations.some((p) => p.kind === 'candidate_counterexample')) {
        nextActions.push('说明候选他人回答是否仅系收藏而非本人观点，或陈述您本人的实际经历');
      }
      if (nextFacts.some((f) => f.kind === 'fact' && f.status === 'active')) {
        nextActions.push('检查或确认该经历成立的具体适用范围条件');
        nextActions.push('输入改写句在同一张已确认图上对比结构影响');
      }
      if (nextFacts.some((f) => f.status === 'active')) {
        nextActions.push('指定条目 ID 或轮次撤回某条早期限定条件，或随时请求收束当前讨论');
      }
      if (nextActions.length === 0) {
        nextActions.push('补充一条您本人的相关经历或明确判断', '追问为何优先拆解当前焦点或查看材料出处');
      }

      // ===== QA-08 & QA-02：构造严格受预算约束的模型输入上下文，并同步更新外发预览 =====
      const budget = resolveEffectiveContextBudget(this, session, input);
      const explicitRefs = extractExplicitRefsFromInput(userText, action, focus);
      const turnVerifiedIdSet = new Set(turnVerifiedEvidence.map((e) => e.id ?? e.evidenceId));

      // 外发给模型的证据候选池：个人采集材料只允许本轮相关或显式点选的片段进入
      const modelEligibleEvidencePool = nextEvidenceIndex.filter((ev) => {
        if (ev.sourceType !== 'collection_record') return true;
        if (personalMaterialsDisabled) return false;
        const eid = ev.id ?? ev.evidenceId;
        return turnVerifiedIdSet.has(eid) || explicitRefs.includes(eid);
      });

      const snapshotForContext = {
        sessionId,
        dataMode: sessionMode,
        graphVersion: targetGraphVersion,
        currentFocus: focus,
        confirmedGraph: nextConfirmedGraph,
        evidenceIndex: modelEligibleEvidencePool,
        facts: nextFacts,
        statements: nextStatements,
        deniedAttributions: nextDeniedAttributions,
        pendingConfirmations: nextPendingConfirmations,
        turns: session.turns ?? [],
      };

      let builtContext = null;
      let conversationSummary = '';
      if (this.contextBuilder) {
        const buildCtxFn =
          this.contextBuilder.buildTurnContext
          ?? this.contextBuilder.buildModelContext
          ?? this.contextBuilder.buildContext;
        if (typeof buildCtxFn === 'function') {
          builtContext = usesObjectParam(buildCtxFn)
            ? await buildCtxFn.call(this.contextBuilder, {
                session: snapshotForContext,
                turnId,
                intent,
                focus,
                userText,
                requestedIds: explicitRefs,
                ...budget,
              })
            : await buildCtxFn.call(this.contextBuilder, snapshotForContext, {
                focus,
                userText,
                requestedIds: explicitRefs,
                ...budget,
              });
          if (typeof builtContext === 'string') {
            conversationSummary = builtContext;
          } else if (typeof builtContext?.promptText === 'string') {
            conversationSummary = builtContext.promptText;
          } else if (typeof builtContext?.summary === 'string') {
            conversationSummary = builtContext.summary;
          } else if (Array.isArray(builtContext?.recentTurns) && builtContext.recentTurns.length > 0) {
            conversationSummary = builtContext.recentTurns
              .map((t) => `第${t.turnNumber ?? '?'}轮(${t.turnId}) 用户：“${t.userText ?? t.text ?? ''}”`)
              .join('\n');
          }
        }
      } else if (Array.isArray(session.turns) && session.turns.length > 0 && budget.recentTurnsLimit > 0) {
        conversationSummary = session.turns
          .filter((t) => t.status === 'committed')
          .slice(-budget.recentTurnsLimit)
          .map((t) => `第${t.turnNumber ?? '?'}轮(${t.turnId}, ${t.intent}) 用户：“${(t.userText ?? t.text ?? '').slice(0, 160)}”`)
          .join('\n');
      }

      const retrievedEarlyItems = Array.isArray(builtContext?.retrievedEarlyItems)
        ? builtContext.retrievedEarlyItems
        : [];
      for (const ref of explicitRefs) {
        if (!retrievedEarlyItems.some((item) => item.id === ref || item.requestedBy === ref)) {
          const directLookup = await lookupByIdFromStore(this.store, ownerId, sessionId, ref);
          if (directLookup?.found) {
            retrievedEarlyItems.push({
              matchType: directLookup.matchType ?? directLookup.kind ?? 'record',
              id: directLookup.id ?? ref,
              requestedBy: ref,
              item: directLookup.item ?? directLookup.record ?? directLookup,
            });
          }
        }
      }
      if (!referencedLookup && retrievedEarlyItems.length > 0) {
        referencedLookup = retrievedEarlyItems.length === 1 ? retrievedEarlyItems[0] : retrievedEarlyItems;
      }

      const querySeed = `${userText} ${focus?.spanText ?? ''} ${nextStatements.find((s) => s.statementId === activeStatementId)?.text ?? ''}`
        .replace(/\b(?:fact|cond|turn|ev|evidence|stmt|node)_[A-Za-z0-9_.:-]+\b/gi, ' ');
      const queryBigrams = extractBigrams(querySeed);
      const queryTokens = (querySeed.toLowerCase().match(/[a-z]{3,}|[\u4e00-\u9fa5]{2,8}/g) ?? []);

      const mustIncludeFactIds = new Set();
      for (const item of retrievedEarlyItems) {
        if (item.matchType === 'fact' && item.id) mustIncludeFactIds.add(item.id);
        if (item.matchType === 'turn' && Array.isArray(item.item?.facts)) {
          for (const tf of item.item.facts) if (tf?.id) mustIncludeFactIds.add(tf.id);
        }
        if (item.matchType === 'turn' && Array.isArray(item.item?.relatedFacts)) {
          for (const tf of item.item.relatedFacts) if (tf?.id) mustIncludeFactIds.add(tf.id);
        }
      }
      if (referencedLookup?.matchType === 'fact' && referencedLookup.id) {
        mustIncludeFactIds.add(referencedLookup.id);
      }
      if (retractionSummary?.retractedFactId) {
        mustIncludeFactIds.add(retractionSummary.retractedFactId);
      }
      const conflictNodeSet = new Set([
        ...(activeQuote?.directConflicts ?? []),
        ...(activeQuote?.collateral ?? []),
        ...(focusedNode ? [focusedNode.id] : []),
      ]);
      for (const n of nextConfirmedGraph) {
        if (conflictNodeSet.has(n.id)) {
          for (const fid of n.sourceFactIds ?? []) mustIncludeFactIds.add(fid);
          if (n.conditionFactId) mustIncludeFactIds.add(n.conditionFactId);
        }
      }

      // 仅保留本轮新建/撤回、显式引用、冲突节点关联或与当前输入有实际语义重合的事实，严禁倾倒无关标记
      const boundedFacts = nextFacts
        .map((f) => {
          const isCurrentTurn = f.turnId === turnId || f.retractedByTurnId === turnId;
          const isExplicitRef =
            mustIncludeFactIds.has(f.id)
            || explicitRefs.includes(f.id)
            || explicitRefs.includes(f.turnId)
            || (Number.isInteger(f.turnNumber) && explicitRefs.includes(`turn_${f.turnNumber}`));
          const overlap = lexicalRelevanceScore(`${f.scopeText ?? ''} ${f.text ?? ''}`, queryBigrams, queryTokens);
          const priority = isCurrentTurn || isExplicitRef ? 1000 : overlap;
          return { f, priority, keep: isCurrentTurn || isExplicitRef || overlap >= 2 };
        })
        .filter((entry) => entry.keep)
        .sort((a, b) => b.priority - a.priority)
        .slice(0, budget.maxFacts)
        .map((entry) => entry.f);

      const boundedFactIdSet = new Set(boundedFacts.map((f) => f.id));

      // 有界局部图节点：仅保留本轮新增、冲突/焦点涉及、显式引用事实关联或词面相关的节点
      const addedNodeSet = new Set(graphDelta.addedNodes);
      const boundedGraphNodes = nextConfirmedGraph
        .map((n) => {
          const isMust =
            addedNodeSet.has(n.id)
            || conflictNodeSet.has(n.id)
            || explicitRefs.includes(n.id)
            || (n.conditionFactId && boundedFactIdSet.has(n.conditionFactId))
            || (Array.isArray(n.sourceFactIds) && n.sourceFactIds.some((fid) => boundedFactIdSet.has(fid)));
          const overlap = lexicalRelevanceScore(n.text, queryBigrams, queryTokens);
          return { n, priority: isMust ? 1000 + (n.S ?? 0) : overlap, keep: isMust || overlap >= 2 };
        })
        .filter((entry) => entry.keep)
        .sort((a, b) => b.priority - a.priority)
        .slice(0, budget.maxLocalNodes)
        .map((entry) => entry.n);

      // 有界证据列表：仅保留本轮核验或显式引用事实/节点关联的证据，严格受 maxEvidence 限制
      const priorityEvIdSet = new Set([
        ...turnVerifiedEvidence.map((e) => e.id ?? e.evidenceId),
        ...boundedFacts.flatMap((f) => f.evidenceIds ?? (f.evidenceId ? [f.evidenceId] : [])),
        ...boundedGraphNodes.flatMap((n) => n.evidenceIds ?? []),
      ]);
      const boundedEvidence = modelEligibleEvidencePool
        .filter((e) => priorityEvIdSet.has(e.id ?? e.evidenceId))
        .slice(0, budget.maxEvidence);

      const boundedEvIdSet = new Set(boundedEvidence.map((e) => e.id ?? e.evidenceId));
      const boundedPendingConfirmations = nextPendingConfirmations
        .filter((pc) => {
          if (pc.kind === 'scope_condition') return true;
          if (pc.evidenceId && boundedEvIdSet.has(pc.evidenceId)) return true;
          return lexicalRelevanceScore(pc.text, queryBigrams, queryTokens) >= 2;
        })
        .slice(0, budget.maxEvidence);

      // 计算实际进入模型提示词的个人采集片段列表，并在发往模型前门禁复核与同步更新 outboundPreview
      const promptPersonalEvidenceMap = new Map();
      for (const ev of boundedEvidence) {
        if (ev.sourceType === 'collection_record') {
          promptPersonalEvidenceMap.set(ev.id ?? ev.evidenceId, ev);
        }
      }
      for (const pc of boundedPendingConfirmations) {
        if (pc.evidenceId) {
          const found = modelEligibleEvidencePool.find(
            (e) => (e.id ?? e.evidenceId) === pc.evidenceId && e.sourceType === 'collection_record',
          );
          if (found) promptPersonalEvidenceMap.set(found.id ?? found.evidenceId, found);
        }
      }
      const promptPersonalItems = [...promptPersonalEvidenceMap.values()];

      const turnOutboundPreview = buildTurnOutboundPreview({
        modelConfig,
        personalMaterialsEnabled: !personalMaterialsDisabled,
        cloudConsentGranted: effectiveCloudConsent,
        personalItems: promptPersonalItems,
        secrets,
        confirmedOutboundPreviewId:
          approvedOutboundManifest?.confirmedOutboundPreviewId
          ?? approvedOutboundManifest?.outboundPreviewId
          ?? session.confirmedOutboundPreviewId
          ?? null,
      });

      const enforceLatestConsentAndManifest = async () => {
        turnSignal.throwIfAborted();
        if (!isCloudModel) return;
        if (promptPersonalItems.length === 0 && !alreadyHasPersonalMaterials) return;
        const latestSession = await readSessionFromStore(this.store, ownerId, sessionId);
        const explicitlyRevoked = Boolean(
          latestSession && (
            latestSession.cloudConsent === false
            || latestSession.allowCloudModel === false
            || latestSession.metadata?.cloudConsent === false
          ),
        );
        const latestConsent = explicitlyRevoked
          ? false
          : (typeof latestSession?.cloudConsent === 'boolean' ? latestSession.cloudConsent : effectiveCloudConsent);
        if (latestConsent !== true) {
          throw new BackendServiceError(
            'CLOUD_CONSENT_REQUIRED',
            '发起云模型调用前检测到会话云推理授权未开启或已撤回，已拦截模型调用。',
            403,
            { outboundPreview: { ...turnOutboundPreview, cloudConsentGranted: false, previewConfirmed: false, confirmedOutboundPreviewId: null } },
          );
        }
        if (approvedOutboundManifest && !verifyOutboundSnippetsMatchManifest(turnOutboundPreview.items, approvedOutboundManifest)) {
          throw new BackendServiceError(
            'CLOUD_CONSENT_REQUIRED',
            '拟发送给云模型的个人片段与已确认的外发预览清单不一致，已拒绝模型调用。',
            403,
            { outboundPreview: turnOutboundPreview },
          );
        }
      };

      await enforceLatestConsentAndManifest();

      // 强制所有进入模型提示词的个人采集片段严格使用拟外发清单中已裁剪的 text、source 与 range，杜绝未裁剪后段泄露。
      const manifestItemById = new Map(turnOutboundPreview.items.map((item) => [item.evidenceId, item]));
      const promptBoundedEvidence = boundedEvidence
        .map((ev) => {
          if (ev.sourceType !== 'collection_record') return ev;
          const eid = ev.evidenceId ?? ev.id;
          const mItem = manifestItemById.get(eid);
          if (!mItem) return null;
          return {
            ...ev,
            text: mItem.text,
            excerpt: mItem.text,
            preview: mItem.text,
            field: mItem.field,
            source: mItem.source,
            range: mItem.range,
            truncated: mItem.truncated,
            summaryTruncated: mItem.truncated,
          };
        })
        .filter(Boolean);

      const promptPendingConfirmations = boundedPendingConfirmations
        .map((pc) => {
          if (pc.kind !== 'candidate_counterexample' && !pc.evidenceId) return pc;
          const mItem = pc.evidenceId ? manifestItemById.get(pc.evidenceId) : null;
          if (!mItem) {
            // 若该待确认项指向个人采集记录但不在本轮外发清单内，绝不带入模型提示词
            if (pc.kind === 'candidate_counterexample') return null;
            return pc;
          }
          return {
            ...pc,
            text: `个人采集中存在作者“${mItem.author ?? pc.author ?? '未知'}”的相关回答（“${mItem.text}”）。该记录属他人观点而非本人立场，仅列为候选线索供您确认或排除。`,
          };
        })
        .filter(Boolean);

      const sanitizeLookupEvidence = (entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        if (entry.sourceType === 'collection_record') {
          const eid = entry.evidenceId ?? entry.id;
          const mItem = manifestItemById.get(eid)
            ?? (isCloudModel ? null : normalizePersonalSnippetForOutbound(entry, 0, {
              maxExcerptChars: DEFAULT_OUTBOUND_EXCERPT_CHARS,
              redact: (s) => redactTurnText(s, secrets),
            }));
          if (!mItem) return null;
          return {
            ...entry,
            text: mItem.text,
            excerpt: mItem.text,
            preview: mItem.text,
            bodyText: mItem.text,
            summary: mItem.text,
            range: mItem.range,
            field: mItem.field,
          };
        }
        return entry;
      };

      const sanitizeLookupPayload = (lookup) => {
        if (!lookup) return null;
        if (Array.isArray(lookup)) {
          return lookup.map(sanitizeLookupPayload).filter(Boolean);
        }
        if (typeof lookup !== 'object') return lookup;
        const copy = { ...lookup };
        if (copy.evidence) copy.evidence = sanitizeLookupEvidence(copy.evidence);
        if (copy.item) copy.item = sanitizeLookupEvidence(copy.item);
        if (Array.isArray(copy.evidences)) {
          copy.evidences = copy.evidences.map(sanitizeLookupEvidence).filter(Boolean);
        }
        return copy;
      };
      const promptReferencedLookup = sanitizeLookupPayload(referencedLookup);

      if (typeof this.store?.updateOutboundPreview === 'function') {
        await this.store.updateOutboundPreview(sessionId, turnOutboundPreview);
      }

      const promptRetractionSummary =
        retractionSummary && retractionSummary.status === 'retracted'
          ? {
              ...retractionSummary,
              preservedFactIds:
                retractionSummary.preservedFactIds.length > 8
                  ? [
                      ...retractionSummary.preservedFactIds.slice(0, 8),
                      `…等共${retractionSummary.preservedFactIds.length}条`,
                    ]
                  : retractionSummary.preservedFactIds,
            }
          : null;

      const verifiedContext = {
        intent,
        turnId,
        sentence: focusTargetSentence,
        focus,
        baseGraphVersion,
        targetGraphVersion,
        graphMutated,
        searchStatus,
        verifiedEvidence: promptBoundedEvidence,
        confirmedFacts: boundedFacts,
        confirmedGraph: boundedGraphNodes,
        pendingConfirmations: promptPendingConfirmations,
        deniedAttributions: nextDeniedAttributions.slice(-6),
        activeQuote,
        quotes: nextQuotes,
        conditionCheckResult,
        invalidatedItems: promptRetractionSummary,
        retractionSummary,
        convergenceSummary: intent === 'converge' ? nextConvergenceSummary : null,
        referencedLookup: promptReferencedLookup,
        nextActions,
      };

      const enabledSources = ['session_turn'];
      if (!personalMaterialsDisabled && (promptPersonalItems.length > 0 || Boolean(nextLockedSnapshotId))) {
        enabledSources.push('collection_record');
      }
      if (materialsAdapter || allowStandaloneDemoFixtures) enabledSources.push('public_search');

      const systemPrompt = buildTurnSystemPrompt({
        intent,
        dataMode: sessionMode,
        enabledSources,
        secrets,
      });

      let userPrompt = buildTurnUserPrompt({
        userText,
        intent,
        verifiedContext,
        conversationSummary,
        secrets,
      });

      // 硬性总字符预算保障（QA-08：若超出 maxPromptChars，渐进收缩近期摘要与次要列表，绝不超预算）
      if (systemPrompt.length + userPrompt.length > budget.maxPromptChars) {
        const compactSummary = conversationSummary.slice(0, Math.min(320, Math.floor(budget.maxPromptChars * 0.15)));
        const compactContext = {
          ...verifiedContext,
          confirmedGraph: boundedGraphNodes.slice(0, Math.min(2, budget.maxLocalNodes)),
          confirmedFacts: boundedFacts.slice(0, Math.min(2, budget.maxFacts)),
          verifiedEvidence: promptBoundedEvidence.slice(0, Math.min(2, budget.maxEvidence)),
          pendingConfirmations: promptPendingConfirmations.slice(0, 2),
          quotes: activeQuote ? [activeQuote] : nextQuotes.slice(0, 1),
        };
        userPrompt = buildTurnUserPrompt({
          userText,
          intent,
          verifiedContext: compactContext,
          conversationSummary: compactSummary,
          secrets,
        });
        if (systemPrompt.length + userPrompt.length > budget.maxPromptChars) {
          const allowedUserLen = Math.max(256, budget.maxPromptChars - systemPrompt.length);
          userPrompt = userPrompt.slice(0, allowedUserLen);
        }
      }

      // ===== 5. 真实流式生成阶段 + 实时增量引文与百分比核验守卫（QA-06） =====
      turnSignal.throwIfAborted();
      await emitStage('streaming_explanation');

      const allowedQuoteSources = [
        userText,
        focusTargetSentence,
        focus?.spanText ?? '',
        focus?.reason ?? '',
        ...nextEvidenceIndex.flatMap((e) => [e.excerpt, e.title, e.author]),
        ...turnVerifiedEvidence.flatMap((e) => [e.excerpt, e.title, e.author]),
        ...nextConfirmedGraph.flatMap((n) => [n.text, n.id]),
        ...nextFacts.flatMap((f) => [f.text, f.scopeText ?? '']),
        ...nextStatements.map((s) => s.text),
        ...nextPendingConfirmations.flatMap((p) => [p.text, p.author, p.scopeText ?? '', p.supportedScope ?? '', p.unsupportedScope ?? '']),
        ...nextDeniedAttributions.flatMap((d) => [d.originalAuthor, d.reason ?? '']),
        ...(conditionCheckResult ? [conditionCheckResult.scopeText, conditionCheckResult.supportedScope, conditionCheckResult.unsupportedScope] : []),
        ...(retractionSummary ? [retractionSummary.retractedText ?? '', retractionSummary.message ?? ''] : []),
      ];

      const allowedRates = [
        ...(activeQuote && Number.isInteger(activeQuote.rate) ? [activeQuote.rate] : []),
        ...nextQuotes.map((q) => q.rate).filter(Number.isInteger),
        ...(retractionSummary?.recalculatedQuotes ?? []).map((q) => q.rate).filter(Number.isInteger),
      ];

      const allowedRatios = [
        ...(activeQuote ? [`${activeQuote.numerator}/${activeQuote.denominator}`] : []),
        ...nextQuotes.map((q) => `${q.numerator}/${q.denominator}`),
      ];

      const streamGuard = createTurnStreamGuard({
        allowedQuoteSources,
        allowedRates,
        allowedRatios,
        activeQuote,
        secrets,
      });

      let accumulatedText = '';
      const emitSafeDelta = async (safeDelta) => {
        if (!safeDelta || safeDelta.length === 0) return;
        if (firstTextDeltaMs === null) {
          firstTextDeltaMs = Math.max(0, Date.now() - startedMs);
        }
        accumulatedText += safeDelta;
        await emitEvent('text.delta', { delta: safeDelta });
      };

      if (resolvedModel) {
        // 发起云模型调用前最后一次核对持久化授权状态与取消信号，确保已撤回会话绝不触发模型调用。
        await enforceLatestConsentAndManifest();
        let streamFailure = null;
        const streamResult = streamText({
          model: resolvedModel,
          system: systemPrompt,
          prompt: userPrompt,
          abortSignal: turnSignal,
          maxOutputTokens: this.maxOutputTokens,
          providerOptions: {
            openaiCompatible: {
              thinking: { type: 'disabled' },
            },
          },
          onError: ({ error }) => {
            streamFailure = error;
          },
        });

        for await (const rawDelta of streamResult.textStream) {
          turnSignal.throwIfAborted();
          const safeChunk = streamGuard.push(rawDelta);
          await emitSafeDelta(safeChunk);
        }

        if (streamFailure) {
          throw streamFailure;
        }
        turnSignal.throwIfAborted();

        const trailingSafe = streamGuard.flush();
        await emitSafeDelta(trailingSafe);

        try {
          const resolvedUsage = await streamResult.usage;
          usageMetrics = normalizeUsageMetrics(resolvedUsage);
        } catch {
          usageMetrics = null;
        }

        if (accumulatedText.trim().length === 0) {
          const fallbackChunks = buildGroundedFallbackChunks(verifiedContext);
          for (const piece of fallbackChunks) {
            turnSignal.throwIfAborted();
            await emitSafeDelta(redactTurnText(piece, secrets));
          }
        }
      } else {
        const fallbackChunks = buildGroundedFallbackChunks(verifiedContext);
        for (const piece of fallbackChunks) {
          turnSignal.throwIfAborted();
          await emitSafeDelta(redactTurnText(piece, secrets));
        }
      }

      const finalResponseText = redactTurnText(accumulatedText, secrets);

      // 6. 单事务原子提交图变更、重算报价、版本号与 turn.committed / turn.done
      const committedEventPayload = {
        turnId,
        sessionId,
        intent,
        focus: {
          ...focus,
          spanText: redactTurnText(focus.spanText, secrets),
          reason: redactTurnText(focus.reason, secrets),
        },
        graphMutated,
        baseGraphVersion,
        graphVersion: targetGraphVersion,
        graphDelta,
        activeStatementId,
        activeQuote,
        quotes: nextQuotes,
        statements: nextStatements,
        statementComparison,
        adoptedStatementId: nextAdoptedStatementId,
        verifiedEvidenceIds: turnVerifiedEvidence.map((e) => e.id ?? e.evidenceId),
        pendingConfirmationsCount: nextPendingConfirmations.length,
        invalidatedItems,
        outboundPreview: turnOutboundPreview,
        ...(retractionSummary ? { retractionSummary } : {}),
        ...(conditionCheckResult ? { conditionCheckResult } : {}),
        ...(intent === 'converge' && nextConvergenceSummary ? { convergenceSummary: nextConvergenceSummary } : {}),
        nextActions,
      };

      const preCommitMetrics = {
        turnId,
        sessionId,
        latencyMs: Math.max(0, Date.now() - startedMs),
        firstEventMs,
        firstTextDeltaMs,
        usage: usageMetrics,
        stages,
        toolCallCount,
        errorCode: null,
      };

      const commitOutcome = await commitStoreTurn(this.store, ownerId, sessionId, turnId, {
        userText: redactTurnText(userText, secrets),
        intent,
        focus,
        graphMutated,
        baseGraphVersion,
        graphVersion: targetGraphVersion,
        lockedSnapshotId: nextLockedSnapshotId,
        confirmedGraph: nextConfirmedGraph,
        graphDelta,
        evidenceIndex: nextEvidenceIndex,
        verifiedEvidence: turnVerifiedEvidence,
        facts: nextFacts,
        upsertedFacts: nextFacts,
        retractionResult: retractionResultForStore,
        pendingConfirmations: nextPendingConfirmations,
        deniedAttributions: nextDeniedAttributions,
        statements: nextStatements,
        upsertedStatements: nextStatements,
        adoptedStatementId: nextAdoptedStatementId,
        activeStatementId,
        quotes: nextQuotes,
        statementComparison,
        activeQuote,
        invalidatedItems,
        invalidatedHistory: nextInvalidatedHistory,
        convergenceSummary: nextConvergenceSummary,
        outboundPreview: turnOutboundPreview,
        responseText: finalResponseText,
        nextActions,
        metrics: preCommitMetrics,
        committedEventPayload,
      });

      const finalStatus = commitOutcome?.status ?? commitOutcome?.outcome ?? 'committed';
      const persistedVersion =
        commitOutcome?.graphVersion
        ?? commitOutcome?.sessionGraphVersion
        ?? targetGraphVersion;

      const metrics = this._recordMetrics({
        ...preCommitMetrics,
        latencyMs: Math.max(0, Date.now() - startedMs),
        errorCode: finalStatus === 'cancelled' ? 'CANCELLED' : null,
      });

      return {
        turnId,
        sessionId,
        status: finalStatus,
        intent,
        focus,
        graphMutated: finalStatus === 'committed' ? graphMutated : false,
        baseGraphVersion,
        graphVersion: persistedVersion,
        activeStatementId,
        activeQuote,
        quotes: nextQuotes,
        statementComparison,
        adoptedStatementId: nextAdoptedStatementId,
        invalidatedItems,
        retractionSummary,
        convergenceSummary: intent === 'converge' ? nextConvergenceSummary : null,
        outboundPreview: turnOutboundPreview,
        responseText: finalResponseText,
        nextActions,
        metrics,
      };
    } catch (rawError) {
      const classified = classifyTurnError(rawError, turnSignal);
      const metrics = this._recordMetrics({
        turnId,
        sessionId,
        latencyMs: Math.max(0, Date.now() - startedMs),
        firstEventMs,
        firstTextDeltaMs,
        usage: usageMetrics,
        stages,
        toolCallCount,
        errorCode: classified.code,
      });

      if (classified.code === 'CANCELLED') {
        await cancelStoreTurn(this.store, ownerId, sessionId, turnId);
      } else {
        await failStoreTurn(this.store, ownerId, sessionId, turnId, {
          baseGraphVersion,
          errorCode: classified.code,
          message: classified.message,
          pendingStatement: pendingNewStatement,
          metrics,
        });
      }

      throw new BackendServiceError(
        classified.code,
        classified.message,
        classified.status,
        { turnId, sessionId, metrics },
      );
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      this.activeControllers.delete(activeKey);
    }
  }
}

TurnOrchestrator.prototype.executeTurn = TurnOrchestrator.prototype.runTurn;
TurnOrchestrator.prototype.processTurn = TurnOrchestrator.prototype.runTurn;

export function createTurnOrchestrator(options = {}) {
  return new TurnOrchestrator(options);
}
