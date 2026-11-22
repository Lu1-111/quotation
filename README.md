# quotation

各模块独立维护代码、依赖、测试与说明。文件夹和文件名使用英文，说明使用中文。

| 模块 | 功能 | 输出说明 |
| --- | --- | --- |
| [`frontend-design/`](frontend-design/README.md) | 正式前端站点（唯一入口 `web/index.html`）与旧版归档 | 页面设计，不提供数据 JSON |
| [`data-collection-service/`](data-collection-service/README.md) | 通用个人采集：统一 API、本机采集器、网页调度、Agent tools / MCP | [输出 JSON](data-collection-service/OUTPUT_FORMAT.md)、[API](data-collection-service/API.md)、[部署适配](data-collection-service/DEPLOYMENT.md) |
| [`data-collection-cli/`](data-collection-cli/README.md) | 独立命令行个人采集，本机单次同步与导出 | [CLI 输出 JSON](data-collection-cli/OUTPUT_FORMAT.md) |
| [`information-search/`](information-search/README.md) | 知乎官方 API 搜索、关键词与标签词匹配，支持 Agent tools 和 MCP | [搜索 JSON 格式](information-search/OUTPUT_FORMAT.md) |
| [`legacy/`](legacy/README.md) | 旧网页采集框架源码归档 | 新项目优先使用通用采集模块 |

```text
quotation/
├─ frontend-design/
│  ├─ web/          # 唯一正式入口 index.html
│  ├─ archive/      # 旧版快照，不部署
│  ├─ shots/
│  └─ README.md
├─ data-collection-service/
│  ├─ OUTPUT_FORMAT.md
│  ├─ schemas/
│  ├─ examples/
│  └─ README.md
├─ data-collection-cli/
├─ information-search/
│  ├─ OUTPUT_FORMAT.md
│  ├─ schemas/
│  ├─ examples/
│  └─ README.md
├─ legacy/
│  └─ data-collection/
├─ AGENTS.md
├─ README.md
└─ .gitignore
```

## 启动

搜索模块的现有 tools 框架继续使用，未归档。各模块需要 Node.js 24+ 的执行宿主；访问远程 API 的浏览器无需安装 Node.js。

- 前端演示：在仓库根目录执行 `python -m http.server 5173 --bind 127.0.0.1 --directory frontend-design/web`，打开 <http://127.0.0.1:5173/>，无需安装依赖。
- 通用采集：在 `data-collection-service/` 执行 `npm ci`，按 README 启动 API 与用户电脑上的采集器。网页和 Agent 通过 API 使用数据，知乎会话只保存在采集设备。首次真实登录需要本人操作浏览器，后续采集隐藏执行。
- 信息搜索调试入口：<http://127.0.0.1:3002/>，需要后端配置开发者 Access Secret；Agent tools／MCP 可独立于网页运行。

详细配置见各模块 README。真实配置、登录会话、数据库和用户导出数据保存在本机，不提交 Git。

`127.0.0.1` 只能由服务所在设备访问，其他设备需使用正确的局域网地址或部署后的 HTTPS 来源。仓库提供部署代码和说明，没有自动创建公网网址。网页定时调度只在页面生命周期内运行，关页取消，异常掉线由任务租约停止。

## 给 Agent 的数据

通用采集用版本 1 交付外层包裹版本 3 个人行为快照，完整数据以 `snapshot.records` 为主，Agent 使用有界分页。独立 CLI 继续直接输出版本 3 快照。搜索的版本 1 快照以 `items` 为主，包含查询计划、摘要和匹配证据；搜索 tools 再使用 `{ schemaVersion, ok, data, error }` 外层。不要把检索结果当作用户阅读行为。

每个模块均提供独立的 `OUTPUT_FORMAT.md`、JSON Schema 与合成示例。Agent 应先检查协议标识和版本，再解析字段；不要将昵称作为稳定用户 ID，也不要把摘要当作全文。

## 协作

文件夹和文件名使用英文，说明文档使用中文。只在自己负责的模块及明确授权的共享导航中改动，提交只描述具体文件或功能更新，同步前检查远程差异，保留其他成员内容。真实密钥和用户数据不进入提交。OAuth 补充开发仍只保留本地，待后续确认后同步。
