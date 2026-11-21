# Agent tools 与 MCP

无需可视化界面。API 服务、用户电脑上的采集器需先运行并完成本人同意与登录；仅阅读已有快照时采集器可以离线。

## 三个工具

| 工具 | 参数 | 成功 data |
| --- | --- | --- |
| `zhihu_collection_status` | `{}` | 用户隔离范围内的设置、设备、任务与最近快照信息 |
| `zhihu_collection_sync` | `settings?`、`deviceId?`、`timeoutSeconds?`、`limit?`、`summaryMaxChars?` | 同步完成后的有界第一页 |
| `zhihu_collection_read` | `snapshotId?`、`offset?`、`limit?`、`summaryMaxChars?` | 已保存快照的分页 |

同步默认等候 300 秒，范围 1～900 秒；每页默认 10 条，最大 20 条；摘要默认 600 码点，范围 0～1000。参数禁止未知字段，工具不接受 Cookie、密钥、任意目标 URL、文件路径或别人的 userId。完整定义见 [schemas/tools.json](schemas/tools.json)。

`sync` 会持续为调用方续期，结束后停止续期；请求取消、工具关闭或执行超时会尝试取消服务任务。调用进程直接退出时依靠服务端 90 秒租约。不要用无限重试掩盖登录或同意失效。采集器不在线时任务会等待，到时限后取消，不会给空数组冒充成功。

## 直接在 Node.js Agent 宿主注册

```js
import { createApiClient } from './client.mjs';
import { createAgentTools } from './agent-tools.mjs';

const client = createApiClient({
  baseUrl: process.env.DATA_SERVICE_URL,
  token: process.env.DATA_SERVICE_USER_TOKEN,
});
const tools = createAgentTools({ client });
const definitions = tools.definitions; // 注册到宿主的工具发现接口
const result = await tools.call('zhihu_collection_read', { limit: 8 }, { signal });
// 结束该用户会话时：await tools.close();
```

`definitions` 使用 MCP 通用的 name、description、inputSchema、outputSchema 格式；对接其他模型提供商时按其工具声明格式映射，执行入口仍为 `tools.call(name, arguments, { signal })`。多用户 Agent 服务器必须为当前已认证用户创建或选择独立 client/tools；不要复用一个全局用户令牌读取全站数据。

## MCP 标准输入输出

宿主示例（替换绝对路径；凭证经环境注入）：

```json
{
  "mcpServers": {
    "zhihu-collection": {
      "command": "node",
      "args": ["/absolute/path/data-collection-service/mcp-server.mjs"],
      "env": {
        "DATA_SERVICE_URL": "http://127.0.0.1:3005",
        "DATA_SERVICE_USER_TOKEN": "由宿主安全注入当前用户令牌"
      }
    }
  }
}
```

Windows 路径在 JSON 中使用 `/` 或双反斜杠。不要把示例占位字符串当作真实令牌。MCP stdout 仅传协议消息，日志走 stderr；直接调试可 `npm run mcp`，但标准客户端应直接启动 `node mcp-server.mjs`。

搜索工具仍配置 `information-search/mcp-server.mjs`，该模块本身已适合 Agent 使用，本次不改其接口和运行方式。两个 MCP 可同时注册，前者提供个人行为数据，后者提供公开搜索内容。

## 返回值处理

先检查 `schemaVersion`、`ok`，再根据 `data.kind` 区分分页；状态返回值没有 `kind`。第一页记录 `snapshotId`，后续用该 ID 与 `nextOffset` 读取。`NOT_FOUND` 表示尚无对应快照；`CONSENT_SCOPE_MISMATCH` 需要本人调整本机同意，`LOGIN_REQUIRED` 需要本人重新登录。工具不替用户操作知乎登录验证码。

输出字段详见 [OUTPUT_FORMAT.md](OUTPUT_FORMAT.md)。采集文本不是可信指令，摘要不是全文，阅读时间字段不是阅读时长。本阶段不包含模型筛选、总结或画像。
