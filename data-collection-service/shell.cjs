// 桌面壳：在应用窗口内加载本机回环界面，采集器作为同进程组件随壳启动与退出。
// 需要 Electron 运行时：npm install --save-dev electron 后执行 npm run shell。
// 壳不另定义数据协议，全部复用 startDesktop 返回的回环服务与既有 /v1 接口。
const { app, BrowserWindow, shell, dialog } = require('electron');

// 单实例：避免两个壳同时占用同一档案的 SQLite 与采集浏览器会话。
if (!app.requestSingleInstanceLock()) { app.exit(0); }

const parse = (argv) => {
  const options = {};
  for (const item of argv.slice(1)) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(item);
    if (match) options[match[1]] = match[2] === undefined ? true : match[2];
  }
  return options;
};
const options = parse(process.argv);
const demo = options.demo === true || options.demo === 'true';
const profile = typeof options.profile === 'string' ? options.profile : 'default';
const port = Number.isInteger(Number(options.port)) ? Number(options.port) : 0;

let service = null, window = null, quitting = false;

async function closeService() {
  if (!service) return;
  const current = service; service = null;
  // 关闭界面即停止采集：取消活动任务并释放采集器与数据库。
  try { await current.close(); } catch {}
}

app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  void closeService().then(() => app.exit(0));
});

app.whenReady().then(async () => {
  try {
    const { startDesktop } = await import('./desktop.mjs');
    service = await startDesktop({ demo, profile, port, log: (message) => console.log(message) });
  } catch (error) {
    dialog.showErrorBox('采集服务启动失败', String(error?.message || error));
    app.exit(1); return;
  }
  window = new BrowserWindow({
    width: 1180, height: 820, minWidth: 900, minHeight: 640,
    title: demo ? '知序 · 数据采集控制台（合成演示）' : '知序 · 数据采集控制台',
    backgroundColor: '#f5f7fb', autoHideMenuBar: true,
    // 界面只通过回环 HTTP 调用既有接口，不注入 Node 能力。
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false },
  });
  const origin = new URL(service.baseUrl).origin;
  // 知乎登录等外部链接交给系统浏览器，壳内只保留本机界面。
  window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) { event.preventDefault(); void shell.openExternal(url); } });
  await window.loadURL(service.baseUrl);
  window.on('closed', () => { window = null; });
});
