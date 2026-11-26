# 工作记录 · data-collection-service

供接手的开发者与 agent 同步进度。按时间倒序，只记录已验证的事实与仍然成立的结论。

分支：`codex/collection-console`（工作副本 `quotation-publish/`）
状态：**全部改动未提交**，需由本人以 `LoGuai` 署名决定提交范围。

---

## 当前进度概览

| 能力 | 状态 |
| --- | --- |
| 统一 API + 本机采集器 | 已实现，11 项测试通过 |
| 本机图形控制台 | 已实现（`public/` + `desktop.mjs`） |
| Electron 桌面壳 | 已实现（`shell.cjs`），真实窗口验证通过 |
| 知识画像协议 | 已实现 `zhihu-knowledge-profile/v1` |
| 正文采集 | 已实现 `fetchFullText`，真实数据 20 条中 19 条取到正文 |
| 增量同步与详情缓存 | 已实现，重复同步不再重爬同一批内容；`test/incremental.test.mjs` 9 项通过 |
| Agent 只读接入 | 已实现，4 个只读工具 + MCP |
| Agent 平台（`agent/`）对接 | **已端到端跑通**：7 个工具握手、真实数据 26 条、云端模型正确归纳 |
| 接入正式前端 | 契约已固化为 [INTEGRATION.md](INTEGRATION.md)，待前端架构确定后执行 |

---

## 2026-11-25

### 增量同步 + 详情缓存：把重复爬取去掉

**动因**（实测见 `agent/WORKLOG.md`）：一次同步约 70 秒，其中约 55 秒是 `zhihu-sources.mjs` 里"每条记录取详情前 `await pause()`"的固定 1 秒，乘上约 50 条扫描记录。真正慢的不是网络，是节流等待，而且每次都在重复采集同一批内容。

**改动**（只动 `local/lib/`，不改采集规则与节流本身）：

1. **详情缓存**：新增 `history_details` 表，按 `(source_id, 内容键)` 存详情响应，TTL 7 天、单条上限 256 KB。命中就不再发请求，也不走 `pause()`。失败与 403/404 不入缓存，下次仍会重试。
2. **增量扫描**：`collectSelectedData` 新增 `previous` 参数（上次落库的浏览记录）。命中上次记录就直接复用，不再取详情；遇到比上次最旧一条更早、且没采过的条目，说明已越过上次的结束位置，停止翻页；随后把更早但采过的记录补回窗口，保证 50 条窗口不缩水。
3. 上次被知识过滤排除的条目也会被复用，只补回审计列表，不占 50 条窗口。

**验证**：

- 新增 `test/incremental.test.mjs`（9 项）：缓存命中不请求、过期重取、复用已采条目、边界停止、排除项复用、无 previous 时行为不变。
- 既有 `test/service.test.mjs` 11 项仍全过。
- 用 demo 数据跑真实 collector 三遍：第一次 1 分页 + 1 内容详情；第二、三次 **1 分页 + 0 内容详情**，记录数不变。

**真机复测**（同一账号、42 条合格记录、全部来源+正文）：优化前 69.5 / 69.5 / 70.6 / 72.4 秒，优化后 **6.7 / 5.4 / 6.5 秒**，约 11 倍。记录数与排除数保持一致（42 / 7）。
剩下的 6 秒基本就是固定开销——浏览器启动、打开知乎、两次账号校验，与之前"仅点赞 0 条也要 5.9 秒"的量级相同，说明分页与详情请求已经几乎全部消失。

**已知取舍**：

- 详情缓存意味着点赞数、评论数最多滞后 7 天，`weight` 由旧指标算出。要强制刷新就清空该档案数据，或等 TTL 过期。
- 首次把 `fetchFullText` 打开时，旧记录没有正文会被重新补齐（命中缓存则不发请求），之后恢复增量。
- 增量只作用于浏览记录；点赞与收藏仍然整表遍历，但它们靠详情缓存已经不再产生详情请求。

---

## 2026-11-25

### 每个类别最多 50 条 + 按「权重 × 采集新鲜度」淘汰

以前只有浏览记录在取数时按"最近 50 条"截断，点赞和收藏没有上限——收藏几百条的人，库会一直涨。

改动：

1. 新增 `PART_LIMIT = 50`，`save()` 里对每个类别分别截断。
2. 淘汰分数在 `record-ranking.mjs` 的 `keepScore()`：`类型权重 × 行为系数 + 互动加分 + 采集新鲜度`。新鲜度按首次采集时间算，30 天内线性衰减到 0，最多加 1 分。同分时保留采集时间更近的，再按 key 定序保证可复现。
3. **快照里的 `weight` 不拿来淘汰**：它还含"同主题加分"，那是窗口内的相对信号，会随批次变化，用来决定长期存储取舍不稳定。淘汰用的是同一套类型/行为/互动权重，但不含主题加分。
4. `observedAt` 改为保留**首次**见到的时间。原来每次同步都会刷新成当前时间，"采集时间靠前"这个判断就失效了。

**验证**：新增 `test/limits.test.mjs`（11 项）——分数优先级、上限截断、三类各自独立计上限、重复采集不翻倍、首次时间保留。

**边界**：浏览记录的 50 条是"扫描时就按最近优先停住"的，不会为了权重多扫（那会把增量同步的耗时打回去）；真正会超限的是点赞与收藏，规则在那里生效。

---

## 2026-11-23

### Agent 平台对接（agent/ 模块）

仓库新增的 `agent/` 采用 Vercel AI SDK v7（`ai` 7.0.179 + `@ai-sdk/mcp` 2.0.103 + `@ai-sdk/openai-compatible` 3.0.94 + zod 4.6.7），通过 stdio 连接搜索与采集两个 MCP 子进程。技术栈与本模块天然一致（Node 24+、ESM、同版本 zod、同为 MCP），无需额外统一。

**修复一处真实对接缺陷**：`agent/config.mjs` 原先向采集子进程下发 `DATA_SERVICE_USER_TOKEN`（`usr_`），而本模块 `agent-tools.mjs` 的 `createAgentTools` 校验 `client.readOnly`，要求 `agt_` 只读凭证，导致子进程启动失败并被归并成笼统的 `MCP_START_FAILED`。已改为 `DATA_SERVICE_AGENT_TOKEN`，并同步 `cli.mjs` 脱敏白名单、`.env.example`、README 与三份测试。提交 `ed269d1`。

**实测结果**：两个 MCP 同时握手成功，暴露 7 个工具（搜索 3 个 + 采集 4 个），全部 `readOnlyHint: true`。画像工具返回真实数据 26 条、含正文（最长 6795 字），`capabilities` 为 `{readSavedData:true, sync:false, login:false, settings:false}`。越权调用同步与改设置均被 403 `READ_ONLY` 拦截；`zhihu_collection_sync` 已不在工具列表中，连调用入口都不存在。agent 自带 72 项测试通过。

**模型已接入并端到端验证**：Ollama 0.40.17 已装（官方包 1.77 GB，GitHub Releases 对单 IP 限速，四路并发分段约 0.7 MB/s、耗时约 40 分钟；静默安装参数为 Inno Setup 的 `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART`）。本机拉取 `qwen2.5:3b`、`qwen2.5:7b`，另接入 DeepSeek 云端模型完成真实对话。

**本地小模型读不穿画像返回结构**，这是本轮最重要的发现：

| 模型 | 对「我最近在看哪些主题」的回答 |
| --- | --- |
| qwen2.5:3b | 「尚无对应采集结果」 |
| qwen2.5:7b | 「没有找到你的浏览数据快照」 |
| deepseek-flash | 正确解析 26 条，归纳出 6 个领域 |

排查确认管道无问题：工具被调用（`toolCalls` 含 `zhihu_knowledge_profile`）、HTTP 直读 `ok:true, total:26`、`content[0].text` 1577 字符且 `ok:true`、`structuredContent` 存在、`isError:false`、`resultType:complete`。原因是返回结构有三层（`{ok,data}` 外层 + `coverage`/`page`/`records` 中层 + 每条 22 字段），7B 量级模型看到 `coverage.completeHistory:false` 之类字段即误判为无数据。**选型时必须考虑模型的嵌套 JSON 解析能力，不只是是否支持 tool calling。**

DeepSeek 的实际模型 ID 需从 `/models` 接口确认：当前为 `deepseek-flash`（显示名 DeepSeek-V4.1-Flash）与 `deepseek-v4-pro`，上下文均 1048576。

云端模型回答质量符合预期：主动声明 `coverage` 的数据边界（最近 50 条、规则生成而非模型分析）、识别出同题多条不同回答、未对用户身份性格做过度推断——说明 `prompt.mjs` 的约束生效。

模型配置要求见 `agent/README.md`：必填 `AGENT_BASE_URL` 与 `AGENT_MODEL`，且**模型必须支持工具调用**，否则不报错但永远拿不到数据。个人数据需显式开启 `AGENT_ALLOW_PERSONAL_DATA`，因为数据会发送至所配置的模型服务——用云端模型即意味着浏览记录与正文离开本机。


### 正文采集（fetchFullText）

**背景**：正文其实一直被采到并清洗好，但 `zhihu-sources.mjs` 中被 `settings.aiReview` 绑定，`aiReview` 在 schema 层锁死为 `false`，导致每次采集后原地丢弃。这正是 README 长期标注的"全文获取需与模型分析解耦"。

**实现**：新增独立设置 `fetchFullText`，与 `aiReview` 完全解耦。读取时以 `bodyMaxChars` 控制长度（默认 0 不返回，上限 50000），`bodyChars` 始终为完整长度便于判断截断。

**关键教训**：首次实现只改了 `contracts.mjs`，采集仍失败且报 `COLLECTION_FAILED`。排查发现链路上有**两道独立字段白名单**静默丢弃该字段：

- `local/runtime.mjs` 的 `TYPES`
- `local/lib/record-ranking.mjs` 的 `DEFAULT_SETTINGS`（`validateSettings` 按其键过滤）

三处同时改完才生效。详见 [INTEGRATION.md](INTEGRATION.md) 第 9 节。

**安全约束**：正文读取范围大于摘要，已纳入 `worker.mjs` 的 `checkGrant()`，服务端无法单方面开启。已加测试锁定。

**验证**：真实账号同步 20 条，19 条带正文；缺的 1 条为 `question` 类型，平台无对应正文接口。

### Electron 桌面壳

新增 `shell.cjs`，调用 `startDesktop()` 后在应用窗口加载回环地址。界面、`client.mjs`、`/v1/ui/*` 校验全部复用，未新增数据协议。

实测确认的事实：

- Electron 45.4.1 内置 Node 24.22.3，`node:sqlite`、ESM 导入、`playwright-core` 均可用，现有代码无需改动
- 同档案同端口二次启动得到 `EADDRINUSE`，故 `requestSingleInstanceLock()` 是必需而非可选
- 窗口关闭时 `before-quit` 等待 `service.close()`，进行中任务置为 `cancelled`
- 页面内 `require` 与 `process` 均不可用，沙箱生效

Electron 二进制从 GitHub Releases 下载，网络受限时 `npm install` 不会报错但二进制缺失，首次 `require('electron')` 才触发下载。

框架选型结论：第一版 Electron 最合适（唯一不改采集器且已验证）；若安装包体积成为问题可换 Tauri，届时界面与采集核心可保留，只重写外壳与 Node 子进程管理；不建议用 Node 单文件程序做正式版，因其无法做到"关闭窗口即停止采集"。

### 知识画像协议

新增 `zhihu-knowledge-profile/v1`，与版本 3 **并存**而非替换（版本 3 仍被既有测试与导出依赖）。

单条记录由 22 字段精简为 20 个画像相关字段。**保留** `url` 与 `author`（用户明确选择，用于结论溯源）；**剔除** `key`、`kind`、`sourceReadTime`、`observedAt`、`metadataStatus`、`weightDetails`、`analysis` 内部指纹。

顶层新增 `coverage` 明示能力边界：`modelAnalysisApplied: false`、`historyScope: latest_50_qualified`、`completeHistory: false`、`fullTextGuaranteed: false`。

模块自描述：`GET /v1/agent/format` 与工具 `zhihu_collection_format` 返回字段含义与消费注意事项，Agent 无需外带文档。

### Agent 工具收敛为只读

工具由 3 个调整为 4 个，**全部只读**：`zhihu_collection_status`、`zhihu_collection_format`、`zhihu_knowledge_profile`、`zhihu_collection_read`。

移除同步工具。两道拦截：工具层对 `zhihu_collection_sync` 明确回绝；HTTP 层对 `agt_` 角色越出 `GET /v1/agent/*` 一律 403 `READ_ONLY`。实测两者均生效。

### 静默定时同步

定时档原已存在。本次改为自动触发时不弹成功提示、失败也不弹错误框，仅更新状态行。

**未做完全后台采集**：保留调用方租约机制，关闭界面后 90 秒内任务被 `CLIENT_OFFLINE` 取消。完全隐形采集需关闭该机制，等于允许程序在用户不知情时读取其账号数据，属安全模型变更，需用户明确要求。

### 剪贴板缺陷修复

`public/app.js` 的 `copy()` 原先只检查 API 是否存在，未捕获 `NotAllowedError`。回环 HTTP 源下 `clipboard-write` 权限为 `denied`，导致"复制 MCP 配置"报错。

已加 `execCommand('copy')` 回退并补 `.offscreen` 样式。实测权限仍为 `denied` 但复制成功，无残留 DOM。

同期排除一个误报：控制台的 CSP 内联样式违规来自自动化工具注入的覆盖层（带 `z-index: 2147483647` 与 Electron 专属属性），非页面缺陷，无需修改。

---

## 外部事实核查结论

**知乎 AI Works 不能用于部署本模块。** 黑客松 S3 官方 FAQ 写明适用范围为"前端 + Node 后端的全栈项目，**不含数据库写入**"，而本模块核心是 SQLite 事务写入；更根本的是采集需拉起本机浏览器，云端无法完成。官方建议常规项目用 CloudBase 或云主机。

**OAuth 无法替代本机浏览器登录。** `data-collection/OAUTH.md` 依官方文档记载：OAuth 不提供浏览历史、点赞行为。知识画像最核心的两类信号只能从网页内部接口取得。

---

## 待办（按建议优先级）

1. **`/v1/status` 补充设备本机同意范围**。当前前端无法预知可勾选类型，用户要等采集跑完才拿到 `CONSENT_SCOPE_MISMATCH`。涉及 worker 与服务端协议改动。
2. **设置字段定义收敛到单一来源**，消除三处白名单导致的静默丢弃。
3. **任务细粒度进度**，当前只有 `queued`/`running`，前端只能转圈。
4. **决定提交范围**，全部改动仍未提交。

---

## 不变量（修改前务必阅读）

以下约束构成模块的安全承诺，任何改动不得绕过：

1. **登录与同意只能在采集设备完成**，`/v1/ui/*` 的回环 + 同源 + `localControl` 三重校验不可放宽。
2. **服务端不能扩大本机同意范围**，`worker.mjs` 的 `checkGrant()` 以本机 grant 为上限。
3. **Agent 只读**，`agt_` 角色不得获得同步、登录、设置、删除能力。
4. **关闭界面即停止采集**，调用方租约不续期即取消任务。
5. **交付对象不含凭证**，不传 Cookie、Token、浏览器目录；账号以 `sha256("zhihu:" + ID)` 摘要绑定。
6. **不伪装能力**：`aiReview` 保持 `false`；摘要不得当作全文；`weight` 不得解释为掌握程度。
