# 「报价」后端 `/v1` HTTP 与 SSE 对接契约

协议标识：`quotation-backend/v1`，外层版本：`schemaVersion: 1`。\
Schema：[http-api-v1.schema.json](schemas/http-api-v1.schema.json)（JSON Schema Draft 2020-12，`data.oneOf` 各分支严格互斥）。\
合成会话快照样例：[session-snapshot-v1.json](examples/session-snapshot-v1.json)。\
合成单轮 SSE 事件流样例：[sse-turn-events-v1.json](examples/sse-turn-events-v1.json)。\
纯算价与星图前端消费样例：[frontend-consume-sample.json](../quotation-engine/examples/frontend-consume-sample.json)。

## 1. 同源保护、主体鉴别、材料开关与云同意门禁

- 除 `GET /health` 外，所有 `/v1/*` 请求均需携带 `Authorization: Bearer <token>`（通过同源合成宿主访问页面时，由宿主基于 `HttpOnly` 会话 Cookie 在服务端内存附加内部 Bearer）。
- 服务端逐请求校验 `Host` 与允许的 `Origin`（默认绑定本机 `127.0.0.1:<port>`），跨源返回 `403 ORIGIN_DENIED`，非法 `Host` 返回 `403 HOST_DENIED`。
- 会话、轮次提交、SSE 事件流与主动取消均逐一校验 `ownerId` 所有权：
  - 缺失或未知凭证：`401 UNAUTHORIZED`
  - 已吊销凭证：`401 TOKEN_REVOKED`
  - 跨主体访问他人会话或事件流：`403 SESSION_FORBIDDEN`
  - `demo` 与 `real` 模式混用：`403 DATA_MODE_MISMATCH`（默认数据库亦按 `sessions-demo.sqlite` 与 `sessions-real.sqlite` 物理隔离）
- **同源合成宿主（P1-C，`cd agent && npm run serve:demo:web`）**：
  - 入口为 `agent/demo-web-host.mjs`，默认监听回环地址 `127.0.0.1:3008`，在单一来源下同时托管 `frontend-design/web/` 正式星图页面与 `/v1/*` 后端接口，使用独立 SQLite（默认 `.data/sessions-demo-web.sqlite`）与合成材料，零外部凭证可运行。
  - 宿主在服务端内存管理内部 Bearer，页面访问 `/`、`index.html` 或调用 `POST /api/host/session` 时签发不透明的 `HttpOnly; SameSite=Strict; Path=/` 同源会话 Cookie，仅代理允许的浏览器 `/v1` 路由（`POST /v1/sessions`、`GET /v1/sessions/:id`、`POST /v1/sessions/:id/turns`、`GET /v1/sessions/:id/turns/:turnId/events`、`POST /v1/sessions/:id/turns/:turnId/cancel`），并额外校验 `Sec-Fetch-Site`；内部 Bearer 绝不下发至浏览器。
  - 显式携带 `Authorization: Bearer <token>` 的直接 API 请求继续保持兼容，不依赖浏览器 Cookie。
- 会话级个人材料开关 `usePersonalMaterials` 持久化与恢复：
  - `POST /v1/sessions` 显式传 `usePersonalMaterials: false` 时强制关闭个人采集读取（`materialsStatus.state = "disabled_by_user"`，`lockedSnapshotId = null`），会话创建、后续多轮提交及服务进程重启后均严格保持零采集调用，仍可正常分析本人当轮输入与公开检索摘要。
  - 启用个人材料时，会话锁定首个采集快照 `lockedSnapshotId`，后续跨页与按需补读均固定携带同一 `snapshotId`。
- **本机回环与非本机云推理同意门禁、持久化撤回与外发预览绑定（P0-A，`CLOUD_CONSENT_REQUIRED`）**：
  - **本机回环推理地址**（`127.0.0.0/8`、`localhost`、`::1`、`::ffff:127.0.0.0/8`）：在 `demo` 与 `real` 模式下均继续按本机材料授权运行，可直接使用本人已授权材料，即使省略 `cloudConsent` 或传 `cloudConsent: false` 也不触发云门禁。
  - **持久化撤回语义**：`POST /v1/sessions/:id/turns` 在完成身份、会话所有权与模式校验后，若请求显式传入 `cloudConsent: false`，服务端先将撤回状态持久化落库，并以最新状态重算会话内所有兼容字段（`cloudConsent`、`allowCloudModel`、`metadata.cloudConsent`、`outboundPreview`）；重复撤回幂等且不递增 `graphVersion`，同时向该会话正在运行的相关云轮次发送取消信号（`AbortSignal`）。发起云模型调用前会再次核对最新持久化授权。后续轮次省略 `cloudConsent` 时严格沿用已持久化的值（跨服务重启保持生效），保持拒绝且模型调用次数为 0。
  - **拟外发预览清单与两步先预览后确认（`outboundPreviewId` + `snapshotId` 绑定）**：非本机云推理地址且涉及个人材料时，实行严格的“先预览、再确认创建/发送”。宿主配置 `allowPersonalData` 仅声明本机只读采集能力，不能替代用户显式 `cloudConsent: true` 与当前清单确认。
    - **`POST /v1/sessions` 两步先预览后确认**：服务端先校验应用身份、数据模式与本机只读材料授权，在本机固定采集快照并按统一规范化与裁剪口径（默认单条上限 160 Unicode 码点）生成实际拟外发清单。当目标为非回环云推理且拟外发清单包含个人片段（`items.length > 0`）时：
      1. **第一步（预览）**：首次请求（或仅传 `cloudConsent: true` 但缺少/不匹配 `outboundPreviewId`、提交空清单 ID、缺少/不匹配 `snapshotId`，或快照/片段/目标模型端点已变化）均不创建会话，云模型调用严格为 0，返回 `403 CLOUD_CONSENT_REQUIRED`，在 `error.details.outboundPreview` 承载**实际非空的未确认清单**（`previewConfirmed: false`、`cloudConsentGranted: false`、`confirmedOutboundPreviewId: null`，含当前 `snapshotId` / `lockedSnapshotId`、`outboundPreviewId` 及逐条裁剪后的 `items` / `snippetPreview`）。
      2. **第二步（确认）**：客户端核对清单后，显式提交 `cloudConsent: true`、匹配的 `outboundPreviewId` 及预览对应的 `snapshotId`（当快照标识非空时必传），服务端重新核对当前清单、快照与模型目标，全部匹配时才返回 `201` 创建已确认会话并落库一致的确认状态。
      3. 无可用个人片段时按现有空材料分支创建会话并保持未确认状态（`previewConfirmed: false`、`confirmedOutboundPreviewId: null`）；本机回环模型与 `usePersonalMaterials: false` 继续直接 `201` 创建。
    - **`POST /v1/sessions/:id/turns` 轮次边界**：预览清单与实际模型提示词共用同一批按 Unicode 码点安全裁剪后的片段，确保预览与模型实际收到的个人片段在 `evidenceId`、`source`/`field`、`range` 和 `text` 上逐项一致。只有与已确认 `outboundPreviewId` 逐项匹配的个人片段才能进入本轮云模型请求；片段集合或内容变化将生成新的 `outboundPreviewId`，旧确认不能放行，须重新确认新预览。

统一响应外层：

```json
{
  "schemaVersion": 1,
  "protocolVersion": "quotation-backend/v1",
  "ok": true,
  "data": {},
  "error": null
}
```

## 2. 接口清单

| 方法与路径 | 状态码 | 语义与关键约束 |
| --- | --- | --- |
| `GET /health` | `200` | 返回 `{ service: "quotation-agent-backend", dataMode }`（Schema `$defs/HealthStatus`），标识服务名与当前隔离模式（`demo` / `real`），不含任何敏感配置 |
| `POST /api/host/session` | `200` / `403` | 由同源宿主（`npm run serve:public:web` 或 `npm run serve:demo:web`）提供：校验同源与 `Sec-Fetch-Site`，签发 `HttpOnly; SameSite=Strict; Path=/` 会话 Cookie，返回统一握手载荷 `{ mode: "public"|"demo", dataMode: "real"|"demo", usePersonalMaterials, hostReady, capabilities }`，绝不向浏览器下发内部 Bearer |
| `POST /v1/sessions` | `201` / `403` | 接受 `{ dataMode?, snapshotId?, usePersonalMaterials?, cloudConsent?, outboundPreviewId?, initialText?, initialGraph?, metadata? }`。公开宿主模式下宿主强制 `usePersonalMaterials: false` 并拒绝客户端提交种子图 `initialGraph` 或任意外部地址覆盖。对非回环云推理且拟外发清单包含个人片段的场景采用两步先预览后确认：首次请求或缺少/不匹配 `cloudConsent: true`、`outboundPreviewId`、`snapshotId`（含空清单 ID 或快照/片段/目标模型变化）时返回 `403 CLOUD_CONSENT_REQUIRED`，`error.details.outboundPreview` 携带当前实际非空未确认清单（`previewConfirmed: false`，含 `snapshotId`/`lockedSnapshotId` 与 `outboundPreviewId`）且不创建会话；第二步带齐匹配的 `cloudConsent: true`、`outboundPreviewId` 与 `snapshotId` 才返回 `201` 创建并持久化已确认会话。无可用个人片段、本机回环模型或 `usePersonalMaterials: false` 继续直接 `201` 创建（Schema `$defs/SessionCreated`，不含 `turns`，与 `SessionSnapshot` 严格互斥） |
| `POST /v1/sessions/:id/turns` | `202` / `200` / `403` / `409` | 接受 `{ clientRequestId, baseGraphVersion, text, focusRef?, action?, cloudConsent?, outboundPreviewId? }`（`action` 支持可选 `targetId`、`factId`、`statementRole`、`adoptStatementId`、`proposal`；公开宿主模式拒绝客户端自造候选提议 `action.proposal` / 顶层 `proposal` 及外部接口地址覆盖）。显式传 `cloudConsent: false` 时先持久化撤回并重算会话内兼容字段、幂等保持原 `graphVersion` 并向运行中的相关云轮次发取消信号；省略 `cloudConsent` 时沿用持久化值。云端涉及个人材料且未确认当前 `outboundPreviewId`（或片段变更导致旧确认失效）时返回 `403 CLOUD_CONSENT_REQUIRED` 并附 `error.details.outboundPreview`。同 `clientRequestId` 且载荷一致时 `200` 幂等复用原 `turnId`（Schema `$defs/TurnAccepted`）；同键换内容（`CLIENT_REQUEST_ID_CONFLICT`）、会话已有运行中轮次（`TURN_IN_PROGRESS`）或 `baseGraphVersion` 过期（`STALE_GRAPH_VERSION`）均返回 `409` |
| `GET /v1/sessions/:id/turns/:turnId/events` | `200` | `text/event-stream` 实时流，按单调递增整数 `id` 输出，支持 `Last-Event-ID` 断线续读。客户端断开连接不会中止后台轮次；轮次进入终态或进程重启后重连可原样重放已持久化事件 |
| `POST /v1/sessions/:id/turns/:turnId/cancel` | `200` / `404` | 先校验会话所有权与 `turnId` 是否存在（不存在返回 `404 TURN_NOT_FOUND`）。运行中轮次主动触发 `AbortSignal` 并原子落库；若轮次已处于任意终态，则不写入新取消事件，直接幂等返回 `200` 与既有终态及 `graphVersion`。`outcome` 与 `status` 取值枚举明文包含全部四种终态：`cancelled`、`committed`、`failed`、`interrupted`（Schema `$defs/TurnCancelled`） |
| `GET /v1/sessions/:id` | `200` | 返回完整会话快照（Schema `$defs/SessionSnapshot`），包含 `usePersonalMaterials`、`cloudConsent`、`allowCloudModel`、`confirmedOutboundPreviewId`、`confirmedOutboundSnippets`、`materialsStatus`、`currentFocus`、`confirmedGraph`、`publicAnalysis`（`$defs/PublicAnalysis` 或 `null`）、`pendingConfirmations`、`deniedAttributions`、`facts`、`evidenceIndex`、`statements`、`statementComparison`、`adoptedStatementId`、`invalidatedHistory`、`convergenceSummary`、`outboundPreview`（`$defs/OutboundPreview`）与 `turns`。支持 `?lookupId=<id>` 按 ID 取回早期事实或轮次（`retrievedItem`） |

## 3. SSE 事件顺序与载荷约束

标准事件顺序：

```text
turn.started → focus.selected → stage.changed → [evidence.verified] → text.delta … → turn.committed → turn.done
```

- 无外部检索缺口的轮次自动跳过 `retrieving_evidence` 阶段事件。
- 提交前主动取消、上游故障或服务进程崩溃恢复时，末端分别为 `turn.cancelled → turn.done` 或 `turn.failed → turn.done`（崩溃恢复 `status: "interrupted"`），保留上一有效 `graphVersion`；已终态轮次重复调用取消接口不会产生第二个终态事件。
- `focus.selected` 先行推送当前拆解的量词/范围/前提及其原文精确起止偏移 `startOffset..endOffset`。
- `text.delta` 仅包含面向用户的脱敏中文解释（基于 Vercel AI SDK `streamText` 的 `textStream`），工具原始回包、模型内部 `reasoning` 思考链及任何密钥凭证绝不进入事件流。
- `turn.committed` 包含本轮核验后的结构化焦点、证据 ID、图差异 `graphDelta` / `graphPatch`、公开分析快照 `publicAnalysis`（公开体验模式下非空，遵循 `$defs/PublicAnalysis`）、全部句子的最新同图报价、`outboundPreview`（遵循 `$defs/OutboundPreview`）与 `graphVersion`，前端无需解析自然语言即可原子更新星图、出处、账单与改写对照。

## 4. 公开体验同源宿主与 `publicAnalysis` 契约

### 4.1 公开体验同源宿主（`cd agent && npm run serve:public:web`）

- **入口与隔离**：入口为 `agent/public-web-host.mjs`，默认运行于真实模式 `dataMode: "real"`，使用独立 SQLite 数据库 `.data/sessions-public-web.sqlite`（与演示库 `.data/sessions-demo-web.sqlite` 及常规真实库物理隔离），在单一来源下同时托管 `frontend-design/web/` 正式星图页面与允许的 `/v1/*` 后端路由。
- **按浏览器 Cookie 隔离匿名 `ownerId`**：
  - 页面访问 `/`、`index.html` 或调用 `POST /api/host/session` 时，宿主为每个浏览器会话签发不透明的 `HttpOnly; SameSite=Strict; Path=/` 会话 Cookie，并在服务端映射至独立的匿名 `ownerId` 与内存内部 Bearer；内部 Bearer 绝不下发至浏览器。
  - 每个浏览器会话仅能读写自己创建的 `/v1/sessions/:id`、轮次与 SSE 流；跨浏览器会话访问返回 `403 SESSION_FORBIDDEN`。
  - 宿主继续校验 `Host`、`Origin` 与 `Sec-Fetch-Site`；模型密钥（`AGENT_API_KEY`）与知乎公开检索凭证（`ZHIHU_ACCESS_SECRET`）仅由服务端进程持有并完成深度脱敏。
- **强制个人材料隔离与越权字段拒绝**：
  - 宿主在创建会话与代理请求时强制写入 `usePersonalMaterials: false`（`lockedSnapshotId` 恒为 `null`），公开体验严禁触发本机个人浏览采集读取。
  - 宿主明确拒绝公开客户端提交的越权字段（返回 `400` / `403`）：
    - `POST /v1/sessions` 中的种子图 `initialGraph`；
    - `POST /v1/sessions/:id/turns` 中的客户端候选提议 `action.proposal` 或顶层 `proposal`；
    - 任何试图覆盖服务端模型地址或上游检索地址的任意外部 URL 字段（如 `baseURL`、`apiBaseUrl`、`modelBaseUrl`、`searchEndpoint`、`upstreamUrl` 等）。

### 4.2 统一宿主握手：`POST /api/host/session`

前端启动时调用同源 `POST /api/host/session` 获取当前宿主运行模式与能力状态，消除页面对 `dataMode: "demo"` 的硬编码：

```json
{
  "schemaVersion": 1,
  "protocolVersion": "quotation-backend/v1",
  "ok": true,
  "data": {
    "mode": "public",
    "dataMode": "real",
    "usePersonalMaterials": false,
    "hostReady": true,
    "capabilities": {
      "searchReady": true,
      "searchStatus": "ready",
      "modelReady": true,
      "modelStatus": "ready",
      "canSwitchToDemo": true
    }
  },
  "error": null
}
```

- `mode`：`"public"`（公开真实体验宿主）或 `"demo"`（合成演示宿主）。
- `dataMode`：`"real"`（对应 `public`）或 `"demo"`（对应 `demo`）。
- `usePersonalMaterials`：布尔值，公开宿主固定为 `false`。
- `capabilities`：声明上游检索与模型是否就绪（`searchReady`、`modelReady` 等）。当 `mode: "public"` 且缺少搜索或模型上游配置时，宿主如实返回未就绪状态而非静默伪造合成数据，前端温和提示原因并提供由用户自行选择切换合成演示的入口。

### 4.3 `publicAnalysis` 结构定义（Schema `$defs/PublicAnalysis`）

`publicAnalysis` 承载于 `GET /v1/sessions/:id`（`SessionSnapshot.publicAnalysis`）与 `turn.committed` 事件中，用于在公开对话体验里保存围绕当前主张核验通过的证据图、出处、改写与变化说明；未使用公开分析时为 `null`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `version` | `integer` | 公开分析演进版本号（从 `0` 或 `1` 起随分析更新单调递增） |
| `graphVersion` | `integer` | 与所属轮次提交的 `SessionSnapshot.graphVersion` 严格一致，随同一轮 `graphVersion` 原子提交 |
| `turnId` | `string \| null` | 最近一次更新该公开分析的轮次 ID |
| `claim` | `object \| null` | 当前正在讨论的主张及其结构拆解（如 `{ text, statementId?, focus?, subject?, action?, conditions?, falsifiableScope? }`） |
| `nodes` | `array<object>` | 本轮聚焦的主张、条件与公开证据节点列表（含 `id`、`kind`、`label`/`text`、`attribution`、`evidenceId`/`evidenceIds`、`status` 等） |
| `edges` | `array<object>` | 经服务端核验的节点关系边（`supports` / `contradicts` / `qualifies` / `unknown` 等），每条已显示边须可追溯对应 `evidenceId`/`evidenceIds` 与理由；跨主体/不同条件不因词面相似误标冲突 |
| `citations` | `array<object>` | 本轮核验选出的精简公开出处列表，每项含 `evidenceId`、`nodeId`、`title`、`author`、`attribution: "other_author"`、`excerpt`/`quote`、`url`/`canonicalUrl`、`relation` 等，支持对话与星图节点双向定位 |
| `suggestedRewrite` | `object \| null` | 可编辑改写建议（含 `text`、`retained`/`kept`、`narrowed`/`changed`、`rationale`/`reason`、`basedOnEvidenceIds` 等），供用户直接修改或点击「试试这句」提交 |
| `relationChanges` | `array<object>` | 与上一版本相比发生变化的边/关系列表（如 `{ edgeId?, from?, to?, previousRelation?, nextRelation?, status?, summary? }`），同题改写或纠错时仅标注受影响的关系 |
| `statementHistory` | `array<object>` | 同一会话内的原句与改写演进列表，保证原句与改写在同批公开证据下可对照比较 |
| `materialBoundary` | `object \| null` | 公开检索与材料边界状态：`state` 枚举为 `"not_configured"` / `"rate_limited"` / `"timeout"` / `"empty"` / `"ok"`，配合温和中文 `message` 与留白的 `unknowns` 列表 |
| `changeSummary` | `string \| null` | 用一句自然、具体的中文说明本轮星图关系发生了什么变化 |

**归属隔离与原子提交约束**：
- **公开证据与个人图严格分离**：`publicAnalysis` 中的全部公开检索出处与证据节点始终保持 `attribution: "other_author"`，属于本次公开讨论；绝不自动写入个人已确认图 `confirmedGraph`（`confirmedGraph` 仅承载经本人表达或本人确认的 `attribution: "self"` 节点，承重百分比亦仅用于有足够结构的已确认个人图）。
- **与 `graphVersion` 原子提交**：`publicAnalysis` 随同一轮次的 `graphVersion` 在服务端事务内原子落库，并由同一份 `GET /v1/sessions/:id` 快照同步更新星图与对话卡片；主动取消、模型/检索失败或快照同步延迟期间，界面维持上一完整已提交版本，绝不出现回复与星图混版。

## 工作台配对与正式观点交锋

启用 `npm run serve:workbench:starfield` 时，`3006` 在原星球封面和三维星图中使用工作台配对会话。旧入口 `18775` 共用服务、账号与数据库，两个端口分别校验同源请求；公开对话宿主的 API 保持原契约。

| 方法与路径 | 行为 |
| --- | --- |
| 工作台 `POST /api/starfield/connect` | 检查在用账号、授权、快照和画像，返回一次性正式星图链接 |
| `POST /api/host/session` | 以 `{ pairCode }` 建立已配对会话，省略时查询连接状态。返回 `resumeSessionId`，仅在当前账号最近一局尚未结束时有值，用于跨端口恢复 |
| `POST /v1/debate/topics` | 返回三个观点；`{ refresh: true }` 换一批 |
| `POST /v1/sessions` | 以 `{ topicId }` 创建一局并锁定画像版本 |
| `POST /v1/sessions/:id/turns` | 沿用 `clientRequestId` 和 `baseGraphVersion`。以 `action.type=open_debate` 开首轮，或以 `action={ type: "choose_debate_option", roundId, optionId }` 提交选择 |
| `GET /v1/sessions/:id` | 查询 `debate`、当前回合、进度、结算与最近一次轮次状态 |
| `GET /v1/sessions/:id/turns/:turnId/events` | 推送实时阶段、对手语句和终态；支持 `Last-Event-ID` |
| `POST /v1/sessions/:id/turns/:turnId/cancel` | 取消正在生成的操作，保留此前提交 |
| `GET /v1/knowledge-map` | 返回领域、已接触或核验的星点、出处与入图待处理状态 |

星图接口采用工作台账号绑定，不把模型或采集凭证交给浏览器。对局运行只消费自己的状态，知识星图只在配对初始化与结算后改变。
