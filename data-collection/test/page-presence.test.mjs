import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createPagePresence } from '../page-presence.mjs';
import { createHistoryStore } from '../history-data.mjs';
import { createHistoryCollector } from '../history-collector.mjs';

const PAGE_A = 'test-page-00000001';
const PAGE_B = 'test-page-00000002';

test('page presence expires without acknowledgements and survives one tab closing', () => {
  let clock = 0;
  const inactive = [];
  const closed = [];
  const pages = createPagePresence({ now: () => clock, leaseMs: 30_000, onInactive: (id) => inactive.push(id) });
  assert.equal(pages.active('source'), false);
  assert.throws(() => pages.attach('source', 'bad'), /无效/);
  const closeA = pages.attach('source', PAGE_A, () => closed.push('a'));
  pages.attach('source', PAGE_B, () => closed.push('b'));
  assert.equal(pages.active('source'), false);
  pages.touch('source', PAGE_A);
  pages.touch('source', PAGE_B);
  assert.equal(pages.active('source'), true);
  closeA();
  assert.equal(pages.active('source'), true);
  assert.equal(inactive.length, 0);
  clock = 20_000;
  assert.equal(pages.touch('source', PAGE_B), true);
  clock = 40_000;
  pages.sweep();
  assert.equal(pages.active('source'), true);
  clock = 50_000;
  pages.sweep();
  assert.equal(pages.active('source'), false);
  assert.equal(pages.touch('source', PAGE_B), false);
  assert.deepEqual(closed, ['a', 'b']);
  assert.deepEqual(inactive, ['source']);
});

test('stale stream closure cannot remove a reconnected page or another source', () => {
  const inactive = [];
  const pages = createPagePresence({ onInactive: (id) => inactive.push(id) });
  const staleClose = pages.attach('first', PAGE_A);
  pages.attach('first', PAGE_A);
  pages.attach('second', PAGE_A);
  pages.touch('first', PAGE_A);
  pages.touch('second', PAGE_A);
  staleClose();
  assert.equal(pages.active('first'), true);
  pages.release('first', PAGE_A);
  assert.equal(pages.active('first'), false);
  assert.equal(pages.active('second'), true);
  assert.deepEqual(inactive, ['first']);
});

test('closing the last page cancels an in-flight sync without committing or erasing automatic-sync preference', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = createHistoryStore(db);
  store.create('source'); store.consent('source');
  store.save('source', { id: 'owner', nickname: '读者' }, [], true);
  let resume;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const gateway = { active: false,
    async open() { this.active = true; }, async close() { this.active = false; },
    async request(path) {
      if (path === '/api/v4/me') return { id: 'owner' };
      started(); await new Promise((resolve) => { resume = resolve; });
      return { data: [{ data: { header: { title: '数据库教程' }, extra: { content_token: '1', content_type: 'article' } } }], paging: { is_end: true } };
    },
  };
  let collector;
  const pages = createPagePresence({ onInactive: (id) => collector.stopForClosedPage(id) });
  collector = createHistoryCollector(store, { gatewayFactory: () => gateway, pageDelay: 0, isPageActive: (id) => pages.active(id) });
  const close = pages.attach('source', PAGE_A);
  pages.touch('source', PAGE_A);
  const job = collector.sync('source', true);
  await waiting;
  close();
  resume();
  await assert.rejects(job, /暂停/);
  assert.equal(gateway.active, false);
  assert.equal(store.count('source'), 0);
  assert.equal(store.get('source').auto_sync, 1);
  assert.equal(collector.status('source').autoSyncActive, false);
  await assert.rejects(collector.open('source'), /网页连接/);
  pages.attach('source', PAGE_B);
  pages.touch('source', PAGE_B);
  assert.equal(collector.status('source').autoSyncActive, true);
});
