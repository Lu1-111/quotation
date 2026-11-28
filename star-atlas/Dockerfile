# Star Atlas 完整测试版 V1 容器镜像
# 内置 Node.js 24 + Playwright Chromium + 中文字体，零配置开箱支持：
# 1. 工作台页面内知乎扫码登录（自动提取实时二维码）与近 50 条浏览历史高速采集
# 2. 可选知乎官方 OAuth 浏览器授权登录（3000 回调桥接）
# 3. 画像 Agent + 数据转换 Agent + 实时监听星球库的星图写入 Agent + 3D 星图前端
FROM node:24-bookworm-slim

WORKDIR /app

# 先安装依赖以复用层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# 预装 Playwright 托管 Chromium、系统运行依赖及中文字体（确保二维码页面与汉字正常渲染）
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-cjk ca-certificates \
    && npx playwright-core install chromium --with-deps \
    && rm -rf /var/lib/apt/lists/*

# 复制应用源码与前端静态资源（不含 .env / data / .data / node_modules，见 .dockerignore）
COPY src/ ./src/
COPY web/ ./web/
COPY .env.example ./

ENV STAR_ATLAS_HOST=0.0.0.0 \
    STAR_ATLAS_PORT=3300 \
    STAR_ATLAS_DATA_DIR=/app/data \
    STAR_ATLAS_SECRETS_DIR=/app/.data \
    COLLECTOR_BROWSER=chromium

RUN mkdir -p /app/data /app/.data \
    && chown -R node:node /app /ms-playwright

VOLUME ["/app/data", "/app/.data"]
EXPOSE 3300 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.STAR_ATLAS_PORT||3300)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--env-file-if-exists=.env", "src/server.mjs"]
