# API 接口

接口来源为部署时的 `PUBLIC_ORIGIN`。除 `/health` 外均需要 `Authorization: Bearer <凭证>`，JSON 请求体设置 `Content-Type: application/json`。用户和设备凭证分开，不互通；服务端从凭证确定用户，拒绝客户端自填 `userId`。HTTP 不使用 Cookie 鉴权，也不提供知乎 Cookie 上传接口。

成功：`{ "schemaVersion": 1, "ok": true, "data": {...}, "error": null }`。领取不到任务时 `data: null`。错误：`{ "schemaVersion": 1, "ok": false, "data": null, "error": { "code": "...", "message": "..." } }`。`/health` 只返回服务名和演示标记。

## 用户凭证接口

| 方法与路径 | 输入 | data |
| --- | --- | --- |
| GET `/v1/status` | 无 | 当前用户、模式、绑定状态、设置、设备、活跃任务、最近快照元数据 |
| GET `/v1/settings` | 无 | 五项设置 |
| PUT `/v1/settings` | 完整五项设置 | 保存后的设置；不改变已经排队的任务 |
| POST `/v1/jobs` | `{ settings?, deviceId? }` | HTTP 202，任务对象；未指定设备时任何当前用户的合格设备可领取 |
| GET `/v1/jobs/:id` | 无 | 当前用户自己的任务 |
| POST `/v1/jobs/:id/keepalive` | `{}` | 延长调用方租约并返回任务；已结束任务不复活 |
| DELETE `/v1/jobs/:id` | 无 | 取消后的任务；不会删除上次快照 |
| GET `/v1/snapshots/latest` | 无 | 最近完整交付快照 |
| GET `/v1/snapshots/:snapshotId` | 无 | 指定的不可变交付快照 |
| GET `/v1/records` | 查询参数见下文 | 有界分页，适合 Agent |
| DELETE `/v1/data` | `{ "confirm": true }` | 清除当前用户所有服务快照、解除账号绑定并取消未完成任务 |

五项设置均必填：

```json
{ "history": true, "likes": false, "collections": false, "knowledgeFilter": true, "aiReview": false }
```

至少勾选浏览、点赞、收藏中的一种，暂不接受 AI 筛选。服务端保存的选择仍需符合设备本机同意范围；只有本人重新执行 `worker-login --consent` 才能扩大本机范围。不能通过 PUT 设置绕过本机同意。

分页查询：`snapshotId` 可选，省略时取最新；`offset` 为 0～1000000，默认 0；`limit` 为 1～20，默认 10；`summaryMaxChars` 为 0～1000，默认 600。继续读取时固定第一页的 `snapshotId`，使用 `nextOffset`，避免新的同步导致翻页漂移。字符按 Unicode 码点截取，摘要裁剪不改变持久化原文。完整快照中的 `excluded` 排除记录只在完整交付中返回。

清除服务数据不会删除本机缓存、浏览器会话、设备凭证或操作系统备份；`worker-revoke` 会删除本机浏览器会话并撤回同意，保留本机采集缓存。要彻底清除，应停止采集器、撤回本机同意、调用服务清除接口，再按需删除该设备的私有数据目录及备份。Agent tools 不提供删除操作。

## 设备凭证接口

| 方法与路径 | 输入 | data |
| --- | --- | --- |
| GET `/v1/worker/info` | 无 | userId、deviceId、demo |
| POST `/v1/worker/claim` | `{}` | `{ job, leaseToken, heartbeatSeconds }` 或 null |
| POST `/v1/worker/jobs/:id/heartbeat` | `{ leaseToken }` | 续期后的任务 |
| POST `/v1/worker/jobs/:id/complete` | `{ leaseToken, accountRef, snapshot }` | 已保存的完整交付快照 |
| POST `/v1/worker/jobs/:id/fail` | `{ leaseToken, code }` | 失败任务 |

`accountRef` 为 `sha256("zhihu:" + 平台账号ID)`，由本机绑定记录生成；不把原始账号 ID、Cookie 或会话发送到服务端。失败 code 仅支持 `CONSENT_REQUIRED`、`CONSENT_SCOPE_MISMATCH`、`LOGIN_REQUIRED`、`ACCOUNT_MISMATCH`、`COLLECTION_FAILED`，不透传浏览器原始异常。

## 状态与可靠性

任务状态：`queued → running → succeeded | failed | cancelled`。设备租约失效且调用方仍在线时，任务可回到 `queued`，最多领取三次。用户同时只能有一个未完成任务。

任务包含 `id`、`state`、`deviceId`、`settings`、`attempts`、`createdAt`、`updatedAt`、`clientLeaseExpiresAt`、`workerLeaseExpiresAt`、`snapshotId`、`error`。任务查询不返回租约令牌。调用方默认 90 秒有效，设备默认 45 秒有效，采集器每约 15 秒心跳。服务每秒清理失效任务，接收上传时再次校验租约，因此即使清理尚未执行也不能补交已过期结果。

结果先校验协议、请求类别、计数、模式和绑定账号，再在 SQLite 事务内保存快照并更新任务。相同任务、相同设备租约、相同内容重复上传返回同一个 `snapshotId`；新租约、不同内容或取消后上传不接受。采集器网络异常只重试一次交付，不无限重跑采集。

常用错误：400 `INVALID_ARGUMENTS` / `INVALID_JSON`；401 `UNAUTHORIZED`；403 `HOST_DENIED` / `ORIGIN_DENIED`；404 `NOT_FOUND`；409 `BUSY` / `LEASE_EXPIRED` / `ACCOUNT_MISMATCH`；413 `BODY_TOO_LARGE`；415 `CONTENT_TYPE`。任务本身失败时查询仍返回 HTTP 200，由 `state` 与 `error.code` 判断结果。

服务只持有应用凭证哈希。创建用户、增加设备、撤销设备、轮换用户凭证由可信服务器上的 CLI 操作，详见部署文档；不存在公开管理员 HTTP 接口。
