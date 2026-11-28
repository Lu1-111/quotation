// Star Atlas 服务入口（主服务默认监听 http://127.0.0.1:3300，自动按需挂载 3000 端口知乎 OAuth 回调桥接）
import { createStarAtlasApp } from './app.mjs';

const HOST = process.env.STAR_ATLAS_HOST || '127.0.0.1';
// 注意：父目录 .env 中的 PORT=3000 专用于知乎官方 OAuth 回调，主服务固定使用 STAR_ATLAS_PORT（默认 3300）
const PORT = Number(process.env.STAR_ATLAS_PORT || 3300);

const app = await createStarAtlasApp({
  ...(process.env.STAR_ATLAS_DATA_DIR ? { dataDir: process.env.STAR_ATLAS_DATA_DIR } : {}),
  ...(process.env.STAR_ATLAS_SECRETS_DIR ? { secretsDir: process.env.STAR_ATLAS_SECRETS_DIR } : {}),
});

app.server.listen(PORT, HOST, async () => {
  const origin = `http://${HOST}:${PORT}`;
  const bridgeOrigin = await app.startOAuthBridge(origin);
  console.log(`[Star Atlas] 工作台入口：${origin}/workbench`);
  console.log(`[Star Atlas] 星图首页：  ${origin}/`);
  if (app.zhihuOAuth.configured) {
    console.log(
      `[Star Atlas] 知乎官方 OAuth 已就绪（回调地址：${app.zhihuOAuth.redirectUri}${
        bridgeOrigin ? `，已启动回环回调监听 ${bridgeOrigin}` : ''
      }）`,
    );
  }
  console.log('[Star Atlas] 星图写入 Agent 已开启对 data/planets-db.json 的实时变动监测');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n[Star Atlas] 收到 ${sig}，正在安全关闭...`);
    await app.close();
    process.exit(0);
  });
}
