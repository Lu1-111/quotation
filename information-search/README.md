# 知乎信息搜索模块

本模块通过知乎数据开放平台的官方搜索 API 获取内容，按调用方给出的关键词、标签词和内容类型筛选结果，提供 Agent tools、MCP、HTTP 接口与可直接导入的 JavaScript 模块。网页是可选的人工调试入口；Agent 调用无需启动网页或 HTTP 服务。

文件夹和文件名使用英文，界面、说明与错误提示使用中文。本模块与 `data-collection/` 的个人浏览历史采集相互独立，不读取知乎网页登录会话，也不依赖 OAuth 应用凭证。Access Secret 仅在本机后端使用，不传给浏览器。

## 官方接口能力与边界

依据 2026 年 11 月 21 日读取的知乎数据开放平台文档与官方开发包参考：

| 项目 | 当前接口能力 |
| --- | --- |
| 地址 | `GET https://developer.zhihu.com/api/v1/content/zhihu_search` |
| 鉴权 | `Authorization: Bearer <Access Secret>` 与秒级 `X-Request-Timestamp` |
| 参数 | `Query` 查询词，`Count` 单查询数量，最多 10 条 |
| 分页 | 文档未提供偏移或游标参数，`HasMore` 当前文档为 `false`；模块不构造分页 |
| 内容 | 标题、摘要、链接、作者、赞同／评论数、时间、权威等级、排序分数及可选精选评论 |
| 原生标签 | 没有公开的标签／话题过滤参数，返回字段未提供原生话题标签 |
| 全文 | `ContentText` 按官方摘要字段处理，不能声称已获取全文 |

本版按用户确认采用“标签词文本匹配”：标签词参与查询召回，并在标题、摘要中进行本地匹配。它不代表已命中知乎原生话题，结果中 `platformTags` 固定为 `null`，`matches.tagSource` 明确标为 `local_title_excerpt_match`。

官方返回的带 UTM 溯源链接保留在 `url`，用于展示和导出；另外生成去掉查询参数的 `canonicalUrl` 供关联使用。精选评论不是完整评论区；不同查询命中同一内容时保留摘要片段列表，不拼成“全文”。

参考：[知乎数据开放平台](https://developer.zhihu.com/)、[官方开发包](https://developer-cdn.zhihu.com/zhihu-cli/releases/stable/skill/zhihu-cli-skill.zip)。本模块直接集成 HTTP 协议，没有安装或执行该开发包中的 CLI。

## 本地运行

需要 Node.js 24+。Agent 工具使用 Zod 校验参数，MCP 入口使用官方 `@modelcontextprotocol/server` SDK；`@modelcontextprotocol/client` 只用于开发测试。以下网页调试命令在模块目录执行：

```powershell
cd information-search
npm ci
if (-not (Test-Path -LiteralPath '.env')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env'
}
npm start
```

在本机 `.env` 填入 `ZHIHU_ACCESS_SECRET`，打开 <http://127.0.0.1:3002/>。已有 `.env` 不要覆盖。默认配置如下，实际密钥不提交到仓库：

```text
HOST=127.0.0.1
PORT=3002
APP_ORIGIN=http://127.0.0.1:3002
ZHIHU_ACCESS_SECRET=在本机填写
```

无需真实凭证时，可停止占用同一端口的服务后运行：

```powershell
npm run demo
```

演示只使用合成数据，保存在 `.data/demo.sqlite`；真实模式保存到 `.data/search.sqlite`，可通过 `DATA_FILE` 指定。默认缓存有效期 5 分钟。演示和真实查询的缓存键、数据库默认位置相互区分。

模块不会定时搜索，只在点击搜索或显式调用接口／函数时执行。网页取消或关闭会中止对应请求；失败或取消不覆盖上一次成功结果。已经完成的单查询缓存可以保留，供后续复用。

## 搜索条件

```json
{
  "query": "RAG 评测方法",
  "keywords": ["RAG", "评测"],
  "tags": ["人工智能", "知识库"],
  "keywordMode": "any",
  "tagMode": "any",
  "countPerQuery": 10,
  "maxQueries": 4,
  "contentTypes": ["article", "answer"]
}
```

- `query` 用于官方召回，不单独作为本地必须命中的条件，最多 240 字符。
- `keywords`、`tags` 为字符串数组，各最多 8 项，每项最多 60 字符，去重并统一大小写匹配。
- 查询语句、关键词和标签词至少填写一种。
- `keywordMode`、`tagMode` 各支持 `any` 或 `all`；关键词组和标签词组之间同时满足。未填写的组不限制结果。
- 匹配范围为标题和摘要，不用作者名或精选评论凑匹配。英文词使用边界判断，允许与中文相邻，避免把 `AI` 误匹配到 `railway`。
- `contentTypes` 为空表示不限；可指定 `article`、`answer`、`question`、`pin`、`zvideo`。这只是本地结果过滤，不表示平台一定召回这些类型。
- `countPerQuery` 为 1 至 10，`maxQueries` 为 1 至 6，默认分别为 10 和 4。最多查询次数是上限，命中缓存可减少实际调用。

模块先构造组合查询，再加入关键词和标签词的独立查询，按预算去重截取；随后合并结果、执行本地条件、按官方排序分数排列。组合词作为普通 `Query` 文本发送，不使用未公开的 `TopicID`、`Filter`、`Offset` 或标签运算符。

查询预算可能截断候选计划，最终数量也可能因去重或严格匹配而少于请求数；这不是全量检索，不保证召回所有相关内容。减少标签或改为任意匹配可扩大本地保留范围。

## HTTP 接口

服务只绑定本机地址，不开放任意跨域访问，POST 的 `Origin` 必须与 `APP_ORIGIN` 相同。它没有面向公网的账号鉴权，不能直接作为多用户公网服务部署。

| 接口 | 用途 |
| --- | --- |
| `GET /api/status` | 返回是否已配置、是否演示及能力边界，不返回密钥 |
| `POST /api/search` | 请求体为 `{ "criteria": { ... }, "refresh": false }` |
| `GET /api/results` | 读取最后一次成功结果，不产生平台调用 |
| `GET /api/results?id=<requestId>` | 读取指定的成功结果 |
| `GET /api/export?id=<requestId>&format=json` | 下载相同的结构化 JSON |
| `GET /api/export?id=<requestId>&format=markdown` | 下载可读 Markdown 报告 |

同源网页调用示例：

```javascript
const response = await fetch('/api/search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    criteria: { keywords: ['RAG'], tags: ['人工智能'], maxQueries: 2 },
    refresh: false
  })
});
const snapshot = await response.json();
if (!response.ok) throw new Error(snapshot.error);
```

`refresh: true` 跳过缓存，可能消耗新的平台额度。同一 HTTP 服务一次只接受一个执行中的搜索，重叠请求返回 409；调用方可以取消后重新提交。接口不在后台自动重试或翻页。

常见错误：400 参数无效，401 上游凭证无效／权限不足，403 请求来源不符，404 尚无结果，409 已有任务运行，413 请求过大，429 频率或额度受限，502 上游网络或响应异常，503 未配置凭证。错误体只返回安全的 `error` 与 `code`，不回显上游鉴权头或原始错误消息。

## 供 Agent 直接调用的工具

已实现独立于界面的三个工具，输入与输出均提供 JSON Schema：

| 工具 | 功能 |
| --- | --- |
| `zhihu_search` | 官方搜索、匹配、缓存、保存快照，返回经过长度限制的结构化结果 |
| `zhihu_get_search_result` | 按 `requestId` 分批读取已经保存的结果，不再次调用知乎 |
| `zhihu_search_status` | 检查配置、运行状态和能力边界，不回传密钥 |

Node.js Agent 可从 `agent-tools.mjs` 导入 `createLocalAgentTools()`，将 `definitions` 注册到宿主并通过 `call(name, arguments, { signal })` 执行。支持标准 MCP 的本地 Agent 可以启动 `mcp-server.mjs`，通过标准输入输出发现并调用这些工具，无需浏览器、网页端口或个人账号登录。

工具默认最多执行 2 个查询、返回前 8 条内容，每条摘要最多 1000 个字符；完整官方摘要与结果快照保存在本机，可按结果标识继续读取。这里的“分批读取”是本地已保存结果的分页，不增加官方搜索的分页能力。工具具有总执行时限、取消传播、重复任务拦截与稳定的错误码，不自动无限重试。

详细接入、MCP 配置、返回协议与调用示例见 [Agent 工具对接说明](AGENT_TOOLS.md)。本模块没有内置推理模型或自动运行的 Agent；由你们的 Agent 宿主决定何时调用。

## 底层 JavaScript 服务调用

```javascript
import { createOfficialClient } from './official-client.mjs';
import { createInformationSearch } from './search.mjs';
import { createSearchStore } from './store.mjs';

const store = createSearchStore('.data/search.sqlite');
const client = createOfficialClient({ accessSecret: process.env.ZHIHU_ACCESS_SECRET });
const service = createInformationSearch({ client, store });
try {
  const snapshot = await service.search({ keywords: ['RAG'], tags: ['人工智能'], maxQueries: 2 });
  // 将 snapshot.items 交给后续本地分析模块，不传递 Access Secret。
  console.log(snapshot.stats);
} finally {
  store.close();
}
```

示例文件位于本模块时可直接使用相对导入；其他模块应调整导入路径。SDK 不要求浏览器 Cookie，可直接由可信的本地协调器调用；`store` 可省略以采用调用方自己的存储。需要取消时向 `search()` 第二个参数传入 `{ signal }`。

只导入 `server.mjs` 不会自动监听端口，HTTP 服务由其显式入口启动。`createSearchHttpServer()` 可供后续应用组装使用。当前没有接入 LLM 或用户领域分析，不推断读者已掌握相关知识。

## 输出协议

快照为 `schemaVersion: 1`，与个人数据采集模块的版本 3 是不同协议：

| 字段 | 含义 |
| --- | --- |
| `module`、`provider` | `information-search`，真实来源为 `zhihu_official_search` |
| `requestId`、`createdAt` | 本次结果标识与 UTC 时间 |
| `criteria`、`queryPlan` | 规范化条件、实际查询列表、候选数及是否被预算截取 |
| `searches` | 各查询的官方请求标识、返回数量、空结果说明与缓存状态 |
| `coverage` | 单查询限制、无公开分页、无原生标签、仅摘要等范围声明 |
| `stats` | 实际调用、缓存命中、原始数量、去重数量、匹配数量和过滤数量 |
| `items` | 匹配成功的标准化内容 |

每条内容包含字符串 `contentId`、`contentType`、`key`、标题、摘要、摘要片段、原始链接、规范链接、作者与认证说明、互动数、创建／编辑时间、权威等级、平台排序分数、精选评论、命中查询与匹配证据。没有返回的字段使用 `null` 或空数组，不把缺失值编造成 0。

`excerptVariants` 保留不同查询对同一内容返回的摘要片段，`excerpt` 合并这些片段方便筛选和阅读，仍为摘要。`matches` 包含命中关键词、标签词、字段及匹配来源。`fullTextAvailable` 为 `false`，`platformTags` 为 `null`，后续 Agent 必须遵守这些边界。

SQLite 的 `query_cache` 缓存官方单查询结果，`search_snapshots` 保存成功的完整搜索快照。局部失败不写入新的最终快照，旧结果仍可读取；错误批次不会伪装成完整成功。当前不提供自动删除、跨设备同步或多用户隔离接口。

## 文件与验证

```text
official-client.mjs   官方协议、鉴权、字段标准化与演示适配
search.mjs            条件校验、查询计划、匹配证据、去重和预算
store.mjs             SQLite 单查询缓存与成功结果存储
report.mjs            Markdown 导出
server.mjs            本机 HTTP 服务和应用入口
agent-tools.mjs       与框架无关的 Agent 工具执行、结果裁剪、取消与生命周期
tool-schemas.mjs      工具输入／输出校验与 JSON Schema 定义
mcp-server.mjs        无界面的标准 MCP stdio 入口
AGENT_TOOLS.md        Agent 宿主与 MCP 接入说明
public/               中文搜索界面
test/                 协议、条件、缓存、取消、HTTP 与 MCP 完整调用测试
.env.example          无密钥的配置模板
```

```powershell
npm test
```

常规测试使用合成数据，不消耗知乎额度。真实接口核验应单独执行最小请求，先确认已配置凭证，不在日志、截图、文档或提交中输出实际密钥。
