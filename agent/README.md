# 智能体模块

本文件先建骨架，再分段填充。凡是没有实际验证过的内容，都会在文中明确标注。

历次改动、模型选型实测与待办见 [工作记录](WORKLOG.md)。

## 图形界面

不想敲命令行时用本机网页界面。`web.mjs` 起一个只监听 `127.0.0.1` 的服务，把对话、采集、交付合成一个页面：

```bash
npm run web
```

打开 <http://127.0.0.1:3210/>，顶部三个页签：

| 页签 | 内容 |
| --- | --- |
| 对话 | 填模型地址／模型名／密钥，勾工具来源，提问；回答下方显示步数、工具调用链与耗时 |
| 交互 | 连通数据端与展示端的三阶段论辩模块：观点选择（2 个画像观点 + 1 个热门观点，支持换一批）→ 多回合说服交锋（隐藏报价算价、动态难度显隐、对手意志增减）→ 逐回合复盘与知识点总结；亦可通过 `/interaction` 单独打开 |
| 采集 | 登录知乎、选采集范围、立即同步、翻看记录、导出 JSON、清除数据 |
| 画像 | 同步后自动生成的用户知识与偏好画像：概要、领域分布、关注点、近期变化、不确定之处；可手动重新生成 |
| 交付 | 管理 Agent 只读入口，查看 MCP 接入配置 |

**画像会自动维护**：每次同步成功后由模型生成一份结构化画像，落盘在 `.data/profile.json`，并注入到对话的系统提示词里。生成失败时保留上一份可用的，界面上注明失败原因——不会出现"没有画像"的空窗。模型没配置时只能显示上一次的结果。

**采集是直接接进对话的**：`collection.mjs` 用 `data-collection-service/desktop.mjs` 把采集服务与本机采集器拉起来，需要个人数据时用 `store.createReader()` 现场签发一个 `agt_` 只读令牌交给 Agent。所以只要在「采集」页登录并同步过，再勾上「允许个人数据发给模型」，对话里就能直接问自己的浏览记录，不需要手工创建令牌或拼 MCP 配置。

权限边界没有放宽：

- 登录、同意、撤回、清除本机数据仍走采集服务的 `/v1/ui/*`，那条路径要求回环 + 同源 + 本地控制模式，`collection.mjs` 只是以本机进程身份调用，服务端的三重校验照旧生效。
- Agent 侧只拿到 `agt_` 只读令牌，无法同步、登录、改设置或删数据。
- 只读令牌只存在内存，进程重启会重新签发；明文只在「交付」页新建入口时出现一次。

其余约定：

- 输出一律深度脱敏：任何返回给页面的文本里出现密钥或令牌都会被替换成 `[已隐藏]`。
- **密钥会保存在本机** `.data/secrets.json`，重启后自动恢复，不用每次重填。这是明文文件，权限收到仅当前用户（`.data/` 已在 `.gitignore` 里，不会进版本库）。页面上的「清除已保存的密钥」会把它删掉。命令行侧仍坚持只走环境变量。
- 同一时刻只处理一个提问，长等待可点「停止」取消。
- 关闭页面后约 60 秒内没有轮询，正在进行的同步会被取消——保留"界面关闭即停止采集"的语义。
- 采集组件起不来时（端口占用、缺浏览器），对话仍可用，错误显示在「采集」页。
- 非机密配置（模型地址、模型名、演示开关、采集服务地址）存 `.data/web-settings.json`。

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

- 该功能默认关闭。只有设置环境变量 `AGENT_ALLOW_PERSONAL_DATA=true`，或在命令行加 `--allow-personal-data`，并且提供了 `DATA_SERVICE_AGENT_TOKEN`（采集界面创建的 agt_ 只读凭证）时，才会启用采集服务。
- 想避免数据发往外部网络，可把 `AGENT_BASE_URL` 指向本机运行的模型服务，例如 `http://127.0.0.1:11434/v1`。是否真的没有外发，取决于该本地服务本身，本模块未做网络层面的验证。
- 密钥与令牌只通过环境变量提供，命令行不接受明文参数。命令行在写出 stdout 与 stderr 前，会把 `AGENT_API_KEY`、`ZHIHU_ACCESS_SECRET`、`DATA_SERVICE_AGENT_TOKEN`、`DATA_SERVICE_USER_TOKEN` 中长度不少于 6 个字符的值替换为占位文字。这只是兜底措施，不能替代妥善保管密钥。
- `chat` 的对话历史只保存在内存里，退出即丢弃；命令行本身不把对话写入文件。

## 环境变量

以下默认值与取值范围来自接口契约（`INTERFACES.md`）。读取这些变量的是 `config.mjs`，写本节时该文件尚未与命令行联调，因此取值与默认值未经验证。命令行只把 `env` 交给 `loadConfig`，并用其中三个密钥做输出脱敏。

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `AGENT_BASE_URL` | 是 | 无 | OpenAI 兼容接口地址，例如 `https://host/v1`；可被 `--base-url` 覆盖 |
| `AGENT_MODEL` | 是 | 无 | 模型名；可被 `--model` 覆盖。**必须是支持工具调用（function calling）的模型** |
| `AGENT_API_KEY` | 否 | 无 | 模型服务密钥，本地服务可为空；命令行只走环境变量，图形界面会存到本机 |
| `AGENT_MAX_STEPS` | 否 | 8 | 步数上限，范围 1 到 20；可被 `--max-steps` 覆盖 |
| `AGENT_TOTAL_TIMEOUT_MS` | 否 | 600000 | 一次提问的总超时，单位毫秒 |
| `AGENT_STEP_TIMEOUT_MS` | 否 | 120000 | 单步超时，单位毫秒 |
| `AGENT_ALLOW_PERSONAL_DATA` | 否 | 关闭 | 为 `true` 才允许启用采集工具；`--allow-personal-data` 等效 |
| `AGENT_SEARCH_DIR` | 否 | `../information-search` | 搜索 MCP 所在目录，相对 `agent/` 解析，不随工作目录变化 |
| `AGENT_COLLECTION_DIR` | 否 | `../data-collection-service` | 采集 MCP 所在目录，解析方式同上 |
| `ZHIHU_ACCESS_SECRET` | 否 | 无 | 搜索服务凭证；非空时启用搜索，`--demo` 时也启用。只传给搜索子进程 |
| `DATA_FILE` | 否 | 无 | 搜索服务的数据文件路径，只传给搜索子进程 |
| `DATA_SERVICE_URL` | 否 | `http://127.0.0.1:3005` | 采集服务地址，只传给采集子进程 |
| `DATA_SERVICE_AGENT_TOKEN` | 否 | 无 | 采集 **agt_ 只读凭证**，由用户在采集界面「Agent 交付」创建；非空且已同意个人数据发送时才启用采集。只传给采集子进程。该入口不接受 usr_ 用户令牌 |

### 模型必须支持工具调用

`agent.mjs` 通过 `generateText({ model, tools, stopWhen: isStepCount(maxSteps) })` 让模型自行决定调用哪个工具、调用几次。**不支持 function calling 的模型接上后不会报错，但永远拿不到数据，只会凭空作答。**

本机部署时可用 `qwen2.5`、`qwen3`、`llama3.1`、`mistral-nemo` 等具备工具调用能力的模型；`gemma2`、`phi3` 等不支持工具调用的模型不要用于本模块。

模型就绪的判定条件是 `AGENT_BASE_URL` 与 `AGENT_MODEL` 同时非空，缺任一项 `ask`／`chat` 以退出码 3 结束。`AGENT_API_KEY` 缺省时不发送 Authorization 头，适合本机服务。

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
| `--allow-personal-data` | 布尔 | 同意把个人浏览数据发送给模型服务；需配合 `DATA_SERVICE_AGENT_TOKEN` 才启用采集工具 |
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

调用采集工具（`DATA_SERVICE_AGENT_TOKEN` 已配置且 `--allow-personal-data` 已开启的情况下）时，同步操作会触发远端采集任务，等待时间通常较长。接口契约中 `limits.collectionSyncMs` 固定为 900000（15 分钟），供引擎（`agent.mjs`）针对同步工具单独放宽单步超时。超时后命令行会收到 `TIMEOUT` 错误并以退出码 1 退出。上述行为来自接口契约，尚未在真实采集流程中验证。

## 提示注入

工具返回的外部数据（如知乎搜索结果）有可能包含诱导模型偏离指令的内容。系统提示词（`prompt.mjs`）会要求模型把工具返回内容视为外部数据而非指令，引擎还可通过 Vercel AI SDK 的 `contentTrust` 配置降低工具结果的信任等级。但这些措施只能缓解风险，无法保证模型在所有情况下都会遵守，也无法阻止技术上可行的注入行为。不应把本模块用于需要可靠隔离外部内容的场景。

## 不在范围内

以下功能不在本模块的范围内，不会也不应在这里实现：

- 公网 HTTP 服务端。`web.mjs` 只监听回环地址，没有账号体系，不能对外提供接口。
- 用户画像生成与存储（画像字段由 `data-collection-service` 按规则产出，本模块只转述）
- 对话持久化（历史不写入数据库或文件）
- 知乎会话管理与登录（由 `data-collection-service` 负责；本模块只是在同一进程里调用它的桌面入口）
- 模型本身的部署与管理

## 验证状态

以下内容在写文档时已通过测试或代码确认：

- `main()` 的签名与契约一致，接受注入的假实现，返回退出码，不调用 `process.exit`
- `--help`、参数错误、`doctor`、`ask` 正常与失败路径、`chat` 多轮历史与退出、取消返回 130 均通过 `test/cli.test.mjs`（41 个测试，全部通过）
- 密钥脱敏的覆盖范围包括环境变量里的三类密钥和写往 stdout / stderr 的所有文本
- 图形界面的路由、设置规范化、并发拒绝、跨站拦截、回答脱敏与采集接口由 `test/web.test.mjs` 覆盖（36 个测试，全部通过，用假实现，不启动子进程）
- 画像的输入拼装、JSON 解析、提示词注入与失败保留由 `test/profile.test.mjs` 覆盖（18 个测试，全部通过）
- 图形界面与采集组件已真机联调：采集页能读到真实快照（26 条记录），勾选个人数据后自动签发的 `agt_` 令牌让 7 个工具全部握手成功，一次提问经 `zhihu_knowledge_profile` 拿到真实数据
- `doctor` 不调用 `createAgent`，不连接模型
- `chat --json` 参数错误、`chat` 多余参数均返回 2

以下内容未在真实环境中验证，只来自接口契约或设计推断：

- 环境变量的默认值和取值范围（由 `config.mjs` 负责，联调前无法确认）
- 与真实云端模型的回答质量（联调时用的是桩模型服务，只验证链路连通）
- 采集同步的实际耗时和超时行为
- `--env-file-if-exists=.env` 在 `npm run cli` 里的可用性（取决于 Node.js 版本与 npm scripts 的处理方式，未单独验证）
