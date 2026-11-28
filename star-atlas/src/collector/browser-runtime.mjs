// 浏览器探测与 Playwright 运行时加载（复用原数据采集模块底层实现）
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export const BROWSERS = ['auto', 'msedge', 'chrome', 'chromium'];

export class BrowserSetupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function browserCandidates({ platform = process.platform, env = process.env, home = homedir(), managedPath } = {}) {
  const result = [];
  const add = (browser, executablePath) => {
    if (executablePath && !result.some((item) => item.executablePath === executablePath)) {
      result.push({ browser, executablePath });
    }
  };
  if (platform === 'win32') {
    const drive = env.SystemDrive || 'C:';
    const roots = [
      env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'),
      env.PROGRAMFILES || win32.join(drive, 'Program Files'),
      env['PROGRAMFILES(X86)'] || win32.join(drive, 'Program Files (x86)'),
    ];
    for (const root of roots) add('msedge', win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    for (const root of roots) add('chrome', win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else if (platform === 'darwin') {
    for (const root of ['/Applications', posix.join(home, 'Applications')]) {
      add('chrome', posix.join(root, 'Google Chrome.app/Contents/MacOS/Google Chrome'));
      add('msedge', posix.join(root, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'));
    }
  } else if (platform === 'linux') {
    for (const p of ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) add('chrome', p);
    for (const p of ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']) add('msedge', p);
  }
  add('chromium', managedPath);
  return result;
}

export function selectBrowser(preference = 'auto', options = {}) {
  if (!BROWSERS.includes(preference)) {
    throw new BrowserSetupError('INVALID_BROWSER', 'browser 只支持 auto、msedge、chrome、chromium。');
  }
  const candidates = browserCandidates(options);
  const exists = options.exists || existsSync;
  const selected = candidates.find(
    (item) => (preference === 'auto' || item.browser === preference) && exists(item.executablePath),
  );
  if (!selected) {
    throw new BrowserSetupError(
      'BROWSER_NOT_FOUND',
      '未检测到可用浏览器。请安装 Edge/Chrome，或运行 npm run browser:install 安装 Chromium。',
    );
  }
  const launchOptions =
    selected.browser === 'chromium'
      ? { executablePath: selected.executablePath }
      : { channel: selected.browser, executablePath: selected.executablePath };
  return { ...selected, launchOptions };
}

export async function loadBrowser(preference = 'auto') {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw new BrowserSetupError('DEPENDENCY_MISSING', '缺少 playwright-core 依赖，请先运行 npm install。');
  }
  return { chromium, selected: selectBrowser(preference, { managedPath: chromium.executablePath() }) };
}
