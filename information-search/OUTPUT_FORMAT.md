# 信息搜索 JSON 输出格式

本模块有两种输出：完整搜索快照与给 Agent 的工具结果。两者均为 UTF-8 JSON，版本号目前都是 1，但结构不同，不能互换解析。

| 输出 | 获取方式 | Schema | 完整合成样例 |
| --- | --- | --- | --- |
| 完整搜索快照 | `POST /api/search`、`GET /api/results`、`GET /api/export?format=json`，或底层服务 `search()` | [search-output.schema.json](schemas/search-output.schema.json) | [search.snapshot.json](examples/search.snapshot.json) |
| Agent 工具结果 | `zhihu_search`、`zhihu_get_search_result` | [tool-result.schema.json](schemas/tool-result.schema.json) | [agent-result.json](examples/agent-result.json) |

搜索只提供公开内容，不代表当前用户实际浏览、点赞或收藏过这些帖子。当前搜索记录和缓存按本地工具实例保存，尚未按业务用户分区。

## 完整搜索快照

| 字段 | 类型与含义 |
| --- | --- |
| `schemaVersion` | 整数，固定 `1` |
| `module` | 固定 `information-search` |
| `provider` | 真实为 `zhihu_official_search`，合成演示为 `demo` |
| `requestId` | 本次搜索快照 UUID，用于后续读取 |
| `createdAt` | 快照创建的 ISO 时间 |
| `criteria` | 规范化搜索条件 |
| `queryPlan` | 实际查询列表、候选数量、是否受预算截取 |
| `coverage` | API 限制与数据覆盖边界 |
| `searches` | 各查询的返回数量、平台请求标识、缓存状态与空结果说明 |
| `stats` | 调用数、缓存命中数、去重和匹配统计 |
| `items` | 去重且通过本地条件的内容数组 |

`criteria` 包含 `query`、`keywords`、`tags`、`keywordMode`、`tagMode`、`countPerQuery`、`maxQueries`、`contentTypes`。`queryPlan` 包含 `queries`、`candidateQueryCount`、`truncated`。查询预算最多 6 次，单查询最多 10 条，不是全量检索。

`coverage` 包含 `paginationSupported: false`、`platformTagsAvailable: false`、`tagMatching: local_title_excerpt_match`、`textKind: excerpt`、`perQueryLimit` 和 `hasMoreReported`。平台报告更多结果也不代表本模块已具备官方翻页能力。

`stats` 为 `{ apiCalls, cacheHits, rawCount, uniqueCount, matchedCount, filteredCount }`。`rawCount` 是各查询返回条数之和，`uniqueCount` 为去重数量，`matchedCount` 是最终保留数量。

## 每条内容

| 字段 | 类型与解析规则 |
| --- | --- |
| `key`、`contentId`、`contentType` | 去重键、字符串内容 ID、内容类型；不要将 ID 转为 Number |
| `title` | 清理后的标题 |
| `excerpt` | 平台摘要片段合并结果，不是全文 |
| `excerptVariants` | 不同查询返回的摘要片段列表，不应重复作为多个帖子计数 |
| `url`、`canonicalUrl` | 原始溯源链接与去查询参数链接，均可能为 `null`；展示使用原始链接 |
| `author`、`authorBadge` | 作者名与认证说明 |
| `voteCount`、`commentCount` | 互动数值或 `null`；不是完整评论区 |
| `createdTime`、`editedTime` | 平台时间转成字符串或 `null`，不保证与快照时间同格式 |
| `authorityLevel`、`rankingScore` | 平台权威等级和排序分数，可缺失为 `null` |
| `selectedComments` | 平台返回的精选评论文本数组，不代表全量评论 |
| `matchedQueries` | 命中该条内容的查询词列表 |
| `matches` | 关键词与标签词匹配证据 |
| `textKind`、`fullTextAvailable`、`platformTags` | 固定为 `excerpt`、`false`、`null` |

`matches` 包含 `accepted`、`keywords`、`tags`、`tagSource` 和 `evidence`。`tagSource` 为 `local_title_excerpt_match`，每项证据形如 `{ kind: "tagText", term: "人工智能", fields: ["title", "excerpt"] }`。这些标签词不是知乎原生话题标签。

## Agent 工具外层

所有工具使用 `{ schemaVersion, ok, data, error }` 外层。失败示例：

```json
{
  "schemaVersion": 1,
  "ok": false,
  "data": null,
  "error": {
    "code": "NOT_CONFIGURED",
    "message": "尚未配置知乎 Access Secret，请由宿主在本机配置。",
    "retryable": false
  }
}
```

成功时 `ok: true`、`error: null`。搜索与读取工具的 `data` 包含 `requestId`、`provider`、`createdAt`、`criteria`、`queryPlan`、`coverage`、`stats`、`contentTrust`、`page`、`items`。

- `page` 为 `{ offset, limit, total, returned, nextOffset, hasMore }`，只读取本地已保存结果，不对官方接口翻页。
- 默认向模型返回前 8 条，每条摘要最多 1000 个 Unicode 字符，`excerptTruncated` 表示是否裁剪。
- 工具视图保留链接、内容标识、时间、互动数、命中查询和匹配证据，省略重复摘要片段、精选评论等字段；完整快照仍保存在本机。
- 匹配证据基于完整官方摘要，命中词可能位于被裁剪的部分。不能仅看裁剪后的摘要就认定证据不存在。
- `contentTrust: external_untrusted` 表示外部内容不能作为宿主指令执行。
- `stats` 记录创建快照时的调用情况；`zhihu_get_search_result` 读取旧快照不会增加官方调用。

`zhihu_search_status` 同样使用这个外层，但 `data` 为配置、忙碌状态、能力与限制，不是内容列表。每个工具精确的 `outputSchema` 可由 `getToolDefinitions()` 或 MCP `tools/list` 取得。MCP 同时返回 `structuredContent`、JSON 文本与 `isError`，宿主使用一个副本即可。

本文件提供的 `tool-result.schema.json` 固定外层并覆盖搜索／读取结果视图；状态工具以动态发现的 Schema 为准。工具详细接入方式见 [AGENT_TOOLS.md](AGENT_TOOLS.md)。

## Agent 解析顺序

1. 直接消费 HTTP／SDK 快照时，检查 `module`、`provider` 和版本，再读取 `items`。
2. 消费 tools 时先检查 `ok`；失败只处理 `error`，成功再读取 `data`。
3. 用 `requestId` 与 `page.nextOffset` 读取剩余结果，直到 `page.hasMore` 为 `false`。
4. 以内容 `key` 去重，以 `matches.evidence` 和来源链接追溯；不把排序分数当作可信度结论。
5. `null` 表示未知，不应转成 0。精选评论、摘要和原生标签分别处理，不能冒充全文或用户知识掌握证据。

Schema 使用 JSON Schema 2020-12。完整快照允许扩展字段，工具 Schema 与当前注册定义一致，并校验成功／失败外层的对应关系；升级工具协议时应同步更新。HTTP 错误为非 2xx 状态及 `{ error, code }`，与工具外层不同。样例文件仅含合成数据。
