// 增量同步与详情缓存的单元测试：用假网关直接驱动采集核心，不启动浏览器、不连接知乎。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHistoryStore } from '../local/lib/history-data.mjs';
import { collectSelectedData } from '../local/lib/zhihu-sources.mjs';

const SETTINGS = Object.freeze({ history: true, likes: false, collections: false, knowledgeFilter: false, fetchFullText: false, aiReview: false });
const NOW = 1_760_000_000;

// 构造列表接口返回的一条历史记录。
function historyItem({ id, title, readTime, type = 'answer' }) {
  return {
    data: {
      header: { title },
      content: { summary: `${title} 摘要`, author_name: '测试作者' },
      extra: { content_token: id, content_type: type, read_time: readTime },
      action: { url: `https://www.zhihu.com/${type}/${id}` },
    },
  };
}

function detailFor(id, { votes = 10, comments = 3 } = {}) {
  return {
    id,
    content: `<p>${id} 的正文</p>`,
    excerpt: `${id} 摘要`,
    voteup_count: votes,
    comment_count: comments,
    question: { topics: [{ id: 'topic-1', name: '人工智能' }] },
  };
}

// 假网关：记录每一次请求，便于断言"有没有重复爬取"。
function fakeGateway({ pages, details }) {
  const calls = [];
  return {
    calls,
    pageRequests: () => calls.filter((path) => path.startsWith('/api/v4/unify-consumption/read_history')),
    detailRequests: () => calls.filter((path) => !path.startsWith('/api/v4/unify-consumption/read_history')),
    async request(path) {
      calls.push(path);
      if (path.startsWith('/api/v4/unify-consumption/read_history')) {
        const offset = new URL(path, 'https://www.zhihu.com').searchParams.get('offset');
        const page = pages[offset];
        if (!page) throw new Error(`没有预置 offset=${offset} 的分页`);
        return page;
      }
      const matched = path.match(/\/(?:answers|pins)\/([^?/]+)/) || path.match(/articles\/([^?/]+)/);
      const id = matched ? decodeURIComponent(matched[1]) : null;
      const detail = details[id];
      if (!detail) throw new Error(`没有预置 ${id} 的详情`);
      return detail;
    },
  };
}

function makeStore() {
  const db = new DatabaseSync(':memory:');
  const store = createHistoryStore(db);
  store.create('src-1');
  store.consent('src-1');
  return store;
}

async function collect(store, gateway, { previous, ttlMs } = {}) {
  const requests = { pause: 0 };
  const records = await collectSelectedData(gateway, { id: 'me', slug: 'me' }, SETTINGS, {
    checkActive() {},
    pause: async () => { requests.pause += 1; },
    progress() {},
    cache: {
      get: (key) => store.cachedDetail('src-1', key, ttlMs),
      set: (key, payload) => store.saveDetail('src-1', key, payload),
    },
    previous,
  });
  return { records, pauses: requests.pause };
}

describe('详情缓存', () => {
  it('第一次采集会为每条记录取详情并写入缓存', async () => {
    const store = makeStore();
    const gateway = fakeGateway({
      pages: { 0: { data: [historyItem({ id: 'a1', title: '第一条', readTime: NOW })], paging: { is_end: true } } },
      details: { a1: detailFor('a1') },
    });
    const { records, pauses } = await collect(store, gateway);
    assert.equal(records.length, 1);
    assert.equal(gateway.pageRequests().length, 1);
    assert.equal(gateway.detailRequests().length, 1);
    assert.equal(pauses, 1, '每取一次详情等待一次');
    assert.ok(store.cachedDetail('src-1', 'answer:a1'), '详情应已进缓存');
  });

  it('缓存命中时不再请求详情，也不产生节流等待', async () => {
    const store = makeStore();
    store.saveDetail('src-1', 'answer:a1', detailFor('a1'));
    const gateway = fakeGateway({
      pages: { 0: { data: [historyItem({ id: 'a1', title: '第一条', readTime: NOW })], paging: { is_end: true } } },
      details: {},
    });
    const { records, pauses } = await collect(store, gateway);
    assert.equal(records.length, 1);
    assert.equal(gateway.detailRequests().length, 0, '不应再取详情');
    assert.equal(pauses, 0, '不应再等待');
    assert.equal(records[0].voteCount, 10, '缓存里的指标要能补回记录');
  });

  it('缓存过期后重新取详情', async () => {
    const store = makeStore();
    store.saveDetail('src-1', 'answer:a1', detailFor('a1'));
    const gateway = fakeGateway({
      pages: { 0: { data: [historyItem({ id: 'a1', title: '第一条', readTime: NOW })], paging: { is_end: true } } },
      details: { a1: detailFor('a1', { votes: 99 }) },
    });
    const { records } = await collect(store, gateway, { ttlMs: -1 });
    assert.equal(gateway.detailRequests().length, 1);
    assert.equal(records[0].voteCount, 99);
  });
});

describe('增量同步', () => {
  it('带上上次记录时，已采集的条目直接复用，不再取详情', async () => {
    const store = makeStore();
    const first = await collect(store, fakeGateway({
      pages: { 0: { data: [historyItem({ id: 'a1', title: '第一条', readTime: NOW })], paging: { is_end: true } } },
      details: { a1: detailFor('a1') },
    }));
    // 第二次：同样的列表，但把上次结果作为 previous 传入，且不给任何详情。
    const gateway = fakeGateway({
      pages: { 0: { data: [historyItem({ id: 'a1', title: '第一条', readTime: NOW })], paging: { is_end: true } } },
      details: {},
    });
    const second = await collect(store, gateway, { previous: { records: first.records } });
    assert.equal(gateway.detailRequests().length, 0);
    assert.equal(second.pauses, 0);
    assert.equal(second.records.length, 1);
    assert.equal(second.records[0].contentId, 'a1');
  });

  it('扫到上一次的边界就停，比边界更早的分页不再取', async () => {
    const store = makeStore();
    const previous = [{
      key: 'answer:old2', kind: 'history', contentId: 'old2', contentType: 'answer', title: '旧二', summary: '旧二 摘要',
      author: '测试作者', url: null, sourceReadTime: String(NOW - 2000), voteCount: 10, commentCount: 3, topics: [],
    }];
    // 第二页全是比边界更早的旧记录，正常情况下不该去 enrich 它们。
    const gateway = fakeGateway({
      pages: {
        0: {
          data: [historyItem({ id: 'new1', title: '新一', readTime: NOW })],
          paging: { is_end: false, next: '/api/v4/unify-consumption/read_history?offset=1&limit=50' },
        },
        1: {
          data: [historyItem({ id: 'old1', title: '旧一', readTime: NOW - 5000 })],
          paging: { is_end: false, next: '/api/v4/unify-consumption/read_history?offset=2&limit=50' },
        },
      },
      details: { new1: detailFor('new1') },
    });
    const { records } = await collect(store, gateway, { previous: { records: previous } });
    const offsets = gateway.pageRequests().map((path) => new URL(path, 'https://www.zhihu.com').searchParams.get('offset'));
    assert.deepEqual(offsets, ['0', '1'], '取到边界所在的那一页就该停，不再翻页');
    assert.equal(gateway.detailRequests().length, 1, '只给新记录取详情');
    assert.deepEqual(records.map((record) => record.contentId).sort(), ['new1', 'old2'], '新记录与上次的旧记录都要在窗口里');
  });

  it('上次被排除的条目保留在审计列表，不再取详情也不占窗口', async () => {
    const store = makeStore();
    const previous = [{
      key: 'answer:bad1', kind: 'history', contentId: 'bad1', contentType: 'answer', title: '猎奇标题', summary: '无实质信息',
      author: '', url: null, sourceReadTime: String(NOW - 3000), voteCount: 10, commentCount: 3, topics: [],
      analysis: { decision: 'exclude', method: 'rules', reason: '猎奇叙事' },
    }];
    // 列表里仍然会出现被排除的那条：它应该被直接复用，而不是重新取详情。
    const gateway = fakeGateway({
      pages: {
        0: {
          data: [
            historyItem({ id: 'a1', title: '第一条', readTime: NOW }),
            historyItem({ id: 'bad1', title: '猎奇标题', readTime: NOW - 3000 }),
          ],
          paging: { is_end: true },
        },
      },
      details: { a1: detailFor('a1') },
    });
    const { records } = await collect(store, gateway, { previous: { records: previous } });
    assert.equal(gateway.detailRequests().length, 1, '只给新记录取详情，被排除的复用旧结果');
    const excluded = records.find((record) => record.contentId === 'bad1');
    assert.ok(excluded, '被排除的条目应保留供审计');
    assert.equal(excluded.analysis.decision, 'exclude');
    assert.equal(records.filter((record) => record.analysis?.decision !== 'exclude').length, 1, '窗口里只应有一条正文记录');
  });

  it('没有上次记录时行为与原来一致（全量扫描）', async () => {
    const store = makeStore();
    const gateway = fakeGateway({
      pages: {
        0: {
          data: [historyItem({ id: 'a1', title: '一', readTime: NOW }), historyItem({ id: 'a2', title: '二', readTime: NOW - 1 })],
          paging: { is_end: true },
        },
      },
      details: { a1: detailFor('a1'), a2: detailFor('a2') },
    });
    const { records } = await collect(store, gateway);
    assert.equal(records.length, 2);
    assert.equal(gateway.detailRequests().length, 2);
  });
});
