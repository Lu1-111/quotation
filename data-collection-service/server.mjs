import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import * as z from 'zod/v4';
import { createJobSchema, localConsentSchema, pageSchema, parse, parseSettings, syncPlanSchema, uploadSchema } from './contracts.mjs';
import { ServiceError, safeError } from './errors.mjs';

const empty = z.object({}).strict();
const lease = z.object({ leaseToken: uploadSchema.shape.leaseToken }).strict();
const failed = lease.extend({ code: z.enum(['CONSENT_REQUIRED', 'CONSENT_SCOPE_MISMATCH', 'LOGIN_REQUIRED', 'ACCOUNT_MISMATCH', 'COLLECTION_FAILED']) });
const idSchema = z.string().uuid();
function origin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) throw new Error('PUBLIC_ORIGIN 和 ALLOWED_ORIGINS 必须是完整来源，不含路径。');
  return url;
}

export function createApiServer({ store, localControl, publicOrigin = 'http://127.0.0.1:3005', allowedOrigins = [], maxBodyBytes = 32 * 1024 * 1024 } = {}) {
  const canonical = origin(publicOrigin);
  const allowed = new Set([canonical.origin, ...allowedOrigins.map((value) => origin(value).origin)]);
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Vary', 'Origin');
    const send = (status, data) => { if (!response.destroyed) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); } };
    try {
      if (request.headers.host !== canonical.host) throw new ServiceError('HOST_DENIED', '请求 Host 与 PUBLIC_ORIGIN 不一致。', 403);
      const requestOrigin = request.headers.origin;
      if (requestOrigin && !allowed.has(requestOrigin)) throw new ServiceError('ORIGIN_DENIED', '网页来源不在允许列表。', 403);
      if (requestOrigin) response.setHeader('Access-Control-Allow-Origin', requestOrigin);
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS'); response.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Local-UI');
        response.writeHead(204); response.end(); return;
      }
      const url = new URL(request.url, canonical); const path = url.pathname;
      const assets = { '/': ['public/index.html', 'text/html'], '/app.js': ['public/app.js', 'text/javascript'], '/style.css': ['public/style.css', 'text/css'], '/client.mjs': ['client.mjs', 'text/javascript'] };
      if (request.method === 'GET' && Object.hasOwn(assets, path)) {
        const [file, mime] = assets[path];
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        response.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }); response.end(readFileSync(new URL(file, import.meta.url))); return;
      }
      if (path === '/health' && request.method === 'GET') { send(200, { schemaVersion: 1, ok: true, data: { service: 'data-collection-service', demo: store.demo } }); return; }
      const worker = path.startsWith('/v1/worker/');
      const header = request.headers.authorization;
      const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
      let principal;
      if (request.headers['x-local-ui'] === '1') {
        const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
        const sameOrigin = requestOrigin === canonical.origin || (!requestOrigin && request.method === 'GET' && request.headers['sec-fetch-site'] === 'same-origin');
        if (!localControl || !loopback || !sameOrigin) throw new ServiceError('LOCAL_UI_DENIED', '本机界面仅允许同源页面在当前设备上操作。', 403);
        principal = { userId: localControl.userId, role: 'user' };
      } else principal = store.authenticate(token, token?.startsWith('agt_') ? 'reader' : worker ? 'device' : 'user');
      if (principal.role === 'reader' && (!path.startsWith('/v1/agent/') || request.method !== 'GET')) throw new ServiceError('READ_ONLY', 'Agent 入口只读取已采集数据，请由用户在界面中控制同步。', 403);
      async function body() {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new ServiceError('CONTENT_TYPE', '请求体需为 application/json。', 415);
        if (Number(request.headers['content-length']) > maxBodyBytes) throw new ServiceError('BODY_TOO_LARGE', '单次上传超过 32 MiB，请拆分或调整部署限制。', 413);
        let size = 0; const parts = [];
        for await (const part of request) { size += part.length; if (size > maxBodyBytes) throw new ServiceError('BODY_TOO_LARGE', '单次上传超过大小限制。', 413); parts.push(part); }
        try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new ServiceError('INVALID_JSON', '请求体不是有效 JSON。', 400); }
      }
      let data; let status = 200; const method = request.method;
      const userId = principal.userId;
      const userJob = path.match(/^\/v1\/jobs\/([^/]+)(\/keepalive)?$/);
      const workerJob = path.match(/^\/v1\/worker\/jobs\/([^/]+)\/(heartbeat|complete|fail)$/);
      if (path.startsWith('/v1/agent/')) {
        if (principal.role !== 'reader') throw new ServiceError('UNAUTHORIZED', 'Agent 接口需要独立的只读凭证。', 401);
        if (path === '/v1/agent/status') data = store.readerStatus(userId);
        else if (path === '/v1/agent/format') data = store.outputFormat();
        else if (path === '/v1/agent/profile') {
          const query = Object.fromEntries(url.searchParams);
          for (const key of ['offset', 'limit', 'summaryMaxChars', 'bodyMaxChars']) if (Object.hasOwn(query, key)) query[key] = /^\d+$/.test(query[key]) ? Number(query[key]) : NaN;
          data = store.profilePage(userId, parse(pageSchema, query));
        } else if (path === '/v1/agent/records') {
          const query = Object.fromEntries(url.searchParams);
          for (const key of ['offset', 'limit', 'summaryMaxChars', 'bodyMaxChars']) if (Object.hasOwn(query, key)) query[key] = /^\d+$/.test(query[key]) ? Number(query[key]) : NaN;
          data = store.page(userId, parse(pageSchema, query));
        } else if (/^\/v1\/agent\/snapshots\/[^/]+$/.test(path)) {
          const id = path.split('/').at(-1); data = store.snapshot(userId, id === 'latest' ? undefined : parse(idSchema, id));
        } else throw new ServiceError('NOT_FOUND', '只读接口不存在。', 404);
      } else if (path === '/v1/ui/context' && method === 'GET') {
        if (!localControl || principal.userId !== localControl.userId || request.headers['x-local-ui'] !== '1') throw new ServiceError('LOCAL_UI_REQUIRED', '请通过 npm run desktop 启动当前设备的操作界面。', 403);
        data = { state: store.status(userId), local: await localControl.status(), syncPlan: store.syncPlan(userId), readers: store.readers(userId) };
      } else if (path === '/v1/ui/login' && method === 'POST') {
        if (!localControl || request.headers['x-local-ui'] !== '1') throw new ServiceError('LOCAL_UI_REQUIRED', '登录需在采集设备的图形界面完成。', 403);
        data = await localControl.login(parse(localConsentSchema, await body())); status = 202;
      } else if (path === '/v1/ui/login' && method === 'DELETE') {
        if (!localControl || request.headers['x-local-ui'] !== '1') throw new ServiceError('LOCAL_UI_REQUIRED', '此操作仅在本机界面可用。', 403);
        data = await localControl.cancelLogin();
      } else if (path === '/v1/ui/consent' && ['POST', 'DELETE'].includes(method)) {
        if (!localControl || request.headers['x-local-ui'] !== '1') throw new ServiceError('LOCAL_UI_REQUIRED', '采集同意需由本人在本机确认。', 403);
        data = method === 'POST' ? await localControl.authorize(parse(localConsentSchema, await body())) : await localControl.revoke();
      } else if (path === '/v1/ui/stop' && method === 'POST') {
        if (!localControl || request.headers['x-local-ui'] !== '1') throw new ServiceError('LOCAL_UI_REQUIRED', '此操作仅在本机界面可用。', 403);
        parse(empty, await body()); data = await localControl.stopSync();
      } else if (path === '/v1/ui/data' && method === 'DELETE') {
        if (!localControl || request.headers['x-local-ui'] !== '1') throw new ServiceError('LOCAL_UI_REQUIRED', '此操作仅在本机界面可用。', 403);
        parse(z.object({ confirm: z.literal(true) }).strict(), await body()); data = await localControl.clearData();
      } else if (path === '/v1/sync-plan' && method === 'GET') data = store.syncPlan(userId);
      else if (path === '/v1/sync-plan' && method === 'PUT') data = store.syncPlan(userId, parse(syncPlanSchema, await body()));
      else if (path === '/v1/readers' && method === 'GET') data = store.readers(userId);
      else if (path === '/v1/readers' && method === 'POST') { const input = parse(z.object({ label: z.string().trim().min(1).max(80) }).strict(), await body()); data = store.createReader(userId, input.label); }
      else if (/^\/v1\/readers\/[^/]+$/.test(path) && method === 'DELETE') data = store.revokeReader(userId, parse(idSchema, path.split('/').at(-1)));
      else if (!worker && path === '/v1/status' && method === 'GET') data = store.status(userId);
      else if (!worker && path === '/v1/settings' && method === 'GET') data = store.settings(userId);
      else if (!worker && path === '/v1/settings' && method === 'PUT') data = store.settings(userId, parseSettings(await body()));
      else if (!worker && path === '/v1/jobs' && method === 'POST') { data = store.createJob(userId, parse(createJobSchema, await body())); status = 202; }
      else if (!worker && userJob) {
        const id = parse(idSchema, userJob[1]);
        if (method === 'GET' && !userJob[2]) data = store.job(userId, id);
        else if (method === 'DELETE' && !userJob[2]) data = store.cancel(userId, id);
        else if (method === 'POST' && userJob[2]) { parse(empty, await body()); data = store.keepalive(userId, id); }
        else throw new ServiceError('NOT_FOUND', '接口不存在。', 404);
      } else if (!worker && /^\/v1\/snapshots\/[^/]+$/.test(path) && method === 'GET') {
        const id = path.split('/').at(-1); data = store.snapshot(userId, id === 'latest' ? undefined : parse(idSchema, id));
      } else if (!worker && path === '/v1/records' && method === 'GET') {
        const query = Object.fromEntries(url.searchParams);
        for (const key of ['offset', 'limit', 'summaryMaxChars', 'bodyMaxChars']) if (Object.hasOwn(query, key)) query[key] = /^\d+$/.test(query[key]) ? Number(query[key]) : NaN;
        data = store.page(userId, parse(pageSchema, query));
      } else if (!worker && path === '/v1/data' && method === 'DELETE') { parse(z.object({ confirm: z.literal(true) }).strict(), await body()); data = store.clear(userId); }
      else if (worker && path === '/v1/worker/info' && method === 'GET') data = { userId, deviceId: principal.deviceId, demo: store.demo };
      else if (worker && path === '/v1/worker/claim' && method === 'POST') { parse(empty, await body()); data = store.claim(principal); }
      else if (worker && workerJob && method === 'POST') {
        const id = parse(idSchema, workerJob[1]); const action = workerJob[2]; const input = await body();
        if (action === 'heartbeat') data = store.heartbeat(principal, id, parse(lease, input).leaseToken);
        else if (action === 'complete') data = store.complete(principal, id, parse(uploadSchema, input));
        else { const value = parse(failed, input); data = store.fail(principal, id, value.leaseToken, value.code); }
      } else throw new ServiceError('NOT_FOUND', '接口不存在。', 404);
      send(status, { schemaVersion: 1, ok: true, data, error: null });
    } catch (error) { const safe = safeError(error); send(safe.status, { schemaVersion: 1, ok: false, data: null, error: { code: safe.code, message: safe.message } }); }
  });
  server.requestTimeout = 120_000; server.headersTimeout = 15_000;
  const sweepTimer = setInterval(() => store.sweep(), 1000); sweepTimer.unref(); server.once('close', () => clearInterval(sweepTimer));
  return server;
}
