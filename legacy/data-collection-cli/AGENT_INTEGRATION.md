# CLI 操作与 Agent 链路选择

## 哪个模块走哪条链路

| 入口 | 实际链路 | 适用范围 |
| --- | --- | --- |
| 本目录 `cli.mjs` / `cli.ps1` | CLI → 本机专用浏览器 → 本机 SQLite → 版本 3 JSON | 单机操作、脚本、桌面前置验证 |
| 本目录 `runtime.mjs` | 本地 Agent／桌面宿主 → runtime.execute → 同一采集核心 → 本机 SQLite → value | 同机单用户，省去 HTTP 和子进程 |
| 根目录 `data-collection-service/agent-tools.mjs` 或其 MCP | Agent → tools/MCP → 统一 API → 本机 worker → 专用浏览器 → API 保存快照 → Agent 分页 | 最终项目、多设备、网页／桌面协作和用户隔离 |
| 根目录 `information-search/` tools/MCP | Agent → 信息搜索工具 → 知乎官方公开搜索 API | 搜索公开内容，不读取个人行为 |

**已有采集 tools/MCP 默认走统一 API＋本机采集器，不会自动执行本目录 CLI。** 本目录没有独立 MCP 服务器；如果宿主选择 CLI，需要自己将命令执行或 SDK 函数注册为 tool。为最终应用建议使用通用服务链路；只验证本机 Agent 时，可选下面的 SDK 或 CLI 子进程方式。

两种采集方式复用相同规则，但默认的数据目录、登录档案和同意记录相互独立。CLI 已登录不表示 service worker 已登录；切换入口需本人完成对应入口的登录／同意，不能复制 Cookie 充当授权。不要让两个采集器共用同一个浏览器目录。

## CLI 逐步操作

进入从仓库复制的 `data-collection-cli/`，使用可写目录，安装 Node.js 24+。首次在每台新设备执行：

```sh
npm ci
node cli.mjs doctor --launch-check
```

若未安装浏览器：

```sh
npm run browser:install
node cli.mjs doctor --browser chromium --launch-check
```

然后本人登录，勾选类别，再同步并导出：

```sh
node cli.mjs login --profile personal --consent --login-timeout 600
node cli.mjs config --profile personal --history --likes --collections
node cli.mjs sync --profile personal --json
node cli.mjs export --profile personal --output .data/exports/personal.json
node cli.mjs status --profile personal --json
```

所有操作固定同一 profile；如指定了自定义 `--data-dir`，后续命令也要使用同一路径。登录时选择的实际浏览器会保存；再次采集默认无头执行。换账号用新的 profile。撤回同意和删除会话用 `logout`；清除内容和绑定用 `clear --yes`。

Windows PowerShell 推荐将 `node cli.mjs` 替换成 `.\cli.ps1`，尤其是 `| ConvertFrom-Json` 时。`--output` 生成 UTF-8 文件，不使用 PowerShell 5.1 默认重定向来存 JSON。

## 本地 Agent 直接调用 SDK

由宿主提前把应用用户映射到固定 profile 和可写数据根目录；本人登录命令也要使用同一根目录。工具参数不接受 `--consent`、账号密码、Cookie 或任意档案路径。

```js
import { createCliRuntime, safeCliError } from './runtime.mjs';

const runtime = createCliRuntime({ dataDir: hostConfiguredDataDir });
async function collectPersonalData({ signal }) {
  try {
    const result = await runtime.execute('sync', { profile: hostMappedProfile }, { signal });
    return { ok: true, data: result.value, error: null }; // value 为版本 3 快照
  } catch (error) {
    const safe = safeCliError(error, signal);
    return { ok: false, data: null, error: { code: safe.code, message: safe.message } };
  }
}
```

将 `collectPersonalData` 注册为宿主自己的工具即可。只读缓存时使用 `runtime.execute('export', ...)`，不启动浏览器、不重新取数。需要取消时由宿主中止 signal；需要定时调用时由应用在自身存活期间调度。

## 通过 CLI 子进程调用

非 Node Agent 可以运行命令并按 UTF-8 读取 stdout；Node 宿主也可以用 `execFile`，不用拼接 shell 字符串：

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const { stdout } = await promisify(execFile)(process.execPath, [
  hostConfiguredCliAbsolutePath, 'sync', '--profile', hostMappedProfile,
  '--data-dir', hostConfiguredDataDir, '--json',
], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
const snapshot = JSON.parse(stdout);
```

退出码非零时解析错误流，不把失败结果当快照。子进程被操作系统强杀可能留下锁或浏览器，因此桌面集成优先使用带 signal 的 SDK；不要重复抢占同一档案。模型只接收必要内容，全文未获取时保留缺失标记，不能把标题／摘要当成全文阅读证据。

## 通用服务路径的准备

如果使用已经提供的三个采集 tools：

1. API 服务运行，并为每位应用用户和采集设备分别开通凭证。
2. 用户电脑上本人执行 service 的 `worker-login --consent`，然后启动 `worker`。
3. Agent 宿主只注入该用户的 `DATA_SERVICE_USER_TOKEN` 和 `DATA_SERVICE_URL`，注册 service 的 MCP 或 tools。
4. 调用 `zhihu_collection_status`、`zhihu_collection_sync`、`zhihu_collection_read`，由 API 按用户隔离、任务租约和快照分页处理。

其输出是版本 1 交付外层／分页，内含版本 3 原始快照，按 service 的输出文档解析。本目录 CLI 直接输出版本 3；两者外层不能混用。
