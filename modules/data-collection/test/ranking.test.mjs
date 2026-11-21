import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createHistoryStore } from '../history-data.mjs';
import { eligibleHistory, newestHistory, rankRecords } from '../record-ranking.mjs';
import { collectSelectedData } from '../zhihu-sources.mjs';

const NOW = Date.UTC(2026, 10, 20);
function record(id, overrides = {}) {
  return {
    key: id, kind: 'history', contentId: id, contentType: 'answer', title: id,
    sourceReadTime: String(NOW / 1000), voteCount: 0, commentCount: 0, topics: [], ...overrides,
  };
}

function content(id) {
  return { id, type: 'answer', question: { title: id, topics: [{ id: id, name: id }] }, voteup_count: 10, comment_count: 2 };
}

test('weights apply type, explicit interaction, strict age boundaries, and bounded popularity bonus', () => {
  const age = (days) => String((NOW - days * 86400_000) / 1000);
  const settings = { history: true, likes: true, collections: true };
  const weighted = rankRecords([
    record('pin', { contentType: 'pin' }), record('article', { contentType: 'article' }),
    record('answer', { voteCount: null }),
    record('7days', { sourceReadTime: age(7), voteCount: 5 }),
    record('8days', { sourceReadTime: age(8), voteCount: 5 }),
    record('14days', { sourceReadTime: age(14), voteCount: 5 }),
    record('15days', { sourceReadTime: age(15), voteCount: 5 }),
    record('liked', { kind: 'likes', sourceReadTime: age(100) }),
    record('collected', { kind: 'collections', contentType: 'article', sourceReadTime: age(100) }),
    record('popular', { voteCount: 100000, commentCount: 100000 }),
  ], settings, NOW);
  const get = (id) => weighted.find((item) => item.contentId === id);
  assert.equal(get('pin').weight, 1);
  assert.equal(get('article').weight, 2);
  assert.equal(get('answer').weight, 3);
  assert.equal(get('liked').weight, 4);
  assert.equal(get('collected').weight, Number((8 / 3).toFixed(6)));
  assert.equal(get('7days').weightDetails.timeFactor, 1);
  assert.equal(get('8days').weightDetails.timeFactor, 0.9);
  assert.equal(get('14days').weightDetails.timeFactor, 0.9);
  assert.equal(get('15days').weightDetails.timeFactor, 0.7);
  assert.equal(get('popular').weightDetails.engagementBonus, 1);
  assert.ok(weighted.every((item, index) => !index || weighted[index - 1].weight >= item.weight));
});

test('topic bonus counts other unique posts, deduplicates multiple sources, and falls back to keywords', () => {
  const topic = [{ id: 'ai', name: '人工智能' }];
  const weighted = rankRecords([
    record('a', { topics: topic, voteCount: 5 }),
    record('a', { kind: 'likes', topics: topic, voteCount: 5 }),
    record('a', { kind: 'collections', topics: topic, voteCount: 5 }),
    record('b', { topics: topic, voteCount: 5 }),
  ], { history: true, likes: true, collections: true }, NOW);
  assert.equal(weighted.length, 2);
  const a = weighted.find((item) => item.contentId === 'a');
  assert.deepEqual(a.kinds, ['history', 'likes', 'collections']);
  assert.equal(a.weightDetails.similarPostCount, 1);
  assert.equal(a.weightDetails.themeBonus, 0.5);
  assert.equal(a.weightDetails.actionMultiplier, 4 / 3);

  const keywords = rankRecords([
    record('c', { voteCount: 5, title: '本地 模型 部署 加速' }),
    record('d', { voteCount: 5, title: '本地 模型 部署 实践' }),
  ], undefined, NOW);
  assert.equal(keywords[0].weightDetails.similarPostCount, 1);
});

test('history excludes profiles and poor answers, retains missing metrics, and selects newest 50 posts', () => {
  assert.equal(eligibleHistory(record('profile', { contentType: 'profile' })), false);
  assert.equal(eligibleHistory(record('bad', { voteCount: 4, commentCount: 1 })), false);
  assert.equal(eligibleHistory(record('votes', { voteCount: 5 })), true);
  assert.equal(eligibleHistory(record('comments', { commentCount: 2 })), true);
  assert.equal(eligibleHistory(record('unknown', { voteCount: null })), true);
  const records = Array.from({ length: 65 }, (_value, index) => record(String(index), {
    voteCount: 5, sourceReadTime: String(NOW / 1000 - index),
  })).reverse();
  const selected = newestHistory(records);
  assert.equal(selected.length, 50);
  assert.equal(selected[0].contentId, '0');
  assert.equal(selected[49].contentId, '49');
});

test('collector continues past rejected history entries and stops at 50 qualified posts', async () => {
  const requested = [];
  const history = (id, type, votes, time) => ({ data: {
    header: { title: id }, content: { voteup_count: votes, comment_count: 0, topics: [{ id, name: id }] },
    extra: { content_token: id, content_type: type, read_time: time },
  } });
  const gateway = {
    async request(path) {
      const url = new URL(path, 'https://www.zhihu.com');
      const offset = url.searchParams.get('offset');
      requested.push(offset);
      if (offset === '0') return { data: [history('profile', 'profile', 100, NOW / 1000), history('bad', 'answer', 0, NOW / 1000)], paging: { is_end: false, next: '?offset=50' } };
      assert.equal(offset, '50');
      return { data: Array.from({ length: 50 }, (_v, i) => history(`good-${i}`, 'answer', 10, NOW / 1000 - i)), paging: { is_end: false, next: '?offset=100' } };
    },
  };
  const result = await collectSelectedData(gateway, { id: 'me', slug: 'me' }, { history: true }, {
    checkActive() {}, async pause() {}, progress() {},
  });
  assert.equal(result.length, 50);
  assert.deepEqual(requested, ['0', '50']);
});

test('likes and favorites paginate beyond 50 while ignoring non-like activities and foreign actors', async () => {
  const gateway = {
    async request(path) {
      const url = new URL(path, 'https://www.zhihu.com');
      const offset = Number(url.searchParams.get('offset') || 0);
      if (url.pathname.endsWith('/activities')) {
        const events = Array.from({ length: 25 }, (_v, i) => ({ verb: 'ANSWER_VOTE_UP', target: content(`like-${offset + i}`), actor: { id: 'me' } }));
        events.push({ verb: 'ANSWER_CREATE', target: content('own-creation') }, { verb: 'ANSWER_VOTE_UP', actor: { id: 'someone-else' }, target: content('foreign') });
        return { data: events, paging: { is_end: offset === 50, next: `?offset=${offset + 25}` } };
      }
      if (url.pathname === '/api/v4/people/me/collections') return { data: [{ id: 'list' }], paging: { is_end: true } };
      if (url.pathname === '/api/v4/collections/list/items') return {
        data: Array.from({ length: 20 }, (_v, i) => ({ content: content(`favorite-${offset + i}`), created: '2020-01-01' })),
        paging: { is_end: offset === 60, next: `?offset=${offset + 20}` },
      };
      throw new Error(`Unexpected path ${url.pathname}`);
    },
  };
  const result = await collectSelectedData(gateway, { id: 'me', slug: 'me' }, { likes: true, collections: true }, {
    checkActive() {}, async pause() {}, progress() {},
  });
  assert.equal(result.filter((item) => item.kind === 'likes').length, 75);
  assert.equal(result.filter((item) => item.kind === 'collections').length, 80);
});

test('legacy records migrate into weighted snapshots and settings only expose selected categories', () => {
  const db = new DatabaseSync(':memory:');
  const store = createHistoryStore(db);
  store.create('old');
  db.prepare('INSERT INTO history_records VALUES (?, ?, ?)').run('old', 'old-key', JSON.stringify(record('legacy', { voteCount: 5 })));
  assert.equal(store.snapshot('old').schemaVersion, 3);
  assert.equal(store.snapshot('old').records.length, 1);
  store.saveSettings('old', { history: false, likes: true, collections: false });
  assert.equal(store.count('old'), 0);
  store.save('old', { id: 'me', nickname: 'me' }, [record('liked', { kind: 'likes' })], false);
  assert.equal(store.snapshot('old').records[0].weight, 4);
  store.saveSettings('old', { history: true, likes: false, collections: false });
  assert.equal(store.snapshot('old').records[0].contentId, 'legacy');
  db.close();
});
