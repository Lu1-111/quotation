import { createHash } from 'node:crypto';

export const POLICY_VERSION = 'knowledge-v1';
export const DATA_KINDS = Object.freeze(['history', 'likes', 'collections']);
export const hasSelectedKinds = (settings) => DATA_KINDS.some((kind) => settings[kind]);

const clean = (value) => String(value || '').normalize('NFKC').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const domains = [
  ['计算机与人工智能', /人工智能|大模型|机器学习|编程|程序|算法|软件|数据库|计算机|\b(?:AI|API|MCP|LLM|agent|codex|python|tauri|fastapi)\b/i],
  ['自然科学与工程', /物理|化学|生物|数学|天文|电路|工程|数据中心|脑细胞|能源|材料/],
  ['教育与学习', /教育|学习|写作|论文|投稿|申诉流程|阅读笔记|学习方法/],
  ['医学与心理', /医学|临床|疾病|治疗|诊断|心理|认知|健康/],
  ['人文与社会', /历史|哲学|文学|法律|社会|经济|金融|网贷|政治|国际局势/],
  ['生活与实践', /指南|教程|流程|步骤|整理|应对|经验|实践|方法/],
];

export function contentHash(record) {
  return createHash('sha256').update(JSON.stringify([
    POLICY_VERSION, record.title || '', record.summary || '', record.bodyText || '', record.bodyStatus || '', record.topics || [],
  ])).digest('hex');
}

export function ruleReview(record) {
  const title = clean(record.title);
  const body = clean(record.bodyText || record.summary);
  const topicText = (record.topics || []).map((topic) => topic.name).join(' ');
  const text = `${title} ${body}`;
  const domain = domains.find(([, pattern]) => pattern.test(`${text} ${topicText}`))?.[0] || '待分类';
  const evidence = [...text.matchAll(/研究表明|临床|实验|统计|参考文献|数据分析|工作原理|作用机制|具体步骤|操作步骤|方法论|法律依据|史料|文本分析|叙事结构|人物塑造|文献|对照组|实现方法|性能测试/g)].map((match) => match[0]);
  const analytical = new Set(evidence).size >= 2 || /科普|教程|技术解析|文学分析|案例分析|医学解释/.test(title);
  let decision = 'review';
  let reason = '现有文本不足以可靠判断知识价值，暂保留并等待复核。';
  let category = '信息不足';
  const exclude = (label, message) => { decision = 'exclude'; category = label; reason = message; };
  if (!analytical && /人和禽兽.{0,12}(?:没有|没什么|有何|有什么)?区别|最龌龊|最下流|毁三观.{0,10}经历/.test(title)) {
    exclude('猎奇与刺激叙事', '标题以猎奇或刺激经历为主，现有内容未显示解释、证据或可迁移方法。');
  } else if (!analytical && (body.match(/黑丝|又纯又欲|裙底|偷拍|36[D-F]|身材.{0,4}火辣|小美女|蹭我腿|下海做KTV/g) || []).length >= 2) {
    exclude('擦边与猎奇叙事', '文本出现多项性化叙事线索，未显示医学、法律、心理或其他知识性分析。');
  } else if (!analytical && (record.topics || []).some((topic) => /^(?:故事|情感故事|爽文|猎奇故事)$/.test(topic.name)) && /同事|美女|办公室|老王|我.{0,6}(?:遇到|看到|发现)/.test(body)) {
    exclude('故事消费', '主要为故事情节，未见可迁移知识或分析。');
  } else if (!analytical && /(?:你|大家).{0,6}(?:怎么看|如何看待)|这个事情大家怎么看/.test(title) && /刑不上|你管这叫|没有一个人|太离谱|气不气|真恶心/.test(body)) {
    exclude('八卦与情绪宣泄', '以人物八卦或情绪表态为主，现有内容未呈现可核查论证。');
  } else if (!analytical && /正过着怎样的生活|今天心情|晒.{0,5}日常/.test(title) && !/步骤|方法|指南|流程|经验总结/.test(body)) {
    exclude('个人日常', '主要为个人日常叙述，现有内容未提供可迁移经验。');
  } else if (!analytical && /如何评价游戏|到底好不好玩/.test(title) && !/设计分析|叙事结构|机制分析|开发教程|渲染原理/.test(body)) {
    exclude('娱乐消费评价', '主要为娱乐消费体验，未呈现设计、文化或技术层面的分析。');
  } else if (/^(?:你就说它牛不牛逼吧|哈哈哈|笑死我了)[!！。\s]*$/.test(body)) {
    exclude('无实质信息', '摘要仅为情绪短句，没有可供分析的知识内容。');
  } else if (analytical || (domain !== '待分类' && body.length >= 45)) {
    decision = 'keep'; category = '知识候选';
    reason = analytical ? '包含解释、证据、分析或方法线索。' : '包含明确知识领域及实质文本，作为知识候选保留。';
  }
  return { policyVersion: POLICY_VERSION, inputHash: contentHash(record), method: 'rules', decision, category,
    reason, domains: domain === '待分类' ? [] : [domain], tags: [category], keywords: [], knowledgePoints: [],
    summary: null, basis: record.bodyText ? 'api_body' : 'title_excerpt', evidence: [...new Set(evidence)] };
}

export function reviewRecord(record, settings = {}) {
  const local = ruleReview(record);
  const cached = record.analysis;
  const analysis = settings.aiReview && cached?.method === 'ollama' && cached.inputHash === local.inputHash && cached.policyVersion === POLICY_VERSION ? cached
    : { ...local, ...(settings.aiReview && cached?.agentWarning ? {
      decision: local.decision === 'exclude' ? 'exclude' : 'review', agentWarning: cached.agentWarning,
    } : {}) };
  return { ...record, analysis };
}

export function policyAllows(record, settings = {}) {
  return settings.knowledgeFilter === false || record.analysis?.decision !== 'exclude';
}
