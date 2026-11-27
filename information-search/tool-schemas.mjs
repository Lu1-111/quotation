import * as z from 'zod/v4';

const termList = z.array(z.string().trim().min(1).max(60)).max(8).default([]);
const contentTypes = z.array(z.enum(['article', 'answer', 'question', 'pin', 'zvideo'])).max(5).default([]);
const pageInput = {
  limit: z.number().int().min(1).max(20).default(8).describe('本次向模型返回的条数；其余已保存结果可按 requestId 分批读取。'),
  excerptMaxChars: z.number().int().min(100).max(4000).default(1000).describe('每条摘要返回的最多字符数；这是摘要裁剪，不会补取全文。'),
};

const errorSchema = z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).strict();
const record = z.record(z.string(), z.unknown());
const itemSchema = z.object({
  key: z.string(), contentId: z.string(), contentType: z.string(), title: z.string(), excerpt: z.string(), excerptTruncated: z.boolean(),
  textKind: z.literal('excerpt'), fullTextAvailable: z.literal(false), platformTags: z.null(),
  url: z.string().nullable(), canonicalUrl: z.string().nullable(), author: z.string(),
  voteCount: z.number().nullable(), commentCount: z.number().nullable(), rankingScore: z.number().nullable(),
  createdTime: z.string().nullable(), editedTime: z.string().nullable(),
  matchedQueries: z.array(z.string()), matches: z.object({
    accepted: z.boolean(), keywords: z.array(z.string()), tags: z.array(z.string()), tagSource: z.literal('local_title_excerpt_match'),
    evidence: z.array(z.object({ kind: z.enum(['keyword', 'tagText']), term: z.string(), fields: z.array(z.enum(['title', 'excerpt'])) }).strict()),
  }).strict(),
}).strict();

const resultsDataSchema = z.object({
  requestId: z.string().uuid(), provider: z.string(), createdAt: z.string(), criteria: record, queryPlan: record, coverage: record, stats: record,
  contentTrust: z.literal('external_untrusted'),
  page: z.object({ offset: z.number().int(), limit: z.number().int(), total: z.number().int(), returned: z.number().int(), nextOffset: z.number().int().nullable(), hasMore: z.boolean() }).strict(),
  items: z.array(itemSchema),
}).strict();
const statusDataSchema = z.object({
  configured: z.boolean(), demo: z.boolean(), busy: z.boolean(), persistentResults: z.boolean(),
  capabilities: z.object({ keywordSearch: z.literal(true), localTagTextMatching: z.literal(true), platformTopicFilter: z.literal(false), fullText: z.literal(false), upstreamPagination: z.literal(false) }).strict(),
  limits: z.object({ countPerQuery: z.literal(10), maxQueries: z.literal(6), defaultMaxQueries: z.literal(2), pageSize: z.literal(20), defaultPageSize: z.literal(8), timeoutMs: z.number().int() }).strict(),
}).strict();
const envelope = (data) => z.object({ schemaVersion: z.literal(1), ok: z.boolean(), data: data.nullable(), error: errorSchema.nullable() }).strict();

export const toolSchemas = {
  zhihu_search: {
    title: '搜索知乎公开内容',
    description: '通过知乎官方接口搜索公开内容。query 用于召回，keywords 与 tags 在标题、摘要中匹配；tags 不是知乎原生话题。只返回摘要，不获取全文或个人浏览记录。默认最多 2 个查询，每个最多 10 条，使用 5 分钟缓存；返回结果可用 requestId 分批读取。',
    input: z.object({
      query: z.string().max(240).default('').describe('自然语言查询语句；query、keywords、tags 至少提供一种。'),
      keywords: termList.describe('需要在标题或摘要中命中的关键词。'), tags: termList.describe('需要在标题或摘要中命中的标签词，不是话题 ID。'),
      keywordMode: z.enum(['any', 'all']).default('any'), tagMode: z.enum(['any', 'all']).default('any'),
      contentTypes, countPerQuery: z.number().int().min(1).max(10).default(10),
      maxQueries: z.number().int().min(1).max(6).default(2).describe('本次最多查询次数，缓存命中不消耗上游调用。'),
      sortBy: z.string().min(1).max(100).optional().describe('可选官方排序，如 VoteUpCount:desc 或 CreateTime:desc；不提供时以相关性为主。'),
      refresh: z.boolean().default(false).describe('true 时跳过缓存并可能消耗新额度；不要因空结果反复强制刷新。'),
      ...pageInput,
    }).strict(),
    output: envelope(resultsDataSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  zhihu_get_search_result: {
    title: '读取已保存的搜索结果',
    description: '按 zhihu_search 返回的 requestId 分批读取本地已保存结果，不再次查询知乎。offset 只针对本地快照，不是官方接口分页。',
    input: z.object({ requestId: z.string().uuid(), offset: z.number().int().min(0).max(60).default(0), ...pageInput }).strict(),
    output: envelope(resultsDataSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  zhihu_search_status: {
    title: '检查搜索工具状态',
    description: '检查凭证是否配置、演示模式、搜索忙碌状态和工具限制，不返回密钥，也不调用知乎。',
    input: z.object({}).strict(), output: envelope(statusDataSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
};

export function getToolDefinitions() {
  return Object.entries(toolSchemas).map(([name, tool]) => ({ name, title: tool.title, description: tool.description,
    inputSchema: z.toJSONSchema(tool.input, { io: 'input' }), outputSchema: z.toJSONSchema(tool.output), annotations: { ...tool.annotations } }));
}
