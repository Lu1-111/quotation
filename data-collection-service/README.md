# 知乎通用数据采集模块

本模块将个人数据采集拆成统一 API 服务与本机采集器。网页、桌面应用、手机网页和 Agent 使用同一套 HTTP/JSON 协议；登录知乎和读取个人浏览、点赞、收藏信息由用户自己的电脑执行。服务端不需要安装浏览器，不接收知乎 Cookie，也不依赖旧模块目录。

已有 `information-search/` 保持独立，继续提供知乎官方公开内容搜索 tools。这里补充的是个人行为数据采集，不是官方 OAuth，也不能取得任意知乎账号的数据。

## 运行结构

```text
网页 / 桌面应用 / 手机网页 / 本地 Agent
          │ 用户凭证：请求任务、续期、读取结果
          ▼
    API 服务 + SQLite
          ▲
          │ 设备凭证：主动领取任务、心跳、交付 JSON
          │
用户电脑上的采集器 ── 专用浏览器会话 ── 知乎
```

采集器只主动向配置的服务地址发送请求，不开放本地端口。首次登录会显示浏览器供本人操作；后续采集使用无头浏览器，不另弹页面。遇到登录失效、验证码或平台接口变化会失败并保留上次成功快照，不能保证所有设备和网络都能采集。

推荐本地开发时服务与采集器同机；正式项目中把 API 放到统一后端，用户电脑只运行采集器。手机可以访问后端和已有结果，但不能直接读取手机知乎 App 的浏览记录。详见 [部署与适配](DEPLOYMENT.md)。

## 快速验证完整链路

需要 Node.js 24+。以下命令均在本目录执行。演示使用合成数据，不连接真实知乎，不下载浏览器或模型。

```sh
npm ci
npm run cli -- provision --demo --name demo-user --output .data/credentials-demo.json
npm run demo
```

保持服务运行，第二个终端执行：

```sh
npm run cli -- worker-login --demo --credentials .data/credentials-demo.json --consent --likes --collections
npm run cli -- worker --demo --credentials .data/credentials-demo.json
```

第三个终端请求并读取：

```sh
npm run cli -- sync --credentials .data/credentials-demo.json
npm run cli -- export --credentials .data/credentials-demo.json --output .data/exports/latest.json
```

服务默认只请求浏览记录。`worker-login` 中的类别是本机允许范围；网页勾选的实际请求还需通过 `saveSettings()` 或创建任务时的 `settings` 提交。只有允许范围内的种类才会被采集。`worker --once` 只检查并处理一次队列，没有任务就退出；正常运行使用前台 `worker`，Ctrl+C 停止。

真实模式去掉服务、provision、worker-login 和 worker 的 `--demo`；使用另一份凭证。`npm start` 启动真实服务；同一端口同时只能运行一个模式。真实采集器还需要已安装的 Edge 或 Chrome，可指定 `--browser msedge` 或 `--browser chrome`。首次本人执行 `worker-login --consent` 即同意将所选数据保存本机并上传到配置的服务，之后可 `worker-revoke` 撤回本机同意和清除登录会话。服务端的数据另行通过删除接口清理。

## 网页与其他模块接入

本目录的 [client.mjs](client.mjs) 使用标准 Web API，不导入 Node 内置模块，可由前端打包器导入。用户凭证由宿主应用提供，不能把管理员凭证、设备凭证或全站共用的用户凭证写进前端源码。

```js
import { createApiClient, startPageSync } from './client.mjs';

// 每个登录用户创建独立客户端；生产项目建议经自己的后端验证用户会话后转发。
const client = createApiClient({ baseUrl: 'https://collection.example.com', token: currentUserToken });
await client.saveSettings({ history: true, likes: true, collections: true, knowledgeFilter: true, aiReview: false });

const task = startPageSync({ client, intervalMs: 300000,
  onData: (delivery) => saveForLocalAgent(delivery),
  onError: (error) => showSyncStatus(error.code),
});
// 单页应用退出该页面时主动执行；整页关闭会由 pagehide 调用。
// task.stop(); await task.done;
```

`startPageSync` 在网页存活期间按间隔请求，前一次完成后才等待下一次，不产生并发采集。页面退出主动取消；浏览器崩溃、断电或移动端冻结时无法立即通知服务器，调用方停止续期 90 秒后任务过期，采集器下次心跳检测后停止，正常在线约再等最多 15 秒。已开始的网络请求关闭也需要时间。因此这是有界停止，不承诺关页瞬间终止所有系统活动。网页休眠可能导致任务被取消，恢复后由宿主重新启动调度。

服务和采集器可以继续等待请求，但本模块没有自行定时创建任务的后端定时器。要保持“仅网页打开时同步”，宿主只在页面生命周期内使用此调度，退出登录、卸载组件时调用 `stop()`；不要另外配置操作系统定时任务。

Agent 可直接导入 [agent-tools.mjs](agent-tools.mjs)，也可使用 [MCP 入口](AGENT_TOOLS.md)。Agent 默认获取有界分页；其他模块需要完整存档时读取交付快照。不要通过抓取控制台日志交付数据。

## 数据与采集规则

- 浏览记录按平台提供的时间顺序向前扫描，过滤用户主页和低质量回答，最多保留 50 条合格浏览记录。低质量回答按已约定标准：点赞少于 5 且评论少于 2 时排除；指标缺失保留并标注。
- 保留原有规则过滤、话题标签优先／标题关键词补充的主题近似匹配，以及类型、热度、同主题、时间权重。想法基础 1、文章 2、回答 3；热度加分在 0～1，同主题其他帖子每条加 0.5；纯浏览超过 7 天乘 0.9，超过 14 天乘 0.7。点赞／收藏基础类型权重乘 4/3，免时间衰减；合并记录有相应行为时同样免衰减。
- 点赞、收藏不设业务条数上限；仍受平台分页、网络、任务时限和 32 MiB 单次传输限制，超过限制明确失败，不静默截断。
- 当前只执行本地规则；AI 全文筛选、总结、知识画像尚未启用。`aiReview` 必须为 `false`，摘要与 `sourceReadTime` 不能解释成全文总结、阅读时长或阅读百分比。

服务端 `.data/server/live.sqlite` / `demo.sqlite` 保存按应用用户隔离的设置、任务、设备、不可变快照和凭证哈希。本机 `.data/worker/live|demo/` 保存按 `profile` 隔离的会话、同意记录、SQLite 与快照。服务数据、设备数据都默认落在实际运行设备上；远程部署后服务快照位于服务器磁盘，不会自动回到访问网页的手机上。

首次成功交付将应用用户绑定到设备声明的知乎账号摘要；同一用户后续切换成另一知乎账号会拒收。该摘要用于防串号，不是知乎官方身份认证。每个知乎账号使用独立应用用户和独立本机 `profile`。清除服务数据可解除绑定，清除和撤回的区别见 [API](API.md)。

## 文件与验证

```text
cli.mjs / config.mjs       运维命令与配置
server.mjs / store.mjs     API、鉴权、任务租约与 SQLite
worker.mjs / local/        本机同意、会话与采集适配器
client.mjs                跨宿主 API 客户端与网页调度
agent-tools.mjs            三个 Agent tools
mcp-server.mjs             MCP 标准输入输出服务
contracts.mjs / schemas/   运行校验与 JSON Schema
examples/ / test/          合成示例与集成测试
```

```sh
npm test
node scripts/export-schemas.mjs
```

测试覆盖账号隔离、凭证角色与撤销、过期上传、幂等、同意范围、调用取消、网页生命周期、演示采集到交付及真实 MCP 进程连接。测试不需要真实知乎登录。Schema 文件由脚本生成，协议修改时一起更新。

详细文档：[API](API.md)、[输出 JSON](OUTPUT_FORMAT.md)、[Agent tools / MCP](AGENT_TOOLS.md)、[部署与适配](DEPLOYMENT.md)。
