# 「报价」后端实施方案与 QA 专项整改交付回执（agy）

- **交付基线**：本地 `main@56290b9`（初始方案基线 `e94e4c5`，更新日期：2026-11-26）
- **运行宿主**：Linux，Node.js `v24.22.3`（本机路径 `/home/lululu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`），锁定 SDK 为 `ai@7.0.179`、`@ai-sdk/mcp@2.0.103`、`@ai-sdk/openai-compatible@3.0.94`、`zod@4.6.7`、内置 `node:sqlite`。
- **实施与并行分工**：
  1. 启动 5 个独立子智能体完成：① `quotation-engine/` 纯算价与协议、② 材料接入与程序核验、③ SQLite 版本化状态与撤回存储、④ 单 Agent `streamText` 流式编排与十二轮演进、⑤ `/v1` 同源 HTTP/SSE 服务与多主体隔离。
  2. 按 `P0 → P1 → P2` 优先级并行完成 `QA-01` 至 `QA-11` 的整改，并补齐带编号的纯引擎、存储、核验器与 HTTP/SSE 端到端回归测试。

---

## 1. 改动范围与模块边界

既有跟踪文件（`agent/cli.mjs`、`agent/agent.mjs`、`agent/config.mjs`、`agent/mcp-servers.mjs`、`agent/prompt.mjs`、`agent/errors.mjs`、`agent/index.mjs`、`frontend-design/`、`data-collection-service/`、`information-search/` 等）及本地私有忽略文件（`quotation-engine/.env`、`quotation-engine/.data/`）均保持兼容未破坏；仅在 `agent/package.json` 增补 `/v1` 后端服务启动与十二轮合成回放脚本。

- **一级目录 `quotation-engine/`（纯算价与协议层）**：
  - [starfield.mjs](../quotation-engine/engine/starfield.mjs)、[quotation.mjs](../quotation-engine/engine/quotation.mjs)、[index.mjs](../quotation-engine/index.mjs)（迭代拓扑环检测与紧凑位集传递承重 `S` 计算，支持万级长链/菱形 DAG 零递归溢出；`Math.round((100 * numerator) / denominator)` 精确整数百分比舍入；过半失效坍塌、`assessment` 与 `rate` 分离口径、严格 `conflictReasons`/`evidenceIds` Schema 对齐校验及有据同图改写对比）
  - [OUTPUT_FORMAT.md](../quotation-engine/OUTPUT_FORMAT.md)、[quote-v1.schema.json](../quotation-engine/schemas/quote-v1.schema.json)、[quote-v1.json](../quotation-engine/examples/quote-v1.json)、[frontend-consume-sample.json](../quotation-engine/examples/frontend-consume-sample.json)、[engine.test.mjs](../quotation-engine/test/engine.test.mjs)
- **目录 `agent/`（会话、证据核验、流式编排与 `/v1` HTTP/SSE 服务）**：
  - 共享协议与接口契约：[protocol.mjs](protocol.mjs)、[http-contracts.mjs](http-contracts.mjs)、[HTTP_API_CONTRACT.md](HTTP_API_CONTRACT.md)、[http-api-v1.schema.json](schemas/http-api-v1.schema.json)
  - 材料接入、正文上限分页、归属隔离与程序校验：[evidence.mjs](evidence.mjs)、[materials.mjs](materials.mjs)、[verifier.mjs](verifier.mjs)、[synthetic-materials.mjs](fixtures/synthetic-materials.mjs)
  - SQLite 版本化存储、恢复、精确撤回与有界上下文预算：[session-store.mjs](session-store.mjs)、[context-builder.mjs](context-builder.mjs)
  - 单 Agent 流式编排、实时输出核验守卫与安全提示词：[turn-orchestrator.mjs](turn-orchestrator.mjs)、[turn-prompts.mjs](turn-prompts.mjs)
  - HTTP/SSE 同源服务与独立启动入口：[server.mjs](server.mjs)、[serve-cli.mjs](serve-cli.mjs)
  - 合成回放脚本与合成事件样例：[replay-twelve-turns.mjs](scripts/replay-twelve-turns.mjs)、[session-snapshot-v1.json](examples/session-snapshot-v1.json)、[sse-turn-events-v1.json](examples/sse-turn-events-v1.json)
  - 后端与 QA 专项回归测试套件：[evidence-verifier.test.mjs](test/evidence-verifier.test.mjs)、[session-store.test.mjs](test/session-store.test.mjs)、[turn-orchestrator.test.mjs](test/turn-orchestrator.test.mjs)、[server-sse.test.mjs](test/server-sse.test.mjs)、[twelve-turns-http-e2e.test.mjs](test/twelve-turns-http-e2e.test.mjs)、[qa-remediation-http.test.mjs](test/qa-remediation-http.test.mjs)

---

## 2. 从本地干净环境复跑全部测试与回放命令

无需真实知乎登录、无需外部模型网络，使用临时数据库与测试身份即可一键复跑全部回归：

```bash
export PATH="/home/lululu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
node -v   # v24.22.3

# 1. 核心后端安装依赖、运行全量测试与十二轮合成回放
(cd agent && npm ci && npm test && npm run replay:12turns)   # 190 / 190 通过（13 suites，0 失败）

# 2. 跨模块回归测试
(cd quotation-engine && npm test)                            # 10 / 10 通过（0 失败）
(cd information-search && npm test)                          # 15 / 15 通过（0 失败）
(cd data-collection-service && npm test)                     # 26 / 26 通过（5 suites，0 失败）

# 3. 前端既有验证脚本校验
(cd frontend-design && node web/src/verify/verify-p0.mjs && node web/src/verify/verify-p1.mjs && node web/src/verify/verify-p2.mjs)
# P0 10/10、P1 15/15、P2 27/27 全部通过

# 4. 启动本机合成演示 HTTP/SSE 服务（当前默认监听 127.0.0.1:3009，物理隔离于 .data/sessions-demo.sqlite）
(cd agent && AGENT_SERVER_TOKEN=local-dev-token-demo npm run serve:demo)
```

---

## 3. QA-01 至 QA-11 专项整改映射与通过情况

全部 11 项问题均按 `P0 → P1 → P2` 修复并通过对应单测与真实 HTTP/SSE 回归：

| 编号 | 优先级 | 整改要点摘要 | 对应测试文件与含编号测试名 | 状态 |
| --- | --- | --- | --- | --- |
| **QA-01** | **P0** | 持久化 `usePersonalMaterials`，关闭时首轮、后续轮与重启后采集工具调用严格为 `0` 且无陈旧提示；开启时跨页固定复用首个 `snapshotId`。 | • `agent/test/qa-remediation-http.test.mjs`: `QA-01 & QA-11：关闭个人材料时首轮、后续轮及重启后采集调用严格为 0；启用时跨页锁定首个 snapshotId 且读取授权正文片段`<br>• `agent/test/server-sse.test.mjs`: `QA-01：关闭个人材料（usePersonalMaterials: false）提交多轮并重启后零采集零外发；开启个人材料会话跨页固定携带首个 snapshotId`<br>• `agent/test/session-store.test.mjs`: `QA-01 / QA-02：usePersonalMaterials、cloudConsent（true/false/null）、materialsStatus 与 outboundPreview 跨轮次及重启持久化（含旧表自动迁移）` | **通过** |
| **QA-02** | **P0** | 真实处理个人材料之前先判定模型端点性质：本机回环地址无需 `cloudConsent`；外部云端点必须显式 `cloudConsent: true` 且展示最小化 `outboundPreview`，未同意或后续轮撤回同意立即返回 `403 CLOUD_CONSENT_REQUIRED` 且模型调用为 `0`。 | • `agent/test/qa-remediation-http.test.mjs`: `QA-02：同一合成快照在回环模型免云同意、外部模型无同意拦截（0调用）、外部模型有同意最小化外发及后续轮撤回同意阻断`<br>• `agent/test/server-sse.test.mjs`: `QA-02：real 模式下同一合成快照走回环模型（cloudConsent: false 成功）、外部云模型无同意被拒（403 且模型调用为 0）、有同意对齐外发预览，以及后续轮次传 cloudConsent: false 被阻止`<br>• `agent/test/evidence-verifier.test.mjs`: `QA-02 buildOutboundModelPreview 本机回环免云同意放行与非本机外部模型严格要求 cloudConsent===true` | **通过** |
| **QA-03** | **P1** | 显式 `targetId` 与自然语言轮次引用精确匹配活跃事实/条件：撤回无事实轮次返回 `TARGET_NOT_FOUND` 不误伤其他事实，重复撤回返回 `ALREADY_RETRACTED` 幂等不增 `graphVersion`，断线重连与重启结果一致。 | • `agent/test/qa-remediation-http.test.mjs`: `QA-03：显式 targetId 精确撤回 A 保留 B、引用无事实的第一轮不误撤第二轮、重复撤回幂等，且重连与重启一致`<br>• `agent/test/session-store.test.mjs`: `QA-03 / QA-04：显式撤回目标精确匹配（无事实轮次 TARGET_NOT_FOUND、重复撤回 ALREADY_RETRACTED 不增版本）与显式 adoptStatementId 校验` | **通过** |
| **QA-04** | **P1** | 显式 `focusRef.nodeId` 校验存在于 `confirmedGraph` 并绑定对应节点文本与证据范围（解释轮不增 `graphVersion`）；`adoptStatementId` 校验并持久化为 `adoptedStatementId` 且写入收束结果；无效引用显式拒绝不静默替换。 | • `agent/test/qa-remediation-http.test.mjs`: `QA-04：显式 focusRef.nodeId 绑定节点证据范围且不增图版本；显式 adoptStatementId 采用指定改写并跨重启保持；无效引用不静默替换`<br>• `agent/test/session-store.test.mjs`: `QA-03 / QA-04：显式撤回目标精确匹配（无事实轮次 TARGET_NOT_FOUND、重复撤回 ALREADY_RETRACTED 不增版本）与显式 adoptStatementId 校验` | **通过** |
| **QA-05** | **P1** | 移除硬编码场景短语（如“刚开始用的时候”），实现通用条件短语提取（如“雨天”、“夜班交接期间”）与结构化分句主谓/极性/双重否定/跨对象隔离判定，空材料不编造冲突或支持。 | • `agent/test/qa-remediation-http.test.mjs`: `QA-05：覆盖同义复述、近似词不同对象、任意条件“雨天”、明确反例（工厂换班新领域）、双重否定与空材料防编造六组回归`<br>• `agent/test/evidence-verifier.test.mjs`: `QA-05 真实适用范围提取与结构化分句语义关系核验：复句同义相容、跨对象隔离、双重否定、通用领域与条件边界`<br>• `agent/test/turn-orchestrator.test.mjs`: `QA-01..QA-11 编排器单测：材料开关零调用、精确撤回、节点焦点与采纳改写、分句极性与雨天条件、流式守卫、有界预算与 23/40 舍入` | **通过** |
| **QA-06** | **P1** | 引入增量流式守卫（`createTurnStreamGuard` / `createStreamingOutputGuard`）：安全文本立即推送 `text.delta`，仅在未闭合引号或待核验百分比边界短暂缓冲，实时剥离未核验引文与错误数字（如虚构“报价 72%”），入图前拦截归属错误与词面相似伪支撑。 | • `agent/test/qa-remediation-http.test.mjs`: `QA-06：可控流式模型阻塞后段时安全首段立即可见；拦截剔除虚构引文与错误“报价 72%”；拒绝归属错误与词面相似支撑候选入图`<br>• `agent/test/evidence-verifier.test.mjs`: `QA-06 & QA-10 候选冲突理由严格结构校验与流式输出实时引文/数值拦截守卫` | **通过** |
| **QA-07** | **P1** | 当原句或改写任一方为 `insufficient_evidence` 时，`resolvedConflicts` 与 `resolvedAffected` 严格保持为空；仅同图正向有据核验改写计入已解除冲突；撤回唯一冲突依据（即使保留无关支撑边）后回退为 `insufficient_evidence`（`rate: null`）并清空旧冲突理由。 | • `quotation-engine/test/engine.test.mjs`: `QA-07：无证据改写不得标为已解决冲突，仅同图已核验改写能进入 resolvedConflicts 与 resolvedAffected`<br>• `agent/test/qa-remediation-http.test.mjs`: `QA-07：无证据改写保持空差值与空已解决集合；正向核验改写进入 resolvedConflicts；撤回唯一冲突依据并保留无关支撑边后恢复未定且无旧理由`<br>• `agent/test/session-store.test.mjs`: `QA-07：无证据改写比较已解除集合为空，撤回唯一冲突依据并保留无关支撑边后回退 insufficient_evidence / null 且彻底清除旧冲突理由` | **通过** |
| **QA-08** | **P1** | `context-builder.mjs` 与 `turn-orchestrator.mjs` 模型提示词严格执行 `maxFacts`/`maxTotalChars`/`maxPromptChars` 有界预算：200 条合成事实下仅外发与本轮焦点/显式早期引用相关的紧凑子集，零混入无关事实标记，而 SQLite 与算价仍完整基于全部 200 条记录。 | • `agent/test/qa-remediation-http.test.mjs`: `QA-08：临时 SQLite 装入 200 条独立标记事实，紧凑预算下精确取回早期第 3 条引用且无关标记零外发，会话完整保留 200 条且算价基于完整图`<br>• `agent/test/session-store.test.mjs`: `QA-08：200 条合成事实长会话严格输入预算（预算调为 1 严格受控、按引用精确取回早期事实、无关标记零混入）` | **通过** |
| **QA-09** | **P2** | 为 `http-api-v1.schema.json` 各响应分支补充互斥判别约束，使健康检查、创建、空/非空快照、轮次接受、错误及 `committed`/`cancelled`/`failed`/`interrupted` 四种终态取消响应在 Draft 2020-12 下均唯一命中单支 `oneOf`；失败与中断轮次重复取消及 `Last-Event-ID` 续读严格幂等，绝不产生第二终态。 | • `agent/test/server-sse.test.mjs`: `QA-09：http-api-v1.schema.json Draft 2020-12 全端点唯一 oneOf 分支校验与四种终态（cancelled/committed/failed/interrupted）幂等取消及续读验证`<br>• `agent/test/session-store.test.mjs`: `QA-09：cancelTurn 对 committed / cancelled / failed / interrupted 四种终态严格幂等且绝不追加第二个终态事件` | **通过** |
| **QA-10** | **P2** | 报价百分比改为 `Math.round((100 * numerator) / denominator)`（`23/40 => 58%`）；引擎与会话存储严格校验 `conflictReasons`、`evidenceIds` 与必需 `text` 字段并通过 `quote-v1.schema.json`（`additionalProperties: false`）；图拓扑校验与传递承重 `S` 改为迭代 + `Uint32Array` 位集实现，10,000 节点长链与万级菱形 DAG 毫秒级完成无栈溢出。 | • `quotation-engine/test/engine.test.mjs`: `QA-10：23/40 整数百分比精确舍入为 58、非法 conflictReasons/evidenceIds 拦截与 Schema 严格对齐`<br>• `quotation-engine/test/engine.test.mjs`: `QA-10：10,000 节点长链与万级菱形 DAG 校验、承重计算及算价无栈溢出压力测试`<br>• `agent/test/qa-remediation-http.test.mjs`: `QA-10：40 对根叶节点冲突 23 个根通过 HTTP 编排得出 23/40 与 58% 且通过 quote-v1.schema.json 校验；非法理由候选被拒绝`<br>• `agent/test/session-store.test.mjs`: `QA-10：23/40 精确四舍五入为 58%、非法 conflictReasons / evidenceIds 拒绝与 10,000 节点长链迭代无栈溢出` | **通过** |
| **QA-11** | **P2** | 材料加载器在已授权个人材料分页时显式传入有上限 `bodyMaxChars`（默认 `4000`），按实际返回区分 `full_text`、`partial_body`、`summary` 及 `truncated` 覆盖范围；公开知乎搜索结果继续标为 `summary`；外发模型内容严格受当轮相关性与预算限制。 | • `agent/test/qa-remediation-http.test.mjs`: `QA-01 & QA-11：关闭个人材料时首轮、后续轮及重启后采集调用严格为 0；启用时跨页锁定首个 snapshotId 且读取授权正文片段`<br>• `agent/test/evidence-verifier.test.mjs`: `QA-11 个人采集正文按上限读取、默认 bodyMaxChars=0 裁剪对齐、partial/截断如实标注与关闭个人材料零调用` | **通过** |

---

## 4. 四项核心回归门槛与合成十二轮复现核对

运行 `cd agent && npm run replay:12turns` 及 `node --test test/twelve-turns-http-e2e.test.mjs test/server-sse.test.mjs test/qa-remediation-http.test.mjs` 实测确认四项回归门槛全部保持通过：

1. **流式首段可见性门槛**：可控流式模型第二段尚未解锁前，真实 HTTP 客户端已收到 `turn.started`、`focus.selected` 与安全首段 `text.delta`。
2. **中断/取消图版本守恒门槛**：收到首段后主动取消或遭遇上游断流时，`confirmedGraph` 与 `graphVersion` 严格保留上一已提交版本。
3. **强杀重启续读门槛**：服务进程重启后，`running` 轮次自动收敛为 `interrupted`，客户端凭旧 `Last-Event-ID` 精确补齐中断终态事件且随后可正常提交新一轮。
4. **十二轮自然语言全流程门槛**：
   - 轮次 1–3：拆解 `"只会"`，收藏的 `周牧` 回答仅作 `other_author` 候选反例；第 3 轮否认归属后持久化写入 `deniedAttributions`（`selfMisattributionCount = 0`）。
   - 轮次 4–6：第 4 轮本人事实（`turn_4`）与第 6 轮限定条件 `"刚开始用的时候"`（`turn_6`）独立成条；原句在 `v1` 得 `rate: 100`，加入限定条件后在 `v2` 得 `rate: 67`。
   - 轮次 7–9：同一图版本 `v2` 下，换语气改写同得 `rate: 67`，缩小范围改写因缺证据保持 `insufficient_evidence`（`rate: null`），三个 `statementId` 可同图并排取回。
   - 轮次 10–12：精确撤回第 6 轮条件（`v3`），仅失效依赖该条件的阶段判断，第 4 轮本人事实保持 `active`，原句与换语气恢复 `rate: 100`；第 12 轮生成持久化 `convergenceSummary`。

---

## 5. 合成联调、真实联调与受前置条件限制项分栏说明

| 验收类别 | 验证项目与方式 | 实测结果、样本量与耗时 |
| --- | --- | --- |
| **合成联调（已全量通过）** | `/v1` HTTP/SSE + `node:sqlite` + 合成采集服务（含正文/摘要/截断分页） + 合成公开搜索 + 12 轮端到端回放 + QA-01..QA-11 专项反例回归 | • `agent`：`190 / 190` 通过（`765 ms`）<br>• `quotation-engine`：`10 / 10` 通过（`117 ms`）<br>• 12 轮热会话（`n=11`）：首帧状态 P50 `7.36 ms` / P95 `9.36 ms`，首段文本 P50 `7.38 ms` / P95 `9.38 ms`，整轮完成 P50 `7.42 ms` / P95 `9.43 ms` |
| **真实联调（已实测通过项）** | 1. 真实云模型 HTTP/SSE 流式推理（`glm-5.3-flash`，仅发送合成空材料句子，零个人数据外发，`n=3`）<br>2. 真实 `information-search` MCP 子进程 `--demo` 协议连通与工具调用<br>3. 兄弟模块 `information-search`（`15/15`）与 `data-collection-service`（`26/26`）及 `frontend-design`（`52/52`）联测 | • 真实云模型 HTTP/SSE（`n=3`）：冷启动 `161.01 ms`；热会话首帧状态 P50 `7.74 ms`（`< 1000 ms`），首段有用文本 P50 `743.91 ms`（`686.32–916.83 ms`，`< 3000 ms`），整轮耗时 `3562.81–4691.26 ms`（每轮 `251–348` 个 `text.delta` 块，零 `reasoning`/密钥泄漏） |
| **受外部凭证前置条件限制项（待本人授权后独立补测）** | 1. **真实个人只读采集快照**：需授权者本人在桌面采集界面登录知乎并签发 `agt_` 只读令牌（`DATA_SERVICE_AGENT_TOKEN`）<br>2. **真实知乎公开搜索接口**：需在本机注入官方 `ZHIHU_ACCESS_SECRET`<br>3. **本机 Ollama 模型推理**：需在本机启动 `127.0.0.1:11434` 服务<br>4. **前端真实 `/v1` 页面切换与整站浏览器验收**：`frontend-design/web/src/analysis.js` 当前仍消费静态样例，待前端接入 `/v1` 接口后执行桌面/移动端真机浏览器联调 | • 未配置上述运行态凭证时，`real` 模式按设计如实返回 `status: "not_configured"` 或 `403 CLOUD_CONSENT_REQUIRED`（已验证绝不静默回退或混入 `demo` 合成数据） |

---

## 6. 整站接通与授权专项修复交付回执（按 SITE_INTEGRATION_PLAN.md）

- **变更基线**：本地 `main@56290b9` + 本轮工作区整站接通与授权修复改动（更新日期：2026-11-26）
- **运行宿主**：Linux，Node.js `v24.22.3`（`/home/lululu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`），浏览器测试使用 `data-collection-service/node_modules/playwright-core` 与本机 `/usr/bin/google-chrome`（无外网、零外部凭证可复跑）。
- **整站合成工作台启动命令**：
  ```bash
  export PATH="/home/lululu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
  cd agent && npm run serve:demo:web
  # 当前默认监听 http://127.0.0.1:3008/（支持 --host / --port / --db / --help）
  # 同源托管 frontend-design/web/ 正式星图页面与 /v1 HTTP/SSE 接口；
  # 内部管理 Bearer，页面通过 HttpOnly SameSite=Strict 同源会话 Cookie 访问允许接口，并保持既有 Bearer API 兼容；
  # 默认使用独立数据库 .data/sessions-demo-web.sqlite 与合成上游，零外部凭证开箱可体验。
  ```

### 6.1 多智能体分工与交付清单（5 路并行 + 主控合流）

| 负责人 / 角色 | 范围与核心交付 | 涉及文件 |
| --- | --- | --- |
| **主控（agy）** | 约定共用个人材料与模型端点位置策略模块，拆分无冲突并行边界，合流修复 `turn.committed` 状态同步并跑完全量回归与回执 | `agent/material-policy.mjs`、`frontend-design/web/src/live-session.js`、`frontend-design/web/src/cover.js`、`agent/DELIVERY_RECEIPT.md` |
| **A · 新版授权与预览（P0-A）** | `POST /v1/sessions/:id/turns` 显式 `cloudConsent: false` 先持久化撤回并重算全部兼容字段、幂等保持 `graphVersion`、向运行中云轮次发送取消信号；重启与后续省略保持 `403`；拟外发清单裁剪（160 码点）与 `outboundPreviewId` 确认绑定，预览与模型提示词逐项一致且拦截后段泄露 | `agent/http-contracts.mjs`、`agent/session-store.mjs`、`agent/server.mjs`、`agent/turn-orchestrator.mjs`、`agent/turn-prompts.mjs`、`agent/test/p0-a-consent-preview.test.mjs` |
| **B · 旧工作台画像（P0-B）** | 统一手动刷新与启动/同步完成/保存设置全部自动画像入口至共用门禁（`evaluateLegacyProfileGate`）；读取记录与调用模型前拦截关闭个人材料及非回环模型；运行中关闭设置或切非回环立即触发 `AbortController` 取消并按代际阻止落库；采集只读能力保持独立可用 | `agent/web.mjs`、`agent/test/p0-b-legacy-profile-gate.test.mjs` |
| **C-1 · 正式星图前端接入（P1-C）** | 沿用现有星图与承重分析布局接入同源 `/v1`；展示合成演示模式、轮次状态、焦点/阶段与独立增量解释；可操作证据卡与精确 `factId` 撤回；星图与账单同 `graphVersion` 更新、`rate === null` 显示「暂未确定」、同图改写比较与 `adoptStatementId` 采纳；支持 `Last-Event-ID` 断线续读去重、主动取消、刷新恢复与 `409 STALE_GRAPH_VERSION` 提示 | `frontend-design/web/index.html`、`frontend-design/web/src/cover.css`、`frontend-design/web/src/cover.js`、`frontend-design/web/src/galaxy.js`、`frontend-design/web/src/analysis.js`、`frontend-design/web/src/live-session.js` |
| **C-2 · 同源宿主与浏览器验收（P1-C）** | 实现 `demo-web-host.mjs` 与 `npm run serve:demo:web`，托管正式首页与 `/v1` 同源代理（内部 Bearer 隔离 + HttpOnly Cookie + 防路径穿越 + 合成上游），补齐宿主单测与 Playwright 桌面/手机双端 `R-C1`/`R-C2` 浏览器端到端验收 | `agent/demo-web-host.mjs`、`agent/package.json`、`agent/test/demo-web-host.test.mjs`、`agent/test/p1-c-site-browser.test.mjs` |
| **D · 契约、Schema、样例与共用策略单测** | 同步持久化撤回、`outboundPreviewId` 与同源宿主说明至契约文档、Draft 2020-12 互斥 Schema、合成样例与 `agent/README.md`，补齐 `material-policy.mjs` 全量单测 | `agent/HTTP_API_CONTRACT.md`、`agent/schemas/http-api-v1.schema.json`、`agent/examples/session-snapshot-v1.json`、`agent/examples/sse-turn-events-v1.json`、`agent/README.md`、`agent/test/material-policy.test.mjs` |

### 6.2 R-A1 至 R-C2 验收用例映射与实测结果

| 验收编号 | 对应测试文件与测试名 | 实测结果 |
| --- | --- | --- |
| **R-A1** | `agent/test/p0-a-consent-preview.test.mjs`：`R-A1：云授权撤回持久化、重复撤回幂等、后续省略与重启后保持 403、重确认预览恢复调用，及回环模型在 false 下仍可用本机材料` | **通过** |
| **R-A2** | `agent/test/p0-a-consent-preview.test.mjs`：`R-A2：240 字合成片段预览与云模型请求逐项一致且无后段泄露、切换个人片段旧确认被拒、调用前撤回触发取消信号并保持 0 调用` | **通过** |
| **R-B1** | `agent/test/p0-b-legacy-profile-gate.test.mjs`：`R-B1.1` 至 `R-B1.7`（共 8 项：关闭个人材料 + 非回环/回环四入口零调用、开启材料 + 非回环拒绝、开启材料 + 回环成功、运行中关闭设置/切非回环取消且不落库、关闭后重启零调用、服务关闭取消） | **通过（8/8）** |
| **R-C1** | `agent/test/p1-c-site-browser.test.mjs`：`R-C1 正式首页合成会话正常闭环：分析原句、证据核验、补充事实、双改写同图比较与采用、指定撤回及跨领域输入` | **通过** |
| **R-C2** | `agent/test/p1-c-site-browser.test.mjs`：`R-C2 桌面与手机尺寸空态/证据不足/异常提示，以及可控模型断线按事件 ID 续读、主动取消与页面刷新恢复` | **通过** |
| **辅助支撑单测** | `agent/test/demo-web-host.test.mjs`（4 项：同源 Cookie 鉴权、隐藏内部 Bearer、Bearer 兼容、防路径穿越、SSE 零缓冲续读）<br>`agent/test/material-policy.test.mjs`（6 项：回环判断、门禁、码点裁剪、清单一致性与 Draft 2020-12 样例校验） | **通过（10/10）** |

### 6.3 全量回归与新增验收复跑命令及实测结果（总计 317 / 317 通过）

```bash
export PATH="/home/lululu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
node -v   # v24.22.3

# 1. 全量回归矩阵（与 SITE_INTEGRATION_PLAN.md 验收命令一致）
(cd agent && npm ci && npm test && npm run replay:12turns)    # 212 / 212 通过（14 suites，0 失败，7.43s）；12 轮回放 finalGraphVersion=3, converged=true
(cd quotation-engine && npm test)                             # 10 / 10 通过（0 失败）
(cd information-search && npm test)                           # 17 / 17 通过（0 失败）
(cd data-collection-service && npm test)                      # 26 / 26 通过（5 suites，0 失败）
(cd frontend-design && node web/src/verify/verify-p0.mjs && node web/src/verify/verify-p1.mjs && node web/src/verify/verify-p2.mjs)
# P0 10/10、P1 15/15、P2 27/27（合计 52 / 52 通过）

# 2. 单独复跑本轮新增 HTTP 与浏览器验收套件
(cd agent && node --test \
  test/material-policy.test.mjs \
  test/p0-a-consent-preview.test.mjs \
  test/p0-b-legacy-profile-gate.test.mjs \
  test/demo-web-host.test.mjs \
  test/p1-c-site-browser.test.mjs)
```

### 6.4 剩余问题与后续真实个人版放行前置项

1. **真实个人版语义与实时模型流核对（已按方案列入下阶段）**：复测记录的 `QA-05`（跨工厂主体语义隔离，如乙工厂换班经历不误用于甲工厂报价）与 `QA-06`（真实 LLM 流式输出“七十二个百分点”等中文大写未核验表述）按 `SITE_INTEGRATION_PLAN.md` 归入后续真实个人版放行前专项验收。
2. **旧工作台非回环云端画像授权体验**：按本轮范围，旧工作台（`web.mjs`）仅放行已授权的本机回环模型画像，非回环模型明确返回 `403 CLOUD_CONSENT_REQUIRED`；待旧工作台接入与 `/v1` 一致的显式预览确认流后再开放云端画像。
3. **真实外部凭证联测**：真实个人只读采集快照（知乎登录 + `agt_` 令牌）、真实知乎公开搜索与本机真实 Ollama 模型推理仍需在具备个人授权与运行态凭证的环境中按 P0 放行标准独立补测。

---

## 7. 整站验收补修交付回执（按 SITE_ACCEPTANCE_FOLLOWUP.md）

- **分支与工作区基线**：本地 `main@56290b9` + 上一轮整站交付工作区改动 + 本轮补修改动（更新日期：2026-11-26）
- **运行宿主**：Linux，Node.js `v24.22.3`（`/home/lululu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`），Playwright `data-collection-service/node_modules/playwright-core` + `/usr/bin/google-chrome`（零外部凭证、离线可复跑）。
- **合成版启动命令**：
  ```bash
  export PATH="/home/lululu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
  cd agent && npm run serve:demo:web
  ```

### 7.1 修复前后观测与核心改动（F-A1 至 F-C2）

| 验收编号 | 修复前观测 | 修复后行为与改动点 | 对应测试文件与测试名 | 状态 |
| --- | --- | --- | --- | --- |
| **F-A1** | `POST /v1/sessions` 首次未同意返回空清单；仅传 `cloudConsent: true` 不带预览 ID 直接返回 `201` 并把首见片段标为已确认。 | `server.mjs` 改为严格两步流程：本机先固定快照并按统一口径裁剪，非回环云推理且存在个人片段时，未同时匹配 `cloudConsent: true` + `outboundPreviewId` + `snapshotId`（含缺 ID、空清单 ID、片段/快照/目标变化）一律 `403 CLOUD_CONSENT_REQUIRED` 并返回实际非空未确认清单，云模型调用为 `0`；匹配重试 `201` 且首轮仅发该清单片段。同步更新 `HTTP_API_CONTRACT.md`、`schemas/http-api-v1.schema.json` 与既有回归测试。 | `agent/test/p0-a-consent-preview.test.mjs`：`F-A1：首次请求返回实际非空未确认清单且模型调用为 0；只传同意、空清单 ID、快照/片段/端点变化及缺错 snapshotId 均 403 不建会话；匹配重试 201 且首轮仅发已确认片段` | **通过** |
| **F-A2** | 首次确认缺少强绑定时，需端到端复核 240 字裁剪末段零泄露、撤回持久化及回环/关闭材料直通路径。 | `material-policy.mjs`、`server.mjs` 与 `turn-orchestrator.mjs`/`turn-prompts.mjs` 共享同一 160 码点裁剪与 `snapshotId`/`outboundPreviewId` 哈希口径；确认后实抓模型输入逐项一致且末段标记不出现；撤回及重启保持 `403`；回环模型与 `usePersonalMaterials: false` 继续直接 `201`。 | `agent/test/p0-a-consent-preview.test.mjs`：`F-A2：240 字合成材料两步确认后逐项比对模型输入且末段标记绝不出现；撤回与重启保持 403 且 0 新增调用；回环与关闭个人材料直接 201 成功` | **通过** |
| **F-B1** | 旧工作台非回环设置下虽阻止刷新画像，但 `web.mjs` 与 `interaction.mjs` 仍把既有画像兴趣标签送入外部公开检索和模型提示词。 | `material-policy.mjs` 新增共用 `evaluateLegacyProfileOutboundPolicy`，在 `web.mjs`（`createInteractionController` 与 `handleAsk`）及 `interaction.mjs`（`generateViewpoints`、`selectViewpoint`、`submitChoice` 纵深防御）构造外部搜索与模型提示前统一校验；未接入已确认清单时回退通用议题，外部检索与模型提示零画像标记，本机 `/api/profile` 展示保留不变。 | `agent/test/p0-b-legacy-profile-gate.test.mjs`：`F-B1.1`、`F-B1.2`、`F-B1.3`<br>`agent/test/interaction.test.mjs`：`纵深防御：即使调用方直接注入 getProfile，非回环模型 / 非 demo 外部搜索 / 关闭个人材料均不外发画像衍生标签并回退通用议题`<br>`agent/test/material-policy.test.mjs`：`evaluateLegacyProfileOutboundPolicy：本机展示放行、关闭授权阻断、外部检索与非回环模型需已确认清单` | **通过（5/5）** |
| **F-B2** | 空快照手动刷新同步抛错在 `runPromise` 赋值前执行 `finally`，导致运行槽永久泄漏，补入采集记录后同进程刷新仍失败；`profile.mjs` 传入外部 `signal` 时忽略内置超时信号。 | `web.mjs` 改为独立运行槽对象 `activeProfileRun` 先占位、按槽引用安全释放；空快照返回明确非 `500` 状态 `409 NO_COLLECTION_RECORDS`（0 模型调用），补入记录后同进程恢复成功；`profile.mjs` 通过 `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])` 合并取消与超时信号，`web.mjs` 支持 `profileTimeoutMs` 且在超时与关闭设置中止后均禁止延后落库。 | `agent/test/p0-b-legacy-profile-gate.test.mjs`：`F-B2.1`、`F-B2.2`、`F-B2.2b`、`F-B2.3`<br>`agent/test/profile.test.mjs`：`generateProfile 同时合并调用方取消信号与超时信号：两者均可独立触发中止` | **通过（5/5）** |
| **F-C1** | 生成中首段输出后刷新页面，前端把快照中的运行中轮次恢复为空闲态、禁用停止按钮且不再订阅 SSE。 | `live-session.js` 的 `restoreSavedSession()` 识别 `snap.activeTurnId` 或运行中末轮，不重新 `POST /turns`，立即恢复 `running` 状态与可用停止按钮，清空局部文本后从头重放同一 `turnId` 的 SSE（按整型事件 `id` 去重，普通断线继续按 `Last-Event-ID` 补齐）；刷新临界已提交时正确处理重放终态并同步最终图版本。 | `agent/test/p1-c-followup-browser.test.mjs`：`F-C1 生成中刷新恢复当前轮次：成功提交续流、主动停止取消、刷新临界恰好提交与零重发校验` | **通过** |
| **F-C2** | `turn.committed` 提前把账单写为 `v1`/100% 而星图仍为空 `v0`；慢快照或失败时出现图账错版；空态硬编码 `v0`；`.adopted-pill` 覆盖 `[hidden]` 导致原句卡误显「已采用」。 | `live-session.js`、`cover.js`、`analysis.js`、`galaxy.js`、`index.html`、`cover.css` 实现提交后标记「正在同步结果」（`snapshot-sync-banner` / `snapshot-sync-status`），仅由携带目标版本或更新版本的完整快照单次原子更新星图、节点列表、账单、事实与改写状态（忽略过时/乱序快照）；慢快照与失败时整组维持上一版本并提供可见重试按钮 `snapshot-retry-btn`；空态全部动态取实际 `v${graphVersion}`；修复 `[hidden]` 样式确保仅对应已采用改写显示唯一 `adopted-badge`。 | `agent/test/p1-c-followup-browser.test.mjs`：`F-C2 慢快照与失败快照图账原子同步、唯一采用标识、全部撤回空态真实版本及手机端恢复` | **通过** |

### 7.2 全仓回归与新增补修验收复跑命令（总计 331 / 331 通过）

```bash
export PATH="/home/lululu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
node -v   # v24.22.3

# 1. 全仓完整回归矩阵与十二轮合成回放
(cd agent && npm ci && npm test && npm run replay:12turns)    # 226 / 226 通过（16 suites，0 失败，8.31s）；12 轮回放 finalGraphVersion=3, converged=true
(cd quotation-engine && npm test)                             # 10 / 10 通过（0 失败）
(cd information-search && npm test)                           # 17 / 17 通过（0 失败）
(cd data-collection-service && npm test)                      # 26 / 26 通过（5 suites，0 失败）
(cd frontend-design && node web/src/verify/verify-p0.mjs && node web/src/verify/verify-p1.mjs && node web/src/verify/verify-p2.mjs)
# P0 10/10、P1 15/15、P2 27/27（合计 52 / 52 通过）

# 2. 单独复跑本轮补修验收套件（F-A1..F-C2 与 R-A1..R-C2）
(cd agent && node --test \
  test/material-policy.test.mjs \
  test/p0-a-consent-preview.test.mjs \
  test/p0-b-legacy-profile-gate.test.mjs \
  test/demo-web-host.test.mjs \
  test/p1-c-site-browser.test.mjs \
  test/p1-c-followup-browser.test.mjs)
```

### 7.3 真实个人版后续放行项（按方案留待下阶段）

- 真实个人版放行仍需独立完成本人授权采集链路验收，以及 `QA-05` 跨主体判定与 `QA-06` 真实模型流式断言核验；当前整站合成闭环、首次云授权两步预览确认、旧工作台外发边界与任务恢复、生成中刷新与图账原子同步已全量通过验收。

---

## 8. 真实公开版星图对话交付回执（按 LIVE_STARFIELD_ASSIGNMENT.md）

- **分支与工作区基线**：本地 `main@56290b9` + 前序整站交付与补修 + 本轮真实公开版星图对话改动（更新日期：2026-11-26）
- **运行宿主**：Linux，Node.js `v24.22.3`（`/home/lululu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`），Playwright `data-collection-service/node_modules/playwright-core` + `/usr/bin/google-chrome`，实测联调对接真实知乎官方公开搜索 Skill 与真实 OpenAI 兼容模型（`glm-5.3-flash`，凭证仅从本机 `.env` 读取，零明文落盘与回显）。
- **真实公开版启动命令**：
  ```bash
  export PATH="/home/lululu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
  cd agent && npm run serve:public:web
  ```
  - 合成演示版启动命令保持独立：`cd agent && npm run serve:demo:web`。
  - 两端共用统一握手接口 `POST /api/host/session`，前端不再硬编码 `dataMode: "demo"`。

### 8.1 核心交付模块与人性化/流式体验升级

1. **真实公开宿主与多浏览器隔离（`agent/public-web-host.mjs`、`agent/materials.mjs`）**：
   - 为每个浏览器签发独立 `HttpOnly; SameSite=Strict` Cookie 与服务端专属 `ownerId`（`pub_<16hex>`），跨浏览器访问返回 `403 SESSION_FORBIDDEN`。
   - 强制 `usePersonalMaterials: false`、绝不连接个人采集服务，显式拒绝客户端提交 `usePersonalMaterials: true`、`snapshotId`、`initialGraph`、预置 `proposal` / `action.proposal` 或外部地址字段；缺凭证时以明确 `capabilities` 状态启动且不崩溃；`/favicon.ico` 返回 `204`。
   - 接入知乎公开搜索，支持模型拆句 `plannedQueries` 透传、基于 `canonicalUrl` 与 `contentId/contentKey` 去重，清晰区分 `not_configured` / `rate_limited` / `timeout` / `empty` 四类状态。
2. **模型主张拆解、结构化提议与严格后端核验（`agent/public-proposal.mjs`、`agent/verifier.mjs`、`agent/session-store.mjs`、`agent/turn-orchestrator.mjs`）**：
   - 新增生产用 `decomposePublicClaim` 与 `createPublicProposalResolver`，并由 `verifyPublicAnalysisProposal` 强制校验每条 `quote` 必须为对应材料 `excerpt` 真实子串、隔离不同主体/对象（如甲工厂 vs 乙工厂）防误标冲突、仅覆盖局部场景的材料归为 `qualify`。
   - 流式守卫升级：拦截阿拉伯百分比与中文数字百分比（如「七十二个百分点」「百分之七十二」「八成」）、无源引文与无引号伪冲突断言；同时允许模型自然引用已核验的改写建议短语，保证逐短语顺滑推送不断句。
   - `session-store.mjs` 与 `turn-orchestrator.mjs` 将公开分析结果以独立 `publicAnalysis` 结构随 `graphVersion` 原子落库，绝不冒充个人 `confirmedGraph`，并在同批公开证据下支持「追问出处 / 纠错补条件 / 改写对比」的 `relationChanges` 追踪。
3. **温柔人性化语气与动态流式星图界面（`agent/turn-prompts.mjs`、`frontend-design/web/`）**：
   - 参考 `humanizer-zh` 原则重塑系统提示词与降级话术：2–4 句大白话（约 60–140 字），禁用「综上所述 / 不仅……更…… / 值得一提的是 / 首先其次最后 / 图版本 / 承重分母」等 AI 腔与实现术语，自然留白边界。
   - 首屏即自由输入（「这句话，你想怎么说？」「看看这句话」），回复旁直接展开出处（「看看出处」「在星图里看它」「查看知乎原文 ↗」），与右侧依据星图双向联动高亮；提供可编辑改写框（「试试这句」「复制这句」），首轮隐藏空白的「这一改，哪里变了」卡片。
   - 针对真实检索 + 核验的等待窗口新增四步动态呼吸星轨条（`.public-live-orbit`）与流式打字光标（`.public-reply-text.is-streaming::after`），实测首反馈（`focus.selected` + 阶段条）仅 5–28ms，模型回复通过多个 `text.delta` 渐进流出。
4. **协议契约与文档同步**：更新 `agent/HTTP_API_CONTRACT.md`、`agent/schemas/http-api-v1.schema.json`（新增 `$defs/PublicAnalysis`）、`agent/examples/session-snapshot-v1.json`、`agent/examples/sse-turn-events-v1.json`、`agent/README.md`。

### 8.2 验收对照记录（L-01 至 L-05）

| 验收编号 | 验收方式与实测观测 | 对应测试或实测记录 | 状态 |
| --- | --- | --- | --- |
| **L-01** | 接入真实知乎公开搜索 + 真实 `glm-5.3-flash`，对 4 句未出现在任何演示或测试语料中的跨领域原句完成真实检索、流式回复与页面联调（含首句同批改写 `v1 -> v2`）：<br>1)「早上空腹喝黑咖啡一定会伤胃。」：`requestIds=[411d311a-c23a-47cf-b36f-c89102fd3878, ccfbc1d3-bc1c-469b-b741-c8185b48e401]`，召回 3–6 条、核验 3–5 条，首反馈 28ms、检索 3555ms、流式 `9` 个 `text.delta`（均值 9.9 字/片、跨度 589ms）、总耗时 12.2s；点击「试试这句」后 `v1 -> v2` 复用同批证据，鱼乐/丁香医生由 `反驳 → 支持`。<br>2)「普通人学编程只要每天坚持刷题就一定能拿到大厂研发offer。」：`requestIds=[0070add3-36e1-40d4-b0e2-5bf7c61dce55, 31fd6a83-4509-4d9b-b73d-5f0374a3e9e5]`，召回 6 条、核验 6 条，首反馈 26ms、检索 3517ms、流式 `7` 个 `text.delta`（跨度 377ms）、总耗时 16.3s。<br>3)「在南极科考站用低温发酵法酿造酸面团面包绝对不会失败。」：`requestIds=[b26fe734-745e-44ca-b049-32edd0e76ae2, cfabd0ae-6c40-451c-a73d-67d4a97edb46]`，召回 6 条、核验 3 条（3 条归为未知并如实说明无南极科考站直接做面包资料），首反馈 6ms、检索 3212ms、流式 `10` 个 `text.delta`（跨度 772ms）、总耗时 11.3s。<br>4) 极端材料不足对照「火星水手谷地下的液态甲烷湖里生活着会发光的硅基水母。」：`requestIds=[4400c9a1-d857-481d-8ab5-85d9e6de421f, 1aa34be8-0ff4-4064-a9da-7d4256f08cd9]`，召回 6 条仅 1 条相关，5 条明确拒标并在 `unknownParts` 逐条写清「实际探测是水冰不是液态甲烷湖」，未编造反例。 | 真实 `public-web-host.mjs`（`127.0.0.1:3016`）SSE 流式遥测 + 浏览器实测 | **通过** |
| **L-02** | 跨主体隔离（甲工厂 vs 乙工厂 / A公司 vs B公司 / 一车间 vs 二车间）严禁误标冲突或支持；虚构引文与不存在 `evidenceId` 拦截；流式守卫拦截中文数字百分比（如「七十二个百分点」）与无源引文；SSE、SQLite 持久化与 `publicAnalysis` 完全一致。 | `agent/test/live-l02-verification.test.mjs`（5/5）<br>`agent/test/live-l02-l03-orchestrator.test.mjs`（3/3）<br>`agent/test/public-web-host.test.mjs`（5/5） | **通过** |
| **L-03** | 真实浏览器桌面端（`1440×900`）连续 4 轮公开对话：首轮自由输入 -> 点开「看看出处」核对原作者/片段/知乎链接并双向高亮星图 -> 追问出处 -> 纠错补条件 -> 同批证据改写对比显示「这一改，哪里变了」，刷新恢复一致且不混入合成演示语料。 | `agent/test/live-l03-l04-browser.test.mjs`：`L-03 · 可继续的公开对话（桌面端）` | **通过** |
| **L-04** | 桌面端（`1440×900`）与手机端（`390×844`）覆盖：搜索限流/超时/空结果温柔提示保留原句且不卡死、生成中刷新恢复同一轮与取消、慢/失败快照重试同步、缺搜索或模型凭证给出明确提示并可切回合成演示。 | `agent/test/live-l03-l04-browser.test.mjs`：`L-04 · 桌面（1440x900）与手机端（390x844）降级、刷新恢复、快照同步与缺上游明确提示` | **通过** |
| **L-05** | 使用浏览器插件在桌面端（`1440×900`）与手机端（`390×844`）真实走查全流程，当场发现并修复 6 项体验问题：① `decomposePublicClaim` 透传模型检索词防止切词丢掉主语（如丢「黑咖啡」）；② `public-proposal.mjs` 容错 `unknown` 空引文防止模型好改写误降级；③ 流式守卫放行已核验改写短语避免尾句被截断；④ 修复「在多数情况下的情况下」和「一定会→往往会会」文案重复；⑤ 手机端 `.public-citation-summary` 在列排时取消 `220px` 高度撑白及星图列表 `.public-rel-badge` 禁止折行；⑥ 焦点胶囊过长自动截断并保留 `title` 悬浮全文。 | 浏览器插件现场走查与截图复验；**说明**：仍建议对外公开演示前邀请 1 位未看过说明的外部测试者做一轮真实盲测。 | **代理走查通过（外部盲测待补）** |

### 8.3 全仓回归与公开版专项复跑命令（总计 346 / 346 通过）

```bash
export PATH="/home/lululu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
node -v   # v24.22.3

# 1. 全仓完整回归矩阵与十二轮合成回放（346 / 346 通过，0 失败）
(cd agent && npm test && npm run replay:12turns)        # 241 / 241 通过（16 suites）；12 轮回放 finalGraphVersion=3
(cd quotation-engine && npm test)                       # 10 / 10 通过
(cd information-search && npm test)                     # 17 / 17 通过
(cd data-collection-service && npm test)                # 26 / 26 通过（5 suites）
(cd frontend-design && node web/src/verify/verify-p0.mjs && node web/src/verify/verify-p1.mjs && node web/src/verify/verify-p2.mjs)
# P0 10/10、P1 15/15、P2 27/27（合计 52 / 52 通过）

# 2. 两套同源宿主 CLI 帮助检查
(cd agent && npm run serve:public:web -- --help >/dev/null && npm run serve:demo:web -- --help >/dev/null && echo "BOTH_HOSTS_HELP_OK")

# 3. 单独复跑本轮真实公开版验收测试（L-02..L-04）
(cd agent && node --test \
  test/public-web-host.test.mjs \
  test/live-l02-verification.test.mjs \
  test/live-l02-l03-orchestrator.test.mjs \
  test/live-l03-l04-browser.test.mjs)
```

### 8.4 诚实边界与后续放行项

1. **外部未读说明真人盲测（L-05 最终确认）**：本轮已通过浏览器插件在桌面与手机视口亲自完成多轮真实联调与视觉修复，但尚未由团队外的初次体验者在未读文档情况下独立盲测，建议在公开演示前补一次 5 分钟真人走查。
2. **个人授权采集版放行仍独立**：真实公开版（`serve:public:web`）严格不读取、不连接任何个人采集数据；真实个人版放行仍需在具备知乎登录态与 `agt_` 令牌的环境中独立完成个人采集快照链路验收。
