// 把 data-collection-service 作为本机组件嵌进图形界面。
//
// 这里只做两件事：
// - 用它的 desktop 入口拉起 API 服务 + 本机采集器（登录窗口、浏览器、SQLite 都在它内部）；
// - 把它的能力收敛成一组函数，供 web.mjs 的路由直接调用。
//
// 权限边界保持原样，不做任何放宽：
// - 登录、同意、撤回、清除本机数据只能走它的 /v1/ui/*，那条路径要求回环 + 同源 + 本地控制模式，
//   本文件以本机进程身份带上 X-Local-UI 才调用，服务端的三重校验仍然生效。
// - Agent 侧只用 store.createReader 签发的 agt_ 只读令牌，拿不到同步、登录、改设置的能力。
import { startDesktop } from '../data-collection-service/desktop.mjs';

// 内置入口的固定名称：每次启动先撤销旧的同名入口再新建，避免 service_readers 越积越多。
export const BUILTIN_READER_LABEL = '图表面板（自动管理）';

export async function startCollection({ demo = false, port = 3005, profile = 'default', dataDir, signal, log = () => {} } = {}) {
  const app = await startDesktop({ demo, port, profile, dataDir, signal, log });
  const { baseUrl, store, userId } = app;

  // 本机界面调用：必须带 X-Local-UI；带 Origin 才能通过同源校验（服务端以此判断"是同一个页面"）。
  async function uiRequest(method, path, body) {
    const headers = { 'x-local-ui': '1', origin: baseUrl };
    const init = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(new URL(path, baseUrl), init);
    const payload = await response.json().catch(() => null);
    if (!payload) throw new Error(`采集服务返回了无法解析的响应（HTTP ${response.status}）`);
    if (!payload.ok) {
      const error = new Error(payload.error?.message ?? '采集服务返回错误');
      error.code = payload.error?.code;
      throw error;
    }
    return payload.data;
  }

  let reader = null; // { readerId, token }

  const collection = {
    baseUrl,
    userId,
    store,

    // ===== 本机界面能力（/v1/ui/*）=====
    localContext: () => uiRequest('GET', '/v1/ui/context'),
    login: (input) => uiRequest('POST', '/v1/ui/login', input),
    cancelLogin: () => uiRequest('DELETE', '/v1/ui/login'),
    authorize: (input) => uiRequest('POST', '/v1/ui/consent', input),
    revokeConsent: () => uiRequest('DELETE', '/v1/ui/consent'),
    stop: () => uiRequest('POST', '/v1/ui/stop', {}),
    clearLocal: () => uiRequest('DELETE', '/v1/ui/data', { confirm: true }),

    // ===== 用户数据（直接走同一个 store，等价于 /v1/* 的实现）=====
    status: () => store.status(userId),
    settings: (value) => store.settings(userId, value),
    plan: (value) => store.syncPlan(userId, value),
    records: (query) => store.page(userId, query),
    exportSnapshot: () => store.snapshot(userId, undefined),
    createJob: (settings) => store.createJob(userId, settings ? { settings } : undefined),
    job: (id) => store.job(userId, id),
    cancelJob: (id) => store.cancel(userId, id),
    keepalive: (id) => store.keepalive(userId, id),
    clearServer: () => store.clear(userId),

    // ===== Agent 只读入口 =====
    readers: () => store.readers(userId),
    createReader: (label) => store.createReader(userId, label),
    revokeReader: (id) => store.revokeReader(userId, id),

    // 保证内置入口存在且令牌可用：令牌只在内存里，进程重启会重新签发。
    async ensureReader() {
      if (reader) return reader;
      for (const item of store.readers(userId)) {
        if (item.label === BUILTIN_READER_LABEL) {
          try { store.revokeReader(userId, item.readerId); } catch { /* 已被撤销则忽略 */ }
        }
      }
      const created = store.createReader(userId, BUILTIN_READER_LABEL);
      reader = { readerId: created.readerId, token: created.agentToken };
      return reader;
    },

    // 用户撤销了内置入口时清空缓存，下次提问会重新签发。
    forgetReaderIf(id) {
      if (reader && reader.readerId === id) reader = null;
    },

    get readerId() { return reader?.readerId ?? null; },
    close: () => app.close(),
  };
  return collection;
}
