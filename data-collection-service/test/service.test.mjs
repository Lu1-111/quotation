import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer as createSocketServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServiceStore } from '../store.mjs';
import { createApiServer } from '../server.mjs';
import { createApiClient, startPageSync } from '../client.mjs';
import { createWorker } from '../worker.mjs';
import { createAgentTools } from '../agent-tools.mjs';
import { collectionPageSchema, defaultSettings, deliverySchema } from '../contracts.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('../examples/snapshot-v3.json', import.meta.url), 'utf8'));
const allSettings = fixture().settings;
const accountRef = 'a'.repeat(64);
function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'zhihu-service-test-')); const store = createServiceStore(join(directory, 'test.sqlite'), { demo: true, ...options });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const credentials = store.provision('合成测试用户'); const user = store.authenticate(credentials.userToken, 'user'); const device = store.authenticate(credentials.deviceToken, 'device');
  return { store, credentials, user, device, directory };
}
function complete(store, user, device, changes = {}) {
  const job = store.createJob(user.userId, { settings: allSettings }); const claimed = store.claim(device);
  const payload = { leaseToken: claimed.leaseToken, accountRef, snapshot: fixture(), ...changes };
  return { job, claimed, payload, result: store.complete(device, job.id, payload) };
}
async function api(t, options) {
  const context = setup(t, options); const { store, credentials } = context;
  const socket = createSocketServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise((ok) => socket.close(ok)); const baseUrl = `http://127.0.0.1:${port}`;
  const server = createApiServer({ store, publicOrigin: baseUrl, allowedOrigins: ['https://app.example.test'] });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  const fetchImpl = fetch;
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { ...context, baseUrl, fetchImpl, client: createApiClient({ baseUrl, token: credentials.userToken, fetchImpl }),
    deviceClient: createApiClient({ baseUrl, token: credentials.deviceToken, fetchImpl }) };
}

test('凭证角色、用户和设备隔离；重复交付幂等并绑定账号', (t) => {
  const { store, credentials, user, device, directory } = setup(t);
  const other = store.provision('另一合成用户');
  assert.throws(() => store.authenticate(credentials.deviceToken, 'user'), { code: 'UNAUTHORIZED' });
  const { job, payload, result } = complete(store, user, device);
  assert.equal(store.complete(device, job.id, payload).snapshotId, result.snapshotId);
  assert.equal(store.heartbeat(device, job.id, payload.leaseToken).state, 'succeeded');
  assert.throws(() => store.snapshot(other.userId, result.snapshotId), { code: 'NOT_FOUND' });
  assert.throws(() => store.job(other.userId, job.id), { code: 'NOT_FOUND' });
  assert.throws(() => store.createJob(other.userId, { deviceId: device.deviceId }), { code: 'NOT_FOUND' });
  assert.equal(store.claim(store.authenticate(other.deviceToken, 'device')), null);
  const second = store.createJob(user.userId, { settings: allSettings }); const claim2 = store.claim(device);
  assert.throws(() => store.complete(device, second.id, { ...payload, leaseToken: claim2.leaseToken, accountRef: 'b'.repeat(64) }), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(store.snapshot(user.userId).snapshotId, result.snapshotId);
  const bytes = readFileSync(join(directory, 'test.sqlite'));
  assert.equal(bytes.includes(Buffer.from(credentials.userToken)), false);
  assert.equal(bytes.includes(Buffer.from(credentials.deviceToken)), false);
});

test('调用方离线、取消和设备超时均拒绝迟到上传；有效调用方可重新领取', (t) => {
  let time = Date.now(); const { store, user, device } = setup(t, { now: () => time, clientLeaseMs: 1000, workerLeaseMs: 200 });
  const first = store.createJob(user.userId, { settings: allSettings }); const claim1 = store.claim(device);
  assert.throws(() => store.createJob(user.userId), { code: 'BUSY' });
  time += 210; const claim2 = store.claim(device); assert.equal(claim2.job.id, first.id); assert.notEqual(claim1.leaseToken, claim2.leaseToken);
  assert.throws(() => store.complete(device, first.id, { leaseToken: claim1.leaseToken, accountRef, snapshot: fixture() }), { code: 'LEASE_EXPIRED' });
  time += 1000;
  assert.equal(store.job(user.userId, first.id).error.code, 'CLIENT_OFFLINE');
  assert.throws(() => store.complete(device, first.id, { leaseToken: claim2.leaseToken, accountRef, snapshot: fixture() }), { code: 'LEASE_EXPIRED' });
  const next = store.createJob(user.userId, { settings: allSettings }); const claim3 = store.claim(device); store.cancel(user.userId, next.id);
  assert.throws(() => store.complete(device, next.id, { leaseToken: claim3.leaseToken, accountRef, snapshot: fixture() }), { code: 'LEASE_EXPIRED' });
  assert.throws(() => store.snapshot(user.userId), { code: 'NOT_FOUND' });
});

test('快照校验拒绝混合模式、错误计数和越权类别；清除只影响当前用户', (t) => {
  const { store, user, device } = setup(t);
  const { result } = complete(store, user, device);
  const other = store.provision('另一用户'); const otherDevice = store.authenticate(other.deviceToken, 'device');
  const otherResult = complete(store, { userId: other.userId }, otherDevice).result;
  const job = store.createJob(user.userId, { settings: allSettings }); const claimed = store.claim(device);
  for (const changed of [{ ...fixture(), source: 'zhihu_selected_data' }, { ...fixture(), counts: { history: 9999, likes: 0, collections: 0 } }]) {
    assert.throws(() => store.complete(device, job.id, { leaseToken: claimed.leaseToken, accountRef, snapshot: changed }), { code: 'INVALID_ARGUMENTS' });
  }
  store.clear(user.userId);
  assert.throws(() => store.snapshot(user.userId, result.snapshotId), { code: 'NOT_FOUND' });
  assert.equal(store.snapshot(other.userId).snapshotId, otherResult.snapshotId);
  assert.equal(store.status(user.userId).accountBound, false);
});

test('HTTP 验证 Host、来源、身份与请求结构；分页不传递全文或凭证', async (t) => {
  const { store, user, device, client, baseUrl, fetchImpl, credentials } = await api(t);
  const wrongHost = await new Promise((ok, fail) => { const req = httpRequest(baseUrl + '/health', { headers: { Host: 'evil.example.test' } }, (response) => { response.resume(); ok(response.statusCode); }); req.on('error', fail); req.end(); });
  assert.equal(wrongHost, 403);
  assert.equal((await fetchImpl(baseUrl + '/v1/status')).status, 401);
  assert.equal((await fetchImpl(baseUrl + '/health', { headers: { Origin: 'https://evil.example.test' } })).status, 403);
  const cors = await fetchImpl(baseUrl + '/health', { headers: { Origin: 'https://app.example.test' } });
  assert.equal(cors.headers.get('access-control-allow-origin'), 'https://app.example.test');
  await assert.rejects(client.createJob({ userId: randomUUID() }), { code: 'INVALID_ARGUMENTS' });
  complete(store, user, device);
  const page = await client.readPage({ limit: 1, summaryMaxChars: 2 });
  assert.equal(page.items.length, 1); assert.equal([...page.items[0].summary].length, 2); assert.equal(page.page.hasMore, true);
  assert.equal(JSON.stringify(page).includes(credentials.userToken), false); assert.equal('bodyText' in page.items[0], false);
  await assert.rejects(client.readPage({ limit: 21 }), { code: 'INVALID_ARGUMENTS' });
});

test('SDK 取消任务，服务端保留上次快照', async (t) => {
  const { client, store, user, device } = await api(t); const previous = complete(store, user, device).result;
  // 等客户端收到任务 ID 再取消；服务端排队不代表创建响应已送达客户端。
  let acknowledge; const acknowledged = new Promise((ok) => { acknowledge = ok; }); const create = client.createJob;
  client.createJob = async (...args) => { const job = await create(...args); acknowledge(job); return job; };
  const controller = new AbortController(); const pending = client.sync({ signal: controller.signal, pollMs: 10 });
  const active = await acknowledged;
  assert.ok(active); controller.abort(); await assert.rejects(pending);
  assert.equal(store.job(user.userId, active.id).state, 'cancelled'); assert.equal(store.snapshot(user.userId).snapshotId, previous.snapshotId);
});

test('完整演示链路：本机同意、后台采集、上传、Agent 分页；服务端不能扩大同意范围', async (t) => {
  const { client, deviceClient, directory, store, user } = await api(t);
  const worker = createWorker({ client: deviceClient, demo: true, dataDir: join(directory, 'worker') });
  await assert.rejects(worker.login(), { code: 'CONSENT_REQUIRED' });
  await worker.login({ consent: true, settings: defaultSettings });
  const forbidden = await client.createJob({ settings: allSettings });
  assert.equal((await worker.runOnce()).code, 'CONSENT_SCOPE_MISMATCH');
  assert.equal((await client.job(forbidden.id)).state, 'failed');
  await worker.login({ consent: true, settings: allSettings });
  const tools = createAgentTools({ client }); const syncing = tools.call('zhihu_collection_sync', { limit: 1, timeoutSeconds: 15 });
  for (let i = 0; i < 100; i++) { if (store.status(user.userId).activeJob) break; await new Promise((ok) => setTimeout(ok, 10)); }
  const worked = await worker.runOnce(); assert.equal(worked.state, 'succeeded');
  const result = await syncing; assert.equal(result.ok, true, JSON.stringify(result.error)); assert.equal(result.data.items.length, 1);
  assert.equal(collectionPageSchema.safeParse(result.data).success, true);
  assert.equal(deliverySchema.safeParse(await client.read(result.data.snapshotId)).success, true);
  const next = await tools.call('zhihu_collection_read', { snapshotId: result.data.snapshotId, offset: result.data.page.nextOffset, limit: 20 });
  assert.equal(next.ok, true); assert.ok(next.data.items.length > 0);
  assert.equal((await tools.call('zhihu_collection_read', { limit: 999 })).error.code, 'INVALID_ARGUMENTS');
  await worker.revoke();
  await client.createJob({ settings: allSettings }); assert.equal((await worker.runOnce()).code, 'LOGIN_REQUIRED');
  await tools.close(); assert.equal((await tools.call('zhihu_collection_status')).error.code, 'CLOSED');
});

test('凭证撤销和轮换立即生效；凭证文件写入失败不会使旧令牌失效', (t) => {
  const { store, user, device, credentials } = setup(t);
  assert.throws(() => store.rotateUserToken(user.userId, () => { throw new Error('模拟磁盘写入失败'); }));
  assert.equal(store.authenticate(credentials.userToken, 'user').userId, user.userId);
  store.createJob(user.userId); const claimed = store.claim(device);
  const rotated = store.rotateUserToken(user.userId);
  assert.throws(() => store.authenticate(credentials.userToken, 'user'), { code: 'UNAUTHORIZED' });
  assert.equal(store.authenticate(rotated.userToken, 'user').userId, user.userId);
  assert.equal(store.job(user.userId, claimed.job.id).state, 'cancelled');
  store.revokeDevice(user.userId, device.deviceId);
  assert.throws(() => store.authenticate(credentials.deviceToken, 'device'), { code: 'UNAUTHORIZED' });
});

test('网页 pagehide 会终止定时调度和当前请求', async () => {
  const lifecycle = new EventTarget(); let received; const started = new Promise((ok) => { received = ok; }); let calls = 0;
  const task = startPageSync({ lifecycle, client: { sync: ({ signal }) => { calls++; received(); return new Promise((_ok, fail) => signal.addEventListener('abort', () => fail(signal.reason), { once: true })); } } });
  await started; lifecycle.dispatchEvent(new Event('pagehide')); await task.done; assert.equal(calls, 1);
});

test('调用方失联会停止正在执行的本机任务，旧结果仍可读取', async (t) => {
  const { client, deviceClient, directory, store, user, device } = await api(t, { clientLeaseMs: 100 });
  const previous = complete(store, user, device).result; let stopped = false;
  const runtime = { async execute(command, _options, { signal } = {}) {
    if (command === 'login') return { value: { accountRef } };
    if (command === 'status') return { value: { accountRef, bound: true, consented: true } };
    if (command === 'sync') return new Promise((_ok, fail) => signal.addEventListener('abort', () => { stopped = true; fail(signal.reason); }, { once: true }));
    return {};
  } };
  const worker = createWorker({ client: deviceClient, runtime, demo: true, dataDir: join(directory, 'slow-worker') });
  await worker.login({ consent: true }); const job = await client.createJob();
  // 将测试心跳缩短至一秒，不改变生产默认的十五秒。
  const original = deviceClient.request;
  deviceClient.request = async (...args) => { const result = await original(...args); return args[0] === '/v1/worker/claim' && result ? { ...result, heartbeatSeconds: 1 } : result; };
  const result = await worker.runOnce(); assert.equal(result.code, 'LEASE_EXPIRED'); assert.equal(stopped, true);
  assert.equal(store.job(user.userId, job.id).state, 'cancelled'); assert.equal(store.snapshot(user.userId).snapshotId, previous.snapshotId);
});

test('真实 MCP 标准输入输出连接可发现三个工具并读取有界快照', { timeout: 15_000 }, async (t) => {
  const { baseUrl, store, user, device, credentials } = await api(t); complete(store, user, device);
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../mcp-server.mjs', import.meta.url))],
    env: { ...process.env, DATA_SERVICE_URL: baseUrl, DATA_SERVICE_USER_TOKEN: credentials.userToken }, stderr: 'pipe' });
  const mcp = new Client({ name: 'collection-test', version: '1.0.0' }); t.after(() => mcp.close());
  await mcp.connect(transport); const catalog = await mcp.listTools(); assert.equal(catalog.tools.length, 3);
  const status = await mcp.callTool({ name: 'zhihu_collection_status', arguments: {} }); assert.equal(status.structuredContent.data.demo, true);
  const records = await mcp.callTool({ name: 'zhihu_collection_read', arguments: { limit: 1 } });
  assert.equal(records.isError, false); assert.equal(records.structuredContent.data.items.length, 1); assert.deepEqual(JSON.parse(records.content[0].text), records.structuredContent);
  const invalid = await mcp.callTool({ name: 'zhihu_collection_read', arguments: { userId: randomUUID() } });
  assert.equal(invalid.isError, true); assert.equal(invalid.structuredContent.error.code, 'INVALID_ARGUMENTS');
});

test('CLI 进程可开通凭证、本人同意、执行单次采集并导出纯 JSON', { timeout: 20_000 }, async (t) => {
  const { client, directory, credentials, baseUrl } = await api(t);
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url)); const file = join(directory, 'private.json');
  writeFileSync(file, JSON.stringify({ baseUrl, ...credentials }), { mode: 0o600 });
  const invoke = async (args) => {
    const { stdout } = await promisify(execFile)(process.execPath, [cli, ...args], { timeout: 15_000, env: { ...process.env,
      DATA_SERVICE_URL: baseUrl, DATA_SERVICE_USER_TOKEN: '', DATA_SERVICE_DEVICE_TOKEN: '' } });
    return JSON.parse(stdout);
  };
  const created = await invoke(['provision', '--demo', '--name', '合成 CLI 用户', '--data-dir', join(directory, 'provision'), '--output', join(directory, 'new-private.json')]);
  assert.ok(created.userId); assert.equal('userToken' in created, false); assert.equal('deviceToken' in created, false);
  const login = await invoke(['worker-login', '--demo', '--consent', '--credentials', file, '--worker-data-dir', join(directory, 'cli-worker')]);
  assert.equal(login.consented, true); const job = await client.createJob();
  const worked = await invoke(['worker', '--demo', '--once', '--credentials', file, '--worker-data-dir', join(directory, 'cli-worker')]);
  assert.equal(worked.state, 'succeeded'); assert.equal(worked.jobId, job.id);
  const exported = await invoke(['export', '--credentials', file]); assert.equal(exported.kind, 'collection_snapshot');
  assert.equal(deliverySchema.safeParse(exported).success, true);
});
