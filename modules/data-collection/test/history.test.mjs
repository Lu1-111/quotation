import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createHistoryStore, HistoryError, normalizeHistoryItem, parseHistoryJson } from '../history-data.mjs';
import { createHistoryCollector } from '../history-collector.mjs';

function historyItem(id, time = '1760000000') {
  return { data: {
    header: { title: `记录 ${id}` },
    content: { summary: '原始摘要', author_name: '作者' },
    action: { url: `https://www.zhihu.com/answer/${id}` },
    extra: { content_token: id, content_type: 'answer', read_time: time },
  } };
}

test('history keeps large content IDs and platform read_time without treating it as duration', () => {
  const item = parseHistoryJson('{"data":{"header":{"title":"标题"},"extra":{"content_token":969570047710216201,"content_type":"answer","read_time":1760000000}}}');
  const normalized = normalizeHistoryItem(item);
  assert.equal(normalized.contentId, '969570047710216201');
  assert.equal(normalized.url, 'https://www.zhihu.com/answer/969570047710216201');
  assert.equal(normalized.sourceReadTime, '1760000000');
  assert.ok(!('duration' in normalized));
});

test('history sync isolates owners, deduplicates, and preserves saved data on later-page failure', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = createHistoryStore(db);
  store.create('first');
  store.create('second');
  let owner = 'owner-a';
  let failPage = false;
  let firstPage = historyItem('1');
  const gateway = {
    active: false,
    async open() { this.active = true; },
    async close() { this.active = false; },
    async request(path) {
      if (path === '/api/v4/me') return { id: owner, name: owner };
      const offset = new URL(path, 'https://www.zhihu.com').searchParams.get('offset');
      if (offset === '50') {
        if (failPage) throw new Error('upstream unavailable');
        return { data: [historyItem('2')], paging: { is_end: true } };
      }
      return { data: [firstPage], paging: { is_end: false, next: '?offset=50&limit=50' } };
    },
  };
  const collector = createHistoryCollector(store, { gatewayFactory: () => gateway, pageDelay: 0, isPageActive: () => true });
  await assert.rejects(collector.sync('first'), /请先同意/);
  store.consent('first');
  await collector.open('first');
  await collector.sync('first', true);
  assert.equal(store.count('first'), 2);
  assert.equal(store.count('second'), 0);
  await collector.sync('first', true);
  assert.equal(store.count('first'), 2);

  firstPage = historyItem('3');
  failPage = true;
  const saved = store.snapshot('first');
  await assert.rejects(collector.sync('first'), /同步失败/);
  assert.deepEqual(store.snapshot('first'), saved);

  failPage = false;
  owner = 'owner-b';
  await assert.rejects(collector.sync('first'), /账号不一致/);
  assert.equal(store.count('first'), 2);
  assert.equal(store.get('first').auto_sync, 0);
  await collector.disconnect('first');
  assert.equal(store.get('first').consented_at, null);
});

test('pausing an in-flight history sync prevents a late result from being saved', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = createHistoryStore(db);
  store.create('local');
  store.consent('local');
  let resume;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const gateway = {
    active: true,
    async open() { this.active = true; },
    async close() { this.active = false; },
    async request(path) {
      if (path === '/api/v4/me') return { id: 'owner-a', name: 'A' };
      started();
      await new Promise((resolve) => { resume = resolve; });
      return { data: [historyItem('1')], paging: { is_end: true } };
    },
  };
  const collector = createHistoryCollector(store, { gatewayFactory: () => gateway, pageDelay: 0, isPageActive: () => true });
  const job = collector.sync('local', true);
  await waiting;
  collector.pause('local');
  resume();
  await assert.rejects(job, /同步已暂停/);
  assert.equal(store.count('local'), 0);
  assert.equal(store.get('local').auto_sync, 0);
});

test('scheduled sync needs a connected page after restart and pauses on login expiry', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = createHistoryStore(db);
  store.create('saved');
  store.consent('saved');
  store.save('saved', { id: 'account-a', nickname: 'A' }, [], true);
  db.prepare('UPDATE history_sources SET last_synced_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 600_000).toISOString(), 'saved');
  let expired = false;
  const modes = [];
  let closes = 0;
  const gateway = {
    active: false,
    async open(options) { modes.push(options.headless); this.active = true; },
    async close() { closes += 1; this.active = false; },
    async request(path) {
      assert.equal(this.active, true);
      if (expired) throw new HistoryError('请重新登录', 401);
      if (path === '/api/v4/me') return { id: 'account-a', name: 'A' };
      return { data: [historyItem('1')], paging: { is_end: true } };
    },
  };
  let pageActive = false;
  let collector = createHistoryCollector(store, { gatewayFactory: () => gateway, pageDelay: 0, isPageActive: () => pageActive });
  await collector.tick();
  assert.equal(modes.length, 0);
  assert.equal(collector.status('saved').autoSyncActive, false);
  assert.equal(collector.status('saved').nextSyncAt, null);
  await assert.rejects(collector.sync('saved'), /网页保持连接/);
  pageActive = true;
  await collector.tick();
  assert.deepEqual(modes, [true]);
  assert.equal(closes, 1);
  assert.equal(gateway.active, false);
  assert.equal(store.count('saved'), 1);
  assert.equal(collector.status('saved').autoSync, true);
  assert.ok(Date.parse(collector.status('saved').nextSyncAt) > Date.now());
  await collector.tick();
  assert.equal(closes, 1);

  expired = true;
  db.prepare('UPDATE history_sources SET last_synced_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 600_000).toISOString(), 'saved');
  collector = createHistoryCollector(store, { gatewayFactory: () => gateway, pageDelay: 0, isPageActive: () => pageActive });
  await collector.tick();
  assert.equal(closes, 2);
  assert.equal(store.count('saved'), 1);
  assert.equal(store.get('saved').auto_sync, 0);
  assert.match(store.get('saved').last_error, /重新登录/);
});
