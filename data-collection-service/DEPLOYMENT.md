# 部署与设备适配

## 选择运行形式

推荐把 API 作为项目的独立后端服务，把采集器作为用户电脑上的本地组件。各模块经 HTTP/JSON 对接，Agent 经 tools/MCP 接入。这样网页访问设备不需要安装 Node.js；Node.js 与浏览器依赖只装在实际运行服务／采集器的设备上。桌面版以后可将同一采集核心与 Node 运行时打包，无需重新定义数据协议。

本模块没有用户注册网页或新的可视化页面，使用既有前端即可。这里生成的应用凭证解决模块之间的访问权限，不等同于知乎 OAuth 或宿主网站的账号登录。宿主后端负责先验证自己的用户身份，再选择该用户的独立凭证、转发请求或交付受控会话；不应把一次 provision 的令牌共享给所有用户。

## 本机与局域网

复制 `.env.example` 为 `.env`，安装依赖后启动 `npm start`。同机默认 `127.0.0.1:3005`。该地址只指访问设备自己，不能作为其他设备的入口。

若只在可信局域网调试，服务配置示例：

```dotenv
HOST=0.0.0.0
PORT=3005
PUBLIC_ORIGIN=http://192.168.1.20:3005
DATA_SERVICE_URL=http://192.168.1.20:3005
ALLOWED_ORIGINS=http://192.168.1.20:5173
```

把地址替换成服务电脑实际局域网 IP；前端端口、来源按项目调整。其他设备访问该 IP，不能访问 `0.0.0.0`。需要设备同网、电脑不休眠，并允许防火墙访问该端口。本模块不自动修改防火墙或路由器。不把 HTTP 局域网方案直接暴露到公网。

服务只接受配置的 Host 和来源；`ALLOWED_ORIGINS` 是用逗号分隔的精确 origin 列表，不支持 `*`，不含路径。命令行、Agent 与采集器不需要 Origin 头，但仍必须鉴权。

## 正式后端

1. 在服务器安装 Node.js 24+、执行 `npm ci`，配置持久磁盘目录 `DATA_SERVICE_DATA_DIR`。浏览器仅安装在用户电脑的采集器侧。
2. 服务绑定内部地址；通过已有反向代理提供有效 HTTPS 域名，例如 `https://collection.example.com`，设置 `PUBLIC_ORIGIN` 为该来源。
3. 代理转发时保留外部 Host。配置明确的前端来源。代理请求体大小至少与服务的 32 MiB 限制一致，避免缓冲或日志记录 Authorization 和请求体。
4. 用进程管理工具运行 `npm start`，持久化并备份 SQLite 所在目录。当前实现推荐单 API 进程、同一台机器的本地磁盘，不支持跨主机共享 SQLite 网络盘。规模扩大时替换 store 为事务数据库和队列，保留当前 HTTP 协议。

部署模板不会自动发布公网网址；域名、证书、服务器和网络条件需要由最终项目提供。宿主网页不要访问 HTTPS 页面中的 HTTP API，浏览器会阻止混合内容。

## 用户与设备开通

可信运维端在实际服务数据库对应目录下执行：

```sh
npm run cli -- provision --name app-user --output .data/credentials-user.json
npm run cli -- device-add --user-id <用户UUID> --device laptop --output .data/credentials-laptop.json
npm run cli -- device-revoke --user-id <用户UUID> --device-id <设备UUID>
npm run cli -- token-rotate --user-id <用户UUID> --output .data/credentials-user-new.json
```

provision 生成的开发凭证文件包含 userToken 和 deviceToken；正式对接应拆开，仅把设备凭证安全交付给对应电脑，用户凭证只交给该用户的可信宿主。`device-add` 只生成设备凭证，`token-rotate` 只生成用户凭证。输出文件不覆盖已有文件，写入失败回滚凭证变更。数据库提交与文件保存跨两种存储并非分布式事务，极端断电时仍应检查开通结果，按需撤销后重新生成。

设备撤销立即使对应令牌无效并取消关联活跃任务，但不删除历史快照和本机会话。令牌轮换使旧用户令牌失效并取消该用户的活跃任务。设备丢失时在服务端撤销设备；需要清除本机知乎登录时在该设备执行 `worker-revoke`。服务端无法远程删除已经丢失设备的文件。

本机采集器通过私有配置运行：

```dotenv
DATA_SERVICE_URL=https://collection.example.com
DATA_SERVICE_DEVICE_TOKEN=单独设备令牌
WORKER_PROFILE=personal
WORKER_BROWSER=msedge
```

```sh
npm run cli -- worker-login --consent --history --likes --collections
npm run cli -- worker
```

一个 `profile` 绑定一个知乎账号，本机档案和会话隔离；同一应用用户不应绑定不同知乎账号。不同账号先创建不同应用用户，再选择不同 `--profile`。服务端绑定采用设备声明的账号摘要，不能把它当作平台认证或实名认证。

## 桌面与移动适配

| 使用场景 | 如何接入 | 采集在哪里执行 |
| --- | --- | --- |
| 电脑网页 | 导入 client.mjs 或由已有后端转发，页面存活时调度 | 在线的用户电脑采集器 |
| 手机网页／原生 App | 用 HTTPS API 读取、发任务和续期；原生语言按 API 文档实现 | 已登录的电脑采集器；不读取手机知乎 App 私有存储 |
| 桌面应用 | 嵌入 API 客户端；将 worker/local 核心随桌面运行时打包 | 桌面设备自己的专用浏览器会话 |
| 本地 Agent | tools 或 MCP，凭证由宿主注入 | 同机或另一台已经授权在线的电脑采集器 |

浏览器组件、登录验证、操作系统权限和平台接口可能不同，因此不保证“任何设备直接运行采集器”。当前真实采集适配的是装有 Edge/Chrome 的桌面系统；Node.js 服务协议可跨系统，手机端消费 API。需要手机独立采集时，另行开发获得平台支持的适配器，不能把桌面 Playwright 直接塞进手机网页。

## 配置和本地文件

| 变量 | 默认值／作用 |
| --- | --- |
| HOST / PORT | 127.0.0.1 / 3005 |
| PUBLIC_ORIGIN | http://127.0.0.1:3005；Host 校验与同源列表 |
| ALLOWED_ORIGINS | 空；额外允许的前端来源 |
| DATA_SERVICE_DATA_DIR | 模块内 .data/server，服务数据库根目录 |
| DATA_SERVICE_URL | http://127.0.0.1:3005，客户端／采集器访问来源 |
| DATA_SERVICE_USER_TOKEN | 仅用户客户端、Agent 使用 |
| DATA_SERVICE_DEVICE_TOKEN | 仅本机采集器使用 |
| WORKER_DATA_DIR | 模块内 .data/worker，本机私有数据根目录 |
| WORKER_PROFILE | default |
| WORKER_BROWSER | Windows 默认 msedge，其他桌面系统默认 chrome |

环境变量优先于 `--credentials` 文件中的服务地址和令牌。切换模式或设备前检查环境，防止旧配置覆盖文件。`.env` 由 npm 脚本中的 Node 参数加载；直接启动脚本时按需加 `--env-file-if-exists=.env`。

源码可上传 Git，`.env`、`.data`、会话、真实导出、令牌、日志与 node_modules 均不上传。文件权限参数在类 Unix 系统设置为仅当前用户读写；Windows 仍需由目录 ACL 控制访问。服务数据库不是加密数据库，磁盘加密和备份权限由宿主管理。
