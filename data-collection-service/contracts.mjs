import * as z from 'zod/v4';
import { invalid } from './errors.mjs';

export const defaultSettings = Object.freeze({ history: true, likes: false, collections: false, knowledgeFilter: true, fetchFullText: false, aiReview: false });
// fetchFullText 与 aiReview 解耦：正文获取不依赖模型，开启后也不代表已做模型分析。
export const settingsSchema = z.object({ history: z.boolean(), likes: z.boolean(), collections: z.boolean(), knowledgeFilter: z.boolean(), fetchFullText: z.boolean().default(false), aiReview: z.literal(false) }).strict();
export const syncPlanSchema = z.object({ mode: z.enum(['manual', 'page_interval']), intervalMinutes: z.number().int().min(1).max(1440) }).strict();
export const localConsentSchema = z.object({ consent: z.literal(true), settings: settingsSchema }).strict();
const nullableNumber = z.number().finite().nullable();
const time = z.union([z.string(), z.number(), z.null()]);
const sourceKind = z.enum(['history', 'likes', 'collections']);
const record = z.object({
  key: z.string(), kind: sourceKind.optional(), contentId: z.string(), contentType: z.string(), title: z.string(), summary: z.string(),
  author: z.string().optional(), url: z.string().nullable(), topics: z.array(z.object({ id: z.string().nullable().optional(), name: z.string() })).optional(),
  sourceReadTime: z.string().nullable().optional(), signalTime: time.optional(), observedAt: z.string().optional(),
  voteCount: nullableNumber.optional(), commentCount: nullableNumber.optional(), metricsMissing: z.boolean().optional(),
  bodyText: z.string().optional(), bodyStatus: z.string().optional(), bodySource: z.string().optional(), metadataStatus: z.string().optional(),
  kinds: z.array(sourceKind).optional(), signals: z.array(z.object({ kind: sourceKind, time })).optional(), weight: nullableNumber.optional(),
  weightDetails: z.object({ base: nullableNumber, actionMultiplier: z.number(), engagementBonus: z.number(), similarPostCount: z.number().int().nonnegative(), themeBonus: z.number(), ageDays: nullableNumber, timeFactor: z.number() }).optional(),
  analysis: z.object({ policyVersion: z.string().optional(), inputHash: z.string().optional(), method: z.string(), decision: z.enum(['keep', 'exclude', 'review']),
    category: z.string().optional(), reason: z.string(), domains: z.array(z.string()).optional(), tags: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(), knowledgePoints: z.array(z.string()).optional(), summary: z.string().nullable().optional(), basis: z.string().optional(),
    evidence: z.array(z.unknown()).optional(), confidence: z.number().optional(), coverage: z.record(z.string(), z.unknown()).optional(), agentWarning: z.string().optional() }).optional(),
});
export const snapshotSchema = z.object({ schemaVersion: z.literal(3), source: z.enum(['zhihu_selected_data', 'demo_history']),
  account: z.object({ nickname: z.string() }), syncedAt: z.string().datetime(), policyVersion: z.string(), settings: settingsSchema,
  records: z.array(record), excluded: z.array(record), revision: z.string(),
  counts: z.object({ history: z.number().int().nonnegative(), likes: z.number().int().nonnegative(), collections: z.number().int().nonnegative() }) });
export const deliverySchema = z.object({ schemaVersion: z.literal(1), module: z.literal('data-collection-service'), kind: z.literal('collection_snapshot'),
  userId: z.string().uuid(), snapshotId: z.string().uuid(), deviceId: z.string().uuid(), jobId: z.string().uuid(), receivedAt: z.string().datetime(), snapshot: snapshotSchema }).strict();
export const collectionPageSchema = z.object({ schemaVersion: z.literal(1), module: z.literal('data-collection-service'), kind: z.literal('collection_page'),
  userId: z.string().uuid(), snapshotId: z.string().uuid(), deviceId: z.string().uuid(), jobId: z.string().uuid(), receivedAt: z.string().datetime(),
  metadata: snapshotSchema.omit({ records: true, excluded: true }), excludedCount: z.number().int().nonnegative(),
  page: z.object({ offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(20), total: z.number().int().nonnegative(), returned: z.number().int().nonnegative(), hasMore: z.boolean(), nextOffset: z.number().int().nonnegative().nullable() }),
  items: z.array(record.pick({ key: true, contentId: true, contentType: true, title: true, summary: true, url: true, author: true, kinds: true, observedAt: true,
    sourceReadTime: true, signals: true, topics: true, voteCount: true, commentCount: true, metricsMissing: true, weight: true, weightDetails: true, bodyStatus: true })
    .extend({ summaryTruncated: z.boolean(), ruleDecision: z.enum(['keep', 'exclude', 'review']).optional(), contentTrust: z.literal('external_untrusted') })) }).strict();
export const createJobSchema = z.object({ settings: settingsSchema.optional(), deviceId: z.string().uuid().optional() }).strict();
// 画像协议：只保留用户知识画像所需的语义、行为证据与可核验溯源字段。
export const KNOWLEDGE_PROFILE_PROTOCOL = 'zhihu-knowledge-profile/v1';
export const profileRecordSchema = z.object({
  contentId: z.string(), contentType: z.string(), title: z.string(), summary: z.string(), summaryTruncated: z.boolean(),
  url: z.string().nullable(), author: z.string().nullable(),
  topics: z.array(z.string()), kinds: z.array(sourceKind), signals: z.array(z.object({ kind: sourceKind, time })),
  voteCount: nullableNumber, commentCount: nullableNumber, metricsMissing: z.boolean(),
  weight: nullableNumber, ruleDecision: z.enum(['keep', 'exclude', 'review']).nullable(),
  domains: z.array(z.string()), tags: z.array(z.string()),
  bodyStatus: z.string(), fullTextAvailable: z.boolean(), bodyText: z.string().optional(), bodyChars: z.number().int().nonnegative().optional(), contentTrust: z.literal('external_untrusted'),
}).strict();
export const knowledgeProfileSchema = z.object({
  schemaVersion: z.literal(1), protocolVersion: z.literal(KNOWLEDGE_PROFILE_PROTOCOL), module: z.literal('data-collection-service'),
  kind: z.literal('knowledge_profile_page'), userId: z.string().uuid(), snapshotId: z.string().uuid(),
  syncedAt: z.string().datetime(), policyVersion: z.string(),
  coverage: z.object({ settings: settingsSchema, counts: z.object({ history: z.number().int().nonnegative(), likes: z.number().int().nonnegative(), collections: z.number().int().nonnegative() }),
    excludedCount: z.number().int().nonnegative(), knowledgeFilterApplied: z.boolean(), modelAnalysisApplied: z.literal(false),
    historyScope: z.literal('latest_50_qualified'), completeHistory: z.literal(false), fullTextGuaranteed: z.literal(false) }),
  page: z.object({ offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(20), total: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(), hasMore: z.boolean(), nextOffset: z.number().int().nonnegative().nullable() }),
  records: z.array(profileRecordSchema),
}).strict();
export const pageSchema = z.object({ snapshotId: z.string().uuid().optional(), offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(20).default(10), summaryMaxChars: z.number().int().min(0).max(1000).default(600),
  bodyMaxChars: z.number().int().min(0).max(50_000).default(0) }).strict();
export const uploadSchema = z.object({ leaseToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/), accountRef: z.string().regex(/^[a-f0-9]{64}$/), snapshot: snapshotSchema }).strict();
export function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) throw invalid('参数结构不符合接口 Schema。'); return result.data; }
export function parseSettings(value) { const result = parse(settingsSchema, value); if (!['history', 'likes', 'collections'].some((kind) => result[kind])) throw invalid('至少需要选择一种采集类别。'); return result; }
export function validateSnapshot(snapshot, settings, demo) {
  const value = parse(snapshotSchema, snapshot);
  if (value.source !== (demo ? 'demo_history' : 'zhihu_selected_data')) throw invalid('真实与演示数据不能混用。');
  if (JSON.stringify(value.settings) !== JSON.stringify(settings)) throw invalid('快照设置与任务不一致。');
  for (const record of [...value.records, ...value.excluded]) {
    const kinds = record.kinds || (record.kind ? [record.kind] : []);
    if (!kinds.length || kinds.some((kind) => !settings[kind])) throw invalid('快照包含本次未请求的行为类别。');
  }
  for (const kind of ['history', 'likes', 'collections']) {
    if (value.counts[kind] !== value.records.filter((record) => (record.kinds || [record.kind]).includes(kind)).length) throw invalid('快照计数与行为证据不一致。');
  }
  return value;
}
