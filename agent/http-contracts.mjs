// `/v1` HTTP/SSE 接口入参契约校验（基于 zod/v4 严格模式，拒绝未知字段）。
import * as z from 'zod/v4';
import {
  BackendServiceError,
  DATA_MODES,
  TURN_INTENTS,
} from './protocol.mjs';

export const STATEMENT_ROLES = Object.freeze([
  'original',
  'rewrite_tone',
  'rewrite_scope',
  'rewrite',
]);

export const focusRefSchema = z.object({
  spanText: z.string().min(1).max(200).optional(),
  startOffset: z.number().int().min(0).optional(),
  endOffset: z.number().int().min(1).optional(),
  nodeId: z.string().min(1).max(128).optional(),
}).strict().refine(
  (value) => value.startOffset === undefined || value.endOffset === undefined || value.endOffset > value.startOffset,
  { message: 'focusRef.endOffset 必须大于 startOffset。' },
);

export const turnActionSchema = z.object({
  type: z.enum(TURN_INTENTS),
  targetId: z.string().max(128).optional(),
  factId: z.string().max(128).optional(),
  statementRole: z.enum(STATEMENT_ROLES).optional(),
  adoptStatementId: z.string().max(128).optional(),
  proposal: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const createSessionBodySchema = z.object({
  dataMode: z.enum(DATA_MODES).optional(),
  snapshotId: z.string().min(1).max(128).optional(),
  usePersonalMaterials: z.boolean().optional(),
  cloudConsent: z.boolean().optional(),
  outboundPreviewId: z.string().trim().min(1).max(128).optional(),
  initialText: z.string().trim().min(1).max(2000).optional(),
  initialGraph: z.array(z.record(z.string(), z.unknown())).max(12000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const createTurnBodySchema = z.object({
  clientRequestId: z.string().trim().min(1).max(128),
  baseGraphVersion: z.number().int().min(0),
  text: z.string().trim().min(1).max(4000),
  focusRef: focusRefSchema.optional(),
  action: turnActionSchema.optional(),
  cloudConsent: z.boolean().optional(),
  outboundPreviewId: z.string().trim().min(1).max(128).optional(),
}).strict();

export const cancelTurnBodySchema = z.object({
  reason: z.string().trim().max(200).optional(),
}).strict().optional();

export const sessionQuerySchema = z.object({
  lookupId: z.string().trim().min(1).max(128).optional(),
}).strict();

export const pathIdSchema = z.string().trim().min(1).max(128).regex(
  /^[A-Za-z0-9_.:-]+$/,
  '路径标识符仅允许字母、数字及 _ . : - 字符。',
);

// 格式化首个校验问题路径，绝不回显原始输入文本或凭证值。
function formatZodIssue(issue) {
  const fieldPath = Array.isArray(issue?.path) && issue.path.length > 0
    ? issue.path.map(String).join('.')
    : null;
  if (issue?.code === 'unrecognized_keys' && Array.isArray(issue.keys) && issue.keys.length > 0) {
    const keys = issue.keys.slice(0, 5).map((key) => String(key).slice(0, 40)).join(', ');
    return {
      field: fieldPath,
      message: `请求包含未定义的字段（${keys}）。`,
    };
  }
  return {
    field: fieldPath,
    message: fieldPath
      ? `字段「${fieldPath}」格式或取值不符合接口契约。`
      : '请求参数结构不符合接口契约。',
  };
}

export function parseContract(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const first = result.error?.issues?.[0];
  const { field, message } = formatZodIssue(first);
  throw new BackendServiceError(
    'INVALID_ARGUMENTS',
    message,
    400,
    field ? { field } : null,
  );
}

export function parsePathId(rawValue, label = 'id') {
  let decoded = rawValue;
  try {
    decoded = decodeURIComponent(String(rawValue ?? ''));
  } catch {
    throw new BackendServiceError('INVALID_ARGUMENTS', `路径参数「${label}」编码无效。`, 400, { field: label });
  }
  const result = pathIdSchema.safeParse(decoded);
  if (!result.success) {
    throw new BackendServiceError('INVALID_ARGUMENTS', `路径参数「${label}」格式无效。`, 400, { field: label });
  }
  return result.data;
}

// 解析 Last-Event-ID：缺省返回 0；显式传入时必须是正整数序号，否则拒绝 400 INVALID_ARGUMENTS。
export function parseLastEventId(rawHeader) {
  if (rawHeader === undefined) return 0;
  const raw = Array.isArray(rawHeader) ? rawHeader.at(-1) : rawHeader;
  if (typeof raw !== 'string') {
    throw new BackendServiceError('INVALID_ARGUMENTS', 'Last-Event-ID 请求头格式无效。', 400, { field: 'Last-Event-ID' });
  }
  const trimmed = raw.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    throw new BackendServiceError(
      'INVALID_ARGUMENTS',
      'Last-Event-ID 必须是正整数事件序号。',
      400,
      { field: 'Last-Event-ID' },
    );
  }
  const seq = Number(trimmed);
  if (!Number.isSafeInteger(seq)) {
    throw new BackendServiceError(
      'INVALID_ARGUMENTS',
      'Last-Event-ID 超出安全整数范围。',
      400,
      { field: 'Last-Event-ID' },
    );
  }
  return seq;
}
