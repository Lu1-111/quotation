# 智能体模块

本文件先建骨架，再分段填充。凡是没有实际验证过的内容，都会在文中明确标注。

## 用途与边界

本模块是一个命令行智能体：用户用自然语言提问，由所配置的模型按需调用仓库里已有的两个 MCP 服务，再把回答写到终端。

- `information-search/`：官方接口的信息搜索，仅消费公开接口结果。
- `data-collection-service/`：个人浏览数据采集服务的 MCP 入口。

边界：

- 本模块没有自己的模型，也没有自写的对话循环；只封装 Vercel AI SDK（`ai`、`@ai-sdk/mcp`、`@ai-sdk/openai-compatible`），按 OpenAI 兼容接口连接你自行配置的模型服务，并启动上述两个 MCP。
- 不 import 仓库内其他模块的源码，只通过路径启动它们各自的 `mcp-server.mjs`。
- 需要 Node.js 24+。

## 个人数据与隐私

采集工具返回的个人浏览数据会作为上下文发送给你所配置的模型服务。为此：

- 该功能默认关闭。只有设置环境变量 `AGENT_ALLOW_PERSONAL_DATA=true`，或在命令行加 `--allow-personal-data`，并且提供了 `DATA_SERVICE_USER_TOKEN` 时，才会启用采集服务。
- 想避免数据发往外部网络，可把 `AGENT_BASE_URL` 指向本机运行的模型服务，例如 `http://127.0.0.1:11434/v1`。是否真的没有外发，取决于该本地服务本身，本模块未做网络层面的验证。
- 密钥与令牌只通过环境变量提供，命令行不接受明文参数。命令行在写出 stdout 与 stderr 前，会把 `AGENT_API_KEY`、`ZHIHU_ACCESS_SECRET`、`DATA_SERVICE_USER_TOKEN` 中长度不少于 6 个字符的值替换为占位文字。这只是兜底措施，不能替代妥善保管密钥。
- `chat` 的对话历史只保存在内存里，退出即丢弃；命令行本身不把对话写入文件。

## 环境变量

以下默认值与取值范围来自接口契约（`INTERFACES.md`）。读取这些变量的是 `config.mjs`，写本节时该文件尚未与命令行联调，因此取值与默认值未经验证。命令行只把 `env` 交给 `loadConfig`，并用其中三个密钥做输出脱敏。

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `AGENT_BASE_URL` | 是 | 无 | OpenAI 兼容接口地址，例如 `https://host/v1`；可被 `--base-url` 覆盖 |
| `AGENT_MODEL` | 是 | 无 | 模型名；可被 `--model` 覆盖 |
| `AGENT_API_KEY` | 否 | 无 | 模型服务密钥，本地服务可为空；只走环境变量 |
| `AGENT_MAX_STEPS` | 否 | 8 | 步数上限，范围 1 到 20；可被 `--max-steps` 覆盖 |
| `AGENT_TOTAL_TIMEOUT_MS` | 否 | 600000 | 一次提问的总超时，单位毫秒 |
| `AGENT_STEP_TIMEOUT_MS` | 否 | 120000 | 单步超时，单位毫秒 |
| `AGENT_ALLOW_PERSONAL_DATA` | 否 | 关闭 | 为 `true` 才允许启用采集工具；`--allow-personal-data` 等效 |
| `AGENT_SEARCH_DIR` | 否 | `../information-search` | 搜索 MCP 所在目录，相对 `agent/` 解析，不随工作目录变化 |
| `AGENT_COLLECTION_DIR` | 否 | `../data-collection-service` | 采集 MCP 所在目录，解析方式同上 |
| `ZHIHU_ACCESS_SECRET` | 否 | 无 | 搜索服务凭证；非空时启用搜索，`--demo` 时也启用。只传给搜索子进程 |
| `DATA_FILE` | 否 | 无 | 搜索服务的数据文件路径，只传给搜索子进程 |
| `DATA_SERVICE_URL` | 否 | `http://127.0.0.1:3005` | 采集服务地址，只传给采集子进程 |
| `DATA_SERVICE_USER_TOKEN` | 否 | 无 | 采集用户令牌；非空且已同意个人数据发送时才启用采集。只传给采集子进程 |

## 快速开始

需要 Node.js 24+。在 `agent/` 目录执行：

```bash
npm ci
```

然后提供模型配置。下面以本机模型地址为例，地址和模型名只是占位，请换成自己的：

```bash
export AGENT_BASE_URL=http://127.0.0.1:11434/v1
export AGENT_MODEL=<你的模型名>
```

`package.json` 里的脚本带有 `--env-file-if-exists=.env`，所以也可以把变量写在 `agent/.env` 里。`.env` 属于私有文件，不得提交。`.env.example` 模板由配置部分维护，写本节时尚未确认它已存在，请以仓库里的实际文件为准。

```bash
npm test
npm run doctor
npm run cli -- ask "你的问题"
```

`npm test` 只依赖注入的假实现，不需要真实模型和真实知乎登录。`doctor`、`ask` 与真实模型、真实 MCP 服务的端到端运行尚未验证。

## 命令示例

### doctor

只打印 `describeConfig` 返回的脱敏结果，以及各 MCP 服务器的启用状态和原因。不创建智能体，不连接模型，不启动子进程。

```bash
npm run doctor
npm run doctor -- --demo
npm run doctor -- --json
```

人类可读输出依次列出：演示模式、是否允许个人数据发送、模型地址与模型名、模型密钥是否已配置（只显示是或否，不显示密钥本身）、各项限制，以及每个服务器一行“id：已启用或未启用，原因”。模型地址与模型名没有同时配置，或没有任何已启用的服务器时，退出码为 3，否则为 0。

`--json` 时输出统一外层，结构如下（字段值为示意）：

```json
{"schemaVersion":1,"ok":true,"data":{"config":{},"modelReady":true,"enabledServers":["search"]},"error":null}
```

其中 `config` 是 `describeConfig` 的返回值，具体字段以 `config.mjs` 为准。

### ask

```bash
npm run cli -- ask "最近有什么热门话题"
npm run cli -- ask "最近有什么热门话题" --json
npm run cli -- ask "总结我最近的浏览" --allow-personal-data --base-url http://127.0.0.1:11434/v1 --model <你的模型名>
```

默认只把回答正文写到 stdout，错误写到 stderr。问题缺失或只有空白时退出码为 2。

加 `--json` 时，stdout 输出统一外层，`data` 为 `{ text, stepCount, toolCalls }`，其中 `toolCalls` 每项只保留工具名，不含参数与结果：

```json
{"schemaVersion":1,"ok":true,"data":{"text":"回答正文","stepCount":2,"toolCalls":[{"name":"zhihu_search"}]},"error":null}
```

失败时 `--json` 把错误外层写到 stderr，stdout 为空：

```json
{"schemaVersion":1,"ok":false,"data":null,"error":{"code":"MODEL_NOT_CONFIGURED","message":"……"}}
```

以上结构来自 `test/cli.test.mjs` 里用假智能体得到的输出，不是真实模型的输出。

### chat

```bash
npm run cli -- chat
```

逐行读取 stdin，每行作为一轮提问，回答写到 stdout。空行忽略，输入 `exit` 或遇到 EOF 退出，退出码为 0。对话历史只保存在内存里，每轮只含问题与回答文本，退出即丢弃。某一轮失败时，命令行会停止并以该错误的退出码结束，不再处理后续输入。`chat` 不支持 `--json`，传入会返回 2（契约没有规定这一点，是本命令行额外加的约束）。

也可以用管道喂入多行：

```bash
printf '你好\n再详细说说\nexit\n' | npm run cli -- chat
```

这条管道命令未在真实模型上运行过。

所有选项均可组合使用。密钥与令牌只走环境变量，命令行不接受对应参数。

| 选项 | 类型 | 说明 |
| --- | --- | --- |
| `--demo` | 布尔 | 使用合成演示数据，不访问真实知乎 |
| `--allow-personal-data` | 布尔 | 同意把个人浏览数据发送给模型服务；需配合 `DATA_SERVICE_USER_TOKEN` 才启用采集工具 |
| `--json` | 布尔 | `ask` 和 `doctor` 输出统一 JSON 外层；`chat` 不支持 |
| `--max-steps <n>` | 整数 | 覆盖最大步数，取值范围由 `config.mjs` 校验 |
| `--base-url <url>` | 字符串 | 覆盖 `AGENT_BASE_URL` |
| `--model <name>` | 字符串 | 覆盖 `AGENT_MODEL` |
| `--help` | 布尔 | 显示帮助，退出码 0 |

退出码：

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 运行失败（模型错误、内部错误、超时） |
| 2 | 参数或配置错误 |
| 3 | 模型未配置或没有可用的 MCP 工具 |
| 130 | 收到 `SIGINT` 或 `SIGTERM` 后取消 |

## 采集同步耗时与超时

调用采集工具（`DATA_SERVICE_USER_TOKEN` 已配置且 `--allow-personal-data` 已开启的情况下）时，同步操作会触发远端采集任务，等待时间通常较长。接口契约中 `limits.collectionSyncMs` 固定为 900000（15 分钟），供引擎（`agent.mjs`）针对同步工具单独放宽单步超时。超时后命令行会收到 `TIMEOUT` 错误并以退出码 1 退出。上述行为来自接口契约，尚未在真实采集流程中验证。

## 提示注入

工具返回的外部数据（如知乎搜索结果）有可能包含诱导模型偏离指令的内容。系统提示词（`prompt.mjs`）会要求模型把工具返回内容视为外部数据而非指令，引擎还可通过 Vercel AI SDK 的 `contentTrust` 配置降低工具结果的信任等级。但这些措施只能缓解风险，无法保证模型在所有情况下都会遵守，也无法阻止技术上可行的注入行为。不应把本模块用于需要可靠隔离外部内容的场景。

## 不在范围内

以下功能不在本模块的范围内，不会也不应在这里实现：

- HTTP 服务端（无任何监听端口）
- 用户画像生成与存储
- 对话持久化（历史不写入数据库或文件）
- 知乎会话管理与登录（由 `data-collection-service` 负责）
- 模型本身的部署与管理

## 验证状态

以下内容在写文档时已通过测试或代码确认：

- `main()` 的签名与契约一致，接受注入的假实现，返回退出码，不调用 `process.exit`
- `--help`、参数错误、`doctor`、`ask` 正常与失败路径、`chat` 多轮历史与退出、取消返回 130 均通过 `test/cli.test.mjs`（41 个测试，全部通过）
- 密钥脱敏的覆盖范围包括环境变量里的三类密钥和写往 stdout / stderr 的所有文本
- `doctor` 不调用 `createAgent`，不连接模型
- `chat --json` 参数错误、`chat` 多余参数均返回 2

以下内容未在真实环境中验证，只来自接口契约或设计推断：

- 环境变量的默认值和取值范围（由 `config.mjs` 负责，联调前无法确认）
- 与真实模型、真实 MCP 服务的端到端运行效果
- 采集同步的实际耗时和超时行为
- `AGENT_ALLOW_PERSONAL_DATA=true` 时采集工具的完整启用流程
- `--env-file-if-exists=.env` 在 `npm run cli` 里的可用性（取决于 Node.js 版本与 npm scripts 的处理方式，未单独验证）
