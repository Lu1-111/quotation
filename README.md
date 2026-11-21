# quotation

本仓库当前维护两个独立模块，源码、配置模板、测试和对接文档分别位于模块目录中。

| 模块 | 功能 | 输出说明 |
| --- | --- | --- |
| [`data-collection/`](data-collection/README.md) | 获取知乎浏览、点赞、收藏信息，规则过滤、权重排序、本机保存与导出 | [采集 JSON 格式](data-collection/OUTPUT_FORMAT.md) |
| [`information-search/`](information-search/README.md) | 知乎官方 API 搜索、关键词与标签词匹配，支持 Agent tools 和 MCP | [搜索 JSON 格式](information-search/OUTPUT_FORMAT.md) |

```text
quotation/
├─ data-collection/
│  ├─ OUTPUT_FORMAT.md
│  ├─ schemas/
│  ├─ examples/
│  └─ README.md
├─ information-search/
│  ├─ OUTPUT_FORMAT.md
│  ├─ schemas/
│  ├─ examples/
│  └─ README.md
├─ AGENTS.md
├─ README.md
└─ .gitignore
```

## 启动

两个模块需要 Node.js 24+，分别在模块目录运行 `npm ci`、`npm start`。

- 数据采集入口：<http://127.0.0.1:3000/history>，真实采集需 Edge 与用户亲自登录知乎。
- 信息搜索调试入口：<http://127.0.0.1:3002/>，需要后端配置开发者 Access Secret；Agent tools／MCP 可独立于网页运行。

详细配置见各模块 README。真实配置、登录会话、数据库和用户导出数据保存在本机，不提交 Git。

## 给 Agent 的数据

采集模块的版本 3 快照以 `records` 为主，包含行为来源、过滤结果和权重。搜索模块的版本 1 快照以 `items` 为主，包含查询计划、摘要和匹配证据；搜索 tools 再使用 `{ schemaVersion, ok, data, error }` 外层。

每个模块均提供独立的 `OUTPUT_FORMAT.md`、JSON Schema 与合成示例。Agent 应先检查协议标识和版本，再解析字段；不要将昵称作为稳定用户 ID，也不要把摘要当作全文。

## 协作

文件夹和文件名使用英文，说明文档使用中文。提交只描述具体文件或功能更新，在对应模块开发和测试，同步前检查远程差异。真实密钥和用户数据不进入提交。
