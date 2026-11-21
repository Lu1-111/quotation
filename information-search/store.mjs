import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function createSearchStore(filename, { now = Date.now, ttlMs = 300_000 } = {}) {
  const path = resolve(filename);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS query_cache (cache_key TEXT PRIMARY KEY, saved_at INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS search_snapshots (request_id TEXT PRIMARY KEY, saved_at INTEGER NOT NULL, payload TEXT NOT NULL);`);
  const cached = db.prepare('SELECT saved_at, payload FROM query_cache WHERE cache_key = ?');
  const cache = db.prepare(`INSERT INTO query_cache VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET saved_at=excluded.saved_at, payload=excluded.payload`);
  const insert = db.prepare('INSERT INTO search_snapshots VALUES (?, ?, ?)');
  const one = db.prepare('SELECT payload FROM search_snapshots WHERE request_id = ?');
  const latest = db.prepare('SELECT payload FROM search_snapshots ORDER BY saved_at DESC, rowid DESC LIMIT 1');
  return {
    getQuery(key) { const row = cached.get(key); return row && now() - row.saved_at < ttlMs ? JSON.parse(row.payload) : null; },
    saveQuery: (key, value) => cache.run(key, now(), JSON.stringify(value)),
    save(snapshot) { insert.run(snapshot.requestId, now(), JSON.stringify(snapshot)); },
    get(id) { const row = id ? one.get(id) : latest.get(); return row ? JSON.parse(row.payload) : null; },
    close() { db.close(); },
  };
}
