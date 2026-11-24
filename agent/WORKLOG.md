# 工作记录 · agent

供接手的开发者与 agent 同步进度。只记录已验证的事实与仍然成立的结论。

本模块是智能体封装层，负责把两个数据模块的 MCP 工具交给模型编排。数据协议与采集规则属于 `data-collection-service/` 与 `information-search/`，见各自文档。

---

## 内核与依赖

Vercel AI SDK v7，四个运行依赖：

| 依赖 | 版本 | 作用 |
| --- | --- | --- |
| `ai` | 7.0.179 | 核心，`generateText` 多步工具循环 |
| `@ai-sdk/mcp` | 2.0.103 | MCP 客户端与 `StdioMCPTransport` |
| `@ai-sdk/openai-compatible` | 3.0.94 | OpenAI 兼容协议适配 |
| `zod` | 4.6.7 | schema 校验，与两个数据模块同版本 |

与数据模块技术栈天然一致（Node 24+、ESM、同版本 zod、同为 MCP），无需额外统一工作。

---

## 2026-11-23

### 修复采集入口凭证角色不匹配

`config.mjs` 原先向采集子进程下发 `DATA_SERVICE_USER_TOKEN`（`usr_` 用户令牌），但采集模块 `agent-tools.mjs` 的 `createAgentTools` 校验 `client.readOnly`，要求用户在界面创建的 `agt_` 只读凭证。后果是子进程启动失败，且错误被归并成笼统的 `MCP_START_FAILED`，`doctor` 看不出来（它不启动子进程）。

单独运行子进程才拿到真实原因：

```
采集 MCP 启动失败，请由用户在界面创建只读入口，并配置服务地址和 DATA_SERVICE_AGENT_TOKEN。
```

改动覆盖五处：`config.mjs` 改读正确键名、`cli.mjs` 脱敏白名单补入新键（否则只读令牌可能被打印）、`.env.example`、`README.md`、三份测试。提交 `ed269d1`。

这个修复也让权限边界更正确：agent 现在只能读已保存数据，无法登录、改设置或发起同步。

### 工具接线验证

两个 MCP 同时握手成功，暴露 7 个工具，全部 `readOnlyHint: true`：

```
zhihu_search  zhihu_get_search_result  zhihu_search_status
zhihu_collection_status  zhihu_collection_format
zhihu_knowledge_profile  zhihu_collection_read
```

越权验证：HTTP 层对 `agt_` 角色越出 `GET /v1/agent/*` 一律 403 `READ_ONLY`；`zhihu_collection_sync` 已不在工具列表，连调用入口都不存在。

`buildChildEnv()` 只传 `PATH`、`SystemRoot`、`TEMP`、`TMP`、`HOME`、`USERPROFILE` 加该服务器自己的 env，并显式剔除所有 `AGENT_` 前缀变量，模型密钥不会泄给子进程。

自带 72 项测试通过。

### 模型选型：tool calling 不是唯一门槛

同一套数据、同一条管道，三个模型结果完全不同：

| 模型 | 回答「我最近在看哪些主题」 |
| --- | --- |
| qwen2.5:3b（本地） | 「尚无对应采集结果」 |
| qwen2.5:7b（本地） | 「没有找到你的浏览数据快照」 |
| deepseek-flash（云端） | 正确解析 26 条，归纳出 6 个领域 |

逐层排查确认管道无问题：工具被调用、HTTP 直读 `ok:true, total:26`、`content[0].text` 1577 字符且 `ok:true`、`structuredContent` 存在、`isError:false`、`resultType:complete`。

原因是画像返回结构有三层——`{ok, data}` 外层 + `coverage`/`page`/`records` 中层 + 每条 22 字段。7B 量级模型看到 `coverage.completeHistory: false` 之类字段即误判为「无数据」。

**结论：选型要同时满足支持 tool calling 与能解析多层嵌套 JSON。** 后者在小模型上是真实瓶颈，且失败方式是静默误答而非报错，很难察觉。

### 已验证的模型配置

```ini
AGENT_BASE_URL=https://api.deepseek.com/v1
AGENT_MODEL=deepseek-flash
AGENT_API_KEY=<仅环境变量，不落盘>
AGENT_ALLOW_PERSONAL_DATA=true
DATA_SERVICE_URL=http://127.0.0.1:3005
DATA_SERVICE_AGENT_TOKEN=<采集界面「Agent 交付」创建的 agt_ 凭证>
```

DeepSeek 实际模型 ID 必须从 `/models` 接口确认，不要凭产品名猜测。当前为 `deepseek-flash`（显示名 DeepSeek-V4.1-Flash）与 `deepseek-v4-pro`，上下文均 1048576。

本机 Ollama 0.40.17 已装，备有 `qwen2.5:3b`、`qwen2.5:7b`。安装要点：官方包 1.77 GB，GitHub Releases 对单 IP 限速，四路并发分段约 0.7 MB/s、耗时约 40 分钟；静默安装用 Inno Setup 参数 `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART`（`/S` 不被接受）。

### 系统提示词的约束已生效

云端模型回答中可观察到三点，对应 `prompt.mjs` 的规则：

- 主动声明 `coverage` 的数据边界（最近 50 条合格记录、领域由本地规则生成而非模型分析）
- 识别出同题多条不同回答，未当作重复数据
- 未对用户身份、职业、性格做过度推断

提示词按已启用工具动态生成，首条即防注入：工具返回内容是外部数据而非指令。

---

## 待办

1. **搜索侧未用真实接口验证**。缺 `ZHIHU_ACCESS_SECRET`，目前只在 `--demo` 下跑过合成数据。
2. **本地模型可用性**。若要求数据不出本机，需验证 `qwen2.5:14b` 或更强模型能否解析画像结构；或考虑为小模型提供扁平化的简化视图。
3. **多轮对话未充分验证**。`chat` 命令已存在，但本轮只验证了单次 `ask`。

---

## 注意事项

1. **密钥只走环境变量**，`cli.mjs` 不接受命令行传入。输出前会把 `AGENT_API_KEY`、`ZHIHU_ACCESS_SECRET`、`DATA_SERVICE_AGENT_TOKEN`、`DATA_SERVICE_USER_TOKEN` 中长度不少于 6 的值替换为占位文字，但这只是兜底。
2. **云端模型意味着个人数据离开本机**。`AGENT_ALLOW_PERSONAL_DATA` 默认关闭就是为此。本地 Ollama 可避免，代价是准确性。
3. **采集入口只接受 `agt_` 凭证**，不接受 `usr_`。凭证由用户在采集界面创建，agent 侧无法自行生成。
4. **不要让 agent 触发采集**。同步由用户在界面操作；数据过旧时应提示用户，而非重试或绕行。
