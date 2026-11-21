# 知乎数据采集 CLI

本模块通过命令行获取本人知乎浏览、点赞和收藏信息，执行与网页版一致的规则过滤和权重排序，保存到本机并输出版本 3 JSON。它不启动 HTTP 服务，不依赖本地网页、OAuth 应用或搜索模块。

这是单独的一级目录，可复制到其他电脑独立安装和运行。首次真实登录由用户在专用浏览器中完成，后续 `sync` 默认使用后台浏览器；每条命令执行完即结束，没有常驻定时采集进程。

## 环境与设备

- Node.js 24+，安装入口见 [Node.js 官网](https://nodejs.org/en/download)。本模块需要该版本提供的内置 SQLite 和相关 Node API。
- 真实采集需本机安装 Microsoft Edge 或 Google Chrome。Windows 默认 `msedge`，其他系统默认 `chrome`，可用 `--browser` 选择；通道机制见 [Playwright 官方文档](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge)。
- 初次登录需要有图形桌面的设备和网络连接，网页验证须由用户亲自完成。
- 当前自动化验证在 Windows 完成，真实登录／采集仍受账号状态、平台验证和接口变化影响。macOS／Linux 未进行真机验收，手机浏览器不能直接运行本模块。

无需先运行原版 `data-collection/`。只复制本目录时，也必须保留 `lib/`、`package.json`、`package-lock.json`；不要拷贝其他人的 `.data/`、`.env` 或登录状态。

## 快速开始

以下命令在 `data-collection-cli/` 目录执行：

```powershell
npm ci
node cli.mjs --help
```

无账号演示，使用合成数据，不请求知乎：

```powershell
node cli.mjs sync --demo --consent --history --likes --collections --json
```

真实使用：

```powershell
node cli.mjs login --profile personal --consent
node cli.mjs config --profile personal --history --likes --collections
node cli.mjs sync --profile personal --json
node cli.mjs export --profile personal --output .data/exports/personal.json
```

`login` 会显示专用浏览器，并在最多 180 秒内检查登录结果；登录成功即绑定账号、保存本机登录状态并关闭窗口，不采集帖子、不清空已有快照。需要更多时间时用 `--login-timeout 600`。Chrome 用户首次可加 `--browser chrome`，选择会按档案保存。

`--consent` 表示同意将所选账号信息采集并保存在本机。首次 `login` 或 `sync` 需要明确同意；后续复用已记录的同意。默认只获取浏览记录，点赞与收藏需勾选对应命令选项。CLI 不要求同步网页在线；它以当前明确执行的命令作为本轮许可，命令退出即停止。

## 命令

| 命令 | 功能 |
| --- | --- |
| `login` | 打开专用窗口，等待本人登录并核对账号 |
| `sync` | 单次获取所选信息，过滤、排序、整体提交快照并关闭浏览器 |
| `config` | 查看或修改该档案的采集种类、知识过滤和浏览器选择 |
| `status` | 查看绑定、同意、最近同步、种类与数量，不访问知乎 |
| `profiles` | 列出当前真实／演示模式的本机档案名称 |
| `export` | 读取已保存的快照，默认输出 JSON；可指定文件 |
| `logout` | 撤回采集同意，删除该档案的本机浏览器登录目录；保留采集快照和账号绑定 |
| `clear --yes` | 删除该档案的采集记录、缓存和本机登录状态，重置账号绑定 |
| `unlock --yes` | 清理已经退出的进程留下的锁；不会强行解锁仍在运行的进程 |

常用选项：

| 选项 | 作用 |
| --- | --- |
| `--profile <name>` | 默认 `default`；1 至 64 位英文字母、数字、下划线、连字符，大小写不区分 |
| `--data-dir <path>` | 指定数据根目录；相对路径以当前工作目录解释 |
| `--browser msedge` 或 `--browser chrome` | 在 `login`、`sync` 或 `config` 中选择并保存通道 |
| `--history`、`--no-history` | 开启／关闭浏览记录 |
| `--likes`、`--no-likes` | 开启／关闭点赞 |
| `--collections`、`--no-collections` | 开启／关闭收藏 |
| `--knowledge-filter`、`--no-knowledge-filter` | 开启／关闭本地知识规则过滤 |
| `--json` | 成功时 stdout 只包含一个 JSON 对象；错误写入 stderr |
| `--output <file>` | `sync` 或 `export` 保存 JSON 文件 |
| `--overwrite` | 允许显式覆盖已存在的普通输出文件，需与 `--output` 一起使用 |
| `--quiet` | 隐藏普通进度提示，不隐藏失败信息 |
| `--demo` | 使用独立演示数据与目录 |

未提供的采集选项保持原值。把所有类别关闭后 `sync` 会拒绝执行，不会把已有快照替换为空结果。修改选择会重新计算所选缓存，关闭类别的原始缓存仍可保留。本模块当前不启用模型审查，`aiReview` 固定关闭，不安装 Ollama。

## 登录、账号与数据目录

默认数据根目录固定为模块内 `.data/`，不随调用方工作目录变化。可通过 `--data-dir` 或 `CLI_DATA_DIR` 指定，命令行优先。目录如下：

```text
.data/
├─ live/profiles/profile-personal/
│  ├─ collection.sqlite
│  ├─ operation.lock             仅执行时存在
│  └─ history-profiles/cli/      专用浏览器登录状态
├─ demo/profiles/profile-default/
│  └─ collection.sqlite
└─ exports/                     用户主动导出的 JSON
```

每个 profile 使用独立 SQLite、登录目录、采集同意和种类设置。不同档案可并行运行；同一档案有进程锁，避免多个命令同时启动相同浏览器或写同一份数据。真实与演示模式使用不同目录，即使名字相同也不会混用。

首次成功登录／同步后保存知乎账号 ID。后续实际账号不一致时拒绝同步，不按昵称覆盖。需要另一个账号时使用新的 `--profile`；不要通过修改昵称或复制 Cookie 替换原档案。`logout` 保留原账号绑定，因此不能用它把旧数据改绑给另一个账号；有意重置时用 `clear --yes`。

跨设备应复制代码并重新安装、登录，而不是共享登录目录。同名 profile 只是当前设备内的选择键，不是跨设备用户 ID。当前不提供云同步、共享用户系统或移动端执行器。

## JSON 与 Agent 对接

数据协议、条件字段、错误流与示例见 [OUTPUT_FORMAT.md](OUTPUT_FORMAT.md)。机器校验文件为 [collection-output.schema.json](schemas/collection-output.schema.json)，完整合成样例为 [collection.snapshot.json](examples/collection.snapshot.json)。

给 Agent／脚本调用时，直接运行 Node 命令并检查退出码：

```powershell
node cli.mjs sync --profile personal --json
node cli.mjs export --profile personal
```

`sync --json` 和不指定文件的 `export` 输出原样的版本 3 快照，没有日志前缀。`status --json`、`config --json`、`login --json` 则返回 CLI 管理状态对象，不是内容快照。`npm run` 可能额外打印 npm 提示，机器解析建议直接调用 `node cli.mjs`。

桌面应用也可直接导入，不需要启动子进程或服务器：

```javascript
import { createCliRuntime } from './runtime.mjs';

const runtime = createCliRuntime({ dataDir: '/absolute/app-data/zhihu' });
const controller = new AbortController();
const result = await runtime.execute('sync', { profile: 'personal' }, {
  signal: controller.signal,
  log: (message) => console.error(message)
});
// 用户已事先完成 login 与采集同意。
// result.value 是版本 3 JSON 对象；关闭桌面应用时调用 controller.abort()。
```

采集同意应由宿主依据用户操作设置，不能由模型自行批准。后续内容分析只接收 JSON，不接收 Cookie、浏览器目录或数据库凭证。CLI 不自动把结果发到网络、Git 仓库或模型服务。

## 运行和停止

CLI 只有单次命令，没有 `watch` 或自动常驻任务。需要定时更新时，由桌面应用在自身运行期间主动调用，应用关闭时停止调度。网页版原有“页面在线才采集”的机制未修改。

正常结束和 Ctrl+C 会关闭采集浏览器并释放锁；取消、验证失败、限流或类别读取失败时不会提交半批快照。操作系统强制结束或断电可能留下锁，确认对应进程已经退出后执行 `unlock --yes`。不同档案不共用锁。更改设置是独立操作，即使后续同步失败，用户明确选择的新设置仍保留。

文件输出先生成完整临时 JSON 再发布到目标路径，默认不覆盖。输出路径不能指向当前数据根目录下任何真实或演示档案内部，防止把快照写到另一个账号的 SQLite 或登录目录。建议导出到本机普通磁盘；特殊文件系统不支持文件发布机制时可用 stdout 交由宿主保存。

## 错误和配置

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 采集、网络、浏览器或本机文件操作失败 |
| `2` | 参数错误、未确认清除、输出文件已存在等 |
| `3` | 缺少采集同意、尚未登录、账号不一致、登录超时或没有成功快照 |
| `4` | 档案被占用或锁无法安全移除 |
| `130` | 当前进程处理到取消信号 |

`.env.example` 提供 `CLI_DATA_DIR`、`CLI_BROWSER_CHANNEL`，实际配置可保存在未跟踪的 `.env`。用 `npm run cli -- ...` 或 `node --env-file-if-exists=.env cli.mjs ...` 才会加载此文件；直接 Node 命令默认读取进程环境。浏览器优先级为当前 `--browser`、档案保存值、环境变量、平台默认值。

知乎的浏览历史、点赞与收藏网页接口可能变化，登录失效或验证需用户处理。本机采集不是 OAuth 官方浏览历史接口。浏览上限、过滤、去重和权重规则与网页版已发布版本一致：过滤用户主页和低互动回答，最多 50 条合格浏览；点赞、收藏读取到当前接口分页结束。规则候选不表示模型已理解全文。

## 文件与验证

```text
cli.mjs             参数、终端输出、退出码和进程信号
runtime.mjs         命令执行、独立档案、锁、登录和文件导出
lib/                本目录自带的采集、过滤、排序与 SQLite 核心
schemas/            版本 3 JSON Schema
examples/           不含真实用户数据的合成样例
test/               命令、隔离、导出、锁、账号与取消测试
```

`lib/` 来源于仓库中已发布的网页版采集核心，基线为 `d270876`；CLI 的账号绑定方法为本模块扩展。复制代码是为了让此目录单独运行，不依赖 `../data-collection/`，不包含本地尚未发布的 OAuth 扩展。后续规则升级需在确认后同步两个版本的核心，不能假设副本自动更新。

执行 `npm test` 运行合成／模拟测试，不消耗真实知乎账号数据。真实浏览器登录、平台验证及跨系统兼容仍需在对应设备验收。
