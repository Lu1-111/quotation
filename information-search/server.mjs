import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOfficialClient, createDemoClient, SearchError } from './official-client.mjs';
import { createSearchStore } from './store.mjs';
import { createInformationSearch } from './search.mjs';
import { toMarkdown } from './report.mjs';

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']],
].map(([route, [name, type]]) => [route, { type, body: readFileSync(new URL(`./public/${name}`, import.meta.url)) }]));

export function createSearchHttpServer({ origin, service, store, configured, demo = false }) {
  const expected = new URL(origin);
  const active = new Set();
  const json = (res, status, data) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); } };
  async function body(req) {
    const parts = []; let size = 0;
    for await (const part of req) { size += part.length; if (size > 16_384) throw new SearchError('请求内容过大。', 413, 'BODY_TOO_LARGE'); parts.push(part); }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new SearchError('请求不是有效 JSON。', 400, 'INVALID_JSON'); }
  }
  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (req.headers.host !== expected.host) return json(res, 400, { error: '请求主机无效。', code: 'INVALID_HOST' });
    const url = new URL(req.url, expected);
    if (url.origin !== expected.origin) return json(res, 400, { error: '请求地址无效。', code: 'INVALID_ORIGIN' });
    if (req.method === 'POST' && req.headers.origin !== expected.origin) return json(res, 403, { error: '请求来源无效。', code: 'INVALID_ORIGIN' });
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { configured, demo, capabilities: { keywordSearch: true, localTagTextMatching: true, platformTopicFilter: false, pagination: false }, perQueryLimit: 10, maxQueries: 6 });
    if (req.method === 'POST' && url.pathname === '/api/search') {
      if (active.size) return json(res, 409, { error: '已有搜索正在执行，请稍后再试。', code: 'BUSY' });
      const input = await body(req);
      if (!input || typeof input !== 'object' || Array.isArray(input) || !input.criteria || (input.refresh !== undefined && typeof input.refresh !== 'boolean')
        || Object.keys(input).some((key) => !['criteria', 'refresh'].includes(key))) throw new SearchError('请提供 criteria 对象和可选的 refresh 布尔值。', 400, 'INVALID_CRITERIA');
      if (active.size) return json(res, 409, { error: '已有搜索正在执行，请稍后再试。', code: 'BUSY' });
      const controller = new AbortController(); active.add(controller);
      const cancel = () => { if (!res.writableEnded) controller.abort(new Error('搜索页面已关闭或请求已取消。')); };
      res.on('close', cancel); req.on('aborted', cancel);
      try { return json(res, 200, await service.search(input.criteria, { signal: controller.signal, refresh: input.refresh ?? false })); }
      finally { active.delete(controller); res.off('close', cancel); req.off('aborted', cancel); }
    }
    if (req.method === 'GET' && ['/api/results', '/api/export'].includes(url.pathname)) {
      const id = url.searchParams.get('id');
      if (id && !/^[a-f0-9-]{36}$/i.test(id)) throw new SearchError('结果标识格式不正确。', 400, 'INVALID_ID');
      const snapshot = store.get(id);
      if (!snapshot) return json(res, 404, { error: '尚无对应搜索结果。', code: 'NOT_FOUND' });
      if (url.pathname === '/api/results') return json(res, 200, snapshot);
      const format = url.searchParams.get('format') || 'json';
      if (!['json', 'markdown'].includes(format)) throw new SearchError('导出格式仅支持 json 或 markdown。', 400, 'INVALID_FORMAT');
      res.setHeader('Content-Disposition', `attachment; filename="zhihu-search-${snapshot.requestId}.${format === 'json' ? 'json' : 'md'}"`);
      res.writeHead(200, { 'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8' });
      return res.end(format === 'json' ? JSON.stringify(snapshot, null, 2) : toMarkdown(snapshot));
    }
    const file = req.method === 'GET' && staticFiles.get(url.pathname);
    if (file) { res.writeHead(200, { 'Content-Type': file.type }); return res.end(file.body); }
    return json(res, 404, { error: '接口或页面不存在。', code: 'NOT_FOUND' });
  }
  const server = createServer((req, res) => handle(req, res).catch((error) => {
    if (res.headersSent || res.destroyed) return res.destroy();
    json(res, error instanceof SearchError ? error.status : 500, { error: error instanceof SearchError ? error.message : '搜索未完成，请稍后重试。', code: error instanceof SearchError ? error.code : 'INTERNAL_ERROR' });
  }));
  server.on('close', () => { for (const controller of active) controller.abort(); });
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const demo = process.argv.includes('--demo');
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3002);
  const origin = new URL(process.env.APP_ORIGIN || `http://127.0.0.1:${port}`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
    || origin.protocol !== 'http:' || origin.href !== `${origin.origin}/` || Number(origin.port || 80) !== port) throw new Error('信息搜索模块仅支持匹配端口的本机 HTTP 地址。');
  const store = createSearchStore(process.env.DATA_FILE || (demo ? '.data/demo.sqlite' : '.data/search.sqlite'));
  const client = demo ? createDemoClient() : createOfficialClient({ accessSecret: process.env.ZHIHU_ACCESS_SECRET });
  const service = createInformationSearch({ client, store, demo });
  createSearchHttpServer({ origin: origin.origin, service, store, configured: client.configured, demo }).listen(port, host, () => {
    console.log(`知乎信息搜索${demo ? '（演示）' : ''} ${origin.origin}`);
  });
}
