// 用户知识与偏好画像：每次同步跑完后由模型生成一份结构化概要，落盘常驻。
//
// 设计约束：
// - 数据只来自已采集的快照，不外发额外内容；正文不参与（只用标题、摘要、话题、权重）。
// - 输出走严格 JSON，解析失败就抛错，由调用方保留上一份可用画像——宁可旧，不可空。
// - 模型可以换，但画像里要记下模型名与生成时间，方便判断是否过期。
import { generateText } from 'ai';

export const PROFILE_VERSION = 1;
// 提示词版本：改了归纳规则就 +1，旧画像会被判定为过期并自动重算。
export const PROMPT_VERSION = 2;
// 生成时最多喂多少条记录、每条摘要截多长，避免一次调用吃掉太多上下文。
export const PROFILE_RECORD_LIMIT = 50;
export const PROFILE_SUMMARY_CHARS = 160;
export const PROFILE_TIMEOUT_MS = 120_000;

const KIND_LABEL = { history: '浏览', likes: '点赞', collections: '收藏' };

const INSTRUCTIONS = [
  '你是知乎阅读数据的画像分析助手。用户会给你一批他本人最近的阅读记录，你要归纳出他的知识兴趣与偏好。',
  '',
  '字段含义：',
  '- 「浏览/点赞/收藏」是这条记录的行为来源，同一内容可能有多个来源。',
  '- 「权重」是本地规则算出的排序信号（内容类型 + 行为 + 互动量 + 时间衰减），只表示这条记录在本次窗口里排得靠前，**不是**兴趣强度、阅读时长或读完比例。',
  '- 「话题」是平台话题名；「摘要」是平台摘要，不是全文。',
  '- question 类型（问题页）没有权重和摘要，信息量最低。',
  '',
  '要求：',
  '- 只依据给定记录归纳，不要引入外部知识，不要编造记录里没有的内容。',
  '- 不要推断用户的身份、职业、性别、年龄、性格或收入；只描述"读了什么、关注什么"。',
  '- 领域划分由你决定，但必须给出占比（按记录条数），并列出支撑该领域的记录标题。',
  '- 同一标题重复出现时，要意识到这可能只是重复曝光，不能直接当成更强的兴趣。',
  '- 记录里没有、但你注意到缺失的信息，写进 uncertainties。',
  '- 只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释文字。',
  '',
  'JSON 结构：',
  '{',
  '  "summary": "两三句话概括最近的阅读兴趣",',
  '  "domains": [ { "name": "领域名", "share": 0.28, "evidence": ["记录标题"] } ],',
  '  "topics": ["具体关注点，5-10 个"],',
  '  "shifts": ["近期变化或新出现的关注点，没有就留空数组"],',
  '  "uncertainties": ["判断上的不确定之处"]',
  '}',
].join('\n');

// 把分页记录压成紧凑文本：一条一行，控制字符数。
// 话题在分页接口里是 { id, name } 对象（不是字符串），这里两种都接受，避免渲染成 [object Object]。
function topicNames(topics) {
  if (!Array.isArray(topics)) return [];
  return topics
    .map((topic) => (typeof topic === 'string' ? topic : typeof topic?.name === 'string' ? topic.name : ''))
    .map((name) => name.trim())
    .filter(Boolean);
}

export function buildProfileInput(records, { summaryChars = PROFILE_SUMMARY_CHARS } = {}) {
  return records.map((record, index) => {
    const kinds = (record.kinds ?? []).map((kind) => KIND_LABEL[kind] ?? kind).join('/') || '浏览';
    const topics = topicNames(record.topics).slice(0, 4).join('、');
    const summary = String(record.summary ?? '').replace(/\s+/g, ' ').slice(0, summaryChars);
    const weight = record.weight == null ? '—' : Number(record.weight).toFixed(2);
    return [
      `${index + 1}. [${kinds}｜${record.contentType ?? '?'}｜权重 ${weight}] ${record.title ?? ''}`,
      topics ? `   话题：${topics}` : '',
      summary ? `   摘要：${summary}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n');
}

// 模型可能仍会包一层代码块或前后加话，这里只取第一个完整 JSON 对象。
export function parseProfileJson(text) {
  const raw = String(text ?? '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('画像输出里没有 JSON 对象。');
  const value = JSON.parse(raw.slice(start, end + 1));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('画像输出不是对象。');
  return normalizeProfile(value);
}

// 收敛成稳定形状：字段缺失或类型不对时给空值，不让下游拿到 undefined。
export function normalizeProfile(value) {
  const text = (input) => (typeof input === 'string' ? input.trim() : '');
  const list = (input) => (Array.isArray(input) ? input.map(text).filter(Boolean) : []);
  const domains = Array.isArray(value.domains) ? value.domains.map((domain) => ({
    name: text(domain?.name),
    share: Number.isFinite(Number(domain?.share)) ? Math.max(0, Math.min(1, Number(domain.share))) : null,
    evidence: list(domain?.evidence).slice(0, 6),
  })).filter((domain) => domain.name) : [];
  return {
    summary: text(value.summary),
    domains,
    topics: list(value.topics).slice(0, 20),
    shifts: list(value.shifts).slice(0, 10),
    uncertainties: list(value.uncertainties).slice(0, 10),
  };
}

/**
 * 生成一份画像。失败就抛错，由调用方决定保留旧画像。
 * @returns {Promise<object>} 带版本、时间与覆盖范围信息的完整画像对象
 */
export async function generateProfile({
  model,
  modelName,
  records,
  snapshotId,
  syncedAt,
  counts,
  signal,
  timeoutMs = PROFILE_TIMEOUT_MS,
  generate = generateText,
}) {
  if (!model) throw new Error('没有可用的模型，无法生成画像。');
  const chosen = records.slice(0, PROFILE_RECORD_LIMIT);
  const input = buildProfileInput(chosen);
  const resolvedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : PROFILE_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(resolvedTimeoutMs);
  const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const result = await generate({
    model,
    instructions: INSTRUCTIONS,
    prompt: `以下是 ${chosen.length} 条阅读记录：\n\n${input}`,
    abortSignal: effectiveSignal,
  });
  const parsed = parseProfileJson(result.text);
  return {
    version: PROFILE_VERSION,
    promptVersion: PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
    snapshotId: snapshotId ?? null,
    syncedAt: syncedAt ?? null,
    model: modelName ?? null,
    coverage: {
      records: chosen.length,
      counts: counts ?? null,
      window: 'latest_50_qualified',
      completeHistory: false,
      includesFullText: false,
    },
    ...parsed,
  };
}

// 画像是否已经落后：快照换了、数据协议换了、或归纳提示词升级了，都要重算。
export function isStale(profile, snapshotId) {
  if (!profile) return true;
  if (profile.version !== PROFILE_VERSION) return true;
  if (profile.promptVersion !== PROMPT_VERSION) return true;
  if (!snapshotId) return true;
  return profile.snapshotId !== snapshotId;
}

// 供系统提示词使用的一段紧凑文本。
export function profilePromptBlock(profile) {
  if (!profile?.summary && !profile?.domains?.length) return '';
  const lines = ['## 用户画像（由后台根据已采集数据生成，可能滞后）'];
  if (profile.summary) lines.push(`- 概要：${profile.summary}`);
  if (profile.domains.length) {
    lines.push(`- 领域：${profile.domains.map((domain) => `${domain.name}${domain.share == null ? '' : `（${Math.round(domain.share * 100)}%）`}`).join('、')}`);
  }
  if (profile.topics.length) lines.push(`- 具体关注：${profile.topics.slice(0, 10).join('、')}`);
  if (profile.shifts.length) lines.push(`- 近期变化：${profile.shifts.join('；')}`);
  if (profile.generatedAt) lines.push(`- 生成时间：${profile.generatedAt}`);
  lines.push('- 用法：这是归纳结果，不是原始证据。回答需要具体依据时应读取采集工具的数据；画像与工具数据冲突时，以工具数据为准。');
  return lines.join('\n');
}
