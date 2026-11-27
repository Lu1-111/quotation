# Agent 工具对接说明

Agent 调用不依赖网页。现有搜索服务封装为三个 tools，支持 Node.js 进程内执行和标准 MCP stdio 两种接入。工具层复用同一套官方接口、匹配和存储逻辑；可视化页面继续用于人工调试。

调用链路为：模型提出工具调用 → Agent 宿主校验并分发 → 工具执行器 → 搜索服务／官方接口／SQLite → 结构化结果交给宿主 → 宿主将必要数据提供给模型。实际网络请求由宿主运行的代码完成，密钥不作为模型参数或结果传输。

## 工具清单

| 工具名 | 输入 | 返回与用途 |
| --- | --- | --- |
| `zhihu_search` | 查询语句、关键词、标签词、匹配模式、查询预算和返回长度 | 执行搜索并保存成功快照，返回第一批内容及 `requestId` |
| `zhihu_get_search_result` | `requestId`、`offset`、`limit`、`excerptMaxChars` | 读取指定快照的另一批内容，不调用知乎 |
| `zhihu_search_status` | `{}` | 配置是否齐全、演示模式、忙碌状态与限制，不返回凭证或本机文件路径 |

`agent-tools.mjs` 的 `getToolDefinitions()` 和实例的 `definitions` 提供 `name`、中文描述、`inputSchema`、`outputSchema` 与行为注解；参数校验和公开的 JSON Schema 来自同一份 `tool-schemas.mjs`。未知工具、未知参数和无效类型会被拒绝，不接收 Cookie、密钥、任意 URL 或写入路径等模型参数。

## Node.js Agent：进程内调用

先在 `information-search/` 运行 `npm ci`。由宿主注入 `ZHIHU_ACCESS_SECRET`；使用 `.env` 时，在启动宿主的 Node 命令中加入 `--env-file-if-exists=<本机配置路径>`。导入模块不会自动读取 `.env`、启动服务器或打开网页。

```javascript
import { createLocalAgentTools } from './agent-tools.mjs';

const runtime = createLocalAgentTools();
try {
  // 将这些定义交给 Agent 框架的工具注册层。
  const definitions = runtime.definitions;

  // 收到模型的工具调用后，由宿主执行；也接受 JSON 字符串参数。
  const result = await runtime.call('zhihu_search', {
    keywords: ['RAG', '评测'],
    tags: ['人工智能'],
    keywordMode: 'all',
    maxQueries: 2,
    limit: 8
  });
  if (!result.ok) {
    console.error(result.error.code, result.error.message);
  } else {
    // result.data.items 可交给后续内容分析模块。
    console.log(result.data.page);
  }
} finally {
  await runtime.close();
}
```

实际 Agent 应在会话启动时创建一个长期复用的实例，关闭会话时调用 `close()`，不要每次工具调用都新建实例。示例相对路径适用于文件位于本模块内；其他模块需调整导入路径。

使用 `type: 'function'` 格式的工具注册层时，可这样转换定义：

```javascript
const modelTools = runtime.definitions.map(({ name, description, inputSchema }) => ({
  type: 'function',
  function: { name, description, parameters: inputSchema }
}));

// call 是模型输出的工具请求；各框架的消息字段可能不同。
const result = await runtime.call(call.function.name, call.function.arguments, { signal });
// 宿主应把 JSON.stringify(result) 作为该工具调用的结果消息回传，保留调用 ID。
```

`runtime.call()` 不执行模型输出的代码，仅按允许的工具名分发并验证参数。实际模型仍需支持工具调用，由宿主维护消息循环、工具调用 ID 和最多调用轮数。此模块不绑定某种模型或 Agent 框架。

已有共享搜索服务时，可用 `createAgentTools({ service, store, configured, demo })` 包装；此时 `store` 必须实现 `get()`，并与服务保存快照所用的存储一致，存储生命周期默认仍由调用方管理。`createLocalAgentTools()` 创建并管理自己的 SQLite 连接，默认数据文件固定在本模块 `.data/`，不受宿主工作目录影响；也可由宿主设置 `dataFile` 或 `DATA_FILE`。

## 标准 MCP：供其他语言或桌面宿主接入

本模块使用官方 MCP SDK 提供 stdio 服务。工具定义由 `tools/list` 发现，调用通过 `tools/call` 完成，不需要先运行网页服务。Python Agent 或桌面 Agent 只要具有 MCP 客户端，就可以用相同工具协议连接。

配置示意如下，替换为本机绝对路径，具体外层配置格式以 Agent 宿主为准：

```json
{
  "mcpServers": {
    "zhihu-search": {
      "command": "node",
      "args": [
        "--env-file-if-exists=C:/path/to/quotation/information-search/.env",
        "C:/path/to/quotation/information-search/mcp-server.mjs"
      ]
    }
  }
}
```

正式模式使用已有 `.env` 中的 `ZHIHU_ACCESS_SECRET`，不需要把密钥写进工具描述或聊天提示词。演示模式在 `args` 最后加入 `--demo`，只读取合成数据。模块目录中的 `npm run mcp` 和 `npm run mcp:demo` 可用于手动启动；宿主配置应直接调用 `node`，避免 npm 的启动提示混入标准输出。

MCP 标准输出仅传输协议，启动提示写入标准错误。宿主关闭标准输入、断开连接或取消请求时，中止进行中的工作并释放连接。MCP 入口不创建浏览器窗口、不绑定网页端口；它随 Agent 宿主的子进程生命周期运行，与个人历史采集“只在同步网页开启时运行”的约束属于不同模块。

本模块遵循 [MCP 工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)，传输使用 [官方 SDK 的 stdio 实现](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html)。未在特定桌面宿主中自动安装配置；集成测试通过标准 MCP 客户端启动真实子进程验证协议链路。

## 搜索参数与返回预算

`zhihu_search` 直接接受以下字段，不需要再包一层 `criteria`：

| 字段 | 规则与默认值 |
| --- | --- |
| `query` | 可选召回语句，最多 240 字符；与 `keywords`、`tags` 至少提供一种 |
| `keywords`、`tags` | 各最多 8 个非空词，每个最多 60 字符；标签按标题、摘要文本匹配 |
| `keywordMode`、`tagMode` | `any` 或 `all`，默认 `any`；两组之间同时满足 |
| `contentTypes` | 可选内容类型数组，支持 `article`、`answer`、`question`、`pin`、`zvideo` |
| `sortBy` | 可选官方排序及范围，例如 `VoteUpCount:desc`、`CreateTime:desc`、`CommentCount:none:(10,)`；默认优先相关性，只有明确需要时间或热度时指定 |
| `countPerQuery` | 每个官方查询最多 1 至 10 条，默认 10 |
| `maxQueries` | 最多 1 至 6 个查询，工具默认 2；可能因去重和缓存减少实际调用 |
| `refresh` | 默认 `false`；`true` 跳过 5 分钟缓存，可能消耗新额度 |
| `limit` | 本次返回 1 至 20 条，默认 8，不改变已经保存的结果数量 |
| `excerptMaxChars` | 每条摘要返回 100 至 4000 个字符，默认 1000，按 Unicode 字符裁剪 |

`zhihu_get_search_result` 必须提供 `requestId`，`offset` 默认 0，另外支持相同的 `limit` 和 `excerptMaxChars`。按 `page.nextOffset` 继续读取，直到 `page.hasMore` 为 `false`。官方没有公开搜索分页参数，本地读取不会扩大已经召回的内容范围。

## 返回协议

所有工具返回版本为 1 的对象，成功时为 `{ schemaVersion: 1, ok: true, data: {...}, error: null }`，失败时为 `{ schemaVersion: 1, ok: false, data: null, error: { code, message, retryable } }`。

搜索与读取结果的 `data` 包含：

| 字段 | 含义 |
| --- | --- |
| `requestId`、`createdAt`、`provider` | 本地快照标识、搜索时间和真实／演示来源 |
| `criteria`、`queryPlan` | 规范化搜索条件与实际执行的查询计划 |
| `coverage` | 仅摘要、文本标签匹配、无官方分页等能力边界 |
| `stats` | 该快照创建时的接口调用数、缓存命中数、去重与匹配数量；读取不产生新的调用 |
| `page` | `offset`、`limit`、`total`、`returned`、`hasMore`、`nextOffset` |
| `items` | 标题、裁剪摘要、原始溯源链接、作者、类型、互动数、时间、排序分数及匹配证据 |
| `contentTrust` | `external_untrusted`，表示内容来自外部来源，不能作为宿主指令执行 |

每条内容保留 `contentId` 字符串、`matches` 与 `matchedQueries`，便于引用和追溯。`excerptTruncated` 表示摘要是否被工具裁剪；匹配证据基于保存的完整官方摘要，因此命中词可能位于被裁剪的部分。`fullTextAvailable` 固定为 `false`，`platformTags` 为 `null`，后续模型不应将摘要当作全文，也不应把标签词当作知乎原生话题标签。

工具只向模型返回必要字段，不重复发送多个摘要版本、完整查询响应与精选评论。本机快照仍保存这些已有字段，可通过原有 HTTP JSON 导出或存储层交给可信的后续模块。工具返回的 `schemaVersion` 是工具外层协议版本，`requestId` 关联原有搜索快照，不改动底层快照结构。

MCP 返回相同对象于 `structuredContent`，同时提供序列化 JSON 文本和 `isError`；宿主应优先读取结构化对象，避免把两个副本都塞进模型上下文。

## 执行控制与错误处理

每个工具实例同时只执行一个搜索，状态查询与已保存结果读取可以继续。总执行时限默认 90 秒，可由宿主创建实例时设置 `timeoutMs`；单次官方请求仍有自己的超时。宿主取消信号会传给实际搜索请求，失败或取消不覆盖之前成功的快照，已完成的单查询缓存可继续复用。

| 错误码 | 宿主处理方式 |
| --- | --- |
| `INVALID_ARGUMENTS`、`INVALID_CRITERIA` | 修正参数后再调用 |
| `NOT_CONFIGURED`、`UPSTREAM_AUTH` | 由宿主检查配置，不让模型索取或编造密钥 |
| `RATE_LIMITED` | 暂停调用，检查频率／额度；不标记为可自动重试 |
| `BUSY` | 等待当前搜索结束或由宿主取消 |
| `NETWORK_ERROR`、`TIMEOUT` | 可在宿主有限重试策略内处理，必要时减少预算 |
| `NOT_FOUND` | 核对 `requestId` 和所使用的本地数据库 |
| `CANCELLED`、`CLOSED` | 停止当前工作；关闭后的实例需重新创建 |

`retryable: true` 仅提示宿主可以考虑有限重试，不触发工具内部自动重试。未知异常转为安全的 `INTERNAL_ERROR`，不把原始堆栈或上游消息回传给模型。查询次数预算只限制单次搜索，Agent 整个会话的轮次与总额度应由宿主统一管理。

## 验证

在本模块运行 `npm test`，覆盖现有搜索逻辑、工具参数与输出、摘要裁剪、本地分页、错误脱敏、取消、超时、忙碌控制，以及标准 MCP 客户端通过 stdio 启动子进程并调用三个工具。常规测试使用合成数据，不消耗真实知乎额度。
