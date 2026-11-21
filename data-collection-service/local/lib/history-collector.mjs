import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HistoryError, parseHistoryJson } from './history-data.mjs';
import { collectSelectedData } from './zhihu-sources.mjs';
import { validateSettings } from './record-ranking.mjs';
import { hasSelectedKinds } from './content-policy.mjs';

export function createBrowserGateway(profileDirectory, channel = 'msedge') {
  let context;
  let page;
  return {
    get active() { return Boolean(context && page && !page.isClosed()); },
    async open({ headless = false } = {}) {
      if (context && page && !page.isClosed()) {
        if (!headless) await page.bringToFront();
        return;
      }
      if (context) await context.close();
      await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
      try {
        const { chromium } = await import('playwright-core');
        context = await chromium.launchPersistentContext(profileDirectory, {
          channel, headless, acceptDownloads: false, viewport: { width: 1100, height: 800 },
        });
        const opened = context;
        opened.on('close', () => {
          if (context === opened) { context = null; page = null; }
        });
        page = context.pages()[0] || await context.newPage();
        await page.goto('https://www.zhihu.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch {
        await context?.close().catch(() => {});
        context = null;
        page = null;
        throw new HistoryError('打开知乎失败，请确认本机已安装 Edge，或检查网络后重试。', 503);
      }
    },
    async request(path, { optional = false } = {}) {
      if (!context || !page || page.isClosed()) throw new HistoryError('请先打开专用浏览器并登录知乎。', 409);
      const target = new URL(path, 'https://www.zhihu.com');
      if (target.protocol !== 'https:' || !['www.zhihu.com', 'api.zhihu.com', 'zhuanlan.zhihu.com'].includes(target.hostname)) {
        throw new HistoryError('采集地址无效。', 400);
      }
      let result;
      try {
        if (target.hostname === 'www.zhihu.com') {
          result = await page.evaluate(async (requestPath) => {
            if (location.origin !== 'https://www.zhihu.com') return { status: 401 };
            const response = await fetch(requestPath, {
              credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(15_000),
            });
            return { status: response.status, body: await response.text() };
          }, `${target.pathname}${target.search}`);
        } else {
          const response = await context.request.get(target.href, {
            timeout: 15_000, maxRedirects: 0,
            headers: { Referer: `${target.origin}/`, Accept: 'application/json' },
          });
          result = { status: response.status(), body: await response.text() };
          await response.dispose();
        }
      } catch {
        throw new HistoryError('知乎请求失败，请检查专用窗口中的登录状态和网络。');
      }
      if (optional && [403, 404, 410].includes(result.status)) {
        throw new HistoryError('这条内容的详情暂时不可用。', result.status);
      }
      if ([401, 403].includes(result.status)) {
        throw new HistoryError('知乎要求重新登录或验证，请在专用窗口中亲自完成后重试。', 401);
      }
      if (result.status === 429) throw new HistoryError('知乎暂时限流，已保留上次同步结果。', 429);
      if (result.status !== 200 || !result.body || result.body.length > 4_000_000) {
        throw new HistoryError('知乎返回了非预期的历史数据响应。');
      }
      try {
        return parseHistoryJson(result.body);
      } catch {
        throw new HistoryError('知乎返回页面或验证信息，请检查专用窗口后重试。', 401);
      }
    },
    async close() {
      const closing = context;
      context = null;
      page = null;
      await closing?.close().catch(() => {});
    },
  };
}

export function createDemoHistoryGateway() {
  let active = false;
  return {
    get active() { return active; },
    async open() { active = true; },
    async close() { active = false; },
    async request(path) {
      if (!active) throw new HistoryError('请先连接演示数据。', 409);
      if (path === '/api/v4/me') return { id: 'demo-history', url_token: 'demo-reader', name: '演示读者' };
      const now = Math.floor(Date.now() / 1000);
      const posts = [
        { id: '101', type: 'answer', question: { title: '本地大模型推理如何加速', topics: [{ id: 'ai', name: '人工智能' }] }, excerpt: '比较推理框架和硬件配置。', voteup_count: 24, comment_count: 5 },
        { id: '102', type: 'article', title: '本地大模型部署实践', topics: [{ id: 'ai', name: '人工智能' }], excerpt: '从模型选择到部署。', voteup_count: 12, comment_count: 3 },
        { id: '103', type: 'pin', title: '阅读笔记的整理方法', topics: [{ id: 'notes', name: '笔记' }], excerpt: '保留观点与原文链接。', like_count: 2, comment_count: 1 },
        { id: '104', type: 'answer', question: { title: '低互动示例' }, voteup_count: 0, comment_count: 0 },
      ];
      if (path.includes('/unify-consumption/read_history')) return {
        data: [...posts.map((post, index) => ({ data: {
          header: { title: post.title || post.question.title }, content: { ...post, summary: post.excerpt, author_name: '演示作者' },
          extra: { content_token: post.id, content_type: post.type, read_time: now - [1, 9, 16, 1][index] * 86400 },
        } })), { data: { header: { title: '主页示例' }, extra: { content_token: 'someone', content_type: 'profile', read_time: now } } }],
        paging: { is_end: true },
      };
      if (path.includes('/activities')) return { data: [{ verb: 'ANSWER_VOTE_UP', target: posts[0], created_time: now - 30 * 86400 }], paging: { is_end: true } };
      if (path.includes('/people/') && path.includes('/collections')) return { data: [{ id: 'sample-list' }], paging: { is_end: true } };
      if (path.includes('/collections/sample-list/items')) return { data: [{ content: posts[1], created: new Date().toISOString() }], paging: { is_end: true } };
      const id = new URL(path, 'https://www.zhihu.com').pathname.split('/').pop();
      const post = posts.find((post) => post.id === id);
      if (post) return post;
      throw new HistoryError('演示接口不存在。', 404);
    },
  };
}

export function createHistoryCollector(store, { directory, channel, gatewayFactory, contentAgent, pageDelay = 1000, isPageActive = () => false } = {}) {
  const workers = new Map();
  const interval = 5 * 60_000;

  function workerFor(id) {
    let worker = workers.get(id);
    if (!worker) {
      worker = {
        gateway: gatewayFactory ? gatewayFactory(id) : createBrowserGateway(join(directory, id), channel),
        epoch: 0, job: null, opening: null, stopping: null,
        lastAttempt: Date.parse(store.get(id)?.last_synced_at) || 0, fetched: 0, stage: null,
      };
      workers.set(id, worker);
    }
    return worker;
  }

  async function account(gateway) {
    const profile = await gateway.request('/api/v4/me');
    const id = profile?.id ?? profile?.url_token;
    if (typeof id !== 'string' || !id || profile.error) {
      throw new HistoryError('请先在专用窗口中登录知乎，再开始同步。', 401);
    }
    return { id, slug: profile.url_token || id, nickname: typeof profile.name === 'string' ? profile.name : '' };
  }

  async function sync(id, autoSync = false) {
    const source = store.get(id);
    if (!source?.consented_at) throw new HistoryError('请先同意采集并连接知乎。', 403);
    const settings = store.settings(id);
    if (!hasSelectedKinds(settings)) throw new HistoryError('请先在设置中勾选要获取的信息种类。', 400);
    if (!isPageActive(id)) throw new HistoryError('仅在应用网页保持连接时允许同步，请打开同步页面。', 409);
    const worker = workerFor(id);
    if (worker.stopping) throw new HistoryError('网页断开后的任务正在停止，请稍后重试。', 409);
    if (worker.job) return worker.job;
    if (worker.opening) throw new HistoryError('专用浏览器正在打开，请稍后同步。', 409);
    const epoch = worker.epoch;
    const checkActive = () => {
      if (worker.epoch !== epoch || !store.get(id)?.consented_at || !isPageActive(id)) throw new HistoryError('同步已暂停。', 409);
    };
    worker.fetched = 0;
    worker.lastAttempt = Date.now();
    worker.job = (async () => {
      try {
        await worker.gateway.open({ headless: true });
        checkActive();
        const owner = await account(worker.gateway);
        if (source.account_id && source.account_id !== owner.id) {
          throw new HistoryError('专用窗口当前账号与已绑定账号不一致，请登录原账号后再同步。', 409);
        }
        const fetchedCounts = {};
        const runAnalysis = contentAgent?.createRun();
        const items = await collectSelectedData(worker.gateway, owner, settings, {
          checkActive,
          analyze: runAnalysis ? (record) => runAnalysis(record, { checkActive,
            cached: (hash) => store.cachedReview(id, hash), save: (hash, analysis) => store.saveReview(id, hash, analysis) }) : undefined,
          pause: async () => { checkActive(); if (pageDelay > 0) await delay(pageDelay); checkActive(); },
          progress(kind, count) {
            if (kind !== 'analysis') fetchedCounts[kind] = count;
            worker.stage = kind;
            worker.fetched = Object.values(fetchedCounts).reduce((sum, value) => sum + value, 0);
          },
        });
        const after = await account(worker.gateway);
        if (owner.id !== after.id) throw new HistoryError('同步期间知乎账号发生变化，请确认账号后重试。', 409);
        checkActive();
        store.save(id, after, items, autoSync);
      } finally {
        await worker.gateway.close();
      }
    })();
    try {
      await worker.job;
    } catch (error) {
      if (worker.epoch === epoch && isPageActive(id)) {
        store.error(id, error instanceof HistoryError ? error.message : '同步失败，请稍后重试。');
        if ([401, 403, 409].includes(error.status)) store.pause(id);
      }
      if (error instanceof HistoryError) throw error;
      throw new HistoryError('同步失败，请稍后重试。');
    } finally {
      worker.lastAttempt = Date.now();
      worker.job = null;
      worker.stage = null;
    }
  }

  return {
    interval,
    async open(id) {
      if (!isPageActive(id)) throw new HistoryError('请保持应用网页连接后再打开知乎登录。', 409);
      const worker = workerFor(id);
      if (worker.stopping) throw new HistoryError('上次采集窗口正在关闭，请稍后重试。', 409);
      if (worker.opening) return worker.opening;
      if (worker.job) throw new HistoryError('正在同步，请稍后打开知乎登录窗口。', 409);
      if (!store.get(id)?.consented_at) throw new HistoryError('请先同意采集所选的知乎信息。', 403);
      if (!hasSelectedKinds(store.settings(id))) throw new HistoryError('请先勾选要获取的信息种类。', 400);
      worker.opening = worker.gateway.open();
      try {
        await worker.opening;
        if (!isPageActive(id)) { await worker.gateway.close(); throw new HistoryError('网页已关闭，登录窗口已停止。', 409); }
      } finally { worker.opening = null; }
    },
    sync,
    configure(id, value) {
      let next;
      try { next = validateSettings(value); }
      catch (error) { throw new HistoryError(error.message, 400); }
      const worker = workers.get(id);
      if (worker) worker.epoch += 1;
      store.saveSettings(id, next);
      if (!hasSelectedKinds(next)) store.pause(id);
      return next;
    },
    status(id) {
      const worker = workers.get(id);
      const source = store.get(id);
      const snapshot = store.snapshot(id);
      const lastAttempt = worker?.lastAttempt || Date.parse(source.last_synced_at) || 0;
      const pageConnected = isPageActive(id);
      return {
        consented: Boolean(source.consented_at), browserOpen: Boolean(worker?.gateway.active),
        opening: Boolean(worker?.opening), syncing: Boolean(worker?.job), fetched: worker?.fetched || 0,
        stage: worker?.stage || null, settings: snapshot.settings, revision: snapshot.revision, counts: snapshot.counts,
        excludedCount: snapshot.excluded.length, reviewCount: snapshot.records.filter((record) => record.analysis?.decision === 'review').length,
        pageConnected, autoSync: Boolean(source.auto_sync), autoSyncActive: Boolean(source.auto_sync && pageConnected), intervalSeconds: interval / 1000,
        nextSyncAt: source.auto_sync && pageConnected ? new Date(lastAttempt + interval).toISOString() : null,
        nickname: source.nickname || '', total: store.count(id),
        lastSyncedAt: source.last_synced_at, error: source.last_error,
      };
    },
    pause(id) {
      const worker = workers.get(id);
      if (worker) worker.epoch += 1;
      store.pause(id);
    },
    async stopForClosedPage(id) {
      const worker = workers.get(id);
      if (!worker) return;
      worker.epoch += 1;
      if (worker.stopping) return worker.stopping;
      worker.stopping = (async () => {
        await worker.opening?.catch(() => {});
        await worker.gateway.close();
      })();
      try { await worker.stopping; } finally { worker.stopping = null; }
    },
    async disconnect(id) {
      this.pause(id);
      store.revoke(id);
      const worker = workers.get(id);
      if (!worker) return;
      await worker.opening?.catch(() => {});
      await worker.gateway.close();
      await worker.job?.catch(() => {});
    },
    async tick() {
      for (const source of store.automatic()) {
        if (!isPageActive(source.id)) continue;
        const worker = workerFor(source.id);
        if (worker.job || worker.opening || worker.stopping || Date.now() - worker.lastAttempt < interval) continue;
        await sync(source.id, true).catch(() => {});
      }
    },
    async close() {
      for (const id of workers.keys()) await this.disconnect(id);
    },
  };
}
