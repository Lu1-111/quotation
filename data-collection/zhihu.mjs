const AUTH_ORIGIN = 'https://openapi.zhihu.com';
const DATA_ORIGIN = 'https://developer.zhihu.com';

export class ZhihuError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

async function requestJson(url, options, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ZhihuError('连接知乎失败，请稍后重试。');
  }
  if ([401, 403].includes(response.status)) {
    throw new ZhihuError('知乎拒绝了请求，请检查应用权限或重新授权。', 403);
  }
  if (response.status === 429) throw new ZhihuError('知乎接口暂时限流，请稍后重试。', 429);
  if (!response.ok) throw new ZhihuError(`知乎接口返回 HTTP ${response.status}。`);

  try {
    return JSON.parse(await response.text(), (key, value, context) => {
      if (key === 'uid' && typeof value === 'number') return context.source;
      return value;
    });
  } catch {
    throw new ZhihuError('知乎返回的数据无法解析。');
  }
}

function oauthResult(body) {
  if (!body || (body.code !== undefined && ![0, 20000].includes(body.code))) {
    throw new ZhihuError('知乎授权请求失败，请重新连接。', 403);
  }
  return body.data ?? body;
}

function normalizeContent(item) {
  let url = null;
  try {
    const parsed = new URL(item.Url);
    if (parsed.protocol === 'https:' && (parsed.hostname === 'zhihu.com' || parsed.hostname.endsWith('.zhihu.com'))) {
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      url = parsed.href;
    }
  } catch {
    // Some upstream items do not have a usable link.
  }
  return {
    type: item.ContentType ?? null,
    title: typeof item.Title === 'string' ? item.Title : '',
    summary: typeof item.Summary === 'string' ? item.Summary : '',
    url,
    createdAt: Number.isFinite(item.CreatedAt) ? item.CreatedAt : null,
    ...(Number.isFinite(item.FavTime) ? { favoritedAt: item.FavTime } : {}),
    likeCount: Number.isFinite(item.LikeCount) ? item.LikeCount : null,
    commentCount: Number.isFinite(item.CommentCount) ? item.CommentCount : null,
    favoriteCount: Number.isFinite(item.FavoriteCount) ? item.FavoriteCount : null,
  };
}

export function createZhihu({ appId, appKey, accessSecret, redirectUri, fetchImpl = fetch }) {
  const ready = Boolean(appId && appKey && accessSecret);

  async function userData(path, query, token) {
    const url = new URL(`/api/v1/user/${path}`, DATA_ORIGIN);
    url.search = new URLSearchParams(query);
    const body = await requestJson(url, {
      headers: {
        Authorization: `Bearer ${accessSecret}`,
        'X-OAuth-Token': token,
        'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    }, fetchImpl);
    if (body?.Code === 20001) throw new ZhihuError('知乎拒绝读取用户数据，请检查权限或重新授权。', 403);
    if ([30001, 30002].includes(body?.Code)) throw new ZhihuError('知乎接口频率或额度已达上限。', 429);
    if (body?.Code !== 0 || !Array.isArray(body.Data?.Items)) {
      throw new ZhihuError('知乎用户数据接口返回了非预期结果。');
    }
    return body.Data;
  }

  async function getCreations(token) {
    const items = [];
    const seenOffsets = new Set();
    let offset = '0';
    while (true) {
      seenOffsets.add(offset);
      const data = await userData('contents', {
        ContentType: 'all', SortField: 'ts', SortOrder: 'desc', Offset: offset, Limit: '50',
      }, token);
      items.push(...data.Items.map(normalizeContent));
      if (data.Paging?.IsEnd === true) return items;
      offset = String(data.Paging?.NextOffset ?? '');
      if (data.Paging?.IsEnd !== false || !/^\d+$/.test(offset) || seenOffsets.has(offset)) {
        throw new ZhihuError('知乎创作列表返回了无效的分页游标。');
      }
    }
  }

  return {
    ready,
    authorizeUrl(state) {
      const url = new URL('/authorize', AUTH_ORIGIN);
      url.search = new URLSearchParams({ app_id: appId, redirect_uri: redirectUri, response_type: 'code', state });
      return url.href;
    },
    async exchange(code) {
      const body = await requestJson(new URL('/access_token', AUTH_ORIGIN), {
        method: 'POST',
        body: new URLSearchParams({
          app_id: appId, app_key: appKey, grant_type: 'authorization_code', redirect_uri: redirectUri, code,
        }),
      }, fetchImpl);
      const grant = oauthResult(body);
      const lifetime = Number(grant.expires_in);
      if (typeof grant.access_token !== 'string' || !grant.access_token || !Number.isFinite(lifetime) || lifetime <= 0) {
        throw new ZhihuError('知乎未返回有效的访问令牌。');
      }
      return { token: grant.access_token, expiresAt: Date.now() + lifetime * 1000 };
    },
    async profile(token) {
      const profile = oauthResult(await requestJson(new URL('/user', AUTH_ORIGIN), {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      }, fetchImpl));
      const accountId = typeof profile.uid === 'string' && /^\d+$/.test(profile.uid)
        ? `uid:${profile.uid}`
        : typeof profile.hash_id === 'string' && profile.hash_id ? `hash:${profile.hash_id}` : null;
      if (!accountId) throw new ZhihuError('知乎没有返回可用于绑定账号的用户标识。');
      return { accountId, nickname: typeof profile.fullname === 'string' ? profile.fullname : '' };
    },
    async snapshot(token) {
      const [creations, collection] = await Promise.all([
        getCreations(token),
        userData('collections', { Limit: '50' }, token),
      ]);
      return { creations, collections: collection.Items.map(normalizeContent) };
    },
  };
}

export function createDemoZhihu(redirectUri) {
  const now = Math.floor(Date.now() / 1000);
  return {
    ready: true,
    authorizeUrl(state) {
      const url = new URL(redirectUri);
      url.search = new URLSearchParams({ authorization_code: 'sample', state });
      return url.href;
    },
    async exchange(code) {
      if (code !== 'sample') throw new ZhihuError('演示授权码无效。', 403);
      return { token: 'sample-token', expiresAt: Date.now() + 3_600_000 };
    },
    async profile() {
      return { accountId: 'demo:reader', nickname: '演示读者' };
    },
    async snapshot() {
      return {
        creations: [normalizeContent({
          ContentType: 'article', Title: '怎样把链接整理成可复用的读书笔记',
          Summary: '记录文章的核心观点，再用主题标签串联相关资料。', CreatedAt: now - 86_400,
          LikeCount: 8, CommentCount: 2, FavoriteCount: 3,
        })],
        collections: [normalizeContent({
          ContentType: 'answer', Title: '本地大模型从哪里入门',
          Summary: '从模型大小、硬件需求和推理工具三个维度比较入门路线。',
          CreatedAt: now - 172_800, FavTime: now - 3_600,
          LikeCount: 24, CommentCount: 5, FavoriteCount: 9,
        })],
      };
    },
  };
}
