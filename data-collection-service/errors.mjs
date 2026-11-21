export class ServiceError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function invalid(message = '请求参数无效。') { return new ServiceError('INVALID_ARGUMENTS', message); }
export function safeError(error) {
  return error instanceof ServiceError ? error : new ServiceError('INTERNAL_ERROR', '服务处理失败，请检查服务端运行状态。', 500);
}
