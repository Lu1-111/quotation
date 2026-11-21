import { createHash } from 'node:crypto';
import { DEFAULT_SETTINGS, rankRecords, validateSettings } from './record-ranking.mjs';
import { DATA_KINDS, POLICY_VERSION, policyAllows, reviewRecord } from './content-policy.mjs';

export class HistoryError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export function parseHistoryJson(text) {
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value) && Number.isInteger(value)) {
      return context.source;
    }
    return value;
  });
}

export function contentUrl(value, type, id) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && (url.hostname === 'zhihu.com' || url.hostname.endsWith('.zhihu.com'))) {
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.href;
    }
  } catch {
    // The platform can return a native-app link instead of a web URL.
  }
  const paths = { answer: '/answer/', question: '/question/', pin: '/pin/', zvideo: '/zvideo/' };
  if (paths[type]) return `https://www.zhihu.com${paths[type]}${encodeURIComponent(id)}`;
  if (type === 'article') return `https://zhuanlan.zhihu.com/p/${encodeURIComponent(id)}`;
  return null;
}

export function plainText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

function firstCount(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const count = Number(value);
    if (Number.isFinite(count) && count >= 0) return count;
  }
  return null;
}

export function contentMetadata(content = {}) {
  const topics = content.topics ?? content.question?.topics ?? [];
  return {
    voteCount: firstCount(content.voteup_count, content.like_count, content.voteupCount, content.likesCount,
      content.reaction?.statistics?.like_count),
    commentCount: firstCount(content.comment_count, content.commentCount, content.commentsCount),
    topics: Array.isArray(topics) ? topics.map((topic) => ({
      id: topic.id == null ? null : String(topic.id), name: typeof topic.name === 'string' ? topic.name : '',
    })).filter((topic) => topic.id || topic.name) : [],
  };
}

export function normalizePost(content, kind, signalTime = null) {
  const id = String(content?.id ?? content?.token ?? '');
  const type = content?.type;
  if (!id || typeof type !== 'string') throw new HistoryError('知乎帖子字段发生变化，请检查取数适配。');
  const pinText = Array.isArray(content.content) ? content.content.map((part) => part.content || part.html || '').join(' ') : '';
  return {
    key: `${kind}:${type}:${id}`, kind, contentId: id, contentType: type,
    title: plainText(content.title || content.question?.title || content.excerpt_title || pinText),
    summary: plainText(content.excerpt || content.summary || pinText),
    author: content.author?.name || '', url: contentUrl(content.url, type, id),
    sourceReadTime: null, signalTime, ...contentMetadata(content),
  };
}

export function normalizeHistoryItem(item) {
  const data = item?.data;
  const extra = data?.extra;
  const id = String(extra?.content_token ?? '');
  const type = extra?.content_type;
  if (!id || typeof type !== 'string' || !type) {
    throw new HistoryError('知乎历史记录字段发生变化，请检查取数适配。');
  }
  const sourceReadTime = extra.read_time == null ? null : String(extra.read_time);
  const key = createHash('sha256').update(JSON.stringify([type, id, sourceReadTime])).digest('hex');
  return {
    key,
    kind: 'history',
    contentId: id,
    contentType: type,
    title: typeof data.header?.title === 'string' ? data.header.title : '',
    summary: typeof data.content?.summary === 'string' ? data.content.summary : '',
    author: typeof data.content?.author_name === 'string' ? data.content.author_name : '',
    url: contentUrl(data.action?.url, type, id),
    sourceReadTime,
    ...contentMetadata({ ...data, ...data.content, ...extra }),
  };
}

export function nextHistoryOffset(paging) {
  if (paging?.is_end === true) return null;
  if (paging?.is_end !== false || typeof paging.next !== 'string') {
    throw new HistoryError('知乎历史记录缺少有效分页信息。');
  }
  let next;
  try {
    next = new URL(paging.next, 'https://www.zhihu.com');
  } catch {
    throw new HistoryError('知乎历史记录的分页地址无效。');
  }
  const offset = next.searchParams.get('offset');
  if (!/^\d+$/.test(offset ?? '')) throw new HistoryError('知乎历史记录的分页游标无效。');
  return offset;
}

export function createHistoryStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS history_sources (
    id TEXT PRIMARY KEY,
    consented_at TEXT,
    account_id TEXT,
    nickname TEXT,
    auto_sync INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT,
    last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS history_records (
    source_id TEXT NOT NULL,
    record_key TEXT NOT NULL,
    record TEXT NOT NULL,
    PRIMARY KEY (source_id, record_key)
  );
  CREATE TABLE IF NOT EXISTS history_settings (
    source_id TEXT PRIMARY KEY, settings TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS history_datasets (
    source_id TEXT NOT NULL, kind TEXT NOT NULL, records TEXT NOT NULL,
    PRIMARY KEY (source_id, kind)
  );
  CREATE TABLE IF NOT EXISTS history_rankings (
    source_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS history_content_reviews (
    source_id TEXT NOT NULL, input_hash TEXT NOT NULL, analysis TEXT NOT NULL,
    PRIMARY KEY (source_id, input_hash)
  );`);

  const get = db.prepare('SELECT * FROM history_sources WHERE id = ?');
  const create = db.prepare('INSERT INTO history_sources (id) VALUES (?)');
  const grant = db.prepare('UPDATE history_sources SET consented_at = ?, last_error = NULL WHERE id = ?');
  const pause = db.prepare('UPDATE history_sources SET auto_sync = 0 WHERE id = ?');
  const revoke = db.prepare('UPDATE history_sources SET auto_sync = 0, consented_at = NULL WHERE id = ?');
  const clear = db.prepare('DELETE FROM history_records WHERE source_id = ?');
  const reset = db.prepare(`UPDATE history_sources SET account_id = NULL, nickname = NULL,
    last_synced_at = NULL, last_error = NULL WHERE id = ?`);
  const error = db.prepare('UPDATE history_sources SET last_error = ? WHERE id = ?');
  const records = db.prepare('SELECT record FROM history_records WHERE source_id = ? ORDER BY rowid DESC');
  const complete = db.prepare(`UPDATE history_sources SET account_id = ?, nickname = ?,
    last_synced_at = ?, last_error = NULL, auto_sync = ? WHERE id = ?`);
  const automatic = db.prepare('SELECT * FROM history_sources WHERE auto_sync = 1 AND consented_at IS NOT NULL');
  const settingsRow = db.prepare('SELECT settings FROM history_settings WHERE source_id = ?');
  const setSettings = db.prepare(`INSERT INTO history_settings VALUES (?, ?)
    ON CONFLICT(source_id) DO UPDATE SET settings = excluded.settings`);
  const datasetRows = db.prepare('SELECT kind, records FROM history_datasets WHERE source_id = ?');
  const setDataset = db.prepare(`INSERT INTO history_datasets VALUES (?, ?, ?)
    ON CONFLICT(source_id, kind) DO UPDATE SET records = excluded.records`);
  const rankingRow = db.prepare('SELECT snapshot FROM history_rankings WHERE source_id = ?');
  const setRanking = db.prepare(`INSERT INTO history_rankings VALUES (?, ?)
    ON CONFLICT(source_id) DO UPDATE SET snapshot = excluded.snapshot`);
  const clearDatasets = db.prepare('DELETE FROM history_datasets WHERE source_id = ?');
  const clearRanking = db.prepare('DELETE FROM history_rankings WHERE source_id = ?');
  const cachedReview = db.prepare('SELECT analysis FROM history_content_reviews WHERE source_id = ? AND input_hash = ?');
  const setReview = db.prepare(`INSERT INTO history_content_reviews VALUES (?, ?, ?)
    ON CONFLICT(source_id, input_hash) DO UPDATE SET analysis = excluded.analysis`);
  const clearReviews = db.prepare('DELETE FROM history_content_reviews WHERE source_id = ?');

  function settings(id) {
    const row = settingsRow.get(id);
    return row ? { ...DEFAULT_SETTINGS, ...JSON.parse(row.settings) } : { ...DEFAULT_SETTINGS };
  }

  function rebuild(id) {
    const selected = settings(id);
    const datasets = datasetRows.all(id);
    const raw = datasets.flatMap((dataset) => JSON.parse(dataset.records));
    if (!datasets.some((dataset) => dataset.kind === 'history')) {
      raw.push(...records.all(id).map((row) => ({ ...JSON.parse(row.record), kind: 'history' })));
    }
    const ranked = rankRecords(raw, selected);
    const excluded = new Map();
    for (const record of raw.filter((record) => selected[record.kind || 'history'])) {
      const reviewed = reviewRecord(record, selected);
      if (!policyAllows(reviewed, selected)) excluded.set(`${record.contentType}:${record.contentId}`, reviewed);
    }
    const snapshot = { policyVersion: POLICY_VERSION, settings: selected, records: ranked, excluded: [...excluded.values()] };
    snapshot.revision = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    setRanking.run(id, JSON.stringify(snapshot));
    return snapshot;
  }

  function ranking(id) {
    const row = rankingRow.get(id);
    const saved = row && JSON.parse(row.snapshot);
    return saved?.policyVersion === POLICY_VERSION ? saved : rebuild(id);
  }

  return {
    get: (id) => get.get(id),
    create: (id) => create.run(id),
    consent: (id) => grant.run(new Date().toISOString(), id),
    pause: (id) => pause.run(id),
    revoke: (id) => revoke.run(id),
    error: (id, message) => error.run(message, id),
    count: (id) => ranking(id).records.length,
    settings,
    cachedReview(id, hash) { const row = cachedReview.get(id, hash); return row ? JSON.parse(row.analysis) : null; },
    saveReview: (id, hash, analysis) => setReview.run(id, hash, JSON.stringify(analysis)),
    saveSettings(id, value) {
      const next = validateSettings(value);
      db.exec('BEGIN IMMEDIATE');
      try {
        setSettings.run(id, JSON.stringify(next));
        rebuild(id);
        db.exec('COMMIT');
      } catch (failure) {
        db.exec('ROLLBACK');
        throw failure;
      }
      return next;
    },
    automatic: () => automatic.all(),
    clear(id) {
      db.exec('BEGIN IMMEDIATE');
      try {
        clear.run(id);
        clearDatasets.run(id);
        clearRanking.run(id);
        clearReviews.run(id);
        reset.run(id);
        db.exec('COMMIT');
      } catch (failure) {
        db.exec('ROLLBACK');
        throw failure;
      }
    },
    save(id, account, items, autoSync) {
      const syncedAt = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const selected = settings(id);
        for (const kind of DATA_KINDS.filter((kind) => selected[kind])) {
          const current = items.filter((item) => (item.kind || 'history') === kind)
            .map((item) => ({ ...item, kind, observedAt: syncedAt }));
          setDataset.run(id, kind, JSON.stringify(current));
        }
        complete.run(account.id, account.nickname, syncedAt, Number(autoSync), id);
        rebuild(id);
        db.exec('COMMIT');
      } catch (failure) {
        db.exec('ROLLBACK');
        throw failure;
      }
    },
    snapshot(id, demo = false) {
      const source = get.get(id);
      const saved = ranking(id);
      return {
        schemaVersion: 3,
        source: demo ? 'demo_history' : 'zhihu_selected_data',
        account: { nickname: source.nickname || '' },
        syncedAt: source.last_synced_at,
        ...saved,
        counts: Object.fromEntries(DATA_KINDS.map((kind) => [kind,
          saved.records.filter((record) => record.kinds.includes(kind)).length])),
      };
    },
  };
}
