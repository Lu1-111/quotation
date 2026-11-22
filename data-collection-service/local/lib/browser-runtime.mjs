import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export const BROWSERS = ['auto', 'msedge', 'chrome', 'chromium'];
export class BrowserSetupError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function browserCandidates({ platform = process.platform, env = process.env, home = homedir(), managedPath } = {}) {
  const result = []; const add = (browser, executablePath) => { if (executablePath && !result.some((item) => item.executablePath === executablePath)) result.push({ browser, executablePath }); };
  if (platform === 'win32') {
    const drive = env.SystemDrive || 'C:';
    const roots = [env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), env.PROGRAMFILES || win32.join(drive, 'Program Files'), env['PROGRAMFILES(X86)'] || win32.join(drive, 'Program Files (x86)')];
    for (const root of roots) add('msedge', win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    for (const root of roots) add('chrome', win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else if (platform === 'darwin') {
    for (const root of ['/Applications', posix.join(home, 'Applications')]) add('chrome', posix.join(root, 'Google Chrome.app/Contents/MacOS/Google Chrome'));
    for (const root of ['/Applications', posix.join(home, 'Applications')]) add('msedge', posix.join(root, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'));
  } else if (platform === 'linux') {
    for (const path of ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) add('chrome', path);
    for (const path of ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']) add('msedge', path);
  }
  add('chromium', managedPath); return result;
}
export function selectBrowser(preference = 'auto', options = {}) {
  if (!BROWSERS.includes(preference)) throw new BrowserSetupError('INVALID_BROWSER', 'browser 只支持 auto、msedge、chrome、chromium。');
  const candidates = browserCandidates(options), exists = options.exists || existsSync;
  const selected = candidates.find((item) => (preference === 'auto' || item.browser === preference) && exists(item.executablePath));
  if (!selected) throw new BrowserSetupError('BROWSER_NOT_FOUND', '未检测到所选浏览器。请安装 Edge/Chrome，或在本模块运行 npm run browser:install 后选择 --browser chromium。');
  return { ...selected, launchOptions: { channel: selected.browser, executablePath: selected.executablePath } };
}
export async function loadBrowser(preference = 'auto') {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { throw new BrowserSetupError('DEPENDENCY_MISSING', '缺少 playwright-core 依赖，请先在本模块运行 npm ci。'); }
  return { chromium, selected: selectBrowser(preference, { managedPath: chromium.executablePath() }) };
}
export async function inspectEnvironment({ preference = 'auto', launchCheck = false, platform = process.platform, env = process.env, version = process.versions.node, loader = loadBrowser } = {}) {
  const nodeReady = Number(version.split('.')[0]) >= 24;
  const desktopPlatform = ['win32', 'darwin', 'linux'].includes(platform);
  const displayReady = platform !== 'linux' || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  let selected = null, error = null, browserRuntime;
  try { browserRuntime = await loader(preference); selected = browserRuntime.selected.browser; }
  catch (failure) { error = { code: failure instanceof BrowserSetupError ? failure.code : 'BROWSER_CHECK_FAILED', message: failure instanceof BrowserSetupError ? failure.message : '无法检查浏览器，请重新安装依赖并检查运行环境。' }; }
  const launch = { requested: launchCheck, ok: null, error: null };
  if (launchCheck) {
    let browser;
    try {
      if (!browserRuntime || !nodeReady || !desktopPlatform) throw new Error();
      browser = await browserRuntime.chromium.launch({ ...browserRuntime.selected.launchOptions, headless: true, timeout: 15_000 });
      launch.ok = true;
    } catch { launch.ok = false; launch.error = { code: 'BROWSER_LAUNCH_FAILED', message: '浏览器启动检查失败，请检查系统依赖、权限或浏览器策略；Linux 可按文档补齐浏览器系统依赖。' }; }
    finally { await browser?.close().catch(() => {}); }
  }
  return { schemaVersion: 1, mode: 'cli', kind: 'environment_check', nodeVersion: version, platform, nodeReady, desktopPlatform, displayReady,
    browser: { preference, selected, error }, launchCheck: launch, demoReady: nodeReady,
    readyForLogin: nodeReady && desktopPlatform && displayReady && Boolean(selected) && launch.ok !== false,
    notes: ['此检查不连接知乎，不证明平台登录、网络或验证码可用。', '手机原生环境不直接运行采集器；Linux 首次登录需图形桌面或显示服务。'] };
}
