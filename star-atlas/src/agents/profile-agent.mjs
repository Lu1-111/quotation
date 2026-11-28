// 画像 Agent：
// 与数据采集绑定，每次采集完成后自动启动。
// 读取用户数据库（含前置 $formatDeclaration 与最新记录），生成用户的知识面貌与偏好领域画像并持久化，供其他 Agent 与前端界面读取。
import { generateStructuredJson } from './llm.mjs';

export const PROFILE_VERSION = 2;
export const PROFILE_PROMPT_VERSION = 3;
export const PROFILE_RECORD_LIMIT = 50;
export const PROFILE_SUMMARY_CHARS = 180;

const KIND_LABEL = { history: '浏览', likes: '点赞', collections: '收藏' };

export const PROFILE_AGENT_INSTRUCTIONS = [
  '你是「用户知识面貌与偏好画像 Agent」。你会读取用户数据库（包含数据库格式声明与用户近期采集的阅读/互动记录），归纳用户的知识结构、核心偏好领域与关注演变。',
  '',
  '工作原则：',
  '1. 只依据给定用户数据库中的记录归纳，不编造记录外的内容。',
  '2. 严禁推断用户的职业、年龄、性别、收入或性格等人口学敏感属性；只描述“关注什么知识领域、正在构建哪些知识方向”。',
  '3. 领域名称采用清晰规范的中文语义领域（如“人工智能与深度学习”“认知心理学”“物理学与量子科学”），合并同义表述（例如 AI 与人工智能归为同一领域），并给出占比 share（0-1 之间，总和接近 1）与支撑标题 evidence。',
  '4. 识别记录中的非知识噪音（如网文/日常/八卦），不要将其放大为核心知识领域，可在 uncertainties 中简述数据覆盖局限。',
  '5. 只输出一个合法 JSON 对象，不要 Markdown 代码块，不要任何多余解释。',
  '',
  'JSON 输出结构：',
  '{',
  '  "summary": "2-3 句话概括用户当前的知识面貌与偏好重心",',
  '  "domains": [',
  '    { "name": "领域名称", "share": 0.42, "evidence": ["支撑记录标题1", "支撑记录标题2"] }',
  '  ],',
  '  "topics": ["具体知识关注点，5-10 个"],',
  '  "shifts": ["近期新出现或明显加强的知识关注方向，没有则为空数组"],',
  '  "uncertainties": ["样本覆盖或判断上的不确定之处"]',
  '}',
].join('\n');

function topicNames(topics) {
  if (!Array.isArray(topics)) return [];
  return topics
    .map((t) => (typeof t === 'string' ? t : typeof t?.name === 'string' ? t.name : ''))
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildProfilePromptFromUserDb(userDbData) {
  const records = (userDbData?.records || []).slice(0, PROFILE_RECORD_LIMIT);
  const header = userDbData?.$formatDeclaration
    ? `【用户数据库格式声明】\n数据库：${userDbData.$formatDeclaration.title}\n说明：${userDbData.$formatDeclaration.description}\n`
    : '';
  const lines = records.map((record, index) => {
    const kinds = (record.kinds || ['history']).map((k) => KIND_LABEL[k] || k).join('/');
    const topics = topicNames(record.topics).slice(0, 4).join('、');
    const summary = String(record.summary || '').replace(/\s+/g, ' ').slice(0, PROFILE_SUMMARY_CHARS);
    const weight = record.weight == null ? '—' : Number(record.weight).toFixed(2);
    return [
      `${index + 1}. [${kinds}｜${record.contentType || '?'}｜权重 ${weight}] ${record.title || ''}`,
      topics ? `   话题：${topics}` : '',
      summary ? `   摘要：${summary}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
  return `${header}\n以下是用户数据库中的 ${records.length} 条记录：\n\n${lines.join('\n')}`;
}

export function normalizeProfileOutput(raw) {
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const list = (v, limit = 15) => (Array.isArray(v) ? v.map(text).filter(Boolean).slice(0, limit) : []);
  const domains = Array.isArray(raw?.domains)
    ? raw.domains
        .map((d) => ({
          name: text(d?.name),
          share: Number.isFinite(Number(d?.share)) ? Math.max(0, Math.min(1, Number(d.share))) : null,
          evidence: list(d?.evidence, 6),
        }))
        .filter((d) => d.name)
    : [];
  return {
    summary: text(raw?.summary),
    domains,
    topics: list(raw?.topics, 16),
    shifts: list(raw?.shifts, 8),
    uncertainties: list(raw?.uncertainties, 8),
  };
}

// 规则回退画像（仅在未配置模型密钥时用于离线演示/兜底，配置模型后始终走大模型推理）
export function buildRuleFallbackProfile(userDbData) {
  const records = (userDbData?.records || []).filter((r) => r.analysis?.decision !== 'exclude');
  const domainMap = new Map();
  const topicCounter = new Map();

  for (const r of records) {
    const domain = r.analysis?.domains?.[0] || '综合与跨学科';
    if (!domainMap.has(domain)) domainMap.set(domain, []);
    domainMap.get(domain).push(r.title || '');
    for (const t of topicNames(r.topics)) {
      topicCounter.set(t, (topicCounter.get(t) || 0) + 1);
    }
  }

  const total = Math.max(1, records.length);
  const domains = [...domainMap.entries()]
    .map(([name, titles]) => ({
      name,
      share: Number((titles.length / total).toFixed(2)),
      evidence: titles.filter(Boolean).slice(0, 4),
    }))
    .sort((a, b) => b.share - a.share);

  const topics = [...topicCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name]) => name);

  return {
    summary:
      domains.length > 0
        ? `当前共覆盖 ${records.length} 条有效阅读记录，知识关注集中在「${domains
            .slice(0, 3)
            .map((d) => d.name)
            .join('、')}」等方向。`
        : '当前用户数据库中尚无足够的有效知识记录。',
    domains,
    topics,
    shifts: [],
    uncertainties: ['当前画像由本地规则兜底生成；配置大模型 API 后将获得更深入的语义画像分析。'],
  };
}

export function createProfileAgent({ userDb, profileStore, getModel }) {
  let running = null;

  async function run({ force = false } = {}) {
    if (running) return running;

    running = (async () => {
      const userDbData = await userDb.read();
      const existing = await profileStore.read();

      if (!userDbData.records.length) {
        return { skipped: true, reason: '用户数据库为空', profile: existing };
      }
      if (
        !force &&
        existing &&
        existing.version === PROFILE_VERSION &&
        existing.promptVersion === PROFILE_PROMPT_VERSION &&
        existing.snapshotRevision === userDbData.revision
      ) {
        return { skipped: true, reason: '画像已是最新版本', profile: existing };
      }

      const { model, modelName } = await getModel();
      let parsed;
      let mode = 'llm';

      if (model) {
        const prompt = buildProfilePromptFromUserDb(userDbData);
        const json = await generateStructuredJson({
          model,
          instructions: PROFILE_AGENT_INSTRUCTIONS,
          prompt,
          temperature: 0.2,
          timeoutMs: 90_000,
        });
        parsed = normalizeProfileOutput(json);
      } else {
        mode = 'fallback_rules';
        parsed = buildRuleFallbackProfile(userDbData);
      }

      const profile = {
        version: PROFILE_VERSION,
        promptVersion: PROFILE_PROMPT_VERSION,
        generatedAt: new Date().toISOString(),
        snapshotRevision: userDbData.revision,
        syncedAt: userDbData.syncedAt,
        model: mode === 'llm' ? modelName : 'local-rules-fallback',
        mode,
        coverage: {
          records: Math.min(PROFILE_RECORD_LIMIT, userDbData.records.length),
          counts: userDbData.counts,
        },
        ...parsed,
      };

      await profileStore.save(profile);
      return { skipped: false, profile };
    })();

    try {
      return await running;
    } finally {
      running = null;
    }
  }

  return {
    run,
    isRunning: () => Boolean(running),
  };
}
