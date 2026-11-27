// 后端共享协议常量与结构契约（供 quotation-engine 与 agent 各子模块对齐，无第三方运行依赖）。

export const PROTOCOL_VERSION = 'quotation-backend/v1';

export const DATA_MODES = Object.freeze(['demo', 'real']);

export const ASSESSMENTS = Object.freeze([
  'conflict',
  'compatible',
  'insufficient_evidence',
]);

export const EVIDENCE_SOURCE_TYPES = Object.freeze([
  'collection_record',
  'public_search',
  'session_turn',
]);

export const ATTRIBUTIONS = Object.freeze([
  'self',
  'other_author',
]);

export const FOCUS_KINDS = Object.freeze([
  'quantifier',
  'scope',
  'premise',
  'dependency',
]);

export const TURN_INTENTS = Object.freeze([
  'analyze_statement',
  'explain_focus_or_provenance',
  'deny_attribution',
  'provide_self_fact',
  'check_or_confirm_condition',
  'compare_rewrite',
  'retract_fact',
  'converge',
]);

export const TURN_STATUSES = Object.freeze([
  'running',
  'committed',
  'cancelled',
  'interrupted',
  'failed',
]);

export const SSE_EVENT_TYPES = Object.freeze([
  'turn.started',
  'focus.selected',
  'stage.changed',
  'evidence.verified',
  'text.delta',
  'turn.committed',
  'turn.cancelled',
  'turn.failed',
  'turn.done',
]);

export const SERVICE_ERROR_CODES = Object.freeze([
  'INVALID_JSON',
  'CONTENT_TYPE',
  'BODY_TOO_LARGE',
  'INVALID_ARGUMENTS',
  'HOST_DENIED',
  'ORIGIN_DENIED',
  'UNAUTHORIZED',
  'TOKEN_REVOKED',
  'SESSION_FORBIDDEN',
  'DATA_MODE_MISMATCH',
  'CLOUD_CONSENT_REQUIRED',
  'SESSION_NOT_FOUND',
  'TURN_NOT_FOUND',
  'CLIENT_REQUEST_ID_CONFLICT',
  'TURN_IN_PROGRESS',
  'STALE_GRAPH_VERSION',
  'RATE_LIMITED',
  'UPSTREAM_AUTH',
  'MODEL_NOT_CONFIGURED',
  'MODEL_ERROR',
  'TIMEOUT',
  'CANCELLED',
  'VERIFICATION_REJECTED',
  'INTERNAL_ERROR',
]);

export const RATE_INTERPRETATION_NOTE =
  '数值仅解释当前已确认图上的承重结构影响比例，不能作为授权者会被说服的概率。';

export class BackendServiceError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'BackendServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function apiOk(data) {
  return {
    schemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    ok: true,
    data,
    error: null,
  };
}

export function apiError(code, message, details = null) {
  return {
    schemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    ok: false,
    data: null,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}
