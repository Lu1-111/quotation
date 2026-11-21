# 旧框架源码

`data-collection/` 保存原网页采集框架的已跟踪源码、测试、配置模板和输出说明。新项目使用根目录 `data-collection-service/`；现有独立 CLI 仍在根目录 `data-collection-cli/`。

`information-search/` 已有适合 Agent 的工具接口，继续作为活跃模块留在根目录，不归档。`frontend-design/` 保持原有位置。

归档不搬运 `.env`、数据库、浏览器登录会话、node_modules 或个人导出。需要运行归档源码时，进入其目录重新安装依赖并单独配置本机私有数据；不要复制敏感运行文件到 Git。
