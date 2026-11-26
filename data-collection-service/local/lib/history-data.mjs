import { createHash } from 'node:crypto';
import { DEFAULT_SETTINGS, rankRecords, trimToLimit, validateSettings } from './record-ranking.mjs';
import { DATA_KINDS, POLICY_VERSION, policyAllows, reviewRecord } from './content-policy.mjs';

export class HistoryError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// 详情（正文、点赞数、话题）缓存多久算新鲜。知乎内容本身变化很慢，
// 但点赞数会变，所以取一周而不是永久。
export const DETAIL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 单条详情缓存的体积上限：超过就不存，避免把异常的大响应写进数据库。
export const DETAIL_CACHE_MAX_BYTES = 256 * 1024;

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
  );
  CREATE TABLE IF NOT EXISTS history_details (
    source_id TEXT NOT NULL, content_key TEXT NOT NULL, payload TEXT NOT NULL,
    fetched_at INTEGER NOT NULL, PRIMARY KEY (source_id, content_key)
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
  const bind = db.prepare('UPDATE history_sources SET account_id = ?, nickname = ?, last_error = NULL WHERE id = ?');
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
  const datasetRow = db.prepare('SELECT records FROM history_datasets WHERE source_id = ? AND kind = ?');
  const detailRow = db.prepare('SELECT payload, fetched_at FROM history_details WHERE source_id = ? AND content_key = ?');
  const setDetail = db.prepare(`INSERT INTO history_details VALUES (?, ?, ?, ?)
    ON CONFLICT(source_id, content_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`);
  const clearDetails = db.prepare('DELETE FROM history_details WHERE source_id = ?');
  const expireDetails = db.prepare('DELETE FROM history_details WHERE source_id = ? AND fetched_at < ?');

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
    bindAccount(id, account) {
      const source = get.get(id);
      if (!source || typeof account?.id !== 'string' || !account.id) throw new HistoryError('无法绑定当前账号。', 400);
      if (source.account_id && source.account_id !== account.id) throw new HistoryError('该档案已绑定其他知乎账号，请使用新的 --profile。', 409);
      bind.run(account.id, typeof account.nickname === 'string' ? account.nickname : '', id);
    },
    consent: (id) => grant.run(new Date().toISOString(), id),
    pause: (id) => pause.run(id),
    revoke: (id) => revoke.run(id),
    error: (id, message) => error.run(message, id),
    count: (id) => ranking(id).records.length,
    settings,
    cachedReview(id, hash) { const row = cachedReview.get(id, hash); return row ? JSON.parse(row.analysis) : null; },
    saveReview: (id, hash, analysis) => setReview.run(id, hash, JSON.stringify(analysis)),
    // 上一次采集落库的某个类别原始记录，用于增量同步时复用。
    dataset(id, kind) {
      const row = datasetRow.get(id, kind);
      if (!row) return [];
      try { const value = JSON.parse(row.records); return Array.isArray(value) ? value : []; }
      catch { return []; }
    },
    // 详情缓存：命中就当次不再向知乎取详情，也不等待节流。
    cachedDetail(id, contentKey, ttlMs = DETAIL_CACHE_TTL_MS) {
      const row = detailRow.get(id, contentKey);
      if (!row) return null;
      if (ttlMs != null && Date.now() - Number(row.fetched_at) > ttlMs) return null;
      try { return JSON.parse(row.payload); }
      catch { return null; }
    },
    saveDetail(id, contentKey, payload) {
      const text = JSON.stringify(payload);
      if (typeof text !== 'string' || text.length > DETAIL_CACHE_MAX_BYTES) return;
      setDetail.run(id, contentKey, text, Date.now());
    },
    // 过期缓存只是读不到，并不会自动消失；每次同步前清一次，避免表无限增长。
    pruneDetails(id, ttlMs = DETAIL_CACHE_TTL_MS) {
      expireDetails.run(id, Date.now() - ttlMs);
    },
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
        clearDetails.run(id);
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
            // 首次见到的时间要保留：它是淘汰时判断"采集时间靠前"的依据，
            // 每次同步都刷新成当前时间的话，这个判断就失效了。
            .map((item) => ({ ...item, kind, observedAt: item.observedAt ?? syncedAt }));
          // 每个类别最多存 50 条，超出按"权重 + 采集新鲜度"淘汰。
          setDataset.run(id, kind, JSON.stringify(trimToLimit(current)));
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
