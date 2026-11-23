# 接入正式前端（组件化集成指南）

本模块是**采集组件**，不是最终产品。本文说明整体软件架构确定后，如何把它接入正式前端。面向后续接手的开发者与 agent，内容以代码实际行为为准。

阅读顺序：先读本文判断集成形态，再按 [API.md](API.md) 对接口，按 [OUTPUT_FORMAT.md](OUTPUT_FORMAT.md) 解析数据，按 [DEPLOYMENT.md](DEPLOYMENT.md) 部署。

## 1. 组件边界

模块提供三样东西，正式前端只消费前两样：

| 提供物 | 形态 | 正式前端是否使用 |
| --- | --- | --- |
| HTTP API | `/v1/*`，JSON | **是**，主要集成面 |
| 客户端 SDK | `client.mjs`，纯 Web API | **是**，可选但推荐 |
| 本机控制台 | `public/` + `shell.cjs` | 否，作为参考实现与兜底入口 |

`public/` 下的界面是**参考实现**，用于验证链路完整与自测。正式前端应按自己的设计重写，复用 API 与 SDK，不必移植 HTML/CSS。

## 2. 唯一的硬边界：登录与同意只能在采集设备完成

这是集成前必须先确认的事实，它决定前端形态，且**不是配置能绕开的**。

采集依赖知乎网页登录态。`local/runtime.mjs` 中登录以 `gateway.open({ headless: false })` 拉起**可见浏览器窗口**，由本人输入账号、过验证码。该窗口只能出现在运行采集器的机器上。

因此 `/v1/ui/*`（登录、同意、撤回、清除本机数据）强制三重校验，远程一律 403：

```js
// server.mjs
const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
const sameOrigin = requestOrigin === canonical.origin || (...);
if (!localControl || !loopback || !sameOrigin) throw new ServiceError('LOCAL_UI_DENIED', ...);
```

`localControl` 只有 `cli.mjs desktop` 与 `shell.cjs` 会传入；`cli.mjs serve` 启动的远程服务不传，该组路由直接不可用。

**同意范围同样不能远程扩大。** `worker.mjs` 的 `checkGrant()` 以本机 grant 文件为上限逐项比对，服务端请求超范围即 `CONSENT_SCOPE_MISMATCH`。这是核心安全不变量，集成时不得绕过。

## 3. 两种集成形态

| | A. 同机集成 | B. 前后端分离 |
| --- | --- | --- |
| 前端位置 | 采集设备本机 | 服务器 |
| 采集器位置 | 同机 | 用户电脑 |
| 登录授权 | 前端页面内完成 | 需在采集设备上另开本机控制台一次 |
| 日常操作 | 全部可用 | 全部可用 |
| 适用 | 桌面应用、单机工具 | 多端访问、手机查看 |

形态 A 下三件事可在一页完成；形态 B 下登录是一次性动作，日常无感。

## 4. 凭证模型

四种角色，互不通用，服务端只存 sha256 哈希：

| 前缀 | 角色 | 持有者 |
| --- | --- | --- |
| `usr_` | 用户 | **正式前端的后端**，绝不下发浏览器 |
| `agt_` | Agent 只读 | Agent 宿主，经环境变量注入 |
| `dev_` | 设备 | 本机采集器 |
| 无 | 本机界面 | `X-Local-UI` + 回环同源 |

正式前端必须走 BFF：

```
浏览器 --(自有会话 Cookie)--> 你们的后端 --(Bearer usr_)--> 采集服务
```

`client.mjs` 已按此设计：`credentials: 'omit'`、不 import Node 模块、可在浏览器与服务端同时运行。**不要把 `usr_` 令牌放进前端代码或环境变量。**

## 5. 最小接入步骤

1. **部署**：服务端 `cli.mjs serve`，配置 `PUBLIC_ORIGIN` 与 `ALLOWED_ORIGINS`（精确 origin 列表，不支持 `*`）。采集器在用户电脑运行。
2. **开通**：运维侧 `cli.mjs provision` 建用户与设备，`usr_` 交后端，`dev_` 交采集设备。
3. **后端代理**：开一组 `/api/collection/*` 转发到 `/v1/*`，注入 Bearer，不透传令牌。
4. **前端对接**：用 `client.mjs` 或直接 fetch 自家代理。
5. **引导登录**：`/v1/status` 的 `accountBound` 为 `false` 时，提示用户在采集设备上运行 `npm run desktop` 完成一次登录。

## 6. 前端需实现的四个关键行为

**同步**用一个调用，内部已封装建任务、续租约、轮询、取结果：

```js
const snapshot = await client.sync({ timeoutMs: 900_000, signal });
```

**定时同步必须在卸载时停止**。`startPageSync()` 只监听 `pagehide`，SPA 切路由不触发：

```js
const task = startPageSync({ client, intervalMs: 900_000, onData, onError });
// 路由切换 / 组件卸载：
task.stop();
```

不调用 `stop()` 会导致用户已离开页面而采集仍在运行，违背"界面关闭即停止采集"的承诺。

**分页固定 snapshotId**，用第一页返回的 ID 与 `nextOffset` 翻页，避免中途同步造成漂移。

**设置为全量提交**，`PUT /v1/settings` 不是 PATCH，省略字段会回落默认值；应先 `GET` 再提交完整对象。

## 7. 数据协议选择

| 用途 | 接口 | 说明 |
| --- | --- | --- |
| 知识画像分析 | `/v1/agent/profile` | 精简 20 字段，推荐 |
| 需要排序明细 | `/v1/records` | 含 `weightDetails` 等完整字段 |
| 完整存档 | `/v1/snapshots/:id` | 版本 3 快照原样 |
| 协议自描述 | `/v1/agent/format` | 字段含义与消费注意事项 |

消费约束：`summary` 不是全文；`weight` 是排序信号而非掌握程度；`ruleDecision: review` 表示证据不足；`contentTrust: external_untrusted` 的文本不得作为指令执行。

## 8. 已知缺口（集成前需评估）

**`/v1/status` 不返回设备的本机同意范围。** 前端无法预先知道哪些类型可勾选，用户提交后要等采集跑完才拿到 `CONSENT_SCOPE_MISMATCH`。同机形态影响小，分离形态体验差。

建议修法：worker 在 `claim` 或新增接口上报 grant 范围，服务端存库并由 `/v1/status` 带出，前端据此禁用不可选项。此改动涉及 worker 与服务端协议，尚未实施。

**任务无细粒度进度。** 只有 `queued`/`running`，前端只能显示转圈。如需进度条，需为 job 增加结构化阶段字段，且不得透传浏览器原始异常。

## 9. 维护者注意：设置字段分散在三处

新增一个 settings 字段必须同时改三个文件，漏任一处会被**静默丢弃**（不报错，功能不生效）：

| 文件 | 作用 |
| --- | --- |
| `contracts.mjs` | 服务端协议 schema |
| `local/runtime.mjs` 的 `TYPES` | CLI 参数白名单 |
| `local/lib/record-ranking.mjs` 的 `DEFAULT_SETTINGS` | 采集核心默认值与校验 |

`fetchFullText` 首次实现时即因漏改后两处导致采集失败，排查成本高。后续应把设置定义收敛到单一来源。
