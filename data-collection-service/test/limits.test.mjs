// 采集上限与淘汰规则的单元测试：直接驱动 store，不启动浏览器、不联网。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHistoryStore } from '../local/lib/history-data.mjs';
import { PART_LIMIT, keepScore, trimToLimit } from '../local/lib/record-ranking.mjs';

const DAY = 86_400_000;

function makeStore() {
  const db = new DatabaseSync(':memory:');
  const store = createHistoryStore(db);
  store.create('src-1');
  store.consent('src-1');
  store.saveSettings('src-1', { history: true, likes: true, collections: true, knowledgeFilter: false, fetchFullText: false, aiReview: false });
  return store;
}

function item(kind, index, { votes = 0, comments = 0, agoDays = 0, type = 'answer' } = {}) {
  return {
    key: `${kind}:${type}:${index}`,
    kind,
    contentId: String(index),
    contentType: type,
    title: `${kind} ${index}`,
    summary: '摘要',
    author: '作者',
    url: null,
    sourceReadTime: kind === 'history' ? String(Math.floor(Date.now() / 1000) - index * 60) : null,
    signalTime: kind === 'history' ? null : Math.floor(Date.now() / 1000) - index * 60,
    voteCount: votes,
    commentCount: comments,
    topics: [],
    observedAt: new Date(Date.now() - agoDays * DAY).toISOString(),
  };
}

describe('淘汰分数', () => {
  it('同等条件下，权重高的分数更高', () => {
    const high = item('collections', 1, { votes: 500, comments: 50 });
    const low = item('collections', 2, { votes: 1, comments: 0 });
    assert.ok(keepScore(high) > keepScore(low));
  });

  it('同等权重下，采集时间更近的分数更高', () => {
    const fresh = item('collections', 1, { votes: 5, comments: 1, agoDays: 0 });
    const old = item('collections', 2, { votes: 5, comments: 1, agoDays: 45 });
    assert.ok(keepScore(fresh) > keepScore(old));
  });

  it('两种因素会互相权衡：很旧的高权重记录仍可能压过新的低权重记录', () => {
    const oldButGood = item('collections', 1, { votes: 900, comments: 100, agoDays: 40 });
    const newButWeak = item('collections', 2, { votes: 0, comments: 0, agoDays: 0, type: 'pin' });
    assert.ok(keepScore(oldButGood) > keepScore(newButWeak));
  });

  it('未超过上限时原样返回', () => {
    const records = [item('likes', 1), item('likes', 2)];
    assert.equal(trimToLimit(records).length, 2);
  });
});

describe('每部分最多 50 条', () => {
  it('点赞超过 50 条时按分数淘汰，保留权重高和更新的', () => {
    const store = makeStore();
    const records = Array.from({ length: 60 }, (_, index) => item('likes', index, {
      votes: index < 10 ? 0 : 200,          // 前 10 条权重低
      comments: index < 10 ? 0 : 30,
      agoDays: index < 10 ? 60 : 1,         // 而且最旧
    }));
    store.save('src-1', { id: 'me', nickname: '我' }, records, false);
    const kept = store.dataset('src-1', 'likes');
    assert.equal(kept.length, PART_LIMIT);
    assert.equal(kept.some((record) => record.contentId === '0'), false, '最低分的那批应被淘汰');
    assert.equal(kept.some((record) => record.contentId === '59'), true);
  });

  it('三个类别各自独立计上限', () => {
    const store = makeStore();
    const history = Array.from({ length: 55 }, (_, index) => item('history', index, { votes: 10, comments: 2 }));
    const likes = Array.from({ length: 55 }, (_, index) => item('likes', index, { votes: 10, comments: 2 }));
    const collections = Array.from({ length: 3 }, (_, index) => item('collections', index, { votes: 10, comments: 2 }));
    store.save('src-1', { id: 'me', nickname: '我' }, [...history, ...likes, ...collections], false);
    assert.equal(store.dataset('src-1', 'history').length, PART_LIMIT);
    assert.equal(store.dataset('src-1', 'likes').length, PART_LIMIT);
    assert.equal(store.dataset('src-1', 'collections').length, 3);
  });

  it('重复采集同一批内容不会无限增长', () => {
    const store = makeStore();
    const batch = Array.from({ length: 40 }, (_, index) => item('collections', index, { votes: 3, comments: 1 }));
    store.save('src-1', { id: 'me', nickname: '我' }, batch, false);
    store.save('src-1', { id: 'me', nickname: '我' }, batch, false);
    assert.equal(store.dataset('src-1', 'collections').length, 40, '同样的 40 条不应翻倍');
  });
});

describe('采集时间语义', () => {
  it('再次保存时保留首次见到的时间，用于判断"采集时间靠前"', () => {
    const store = makeStore();
    const first = item('likes', 1, { votes: 5, comments: 1, agoDays: 10 });
    store.save('src-1', { id: 'me', nickname: '我' }, [first], false);
    const seenAt = store.dataset('src-1', 'likes')[0].observedAt;
    // 增量同步会带着上次的记录再来一遍，时间应保持首次采集的时刻。
    const carried = store.dataset('src-1', 'likes')[0];
    store.save('src-1', { id: 'me', nickname: '我' }, [carried], false);
    assert.equal(store.dataset('src-1', 'likes')[0].observedAt, seenAt, '首次采集时间应保持不变');
  });
});
