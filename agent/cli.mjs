#!/usr/bin/env node
// 智能体命令行：ask、chat、doctor。main() 只返回退出码，不直接调用 process.exit，便于测试注入。
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentError, okEnvelope, errorEnvelope, safeAgentError } from './errors.mjs';

const HELP = `智能体命令行（Node.js 24+）

用法：node cli.mjs <命令> [选项]

命令：
  ask <问题>   单次提问，默认只把回答正文写到 stdout
  chat         逐行问答；历史只保存在内存，输入 exit 或遇到 EOF 退出
  doctor       打印脱敏后的配置与各 MCP 服务器的启用状态，不创建智能体、不连接模型

选项：
  --demo                    使用合成演示数据
  --allow-personal-data     同意把个人浏览数据发送给所配置的模型服务（默认关闭）
  --json                    ask 与 doctor 输出统一 JSON 外层；失败时错误外层写到 stderr
  --max-steps <n>           步数上限，取值范围由配置校验
  --base-url <url>          覆盖 AGENT_BASE_URL
  --model <name>            覆盖 AGENT_MODEL
  --help                    显示帮助

密钥与令牌只通过环境变量提供（AGENT_API_KEY、ZHIHU_ACCESS_SECRET、DATA_SERVICE_USER_TOKEN），不接受命令行参数。
退出码：0 成功，1 运行失败，2 参数或配置错误，3 缺模型配置或没有可用工具，130 取消。
`;

// ===== 参数解析 =====
const COMMANDS = ['ask', 'chat', 'doctor'];
const usageError = (message) => new AgentError('INVALID_ARGUMENTS', message, 2);

// 解析命令行；格式问题一律抛 AgentError('INVALID_ARGUMENTS', 中文消息, 2)。
// 密钥与令牌没有对应的命令行选项，传入即视为未知选项。
export function parseCliArgs(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      demo: { type: 'boolean' },
      'allow-personal-data': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
      'max-steps': { type: 'string' },
      'base-url': { type: 'string' },
      model: { type: 'string' },
    } });
  } catch {
    throw usageError('参数无效，请运行 node cli.mjs --help 查看格式。');
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) return { command: 'help', options: values, question: '' };
  const [command, ...rest] = positionals;
  if (!COMMANDS.includes(command)) throw usageError('未知命令，请运行 node cli.mjs --help 查看可用命令。');
  if (command !== 'ask' && rest.length > 0) throw usageError(`${command} 不接受额外参数。`);
  if (command === 'chat' && values.json) throw usageError('chat 不支持 --json。');
  const question = rest.join(' ').trim();
  if (command === 'ask' && !question) throw usageError('缺少问题，用法：node cli.mjs ask <问题>');
  if (values['max-steps'] !== undefined && !/^[0-9]+$/.test(values['max-steps'])) throw usageError('--max-steps 必须是正整数。');
  for (const key of ['base-url', 'model']) {
    if (values[key] !== undefined && !values[key].trim()) throw usageError(`--${key} 不能为空。`);
  }
  return { command, options: values, question };
}

// 命令行选项转为 loadConfig 的 overrides；未给出的选项不写入，交给环境变量决定。
// 数值范围由 loadConfig 校验，这里只保证是整数形态。
export function buildOverrides(options) {
  const overrides = {};
  if (options.demo) overrides.demo = true;
  if (options['allow-personal-data']) overrides.allowPersonalData = true;
  if (options['max-steps'] !== undefined) overrides.maxSteps = Number(options['max-steps']);
  if (options['base-url'] !== undefined) overrides.baseURL = options['base-url'].trim();
  if (options.model !== undefined) overrides.modelName = options.model.trim();
  return overrides;
}

// ===== 输出与脱敏 =====
// 只从环境变量里收集这三类密钥；它们没有命令行选项，也不应出现在任何输出里。
const SECRET_ENV_KEYS = ['AGENT_API_KEY', 'ZHIHU_ACCESS_SECRET', 'DATA_SERVICE_USER_TOKEN'];
// 过短的值替换后会破坏正常文本，因此只处理不短于 6 个字符的值。
const MIN_SECRET_LENGTH = 6;
const REDACTED = '[已隐藏]';

// 返回按长度降序排列的去重密钥值，先替换长值，避免短值是长值子串时留下残片。
export function collectSecrets(env = {}) {
  const values = SECRET_ENV_KEYS
    .map((key) => env[key])
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length >= MIN_SECRET_LENGTH);
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

export function redactSecrets(text, secrets = []) {
  let result = String(text);
  for (const secret of secrets) result = result.split(secret).join(REDACTED);
  return result;
}

// 包装输出流：写出前统一脱敏，写入的内容一律按字符串处理。
function createSink(stream, secrets) {
  return { write: (text) => stream.write(redactSecrets(text, secrets)) };
}

const withNewline = (text) => (text.endsWith('\n') ? text : `${text}\n`);

// 失败输出：--json 时把 errorEnvelope 写到 stderr，否则写中文消息；stdout 保持干净。
function reportFailure(stderr, error, json) {
  stderr.write(json ? `${JSON.stringify(errorEnvelope(error))}\n` : withNewline(error.message));
}

// 把任意异常经 safeAgentError 转成 AgentError 并报告，返回 AgentError.exitCode。
function failureExitCode(stderr, error, { json = false, signal } = {}) {
  const safe = safeAgentError(error, signal);
  reportFailure(stderr, safe, json);
  return safe.exitCode;
}

// ===== 命令实现 =====
const toolNames = (toolCalls) => (Array.isArray(toolCalls) ? toolCalls : []).map((call) => ({ name: String(call?.name ?? '') }));
const yesNo = (value) => (value ? '是' : '否');

// ask：单次提问。默认只写回答正文；--json 写 okEnvelope。toolCalls 只保留工具名，不带参数与结果。
export async function runAsk(agent, question, { json = false, stdout, signal } = {}) {
  const result = await agent.ask(question, { history: [], signal });
  const text = typeof result?.text === 'string' ? result.text : '';
  if (json) {
    const stepCount = Number.isInteger(result?.stepCount) ? result.stepCount : 0;
    stdout.write(`${JSON.stringify(okEnvelope({ text, stepCount, toolCalls: toolNames(result?.toolCalls) }))}\n`);
  } else {
    stdout.write(withNewline(text));
  }
}

// chat：逐行读 stdin，历史只在内存里累积，退出即丢弃。空行忽略，输入 exit 或遇到 EOF 退出。
// 任一轮失败即停止并返回该错误的退出码，不带着残缺历史继续。收到取消信号返回 130。
export async function runChat(agent, { stdin, stdout, stderr, signal } = {}) {
  const cancelled = () => failureExitCode(stderr, new Error('cancelled'), { signal });
  if (signal?.aborted) return cancelled();
  let history = [];
  const rl = createInterface({ input: stdin, terminal: false, crlfDelay: Infinity });
  const onAbort = () => rl.close();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (stdin?.isTTY) stderr.write('已进入对话：输入问题后回车，输入 exit 退出。\n');
    for await (const line of rl) {
      if (signal?.aborted) break;
      const question = line.trim();
      if (!question) continue;
      if (question === 'exit') break;
      try {
        const result = await agent.ask(question, { history, signal });
        const text = typeof result?.text === 'string' ? result.text : '';
        history = Array.isArray(result?.history) ? result.history : [...history, { role: 'user', content: question }, { role: 'assistant', content: text }];
        stdout.write(withNewline(text));
      } catch (error) {
        return failureExitCode(stderr, error, { signal });
      }
    }
    return signal?.aborted ? cancelled() : 0;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    rl.close();
  }
}

// doctor 的人类可读输出：只取 describeConfig 返回的脱敏对象，字段缺失时给出占位而不是报错。
export function formatDoctor(description, { modelReady, enabledServers }) {
  const model = description?.model ?? {};
  const limits = description?.limits ?? {};
  const servers = Array.isArray(description?.servers) ? description.servers : [];
  const lines = [
    '智能体配置检查（不连接模型，不启动子进程）',
    `演示模式：${yesNo(description?.demo)}`,
    `允许个人数据发送给模型服务：${yesNo(description?.allowPersonalData)}`,
    `模型地址：${model.baseURL ?? '未配置'}`,
    `模型名：${model.modelName ?? '未配置'}`,
    `模型密钥已配置：${yesNo(model.apiKeyConfigured)}`,
    `模型配置就绪：${yesNo(modelReady)}`,
    `限制：步数上限 ${limits.maxSteps ?? '-'}，总超时 ${limits.totalMs ?? '-'} 毫秒，单步超时 ${limits.stepMs ?? '-'} 毫秒，同步工具单步超时 ${limits.collectionSyncMs ?? '-'} 毫秒`,
    'MCP 服务器：',
    ...(servers.length ? servers.map((server) => `  ${server.id}：${server.enabled ? '已启用' : '未启用'}，${server.reason ?? '无说明'}`) : ['  （无）']),
  ];
  if (!modelReady) lines.push('提示：模型需要同时配置 AGENT_BASE_URL 与 AGENT_MODEL（或 --base-url 与 --model）。');
  if (!enabledServers.length) lines.push('提示：没有已启用的 MCP 服务器，ask 与 chat 会以退出码 3 结束。');
  return `${lines.join('\n')}\n`;
}

// doctor：只打印 describeConfig 的结果与各服务器的启用状态和原因，不创建智能体、不连接模型。
// 模型配置不完整或没有已启用的服务器时退出码为 3，便于脚本判断是否可用；其余情况为 0。
export function runDoctor(config, describeConfig, { json = false, stdout } = {}) {
  const description = describeConfig(config);
  const modelReady = Boolean(config?.model?.ready);
  const enabledServers = (Array.isArray(config?.servers) ? config.servers : []).filter((server) => server?.enabled).map((server) => server.id);
  if (json) stdout.write(`${JSON.stringify(okEnvelope({ config: description, modelReady, enabledServers }))}\n`);
  else stdout.write(formatDoctor(description, { modelReady, enabledServers }));
  return modelReady && enabledServers.length > 0 ? 0 : 3;
}

// ===== main =====
// 未注入实现时才动态 import：A、B 的文件尚未就绪时，注入假实现的测试仍可运行；doctor 不会加载引擎（index.mjs）。
export async function main(args, { env = process.env, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, signal, createAgent, loadConfig, describeConfig } = {}) {
  const secrets = collectSecrets(env);
  const out = createSink(stdout, secrets);
  const err = createSink(stderr, secrets);
  let parsed;
  try {
    parsed = parseCliArgs(args);
  } catch (error) {
    return failureExitCode(err, error, { json: Array.isArray(args) && args.includes('--json'), signal });
  }
  const { command, options, question } = parsed;
  if (command === 'help') {
    out.write(HELP);
    return 0;
  }
  const json = Boolean(options.json);
  let agent;
  try {
    if (signal?.aborted) throw new Error('cancelled');
    const load = loadConfig ?? (await import('./config.mjs')).loadConfig;
    const config = await load({ env, overrides: buildOverrides(options) });
    if (command === 'doctor') {
      const describe = describeConfig ?? (await import('./config.mjs')).describeConfig;
      return runDoctor(config, describe, { json, stdout: out });
    }
    const create = createAgent ?? (await import('./index.mjs')).createAgent;
    agent = await create(config);
    if (command === 'ask') {
      await runAsk(agent, question, { json, stdout: out, signal });
      return 0;
    }
    return await runChat(agent, { stdin, stdout: out, stderr: err, signal });
  } catch (error) {
    return failureExitCode(err, error, { json, signal });
  } finally {
    // 退出前关闭智能体；关闭失败不覆盖已确定的结果与退出码。
    if (agent) {
      try { await agent.close(); } catch { /* 忽略关闭失败 */ }
    }
  }
}

// ===== 入口：只在作为主脚本运行时处理真实进程与信号 =====
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    process.exitCode = await main(process.argv.slice(2), { signal: controller.signal });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
