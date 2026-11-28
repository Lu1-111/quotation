// 知乎知识搜索工具（供「星球探索 · 跃迁」等子模块调用）：
// - 优先使用知乎官方公开搜索接口（ZHIHU_ACCESS_SECRET）
// - 若未配置官方搜索密钥，则自动回退到一体化登录态下的知乎网页搜索 API（/api/v4/search_v3）
// - 统一返回规范化的帖子列表，附带赞同/评论/浏览量等互动数据供跃迁 Agent 优选高质量知识内容
import { contentUrl, parseHistoryJson, plainText } from '../collector/history-data.mjs';

export const OFFICIAL_SEARCH_ENDPOINT = 'https://developer.zhihu.com/api/v1/content/zhihu_search';

function toCount(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function normalizeOfficialItem(item) {
  if (!item?.ContentID || !item?.ContentType || typeof item?.Title !== 'string') return null;
  const contentId = String(item.ContentID);
  const contentType = String(item.ContentType).toLowerCase();
  const url = contentUrl(item.Url, contentType, contentId);
  return {
    key: `${contentType}:${contentId}`,
    contentId,
    contentType,
    title: plainText(item.Title),
    excerpt: plainText(item.ContentText || ''),
    url,
    author: plainText(item.AuthorName || ''),
    authorBadge: plainText(item.AuthorBadgeText || ''),
    voteCount: toCount(item.VoteUpCount),
    commentCount: toCount(item.CommentCount),
    viewCount: toCount(item.ViewCount ?? item.ReadCount),
    rankingScore: item.RankingScore != null && Number.isFinite(Number(item.RankingScore)) ? Number(item.RankingScore) : null,
    authorityLevel: item.AuthorityLevel == null ? null : String(item.AuthorityLevel),
    selectedComments: Array.isArray(item.CommentInfoList)
      ? item.CommentInfoList.map((c) => plainText(c?.Content || '')).filter(Boolean).slice(0, 3)
      : [],
    provider: 'official_api',
  };
}

function normalizeWebSearchItem(entry) {
  const obj = entry?.object;
  if (!obj) return null;
  const type = String(obj.type || '').toLowerCase();
  if (!['answer', 'article', 'question', 'pin'].includes(type)) return null;
  const id = String(obj.id || '');
  if (!id) return null;
  const title = plainText(obj.title || obj.question?.name || obj.question?.title || entry?.highlight?.title || '');
  const excerpt = plainText(obj.excerpt || obj.content || entry?.highlight?.description || '');
  if (!title) return null;
  return {
    key: `${type}:${id}`,
    contentId: id,
    contentType: type,
    title,
    excerpt: excerpt.slice(0, 420),
    url: contentUrl(obj.url, type, id),
    author: plainText(obj.author?.name || ''),
    authorBadge: plainText(obj.author?.headline || ''),
    voteCount: toCount(obj.voteup_count ?? obj.like_count),
    commentCount: toCount(obj.comment_count),
    viewCount: toCount(obj.visit_count),
    rankingScore: null,
    authorityLevel: null,
    selectedComments: [],
    provider: 'zhihu_web_session',
  };
}

export function createZhihuSearchTool({ getAccessSecret, collector, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  async function searchOfficial(query, limit, accessSecret, signal) {
    const url = new URL(OFFICIAL_SEARCH_ENDPOINT);
    url.search = new URLSearchParams({ Query: query, Count: String(Math.max(1, Math.min(10, limit))) });
    const response = await fetchImpl(url, {
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${accessSecret}`,
        'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`知乎官方搜索返回 HTTP ${response.status}`);
    }
    const text = await response.text();
    const body = parseHistoryJson(text);
    if (body?.Code !== 0 || !Array.isArray(body?.Data?.Items)) {
      throw new Error(`知乎官方搜索返回异常码 (${body?.Code ?? 'unknown'})`);
    }
    return body.Data.Items.map(normalizeOfficialItem).filter(Boolean);
  }

  async function searchViaSession(query, limit) {
    if (!collector?.ensureAuthenticatedSession) return [];
    const sess = await collector.ensureAuthenticatedSession({ autoOpenHeadless: true });
    if (!sess.authenticated) return [];
    const path = `/api/v4/search_v3?gk_version=gz-gaokao&t=general&q=${encodeURIComponent(query)}&correction=1&offset=0&limit=${Math.max(1, Math.min(15, limit))}`;
    const data = await sess.gateway.request(path, { optional: true, timeoutMs: 10_000 });
    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows.map(normalizeWebSearchItem).filter(Boolean);
  }

  async function search(query, { limit = 8, signal } = {}) {
    const cleanQuery = String(query || '').replace(/\s+/g, ' ').trim();
    if (!cleanQuery) return { provider: 'none', query: '', items: [] };

    const secret = typeof getAccessSecret === 'function' ? getAccessSecret() : process.env.ZHIHU_ACCESS_SECRET || '';
    if (secret) {
      try {
        const items = await searchOfficial(cleanQuery, limit, secret, signal);
        return { provider: 'official_api', query: cleanQuery, items };
      } catch (err) {
        // 官方搜索限流或异常时，若一体化浏览器会话已登录则无缝回退网页搜索
        const fallbackItems = await searchViaSession(cleanQuery, limit).catch(() => []);
        if (fallbackItems.length > 0) {
          return { provider: 'zhihu_web_session', query: cleanQuery, items: fallbackItems };
        }
        throw err;
      }
    }

    const sessionItems = await searchViaSession(cleanQuery, limit);
    if (sessionItems.length > 0) {
      return { provider: 'zhihu_web_session', query: cleanQuery, items: sessionItems };
    }

    throw new Error('未检测到 ZHIHU_ACCESS_SECRET 且尚未登录知乎会话，无法调用知乎搜索工具。请配置搜索密钥或先在工作台扫码登录知乎。');
  }

  return {
    search,
    hasOfficialSecret: () => Boolean((typeof getAccessSecret === 'function' ? getAccessSecret() : process.env.ZHIHU_ACCESS_SECRET) || ''),
  };
}
