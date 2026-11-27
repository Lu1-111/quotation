export const SEARCH_ENDPOINT = 'https://developer.zhihu.com/api/v1/content/zhihu_search';

export class SearchError extends Error {
  constructor(message, status = 502, code = 'UPSTREAM_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function plainText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_all, code) => {
      const number = /^x/i.test(code) ? parseInt(code.slice(1), 16) : Number(code);
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
    }).replace(/\s+/g, ' ').trim();
}

export function parseLossless(text) {
  return JSON.parse(text, (_key, value, context) => typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) ? context.source : value);
}

function count(value) {
  return value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
}

export function normalizeItem(item) {
  if (!['string', 'number'].includes(typeof item?.ContentID) || !String(item.ContentID).trim() || typeof item.ContentType !== 'string' || !item.ContentType.trim() || typeof item.Title !== 'string') {
    throw new SearchError('官方搜索结果字段不完整，请检查接口适配。', 502, 'INVALID_RESPONSE');
  }
  let url = null;
  let canonicalUrl = null;
  try {
    const parsed = new URL(item.Url);
    if (parsed.protocol === 'https:' && (parsed.hostname === 'zhihu.com' || parsed.hostname.endsWith('.zhihu.com'))) {
      parsed.username = ''; parsed.password = ''; parsed.hash = '';
      url = parsed.href;
      parsed.search = '';
      canonicalUrl = parsed.href;
    }
  } catch {}
  const contentId = String(item.ContentID);
  const contentType = item.ContentType.toLowerCase();
  return {
    key: `${contentType}:${contentId}`, contentId, contentType, title: plainText(item.Title),
    excerpt: plainText(item.ContentText), textKind: 'excerpt', fullTextAvailable: false,
    url, canonicalUrl, author: plainText(item.AuthorName), authorBadge: plainText(item.AuthorBadgeText),
    voteCount: count(item.VoteUpCount), commentCount: count(item.CommentCount),
    createdTime: item.CreateTime == null ? null : String(item.CreateTime),
    editedTime: item.EditTime == null ? null : String(item.EditTime),
    authorityLevel: item.AuthorityLevel == null ? null : String(item.AuthorityLevel),
    rankingScore: item.RankingScore != null && Number.isFinite(Number(item.RankingScore)) ? Number(item.RankingScore) : null,
    selectedComments: Array.isArray(item.CommentInfoList) ? item.CommentInfoList.map((comment) => plainText(comment.Content)).filter(Boolean) : [],
    platformTags: null,
  };
}

export function createOfficialClient({ accessSecret, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  return {
    configured: Boolean(accessSecret),
    async search(query, limit = 10, { signal, sortBy } = {}) {
      if (!accessSecret) throw new SearchError('尚未配置知乎 Access Secret，请在本机 .env 中填写。', 503, 'NOT_CONFIGURED');
      if (typeof query !== 'string' || !query.trim() || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new SearchError('关键词不能为空，单查询数量必须为 1 到 10。', 400, 'INVALID_CRITERIA');
      const url = new URL(SEARCH_ENDPOINT);
      url.search = new URLSearchParams({ Query: query, Count: String(limit) });
      if (sortBy) url.searchParams.set('SortBy', sortBy);
      let response;
      try {
        response = await fetchImpl(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
          headers: { Authorization: `Bearer ${accessSecret}`, 'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)), 'Content-Type': 'application/json', Accept: 'application/json' } });
      } catch {
        if (signal?.aborted) throw signal.reason;
        throw new SearchError('连接知乎官方搜索接口失败或超时。', 502, 'NETWORK_ERROR');
      }
      if ([401, 403].includes(response.status)) throw new SearchError('知乎凭证无效或权限不足。', 401, 'UPSTREAM_AUTH');
      if (response.status === 429) throw new SearchError('知乎搜索频率或额度受限，请稍后再试。', 429, 'RATE_LIMITED');
      if (!response.ok) throw new SearchError(`知乎搜索返回 HTTP ${response.status}。`);
      let body;
      try {
        const parts = []; let bytes = 0;
        for await (const part of response.body) {
          bytes += part.byteLength;
          if (bytes > 4_000_000) throw new Error();
          parts.push(part);
        }
        body = parseLossless(Buffer.concat(parts).toString('utf8'));
      } catch {
        if (signal?.aborted) throw signal.reason;
        throw new SearchError('知乎搜索响应无法解析或超过大小限制。', 502, 'INVALID_RESPONSE');
      }
      if (body?.Code === 20001) throw new SearchError('知乎凭证无效或权限不足。', 401, 'UPSTREAM_AUTH');
      if ([30001, 30002].includes(body?.Code)) throw new SearchError('知乎搜索频率或额度受限，请稍后再试。', 429, 'RATE_LIMITED');
      if (body?.Code === 10001) throw new SearchError('知乎拒绝了搜索参数。', 400, 'UPSTREAM_PARAMETERS');
      if (body?.Code !== 0 || !Array.isArray(body.Data?.Items) || typeof body.Data.HasMore !== 'boolean') throw new SearchError('知乎返回非预期搜索结果。', 502, 'INVALID_RESPONSE');
      return { query, searchHashId: body.Data.SearchHashId == null ? null : String(body.Data.SearchHashId),
        hasMore: body.Data.HasMore, emptyReason: plainText(body.Data.EmptyReason), items: body.Data.Items.map(normalizeItem) };
    },
  };
}

export function createDemoClient() {
  return { configured: true, async search(query, limit, { signal } = {}) {
    signal?.throwIfAborted();
    const rows = [
      { ContentID: '1001', ContentType: 'Article', Title: 'RAG 评测与人工智能检索实践', ContentText: '介绍 RAG 检索评测方法、人工智能知识库和实验指标。', VoteUpCount: 24, CommentCount: 3 },
      { ContentID: '1002', ContentType: 'Answer', Title: 'Python 数据处理方法', ContentText: '用 Python 清洗数据、整理表格和比较运行结果。', VoteUpCount: 12, CommentCount: 2 },
      { ContentID: '1003', ContentType: 'Question', Title: '怎样学习人工智能', ContentText: '讨论人工智能、机器学习与知识检索的学习路径。', VoteUpCount: 4, CommentCount: 1 },
    ];
    const terms = query.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean);
    const items = rows.filter((row) => terms.some((term) => `${row.Title} ${row.ContentText}`.normalize('NFKC').toLowerCase().includes(term))).slice(0, limit).map((row) => normalizeItem({
      ...row, Url: row.ContentType === 'Article' ? `https://zhuanlan.zhihu.com/p/${row.ContentID}?utm_source=demo` : `https://www.zhihu.com/${row.ContentType.toLowerCase()}/${row.ContentID}?utm_source=demo`, AuthorName: '示例作者', RankingScore: 0.9,
    }));
    return { query, searchHashId: 'demo-search', hasMore: false, emptyReason: '', items };
  } };
}
