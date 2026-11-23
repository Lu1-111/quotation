// 智能体模块的统一错误与返回外层，其他文件只从这里取，不各自定义。
export const ERROR_CODES = Object.freeze(['CONFIG_INVALID', 'MODEL_NOT_CONFIGURED', 'NO_TOOLS_ENABLED', 'MCP_START_FAILED', 'STEP_LIMIT', 'TIMEOUT', 'CANCELLED', 'MODEL_ERROR', 'CLOSED', 'INVALID_ARGUMENTS', 'INTERNAL_ERROR']);

export class AgentError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export const fail = (code, message, exitCode) => { throw new AgentError(code, message, exitCode); };
export const okEnvelope = (data) => ({ schemaVersion: 1, ok: true, data, error: null });
export const errorEnvelope = (error) => ({ schemaVersion: 1, ok: false, data: null, error: { code: error.code, message: error.message } });

// 把任意异常转成可展示的 AgentError；消息固定为中文短句，不回显上游响应体、密钥或堆栈。
export function safeAgentError(error, signal) {
  if (error instanceof AgentError) return error;
  if (signal?.reason?.name === 'TimeoutError' || error?.name === 'TimeoutError') return new AgentError('TIMEOUT', '智能体执行超时，已中止。', 1);
  if (signal?.aborted || error?.name === 'AbortError') return new AgentError('CANCELLED', '智能体已取消，未完成的回答不会保存。', 130);
  if (error?.name === 'AI_APICallError') {
    const status = Number.isInteger(error.statusCode) ? `（HTTP ${error.statusCode}）` : '';
    return new AgentError('MODEL_ERROR', `模型服务请求失败${status}，请检查地址、模型名与密钥。`, 1);
  }
  return new AgentError('INTERNAL_ERROR', '智能体内部处理失败，请检查配置、依赖与本机环境。', 1);
}
