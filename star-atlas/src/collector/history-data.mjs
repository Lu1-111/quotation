// 知乎数据解析、规范化与轻量 JSON 详情缓存（7 天 TTL，支持毫秒级增量命中）
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class HistoryError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export const DETAIL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DETAIL_CACHE_MAX_BYTES = 128 * 1024;

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
    // 忽略原生 App 协议地址
  }
  const paths = { answer: '/answer/', question: '/question/', pin: '/pin/', zvideo: '/zvideo/' };
  if (paths[type]) return `https://www.zhihu.com${paths[type]}${encodeURIComponent(id)}`;
  if (type === 'article') return `https://zhuanlan.zhihu.com/p/${encodeURIComponent(id)}`;
  return null;
}

export function plainText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
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
    voteCount: firstCount(
      content.voteup_count,
      content.like_count,
      content.voteupCount,
      content.likesCount,
      content.reaction?.statistics?.like_count,
    ),
    commentCount: firstCount(content.comment_count, content.commentCount, content.commentsCount),
    topics: Array.isArray(topics)
      ? topics
          .map((topic) => ({
            id: topic.id == null ? null : String(topic.id),
            name: typeof topic.name === 'string' ? topic.name : '',
          }))
          .filter((topic) => topic.id || topic.name)
      : [],
  };
}

export function normalizePost(content, kind, signalTime = null) {
  const id = String(content?.id ?? content?.token ?? '');
  const type = content?.type;
  if (!id || typeof type !== 'string') throw new HistoryError('知乎帖子字段发生变化，请检查取数适配。');
  const pinText = Array.isArray(content.content)
    ? content.content.map((part) => part.content || part.html || '').join(' ')
    : '';
  return {
    key: `${kind}:${type}:${id}`,
    kind,
    contentId: id,
    contentType: type,
    title: plainText(content.title || content.question?.title || content.excerpt_title || pinText),
    summary: plainText(content.excerpt || content.summary || pinText),
    author: content.author?.name || '',
    url: contentUrl(content.url, type, id),
    sourceReadTime: null,
    signalTime,
    ...contentMetadata(content),
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

// 轻量持久化详情缓存（内存 Map + 落盘 JSON），确保增量同步与二次同步零额外网络等待
export function createDetailCache(filePath, { ttlMs = DETAIL_CACHE_TTL_MS } = {}) {
  const entries = new Map();
  let loaded = false;
  let dirty = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const now = Date.now();
      for (const [k, v] of Object.entries(parsed?.entries || {})) {
        if (v && Number.isFinite(v.fetchedAt) && now - v.fetchedAt <= ttlMs) {
          entries.set(k, v);
        }
      }
    } catch {
      // 文件不存在或首次运行
    }
  }

  function prune() {
    const now = Date.now();
    for (const [k, v] of entries) {
      if (now - v.fetchedAt > ttlMs) {
        entries.delete(k);
        dirty = true;
      }
    }
  }

  function get(contentKey) {
    const item = entries.get(contentKey);
    if (!item) return null;
    if (Date.now() - item.fetchedAt > ttlMs) {
      entries.delete(contentKey);
      dirty = true;
      return null;
    }
    return item.payload;
  }

  function set(contentKey, payload) {
    const compact = {
      id: payload.id,
      title: payload.title,
      excerpt: payload.excerpt,
      excerpt_title: payload.excerpt_title,
      author: payload.author ? { name: payload.author.name } : undefined,
      question: payload.question
        ? { title: payload.question.title, topics: payload.question.topics }
        : undefined,
      topics: payload.topics,
      voteup_count: payload.voteup_count,
      like_count: payload.like_count,
      comment_count: payload.comment_count,
    };
    const serialized = JSON.stringify(compact);
    if (serialized.length > DETAIL_CACHE_MAX_BYTES) return;
    entries.set(contentKey, { fetchedAt: Date.now(), payload: compact });
    dirty = true;
  }

  async function flush() {
    if (!dirty) return;
    dirty = false;
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify({ entries: Object.fromEntries(entries) }), 'utf8');
    await rename(tmp, filePath);
  }

  return { load, prune, get, set, flush };
}
