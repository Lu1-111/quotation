import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, unlinkSync, mkdirSync, symlinkSync, copyFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createCliRuntime } from '../runtime.mjs';
import { parseCliArgs } from '../cli.mjs';
import { createDemoHistoryGateway } from '../lib/history-collector.mjs';

const entry = fileURLToPath(new URL('../cli.mjs', import.meta.url));
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'quotation-cli-test-'));
  t.after(() => { const actual = realpathSync(directory); assert.equal(dirname(actual), realpathSync(tmpdir())); assert.ok(basename(actual).startsWith('quotation-cli-test-')); rmSync(actual, { recursive: true, force: true }); });
  const dataDir = join(directory, 'state');
  const run = (...args) => spawnSync(process.execPath, [entry, ...args, '--data-dir', dataDir], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 4_000_000, windowsHide: true,
    env: { ...process.env, CLI_DATA_DIR: '', CLI_BROWSER_CHANNEL: '', NODE_OPTIONS: '' },
  });
  const success = (...args) => { const result = run(...args); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  return { directory, dataDir, run, success };
}

test('CLI 参数校验支持否定开关，帮助和不存在的档案不创建数据', (t) => {
  const { dataDir, run, success } = fixture(t);
  const parsed = parseCliArgs(['config', '--history', '--no-likes', '--no-knowledge-filter']);
  assert.equal(parsed.options.history, true); assert.equal(parsed.options.likes, false); assert.equal(parsed.options.knowledgeFilter, false);
  assert.match(run('--help').stdout, /不启动 HTTP 服务/);
  assert.equal(success('status', '--json').exists, false); assert.equal(existsSync(dataDir), false);
  for (const args of [['unknown'], ['sync', '--token', 'must-not-echo'], ['login', '--login-timeout', '0'], ['export', '--history'], ['sync', '--profile', '../outside']]) {
    const result = run(...args, '--json'); assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.ok(JSON.parse(result.stderr).error.code); assert.ok(!result.stderr.includes('must-not-echo'));
  }
});

test('独立 CLI 可登录演示账号、保存设置、同步并导出相同版本3快照', (t) => {
  const { run, success, dataDir } = fixture(t);
  const denied = run('sync', '--demo', '--json'); assert.equal(denied.status, 3); assert.equal(JSON.parse(denied.stderr).error.code, 'CONSENT_REQUIRED');
  const login = success('login', '--demo', '--consent', '--profile', 'Personal', '--browser', 'chrome', '--json');
  assert.equal(login.bound, true); assert.equal(login.lastSyncedAt, null); assert.equal(login.profile, 'personal');
  const configured = success('config', '--demo', '--profile', 'personal', '--history', '--likes', '--collections', '--json'); assert.equal(configured.browser, 'chrome');
  const snapshot = success('sync', '--demo', '--profile', 'personal', '--json');
  assert.equal(snapshot.schemaVersion, 3); assert.equal(snapshot.source, 'demo_history'); assert.deepEqual(snapshot.counts, { history: 3, likes: 1, collections: 1 });
  assert.equal(snapshot.records.length, 3); assert.ok(snapshot.records.every((record) => typeof record.contentId === 'string'));
  assert.deepEqual(success('export', '--demo', '--profile', 'personal'), snapshot);
  assert.equal(existsSync(join(dataDir, 'demo', 'profiles', 'profile-personal', 'operation.lock')), false);
});

test('档案与真实／演示目录独立，配置和清除只作用于所选档案', (t) => {
  const { success } = fixture(t);
  success('sync', '--demo', '--profile', 'alpha', '--consent', '--likes', '--json');
  success('sync', '--demo', '--profile', 'beta', '--consent', '--collections', '--json');
  assert.deepEqual(success('profiles', '--demo', '--json').profiles, ['alpha', 'beta']);
  assert.deepEqual(success('profiles', '--json').profiles, []);
  assert.equal(success('status', '--profile', 'alpha', '--json').exists, false);
  assert.equal(success('config', '--demo', '--profile', 'alpha', '--no-history', '--json').settings.history, false);
  assert.equal(success('status', '--demo', '--profile', 'beta', '--json').settings.history, true);
  success('clear', '--demo', '--profile', 'alpha', '--yes', '--json');
  assert.equal(success('status', '--demo', '--profile', 'alpha', '--json').lastSyncedAt, null);
  assert.ok(success('status', '--demo', '--profile', 'beta', '--json').lastSyncedAt);
});

test('文件导出与标准输出一致，不隐式覆盖已有文件或内部数据库', (t) => {
  const { directory, dataDir, run, success } = fixture(t);
  const snapshot = success('sync', '--demo', '--consent', '--json');
  const output = join(directory, 'exports', 'result.json');
  assert.equal(run('export', '--demo', '--output', output).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), snapshot);
  const refused = run('export', '--demo', '--output', output, '--json'); assert.equal(refused.status, 2); assert.equal(JSON.parse(refused.stderr).error.code, 'OUTPUT_EXISTS');
  assert.equal(run('export', '--demo', '--output', output, '--overwrite').status, 0);
  const database = join(dataDir, 'demo', 'profiles', 'profile-default', 'collection.sqlite');
  const protectedResult = run('export', '--demo', '--output', database, '--overwrite', '--json'); assert.equal(protectedResult.status, 2);
  success('sync', '--demo', '--profile', 'another', '--consent', '--json');
  const otherDatabase = join(dataDir, 'demo', 'profiles', 'profile-another', 'collection.sqlite');
  assert.equal(run('export', '--demo', '--output', otherDatabase, '--overwrite', '--json').status, 2);
  assert.equal(success('export', '--demo', '--profile', 'another').records.length, 3);
  assert.equal(success('export', '--demo').revision, snapshot.revision);
});

test('采集锁拒绝重叠命令，不能解锁活跃进程，可清理已退出进程的遗留锁', (t) => {
  const { dataDir, run, success } = fixture(t); success('sync', '--demo', '--consent', '--json');
  const lock = join(dataDir, 'demo', 'profiles', 'profile-default', 'operation.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
  assert.equal(run('status', '--demo', '--json').status, 4); assert.equal(run('unlock', '--demo', '--yes', '--json').status, 4);
  unlinkSync(lock);
  const exited = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }); assert.equal(exited.status, 0);
  writeFileSync(lock, JSON.stringify({ pid: exited.pid, nonce: randomUUID() }));
  assert.equal(success('unlock', '--demo', '--yes', '--json').unlocked, true);
  assert.equal(existsSync(lock), false);
});

test('logout 保留本地结果但撤回同意，clear 必须明确确认', (t) => {
  const { run, success } = fixture(t); const snapshot = success('sync', '--demo', '--consent', '--json');
  assert.equal(run('clear', '--demo', '--json').status, 2);
  assert.equal(success('logout', '--demo', '--json').consented, false);
  assert.equal(success('export', '--demo').revision, snapshot.revision);
  assert.equal(run('sync', '--demo', '--json').status, 3);
  assert.equal(success('clear', '--demo', '--yes', '--json').bound, false);
  assert.equal(run('export', '--demo', '--json').status, 3);
});

test('登录目录清理限定在当前档案，拒绝通过链接删除其他目录', (t) => {
  const { directory, dataDir, run, success } = fixture(t); success('sync', '--demo', '--consent', '--json');
  const browser = join(dataDir, 'demo', 'profiles', 'profile-default', 'history-profiles');
  mkdirSync(browser); writeFileSync(join(browser, 'fixture-cookie'), 'synthetic');
  assert.equal(run('logout', '--demo', '--json').status, 0); assert.equal(existsSync(browser), false);
  const outside = join(directory, 'must-keep'); mkdirSync(outside); writeFileSync(join(outside, 'marker'), 'keep');
  symlinkSync(outside, browser, process.platform === 'win32' ? 'junction' : 'dir');
  const refused = run('clear', '--demo', '--yes', '--json');
  assert.equal(refused.status, 1); assert.equal(JSON.parse(refused.stderr).error.code, 'UNSAFE_PATH');
  assert.equal(readFileSync(join(outside, 'marker'), 'utf8'), 'keep');
});

test('登录只绑定账号不清空旧数据，换账号必须使用另一档案', async (t) => {
  const { dataDir } = fixture(t); let owner = 'owner-a';
  const runtime = createCliRuntime({ dataDir, demo: true, gatewayFactory() {
    const gateway = createDemoHistoryGateway(); const request = gateway.request;
    gateway.request = async (path) => path === '/api/v4/me' ? { id: owner, name: owner, url_token: owner } : request(path);
    return gateway;
  } });
  const original = await runtime.execute('sync', { consent: true });
  await runtime.execute('login');
  assert.deepEqual((await runtime.execute('export')).value, original.value);
  owner = 'owner-b';
  await assert.rejects(runtime.execute('login'), /其他知乎账号/);
  await assert.rejects(runtime.execute('sync'), /账号不一致/);
  assert.deepEqual((await runtime.execute('export')).value, original.value);
});

test('取消同步后不写入迟到结果，并释放档案锁', async (t) => {
  const { dataDir } = fixture(t); let hold = false, release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const runtime = createCliRuntime({ dataDir, demo: true, gatewayFactory() {
    const gateway = createDemoHistoryGateway(), request = gateway.request;
    gateway.request = async (path) => { if (hold && path.includes('/read_history')) { entered(); await new Promise((resolve) => { release = resolve; }); } return request(path); };
    return gateway;
  } });
  const original = (await runtime.execute('sync', { consent: true })).value;
  hold = true; const controller = new AbortController(); const pending = runtime.execute('sync', {}, { signal: controller.signal }).catch((error) => error);
  await started; controller.abort(); release(); assert.ok((await pending) instanceof Error);
  assert.deepEqual((await runtime.execute('export')).value, original);
  assert.equal(existsSync(join(dataDir, 'demo', 'profiles', 'profile-default', 'operation.lock')), false);
});

test('只复制 CLI 自身文件到独立目录，也能完成演示同步', (t) => {
  const { directory, dataDir } = fixture(t);
  const portable = join(directory, 'portable-cli');
  mkdirSync(join(portable, 'lib'), { recursive: true });
  const files = ['cli.mjs', 'runtime.mjs', 'package.json', ...['browser-runtime.mjs', 'history-collector.mjs', 'history-data.mjs', 'record-ranking.mjs', 'content-policy.mjs', 'zhihu-sources.mjs'].map((name) => `lib/${name}`)];
  for (const name of files) copyFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(portable, name));
  const result = spawnSync(process.execPath, [join(portable, 'cli.mjs'), 'sync', '--demo', '--consent', '--json', '--data-dir', dataDir], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 4_000_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).schemaVersion, 3);
  assert.equal(JSON.parse(result.stdout).records.length, 3);
});
