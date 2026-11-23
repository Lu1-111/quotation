// 智能体引擎：惰性连接 MCP 服务器，用 AI SDK 的 generateText 做多步工具调用。
//
// 已核对的 ai 7.0.179 与 @ai-sdk/openai-compatible 3.0.94 源码结论：
// - ai 导出 generateText、isStepCount、tool；测试用的 mock 模型在 'ai/test'（MockLanguageModelV4）。
// - timeout 为对象时支持 totalMs、stepMs、toolMs、tools（键为工具名加 Ms，例如 zhihu_collection_syncMs），
//   firstChunkMs 与 chunkMs 只对流式生效，这里不用。
// - stepMs 覆盖一步的全过程（模型生成、重试、本地工具执行），所以放宽同步工具时必须同时放宽 stepMs。
// - createOpenAICompatible({ name, baseURL, apiKey?, headers?, fetch? ... }) 返回 provider，用 chatModel(模型名) 取聊天模型；
//   apiKey 缺省时不加 Authorization 头，适合本地服务。
import { generateText, isStepCount } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { AgentError, safeAgentError } from './errors.mjs';
import { connectServers } from './mcp-servers.mjs';

const SYNC_TOOL = 'zhihu_collection_sync';

// 由 limits 生成 SDK 的 timeout 对象；只有连上了同步工具时才放宽。
// SDK 支持按工具覆盖（tools），但 stepMs 仍会把整步截断，所以 stepMs 同时取 collectionSyncMs 与 stepMs 中较大的值。
// 注意：totalMs 不随之放宽（契约未要求），若 totalMs 小于同步耗时，总超时会先生效。
export function buildTimeout(limits, toolNames = []) {
  const timeout = {};
  if (Number.isFinite(limits?.totalMs)) timeout.totalMs = limits.totalMs;
  if (Number.isFinite(limits?.stepMs)) timeout.stepMs = limits.stepMs;
  if (toolNames.includes(SYNC_TOOL) && Number.isFinite(limits?.collectionSyncMs)) {
    timeout.stepMs = Math.max(timeout.stepMs ?? 0, limits.collectionSyncMs);
    timeout.tools = { [`${SYNC_TOOL}Ms`]: limits.collectionSyncMs };
  }
  return timeout;
}

function createDefaultModel(modelConfig) {
  const provider = createOpenAICompatible({
    name: modelConfig.providerName ?? 'openai-compatible',
    baseURL: modelConfig.baseURL,
    apiKey: modelConfig.apiKey ?? undefined,
  });
  return provider.chatModel(modelConfig.modelName);
}

// 提示词由 prompt.mjs 提供；懒加载使引擎测试不依赖该文件，测试可通过 buildPrompt 注入。
async function defaultBuildPrompt(args) {
  const { buildSystemPrompt } = await import('./prompt.mjs');
  return buildSystemPrompt(args);
}

// 历史只保留文本，且返回新对象，不触碰调用方传入的数组与元素。
function normalizeHistory(history) {
  if (!Array.isArray(history)) throw new AgentError('INVALID_ARGUMENTS', 'history 必须是数组。', 2);
  return history.map((item) => {
    if ((item?.role !== 'user' && item?.role !== 'assistant') || typeof item.content !== 'string') {
      throw new AgentError('INVALID_ARGUMENTS', 'history 的每一项必须是 role 为 user 或 assistant、content 为字符串的对象。', 2);
    }
    return { role: item.role, content: item.content };
  });
}

// 上游 5xx、429 重试耗尽后会被包成 AI_RetryError，取出最后一次真实错误再分类。
function unwrapRetryError(error) {
  return error?.name === 'AI_RetryError' && error.lastError ? error.lastError : error;
}

export function createAgent(config, { connect = connectServers, model, buildPrompt = defaultBuildPrompt } = {}) {
  let closed = false;
  let connecting = null;
  let connection = null;
  let closing = null;
  let resolvedModel = model ?? null;

  // 惰性且复用：首次 ask 才连接；连接失败时清空缓存，允许下次重试。
  function connectOnce(signal) {
    connecting ??= Promise.resolve(connect(config, { signal })).then((result) => {
      if (closed) {
        Promise.resolve(result.close()).catch(() => {});
        throw new AgentError('CLOSED', '智能体已关闭，不能再提问。', 1);
      }
      connection = result;
      return result;
    }, (error) => {
      connecting = null;
      throw error;
    });
    return connecting;
  }

  async function ask(question, { history = [], signal } = {}) {
    if (closed) throw new AgentError('CLOSED', '智能体已关闭，不能再提问。', 1);
    if (typeof question !== 'string' || question.trim() === '') throw new AgentError('INVALID_ARGUMENTS', '问题不能为空。', 2);
    const prior = normalizeHistory(history);
    try {
      if (!resolvedModel) {
        // 注入的 model 视为已就绪；否则必须有 baseURL 与模型名，先于连接检查，避免白白启动子进程。
        if (!config.model?.ready) throw new AgentError('MODEL_NOT_CONFIGURED', '尚未配置模型：请设置 AGENT_BASE_URL 与 AGENT_MODEL。', 3);
        resolvedModel = createDefaultModel(config.model);
      }
      signal?.throwIfAborted();
      const active = await connectOnce(signal);
      const instructions = await buildPrompt({ enabled: active.enabled });
      const result = await generateText({
        model: resolvedModel,
        instructions,
        messages: [...prior, { role: 'user', content: question }],
        tools: active.tools,
        stopWhen: isStepCount(config.limits.maxSteps),
        timeout: buildTimeout(config.limits, Object.keys(active.tools)),
        abortSignal: signal,
      });
      // 步数用尽时最后一步仍在请求工具，没有最终回答：抛错而不是返回空文本。
      const last = result.steps.at(-1);
      if (last && (last.finishReason === 'tool-calls' || last.toolCalls?.length > 0)) {
        throw new AgentError('STEP_LIMIT', `已达到 ${config.limits.maxSteps} 步上限仍未得出回答，请缩小问题范围或调大 AGENT_MAX_STEPS。`, 1);
      }
      const text = result.text;
      return {
        text,
        stepCount: result.steps.length,
        toolCalls: result.steps.flatMap((step) => step.toolCalls.map((call) => ({ name: call.toolName }))),
        history: [...prior, { role: 'user', content: question }, { role: 'assistant', content: text }],
      };
    } catch (error) {
      throw safeAgentError(unwrapRetryError(error), signal);
    }
  }

  // 幂等：重复调用返回同一个 Promise；连接还在建立时会等它完成后再关闭。
  function close() {
    closed = true;
    closing ??= (async () => {
      if (!connecting) return;
      try {
        const active = await connecting;
        await active.close();
      } catch { /* 连接失败或已关闭，无需再处理 */ }
    })();
    return closing;
  }

  return {
    ask,
    close,
    // 连上之后是实际连上的服务器 id；连接前是配置里已启用的服务器 id。
    get enabled() {
      return connection ? [...connection.enabled] : (config.servers ?? []).filter((server) => server.enabled).map((server) => server.id);
    },
  };
}
