// 连接两个 MCP 子进程（搜索、采集），并把它们的工具合并为一个 AI SDK 工具对象。
//
// 已核对的 @ai-sdk/mcp 2.0.103 源码结论（StdioMCPTransport，来自 @ai-sdk/mcp/mcp-stdio 子路径）：
// - StdioConfig 支持 command、args、env、stderr、cwd、shell；createMCPClient 可直接接收传输实例。
// - 传入 env 时，SDK 只会再补一份固定白名单变量，不会继承父进程的全部环境变量。
//   Windows 白名单：APPDATA、HOMEDRIVE、HOMEPATH、LOCALAPPDATA、PATH、PROCESSOR_ARCHITECTURE、SYSTEMDRIVE、SYSTEMROOT、TEMP、USERNAME、USERPROFILE。
//   其他系统白名单：HOME、LOGNAME、PATH、SHELL、TERM、USER。AGENT_API_KEY 不在其中，不会被下发。
// - 即便如此，这里仍自行构造子进程环境（基础变量 + server.env），并剔除 AGENT_ 前缀的变量，
//   不依赖 SDK 白名单今后保持不变；模型密钥因此不会出现在传给传输层的 env 里。
// - callTool 没有默认超时，只透传 abortSignal；工具耗时由 agent.mjs 的 timeout 配置约束。
import { createMCPClient } from '@ai-sdk/mcp';
import { StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { AgentError, safeAgentError } from './errors.mjs';

// 子进程需要的少量基础变量，其余一律不下发。TMP、SystemDrive、LOCALAPPDATA、APPDATA 供 Windows 下 Python 3 运行官方搜索 Skill 使用。
const BASE_ENV_NAMES = ['PATH', 'SystemRoot', 'SystemDrive', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'];
// 单个服务器的启动（含 initialize 握手）超时，是本模块的假设值，调用方可覆盖。
const DEFAULT_START_TIMEOUT_MS = 30_000;

// 子进程环境 = 基础变量 + server.env；AGENT_ 前缀的变量一律丢弃，非字符串值忽略。
export function buildChildEnv(serverEnv = {}, parentEnv = process.env) {
  const wanted = new Set(BASE_ENV_NAMES.map((name) => name.toUpperCase()));
  const env = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (wanted.has(key.toUpperCase()) && typeof value === 'string' && value !== '') env[key] = value;
  }
  for (const [key, value] of Object.entries(serverEnv ?? {})) {
    if (typeof value !== 'string' || key.toUpperCase().startsWith('AGENT_')) continue;
    env[key] = value;
  }
  return env;
}

// 默认传输实现集中在这一个函数里，便于替换。stderr 丢弃：子进程的启动提示不混入命令行输出。
export function createStdioTransport({ command, args = [], env }) {
  return new StdioMCPTransport({ command, args, env, stderr: 'ignore' });
}

function describeNoServers(servers) {
  const reasons = servers.map((server) => `${server?.id ?? '?'}：${server?.reason ?? '未启用'}`).join('；');
  return reasons ? `没有可用的 MCP 服务器（${reasons}）。` : '没有可用的 MCP 服务器。';
}

export async function connectServers(config, { signal, createTransport = createStdioTransport, createClient = createMCPClient, startTimeoutMs = DEFAULT_START_TIMEOUT_MS } = {}) {
  const all = Array.isArray(config?.servers) ? config.servers : [];
  const servers = all.filter((server) => server?.enabled);
  if (servers.length === 0) throw new AgentError('NO_TOOLS_ENABLED', describeNoServers(all), 3);

  const clients = [];
  let closing;
  // 幂等：重复调用返回同一个 Promise；单个客户端关闭失败不影响其余。
  const close = () => {
    closing ??= Promise.allSettled(clients.map((client) => client.close())).then(() => undefined);
    return closing;
  };
  const tools = {};
  const enabled = [];

  for (const server of servers) {
    try {
      signal?.throwIfAborted();
      const transport = createTransport({ command: server.command, args: [...(server.args ?? [])], env: buildChildEnv(server.env) });
      let client;
      try {
        client = await createClient({ transport, clientName: 'quotation-agent', initializationOptions: { signal, timeout: startTimeoutMs } });
      } catch (error) {
        try { await transport?.close?.(); } catch { /* 尽力回收子进程 */ }
        throw error;
      }
      clients.push(client);
      const serverTools = await client.tools();
      for (const name of Object.keys(serverTools)) {
        if (Object.hasOwn(tools, name)) throw new AgentError('MCP_START_FAILED', `MCP 服务器「${server.id}」的工具名与已连接的服务器冲突，已全部关闭。`, 1);
      }
      Object.assign(tools, serverTools);
      enabled.push(server.id);
    } catch (error) {
      // 先关闭已启动的服务器，再抛错；消息只带服务器 id，不带环境变量与原始异常文本。
      await close();
      if (error instanceof AgentError) throw error;
      if (signal?.aborted) throw safeAgentError(error, signal);
      throw new AgentError('MCP_START_FAILED', `MCP 服务器「${server.id}」启动失败，请检查依赖安装、路径与环境配置。`, 1);
    }
  }
  return { tools, enabled, close };
}
