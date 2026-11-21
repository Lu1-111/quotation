import { createServer } from 'node:http';
import * as z from 'zod/v4';
import { createJobSchema, pageSchema, parse, parseSettings, uploadSchema } from './contracts.mjs';
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

export function createApiServer({ store, publicOrigin = 'http://127.0.0.1:3005', allowedOrigins = [], maxBodyBytes = 32 * 1024 * 1024 } = {}) {
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
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS'); response.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
        response.writeHead(204); response.end(); return;
      }
      const url = new URL(request.url, canonical); const path = url.pathname;
      if (path === '/health' && request.method === 'GET') { send(200, { schemaVersion: 1, ok: true, data: { service: 'data-collection-service', demo: store.demo } }); return; }
      const worker = path.startsWith('/v1/worker/');
      const header = request.headers.authorization;
      const principal = store.authenticate(typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null, worker ? 'device' : 'user');
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
      if (!worker && path === '/v1/status' && method === 'GET') data = store.status(userId);
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
        for (const key of ['offset', 'limit', 'summaryMaxChars']) if (Object.hasOwn(query, key)) query[key] = /^\d+$/.test(query[key]) ? Number(query[key]) : NaN;
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
