# API 服务容器镜像。
# 仅容器化 API 服务：它不需要浏览器与桌面环境。
# 采集器（worker）必须运行在用户自己的桌面设备上，因为首次知乎登录需要
# 弹出可见浏览器窗口由本人输入账号并通过验证码，容器内无法显示该窗口。
FROM node:24-alpine

WORKDIR /app

# 先装依赖，利用层缓存。--omit=dev 排除测试与 Electron 等开发依赖。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# 只复制服务端运行所需文件，不含 .data、.env 等本机数据（另见 .dockerignore）。
COPY server.mjs store.mjs contracts.mjs errors.mjs config.mjs cli.mjs client.mjs ./
COPY agent-tools.mjs mcp-server.mjs ./
COPY schemas/ ./schemas/

# 服务数据库写入挂载卷，容器本身不保存用户数据。
ENV DATA_SERVICE_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=3005
VOLUME ["/data"]
EXPOSE 3005

# 以非 root 运行；/data 需在宿主侧赋予该 uid 写权限。
RUN mkdir -p /data && chown -R node:node /data
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3005)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# serve 模式不传 localControl，/v1/ui/* 一律拒绝，符合「登录只在采集设备完成」。
CMD ["node", "cli.mjs", "serve"]
