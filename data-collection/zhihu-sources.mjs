import { HistoryError, contentMetadata, normalizeHistoryItem, normalizePost, nextHistoryOffset, plainText } from './history-data.mjs';
import { eligibleHistory, HISTORY_LIMIT, newestHistory, postKey, readTimestamp } from './record-ranking.mjs';
import { policyAllows, reviewRecord } from './content-policy.mjs';

const LIKE_VERBS = new Set(['ANSWER_VOTE_UP', 'MEMBER_VOTEUP_ANSWER', 'MEMBER_VOTEUP_ARTICLE', 'MEMBER_VOTE_PIN', 'PIN_LIKE', 'MEMBER_LIKE_PIN']);

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

export async function collectSelectedData(gateway, owner, settings, { checkActive, pause, progress, analyze }) {
  const metadataCache = new Map();
  const collected = [];

  async function* pages(first) {
    let path = first;
    const seen = new Set();
    while (path !== null) {
      checkActive();
      if (seen.has(path)) throw new HistoryError('知乎返回了重复分页，同步已停止。');
      seen.add(path);
      const result = await gateway.request(path);
      if (!Array.isArray(result?.data)) throw new HistoryError('知乎列表字段发生变化，请检查取数适配。');
      yield result.data;
      path = nextPage(result.paging, path);
      if (path !== null) await pause();
    }
  }

  async function enrich(record) {
    const key = postKey(record);
    if (!metadataCache.has(key)) {
      let detail = null;
      const id = encodeURIComponent(record.contentId);
      const paths = {
        answer: `/api/v4/answers/${id}?include=content,excerpt,voteup_count,comment_count,question.topics`,
        article: `https://zhuanlan.zhihu.com/api/articles/${id}`,
        pin: `/api/v4/pins/${id}?include=topics`,
      };
      if (paths[record.contentType] && (settings.aiReview || record.voteCount == null || record.commentCount == null || !record.topics?.length)) {
        checkActive();
        await pause();
        try {
          detail = await gateway.request(paths[record.contentType], { optional: true });
        } catch (error) {
          if ([401, 429].includes(error.status)) throw error;
        }
      }
      metadataCache.set(key, detail?.id ? detail : null);
    }
    const detail = metadataCache.get(key);
    if (!detail) return { ...record, bodyStatus: 'unavailable', metadataStatus: record.voteCount != null && record.commentCount != null ? 'available' : 'partial' };
    const metadata = contentMetadata(detail);
    const rawBody = typeof detail.content === 'string' ? detail.content : Array.isArray(detail.content)
      ? detail.content.filter((part) => part.type === 'text' || part.content || part.html).map((part) => part.content || part.html || '').join('\n') : '';
    const bodyText = plainText(rawBody);
    const partial = detail.is_partial_content === true || detail.content_is_truncated === true || detail.can_read === false
      || detail.paid_info?.has_purchased === false || /购买后.{0,10}(?:阅读|查看)|开通会员.{0,10}(?:阅读|查看)|此处为付费内容/.test(bodyText);
    return {
      ...record,
      title: record.title || plainText(detail.title || detail.question?.title || detail.excerpt_title),
      summary: record.summary || plainText(detail.excerpt),
      author: record.author || detail.author?.name || '',
      voteCount: metadata.voteCount ?? record.voteCount,
      commentCount: metadata.commentCount ?? record.commentCount,
      topics: metadata.topics.length ? metadata.topics : record.topics || [],
      metadataStatus: 'available',
      ...(settings.aiReview ? { bodyText, bodyStatus: partial ? 'partial' : bodyText ? 'available' : 'unavailable', bodySource: 'zhihu_api_content' } : {}),
    };
  }

  async function prepare(record) {
    let reviewed = reviewRecord(record, settings);
    if (settings.aiReview && analyze) {
      progress('analysis', collected.length);
      reviewed = await analyze(reviewed);
      checkActive();
    }
    return reviewed;
  }

  if (settings.history) {
    const history = new Map();
    const seenPosts = new Set();
    let offset = '0';
    const seen = new Set();
    while (offset !== null && history.size < HISTORY_LIMIT) {
      checkActive();
      if (seen.has(offset)) throw new HistoryError('知乎返回了重复历史分页，同步已停止。');
      seen.add(offset);
      const result = await gateway.request(`/api/v4/unify-consumption/read_history?offset=${offset}&limit=50`);
      if (!Array.isArray(result?.data)) throw new HistoryError('知乎历史字段发生变化，请检查取数适配。');
      const sorted = result.data.map(normalizeHistoryItem).sort((a, b) => (readTimestamp(b) || 0) - (readTimestamp(a) || 0));
      for (const record of sorted) {
        if (record.contentType === 'profile' || seenPosts.has(postKey(record))) continue;
        seenPosts.add(postKey(record));
        const enriched = await enrich(record);
        if (!eligibleHistory(enriched)) continue;
        const reviewed = await prepare(enriched);
        if (!policyAllows(reviewed, settings)) { collected.push(reviewed); continue; }
        history.set(postKey(reviewed), reviewed);
        progress('history', history.size);
        if (history.size === HISTORY_LIMIT) break;
      }
      if (history.size === HISTORY_LIMIT) break;
      offset = nextHistoryOffset(result.paging);
      if (offset !== null) await pause();
    }
    collected.push(...newestHistory([...history.values()]));
  }

  if (settings.likes) {
    const likes = new Map();
    const slug = encodeURIComponent(owner.slug);
    for await (const page of pages(`/api/v3/moments/${slug}/activities?limit=20&desktop=true`)) {
      for (const event of activities(page)) {
        if (!LIKE_VERBS.has(event.verb) || !event.target?.id) continue;
        const actor = event.actor;
        if (actor?.id && String(actor.id) !== owner.id && actor.url_token !== owner.slug) continue;
        const record = normalizePost(event.target, 'likes', event.created_time ?? null);
        if (likes.has(postKey(record))) continue;
        likes.set(postKey(record), await prepare(await enrich(record)));
        progress('likes', likes.size);
      }
    }
    collected.push(...likes.values());
  }

  if (settings.collections) {
    const favorites = new Map();
    const slug = encodeURIComponent(owner.slug);
    for await (const lists of pages(`/api/v4/people/${slug}/collections?offset=0&limit=20`)) {
      for (const list of lists) {
        if (list.id == null) throw new HistoryError('知乎收藏夹缺少标识。');
        if (list.creator?.id && String(list.creator.id) !== owner.id && list.creator.url_token !== owner.slug) continue;
        for await (const page of pages(`/api/v4/collections/${encodeURIComponent(list.id)}/items?offset=0&limit=20`)) {
          for (const item of page) {
            const record = normalizePost(item.content, 'collections', item.created ?? null);
            if (favorites.has(postKey(record))) continue;
            favorites.set(postKey(record), await prepare(await enrich(record)));
            progress('collections', favorites.size);
          }
        }
      }
    }
    collected.push(...favorites.values());
  }
  return collected;
}
