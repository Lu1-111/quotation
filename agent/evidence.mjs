// 固定证据来源、归属主体隔离、摘要去重与否认归属持久化。
import { BackendServiceError } from './protocol.mjs';

const ALLOWED_BEHAVIOR_KINDS = new Set(['history', 'likes', 'collections']);

function sanitizeIdSegment(value) {
  const cleaned = String(value ?? 'unknown')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'unknown';
}

export function normalizeTextForDedup(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBehaviorKinds(rawKinds, fallbackKind = null) {
  const source = Array.isArray(rawKinds)
    ? rawKinds
    : (fallbackKind ? [fallbackKind] : []);
  const seen = new Set();
  const result = [];
  for (const kind of source) {
    if (typeof kind === 'string' && ALLOWED_BEHAVIOR_KINDS.has(kind) && !seen.has(kind)) {
      seen.add(kind);
      result.push(kind);
    }
  }
  return result;
}

function normalizeQuerySource(queries) {
  if (!Array.isArray(queries)) return null;
  const cleaned = [...new Set(
    queries
      .filter((q) => typeof q === 'string')
      .map((q) => q.trim())
      .filter(Boolean),
  )];
  return cleaned.length > 0 ? cleaned : null;
}

function cloneEvidence(ev) {
  return {
    ...ev,
    behaviorKinds: Array.isArray(ev.behaviorKinds) ? [...ev.behaviorKinds] : [],
    querySource: Array.isArray(ev.querySource) ? [...ev.querySource] : null,
    locator: ev.locator ? { ...ev.locator } : { field: 'excerpt', startOffset: 0, endOffset: 0 },
    denialRecord: ev.denialRecord ? { ...ev.denialRecord } : null,
  };
}

// 个人采集记录规范化：阅读、点赞、收藏行为一律与原作者分离（默认 attribution: 'other_author'）。
export function normalizeCollectionRecordToEvidence(
  record,
  { snapshotId = null, verifiedSelfAuthored = false } = {},
) {
  if (!record || typeof record !== 'object') {
    throw new BackendServiceError('INVALID_ARGUMENTS', '采集记录必须是有效对象。', 400);
  }
  const contentType = String(record.contentType ?? 'unknown').trim() || 'unknown';
  const contentId = String(record.contentId ?? '').trim();
  if (!contentId) {
    throw new BackendServiceError('INVALID_ARGUMENTS', '采集记录缺少 contentId。', 400);
  }

  const contentKey = `${contentType}:${contentId}`;
  const id = `ev_col_${sanitizeIdSegment(contentType)}_${sanitizeIdSegment(contentId)}`;
  const resolvedSnapshotId = snapshotId ?? record.snapshotId ?? null;
  const summary = String(record.summary ?? '');
  const hasReturnedBody = typeof record.bodyText === 'string' && record.bodyText.trim().length > 0;

  let excerpt;
  let field;
  let textKind;
  let bodyStatus;
  let fullTextAvailable;
  let truncated;
  let bodyChars = Number.isInteger(record.bodyChars) ? record.bodyChars : null;

  if (hasReturnedBody) {
    excerpt = record.bodyText.trim();
    field = 'bodyText';
    const returnedBodyChars = [...record.bodyText].length;
    if (bodyChars === null) bodyChars = returnedBodyChars;
    const isPartialOrClipped = Boolean(
      record.bodyStatus === 'partial'
      || record.bodyTruncated === true
      || (Number.isInteger(record.bodyChars) && record.bodyChars > returnedBodyChars),
    );
    if (isPartialOrClipped) {
      textKind = 'partial_body';
      truncated = true;
      fullTextAvailable = false;
      bodyStatus = record.bodyStatus === 'partial'
        ? 'partial'
        : (record.bodyStatus === 'available' ? 'available' : 'partial');
    } else if (record.bodyStatus === 'available') {
      textKind = 'full_text';
      truncated = false;
      fullTextAvailable = true;
      bodyStatus = 'available';
    } else {
      textKind = 'partial_body';
      truncated = true;
      fullTextAvailable = false;
      bodyStatus = record.bodyStatus || 'partial';
    }
  } else {
    excerpt = summary;
    field = 'summary';
    textKind = 'summary';
    truncated = Boolean(record.summaryTruncated);
    fullTextAvailable = false;
    bodyStatus = record.bodyStatus === 'available' || record.bodyStatus === 'partial'
      ? record.bodyStatus
      : 'unavailable';
  }

  const url = typeof record.url === 'string' && record.url.trim() ? record.url.trim() : null;

  // 严格主体隔离：即使在收藏夹或点赞中，除非明确标注本人创作且经宿主核验，绝不归为 self。
  const isVerifiedSelf = Boolean(verifiedSelfAuthored === true && record.isSelfAuthored === true);
  const author = typeof record.author === 'string' && record.author.trim()
    ? record.author.trim()
    : '未知作者';

  return {
    id,
    sourceType: 'collection_record',
    contentKey,
    title: String(record.title ?? '').trim(),
    author: isVerifiedSelf ? 'self' : author,
    attribution: isVerifiedSelf ? 'self' : 'other_author',
    behaviorKinds: normalizeBehaviorKinds(record.kinds, record.kind),
    excerpt,
    summary,
    ...(bodyChars !== null ? { bodyChars } : {}),
    textKind,
    bodyStatus,
    fullTextAvailable,
    truncated,
    url,
    querySource: null,
    snapshotId: resolvedSnapshotId,
    requestId: null,
    turnId: null,
    locator: {
      field,
      startOffset: 0,
      endOffset: excerpt.length,
      ...(resolvedSnapshotId ? { snapshotId: resolvedSnapshotId } : {}),
      ...(url ? { url } : {}),
    },
    contentTrust: 'external_untrusted',
    deniedAsSelf: false,
    denialRecord: null,
  };
}

// 公开搜索条目规范化：固定 sourceType: 'public_search'，attribution: 'other_author'，textKind: 'excerpt'，fullTextAvailable: false。
export function normalizeSearchItemToEvidence(item, { requestId = null } = {}) {
  if (!item || typeof item !== 'object') {
    throw new BackendServiceError('INVALID_ARGUMENTS', '公开搜索条目必须是有效对象。', 400);
  }
  const contentType = String(item.contentType ?? 'unknown').trim() || 'unknown';
  const contentId = String(item.contentId ?? '').trim();
  const contentKey = contentId
    ? `${contentType}:${contentId}`
    : String(item.key ?? 'unknown').trim() || 'unknown';
  const id = `ev_sch_${sanitizeIdSegment(contentType)}_${sanitizeIdSegment(contentId || contentKey)}`;
  const resolvedRequestId = requestId ?? item.requestId ?? null;
  const excerpt = String(item.excerpt ?? item.summary ?? '');
  const url = (typeof item.canonicalUrl === 'string' && item.canonicalUrl.trim())
    || (typeof item.url === 'string' && item.url.trim())
    || null;
  const author = typeof item.author === 'string' && item.author.trim()
    ? item.author.trim()
    : '未知作者';

  return {
    id,
    sourceType: 'public_search',
    contentKey,
    title: String(item.title ?? '').trim(),
    author,
    attribution: 'other_author',
    behaviorKinds: [],
    excerpt,
    textKind: 'excerpt',
    bodyStatus: 'unavailable',
    fullTextAvailable: false,
    truncated: Boolean(item.excerptTruncated ?? item.truncated ?? false),
    url,
    querySource: normalizeQuerySource(item.matchedQueries),
    snapshotId: null,
    requestId: resolvedRequestId,
    turnId: null,
    locator: {
      field: 'excerpt',
      startOffset: 0,
      endOffset: excerpt.length,
      ...(resolvedRequestId ? { requestId: resolvedRequestId } : {}),
      ...(url ? { url } : {}),
    },
    contentTrust: 'external_untrusted',
    deniedAsSelf: false,
    denialRecord: null,
  };
}

// 本人会话发言证据：固定 author: 'self', attribution: 'self'，精确记录原文起止偏移与 turnId。
export function createSessionTurnEvidence({
  sessionId = null,
  turnId,
  text,
  spanText = null,
  startOffset = null,
  endOffset = null,
  title = null,
} = {}) {
  if (typeof turnId !== 'string' || !turnId.trim()) {
    throw new BackendServiceError('INVALID_ARGUMENTS', '创建会话证据必须提供非空 turnId。', 400);
  }
  if (typeof text !== 'string' || text.length === 0) {
    throw new BackendServiceError('INVALID_ARGUMENTS', '创建会话证据必须提供非空发言文本。', 400);
  }
  const cleanTurnId = turnId.trim();
  let resolvedStart = 0;
  let resolvedEnd = text.length;

  if (Number.isInteger(startOffset) && Number.isInteger(endOffset)) {
    if (startOffset < 0 || endOffset > text.length || startOffset >= endOffset) {
      throw new BackendServiceError('INVALID_ARGUMENTS', '会话证据偏移范围无效。', 400);
    }
    if (typeof spanText === 'string' && text.slice(startOffset, endOffset) !== spanText) {
      throw new BackendServiceError('INVALID_ARGUMENTS', '会话证据 spanText 与偏移切片不一致。', 400);
    }
    resolvedStart = startOffset;
    resolvedEnd = endOffset;
  } else if (typeof spanText === 'string' && spanText.length > 0) {
    const idx = text.indexOf(spanText);
    if (idx < 0) {
      throw new BackendServiceError('INVALID_ARGUMENTS', '指定的会话片段不在当前轮次文本中。', 400);
    }
    resolvedStart = idx;
    resolvedEnd = idx + spanText.length;
  }

  const slice = text.slice(resolvedStart, resolvedEnd);
  const isWholeTurn = resolvedStart === 0 && resolvedEnd === text.length;
  const id = isWholeTurn
    ? `ev_turn_${sanitizeIdSegment(cleanTurnId)}`
    : `ev_turn_${sanitizeIdSegment(cleanTurnId)}_${resolvedStart}_${resolvedEnd}`;
  const contentKey = isWholeTurn
    ? `turn:${cleanTurnId}`
    : `turn:${cleanTurnId}:${resolvedStart}-${resolvedEnd}`;

  return {
    id,
    sourceType: 'session_turn',
    contentKey,
    title: title ?? `会话轮次 ${cleanTurnId} 本人发言`,
    author: 'self',
    attribution: 'self',
    behaviorKinds: [],
    excerpt: slice,
    textKind: 'user_utterance',
    bodyStatus: 'session',
    fullTextAvailable: true,
    truncated: false,
    url: null,
    querySource: null,
    snapshotId: null,
    requestId: null,
    turnId: cleanTurnId,
    locator: {
      field: 'user_utterance',
      startOffset: resolvedStart,
      endOffset: resolvedEnd,
      turnId: cleanTurnId,
      ...(sessionId ? { sessionId } : {}),
    },
    contentTrust: 'session_user',
    deniedAsSelf: false,
    denialRecord: null,
  };
}

function textKindRank(kind) {
  if (kind === 'full_text' || kind === 'user_utterance') return 3;
  if (kind === 'partial_body') return 2;
  return 1;
}

function mergeTwoEvidenceItems(primary, incoming) {
  const mergedBehaviors = normalizeBehaviorKinds([
    ...(primary.behaviorKinds ?? []),
    ...(incoming.behaviorKinds ?? []),
  ]);
  const mergedQueries = normalizeQuerySource([
    ...(primary.querySource ?? []),
    ...(incoming.querySource ?? []),
  ]);

  // 若新命中项拥有更完整的正文（如 full_text 或更长的 partial_body），保留更完整文本同时维持稳定主 ID。
  const primaryRank = textKindRank(primary.textKind);
  const incomingRank = textKindRank(incoming.textKind);
  const preferIncomingBody = Boolean(
    incoming.excerpt
    && (
      incomingRank > primaryRank
      || (incomingRank === primaryRank && incoming.excerpt.length > (primary.excerpt?.length ?? 0))
    ),
  );
  const chosen = preferIncomingBody ? incoming : primary;
  const excerpt = chosen.excerpt;
  const textKind = chosen.textKind;
  const bodyStatus = chosen.bodyStatus;
  const fullTextAvailable = Boolean(chosen.fullTextAvailable);
  const truncated = Boolean(chosen.truncated);
  const summary = primary.summary ?? incoming.summary;
  const bodyChars = primary.bodyChars ?? incoming.bodyChars;

  return {
    ...primary,
    behaviorKinds: mergedBehaviors,
    querySource: mergedQueries,
    excerpt,
    ...(summary !== undefined ? { summary } : {}),
    ...(bodyChars !== undefined ? { bodyChars } : {}),
    textKind,
    bodyStatus,
    fullTextAvailable,
    truncated,
    url: primary.url ?? incoming.url ?? null,
    snapshotId: primary.snapshotId ?? incoming.snapshotId ?? null,
    requestId: primary.requestId ?? incoming.requestId ?? null,
    locator: {
      ...primary.locator,
      field: chosen.locator?.field ?? primary.locator?.field ?? 'excerpt',
      endOffset: excerpt.length,
    },
    deniedAsSelf: Boolean(primary.deniedAsSelf || incoming.deniedAsSelf),
    denialRecord: primary.denialRecord ?? incoming.denialRecord ?? null,
  };
}

// 按 contentKey 及规范化摘要文本去重：同一摘要重复命中只算一份证据，绝不跨 self/other_author 混并。
export function deduplicateEvidenceList(evidenceList = []) {
  if (!Array.isArray(evidenceList)) return [];
  const result = [];
  const indexByContentKey = new Map();
  const indexByExcerptKey = new Map();

  for (const rawItem of evidenceList) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = cloneEvidence(rawItem);
    const scopePrefix = item.sourceType === 'session_turn'
      ? `self:${item.turnId ?? ''}`
      : `ext:${item.attribution}`;
    const contentLookupKey = item.contentKey ? `${scopePrefix}|key:${item.contentKey}` : null;
    const normExcerpt = normalizeTextForDedup(item.excerpt);
    const excerptLookupKey = normExcerpt ? `${scopePrefix}|txt:${normExcerpt}` : null;

    const existingIdx = (contentLookupKey && indexByContentKey.has(contentLookupKey))
      ? indexByContentKey.get(contentLookupKey)
      : ((excerptLookupKey && indexByExcerptKey.has(excerptLookupKey))
          ? indexByExcerptKey.get(excerptLookupKey)
          : undefined);

    if (existingIdx !== undefined) {
      result[existingIdx] = mergeTwoEvidenceItems(result[existingIdx], item);
      if (contentLookupKey) indexByContentKey.set(contentLookupKey, existingIdx);
      if (excerptLookupKey) indexByExcerptKey.set(excerptLookupKey, existingIdx);
    } else {
      const idx = result.length;
      result.push(item);
      if (contentLookupKey) indexByContentKey.set(contentLookupKey, idx);
      if (excerptLookupKey) indexByExcerptKey.set(excerptLookupKey, idx);
    }
  }

  return result;
}

// 记录本人否认归属事实（不可变更新，供会话持久化保存）。
export function recordAttributionDenial(
  deniedAttributions = [],
  {
    contentKey = null,
    evidenceId = null,
    originalAuthor = null,
    turnId = null,
    reason = '本人明确指出该材料属于他人观点而非本人表达。',
    excerpt = null,
  } = {},
) {
  const cleanKey = typeof contentKey === 'string' && contentKey.trim() ? contentKey.trim() : null;
  const cleanEvId = typeof evidenceId === 'string' && evidenceId.trim() ? evidenceId.trim() : null;
  if (!cleanKey && !cleanEvId) {
    throw new BackendServiceError(
      'INVALID_ARGUMENTS',
      '记录归属否认至少需要提供 contentKey 或 evidenceId。',
      400,
    );
  }
  const entry = {
    contentKey: cleanKey,
    evidenceId: cleanEvId,
    originalAuthor: typeof originalAuthor === 'string' && originalAuthor.trim()
      ? originalAuthor.trim()
      : null,
    turnId: typeof turnId === 'string' && turnId.trim() ? turnId.trim() : null,
    reason: typeof reason === 'string' && reason.trim()
      ? reason.trim()
      : '本人明确指出该材料属于他人观点而非本人表达。',
    ...(typeof excerpt === 'string' && excerpt.trim()
      ? { normalizedExcerpt: normalizeTextForDedup(excerpt) }
      : {}),
  };

  const base = Array.isArray(deniedAttributions) ? deniedAttributions.map((d) => ({ ...d })) : [];
  const existingIndex = base.findIndex((item) =>
    (cleanKey && item.contentKey === cleanKey)
    || (cleanEvId && item.evidenceId === cleanEvId),
  );

  if (existingIndex >= 0) {
    base[existingIndex] = { ...base[existingIndex], ...entry };
    return base;
  }
  base.push(entry);
  return base;
}

// 套用历史否认归属：再次命中相同 contentKey、evidenceId 或相同外部摘要时保留纠正，严禁当作本人表达。
export function applyDeniedAttributions(evidenceList = [], deniedAttributions = []) {
  if (!Array.isArray(evidenceList)) return [];
  const denials = Array.isArray(deniedAttributions) ? deniedAttributions : [];
  if (denials.length === 0) return evidenceList.map(cloneEvidence);

  return evidenceList.map((rawEv) => {
    const ev = cloneEvidence(rawEv);
    if (ev.sourceType === 'session_turn') return ev;

    const normExcerpt = normalizeTextForDedup(ev.excerpt);
    const matched = denials.find((d) =>
      (d?.contentKey && ev.contentKey === d.contentKey)
      || (d?.evidenceId && ev.id === d.evidenceId)
      || (d?.normalizedExcerpt && normExcerpt && normExcerpt === d.normalizedExcerpt),
    );

    if (!matched) return ev;

    return {
      ...ev,
      author: ev.author && ev.author !== 'self'
        ? ev.author
        : (matched.originalAuthor ?? '未知作者'),
      attribution: 'other_author',
      deniedAsSelf: true,
      denialRecord: {
        contentKey: matched.contentKey ?? ev.contentKey,
        evidenceId: matched.evidenceId ?? ev.id,
        originalAuthor: matched.originalAuthor ?? ev.author,
        turnId: matched.turnId ?? null,
        reason: matched.reason ?? '本人已否认归属。',
      },
    };
  });
}
