// 纯 Web API，可用于浏览器、Node.js、桌面壳和移动端 JavaScript 宿主。
export class ApiError extends Error {
  constructor(code, message, status = 0) { super(message); this.name = 'ApiError'; this.code = code; this.status = status; }
}
export function validateServiceUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new ApiError('INVALID_URL', '服务 URL 必须为 HTTPS 来源；本机或私有局域网开发可使用 HTTP。');
  return url.origin;
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted(); const stop = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  signal?.addEventListener('abort', stop, { once: true });
});
export function createApiClient({ baseUrl, token, fetchImpl = globalThis.fetch } = {}) {
  const base = validateServiceUrl(baseUrl);
  if (typeof token !== 'string' || !/^(usr|dev)_[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError('NOT_CONFIGURED', '需要宿主提供用户或设备凭证。');
  const request = async (path, { method = 'GET', body, signal } = {}) => {
    let response;
    try { response = await fetchImpl(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]), redirect: 'error', credentials: 'omit' }); }
    catch (error) { if (signal?.aborted) throw signal.reason; throw new ApiError('NETWORK_ERROR', '无法连接采集服务，或请求超时。'); }
    let result; try { result = await response.json(); } catch { throw new ApiError('INVALID_RESPONSE', '服务没有返回预期 JSON。', response.status); }
    if (!response.ok || result.ok !== true) throw new ApiError(result.error?.code || 'SERVER_ERROR', result.error?.message || '采集服务请求失败。', response.status);
    return result.data;
  };
  const client = {
    request,
    status: (options) => request('/v1/status', options),
    settings: (options) => request('/v1/settings', options),
    saveSettings: (body, options) => request('/v1/settings', { ...options, method: 'PUT', body }),
    createJob: (body = {}, options) => request('/v1/jobs', { ...options, method: 'POST', body }),
    job: (id, options) => request(`/v1/jobs/${encodeURIComponent(id)}`, options),
    cancel: (id, options) => request(`/v1/jobs/${encodeURIComponent(id)}`, { ...options, method: 'DELETE' }),
    keepalive: (id, options) => request(`/v1/jobs/${encodeURIComponent(id)}/keepalive`, { ...options, method: 'POST', body: {} }),
    read: (id = 'latest', options) => request(`/v1/snapshots/${encodeURIComponent(id)}`, options),
    readPage: (query = {}, options) => request(`/v1/records?${new URLSearchParams(query)}`, options),
    async sync({ settings, deviceId, timeoutMs = 300_000, pollMs = 2000, signal, fullSnapshot = true } = {}) {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 900_000 || !Number.isInteger(pollMs) || pollMs < 10 || pollMs > 5000) throw new ApiError('INVALID_ARGUMENTS', '同步时限或轮询间隔无效。');
      const active = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
      let job; let done = false;
      try {
        job = await client.createJob({ ...(settings ? { settings } : {}), ...(deviceId ? { deviceId } : {}) }, { signal: active });
        while (true) {
          active.throwIfAborted(); job = await client.keepalive(job.id, { signal: active });
          if (job.state === 'succeeded') { done = true; return fullSnapshot ? await client.read(job.snapshotId, { signal: active }) : job; }
          if (['failed', 'cancelled'].includes(job.state)) { done = true; throw new ApiError(job.error?.code || 'COLLECTION_FAILED', job.error?.message || '采集未完成。'); }
          await sleep(pollMs, active);
        }
      } finally { if (job && !done) await client.cancel(job.id, { signal: AbortSignal.timeout(5000) }).catch(() => {}); }
    },
  };
  return client;
}

// 页面结束即主动取消；断电等无法发送取消的情况由服务端调用方租约兜底。
export function startPageSync({ client, intervalMs = 300_000, settings, deviceId, onData = () => {}, onError = () => {}, signal, lifecycle = globalThis.window } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1000) throw new ApiError('INVALID_ARGUMENTS', '同步间隔至少 1000 毫秒。');
  const controller = new AbortController(); const active = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  const stop = () => controller.abort(); lifecycle?.addEventListener('pagehide', stop, { once: true });
  const done = (async () => {
    try {
      while (!active.aborted) {
        try { const result = await client.sync({ settings, deviceId, signal: active }); if (!active.aborted) await onData(result); }
        catch (error) { if (active.aborted) break; await onError(error); }
        await sleep(intervalMs, active);
      }
    } catch (error) { if (!active.aborted) throw error; }
    finally { lifecycle?.removeEventListener('pagehide', stop); }
  })();
  return { stop, done };
}
