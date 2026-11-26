import { DATA_KINDS, policyAllows, reviewRecord } from './content-policy.mjs';

export const DEFAULT_SETTINGS = Object.freeze({ history: true, likes: false, collections: false, knowledgeFilter: true, fetchFullText: false, aiReview: false });
export const BASE_WEIGHTS = Object.freeze({ pin: 1, article: 2, answer: 3 });
export const ANSWER_MIN_VOTES = 5;
export const ANSWER_MIN_COMMENTS = 2;
export const HISTORY_LIMIT = 50;
// 每个类别在库里最多保留多少条，超出时按 keepScore 淘汰。
export const PART_LIMIT = 50;
// 淘汰时"采集新鲜度"最多能加多少分：30 天内线性衰减到 0。
export const FRESHNESS_WEIGHT = 1;
export const FRESHNESS_DAYS = 30;

// 淘汰分数：类型/行为/互动 + 采集新鲜度。
// 快照里的 weight 还含"同主题加分"，那是窗口内的相对信号、会随批次变化，
// 不适合用来决定长期存储取舍，所以这里单独算一个稳定的分数。
export function keepScore(record, now = Date.now()) {
  const base = BASE_WEIGHTS[record.contentType] ?? 0;
  const kinds = record.kinds ?? (record.kind ? [record.kind] : ['history']);
  const action = kinds.some((kind) => kind === 'likes' || kind === 'collections') ? 4 / 3 : 1;
  const engagement = Math.min(1, Math.log1p((record.voteCount || 0) + 2 * (record.commentCount || 0)) / Math.log1p(1000));
  const seen = Date.parse(record.observedAt ?? '');
  const ageDays = Number.isFinite(seen) ? Math.max(0, (now - seen) / 86_400_000) : FRESHNESS_DAYS;
  const freshness = Math.max(0, 1 - ageDays / FRESHNESS_DAYS);
  return base * action + engagement + FRESHNESS_WEIGHT * freshness;
}

// 超过上限时保留分数最高的若干条；同分时保留采集时间更近的，再按 key 定序保证可复现。
export function trimToLimit(records, { limit = PART_LIMIT, now = Date.now() } = {}) {
  if (records.length <= limit) return records;
  const scored = records.map((record) => ({ record, score: keepScore(record, now) }));
  scored.sort((left, right) => right.score - left.score
    || (Date.parse(right.record.observedAt ?? '') || 0) - (Date.parse(left.record.observedAt ?? '') || 0)
    || String(left.record.key).localeCompare(String(right.record.key)));
  return scored.slice(0, limit).map((entry) => entry.record);
}

export function validateSettings(value) {
  if (!value || DATA_KINDS.some((kind) => typeof value[kind] !== 'boolean')
    || ['knowledgeFilter', 'fetchFullText', 'aiReview'].some((key) => value[key] !== undefined && typeof value[key] !== 'boolean')) {
    throw new Error('请为浏览记录、点赞和收藏分别指定勾选状态。');
  }
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.keys(DEFAULT_SETTINGS).filter((key) => value[key] !== undefined).map((key) => [key, value[key]])) };
}

export function postKey(record) {
  return `${record.contentType}:${record.contentId}`;
}

export function readTimestamp(record) {
  const seconds = Number(record.sourceReadTime);
  return record.sourceReadTime != null && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

export function eligibleHistory(record) {
  if (record.contentType === 'profile') return false;
  return !(record.contentType === 'answer' && record.voteCount != null && record.commentCount != null
    && record.voteCount < ANSWER_MIN_VOTES && record.commentCount < ANSWER_MIN_COMMENTS);
}

export function newestHistory(records) {
  const sorted = [...records].sort((a, b) => (readTimestamp(b) || 0) - (readTimestamp(a) || 0));
  const unique = new Map();
  for (const record of sorted) {
    if (eligibleHistory(record) && !unique.has(postKey(record))) unique.set(postKey(record), record);
    if (unique.size === HISTORY_LIMIT) break;
  }
  return [...unique.values()];
}

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const stopWords = new Set(['什么', '怎么', '如何', '为什么', '是否', '哪些', '一个', '这个', '那个', '我们', '你们', '他们', '可以', '能够', '对于', '现在', '知乎', '问题', '回答', '文章', '怎样', 'the', 'and', 'for', 'with', 'that', 'this']);

function keywords(title) {
  return new Set([...segmenter.segment((title || '').normalize('NFKC').toLowerCase())]
    .filter((part) => part.isWordLike && [...part.segment].length >= 2 && !stopWords.has(part.segment))
    .map((part) => part.segment));
}

function topicKeys(record) {
  return new Set((record.topics || []).flatMap((topic) => [
    topic.id && `id:${topic.id}`,
    topic.name && `name:${topic.name.normalize('NFKC').toLowerCase()}`,
  ].filter(Boolean)));
}

function similarCounts(records) {
  const topics = records.map(topicKeys);
  const words = records.map((record) => keywords(record.title));
  const topicIndex = new Map();
  const wordIndex = new Map();
  for (let index = 0; index < records.length; index += 1) {
    for (const [keys, lookup] of [[topics[index], topicIndex], [words[index], wordIndex]]) {
      for (const key of keys) {
        if (!lookup.has(key)) lookup.set(key, new Set());
        lookup.get(key).add(index);
      }
    }
  }
  return records.map((_record, index) => {
    const peers = new Set();
    for (const key of topics[index]) {
      for (const candidate of topicIndex.get(key)) if (candidate !== index) peers.add(candidate);
    }
    const candidates = new Set();
    for (const word of words[index]) for (const candidate of wordIndex.get(word)) candidates.add(candidate);
    for (const candidate of candidates) {
      if (candidate === index || peers.has(candidate) || (topics[index].size && topics[candidate].size)) continue;
      const common = [...words[index]].filter((word) => words[candidate].has(word)).length;
      const union = words[index].size + words[candidate].size - common;
      if (common >= 2 && common / union >= 0.35) peers.add(candidate);
    }
    return peers.size;
  });
}

function mergeRecord(left, right) {
  if (!left) return { ...right, kinds: [right.kind || 'history'], signals: [{ kind: right.kind || 'history', time: right.signalTime ?? right.sourceReadTime ?? null }] };
  const kinds = [...new Set([...left.kinds, right.kind || 'history'])];
  const signals = [...left.signals, { kind: right.kind || 'history', time: right.signalTime ?? right.sourceReadTime ?? null }];
  return {
    ...left,
    title: left.title || right.title,
    summary: left.summary || right.summary,
    author: left.author || right.author,
    url: left.url || right.url,
    voteCount: left.voteCount ?? right.voteCount ?? null,
    commentCount: left.commentCount ?? right.commentCount ?? null,
    topics: left.topics?.length ? left.topics : right.topics || [],
    sourceReadTime: left.sourceReadTime ?? right.sourceReadTime ?? null,
    kinds, signals,
  };
}

export function rankRecords(records, settings = DEFAULT_SETTINGS, now = Date.now()) {
  const selected = records.filter((record) => settings[record.kind || 'history'])
    .map((record) => reviewRecord(record, settings)).filter((record) => policyAllows(record, settings));
  const history = newestHistory(selected.filter((record) => (record.kind || 'history') === 'history'));
  const combined = new Map();
  for (const record of [...history, ...selected.filter((record) => record.kind && record.kind !== 'history')]) {
    const key = postKey(record);
    combined.set(key, mergeRecord(combined.get(key), record));
  }
  const unique = [...combined.values()];
  const counts = similarCounts(unique);
  return unique.map((record, index) => {
    const base = BASE_WEIGHTS[record.contentType] ?? null;
    const actionMultiplier = record.kinds.some((kind) => ['likes', 'collections'].includes(kind)) ? 4 / 3 : 1;
    const engagementBonus = Math.min(1, Math.log1p((record.voteCount || 0) + 2 * (record.commentCount || 0)) / Math.log1p(1000));
    const themeBonus = 0.5 * counts[index];
    const timestamp = readTimestamp(record);
    const ageDays = timestamp ? Math.max(0, (now - timestamp) / 86_400_000) : null;
    let timeFactor = 1;
    if (actionMultiplier === 1 && ageDays > 14) timeFactor = 0.7;
    else if (actionMultiplier === 1 && ageDays > 7) timeFactor = 0.9;
    const weight = base == null ? null : Number(((base * actionMultiplier + engagementBonus + themeBonus) * timeFactor).toFixed(6));
    return {
      ...record,
      key: postKey(record),
      voteCount: record.voteCount ?? null,
      commentCount: record.commentCount ?? null,
      metricsMissing: record.voteCount == null || record.commentCount == null,
      weight,
      weightDetails: {
        base, actionMultiplier, engagementBonus: Number(engagementBonus.toFixed(6)),
        similarPostCount: counts[index], themeBonus, ageDays, timeFactor,
      },
    };
  }).sort((a, b) => (b.weight ?? -Infinity) - (a.weight ?? -Infinity)
    || (readTimestamp(b) || 0) - (readTimestamp(a) || 0) || postKey(a).localeCompare(postKey(b)));
}
