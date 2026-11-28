// 网站内一体化知乎帖子阅读服务（供「星球探索 · 跃迁」直接站内打开阅览，不跳出外部窗口）：
// - 登录与数据采集模块完全一体化（直接复用 collector.ensureAuthenticatedSession 的知乎账号会话）
// - 以用户自己的知乎账号通过知乎接口读取帖子完整正文、问题背景、话题与互动数据，做安全 HTML 净化后在站内呈现
// - 同时返回可直接写入 user-db.json 的标准用户记录，以便立即触发星图生成流程
import { contentMetadata, contentUrl, plainText } from '../collector/history-data.mjs';

function escapeAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 安全清洗知乎正文 HTML：仅保留可读排版标签（段落/标题/引用/列表/代码/图片），剔除脚本与事件属性，并加 no-referrer 保障知乎图床加载
export function sanitizeZhihuHtml(rawHtml) {
  if (typeof rawHtml !== 'string' || !rawHtml.trim()) return '';
  let html = rawHtml
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi, '$1')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');

  // 规范 img 标签：优先取 data-original / data-actualsrc / src，并添加 referrerpolicy="no-referrer"
  html = html.replace(/<img\b([^>]*)>/gi, (_full, attrs) => {
    const pick = (name) => {
      const m = attrs.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]+)"|'([^']+)')`, 'i'));
      return m?.[1] || m?.[2] || '';
    };
    const src = pick('data-original') || pick('data-actualsrc') || pick('src');
    if (!src || !/^https?:\/\//i.test(src)) return '';
    const alt = pick('alt');
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" loading="lazy" referrerpolicy="no-referrer">`;
  });

  // 规范链接为新标签安全打开，避免把当前星图页带走
  html = html.replace(/<a\b([^>]*)>/gi, (_full, attrs) => {
    const m = attrs.match(/href\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
    const href = m?.[1] || m?.[2] || '';
    if (!href || !/^https?:\/\//i.test(href)) return '<span>';
    return `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">`;
  });

  // 过滤掉除安全排版标签外的其他标签
  const allowed = new Set([
    'p', 'br', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'ul', 'ol', 'li',
    'pre', 'code', 'strong', 'b', 'em', 'i', 'hr', 'figure', 'figcaption', 'img', 'a', 'span',
  ]);
  html = html.replace(/<\/?([a-z0-9]+)\b[^>]*>/gi, (tag, name) => {
    const lower = name.toLowerCase();
    if (!allowed.has(lower)) return '';
    if (lower === 'img' || lower === 'a') return tag;
    return tag.startsWith('</') ? `</${lower}>` : `<${lower}>`;
  });

  return html.trim();
}

function parseIdsFromUrl(url, fallbackType, fallbackId) {
  let contentType = String(fallbackType || '').toLowerCase();
  let contentId = String(fallbackId || '');
  if (typeof url === 'string') {
    const ans = url.match(/\/answer\/(\d+)/);
    if (ans) return { contentType: 'answer', contentId: ans[1] };
    const art = url.match(/zhuanlan\.zhihu\.com\/p\/(\d+)/);
    if (art) return { contentType: 'article', contentId: art[1] };
    const pin = url.match(/\/pin\/(\d+)/);
    if (pin) return { contentType: 'pin', contentId: pin[1] };
    const q = url.match(/\/question\/(\d+)/);
    if (q && (!contentType || contentType === 'question')) return { contentType: 'question', contentId: q[1] };
  }
  return { contentType: contentType || 'answer', contentId };
}

export function createInAppReaderService({ collector }) {
  async function loadPost(target) {
    const { contentType, contentId } = parseIdsFromUrl(target.url, target.contentType, target.contentId);
    const canonicalUrl = contentUrl(target.url, contentType, contentId);

    // 复用采集模块的一体化知乎账号登录会话
    const sess = collector?.ensureAuthenticatedSession
      ? await collector.ensureAuthenticatedSession({ autoOpenHeadless: true })
      : { authenticated: false, account: null, gateway: null };

    const viewer = {
      loggedIn: Boolean(sess.authenticated),
      nickname: sess.account?.nickname || '',
    };

    let detail = null;
    let questionDetailHtml = '';
    let contentHtml = '';
    let bodyText = target.rawExcerpt || target.briefSummary || '';
    let topics = [];
    let voteCount = target.voteCount ?? null;
    let commentCount = target.commentCount ?? null;
    let viewCount = target.viewCount ?? null;
    let author = target.author || '';
    let title = target.title || '';

    if (sess.authenticated && contentId) {
      const idEnc = encodeURIComponent(contentId);
      try {
        if (contentType === 'answer') {
          detail = await sess.gateway.request(
            `/api/v4/answers/${idEnc}?include=content,excerpt,voteup_count,comment_count,question.title,question.detail,question.topics,author`,
            { optional: true, timeoutMs: 12_000 },
          );
          if (detail) {
            title = plainText(detail.question?.title || detail.title) || title;
            questionDetailHtml = sanitizeZhihuHtml(detail.question?.detail || '');
            contentHtml = sanitizeZhihuHtml(detail.content || '');
            bodyText = plainText(detail.content || detail.excerpt || '') || bodyText;
            author = detail.author?.name || author;
            const meta = contentMetadata(detail);
            voteCount = meta.voteCount ?? voteCount;
            commentCount = meta.commentCount ?? commentCount;
            topics = meta.topics;
          }
        } else if (contentType === 'article') {
          detail = await sess.gateway.request(`https://zhuanlan.zhihu.com/api/articles/${idEnc}`, {
            optional: true,
            timeoutMs: 12_000,
          });
          if (detail) {
            title = plainText(detail.title) || title;
            contentHtml = sanitizeZhihuHtml(detail.content || '');
            bodyText = plainText(detail.content || detail.excerpt || '') || bodyText;
            author = detail.author?.name || author;
            const meta = contentMetadata(detail);
            voteCount = meta.voteCount ?? voteCount;
            commentCount = meta.commentCount ?? commentCount;
            topics = meta.topics;
          }
        } else if (contentType === 'question') {
          detail = await sess.gateway.request(
            `/api/v4/questions/${idEnc}?include=detail,excerpt,answer_count,follower_count,visit_count,topics`,
            { optional: true, timeoutMs: 12_000 },
          );
          const topAns = await sess.gateway
            .request(
              `/api/v4/questions/${idEnc}/answers?limit=1&offset=0&sort_by=default&include=content,excerpt,voteup_count,comment_count,author`,
              { optional: true, timeoutMs: 12_000 },
            )
            .catch(() => null);
          const best = topAns?.data?.[0];
          if (detail) {
            title = plainText(detail.title) || title;
            questionDetailHtml = sanitizeZhihuHtml(detail.detail || '');
            viewCount = Number.isFinite(Number(detail.visit_count)) ? Number(detail.visit_count) : viewCount;
            const meta = contentMetadata(detail);
            topics = meta.topics;
          }
          if (best) {
            contentHtml = sanitizeZhihuHtml(best.content || '');
            bodyText = plainText(best.content || best.excerpt || '') || bodyText;
            author = best.author?.name || author;
            voteCount = best.voteup_count ?? voteCount;
            commentCount = best.comment_count ?? commentCount;
          }
        } else if (contentType === 'pin') {
          detail = await sess.gateway.request(`/api/v4/pins/${idEnc}?include=topics`, {
            optional: true,
            timeoutMs: 12_000,
          });
          if (detail) {
            const rawParts = Array.isArray(detail.content)
              ? detail.content.map((p) => p.content || p.html || '').join('<br>')
              : '';
            contentHtml = sanitizeZhihuHtml(rawParts);
            bodyText = plainText(rawParts) || bodyText;
            author = detail.author?.name || author;
            const meta = contentMetadata(detail);
            voteCount = meta.voteCount ?? voteCount;
            commentCount = meta.commentCount ?? commentCount;
            topics = meta.topics;
          }
        }
      } catch {
        // 个别接口受限时仍回退返回搜索节选并提示状态
      }
    }

    if (!contentHtml) {
      const safeParagraph = plainText(bodyText || target.briefSummary || '暂无正文内容。')
        .split(/\n+/)
        .map((line) => `<p>${line.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
        .join('');
      contentHtml = safeParagraph;
    }

    const nowSec = String(Math.floor(Date.now() / 1000));
    const userDbRecord = {
      key: `${contentType}:${contentId}`,
      kind: 'history',
      kinds: ['history', 'warp'],
      contentId,
      contentType,
      title,
      summary: plainText(bodyText).slice(0, 420),
      author,
      url: canonicalUrl,
      topics,
      voteCount,
      commentCount,
      sourceReadTime: nowSec,
      observedAt: new Date().toISOString(),
      weight: 5.5,
      weightDetails: { source: 'planet_exploration_warp' },
      analysis: {
        policyVersion: 'knowledge-v1',
        method: 'warp_exploration',
        decision: 'keep',
        category: '跃迁探索知识帖',
        reason: '用户主动通过星图「跃迁」挑选的高知识价值知乎帖子。',
      },
    };

    return {
      viewer,
      fullContentLoaded: Boolean(detail && contentHtml),
      requiresLogin: !viewer.loggedIn,
      article: {
        key: userDbRecord.key,
        contentId,
        contentType,
        title,
        author,
        url: canonicalUrl,
        voteCount,
        commentCount,
        viewCount,
        topics: topics.map((t) => t.name).filter(Boolean),
        questionDetailHtml,
        contentHtml,
        briefSummary: target.briefSummary || '',
        knowledgeGain: target.knowledgeGain || '',
      },
      userDbRecord,
    };
  }

  return { loadPost };
}
