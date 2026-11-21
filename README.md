# 报价 / quotation

本仓库按模块分区协作，避免前端设计、用户数据采集和后续模块相互混淆。

| 分区 | 中文标识 | 内容与入口 |
| --- | --- | --- |
| [`frontend-design/`](frontend-design/README.md) | 前端设计 | 原有 `web` 与 `shots`，包含网页演示、样式、素材和预览 |
| [`data-collection/`](data-collection/README.md) | 数据采集模块 | 知乎浏览、点赞、收藏的本机采集，规则过滤、排序、SQLite、JSON 接口和对接说明 |
| [`information-search/`](information-search/README.md) | 信息搜索模块 | 知乎官方 API 搜索、关键词与标签词文本匹配、缓存及 JSON／Markdown 导出 |

```text
quotation/
├─ frontend-design/
│  ├─ README.md
│  ├─ web/                   原有前端代码与素材
│  └─ shots/                 原有截图、视频和导出预览
├─ data-collection/          本机数据采集模块
├─ information-search/       官方接口的信息搜索模块
├─ AGENTS.md                 模块分区与同步约定
├─ README.md                 仓库导航
└─ .gitignore
```

此次仅移动原有 `web/` 和 `shots/`，它们的内部文件保持原样。其他原有根目录文件保留在根目录。

## 启动入口

前端设计可将 `frontend-design/web/` 作为静态站点根目录提供服务，详见对应 README。

数据采集模块在自身目录安装与运行，需要 Node.js 24+；真实采集还需要 Edge 和用户亲自登录知乎：

```powershell
cd data-collection
npm ci
npm start
```

然后访问 <http://127.0.0.1:3000/history>。配置模板为 `.env.example`，真实配置、数据库、登录会话与用户导出文件只保存在本机。

## 后续同步约定

1. 修改代码前先查看 `AGENTS.md`，在对应模块目录开发；新增模块使用独立目录和 README。
2. 同步前先检查远程更新和本地差异，不使用强制推送覆盖他人提交。
3. 只暂存本次负责的模块路径；仓库导航、协作规则等共享文件需要有明确修改目的。
4. 前端设计提交放在 `frontend-design/`，本机数据采集提交放在 `data-collection/`；模块直接位于第一级目录，不使用 `modules/` 中间层。
5. 提交前检查密钥、浏览器会话、数据库、日志和真实用户数据均未进入暂存区。

信息搜索模块在自身目录运行 `npm ci`、`npm start`，默认入口为 <http://127.0.0.1:3002/>。它使用官方 Access Secret 搜索公开内容，标签词按标题和摘要匹配，不代表知乎原生话题过滤。详细能力和对接方式见对应 README。

数据采集模块目前保留网页操作方式，CLI 继续暂缓。

文件夹和文件名使用英文，说明文档、协作规则和提交说明使用中文。
