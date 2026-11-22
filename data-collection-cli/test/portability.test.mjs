import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserCandidates, selectBrowser, inspectEnvironment, BrowserSetupError } from '../lib/browser-runtime.mjs';
import { writeSnapshot } from '../runtime.mjs';

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'quotation-portability-'));
  t.after(() => { const resolved = realpathSync(directory); assert.equal(dirname(resolved), realpathSync(tmpdir())); assert.ok(basename(resolved).startsWith('quotation-portability-')); rmSync(resolved, { recursive: true, force: true }); });
  return directory;
}
test('模拟 Windows 仅装 Chrome、macOS 用户应用目录、Linux 托管浏览器均可选择', () => {
  for (const [platform, browser, expected] of [
    ['win32', 'chrome', 'C:\\Users\\reader\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'],
    ['darwin', 'msedge', '/Users/reader/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    ['linux', 'chromium', '/home/reader/cache/chromium/chrome'],
  ]) {
    const options = { platform, home: platform === 'win32' ? 'C:\\Users\\reader' : '/Users/reader', env: {}, managedPath: '/home/reader/cache/chromium/chrome', exists: (path) => path === expected };
    const selected = selectBrowser('auto', options); assert.equal(selected.browser, browser); assert.equal(selected.launchOptions.executablePath, expected);
    assert.equal(selectBrowser(browser, options).browser, browser);
  }
  const options = { platform: 'win32', env: {}, home: 'C:\\Users\\reader', exists: (path) => path.includes('Google') };
  assert.throws(() => selectBrowser('msedge', options), { code: 'BROWSER_NOT_FOUND' });
  assert.throws(() => selectBrowser('firefox', options), { code: 'INVALID_BROWSER' });
  assert.equal(browserCandidates({ platform: 'android', managedPath: undefined }).length, 0);
});

test('环境检查区分低版本 Node、缺少依赖、Linux 无显示服务以及实际启动失败', async () => {
  const loader = async () => ({ selected: { browser: 'chromium', launchOptions: {} }, chromium: { launch: async () => { throw new Error('不得输出原始浏览器错误'); } } });
  const old = await inspectEnvironment({ version: '20.19.0', platform: 'linux', env: {}, loader });
  assert.equal(old.nodeReady, false); assert.equal(old.readyForLogin, false);
  const headless = await inspectEnvironment({ platform: 'linux', env: {}, loader }); assert.equal(headless.displayReady, false); assert.equal(headless.readyForLogin, false);
  const missing = await inspectEnvironment({ loader: async () => { throw new BrowserSetupError('DEPENDENCY_MISSING', '运行 npm ci'); } });
  assert.equal(missing.browser.error.code, 'DEPENDENCY_MISSING');
  const failed = await inspectEnvironment({ platform: 'win32', launchCheck: true, loader });
  assert.equal(failed.readyForLogin, false); assert.equal(failed.launchCheck.error.code, 'BROWSER_LAUNCH_FAILED'); assert.ok(!JSON.stringify(failed).includes('不得输出'));
  let closed = false;
  const ready = await inspectEnvironment({ platform: 'darwin', launchCheck: true, loader: async () => ({ selected: { browser: 'chrome', launchOptions: {} }, chromium: { launch: async () => ({ close: async () => { closed = true; } }) } }) });
  assert.equal(ready.readyForLogin, true); assert.equal(closed, true);
});

test('硬链接不可用时独占复制导出，目标已存在或并发出现时均不覆盖', (t) => {
  const directory = temporary(t); const target = join(directory, '中文 file.json');
  const snapshot = { title: '中文导出内容', contentId: '12345678901234567890' };
  const noLink = () => { throw Object.assign(new Error(), { code: 'EPERM' }); };
  assert.equal(writeSnapshot(target, snapshot, { linkFile: noLink }), target);
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), snapshot);
  assert.throws(() => writeSnapshot(target, { title: '不能覆盖' }, { linkFile: noLink }), { code: 'OUTPUT_EXISTS' });
  const racing = join(directory, 'racing.json');
  assert.throws(() => writeSnapshot(racing, snapshot, { linkFile: () => { writeFileSync(racing, 'keep'); noLink(); } }), { code: 'OUTPUT_EXISTS' });
  assert.equal(readFileSync(racing, 'utf8'), 'keep');
  assert.throws(() => writeSnapshot(join(directory, 'failed.json'), snapshot, { linkFile: noLink, copyFile: () => { throw new Error(); } }), { code: 'OUTPUT_WRITE_FAILED' });
  assert.equal(readdirSync(directory).some((name) => name.endsWith('.tmp')), false);
});

test('Windows PowerShell 5.1 在非 UTF-8 初始代码页中通过启动脚本正确解析中文 JSON', { skip: process.platform !== 'win32' }, (t) => {
  const directory = temporary(t), portable = join(directory, '独立 CLI with spaces'); mkdirSync(join(portable, 'lib'), { recursive: true });
  const files = ['cli.mjs', 'cli.ps1', 'runtime.mjs', ...['browser-runtime.mjs', 'history-collector.mjs', 'history-data.mjs', 'record-ranking.mjs', 'content-policy.mjs', 'zhihu-sources.mjs'].map((name) => `lib/${name}`)];
  for (const name of files) copyFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(portable, name));
  const wrapper = join(portable, 'cli.ps1').replaceAll("'", "''"); const data = join(directory, 'state').replaceAll("'", "''");
  const script = join(directory, 'verify.ps1');
  writeFileSync(script, '\uFEFF' + `$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936)\n$OutputEncoding = [Console]::OutputEncoding\n$result = & '${wrapper}' sync --demo --consent --json --data-dir '${data}' | ConvertFrom-Json -ErrorAction Stop\nif ($LASTEXITCODE -ne 0 -or $result.account.nickname -ne '演示读者' -or $result.records[0].title -ne '本地大模型推理如何加速') { throw '中文 JSON 校验失败' }\n[Console]::Out.WriteLine(($result.counts | ConvertTo-Json -Compress))\n`, 'utf8');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { history: 3, likes: 0, collections: 0 });
  const failed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(portable, 'cli.ps1'), 'sync', '--bad-argument', '--json'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  assert.equal(failed.status, 2); assert.equal(JSON.parse(failed.stderr).error.code, 'INVALID_ARGUMENTS');
});
