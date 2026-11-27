// 个人材料授权与模型端点位置共用判定策略（供新版 `/v1` 后端与旧工作台画像入口共同复用）。
import { createHash } from 'node:crypto';

export const AUTHORIZED_PERSONAL_FIELDS = Object.freeze([
  'contentId',
  'contentType',
  'title',
  'summary',
  'bodyText',
  'author',
  'url',
  'topics',
  'kinds',
  'signals',
]);

export const DEFAULT_OUTBOUND_MAX_ITEMS = 20;
export const DEFAULT_OUTBOUND_EXCERPT_CHARS = 160;
export const DEFAULT_OUTBOUND_TITLE_CHARS = 120;

const LOOPBACK_IPV4_RE = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const LOOPBACK_MAPPED_IPV4_RE = /^::ffff:127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/i;

export function isLoopbackHost(rawHost) {
  if (typeof rawHost !== 'string') return false;
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (LOOPBACK_IPV4_RE.test(host)) return true;
  if (LOOPBACK_MAPPED_IPV4_RE.test(host)) return true;
  return false;
}

export function sanitizeModelTargetOrigin(baseURL) {
  if (typeof baseURL !== 'string' || !baseURL.trim()) return null;
  try {
    const parsed = new URL(baseURL.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function classifyModelEndpoint(baseURL, modelConfig = null) {
  const effectiveUrl = typeof baseURL === 'string' && baseURL.trim()
    ? baseURL.trim()
    : (typeof modelConfig?.baseURL === 'string' && modelConfig.baseURL.trim() ? modelConfig.baseURL.trim() : null);

  const targetOrigin = sanitizeModelTargetOrigin(effectiveUrl);

  if (modelConfig?.isCloud === true) {
    return {
      baseURL: effectiveUrl,
      targetOrigin,
      configured: Boolean(effectiveUrl || modelConfig?.ready),
      isLocalModel: false,
      isLoopback: false,
      isCloudModel: true,
    };
  }

  if (modelConfig?.isLocal === true || modelConfig?.isLoopback === true) {
    return {
      baseURL: effectiveUrl,
      targetOrigin,
      configured: Boolean(effectiveUrl || modelConfig?.ready),
      isLocalModel: true,
      isLoopback: true,
      isCloudModel: false,
    };
  }

  if (!effectiveUrl) {
    return {
      baseURL: null,
      targetOrigin: null,
      configured: false,
      isLocalModel: true,
      isLoopback: true,
      isCloudModel: false,
    };
  }

  try {
    const parsed = new URL(effectiveUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        baseURL: effectiveUrl,
        targetOrigin: null,
        configured: false,
        isLocalModel: false,
        isLoopback: false,
        isCloudModel: true,
      };
    }
    const loopback = isLoopbackHost(parsed.hostname);
    return {
      baseURL: effectiveUrl,
      targetOrigin: parsed.origin,
      configured: true,
      isLocalModel: loopback,
      isLoopback: loopback,
      isCloudModel: !loopback,
    };
  } catch {
    return {
      baseURL: effectiveUrl,
      targetOrigin: null,
      configured: false,
      isLocalModel: false,
      isLoopback: false,
      isCloudModel: true,
    };
  }
}

export function isLoopbackModelEndpoint(baseURL, modelConfig = null) {
  return classifyModelEndpoint(baseURL, modelConfig).isLocalModel;
}

export function isLocalModelEndpoint(baseURL, modelConfig = null) {
  return classifyModelEndpoint(baseURL, modelConfig).isLocalModel;
}

/**
 * 旧工作台用户画像门禁（P0-B）：
 * - 手动刷新与全部自动触发（启动、同步完成、保存设置）统一走本门禁。
 * - 关闭个人材料授权时，立即拒绝（禁止读取记录、禁止调用模型）。
 * - 本轮旧工作台仅开放已授权的本机回环模型；非回环模型返回明确的未授权状态。
 */
export function evaluateLegacyProfileGate({ allowPersonalData = false, modelConfig = null, baseURL = null } = {}) {
  const endpoint = classifyModelEndpoint(baseURL ?? modelConfig?.baseURL ?? null, modelConfig);

  if (allowPersonalData !== true) {
    return {
      allowed: false,
      code: 'PERSONAL_DATA_DISABLED',
      httpStatus: 403,
      message: '未开启个人材料授权（allowPersonalData 为 false），已禁止读取个人采集记录与生成画像。',
      endpoint,
    };
  }

  if (!modelConfig?.ready) {
    return {
      allowed: false,
      code: 'MODEL_NOT_CONFIGURED',
      httpStatus: 503,
      message: '模型还没配置，无法生成画像。',
      endpoint,
    };
  }

  if (endpoint.isCloudModel || !endpoint.isLocalModel) {
    return {
      allowed: false,
      code: 'CLOUD_CONSENT_REQUIRED',
      httpStatus: 403,
      message: '旧工作台画像当前仅开放已授权的本机回环模型；非回环模型在具备显式同意与外发材料预览前不允许调用。',
      endpoint,
    };
  }

  return {
    allowed: true,
    code: 'OK',
    httpStatus: 200,
    message: null,
    endpoint,
  };
}

/**
 * 旧工作台已有画像外发边界策略（P0-B / F-B1）：
 * - 保留画像供本机展示与本机逻辑使用；
 * - 当旧交互或旧问答走向外部公开搜索（非 demo 本机合成检索）或非回环模型时，
 *   在未接入已确认外发清单（confirmedOutboundPreviewId）前，禁止把画像及衍生标签送入外部查询或模型提示词。
 */
export function evaluateLegacyProfileOutboundPolicy({
  allowPersonalData = false,
  modelConfig = null,
  baseURL = null,
  demoSearch = false,
  targetKind = 'interaction', // 'local_display' | 'external_search' | 'model' | 'interaction'
  confirmedOutboundPreviewId = null,
} = {}) {
  const endpoint = classifyModelEndpoint(baseURL ?? modelConfig?.baseURL ?? null, modelConfig);
  const hasConfirmedManifest = typeof confirmedOutboundPreviewId === 'string' && confirmedOutboundPreviewId.trim().length > 0;

  if (targetKind === 'local_display') {
    return {
      allowed: true,
      code: 'OK',
      reason: null,
      endpoint,
    };
  }

  if (allowPersonalData !== true) {
    return {
      allowed: false,
      code: 'PERSONAL_DATA_DISABLED',
      reason: '未开启个人材料授权（allowPersonalData 为 false），禁止在外部搜索或模型提示词中使用画像及其衍生标签。',
      endpoint,
    };
  }

  // 外部公开搜索（非 demo 本机检索）：未经已确认外发清单不得把画像衍生词句送往外部搜索。
  if (targetKind === 'external_search') {
    if (!demoSearch && !hasConfirmedManifest) {
      return {
        allowed: false,
        code: 'CLOUD_CONSENT_REQUIRED',
        reason: '未接入已确认外发清单前，禁止将用户画像衍生标签送入外部公开检索。',
        endpoint,
      };
    }
    return { allowed: true, code: 'OK', reason: null, endpoint };
  }

  // 非回环模型：未经已确认外发清单不得把画像内容或衍生词句送入模型提示词。
  if (endpoint.isCloudModel || !endpoint.isLocalModel) {
    if (!hasConfirmedManifest) {
      return {
        allowed: false,
        code: 'CLOUD_CONSENT_REQUIRED',
        reason: '当前为非回环模型，未经已确认外发清单禁止将用户画像或其衍生标签送入模型或外部检索。',
        endpoint,
      };
    }
  }

  // 综合交互入口（既调检索又调模型）：非 demo 外部搜索或非回环模型均需已确认清单。
  if (targetKind === 'interaction' && !demoSearch && !hasConfirmedManifest) {
    return {
      allowed: false,
      code: 'CLOUD_CONSENT_REQUIRED',
      reason: '旧交互走外部公开检索时，未经已确认外发清单禁止发送画像衍生词句，将改用通用议题。',
      endpoint,
    };
  }

  return {
    allowed: true,
    code: 'OK',
    reason: null,
    endpoint,
  };
}

/**
 * 按 Unicode 码点安全裁剪文本，确保预览与实际外发给模型的文本、范围与长度逐字符一致。
 */
export function clipByCodePoints(value, maxChars = DEFAULT_OUTBOUND_EXCERPT_CHARS) {
  const full = String(value ?? '');
  const chars = Array.from(full);
  const originalLength = chars.length;
  const limit = Number.isInteger(maxChars) && maxChars >= 0 ? maxChars : DEFAULT_OUTBOUND_EXCERPT_CHARS;
  if (originalLength <= limit) {
    return {
      text: full,
      start: 0,
      end: originalLength,
      originalLength,
      truncated: false,
    };
  }
  const clipped = chars.slice(0, limit).join('');
  return {
    text: clipped,
    start: 0,
    end: limit,
    originalLength,
    truncated: true,
  };
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function resolveSnippetSourceField(ev) {
  if (typeof ev?.field === 'string' && ev.field.trim()) return ev.field.trim();
  if (typeof ev?.locator?.field === 'string' && ev.locator.field.trim()) return ev.locator.field.trim();
  if (ev?.textKind === 'full_text' || ev?.textKind === 'partial_body') return 'bodyText';
  if (typeof ev?.bodyText === 'string' && ev.bodyText.trim() && !ev?.excerpt) return 'bodyText';
  if (typeof ev?.summary === 'string' && ev.summary.trim() && !ev?.excerpt) return 'summary';
  return 'excerpt';
}

function resolveSnippetRawText(ev) {
  if (typeof ev?.text === 'string' && ev.text.length > 0 && ev?.range && typeof ev.range.end === 'number') {
    return ev.text;
  }
  if (typeof ev?.excerpt === 'string') return ev.excerpt;
  if (typeof ev?.bodyText === 'string') return ev.bodyText;
  if (typeof ev?.summary === 'string') return ev.summary;
  return '';
}

/**
 * 将单条个人材料证据标准化并裁剪为拟外发清单条目。
 * 预览响应与实际模型提示词必须共用本条目的 evidenceId、source、range 与 text。
 */
export function normalizePersonalSnippetForOutbound(ev, index = 0, {
  maxExcerptChars = DEFAULT_OUTBOUND_EXCERPT_CHARS,
  maxTitleChars = DEFAULT_OUTBOUND_TITLE_CHARS,
  redact = (s) => String(s ?? ''),
} = {}) {
  const evidenceId = String(ev?.evidenceId ?? ev?.id ?? ev?.contentId ?? `item-${index + 1}`);
  const sourceType = String(ev?.sourceType ?? 'collection_record');
  const snapshotId = typeof ev?.snapshotId === 'string' && ev.snapshotId.trim() ? ev.snapshotId.trim() : null;
  const contentKey = typeof ev?.contentKey === 'string' && ev.contentKey.trim()
    ? ev.contentKey.trim()
    : (typeof ev?.contentId === 'string' && ev.contentId.trim() ? ev.contentId.trim() : null);
  const field = resolveSnippetSourceField(ev);
  const textKind = String(ev?.textKind ?? (field === 'bodyText' ? 'partial_body' : 'summary'));
  const behaviorKinds = Array.isArray(ev?.behaviorKinds)
    ? ev.behaviorKinds.map((k) => String(k)).filter(Boolean)
    : (Array.isArray(ev?.kinds) ? ev.kinds.map((k) => String(k)).filter(Boolean) : []);
  const url = typeof ev?.url === 'string' && ev.url.trim() ? ev.url.trim() : null;

  const cleanTitle = clipByCodePoints(redact(ev?.title ?? ''), maxTitleChars).text;
  const cleanAuthor = typeof ev?.author === 'string' && ev.author.trim() ? redact(ev.author.trim()) : null;
  const rawText = redact(resolveSnippetRawText(ev));
  const clipped = clipByCodePoints(rawText, maxExcerptChars);
  const originalLength = Number.isInteger(ev?.range?.originalLength)
    ? Math.max(ev.range.originalLength, clipped.originalLength)
    : clipped.originalLength;
  const range = {
    start: Number.isInteger(ev?.range?.start) ? ev.range.start : clipped.start,
    end: clipped.end,
    originalLength,
  };
  const truncated = Boolean(clipped.truncated || ev?.truncated || ev?.summaryTruncated || range.end < originalLength);

  const source = {
    sourceType,
    snapshotId,
    contentKey,
    field,
    behaviorKinds,
    url,
  };

  const digest = sha256Hex(JSON.stringify({
    evidenceId,
    sourceType,
    snapshotId,
    contentKey,
    field,
    range: { start: range.start, end: range.end },
    text: clipped.text,
  }));

  return {
    evidenceId,
    sourceType,
    snapshotId,
    contentKey,
    title: cleanTitle,
    author: cleanAuthor,
    attribution: ev?.attribution ?? 'other_author',
    source,
    field,
    textKind,
    range,
    truncated,
    charCount: clipped.end,
    originalCharCount: originalLength,
    text: clipped.text,
    excerpt: clipped.text,
    preview: clipped.text,
    digest,
  };
}

export function computeOutboundPreviewId({
  targetOrigin = null,
  modelName = null,
  items = [],
} = {}) {
  const canonicalItems = (Array.isArray(items) ? items : []).map((item) => ({
    evidenceId: String(item?.evidenceId ?? ''),
    sourceType: String(item?.sourceType ?? 'collection_record'),
    snapshotId: item?.snapshotId ?? item?.source?.snapshotId ?? null,
    contentKey: item?.contentKey ?? item?.source?.contentKey ?? null,
    field: item?.field ?? item?.source?.field ?? 'excerpt',
    range: {
      start: Number.isInteger(item?.range?.start) ? item.range.start : 0,
      end: Number.isInteger(item?.range?.end) ? item.range.end : Array.from(String(item?.text ?? item?.excerpt ?? '')).length,
    },
    text: String(item?.text ?? item?.excerpt ?? item?.preview ?? ''),
  }));
  const digest = sha256Hex(JSON.stringify({
    v: 1,
    targetOrigin: targetOrigin ?? null,
    modelName: modelName ?? null,
    items: canonicalItems,
  }));
  return `opv_${digest.slice(0, 24)}`;
}

/**
 * 构建新版 `/v1` 统一拟外发个人材料预览清单（含确定性 outboundPreviewId）。
 */
export function buildOutboundPersonalManifest({
  modelConfig = null,
  usePersonalMaterials = false,
  cloudConsent = false,
  evidences = [],
  snapshotId = null,
  maxItems = DEFAULT_OUTBOUND_MAX_ITEMS,
  maxExcerptChars = DEFAULT_OUTBOUND_EXCERPT_CHARS,
  maxTitleChars = DEFAULT_OUTBOUND_TITLE_CHARS,
  redact = (s) => String(s ?? ''),
  confirmedOutboundPreviewId = null,
} = {}) {
  const endpoint = classifyModelEndpoint(modelConfig?.baseURL ?? null, modelConfig);
  const rawList = Array.isArray(evidences) ? evidences : [];
  const personalOnly = usePersonalMaterials
    ? rawList.filter((item) => !item?.sourceType || item.sourceType === 'collection_record')
    : [];

  const seen = new Set();
  const deduped = [];
  for (const item of personalOnly) {
    const id = String(item?.evidenceId ?? item?.id ?? item?.contentId ?? '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    deduped.push(item);
    if (deduped.length >= maxItems) break;
  }

  const resolvedSnapshotId = typeof snapshotId === 'string' && snapshotId.trim()
    ? snapshotId.trim()
    : (deduped.find((item) => typeof item?.snapshotId === 'string' && item.snapshotId.trim())?.snapshotId?.trim() ?? null);

  const items = deduped.map((ev, idx) => normalizePersonalSnippetForOutbound(
    resolvedSnapshotId && !ev?.snapshotId ? { ...ev, snapshotId: resolvedSnapshotId } : ev,
    idx,
    {
      maxExcerptChars,
      maxTitleChars,
      redact,
    },
  ));

  const outboundPreviewId = computeOutboundPreviewId({
    targetOrigin: endpoint.targetOrigin,
    modelName: modelConfig?.modelName ?? null,
    items,
  });

  const normalizedConfirmedId = typeof confirmedOutboundPreviewId === 'string' && confirmedOutboundPreviewId.trim()
    ? confirmedOutboundPreviewId.trim()
    : null;

  return {
    outboundPreviewId,
    confirmedOutboundPreviewId: normalizedConfirmedId,
    previewConfirmed: Boolean(cloudConsent && items.length > 0 && normalizedConfirmedId && normalizedConfirmedId === outboundPreviewId),
    snapshotId: resolvedSnapshotId,
    lockedSnapshotId: resolvedSnapshotId,
    providerName: modelConfig?.providerName ?? 'openai-compatible',
    modelName: modelConfig?.modelName ?? null,
    targetOrigin: endpoint.targetOrigin,
    isLocalModel: endpoint.isLocalModel,
    isCloudModel: endpoint.isCloudModel,
    cloudConsentGranted: Boolean(cloudConsent),
    personalMaterialsEnabled: Boolean(usePersonalMaterials),
    authorizedFields: usePersonalMaterials ? [...AUTHORIZED_PERSONAL_FIELDS] : [],
    snippetCount: items.length,
    snippetPreview: items,
    items,
  };
}

/**
 * 校验某批个人片段是否与已确认的拟外发清单逐项一致（evidenceId、source/field、range、text 全部匹配）。
 */
export function verifyOutboundSnippetsMatchManifest(snippets = [], manifest = null) {
  if (!manifest || !Array.isArray(manifest.items)) return false;
  const approvedById = new Map(manifest.items.map((item) => [item.evidenceId, item]));
  for (const ev of Array.isArray(snippets) ? snippets : []) {
    if (ev?.sourceType && ev.sourceType !== 'collection_record') continue;
    const evidenceId = String(ev?.evidenceId ?? ev?.id ?? '');
    const approved = approvedById.get(evidenceId);
    if (!approved) return false;
    const text = String(ev?.text ?? ev?.excerpt ?? ev?.preview ?? '');
    if (text !== approved.text) return false;
    const field = resolveSnippetSourceField(ev);
    if (field !== approved.field) return false;
    if (ev?.range) {
      if (ev.range.start !== approved.range.start || ev.range.end !== approved.range.end) return false;
    }
  }
  return true;
}
