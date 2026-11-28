// 高速并发知乎数据源采集器（复用原框架接口适配与增量边界机制，优化为受控并发与预算控制）：
// 目标：初次 50 条采集 <= 15 秒，后续增量同步 <= 10 秒。
import { setTimeout as delay } from 'node:timers/promises';
import {
  HistoryError,
  contentMetadata,
  normalizeHistoryItem,
  normalizePost,
  nextHistoryOffset,
  plainText,
} from './history-data.mjs';
import { eligibleHistory, HISTORY_LIMIT, newestHistory, postKey, readTimestamp } from './record-ranking.mjs';
import { policyAllows, reviewRecord } from './content-policy.mjs';

const LIKE_VERBS = new Set([
  'ANSWER_VOTE_UP',
  'MEMBER_VOTEUP_ANSWER',
  'MEMBER_VOTEUP_ARTICLE',
  'MEMBER_VOTE_PIN',
  'PIN_LIKE',
  'MEMBER_LIKE_PIN',
]);

function nextPage(paging, current) {
  if (paging?.is_end === true) return null;
  if (paging?.is_end !== false || typeof paging.next !== 'string') {
    throw new HistoryError('知乎列表缺少有效分页信息。');
  }
  const url = new URL(paging.next, new URL(current, 'https://www.zhihu.com'));
  if (url.protocol !== 'https:' || !['www.zhihu.com', 'api.zhihu.com'].includes(url.hostname)) {
    throw new HistoryError('知乎列表返回了非预期分页地址。');
  }
  return url.hostname === 'www.zhihu.com' ? `${url.pathname}${url.search}` : url.href;
}

function* activities(entries) {
  for (const entry of entries) {
    yield entry;
    const children = entry.children || (Array.isArray(entry.data) ? entry.data : []);
    if (Array.isArray(children)) yield* activities(children);
  }
}

function detailPathFor(record) {
  const id = encodeURIComponent(record.contentId);
  if (record.contentType === 'answer') {
    return `/api/v4/answers/${id}?include=excerpt,voteup_count,comment_count,question.topics`;
  }
  if (record.contentType === 'article') {
    return `https://zhuanlan.zhihu.com/api/articles/${id}`;
  }
  if (record.contentType === 'pin') {
    return `/api/v4/pins/${id}?include=topics`;
  }
  return null;
}

function applyDetail(record, detail, settings) {
  if (!detail) {
    return {
      ...record,
      bodyStatus: 'unavailable',
      metadataStatus: record.voteCount != null && record.commentCount != null ? 'available' : 'partial',
    };
  }
  const metadata = contentMetadata(detail);
  const rawBody =
    typeof detail.content === 'string'
      ? detail.content
      : Array.isArray(detail.content)
        ? detail.content
            .filter((part) => part.type === 'text' || part.content || part.html)
            .map((part) => part.content || part.html || '')
            .join('\n')
        : '';
  const bodyText = plainText(rawBody);
  return {
    ...record,
    title: record.title || plainText(detail.title || detail.question?.title || detail.excerpt_title),
    summary: record.summary || plainText(detail.excerpt),
    author: record.author || detail.author?.name || '',
    voteCount: metadata.voteCount ?? record.voteCount,
    commentCount: metadata.commentCount ?? record.commentCount,
    topics: metadata.topics.length ? metadata.topics : record.topics || [],
    metadataStatus: 'available',
    ...(settings.fetchFullText
      ? { bodyText, bodyStatus: bodyText ? 'available' : 'unavailable', bodySource: 'zhihu_api_content' }
      : {}),
  };
}

function needsDetailFetch(record, settings) {
  if (!detailPathFor(record)) return false;
  if (settings.fetchFullText) return true;
  // 若 read_history 已包含标题、摘要与互动指标且有话题，无需再额外请求详情
  const hasCoreMeta = record.voteCount != null && record.commentCount != null && (record.topics?.length || 0) > 0;
  return !hasCoreMeta || !record.summary;
}

/**
 * 受控并发详情补全：
 * - 优先命中本地 7 天详情缓存（0ms）；
 * - 未命中缓存时以固定并发池（默认 6 路）分波次拉取，波次间隔 120ms，避免逐条串行 1s 睡眠导致 50+ 秒超时；
 * - 严格遵守 enrichBudgetMs 时间预算（初次 8s / 增量 4s），接近预算时保留列表页已有标题与摘要直接返回，确保总耗时稳控在 15s / 10s 内。
 */
async function enrichBatch(records, gateway, settings, { checkActive, cache, concurrency = 6, batchPauseMs = 120, enrichBudgetMs = 8000 }) {
  const startedAt = Date.now();
  const metadataCache = new Map();
  const pendingToFetch = [];

  for (const record of records) {
    const key = postKey(record);
    if (metadataCache.has(key)) continue;
    const cached = cache?.get(key) ?? null;
    if (cached) {
      metadataCache.set(key, cached);
      continue;
    }
    if (needsDetailFetch(record, settings)) {
      metadataCache.set(key, undefined); // 占位防重复
      pendingToFetch.push({ key, record, path: detailPathFor(record) });
    } else {
      metadataCache.set(key, null);
    }
  }

  for (let i = 0; i < pendingToFetch.length; i += concurrency) {
    checkActive();
    if (Date.now() - startedAt >= enrichBudgetMs) {
      // 达到详情补全预算：剩余条目沿用 read_history 的标题与摘要，保证总采集耗时达标
      break;
    }
    const wave = pendingToFetch.slice(i, i + concurrency);
    const results = await Promise.all(
      wave.map(async (task) => {
        try {
          const detail = await gateway.request(task.path, { optional: true, timeoutMs: 5500 });
          const usable = detail?.id ? detail : null;
          if (usable) cache?.set(task.key, usable);
          return { key: task.key, detail: usable };
        } catch (error) {
          if ([401, 429].includes(error?.status)) throw error;
          return { key: task.key, detail: null };
        }
      }),
    );
    for (const res of results) {
      metadataCache.set(res.key, res.detail);
    }
    if (i + concurrency < pendingToFetch.length && batchPauseMs > 0) {
      const remaining = enrichBudgetMs - (Date.now() - startedAt);
      if (remaining > batchPauseMs) await delay(batchPauseMs);
    }
  }

  return records.map((record) => applyDetail(record, metadataCache.get(postKey(record)) ?? null, settings));
}

export async function collectSelectedData(
  gateway,
  owner,
  settings,
  {
    checkActive = () => {},
    pagePauseMs = 150,
    progress = () => {},
    cache,
    previous,
    concurrency = 6,
    batchPauseMs = 120,
    enrichBudgetMs,
  } = {},
) {
  const isIncremental = Boolean(previous?.records?.length);
  const budgetMs = enrichBudgetMs ?? (isIncremental ? 4200 : 8000);
  const collected = [];
  let newRecordCount = 0;

  async function* pages(first, maxPages = 3) {
    let current = first;
    const seen = new Set();
    let count = 0;
    while (current !== null && count < maxPages) {
      checkActive();
      if (seen.has(current)) throw new HistoryError('知乎返回了重复分页，同步已停止。');
      seen.add(current);
      const result = await gateway.request(current);
      if (!Array.isArray(result?.data)) throw new HistoryError('知乎列表字段发生变化，请检查取数适配。');
      yield result.data;
      count += 1;
      current = nextPage(result.paging, current);
      if (current !== null && count < maxPages && pagePauseMs > 0) await delay(pagePauseMs);
    }
  }

  if (settings.history) {
    const history = new Map();
    const seenPosts = new Set();
    const known = new Map();
    let watermark = null;

    for (const record of Array.isArray(previous?.records) ? previous.records : []) {
      if (!record || record.contentId == null || !record.contentType) continue;
      const at = readTimestamp(record);
      if (at != null && (watermark == null || at < watermark)) watermark = at;
      known.set(postKey(record), record);
    }

    let offset = '0';
    const seenOffsets = new Set();
    let reachedFrontier = false;
    let pageCalls = 0;

    while (offset !== null && history.size < HISTORY_LIMIT && !reachedFrontier && pageCalls < 4) {
      checkActive();
      if (seenOffsets.has(offset)) throw new HistoryError('知乎返回了重复历史分页，同步已停止。');
      seenOffsets.add(offset);
      pageCalls += 1;

      const result = await gateway.request(`/api/v4/unify-consumption/read_history?offset=${offset}&limit=50`);
      if (!Array.isArray(result?.data)) throw new HistoryError('知乎历史字段发生变化，请检查取数适配。');
      const sorted = result.data
        .map(normalizeHistoryItem)
        .sort((a, b) => (readTimestamp(b) || 0) - (readTimestamp(a) || 0));

      const freshCandidates = [];
      for (const record of sorted) {
        if (record.contentType === 'profile') continue;
        const key = postKey(record);
        if (seenPosts.has(key)) continue;
        seenPosts.add(key);

        const carried = known.get(key);
        if (carried) {
          if (carried.analysis?.decision === 'exclude') {
            collected.push(carried);
            continue;
          }
          history.set(key, carried);
          progress('history', history.size);
          if (history.size === HISTORY_LIMIT) break;
          continue;
        }

        const at = readTimestamp(record);
        if (watermark != null && at != null && at < watermark) {
          reachedFrontier = true;
          break;
        }
        freshCandidates.push(record);
        if (history.size + freshCandidates.length >= HISTORY_LIMIT + 10) break;
      }

      if (freshCandidates.length > 0) {
        const enrichedList = await enrichBatch(freshCandidates, gateway, settings, {
          checkActive,
          cache,
          concurrency,
          batchPauseMs,
          enrichBudgetMs: budgetMs,
        });
        for (const enriched of enrichedList) {
          if (!eligibleHistory(enriched)) continue;
          const reviewed = reviewRecord(enriched, settings);
          if (!policyAllows(reviewed, settings)) {
            collected.push(reviewed);
            continue;
          }
          const key = postKey(reviewed);
          if (!history.has(key)) {
            history.set(key, reviewed);
            newRecordCount += 1;
            progress('history', history.size);
            if (history.size === HISTORY_LIMIT) break;
          }
        }
      }

      if (history.size === HISTORY_LIMIT || reachedFrontier) break;
      offset = nextHistoryOffset(result.paging);
      if (offset !== null && pagePauseMs > 0) await delay(pagePauseMs);
    }

    // 增量同步时，若新记录不足 50 条则用上次已采集的旧记录补齐窗口
    if (history.size < HISTORY_LIMIT && known.size) {
      const older = [...known.values()].sort((a, b) => (readTimestamp(b) || 0) - (readTimestamp(a) || 0));
      for (const record of older) {
        const key = postKey(record);
        if (seenPosts.has(key) || record.analysis?.decision === 'exclude' || !eligibleHistory(record)) continue;
        seenPosts.add(key);
        history.set(key, record);
        if (history.size === HISTORY_LIMIT) break;
      }
    }
    collected.push(...newestHistory([...history.values()]));
  }

  if (settings.likes) {
    const rawLikes = new Map();
    const slug = encodeURIComponent(owner.slug);
    for await (const page of pages(`/api/v3/moments/${slug}/activities?limit=20&desktop=true`, 2)) {
      for (const event of activities(page)) {
        if (!LIKE_VERBS.has(event.verb) || !event.target?.id) continue;
        const actor = event.actor;
        if (actor?.id && String(actor.id) !== owner.id && actor.url_token !== owner.slug) continue;
        const record = normalizePost(event.target, 'likes', event.created_time ?? null);
        if (!rawLikes.has(postKey(record))) rawLikes.set(postKey(record), record);
      }
    }
    const enrichedLikes = await enrichBatch([...rawLikes.values()], gateway, settings, {
      checkActive,
      cache,
      concurrency,
      batchPauseMs,
      enrichBudgetMs: Math.min(budgetMs, 3500),
    });
    for (const item of enrichedLikes) {
      collected.push(reviewRecord(item, settings));
      progress('likes', collected.length);
    }
  }

  if (settings.collections) {
    const rawFavs = new Map();
    const slug = encodeURIComponent(owner.slug);
    for await (const lists of pages(`/api/v4/people/${slug}/collections?offset=0&limit=10`, 1)) {
      for (const list of lists.slice(0, 3)) {
        if (list.id == null) continue;
        if (list.creator?.id && String(list.creator.id) !== owner.id && list.creator.url_token !== owner.slug) continue;
        for await (const page of pages(`/api/v4/collections/${encodeURIComponent(list.id)}/items?offset=0&limit=20`, 1)) {
          for (const item of page) {
            if (!item?.content?.id) continue;
            const record = normalizePost(item.content, 'collections', item.created ?? null);
            if (!rawFavs.has(postKey(record))) rawFavs.set(postKey(record), record);
          }
        }
      }
    }
    const enrichedFavs = await enrichBatch([...rawFavs.values()], gateway, settings, {
      checkActive,
      cache,
      concurrency,
      batchPauseMs,
      enrichBudgetMs: Math.min(budgetMs, 3500),
    });
    for (const item of enrichedFavs) {
      collected.push(reviewRecord(item, settings));
      progress('collections', collected.length);
    }
  }

  return {
    items: collected,
    newRecordCount,
    mode: isIncremental ? 'incremental' : 'initial',
  };
}
