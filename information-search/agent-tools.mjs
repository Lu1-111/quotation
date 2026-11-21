import { fileURLToPath } from 'node:url';
import { createOfficialClient, createDemoClient, SearchError } from './official-client.mjs';
import { createInformationSearch } from './search.mjs';
import { createSearchStore } from './store.mjs';
import { getToolDefinitions, toolSchemas } from './tool-schemas.mjs';

export { getToolDefinitions } from './tool-schemas.mjs';

const failure = (code, message, retryable = false) => ({ schemaVersion: 1, ok: false, data: null, error: { code, message, retryable } });
const safeMessages = {
  NOT_CONFIGURED: '尚未配置知乎 Access Secret，请由宿主在本机配置。',
  UPSTREAM_AUTH: '知乎凭证无效或权限不足，请检查宿主配置。',
  RATE_LIMITED: '知乎搜索频率或额度受限，请稍后重试或检查额度。',
  NETWORK_ERROR: '连接知乎失败或超时。',
  INVALID_RESPONSE: '知乎返回非预期结果，暂时无法完成搜索。',
  UPSTREAM_PARAMETERS: '知乎拒绝了搜索参数，请调整条件。',
  UPSTREAM_ERROR: '知乎搜索暂时不可用。',
};

function pageOf(snapshot, { offset = 0, limit, excerptMaxChars }) {
  const items = snapshot.items.slice(offset, offset + limit).map((item) => {
    const excerpt = [...item.excerpt];
    return { key: item.key, contentId: item.contentId, contentType: item.contentType, title: item.title,
      excerpt: excerpt.slice(0, excerptMaxChars).join(''), excerptTruncated: excerpt.length > excerptMaxChars,
      textKind: item.textKind, fullTextAvailable: item.fullTextAvailable, platformTags: item.platformTags,
      url: item.url, canonicalUrl: item.canonicalUrl, author: item.author, voteCount: item.voteCount, commentCount: item.commentCount,
      rankingScore: item.rankingScore, createdTime: item.createdTime, editedTime: item.editedTime,
      matchedQueries: item.matchedQueries, matches: item.matches };
  });
  const hasMore = offset + items.length < snapshot.items.length;
  return { requestId: snapshot.requestId, provider: snapshot.provider, createdAt: snapshot.createdAt, criteria: snapshot.criteria,
    queryPlan: snapshot.queryPlan, coverage: snapshot.coverage, stats: snapshot.stats, contentTrust: 'external_untrusted',
    page: { offset, limit, total: snapshot.items.length, returned: items.length, hasMore, nextOffset: hasMore ? offset + items.length : null }, items };
}

export function createAgentTools({ service, store, configured = false, demo = false, timeoutMs = 90_000, closeStore = false } = {}) {
  if (!service?.search || !store?.get) throw new TypeError('Agent 工具需要搜索服务和结果存储。');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError('工具超时需为 1 到 300000 毫秒。');
  let activeSearch = null;
  let closed = false;
  let closing;
  return {
    definitions: getToolDefinitions(),
    async call(name, argumentsValue = {}, { signal } = {}) {
      const tool = Object.hasOwn(toolSchemas, name) && toolSchemas[name];
      if (!tool) return failure('UNKNOWN_TOOL', '未知的知乎搜索工具。');
      if (closed) return failure('CLOSED', '知乎搜索工具已关闭，请由宿主重新创建。');
      let input = argumentsValue;
      if (typeof input === 'string') {
        try { if (Buffer.byteLength(input) > 16_384) throw new Error(); input = JSON.parse(input); }
        catch { return failure('INVALID_ARGUMENTS', '工具参数必须是有效且不超过 16 KB 的 JSON 对象。'); }
      }
      const parsed = tool.input.safeParse(input);
      if (!parsed.success) return failure('INVALID_ARGUMENTS', '工具参数不符合 inputSchema，请检查字段名称、类型、范围和必填项。');
      let task;
      try {
        signal?.throwIfAborted();
        let data;
        if (name === 'zhihu_search_status') {
          data = { configured: Boolean(configured), demo, busy: Boolean(activeSearch), persistentResults: true,
            capabilities: { keywordSearch: true, localTagTextMatching: true, platformTopicFilter: false, fullText: false, upstreamPagination: false },
            limits: { countPerQuery: 10, maxQueries: 6, defaultMaxQueries: 2, pageSize: 20, defaultPageSize: 8, timeoutMs } };
        } else if (name === 'zhihu_get_search_result') {
          const snapshot = store.get(parsed.data.requestId);
          if (!snapshot) return failure('NOT_FOUND', '未找到该 requestId 对应的本地搜索结果。');
          data = pageOf(snapshot, parsed.data);
        } else {
          if (activeSearch) return failure('BUSY', '已有搜索正在执行，请稍后重试。', true);
          if (!configured) return failure('NOT_CONFIGURED', safeMessages.NOT_CONFIGURED);
          const controller = new AbortController();
          let finish;
          task = { controller, done: new Promise((resolve) => { finish = resolve; }), finish: () => finish() };
          task.signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
          activeSearch = task;
          const { limit, excerptMaxChars, refresh, ...criteria } = parsed.data;
          const snapshot = await service.search(criteria, { signal: task.signal, refresh });
          task.signal.throwIfAborted();
          data = pageOf(snapshot, { limit, excerptMaxChars });
        }
        return tool.output.parse({ schemaVersion: 1, ok: true, data, error: null });
      } catch (error) {
        if (task?.signal.aborted || signal?.aborted) {
          return task?.signal.reason?.name === 'TimeoutError' ? failure('TIMEOUT', '搜索超过工具执行时限，已中止；可减少查询预算后重试。', true)
            : failure('CANCELLED', '搜索已取消，未完成的结果不会作为成功结果返回。');
        }
        if (error instanceof SearchError) {
          if (error.code === 'INVALID_CRITERIA') return failure(error.code, '搜索条件无效：至少提供一种条件，并遵守查询组合长度限制。');
          return failure(error.code in safeMessages ? error.code : 'UPSTREAM_ERROR', safeMessages[error.code] || safeMessages.UPSTREAM_ERROR,
            ['NETWORK_ERROR', 'UPSTREAM_ERROR', 'INVALID_RESPONSE'].includes(error.code));
        }
        return failure('INTERNAL_ERROR', '搜索工具内部处理失败，请检查宿主运行环境。');
      } finally {
        if (task) { activeSearch = null; task.finish(); }
      }
    },
    close() {
      return closing ??= (async () => {
        closed = true;
        const task = activeSearch;
        task?.controller.abort();
        if (task) await task.done;
        if (closeStore) store.close();
      })();
    },
  };
}

export function createLocalAgentTools({ accessSecret = process.env.ZHIHU_ACCESS_SECRET, demo = false,
  dataFile = process.env.DATA_FILE || fileURLToPath(new URL(demo ? './.data/demo.sqlite' : './.data/search.sqlite', import.meta.url)), timeoutMs = 90_000 } = {}) {
  const client = demo ? createDemoClient() : createOfficialClient({ accessSecret });
  const store = createSearchStore(dataFile);
  try {
    const service = createInformationSearch({ client, store, demo });
    return createAgentTools({ service, store, configured: client.configured, demo, timeoutMs, closeStore: true });
  } catch (error) { store.close(); throw error; }
}
