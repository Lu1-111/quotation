# 旧框架源码

`data-collection/` 保存原网页采集框架的已跟踪源码、测试、配置模板和输出说明。新项目使用根目录 `data-collection-service/`。

`data-collection-cli/` 为独立命令行采集方式，已于 2026-11-23 归档。它与 `data-collection-service/` 功能重叠：两者共用同一套采集核心（`lib/` 与 `local/lib/` 是互为副本的关系），但 CLI 不提供 HTTP 服务、图形界面、Agent 只读凭证与知识画像协议，且其核心副本基线停留在 `d270876`，不包含后续的正文获取（`fetchFullText`）与画像输出改动。保留源码供参考与应急单机使用，不再同步新规则。

`information-search/` 已有适合 Agent 的工具接口，继续作为活跃模块留在根目录，不归档。`frontend-design/` 保持原有位置。

归档不搬运 `.env`、数据库、浏览器登录会话、node_modules 或个人导出。需要运行归档源码时，进入其目录重新安装依赖并单独配置本机私有数据；不要复制敏感运行文件到 Git。
