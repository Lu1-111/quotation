// 数据转换 Agent：
// 读取用户数据库（user-db.json），严格过滤不具备知识属性的条目（网文、日常、情绪八卦、水帖等），
// 将具备知识价值的浏览/互动内容提炼为用户真正获取的结构化知识点（绝不把帖子原文直接粘贴到星球上），
// 给出知识点摘要、所属领域与权重，并严格按照星球数据库（planets-db.json）规范写入。
import { PLANETS_DB_FORMAT_DECLARATION } from '../db/planets-db.mjs';
import { generateStructuredJson } from './llm.mjs';

export const CONVERTER_BATCH_SIZE = 15;

export const CONVERTER_AGENT_INSTRUCTIONS = [
  '你是「数据转换与知识提炼 Agent」。你的任务是读取用户数据库中的阅读与互动记录，将其转化为可构建个人知识星图的「知识星球条目」，严格遵循星球数据库格式规范写入。',
  '',
  '【核心筛选与提炼原则（必须严格执行）】',
  '1. 坚决丢弃不具备知识属性的数据：包括但不限于网络小说/爽文/虚构故事、个人日常晒图/流水账、明星/社会八卦与纯情绪宣泄、无实质信息的吐槽短句。不要为这些条目生成任何星球。',
  '2. 绝对禁止将帖子标题或摘要直接复制粘贴为知识点！你必须站在“构建知识体系”的视角，提炼出用户从该帖子中真正了解到的概念、原理、方法或结论：',
  '   - 例如原帖标题为《从 PPO 到 GRPO：DeepSeek-R1 为什么能用组内相对优势替代 Critic 网络？》，应提炼为知识点：「GRPO 组内相对策略优化」，摘要概括其核心机理（通过组内相对奖励归一化替代 Critic 价值网络，降低显存开销并以 KL 散度约束防止策略坍缩）。',
  '   - 知识点名称（knowledgePoint）应简洁凝练（4-18 个汉字或中英术语），像知识图谱词条而非知乎提问句（不要带问号、不要以“如何看待/为什么/怎么”开头）。',
  '3. 内容摘要（summary）为 35-140 字的知识说明，直述核心概念、因果机制、应用场景或关键结论，不得出现“这篇回答讲了”“作者认为”“知乎网友”等原帖搬运口吻。',
  '4. 所属领域（domain）使用清晰规范的中文大类领域名（如“人工智能”“物理学”“认知心理学”“行为经济学”“信息论与数学”“生物医学”等），尽量保持同类一致，不要过细碎片化。',
  '5. 权重（weight）为 1-100 的整数：综合参考用户记录原始权重、行为类型（点赞/收藏高于普通浏览）、互动热度与知识点本身的基础重要性（基础核心概念 70-95，进阶专题 45-75，轻量补充 25-50）。',
  '6. 如果多条记录指向同一个核心知识点，可以合并提炼为一颗权重更高的星球，并在 sourceRecordKeys 中同时列出它们的 key。',
  '7. 只输出一个合法 JSON 对象，不要 Markdown 代码块，不要任何多余解释。',
  '',
  '【星球数据库目标记录规范】',
  JSON.stringify(PLANETS_DB_FORMAT_DECLARATION.recordSchema, null, 2),
  '',
  'JSON 输出结构：',
  '{',
  '  "planets": [',
  '    {',
  '      "domain": "所属领域（中文大类）",',
  '      "knowledgePoint": "提炼后的概念化知识点名称",',
  '      "summary": "35-140 字结构化知识摘要（解释原理、要点或结论）",',
  '      "weight": 78,',
  '      "sourceRecordKeys": ["answer:201"]',
  '    }',
  '  ],',
  '  "discarded": [',
  '    { "sourceRecordKey": "answer:291", "reason": "网文爽文，无知识属性" }',
  '  ]',
  '}',
].join('\n');

const NOISE_PATTERNS = [
  /穿越|重生|系统绑定|爽文|网文|修仙|霸道总裁|镇国公/,
  /晒.*日常|今天心情|午饭日常|吃瓜|明星.*翻车|真恶心|太离谱|气不气|娱乐八卦/,
];

const SHORT_NOISE_RE = /^(?:哈哈哈|笑死我了|牛逼|绝了|你就说它牛不牛逼吧)[!！。\s]*$/;

function isObviouslyNoise(record) {
  if (record?.analysis?.decision === 'exclude') return true;
  const title = String(record?.title || '').trim();
  const summary = String(record?.summary || '').trim();
  const topicNames = (record?.topics || []).map((t) => (typeof t === 'string' ? t : t?.name || '')).filter(Boolean);
  if (SHORT_NOISE_RE.test(title) || SHORT_NOISE_RE.test(summary)) return true;
  if (topicNames.some((t) => /^(?:网文|爽文|日常|娱乐八卦|搞笑|故事|情感故事)$/.test(t))) return true;
  const text = `${title} ${summary} ${topicNames.join(' ')}`;
  return NOISE_PATTERNS.some((re) => re.test(text));
}

function normalizeConvertedPlanet(raw, validKeys) {
  const kp = String(raw?.knowledgePoint || '').replace(/\s+/g, ' ').trim();
  const summary = String(raw?.summary || '').replace(/\s+/g, ' ').trim();
  const domain = String(raw?.domain || '').replace(/\s+/g, ' ').trim() || '通识与跨学科';
  if (!kp || kp.length < 2) return null;

  // 防呆检查：防止模型直接照搬“如何评价/为什么...”问句标题
  const cleanedKp = kp
    .replace(/^(?:如何看待|如何评价|怎么评价|为什么|怎样理解)\s*/, '')
    .replace(/[？?！!。]+$/, '')
    .trim()
    .slice(0, 48);
  if (!cleanedKp) return null;

  const weightNum = Number(raw?.weight);
  const weight = Number.isFinite(weightNum) ? Math.max(1, Math.min(100, Math.round(weightNum))) : 55;

  const sourceRecordKeys = Array.isArray(raw?.sourceRecordKeys)
    ? raw.sourceRecordKeys.filter((k) => typeof k === 'string' && (!validKeys || validKeys.has(k)))
    : [];

  return {
    domain: domain.slice(0, 32),
    knowledgePoint: cleanedKp,
    summary: (summary || `${cleanedKp}的核心概念与知识要点。`).slice(0, 260),
    weight,
    sourceRecordKeys,
  };
}

// 规则回退转换（仅用于未配置 LLM 时的本地兜底与单元测试；配置模型时默认走 LLM 深度提炼）
export function convertRecordsWithFallbackRules(records = []) {
  const planets = [];
  const discarded = [];

  for (const record of records) {
    if (isObviouslyNoise(record)) {
      discarded.push({ sourceRecordKey: record.key, reason: '非知识属性内容（网文/日常/娱乐八卦）' });
      continue;
    }
    const topics = (record.topics || []).map((t) => (typeof t === 'string' ? t : t?.name || '')).filter(Boolean);
    const rawTitle = String(record.title || '').trim();
    const rawSummary = String(record.summary || '').trim();
    if (!rawTitle && !rawSummary) {
      discarded.push({ sourceRecordKey: record.key, reason: '缺少有效文本信息' });
      continue;
    }

    // 提取核心短语而非照搬整句标题
    const bracketMatch = rawTitle.match(/「([^」]{2,24})」|（([^）]{2,20})）/);
    const conceptName =
      bracketMatch?.[1] ||
      bracketMatch?.[2] ||
      rawTitle
        .split(/[：:？?！!，,—-]/)[0]
        .replace(/^(?:从|关于|如何|为什么|怎样|深入|通俗)/, '')
        .trim()
        .slice(0, 22) ||
      topics[0] ||
      '核心概念';

    let domain = '跨学科知识';
    const joined = `${rawTitle} ${rawSummary} ${topics.join(' ')}`;
    if (/人工智能|大模型|多模态|强化学习|Transformer|CLIP|GRPO|KV Cache|扩散模型|AI|RoPE|LLM/i.test(joined)) {
      domain = '人工智能';
    } else if (/量子|物理|相对论|力学|热力学/.test(joined)) {
      domain = '物理学';
    } else if (/心理|记忆|认知|直觉|组块/.test(joined)) {
      domain = '认知心理学';
    } else if (/经济|前景理论|博弈|金融|损失厌恶/.test(joined)) {
      domain = '经济学与决策';
    } else if (/熵|贝叶斯|概率|数学|信息论/.test(joined)) {
      domain = '数学与信息论';
    } else if (/基因|CRISPR|mRNA|疫苗|免疫|生物|医学|细胞/.test(joined)) {
      domain = '生物医学';
    }

    const baseWeight = Number(record.weight);
    const weight = Number.isFinite(baseWeight)
      ? Math.max(25, Math.min(96, Math.round(35 + baseWeight * 9)))
      : 55;

    const cleanSummary =
      rawSummary.length >= 20
        ? `核心要点：${rawSummary.replace(/^(?:本文|这篇文章|这篇回答|系统拆解了|解析)/, '').slice(0, 140)}`
        : `围绕「${conceptName}」展开的核心机制与方法要点。`;

    planets.push({
      domain,
      knowledgePoint: conceptName,
      summary: cleanSummary,
      weight,
      sourceRecordKeys: [record.key].filter(Boolean),
    });
  }

  return { planets, discarded };
}

function buildBatchPrompt(userDbData, batch) {
  const formatSummary = userDbData?.$formatDeclaration
    ? `【用户数据库格式说明】${userDbData.$formatDeclaration.description}\n`
    : '';

  const rows = batch.map((r, idx) => {
    const topics = (r.topics || [])
      .map((t) => (typeof t === 'string' ? t : t?.name || ''))
      .filter(Boolean)
      .join('、');
    const kinds = (r.kinds || ['history']).join('/');
    return [
      `${idx + 1}. key=${r.key} | 类型=${r.contentType} | 行为=${kinds} | 排序权重=${r.weight ?? '—'} | 赞同=${r.voteCount ?? '—'}`,
      `   标题：${r.title || ''}`,
      topics ? `   话题：${topics}` : '',
      r.summary ? `   摘要：${String(r.summary).slice(0, 260)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });

  return `${formatSummary}\n请审查以下 ${batch.length} 条用户记录，过滤非知识条目，并将其余条目提炼为结构化知识点写入星球数据库：\n\n${rows.join('\n')}`;
}

export function createConverterAgent({ userDb, planetsDb, getModel, onProgress }) {
  let running = null;

  async function run({ forceAll = false } = {}) {
    if (running) return running;

    running = (async () => {
      const userDbData = await userDb.read();
      const convertedSet = new Set(forceAll ? [] : userDbData.convertedKeys || []);
      const pendingRecords = (userDbData.records || []).filter((r) => r?.key && !convertedSet.has(r.key));

      if (pendingRecords.length === 0) {
        return {
          skipped: true,
          processedRecords: 0,
          addedPlanets: 0,
          updatedPlanets: 0,
          discardedCount: 0,
        };
      }

      const { model } = await getModel();
      const allPlanets = [];
      const allDiscarded = [];
      const processedKeys = [];
      const mode = model ? 'llm' : 'fallback_rules';

      for (let i = 0; i < pendingRecords.length; i += CONVERTER_BATCH_SIZE) {
        const batch = pendingRecords.slice(i, i + CONVERTER_BATCH_SIZE);
        const batchKeySet = new Set(batch.map((r) => r.key));
        onProgress?.({
          stage: 'converting',
          processed: i,
          total: pendingRecords.length,
        });

        let batchResult;
        if (model) {
          const json = await generateStructuredJson({
            model,
            instructions: CONVERTER_AGENT_INSTRUCTIONS,
            prompt: buildBatchPrompt(userDbData, batch),
            temperature: 0.2,
            timeoutMs: 90_000,
          });
          const rawPlanets = Array.isArray(json?.planets) ? json.planets : [];
          const planets = rawPlanets
            .map((p) => normalizeConvertedPlanet(p, batchKeySet))
            .filter(Boolean);
          const discarded = Array.isArray(json?.discarded) ? json.discarded : [];
          batchResult = { planets, discarded };
        } else {
          batchResult = convertRecordsWithFallbackRules(batch);
        }

        allPlanets.push(...batchResult.planets);
        allDiscarded.push(...batchResult.discarded);
        processedKeys.push(...batch.map((r) => r.key));
      }

      let dbResult = { added: [], updated: [], total: 0 };
      if (allPlanets.length > 0) {
        dbResult = await planetsDb.addPlanets(allPlanets);
      }
      await userDb.markConverted(processedKeys);

      const summary = {
        skipped: false,
        mode,
        processedRecords: processedKeys.length,
        addedPlanets: dbResult.added.length,
        updatedPlanets: dbResult.updated.length,
        discardedCount: allDiscarded.length,
        discarded: allDiscarded.slice(0, 30),
        totalPlanetsInDb: dbResult.total,
      };
      onProgress?.({ stage: 'converted', ...summary });
      return summary;
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
