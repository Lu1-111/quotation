// 固定快照分页读取、外发预览与云端推理同意门禁、脱敏议题提取与按缺口公开检索。
import { BackendServiceError } from './protocol.mjs';
import {
  applyDeniedAttributions,
  deduplicateEvidenceList,
  normalizeCollectionRecordToEvidence,
  normalizeSearchItemToEvidence,
  normalizeTextForDedup,
} from './evidence.mjs';

// 判断模型服务地址是否为本机回环（127.0.0.0/8、localhost、::1）。
export function isLoopbackBaseUrl(baseURL) {
  if (typeof baseURL !== 'string' || !baseURL.trim()) return false;
  let parsed;
  try {
    parsed = new URL(baseURL.trim());
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (/^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(host)) {
    return true;
  }
  return false;
}

function safeModelOrigin(baseURL) {
  if (typeof baseURL !== 'string' || !baseURL.trim()) return null;
  try {
    const url = new URL(baseURL.trim());
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

// 生成将发给推理模型的片段预览清单，并强制检查本机回环推理与非本机云推理同意约束。
export function buildOutboundModelPreview({
  modelConfig,
  evidenceItems = [],
  allowPersonalData = false,
  usePersonalMaterials = true,
  cloudConsent = false,
  maxPreviewChars = 120,
} = {}) {
  const rawList = Array.isArray(evidenceItems) ? evidenceItems : [];
  const list = usePersonalMaterials === false
    ? rawList.filter((item) => item?.sourceType !== 'collection_record')
    : rawList;
  const hasPersonalData = list.some((item) => item?.sourceType === 'collection_record');
  const isLoopback = isLoopbackBaseUrl(modelConfig?.baseURL);

  // 本机回环推理无需云同意即可使用会话已启用的个人授权材料；非本机外部模型发送个人材料必须具备明确 cloudConsent===true。
  if (hasPersonalData && !isLoopback && cloudConsent !== true) {
    throw new BackendServiceError(
      'CLOUD_CONSENT_REQUIRED',
      '个人材料发往云端推理模型需本人明确同意。',
      403,
      { model: modelConfig?.modelName ?? null },
    );
  }

  const items = list.map((ev) => {
    const raw = String(ev?.excerpt ?? '');
    const chars = [...raw];
    const preview = chars.length > maxPreviewChars
      ? `${chars.slice(0, maxPreviewChars).join('')}…`
      : raw;
    return {
      evidenceId: ev?.id ?? null,
      sourceType: ev?.sourceType ?? 'unknown',
      author: ev?.author ?? '未知作者',
      attribution: ev?.attribution ?? 'other_author',
      field: ev?.locator?.field ?? ev?.textKind ?? 'excerpt',
      charCount: chars.length,
      preview,
    };
  });

  return {
    targetModel: {
      providerName: modelConfig?.providerName ?? 'openai-compatible',
      modelName: modelConfig?.modelName ?? null,
      baseURL: safeModelOrigin(modelConfig?.baseURL),
      isLoopback,
      isCloud: !isLoopback,
    },
    includesPersonalData: hasPersonalData,
    allowPersonalData: Boolean(allowPersonalData || (isLoopback && usePersonalMaterials !== false)),
    usePersonalMaterials: usePersonalMaterials !== false,
    cloudConsent: Boolean(cloudConsent === true),
    totalItems: items.length,
    totalChars: items.reduce((sum, item) => sum + item.charCount, 0),
    items,
  };
}

function unwrapToolEnvelope(rawResult) {
  if (!rawResult || typeof rawResult !== 'object') {
    return {
      schemaVersion: 1,
      ok: false,
      data: null,
      error: { code: 'INVALID_RESPONSE', message: '工具未返回有效对象。' },
    };
  }
  if (rawResult.structuredContent && typeof rawResult.structuredContent === 'object') {
    return rawResult.structuredContent;
  }
  if (typeof rawResult.ok === 'boolean' && ('data' in rawResult || 'error' in rawResult)) {
    return rawResult;
  }
  if (Array.isArray(rawResult.content)) {
    const textPart = rawResult.content.find((part) => part?.type === 'text' && typeof part.text === 'string');
    if (textPart) {
      try {
        const parsed = JSON.parse(textPart.text);
        if (typeof parsed?.ok === 'boolean') return parsed;
      } catch {
        // 忽略非 JSON 文本，走下方兜底
      }
    }
  }
  return {
    schemaVersion: 1,
    ok: false,
    data: null,
    error: { code: 'INVALID_RESPONSE', message: '无法解析工具返回结构。' },
  };
}

async function invokeTool(callTool, toolName, args = {}, { signal } = {}) {
  if (!callTool) {
    return {
      schemaVersion: 1,
      ok: false,
      data: null,
      error: { code: 'NOT_CONFIGURED', message: `未配置工具入口：${toolName}` },
    };
  }
  try {
    signal?.throwIfAborted();
    let raw;
    if (typeof callTool === 'function') {
      raw = await callTool(toolName, args, { signal });
    } else if (typeof callTool.call === 'function') {
      raw = await callTool.call(toolName, args, { signal });
    } else if (callTool[toolName] && typeof callTool[toolName].execute === 'function') {
      raw = await callTool[toolName].execute(args, { abortSignal: signal, signal });
    } else {
      return {
        schemaVersion: 1,
        ok: false,
        data: null,
        error: { code: 'NOT_CONFIGURED', message: `未找到工具定义：${toolName}` },
      };
    }
    return unwrapToolEnvelope(raw);
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') {
      return {
        schemaVersion: 1,
        ok: false,
        data: null,
        error: { code: 'CANCELLED', message: '工具调用已取消。' },
      };
    }
    if (error?.name === 'TimeoutError') {
      return {
        schemaVersion: 1,
        ok: false,
        data: null,
        error: { code: 'TIMEOUT', message: '工具调用超时。' },
      };
    }
    return {
      schemaVersion: 1,
      ok: false,
      data: null,
      error: { code: error?.code || 'INTERNAL_ERROR', message: '工具调用执行异常。' },
    };
  }
}

const COLLECTION_ERROR_STATUS_MAP = Object.freeze({
  NOT_CONFIGURED: 'not_configured',
  READ_ONLY_REQUIRED: 'not_configured',
  UNKNOWN_TOOL: 'not_configured',
  LOGIN_REQUIRED: 'login_required',
  UNAUTHORIZED: 'login_required',
  TOKEN_REVOKED: 'login_required',
  CONSENT_REQUIRED: 'consent_required',
  CONSENT_SCOPE_MISMATCH: 'consent_scope_mismatch',
  NOT_FOUND: 'not_found',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
});

// 通过只读入口分页读取个人知识画像，锁定第一页（或传入的 lockedSnapshotId）跨页对齐，并按授权上限请求正文片段。
export async function loadAuthorizedCollectionMaterials({
  callTool,
  lockedSnapshotId = null,
  maxPages = 5,
  pageSize = 10,
  summaryMaxChars = 600,
  includeBody = true,
  bodyMaxChars = 4000,
  usePersonalMaterials = true,
  deniedAttributions = [],
  signal,
} = {}) {
  if (usePersonalMaterials === false) {
    return {
      status: 'disabled',
      snapshotId: null,
      evidence: [],
      rawPageCount: 0,
      coverage: null,
      errorCode: null,
      message: '本次会话已关闭个人采集材料读取。',
    };
  }

  const safeMaxPages = Number.isInteger(maxPages) && maxPages >= 1 ? Math.min(20, maxPages) : 5;
  const safePageSize = Number.isInteger(pageSize) && pageSize >= 1 ? Math.min(20, pageSize) : 10;
  const safeSummaryMaxChars = Number.isInteger(summaryMaxChars) && summaryMaxChars >= 0
    ? Math.min(1000, summaryMaxChars)
    : 600;
  const clampedBodyMaxChars = Number.isInteger(bodyMaxChars)
    ? Math.max(0, Math.min(50000, bodyMaxChars))
    : 4000;
  const effectiveBodyMaxChars = includeBody === false ? 0 : clampedBodyMaxChars;

  let activeSnapshotId = typeof lockedSnapshotId === 'string' && lockedSnapshotId.trim()
    ? lockedSnapshotId.trim()
    : null;
  let offset = 0;
  let rawPageCount = 0;
  let coverage = null;
  const collected = [];

  for (let pageIndex = 0; pageIndex < safeMaxPages; pageIndex += 1) {
    const args = {
      offset,
      limit: safePageSize,
      summaryMaxChars: safeSummaryMaxChars,
      bodyMaxChars: effectiveBodyMaxChars,
      ...(activeSnapshotId ? { snapshotId: activeSnapshotId } : {}),
    };
    const response = await invokeTool(callTool, 'zhihu_knowledge_profile', args, { signal });
    if (!response.ok) {
      const errorCode = response.error?.code ?? 'INTERNAL_ERROR';
      const status = COLLECTION_ERROR_STATUS_MAP[errorCode] ?? 'error';
      const finalizedPartial = applyDeniedAttributions(
        deduplicateEvidenceList(collected),
        deniedAttributions,
      );
      return {
        status,
        snapshotId: activeSnapshotId,
        evidence: finalizedPartial,
        rawPageCount,
        coverage,
        errorCode,
        message: response.error?.message ?? '读取个人采集快照失败。',
      };
    }

    const data = response.data ?? {};
    rawPageCount += 1;
    if (!activeSnapshotId && typeof data.snapshotId === 'string' && data.snapshotId.trim()) {
      activeSnapshotId = data.snapshotId.trim();
    } else if (activeSnapshotId && data.snapshotId && data.snapshotId !== activeSnapshotId) {
      return {
        status: 'error',
        snapshotId: activeSnapshotId,
        evidence: applyDeniedAttributions(deduplicateEvidenceList(collected), deniedAttributions),
        rawPageCount,
        coverage,
        errorCode: 'SNAPSHOT_MISMATCH',
        message: '分页返回的 snapshotId 与已锁定的快照不一致，已中止混读。',
      };
    }

    if (data.coverage && !coverage) {
      coverage = data.coverage;
    }

    const records = Array.isArray(data.records) ? data.records : [];
    for (const record of records) {
      collected.push(
        normalizeCollectionRecordToEvidence(record, { snapshotId: activeSnapshotId }),
      );
    }

    const hasMore = Boolean(data.page?.hasMore);
    const nextOffset = data.page?.nextOffset;
    if (!hasMore || !Number.isInteger(nextOffset) || nextOffset <= offset) {
      break;
    }
    offset = nextOffset;
  }

  const deduped = deduplicateEvidenceList(collected);
  const evidence = applyDeniedAttributions(deduped, deniedAttributions);

  return {
    status: 'ok',
    snapshotId: activeSnapshotId,
    evidence,
    rawPageCount,
    coverage,
    errorCode: null,
    message: null,
  };
}

// 常见高价值双词/专有名词词表（优先完整保留）
const KNOWN_TOPIC_PHRASES = [
  '推荐算法',
  '推荐系统',
  '信息茧房',
  '信息流',
  '音乐推荐',
  '独立乐队',
  '独立音乐',
  '同类歌曲',
  '协同过滤',
  '冷启动',
  '远程办公',
  '居家办公',
  '异步文档',
  '异步协作',
  '团队协作',
  '交付周期',
  '跨时区',
  '工程团队',
  '研发团队',
  '接口契约',
  '知识图谱',
  '大模型',
  '本地部署',
  '代码审查',
];

const COMPOUND_HEAD_SUFFIXES = [
  '效率',
  '周期',
  '成本',
  '边界',
  '质量',
  '能力',
  '机制',
  '系统',
  '算法',
  '模式',
  '结构',
  '策略',
  '偏好',
  '场景',
  '时段',
  '团队',
  '协作',
  '办公',
  '推荐',
  '歌曲',
  '乐队',
  '文档',
  '兴趣',
  '茧房',
];

const NON_TOPIC_SINGLE_WORDS = new Set([
  '问题', '事情', '方面', '情况', '条件', '时候', '阶段', '结果', '原因', '影响',
  '观点', '看法', '说法', '内容', '材料', '证据', '反例', '例子', '回答', '文章',
  '作者', '用户', '大家', '人们', '别人', '他人', '东西', '地方', '时间', '方式',
  '开始', '后来', '最后', '现在', '目前', '以前', '以后', '之前', '之后', '固定',
  '核心', '所有', '全部', '必然', '只会', '只有', '总是', '从不', '绝不', '一定',
]);

function stripSecretsAndUrls(raw) {
  return String(raw ?? '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/【系统指令】[^。！？\n]*/g, ' ')
    .replace(/<\s*\/?\s*system\s*>/gi, ' ')
    .replace(/\b(?:api[_-]?key|access[_-]?secret|secret|token|password|authorization)\s*[:=]\s*\S+/gi, ' ')
    .replace(/\b(?:API_KEY|ZHIHU_ACCESS_SECRET|DATA_SERVICE_AGENT_TOKEN|DATA_SERVICE_USER_TOKEN|AGENT_API_KEY)\b/g, ' ')
    .replace(/\b(?:agt|usr|dev|sk|pk|rk|ghp|gho|xoxb|Bearer)[_-][A-Za-z0-9._-]{3,}\b/gi, ' ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ' ')
    .replace(/\b[A-Za-z0-9_-]{16,}\b/g, ' ')
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{8,}\b/g, ' ');
}

const PERSONAL_AND_OPERATOR_STRIP_RE = new RegExp(
  [
    '第[零一二三四五六七八九十百千万\\d]+[轮次条篇页步]',
    '(?:上一|下一|这一|本|前几|刚才那)[轮次条篇]',
    '刚才讨论的?', '刚才', '刚刚', '前面说的?', '前面', '之前说的?', '上文', '上面',
    '我本人', '我自己', '本人', '个人认为', '个人觉得', '咱们', '我们', '你们', '他们', '她们',
    '我的', '你的', '他的', '她的',
    '收藏夹里?', '收藏过?的?', '收藏', '点赞过?的?', '点赞', '浏览历史', '浏览记录', '阅读记录', '浏览过?的?', '浏览',
    '顺手点开', '点开', '刷到', '看到', '看过', '读过', '听过', '用过',
    '那位作者', '某位作者', '他人回答', '这篇回答', '那条回答', '那篇文章', '那篇', '那条', '这条', '这篇',
    '回答说', '文章说', '提到的?', '指出',
    '你怎么看', '怎么看', '为什么', '是不是', '是否', '如何', '怎么', '什么',
    '无一例外', '从来不会', '绝不会', '只会', '只有', '必然会?', '必定会?', '一定会?',
    '所有', '全部', '一切', '总是', '永远', '完全', '绝对', '绝不', '从不', '往往', '通常', '可能', '也许', '其实', '确实', '真的', '反而',
    '越来越', '更加', '非常', '十分', '比较',
    '只发生在', '刚开始用的时候', '刚开始使用时', '刚开始用时', '刚开始用', '刚开始',
    '连续听', '连续看', '连续刷', '连续',
    '的时候', '之后', '之前', '以后', '以前', '情况下', '条件下', '前提下',
    '一旦', '只要', '除非', '如果', '虽然', '但是', '不过', '而且', '或者', '因为', '所以',
    '导致', '使得', '让人的', '让人', '使人', '会让', '能让',
    '降低', '提高', '提升', '缩短', '拉长', '减少', '增加', '放大', '压制', '取代', '配合', '进入', '陷入', '变成', '成为',
    '觉得', '认为', '以为', '发现', '固定核心',
    '[我你他她它吗呢吧啊呀的了着过是有会能把被给向从到与和及在对当就也还都又更只不没无让使说看想问]',
  ].join('|'),
  'gu',
);

function splitChineseCompoundChunk(chunk) {
  const clean = chunk.trim();
  if (clean.length < 2) return [];
  if (clean.length <= 4) {
    return NON_TOPIC_SINGLE_WORDS.has(clean) ? [] : [clean];
  }
  const out = [];
  let remaining = clean;
  for (const phrase of KNOWN_TOPIC_PHRASES) {
    if (remaining.includes(phrase)) {
      out.push(phrase);
      remaining = remaining.replace(phrase, '|');
    }
  }
  for (const piece of remaining.split('|').map((s) => s.trim()).filter(Boolean)) {
    if (piece.length < 2) continue;
    if (piece.length <= 4) {
      if (!NON_TOPIC_SINGLE_WORDS.has(piece)) out.push(piece);
      continue;
    }
    let matchedSuffix = false;
    for (const suffix of COMPOUND_HEAD_SUFFIXES) {
      if (piece.endsWith(suffix) && piece.length > suffix.length) {
        const prefix = piece.slice(0, piece.length - suffix.length);
        if (prefix.length >= 2 && prefix.length <= 4 && !NON_TOPIC_SINGLE_WORDS.has(prefix)) {
          out.push(prefix);
        }
        if (!NON_TOPIC_SINGLE_WORDS.has(suffix)) {
          out.push(suffix);
        }
        matchedSuffix = true;
        break;
      }
    }
    if (!matchedSuffix) {
      if (piece.length <= 8) {
        out.push(piece);
      } else {
        out.push(piece.slice(0, 6));
      }
      const head = piece.slice(0, 4);
      const tail = piece.slice(-4);
      if (head.length >= 2 && head !== piece && !NON_TOPIC_SINGLE_WORDS.has(head)) {
        out.push(head);
      }
      if (tail.length >= 2 && tail !== piece && tail !== head && !NON_TOPIC_SINGLE_WORDS.has(tail)) {
        out.push(tail);
      }
    }
  }
  return out;
}

// 提取用于公开搜索的通用议题词：剥离个人会话指代与任何疑似凭证/令牌串。
export function extractGenericTopicTerms(sentence, focus = null) {
  const combinedInput = [
    typeof sentence === 'string' ? sentence : '',
    typeof focus?.spanText === 'string' ? focus.spanText : '',
  ].join(' ');
  const safeText = stripSecretsAndUrls(combinedInput);
  if (!safeText.trim()) return [];

  const collected = [];
  const addTerm = (term) => {
    const clean = term.trim();
    if (clean.length < 2 || clean.length > 16) return;
    if (NON_TOPIC_SINGLE_WORDS.has(clean)) return;
    if (!collected.includes(clean)) collected.push(clean);
  };

  // 1. 先按文本出现顺序提取已知领域复合词
  const matchedKnownPositions = [];
  for (const phrase of KNOWN_TOPIC_PHRASES) {
    const idx = safeText.indexOf(phrase);
    if (idx >= 0) {
      matchedKnownPositions.push({ phrase, idx });
    }
  }
  matchedKnownPositions
    .sort((a, b) => a.idx - b.idx || b.phrase.length - a.phrase.length)
    .forEach(({ phrase }) => addTerm(phrase));

  // 2. 提取安全的英文技术缩写/术语（排除密钥、代词和通用虚词）
  const englishStop = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'will', 'only', 'always', 'never',
    'ignore', 'previous', 'instructions', 'mark', 'attribution', 'self', 'system', 'prompt',
  ]);
  const englishMatches = safeText.match(/\b[A-Za-z][A-Za-z0-9+#.-]{1,14}\b/g) ?? [];
  for (const word of englishMatches) {
    if (englishStop.has(word.toLowerCase())) continue;
    addTerm(word);
  }

  // 3. 剥离个人指代与句法算子后切分剩余中文名词短语
  const stripped = safeText
    .replace(/[，。！？；：、“”‘’（）()【】[\]《》〈〉,.;:!?'"/\n\r\t]+/g, '|')
    .replace(PERSONAL_AND_OPERATOR_STRIP_RE, '|');

  for (const rawSeg of stripped.split('|')) {
    const zhChunks = rawSeg.match(/[\u4e00-\u9fa5]{2,12}/g) ?? [];
    for (const chunk of zhChunks) {
      for (const piece of splitChineseCompoundChunk(chunk)) {
        addTerm(piece);
      }
    }
  }

  // 去掉已被更完整短语完全覆盖的冗余碎片（保留如 ['团队协作', '效率'] 但避免 ['推荐算法', '推荐', '算法'] 重复膨胀）
  const filtered = collected.filter((term) => {
    if (term === '效率' || term === '兴趣') return true;
    return !collected.some((other) => other !== term && other.length <= 4 && other.includes(term));
  });

  return filtered.slice(0, 6);
}

function sanitizeFocusConditionHint(focus) {
  if (!focus || typeof focus.spanText !== 'string') return '';
  const cleaned = stripSecretsAndUrls(focus.spanText)
    .replace(/[我你他她本人自己收藏第轮]/g, '')
    .trim();
  if (cleaned.length < 2 || cleaned.length > 18) return '';
  if (['只会', '只有', '必然', '所有', '全部', '总是', '绝不', '从不', '一定'].includes(cleaned)) {
    return '';
  }
  return cleaned;
}

function extractConditionHintFromSentence(sentence) {
  const safeText = stripSecretsAndUrls(sentence);
  if (!safeText.trim()) return '';
  const patterns = [
    /(?:在|当|若|如果|只要|一旦|除非)([^，。！？；,.;!?]{2,14}?)(?:的时候|之时|情况下|条件下|前提下|之后|以后|期间|时|中|里)/u,
    /([^，。！？；,.;!?]{2,12}?)(?:之后|以后|情况下|条件下|前提下|阶段|期间)/u,
  ];
  for (const pattern of patterns) {
    const match = safeText.match(pattern);
    const candidate = match?.[1]?.trim() ?? '';
    if (
      candidate.length >= 2
      && candidate.length <= 14
      && !NON_TOPIC_SINGLE_WORDS.has(candidate)
      && !/[我你他她本人自己收藏第轮]/u.test(candidate)
    ) {
      return candidate;
    }
  }
  return '';
}

function dedupeQueryTokens(rawQuery) {
  const tokens = String(rawQuery ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const kept = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (kept.some((prev) => prev.toLowerCase() === lower)) continue;
    kept.push(token);
  }
  return kept.join(' ').slice(0, 240);
}

function buildFallbackTopicTerms(sentence) {
  const safeText = stripSecretsAndUrls(sentence)
    .replace(/[，。！？；：、“”‘’（）()【】[\]《》〈〉,.;:!?'"/\n\r\t]+/g, ' ')
    .replace(/(?:我本人|我自己|本人|个人认为|个人觉得|收藏夹|浏览历史|浏览记录)/gu, ' ')
    .trim();
  if (!safeText) return [];
  const terms = [];
  const zhChunks = safeText.match(/[\u4e00-\u9fa5]{2,8}/g) ?? [];
  for (const chunk of zhChunks) {
    const clean = chunk.trim();
    if (clean.length < 2 || NON_TOPIC_SINGLE_WORDS.has(clean)) continue;
    if (!terms.includes(clean)) terms.push(clean);
    if (terms.length >= 4) break;
  }
  if (terms.length < 4) {
    const enChunks = safeText.match(/\b[A-Za-z][A-Za-z0-9+#.-]{1,14}\b/g) ?? [];
    for (const word of enChunks) {
      if (!terms.includes(word)) terms.push(word);
      if (terms.length >= 4) break;
    }
  }
  return terms;
}

function normalizeCallerPlannedQueries(plannedQueries, fallbackKeywords, budget) {
  if (!Array.isArray(plannedQueries) || plannedQueries.length === 0) return null;
  const plans = [];
  const seenQueries = new Set();

  for (const entry of plannedQueries) {
    const rawQuery = typeof entry === 'string'
      ? entry
      : (typeof entry?.query === 'string' ? entry.query : '');
    const safeQuery = dedupeQueryTokens(stripSecretsAndUrls(rawQuery));
    if (!safeQuery || safeQuery.length < 2) continue;
    const dedupKey = safeQuery.toLowerCase();
    if (seenQueries.has(dedupKey)) continue;
    seenQueries.add(dedupKey);

    const rawKeywords = Array.isArray(entry?.keywords)
      ? entry.keywords
          .filter((kw) => typeof kw === 'string')
          .map((kw) => stripSecretsAndUrls(kw).trim())
          .filter((kw) => kw.length >= 2 && kw.length <= 24)
      : [];
    const derivedKeywords = rawKeywords.length > 0
      ? [...new Set(rawKeywords)].slice(0, 6)
      : (extractGenericTopicTerms(safeQuery).length > 0
          ? extractGenericTopicTerms(safeQuery).slice(0, 6)
          : fallbackKeywords.slice(0, 6));

    plans.push({
      aspect: typeof entry?.aspect === 'string' && entry.aspect.trim()
        ? entry.aspect.trim()
        : (plans.length === 0 ? 'model_planned_primary' : 'model_planned_secondary'),
      query: safeQuery,
      keywords: derivedKeywords.length > 0 ? derivedKeywords : [safeQuery.split(' ')[0]],
      keywordMode: entry?.keywordMode === 'all' ? 'all' : 'any',
    });
    if (plans.length >= budget) break;
  }

  return plans.length > 0 ? plans : null;
}

function normalizeCanonicalUrlKey(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${pathname}`;
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

function enrichSearchEvidenceMetadata(ev, rawItem) {
  const rawUrl = typeof rawItem?.url === 'string' && rawItem.url.trim()
    ? rawItem.url.trim()
    : null;
  const canonicalUrl = (typeof rawItem?.canonicalUrl === 'string' && rawItem.canonicalUrl.trim())
    || (rawUrl ? normalizeCanonicalUrlKey(rawUrl) : null)
    || ev.url
    || null;
  const displayUrl = ev.url ?? rawUrl ?? canonicalUrl ?? null;
  const contentId = typeof rawItem?.contentId === 'string' && rawItem.contentId.trim()
    ? rawItem.contentId.trim()
    : null;

  return {
    ...ev,
    url: displayUrl,
    canonicalUrl,
    rawUrl: rawUrl ?? displayUrl,
    ...(contentId ? { contentId } : {}),
    locator: {
      ...(ev.locator ?? { field: 'excerpt', startOffset: 0, endOffset: String(ev.excerpt ?? '').length }),
      ...(displayUrl ? { url: displayUrl } : {}),
      ...(canonicalUrl ? { canonicalUrl } : {}),
      ...(rawUrl ? { rawUrl } : {}),
    },
  };
}

// 公开搜索去重：优先按规范链接（canonicalUrl）与内容标识（contentKey / contentId）归并，再结合摘要文本去重。
function deduplicatePublicSearchEvidence(rawItems = []) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return [];
  const mergedByCanonical = [];
  const indexByCanonicalUrl = new Map();
  const indexByContentKey = new Map();

  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    const urlKey = normalizeCanonicalUrlKey(item.canonicalUrl ?? item.url);
    const contentKey = item.contentKey && item.contentKey !== 'unknown'
      ? String(item.contentKey).toLowerCase()
      : (item.contentId ? `id:${String(item.contentId).toLowerCase()}` : null);

    let existingIdx;
    if (urlKey && indexByCanonicalUrl.has(urlKey)) {
      existingIdx = indexByCanonicalUrl.get(urlKey);
    } else if (contentKey && indexByContentKey.has(contentKey)) {
      existingIdx = indexByContentKey.get(contentKey);
    }

    if (existingIdx !== undefined) {
      const existing = mergedByCanonical[existingIdx];
      const mergedQueries = [...new Set([
        ...(Array.isArray(existing.querySource) ? existing.querySource : []),
        ...(Array.isArray(item.querySource) ? item.querySource : []),
      ])];
      const useIncomingExcerpt =
        typeof item.excerpt === 'string'
        && item.excerpt.length > String(existing.excerpt ?? '').length;
      mergedByCanonical[existingIdx] = {
        ...existing,
        title: existing.title || item.title,
        author: existing.author && existing.author !== '未知作者' ? existing.author : item.author,
        excerpt: useIncomingExcerpt ? item.excerpt : existing.excerpt,
        truncated: useIncomingExcerpt ? Boolean(item.truncated) : Boolean(existing.truncated),
        url: existing.url ?? item.url ?? null,
        canonicalUrl: existing.canonicalUrl ?? item.canonicalUrl ?? null,
        rawUrl: existing.rawUrl ?? item.rawUrl ?? null,
        querySource: mergedQueries.length > 0 ? mergedQueries : null,
        locator: {
          ...(existing.locator ?? {}),
          endOffset: (useIncomingExcerpt ? item.excerpt : existing.excerpt ?? '').length,
          ...(existing.url ?? item.url ? { url: existing.url ?? item.url } : {}),
          ...(existing.canonicalUrl ?? item.canonicalUrl ? { canonicalUrl: existing.canonicalUrl ?? item.canonicalUrl } : {}),
          ...(existing.rawUrl ?? item.rawUrl ? { rawUrl: existing.rawUrl ?? item.rawUrl } : {}),
        },
      };
      if (urlKey) indexByCanonicalUrl.set(urlKey, existingIdx);
      if (contentKey) indexByContentKey.set(contentKey, existingIdx);
    } else {
      const nextIdx = mergedByCanonical.length;
      mergedByCanonical.push(item);
      if (urlKey) indexByCanonicalUrl.set(urlKey, nextIdx);
      if (contentKey) indexByContentKey.set(contentKey, nextIdx);
    }
  }

  return deduplicateEvidenceList(mergedByCanonical);
}

// 围绕当前主张的核心论点及适用条件生成 1–2 条有区分度的查询计划，支持调用方透传模型拆句后的 plannedQueries。
export function planPublicSearchQueries({
  sentence,
  focus = null,
  aspects = ['support', 'counterexample', 'boundary'],
  maxQueries = 2,
  plannedQueries = null,
} = {}) {
  const budget = Number.isInteger(maxQueries) ? Math.max(1, Math.min(6, maxQueries)) : 2;
  const extractedTerms = extractGenericTopicTerms(sentence, focus);
  const topicTerms = extractedTerms.length > 0 ? extractedTerms : buildFallbackTopicTerms(sentence);

  const callerPlans = normalizeCallerPlannedQueries(plannedQueries, topicTerms, budget);
  if (callerPlans) {
    return callerPlans;
  }

  if (topicTerms.length === 0) return [];

  const coreTopics = topicTerms.slice(0, 3).join(' ');
  const focusHint = sanitizeFocusConditionHint(focus);
  const conditionHint = focusHint || extractConditionHintFromSentence(sentence);

  // 若当前焦点本身是适用范围/阶段条件（scope），优先把 boundary 排在预算最前面；
  // 若是全称量词（quantifier，如“只会”“必然”），在 2 条预算内优先兼顾反例与适用条件/原因。
  const orderedAspects = Array.isArray(aspects) && aspects.length > 0
    ? [...aspects]
    : ['support', 'counterexample', 'boundary'];
  if (focus?.kind === 'scope' && orderedAspects.includes('boundary')) {
    orderedAspects.splice(orderedAspects.indexOf('boundary'), 1);
    orderedAspects.unshift('boundary');
  } else if (focus?.kind === 'quantifier' && orderedAspects.includes('counterexample')) {
    orderedAspects.splice(orderedAspects.indexOf('counterexample'), 1);
    orderedAspects.unshift('counterexample');
  }

  const aspectTemplates = {
    support: conditionHint
      ? `${coreTopics} ${conditionHint} 原因`
      : `${coreTopics} 原因 影响`,
    counterexample: `${coreTopics} 反例 例外`,
    boundary: conditionHint
      ? `${coreTopics} ${conditionHint} 适用条件`
      : `${coreTopics} 适用条件 边界`,
  };

  const plans = [];
  const seenQueries = new Set();
  for (const aspect of orderedAspects) {
    const query = dedupeQueryTokens(aspectTemplates[aspect] ?? coreTopics);
    if (!query || seenQueries.has(query.toLowerCase())) continue;
    seenQueries.add(query.toLowerCase());
    plans.push({
      aspect,
      query,
      keywords: topicTerms.slice(0, 6),
      keywordMode: 'any',
    });
    if (plans.length >= budget) break;
  }

  return plans;
}

function extractFocusAnchorTerms(focus) {
  if (!focus || typeof focus.spanText !== 'string') return [];
  const span = stripSecretsAndUrls(focus.spanText).trim();
  if (!span) return [];
  if (focus.kind === 'quantifier') return [];
  const cleaned = span
    .replace(/^(?:在|当|只发生在)/u, '')
    .replace(/(?:的时候|之时|时|之后|以后|情况下|条件下|前提下)$/u, '')
    .trim();
  const terms = [];
  if (cleaned.length >= 2) terms.push(cleaned);
  for (const sub of extractGenericTopicTerms(cleaned)) {
    if (!terms.includes(sub)) terms.push(sub);
  }
  return terms;
}

function scoreDirectRelevance(text, { topicTerms, focusAnchors }) {
  const hay = normalizeTextForDedup(text).toLowerCase();
  if (!hay) return { topicHits: 0, focusHits: 0, totalScore: 0 };
  const topicHits = topicTerms.filter((t) => hay.includes(t.toLowerCase())).length;
  const focusHits = focusAnchors.filter((f) => hay.includes(f.toLowerCase())).length;
  const totalScore = topicHits * 2 + focusHits * 4;
  return { topicHits, focusHits, totalScore };
}

function rankExistingMaterials({ confirmedGraph = [], existingEvidence = [], topicTerms, focusAnchors }) {
  const candidates = [];
  for (const node of Array.isArray(confirmedGraph) ? confirmedGraph : []) {
    if (!node || typeof node.text !== 'string') continue;
    const score = scoreDirectRelevance(node.text, { topicTerms, focusAnchors });
    if (score.topicHits > 0 || score.focusHits > 0) {
      candidates.push({
        kind: 'confirmed_node',
        id: node.id,
        author: 'self',
        sourceKey: `node:${node.id}`,
        ...score,
      });
    }
  }
  for (const ev of Array.isArray(existingEvidence) ? existingEvidence : []) {
    if (!ev || typeof ev !== 'object') continue;
    const score = scoreDirectRelevance(`${ev.title ?? ''} ${ev.excerpt ?? ''}`, { topicTerms, focusAnchors });
    if (score.topicHits > 0 || score.focusHits > 0) {
      candidates.push({
        kind: 'evidence',
        id: ev.id,
        author: ev.author ?? '未知作者',
        sourceKey: `${ev.author ?? 'unknown'}|${ev.contentKey ?? ev.id}`,
        ...score,
      });
    }
  }
  candidates.sort((a, b) => b.totalScore - a.totalScore);
  return candidates;
}

// 先核对已确认图与已有证据是否存在缺口；有缺口时才受预算约束调用 zhihu_search，并区分错误状态与排序。
export async function searchGapMaterials({
  callTool,
  sentence,
  focus = null,
  confirmedGraph = [],
  existingEvidence = [],
  deniedAttributions = [],
  plannedQueries: callerPlannedQueries = null,
  maxQueries = 2,
  limit = 8,
  forceSearch = false,
  signal,
} = {}) {
  const extractedTopicTerms = extractGenericTopicTerms(sentence, focus);
  const topicTerms = extractedTopicTerms.length > 0
    ? extractedTopicTerms
    : buildFallbackTopicTerms(sentence);
  const focusAnchors = extractFocusAnchorTerms(focus);
  const rankedExisting = rankExistingMaterials({
    confirmedGraph,
    existingEvidence,
    topicTerms,
    focusAnchors,
  });

  // 缺口判定：必须既有话题直接命中，又覆盖当前焦点锚点（若有具体条件焦点），且至少来自 2 个独立主体/来源。
  const qualifyingExisting = rankedExisting.filter((item) =>
    item.topicHits >= 1 && (focusAnchors.length === 0 || item.focusHits >= 1),
  );
  const distinctExistingAuthors = new Set(qualifyingExisting.map((item) => item.author));
  const hasSufficientCoverage = qualifyingExisting.length >= 2 && distinctExistingAuthors.size >= 2;

  if (!forceSearch && hasSufficientCoverage) {
    return {
      status: 'skipped_no_gap',
      searched: false,
      evidence: [],
      rankedExisting,
      plannedQueries: [],
      requestIds: [],
      errorCode: null,
      message: null,
    };
  }

  const plannedQueries = planPublicSearchQueries({
    sentence,
    focus,
    maxQueries,
    plannedQueries: callerPlannedQueries,
  });
  if (plannedQueries.length === 0) {
    return {
      status: 'empty',
      searched: false,
      evidence: [],
      rankedExisting,
      plannedQueries: [],
      requestIds: [],
      errorCode: null,
      message: '这句话里暂时还缺少可检索的具体话题词。你可以再补一句具体的对象或场景，我们一起查查。',
    };
  }

  const rawSearchEvidence = [];
  const requestIds = [];
  const safeLimit = Number.isInteger(limit) && limit >= 1 ? Math.min(20, limit) : 8;

  for (const plan of plannedQueries) {
    const response = await invokeTool(
      callTool,
      'zhihu_search',
      {
        query: plan.query,
        keywords: plan.keywords,
        keywordMode: plan.keywordMode ?? 'any',
        maxQueries: 1,
        limit: safeLimit,
      },
      { signal },
    );

    if (!response.ok) {
      const code = response.error?.code ?? 'INTERNAL_ERROR';
      const partial = applyDeniedAttributions(
        deduplicatePublicSearchEvidence(rawSearchEvidence),
        deniedAttributions,
      );
      if (code === 'NOT_CONFIGURED') {
        return {
          status: 'not_configured',
          searched: true,
          evidence: partial,
          rankedExisting,
          plannedQueries,
          requestIds,
          errorCode: code,
          message: '当前还没有配置公开搜索凭证，暂时查不到知乎公开资料。你的原句还在这里，也可以先切到合成演示体验。',
        };
      }
      if (code === 'UPSTREAM_AUTH') {
        return {
          status: 'auth_error',
          searched: true,
          evidence: partial,
          rankedExisting,
          plannedQueries,
          requestIds,
          errorCode: code,
          message: '这次没能通过公开搜索的身份校验，暂时查不到资料。你的原句还在这里，稍后可以再试。',
        };
      }
      if (code === 'RATE_LIMITED') {
        return {
          status: 'rate_limited',
          searched: true,
          evidence: partial,
          rankedExisting,
          plannedQueries,
          requestIds,
          errorCode: code,
          message: '公开搜索暂时达到了频率上限，这次没能查到资料。你的原句还在这里，等一下可以再试。',
        };
      }
      if (code === 'TIMEOUT' || code === 'NETWORK_ERROR') {
        return {
          status: 'timeout',
          searched: true,
          evidence: partial,
          rankedExisting,
          plannedQueries,
          requestIds,
          errorCode: code,
          message: '公开搜索这次响应超时或网络波动，没能拉回资料。你的原句还在这里，等一下可以再试。',
        };
      }
      return {
        status: 'error',
        searched: true,
        evidence: partial,
        rankedExisting,
        plannedQueries,
        requestIds,
        errorCode: code,
        message: '这次没能查到资料。你的原句还在这里，等一下可以再试。',
      };
    }

    const data = response.data ?? {};
    const requestId = data.requestId ?? null;
    if (requestId) requestIds.push(requestId);
    const items = Array.isArray(data.items) ? [...data.items] : [];

    // 若本地搜索快照仍有剩余条目且尚未达到单轮返回上限，可通过 zhihu_get_search_result 补齐（不触发新官方调用）
    if (
      requestId
      && data.page?.hasMore
      && Number.isInteger(data.page?.nextOffset)
      && items.length < safeLimit
    ) {
      const moreRes = await invokeTool(
        callTool,
        'zhihu_get_search_result',
        {
          requestId,
          offset: data.page.nextOffset,
          limit: safeLimit - items.length,
        },
        { signal },
      );
      if (moreRes.ok && Array.isArray(moreRes.data?.items)) {
        items.push(...moreRes.data.items);
      }
    }

    for (const item of items) {
      const normalized = normalizeSearchItemToEvidence(item, { requestId });
      rawSearchEvidence.push(enrichSearchEvidenceMetadata(normalized, item));
    }
  }

  const deduped = deduplicatePublicSearchEvidence(rawSearchEvidence);
  const withDenials = applyDeniedAttributions(deduped, deniedAttributions);

  if (withDenials.length === 0) {
    return {
      status: 'empty',
      searched: true,
      evidence: [],
      rankedExisting,
      plannedQueries,
      requestIds,
      errorCode: null,
      message: '这次没有找到能直接回应这句话的公开资料。这句先留着，我们可以一起把范围说清。',
    };
  }

  // 排序优先级：① 能否直接回答当前焦点；② 是否来自独立作者/来源
  const existingAuthors = new Set(
    (Array.isArray(existingEvidence) ? existingEvidence : [])
      .map((ev) => ev?.author)
      .filter(Boolean),
  );
  const seenBatchAuthors = new Set();

  const scored = withDenials.map((ev) => {
    const relevance = scoreDirectRelevance(`${ev.title} ${ev.excerpt}`, {
      topicTerms,
      focusAnchors,
    });
    const isFreshFromExisting = !existingAuthors.has(ev.author);
    return { ev, relevance, isFreshFromExisting };
  });

  scored.sort((a, b) => b.relevance.totalScore - a.relevance.totalScore);

  const independentPass = [];
  const secondaryPass = [];
  for (const entry of scored) {
    const authorKey = entry.ev.author || entry.ev.url || entry.ev.id;
    if (!seenBatchAuthors.has(authorKey) && entry.isFreshFromExisting) {
      seenBatchAuthors.add(authorKey);
      independentPass.push(entry.ev);
    } else {
      secondaryPass.push(entry.ev);
    }
  }

  const rankedEvidence = [...independentPass, ...secondaryPass].slice(0, safeLimit);

  return {
    status: 'ok',
    searched: true,
    evidence: rankedEvidence,
    rankedExisting,
    plannedQueries,
    requestIds,
    errorCode: null,
    message: null,
  };
}

// 供 serve-cli.mjs / server.mjs / turn-orchestrator.mjs 自动装配的材料适配器（严格隔离 demo 与 real，并遵守个人材料门控）。
export function createMaterialsAdapter({
  config = null,
  dataMode = null,
  demo = false,
  tools = null,
  callTool = null,
  enabled = undefined,
  allowPersonalMaterials = undefined,
  usePersonalMaterials: adapterUsePersonalMaterials = undefined,
  includeBody: defaultIncludeBody = true,
  bodyMaxChars: defaultBodyMaxChars = 4000,
  summaryMaxChars: defaultSummaryMaxChars = 600,
} = {}) {
  const isDemo = dataMode ? dataMode === 'demo' : Boolean(demo || config?.demo);
  const mode = isDemo ? 'demo' : 'real';
  const hasToolsObject = Boolean(
    tools
    && (
      typeof tools === 'function'
      || typeof tools.call === 'function'
      || (typeof tools === 'object' && Object.keys(tools).length > 0)
    ),
  );
  const hasExternalCaller = hasToolsObject || typeof callTool === 'function';
  let lazySynthetic = null;

  const resolvedEnabled = (() => {
    if (enabled === false || allowPersonalMaterials === false || adapterUsePersonalMaterials === false) {
      return false;
    }
    if (typeof enabled === 'boolean') return enabled;
    if (typeof allowPersonalMaterials === 'boolean') {
      return allowPersonalMaterials && (isDemo || hasExternalCaller);
    }
    if (isDemo) return true;
    if (config && typeof config.allowPersonalData === 'boolean') {
      return Boolean(config.allowPersonalData && hasExternalCaller);
    }
    return hasExternalCaller;
  })();

  function isPersonalBlocked(reqUsePersonalMaterials, reqAllowPersonalMaterials) {
    return (
      reqUsePersonalMaterials === false
      || reqAllowPersonalMaterials === false
      || adapterUsePersonalMaterials === false
      || allowPersonalMaterials === false
      || resolvedEnabled === false
    );
  }

  async function resolveToolCaller(requiredToolName = null) {
    if (hasToolsObject) {
      if (
        typeof tools === 'function'
        || typeof tools.call === 'function'
        || !requiredToolName
        || tools[requiredToolName]
      ) {
        return tools;
      }
    }
    if (typeof callTool === 'function' && (!isDemo || (tools === null && !hasToolsObject))) {
      return callTool;
    }
    if (!isDemo) {
      return hasToolsObject ? tools : (typeof callTool === 'function' ? callTool : null);
    }
    if (!lazySynthetic) {
      const { createSyntheticMaterialAdapters } = await import('./fixtures/synthetic-materials.mjs');
      lazySynthetic = createSyntheticMaterialAdapters();
    }
    if (!hasToolsObject && (typeof callTool !== 'function' || tools !== null)) {
      return lazySynthetic.callTool;
    }
    return async (toolName, args = {}, opts = {}) => {
      if (tools && tools[toolName] && typeof tools[toolName].execute === 'function') {
        return tools[toolName].execute(args, { abortSignal: opts?.signal, signal: opts?.signal });
      }
      if (tools === null && typeof callTool === 'function') {
        return callTool(toolName, args, opts);
      }
      return lazySynthetic.callTool(toolName, args, opts);
    };
  }

  return {
    enabled: resolvedEnabled,
    allowPersonalMaterials: resolvedEnabled,
    dataMode: mode,
    async loadMaterials({
      dataMode: reqMode = mode,
      snapshotId = null,
      usePersonalMaterials: reqUsePersonalMaterials = undefined,
      allowPersonalMaterials: reqAllowPersonalMaterials = undefined,
      includeBody = defaultIncludeBody,
      bodyMaxChars = defaultBodyMaxChars,
      summaryMaxChars = defaultSummaryMaxChars,
      deniedAttributions = [],
      signal,
    } = {}) {
      if (reqMode && reqMode !== mode) {
        throw new BackendServiceError(
          'DATA_MODE_MISMATCH',
          '请求的材料数据模式与当前适配器隔离模式不一致。',
          403,
        );
      }
      if (isPersonalBlocked(reqUsePersonalMaterials, reqAllowPersonalMaterials)) {
        const disabledByUser =
          reqUsePersonalMaterials === false
          || reqAllowPersonalMaterials === false
          || adapterUsePersonalMaterials === false
          || allowPersonalMaterials === false;
        return {
          dataMode: mode,
          lockedSnapshotId: null,
          snapshotId: null,
          evidences: [],
          evidence: [],
          materialsStatus: {
            state: disabledByUser ? 'disabled_by_user' : 'unconfigured',
            source: 'none',
            count: 0,
            reasonCode: null,
            message: disabledByUser
              ? '本次会话已按请求关闭个人采集材料，未触发采集读取。'
              : '未启用个人采集材料读取入口，已从本人输入开始会话。',
          },
        };
      }
      const caller = await resolveToolCaller('zhihu_knowledge_profile');
      const loaded = await loadAuthorizedCollectionMaterials({
        callTool: caller,
        lockedSnapshotId: snapshotId,
        summaryMaxChars,
        includeBody,
        bodyMaxChars,
        deniedAttributions,
        signal,
      });
      if (loaded.status !== 'ok') {
        if (snapshotId && loaded.errorCode === 'NOT_FOUND') {
          throw new BackendServiceError('INVALID_ARGUMENTS', loaded.message, 404);
        }
        return {
          dataMode: mode,
          lockedSnapshotId: null,
          snapshotId: null,
          evidences: [],
          evidence: [],
          materialsStatus: {
            state: loaded.status === 'not_configured' ? 'unconfigured' : 'empty',
            source: 'none',
            count: 0,
            reasonCode: loaded.errorCode,
            message: loaded.message ?? '当前无可用个人采集快照，已从本人输入开始会话。',
          },
        };
      }
      return {
        dataMode: mode,
        lockedSnapshotId: loaded.snapshotId,
        snapshotId: loaded.snapshotId,
        evidences: loaded.evidence,
        evidence: loaded.evidence,
        coverage: loaded.coverage,
        materialsStatus: {
          state: loaded.evidence.length > 0 ? 'loaded' : 'empty',
          source: loaded.evidence.length > 0 ? 'collection' : 'none',
          count: loaded.evidence.length,
          lockedSnapshotId: loaded.snapshotId,
          message: `已锁定快照并载入 ${loaded.evidence.length} 条已授权个人材料。`,
        },
      };
    },
    async readCollectionCandidates({
      snapshotId = null,
      keywords = [],
      dataMode: reqMode = mode,
      usePersonalMaterials: reqUsePersonalMaterials = undefined,
      allowPersonalMaterials: reqAllowPersonalMaterials = undefined,
      includeBody = defaultIncludeBody,
      bodyMaxChars = defaultBodyMaxChars,
      summaryMaxChars = defaultSummaryMaxChars,
      deniedAttributions = [],
      signal,
    } = {}) {
      if (reqMode && reqMode !== mode) {
        throw new BackendServiceError('DATA_MODE_MISMATCH', '数据模式不匹配。', 403);
      }
      if (isPersonalBlocked(reqUsePersonalMaterials, reqAllowPersonalMaterials)) {
        return { snapshotId: null, items: [], status: 'disabled', errorCode: null };
      }
      const caller = await resolveToolCaller('zhihu_knowledge_profile');
      const loaded = await loadAuthorizedCollectionMaterials({
        callTool: caller,
        lockedSnapshotId: snapshotId,
        summaryMaxChars,
        includeBody,
        bodyMaxChars,
        deniedAttributions,
        signal,
      });
      if (loaded.status !== 'ok') return { items: [], status: loaded.status, errorCode: loaded.errorCode };
      const kws = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
      const filtered = kws.length === 0
        ? loaded.evidence
        : loaded.evidence.filter((ev) =>
            kws.some((kw) => `${ev.title} ${ev.excerpt}`.toLowerCase().includes(kw.toLowerCase())),
          );
      return { snapshotId: loaded.snapshotId, items: filtered };
    },
    async searchPublicEvidence({
      query = '',
      queries = null,
      sentence = '',
      focus = null,
      keywords = [],
      plannedQueries = null,
      maxQueries = 2,
      limit = 6,
      dataMode: reqMode = mode,
      signal,
    } = {}) {
      if (reqMode && reqMode !== mode) {
        throw new BackendServiceError('DATA_MODE_MISMATCH', '数据模式不匹配。', 403);
      }
      const caller = await resolveToolCaller('zhihu_search');
      const sentenceSeed = [
        sentence || query,
        ...(Array.isArray(keywords) ? keywords : []),
      ].filter(Boolean).join(' ');
      const effectivePlannedQueries = Array.isArray(plannedQueries) && plannedQueries.length > 0
        ? plannedQueries
        : (Array.isArray(queries) && queries.length > 0 ? queries : null);
      const res = await searchGapMaterials({
        callTool: caller,
        sentence: sentenceSeed,
        focus,
        plannedQueries: effectivePlannedQueries,
        maxQueries,
        limit,
        forceSearch: true,
        signal,
      });
      if (res.status === 'not_configured') {
        return {
          ok: false,
          status: 'not_configured',
          items: [],
          requestIds: res.requestIds,
          plannedQueries: res.plannedQueries,
          message: res.message,
          error: { code: 'NOT_CONFIGURED', message: res.message },
        };
      }
      if (res.status === 'rate_limited') {
        return {
          ok: false,
          status: 'rate_limited',
          items: res.evidence,
          requestIds: res.requestIds,
          plannedQueries: res.plannedQueries,
          message: res.message,
          error: { code: 'RATE_LIMITED', message: res.message },
        };
      }
      if (res.status === 'timeout') {
        return {
          ok: false,
          status: 'timeout',
          items: res.evidence,
          requestIds: res.requestIds,
          plannedQueries: res.plannedQueries,
          message: res.message,
          error: { code: res.errorCode || 'TIMEOUT', message: res.message },
        };
      }
      if (res.status === 'auth_error') {
        throw new BackendServiceError('UPSTREAM_AUTH', res.message || '公开搜索鉴权未通过。', 502);
      }
      if (res.status === 'error') {
        return {
          ok: false,
          status: 'error',
          items: res.evidence,
          requestIds: res.requestIds,
          plannedQueries: res.plannedQueries,
          message: res.message,
          error: { code: res.errorCode || 'INTERNAL_ERROR', message: res.message },
        };
      }
      return {
        ok: true,
        status: res.status,
        items: res.evidence,
        requestIds: res.requestIds,
        plannedQueries: res.plannedQueries,
        message: res.message,
      };
    },
  };
}

export const createMaterialLoader = createMaterialsAdapter;
