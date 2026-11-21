import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { SearchError } from './official-client.mjs';

const TYPES = ['answer', 'article', 'question', 'pin', 'zvideo'];
const normalized = (value) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const invalid = (message) => new SearchError(message, 400, 'INVALID_CRITERIA');

function terms(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8 || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 60)) throw invalid(`${label}需为最多 8 项的非空字符串数组，每项不超过 60 字符。`);
  const unique = new Map();
  for (const item of value) unique.set(normalized(item), item.normalize('NFKC').replace(/\s+/g, ' ').trim());
  return [...unique.values()];
}

export function validateCriteria(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('请提供搜索条件对象。');
  const known = ['query', 'keywords', 'tags', 'keywordMode', 'tagMode', 'countPerQuery', 'maxQueries', 'contentTypes'];
  if (Object.keys(input).some((key) => !known.includes(key))) throw invalid('包含未知搜索条件，请检查字段名称。');
  if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 240)) throw invalid('查询语句不超过 240 字符。');
  const criteria = { query: (input.query || '').normalize('NFKC').replace(/\s+/g, ' ').trim(), keywords: terms(input.keywords, '关键词'), tags: terms(input.tags, '标签词'),
    keywordMode: input.keywordMode ?? 'any', tagMode: input.tagMode ?? 'any', countPerQuery: input.countPerQuery ?? 10, maxQueries: input.maxQueries ?? 4,
    contentTypes: input.contentTypes ?? [] };
  if (!criteria.query && !criteria.keywords.length && !criteria.tags.length) throw invalid('查询语句、关键词或标签词至少填写一项。');
  if (![criteria.keywordMode, criteria.tagMode].every((mode) => ['any', 'all'].includes(mode))) throw invalid('匹配模式只能为 any 或 all。');
  if (!Number.isInteger(criteria.countPerQuery) || criteria.countPerQuery < 1 || criteria.countPerQuery > 10) throw invalid('单查询数量必须为 1 到 10。');
  if (!Number.isInteger(criteria.maxQueries) || criteria.maxQueries < 1 || criteria.maxQueries > 6) throw invalid('查询预算必须为 1 到 6 次。');
  if (!Array.isArray(criteria.contentTypes) || criteria.contentTypes.some((type) => !TYPES.includes(type))) throw invalid('内容类型不受支持。');
  criteria.contentTypes = [...new Set(criteria.contentTypes)];
  return criteria;
}

export function buildQueryPlan(criteria) {
  const base = [criteria.query, ...criteria.keywords].filter(Boolean).join(' ');
  const candidates = [[base, ...criteria.tags].filter(Boolean).join(' '), base];
  for (const keyword of criteria.keywords) candidates.push([criteria.query, keyword].filter(Boolean).join(' '));
  for (const tag of criteria.tags) candidates.push([base, tag].filter(Boolean).join(' '), tag);
  const unique = new Map();
  for (const query of candidates.filter(Boolean)) unique.set(normalized(query), query);
  const all = [...unique.values()];
  if (all.some((query) => query.length > 1000)) throw invalid('组合查询过长，请减少关键词和标签词。');
  return { queries: all.slice(0, criteria.maxQueries), candidateQueryCount: all.length, truncated: all.length > criteria.maxQueries };
}

function contains(text, term) {
  const haystack = normalized(text || '');
  const needle = normalized(term);
  if (/^[\x00-\x7f]+$/.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, 'u').test(haystack);
  }
  return haystack.includes(needle);
}

export function matchItem(item, criteria) {
  const evidence = [];
  const matched = (list, kind) => list.filter((term) => {
    const fields = ['title', 'excerpt'].filter((field) => contains(item[field], term));
    if (fields.length) { evidence.push({ kind, term, fields }); return true; }
    return false;
  });
  const keywords = matched(criteria.keywords, 'keyword');
  const tags = matched(criteria.tags, 'tagText');
  const accepts = (requested, actual, mode) => !requested.length || (mode === 'all' ? actual.length === requested.length : actual.length > 0);
  return { accepted: accepts(criteria.keywords, keywords, criteria.keywordMode) && accepts(criteria.tags, tags, criteria.tagMode)
      && (!criteria.contentTypes.length || criteria.contentTypes.includes(item.contentType)),
    keywords, tags, tagSource: 'local_title_excerpt_match', evidence };
}

export function createInformationSearch({ client, store, now = Date.now, queryDelayMs = 350, demo = false } = {}) {
  return {
    async search(input, { signal, refresh = false } = {}) {
      if (typeof refresh !== 'boolean') throw invalid('refresh 必须为布尔值。');
      const criteria = validateCriteria(input);
      const queryPlan = buildQueryPlan(criteria);
      const merged = new Map();
      const searches = [];
      let apiCalls = 0, cacheHits = 0, rawCount = 0;
      for (const query of queryPlan.queries) {
        signal?.throwIfAborted();
        const cacheKey = createHash('sha256').update(JSON.stringify(['official-zhihu-v1', demo, query, criteria.countPerQuery])).digest('hex');
        let result = !refresh && store?.getQuery(cacheKey);
        const fromCache = Boolean(result);
        if (result) cacheHits += 1;
        else {
          if (apiCalls && queryDelayMs > 0) await pause(queryDelayMs, undefined, { signal });
          result = await client.search(query, criteria.countPerQuery, { signal });
          signal?.throwIfAborted();
          store?.saveQuery(cacheKey, result); apiCalls += 1;
        }
        searches.push({ query, searchHashId: result.searchHashId, returnedCount: result.items.length, hasMoreReported: result.hasMore, emptyReason: result.emptyReason || '', fromCache });
        rawCount += result.items.length;
        for (const item of result.items) {
          const old = merged.get(item.key);
          if (old) {
            const excerptVariants = [...new Set([...old.excerptVariants, item.excerpt])];
            const bestScore = Math.max(old.rankingScore ?? -Infinity, item.rankingScore ?? -Infinity);
            merged.set(item.key, { ...old, excerptVariants, excerpt: excerptVariants.filter(Boolean).join('\n\n'),
              matchedQueries: [...new Set([...old.matchedQueries, query])], rankingScore: bestScore === -Infinity ? null : bestScore });
          } else merged.set(item.key, { ...item, excerptVariants: [item.excerpt], matchedQueries: [query] });
        }
      }
      signal?.throwIfAborted();
      const evaluated = [...merged.values()].map((item) => ({ ...item, matches: matchItem(item, criteria) }));
      const items = evaluated.filter((item) => item.matches.accepted).sort((a, b) => (b.rankingScore ?? -Infinity) - (a.rankingScore ?? -Infinity) || a.key.localeCompare(b.key));
      const snapshot = { schemaVersion: 1, module: 'information-search', provider: demo ? 'demo' : 'zhihu_official_search', requestId: randomUUID(), createdAt: new Date(now()).toISOString(), criteria,
        queryPlan, coverage: { paginationSupported: false, perQueryLimit: criteria.countPerQuery, platformTagsAvailable: false, tagMatching: 'local_title_excerpt_match', textKind: 'excerpt', hasMoreReported: searches.some((search) => search.hasMoreReported) },
        searches, stats: { apiCalls, cacheHits, rawCount, uniqueCount: merged.size, matchedCount: items.length, filteredCount: merged.size - items.length }, items };
      store?.save(snapshot);
      return snapshot;
    },
  };
}
