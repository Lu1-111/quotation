import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { createHistoryStore, HistoryError } from './lib/history-data.mjs';
import { createBrowserGateway, createDemoHistoryGateway, createHistoryCollector } from './lib/history-collector.mjs';
import { DEFAULT_SETTINGS } from './lib/record-ranking.mjs';
import { BROWSERS, BrowserSetupError } from './lib/browser-runtime.mjs';

export class CliError extends Error {
  constructor(code, message, exitCode = 1) { super(message); this.code = code; this.exitCode = exitCode; }
}
const SOURCE_ID = 'cli';
const TYPES = ['history', 'likes', 'collections', 'knowledgeFilter', 'fetchFullText'];
const fail = (code, message, exitCode) => { throw new CliError(code, message, exitCode); };

function inside(parent, target) {
  const path = relative(parent, target);
  return Boolean(path && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path));
}
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function lockProfile(path) {
  const nonce = randomUUID(); let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') fail('PROFILE_BUSY', '该档案正被其他 CLI 进程使用；若上次异常退出，请确认进程已结束后执行 unlock --yes。', 4);
    throw error;
  }
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce, createdAt: new Date().toISOString() })); }
  finally { closeSync(fd); }
  return () => { if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).nonce === nonce) unlinkSync(path); };
}
function forgetBrowser(profileRoot, browserDirectory) {
  if (!existsSync(browserDirectory)) return;
  const root = realpathSync(profileRoot), target = realpathSync(browserDirectory);
  if (lstatSync(browserDirectory).isSymbolicLink() || !inside(root, target)) fail('UNSAFE_PATH', '浏览器目录越出当前档案，已拒绝删除。');
  rmSync(browserDirectory, { recursive: true, force: true });
}

export function writeSnapshot(filename, snapshot, { overwrite = false, protectedRoots = [], linkFile = linkSync, copyFile = copyFileSync } = {}) {
  const target = resolve(filename);
  if (protectedRoots.some((root) => relative(root, target) === '' || inside(root, target))) fail('INVALID_OUTPUT', '导出文件不能写入 CLI 内部档案目录，请使用独立的 exports 目录。', 2);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const actualTarget = join(realpathSync(dirname(target)), basename(target));
  const actualProtected = protectedRoots.filter(existsSync).map((root) => realpathSync(root));
  if (actualProtected.some((root) => relative(root, actualTarget) === '' || inside(root, actualTarget))) fail('INVALID_OUTPUT', '输出路径指向内部档案，已拒绝写入。', 2);
  if (existsSync(target) && (!overwrite || lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile())) fail('OUTPUT_EXISTS', '输出路径已存在；需要覆盖普通文件时请显式加入 --overwrite。', 2);
  const temporary = join(dirname(target), `.zhihu-export-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (overwrite) renameSync(temporary, target);
    else {
      try { linkFile(temporary, target); }
      catch (error) {
        if (error.code === 'EEXIST') fail('OUTPUT_EXISTS', '输出文件已存在，未覆盖。', 2);
        if (!['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EXDEV'].includes(error.code)) throw error;
        try { copyFile(temporary, target, constants.COPYFILE_EXCL); }
        catch (copyError) { if (copyError.code === 'EEXIST') fail('OUTPUT_EXISTS', '输出文件已存在，未覆盖。', 2); fail('OUTPUT_WRITE_FAILED', '无法写入导出文件，请选择本机可写目录并检查剩余空间。', 2); }
      }
    }
  }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return target;
}

export function createCliRuntime({ dataDir = process.env.CLI_DATA_DIR || fileURLToPath(new URL('./.data', import.meta.url)), demo = false,
  browserChannel = process.env.CLI_BROWSER_CHANNEL, gatewayFactory, loginPollMs = 2000, pageDelay = 1000 } = {}) {
  const storageRoot = resolve(dataDir);
  const scope = join(storageRoot, demo ? 'demo' : 'live');
  const profilesRoot = join(scope, 'profiles');
  function paths(name = 'default') {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) fail('INVALID_PROFILE', 'profile 只允许 1 至 64 位英文字母、数字、下划线或连字符。', 2);
    name = name.toLowerCase();
    const directory = join(profilesRoot, `profile-${name}`);
    return { name, directory, database: join(directory, 'collection.sqlite'), lock: join(directory, 'operation.lock'), browserDirectory: join(directory, 'history-profiles') };
  }
  function prepare(path) {
    mkdirSync(path.directory, { recursive: true, mode: 0o700 });
    if (!inside(realpathSync(profilesRoot), realpathSync(path.directory))) fail('UNSAFE_PATH', '档案目录越出数据根目录，操作已停止。');
  }
  function channel(value) {
    const selected = value || browserChannel || 'auto';
    if (!BROWSERS.includes(selected)) fail('INVALID_BROWSER', 'browser 只支持 auto、msedge、chrome、chromium。', 2);
    return selected;
  }
  return {
    async execute(command, options = {}, { signal, log = () => {} } = {}) {
      signal?.throwIfAborted();
      const path = paths(options.profile);
      if (command === 'profiles') {
        const profiles = existsSync(profilesRoot) ? readdirSync(profilesRoot, { withFileTypes: true }).filter((item) => item.isDirectory() && /^profile-[a-z0-9][a-z0-9_-]{0,63}$/.test(item.name)).map((item) => item.name.slice(8)).sort() : [];
        return { type: 'status', value: { schemaVersion: 1, mode: 'cli', demo, profiles } };
      }
      if (command === 'status' && !existsSync(path.database)) return { type: 'status', value: { schemaVersion: 1, mode: 'cli', demo, profile: path.name, exists: false, consented: false, bound: false,
        nickname: '', lastSyncedAt: null, counts: { history: 0, likes: 0, collections: 0 }, settings: { ...DEFAULT_SETTINGS } } };
      if (command === 'export' && !existsSync(path.database)) fail('NO_SNAPSHOT', '该档案尚无采集数据，请先 login 和 sync。', 3);
      prepare(path);
      if (command === 'unlock') {
        if (!options.yes) fail('CONFIRM_REQUIRED', '移除遗留锁需要 --yes；运行中的进程不会被强行解锁。', 2);
        if (!existsSync(path.lock)) return { type: 'status', value: { profile: path.name, unlocked: false } };
        let owner; try { owner = JSON.parse(readFileSync(path.lock, 'utf8')); } catch { fail('INVALID_LOCK', '锁文件损坏，请检查档案目录。', 4); }
        if (processAlive(owner.pid)) fail('PROFILE_BUSY', '锁对应的进程仍在运行或无法核验，不能解锁。', 4);
        if (JSON.parse(readFileSync(path.lock, 'utf8')).nonce !== owner.nonce) fail('PROFILE_BUSY', '档案锁已改变，请重试。', 4);
        unlinkSync(path.lock); return { type: 'status', value: { profile: path.name, unlocked: true } };
      }
      const release = lockProfile(path.lock); let db;
      try {
        closeSync(openSync(path.database, 'a', 0o600)); db = new DatabaseSync(path.database);
        db.exec('PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS cli_metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
        const store = createHistoryStore(db); if (!store.get(SOURCE_ID)) store.create(SOURCE_ID);
        const savedBrowser = db.prepare("SELECT value FROM cli_metadata WHERE name = 'browser'").get()?.value;
        let browser = channel(options.browser || savedBrowser);
        if (['login', 'sync', 'config'].includes(command)) {
          const previous = store.settings(SOURCE_ID);
          const settings = { ...previous, aiReview: false };
          for (const key of TYPES) if (options[key] !== undefined) settings[key] = options[key];
          if (Object.keys(settings).some((key) => settings[key] !== previous[key])) store.saveSettings(SOURCE_ID, settings);
          if (options.browser) db.prepare("INSERT INTO cli_metadata VALUES ('browser', ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(browser);
        }
        const status = () => {
          const source = store.get(SOURCE_ID), snapshot = store.snapshot(SOURCE_ID, demo);
          return { schemaVersion: 1, mode: 'cli', demo, profile: path.name, exists: true, consented: Boolean(source.consented_at), bound: Boolean(source.account_id),
            accountRef: source.account_id ? createHash('sha256').update(`zhihu:${source.account_id}`).digest('hex') : null,
            nickname: source.nickname || '', lastSyncedAt: source.last_synced_at, browser, settings: snapshot.settings, counts: snapshot.counts };
        };
        if (command === 'status' || command === 'config') return { type: 'status', value: status() };
        if (command === 'logout' || command === 'clear') {
          if (command === 'clear' && !options.yes) fail('CONFIRM_REQUIRED', 'clear 会删除该档案的数据和登录状态，请显式加入 --yes。', 2);
          store.revoke(SOURCE_ID); store.pause(SOURCE_ID); forgetBrowser(path.directory, path.browserDirectory);
          if (command === 'clear') store.clear(SOURCE_ID);
          return { type: 'status', value: { ...status(), operation: command } };
        }
        if (command === 'login' || command === 'sync') {
          if (options.consent === true) store.consent(SOURCE_ID);
          if (!store.get(SOURCE_ID).consented_at) fail('CONSENT_REQUIRED', '首次采集需显式加入 --consent，表示同意将所选账号信息保存到本机。', 3);
        }
        const makeGateway = () => gatewayFactory ? gatewayFactory(path.name) : demo ? createDemoHistoryGateway() : createBrowserGateway(join(path.browserDirectory, SOURCE_ID), browser);
        if (command === 'login') {
          const gateway = makeGateway();
          const loginSignal = AbortSignal.any([AbortSignal.timeout((options.loginTimeout || 180) * 1000), ...(signal ? [signal] : [])]);
          const stop = () => { void gateway.close().catch(() => {}); };
          loginSignal.addEventListener('abort', stop, { once: true });
          try {
            log(demo ? '正在连接合成演示账号。' : '正在打开专用浏览器，请在知乎页面完成登录或验证。');
            await gateway.open({ headless: false });
            if (!demo && gateway.browserChannel) {
              browser = gateway.browserChannel;
              db.prepare("INSERT INTO cli_metadata VALUES ('browser', ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(browser);
            }
            while (true) {
              loginSignal.throwIfAborted();
              let profile;
              try { profile = await gateway.request('/api/v4/me'); }
              catch (error) { if (error.status !== 401) throw error; }
              if (typeof profile?.id === 'string' && profile.id && !profile.error) {
                store.bindAccount(SOURCE_ID, { id: profile.id, nickname: typeof profile.name === 'string' ? profile.name : '' });
                return { type: 'status', value: { ...status(), operation: 'login' } };
              }
              await pause(loginPollMs, undefined, { signal: loginSignal });
            }
          } catch (error) {
            if (loginSignal.aborted && !signal?.aborted) fail('LOGIN_TIMEOUT', '等待登录超时，请重试 login；采集数据未被替换。', 3);
            throw error;
          } finally { loginSignal.removeEventListener('abort', stop); await gateway.close(); }
        }
        if (command === 'sync') {
          const collector = createHistoryCollector(store, { gatewayFactory: makeGateway, pageDelay: demo ? 0 : pageDelay,
            // CLI 的显式前台命令是本次运行许可；网页版的页面在线检查保持原样。
            isPageActive: () => !signal?.aborted });
          const stop = () => { void collector.stopForClosedPage(SOURCE_ID).catch(() => {}); };
          signal?.addEventListener('abort', stop, { once: true });
          try { log('正在获取所选内容，完成后关闭采集浏览器。'); await collector.sync(SOURCE_ID, false); }
          finally { signal?.removeEventListener('abort', stop); await collector.stopForClosedPage(SOURCE_ID); }
        } else if (command !== 'export') fail('INVALID_COMMAND', '不支持的 CLI 命令。', 2);
        if (!store.get(SOURCE_ID).last_synced_at) fail('NO_SNAPSHOT', '该档案尚无成功快照，请先 sync。', 3);
        signal?.throwIfAborted();
        const snapshot = store.snapshot(SOURCE_ID, demo);
        const savedTo = options.output ? writeSnapshot(options.output, snapshot, { overwrite: options.overwrite,
          protectedRoots: ['demo', 'live'].map((kind) => join(storageRoot, kind, 'profiles')) }) : null;
        return { type: 'snapshot', value: snapshot, accountRef: status().accountRef, savedTo };
      } finally { if (db) db.close(); release(); }
    },
  };
}

export function safeCliError(error, signal) {
  if (signal?.aborted) return new CliError('CANCELLED', '采集已取消，未完成的结果不会保存为新快照。', 130);
  if (error instanceof CliError) return error;
  if (error instanceof BrowserSetupError) return new CliError(error.code, error.message, 3);
  if (error instanceof HistoryError) return new CliError(error.status === 409 ? 'ACCOUNT_OR_SESSION_MISMATCH' : error.status === 401 ? 'LOGIN_REQUIRED' : error.status === 429 ? 'RATE_LIMITED' : 'COLLECTION_ERROR', error.message, [401, 403, 409].includes(error.status) ? 3 : 1);
  return new CliError('LOCAL_IO_ERROR', '本机文件、数据库或浏览器操作失败，请检查路径、权限与依赖。');
}
