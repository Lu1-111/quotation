# CLI 输出 JSON 格式

CLI 的业务成功结果包括采集快照与管理状态，另提供环境检查诊断。只有采集快照使用版本 3；不要把 `status --json` 或 `doctor --json` 的版本 1 当作采集数据。

## 采集快照

以下命令输出相同结构：

```powershell
node cli.mjs sync --profile personal --json
node cli.mjs export --profile personal
node cli.mjs export --profile personal --output .data/exports/personal.json
```

`sync` 先获取并整体保存成功结果；`export` 只读取本机快照。指定 `--output` 的文件与 stdout 快照结构相同。若同时使用 `--json`，stdout 仍输出快照，文件路径不作为新字段混入协议。

Schema：[collection-output.schema.json](schemas/collection-output.schema.json)；完整合成样例：[collection.snapshot.json](examples/collection.snapshot.json)。

| 顶层字段 | 含义 |
| --- | --- |
| `schemaVersion` | 固定 `3` |
| `source` | 真实为 `zhihu_selected_data`，演示为 `demo_history` |
| `account` | `{ nickname }`，仅显示用，不能用昵称合并用户 |
| `syncedAt` | 最近成功采集的 ISO 时间 |
| `policyVersion` | 内容过滤规则版本 |
| `settings` | `history`、`likes`、`collections`、`knowledgeFilter`、`aiReview`；CLI 当前关闭 AI |
| `records` | 合格内容，按权重排序，同一帖合并不同来源 |
| `excluded` | 被过滤内容及理由，不计入主结果排序 |
| `revision` | 快照指纹，便于识别重复结果 |
| `counts` | 各来源的合格数量，同一帖子可计入多个来源 |

每条主记录包含字符串 `contentId`、`contentType`、`key`、标题、平台摘要、作者、URL、话题、互动指标、采集时间、`kinds`、`signals`、`weight`、`weightDetails` 和筛选 `analysis`。`kind` 是兼容字段，识别所有行为来源应使用 `kinds`。

- `sourceReadTime` 是秒级浏览发生时间字符串，不是阅读时长或阅读完成比例。
- `signals` 的时间可能是秒级字符串、数值或 `null`；`observedAt`、`syncedAt` 是 ISO 时间。
- 指标缺失为 `null`，不能转成 0。`weight` 是排序信号，不是知识掌握程度；未配置类型可能为 `null`。
- `summary` 是平台摘要；`analysis.summary` 才是实际模型总结。CLI 当前采用本地规则，不能声称已阅读全文。
- `analysis.decision` 为 `keep`、`exclude` 或 `review`。`review` 要携带不确定性，不应视为确定的知识证据。
- `bodyText`、`bodyStatus`、`bodySource` 为条件字段。没有完整正文时不能把摘要作为全文传递。
- `counts` 可重叠，独立帖子数以 `records.length` 为准。

数据协议与网页版的版本 3 保持兼容；CLI 档案名不额外插入快照。Agent 宿主应另外保留本机 profile 与应用用户的映射，不按昵称或不同设备上的同名 profile 合并用户。

## 管理状态

`login --json`、`config --json`、`status --json`、`logout --json` 和 `clear --json` 返回 CLI 状态，例如：

```json
{
  "schemaVersion": 1,
  "mode": "cli",
  "demo": false,
  "profile": "personal",
  "exists": true,
  "consented": true,
  "bound": true,
  "nickname": "示例用户",
  "lastSyncedAt": null,
  "browser": "msedge",
  "settings": {
    "history": true,
    "likes": false,
    "collections": false,
    "knowledgeFilter": true,
    "aiReview": false
  },
  "counts": { "history": 0, "likes": 0, "collections": 0 }
}
```

档案不存在时 `exists: false`，尚未绑定时 `bound: false`，`browser` 可能缺失。登录与清理结果可额外含 `operation`。`profiles --json` 返回 `{ schemaVersion: 1, mode: "cli", demo, profiles: ["personal"] }`；`unlock --json` 返回 `{ profile, unlocked }`。

管理状态不包含 Cookie、平台令牌或浏览器登录目录，不是用户内容分析输入。

`doctor --json` 返回 `{ schemaVersion: 1, mode: "cli", kind: "environment_check", nodeVersion, platform, nodeReady, desktopPlatform, displayReady, browser, launchCheck, demoReady, readyForLogin, notes }`。`browser` 含选择偏好、选中浏览器和安全诊断错误；`launchCheck` 含 requested、ok、error，未执行启动检查时 ok 为 null。就绪返回码 0，不就绪返回码 3；即使返回码 3，stdout 仍为完整诊断对象，不是错误流。此命令不创建采集数据或证明知乎登录有效。

## 错误与流

成功命令在 stdout 输出结果；使用 `--json` 时仅有一个 JSON 对象。失败时 stdout 为空，stderr 返回如下对象，并用非零退出码表示失败：

```json
{
  "error": {
    "code": "CONSENT_REQUIRED",
    "message": "首次采集需显式加入 --consent，表示同意将所选账号信息保存到本机。"
  }
}
```

先检查退出码，再解析 stdout。常见错误码有 `INVALID_ARGUMENTS`、`INVALID_PROFILE`、`UNSUPPORTED_NODE`、`DEPENDENCY_MISSING`、`BROWSER_NOT_FOUND`、`CONSENT_REQUIRED`、`LOGIN_REQUIRED`、`ACCOUNT_OR_SESSION_MISMATCH`、`PROFILE_BUSY`、`NO_SNAPSHOT`、`OUTPUT_EXISTS`、`OUTPUT_WRITE_FAILED`、`CANCELLED`。进度提示只写 stderr，`--json` 会隐藏普通进度；Node 本身的运行警告也可能出现在 stderr，宿主不应把所有 stderr 文本当成单一成功结果。

SDK `runtime.execute()` 返回 `{ type: "snapshot" | "status", value, savedTo? }`，其中 `value` 才是上述业务对象；调用失败抛出异常，宿主可用 `safeCliError()` 转成稳定错误。示例与 Schema 允许适度扩展字段，消费方需识别版本并忽略不认识的可选扩展。
