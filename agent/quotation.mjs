// 报价打分与交锋数值引擎：连通前端信念依赖图（承重墙 / 级联塌陷）与交互模块的难度检定、意志增减。
//
// 核心约定：
// - 「报价」（quotation，0–100 隐藏数值）衡量让对手接受该话术所需付出的认知拆迁代价与逻辑阻力：
//   报价越低 = 越能避开无辜承重墙、精准切中漏洞且论据扎实 -> 检定难度越低（非常简单 / 比较简单）-> 削减对手意志；
//   报价越高 = 硬撞多堵底层承重墙或话术自身含事实/逻辑谬误 -> 检定难度越高（比较困难 / 非常困难）-> 反而助长（增加）对手意志。
// - 8 回合上限（MAX_CLASH_ROUNDS = 8）：8 回合结束后若未能将对手意志削减至 0，则判定用户说服失败。
// - 准确率（accuracy，0 或 1 隐藏数值，初始 1）：选中「比较困难」「非常困难」变为 0，否则变为 1；
//   仅当 accuracy === 0 时，向用户展示下一轮各选项的检定难度。

export const DIFFICULTY_LEVELS = Object.freeze(['非常简单', '比较简单', '比较困难', '非常困难']);
export const INITIAL_WILLPOWER = 100;
export const MAX_WILLPOWER = 140;
export const MAX_CLASH_ROUNDS = 8;
export const INITIAL_ACCURACY = 1;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// 与 frontend-design/web/src/starfield.js 一致的确定性 FNV-1a 32 位哈希，用于稳定洗牌。
export function h32(input) {
  const text = String(input ?? '');
  let x = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    x ^= text.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return (x >>> 0) / 4294967296;
}

// 报价 -> 检定难度映射：低报价对应低说服阻力（简单），高报价对应高说服阻力（困难）。
export function difficultyFromQuotation(quotation) {
  const q = Number(quotation);
  if (!Number.isFinite(q) || q <= 25) return '非常简单';
  if (q <= 50) return '比较简单';
  if (q <= 75) return '比较困难';
  return '非常困难';
}

// 报价 -> 对手意志有符号变化量（willpowerDelta，负数表示削减意志，正数表示助长/增加意志）：
// - 非常简单（q=10..25）：削减 28–34 点意志（负数 -34 .. -28）
// - 比较简单（q=26..50）：削减 16–26 点意志（负数 -26 .. -16）
// - 比较困难（q=51..75）：增加 8–15 点意志（正数 +8 .. +15）
// - 非常困难（q=76..95）：增加 16–24 点意志（正数 +16 .. +24）
// 全选简单选项约 4–5 回合削减至 0 获胜；夹杂 1–2 次失误约 6–7 回合获胜；失误过多满 8 回合未归零则失败。
export function computeWillpowerDelta(quotation) {
  const q = clamp(Number.isFinite(Number(quotation)) ? Number(quotation) : 50, 0, 100);
  if (q <= 25) {
    return -clamp(Math.round(37 - 0.36 * q), 28, 34);
  }
  if (q <= 50) {
    return -clamp(Math.round(36 - 0.40 * q), 16, 26);
  }
  if (q <= 75) {
    return clamp(Math.round(0.32 * q - 9), 8, 15);
  }
  return clamp(Math.round(0.36 * q - 11), 16, 24);
}

// 兼容旧签名的意志伤害值（正数代表削减量，负数代表反增对手意志）。
export function computeWillpowerDamage(quotation) {
  return -computeWillpowerDelta(quotation);
}

// 困难选项自身已直接增加对手意志，回合切换不再额外凭空回血。
export function computeWillpowerRecovery() {
  return 0;
}

// 隐藏数值「准确率」更新规则：选中比较困难/非常困难 -> 0；选中非常简单/比较简单 -> 1。
export function nextAccuracy(difficulty) {
  return difficulty === '比较困难' || difficulty === '非常困难' ? 0 : 1;
}

export function isDifficultyVisible(accuracy) {
  return accuracy === 0;
}

export function isChoiceAppropriate(difficulty) {
  return difficulty === '非常简单' || difficulty === '比较简单';
}

// 构造兜底拓扑信念图：模型输出节点不足时，仍保证报价算法跑在合法的有向无环信念结构上。
export function fallbackBeliefNodes(claim = '该观点成立') {
  const short = String(claim || '该观点成立').trim().slice(0, 60);
  return [
    { id: 'b1', name: '切身观察', cluster: 1, deps: [], text: `身边多次见到支持「${short}」的直观案例。` },
    { id: 'b2', name: '常见痛点', cluster: 2, deps: [], text: '现实中确实存在与该话题相关的焦虑或负面体验。' },
    { id: 'b3', name: '热点印象', cluster: 3, deps: [], text: '社交讨论里最常被放大的往往是极端结果。' },
    { id: 'b4', name: '经验外推', cluster: 1, deps: ['b1', 'b2'], text: '既然身边案例和痛点同时出现，说明这不是偶然现象。' },
    { id: 'b5', name: '单一归因', cluster: 2, deps: ['b2', 'b3'], text: '把复杂结果归结到单一原因上最容易解释现状。' },
    { id: 'b6', name: '绝对化推论', cluster: 3, deps: ['b4', 'b5'], text: short },
  ];
}

// 清洗并强制拓扑序：每个节点的 deps 只能指向排在它前面的节点，杜绝环路与悬空引用。
export function normalizeBeliefGraph(rawNodes, fallbackClaim = '') {
  if (!Array.isArray(rawNodes) || rawNodes.length < 4) {
    return computeBeliefGraph(fallbackBeliefNodes(fallbackClaim));
  }
  const normalized = [];
  const seenIds = new Set();
  for (let i = 0; i < Math.min(rawNodes.length, 12); i += 1) {
    const raw = rawNodes[i];
    if (!raw || typeof raw !== 'object') continue;
    const rawId = String(raw.id ?? `b${i + 1}`).trim() || `b${i + 1}`;
    const id = seenIds.has(rawId) ? `b${i + 1}_${seenIds.size}` : rawId;
    const text = String(raw.text ?? '').trim();
    if (!text) continue;
    const name = String(raw.name ?? text.slice(0, 8)).trim().slice(0, 24) || `判断${normalized.length + 1}`;
    const cluster = Number.isInteger(Number(raw.cluster)) && Number(raw.cluster) > 0 ? Number(raw.cluster) : ((normalized.length % 3) + 1);
    const deps = Array.isArray(raw.deps)
      ? [...new Set(raw.deps.map((dep) => String(dep).trim()).filter((dep) => seenIds.has(dep)))]
      : [];
    seenIds.add(id);
    normalized.push({ id, name, text, cluster, deps });
  }
  if (normalized.length < 4) {
    return computeBeliefGraph(fallbackBeliefNodes(fallbackClaim));
  }
  // 若所有节点都没有依赖边，自动为后半层补上双依赖，保证级联塌陷数学有效。
  const hasAnyEdge = normalized.some((node) => node.deps.length > 0);
  if (!hasAnyEdge) {
    for (let i = 2; i < normalized.length; i += 1) {
      normalized[i].deps = [normalized[i - 2].id, normalized[i - 1].id];
    }
  }
  return computeBeliefGraph(normalized);
}

// 与 frontend-design/web/src/starfield.js 同口径计算承重数 S（传递闭包）与最短依赖深度 d。
export function computeBeliefGraph(nodes) {
  const kids = new Map(nodes.map((node) => [node.id, []]));
  for (const node of nodes) {
    for (const dep of node.deps) {
      if (kids.has(dep)) kids.get(dep).push(node.id);
    }
  }
  const depth = new Map();
  for (const node of nodes) depth.set(node.id, node.deps.length ? Infinity : 0);
  for (const node of nodes) {
    const d = depth.get(node.id);
    for (const child of kids.get(node.id)) {
      if (d + 1 < depth.get(child)) depth.set(child, d + 1);
    }
  }
  const desc = new Map();
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    const set = new Set();
    for (const child of kids.get(node.id)) {
      set.add(child);
      for (const item of desc.get(child)) set.add(item);
    }
    desc.set(node.id, set);
  }
  return nodes.map((node) => ({
    ...node,
    S: desc.get(node.id).size,
    d: Number.isFinite(depth.get(node.id)) ? depth.get(node.id) : 0,
  }));
}

// 级联塌陷规则（与 starfield.js 一致）：任一有依赖的判断若存活依据占比 < 0.5，则一并失稳塌陷。
export function collapseAfter(removedIds, graph) {
  const dead = new Set(removedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph) {
      if (dead.has(node.id) || !node.deps.length) continue;
      const alive = node.deps.filter((dep) => !dead.has(dep)).length;
      if (alive / node.deps.length < 0.5) {
        dead.add(node.id);
        changed = true;
      }
    }
  }
  return dead;
}

const DOGMATIC_PATTERNS = /只会|绝对|完全错|本来就是错|毫无意义|毫无价值|根本不|百分百|全盘否定|必然失败|纯属无稽|纯属瞎说|一文不值|所有人都|反正就是|闭着眼都|傻子才|常识都不懂/;
const NUANCED_PATTERNS = /在.{1,12}(条件|前提|场景)下|数据|统计|研究|案例|一方面|但同时|并不否认|边界|具体来看|区分|取决于/;
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });

function contentWords(text) {
  return new Set(
    [...segmenter.segment(String(text ?? '').normalize('NFKC').toLowerCase())]
      .filter((part) => part.isWordLike && [...part.segment].length >= 2)
      .map((part) => part.segment),
  );
}

// 根据话术内容、冲突节点塌陷规模、事实/逻辑瑕疵与搜索证据贴合度计算原始报价。
export function computeRawQuotation(option, graph, searchItems = []) {
  const validGraph = Array.isArray(graph) && graph.length ? graph : normalizeBeliefGraph([]);
  const byId = new Map(validGraph.map((node) => [node.id, node]));
  const text = String(option?.text ?? '');

  const conflicts = new Set(
    Array.isArray(option?.conflicts)
      ? option.conflicts.map((id) => String(id).trim()).filter((id) => byId.has(id))
      : [],
  );

  // 若话术带有强烈全盘否定措辞且未标注冲突点，自动关联对手最核心的地基承重墙。
  if (conflicts.size === 0 && DOGMATIC_PATTERNS.test(text)) {
    const roots = [...validGraph].filter((node) => node.d === 0).sort((a, b) => b.S - a.S);
    if (roots[0]) conflicts.add(roots[0].id);
  }

  const dead = collapseAfter(conflicts, validGraph);
  // 节点权重取 (1 + S)：既反映上游传递承重 S，也让叶节点具备基础权重。
  const totalWeight = validGraph.reduce((sum, node) => sum + 1 + node.S, 0) || 1;
  const deadWeight = validGraph.filter((node) => dead.has(node.id)).reduce((sum, node) => sum + 1 + node.S, 0);
  const structuralRate = deadWeight / totalWeight;

  const flawLevel = clamp(Number(option?.flawLevel) || 0, 0, 2);
  const flawPenalty = flawLevel === 2 ? 48 : flawLevel === 1 ? 26 : 0;

  let toneDelta = 0;
  if (DOGMATIC_PATTERNS.test(text)) toneDelta += 12;
  if (NUANCED_PATTERNS.test(text)) toneDelta -= 8;

  // 与本回合知乎检索证据的词项重合奖励（仅对无明显事实错误的话术生效）。
  let evidenceBonus = 0;
  if (flawLevel === 0 && Array.isArray(searchItems) && searchItems.length > 0) {
    const optionWords = contentWords(text);
    const corpusWords = contentWords(searchItems.map((item) => `${item.title ?? ''} ${item.excerpt ?? ''}`).join(' '));
    let overlap = 0;
    for (const word of optionWords) {
      if (corpusWords.has(word)) overlap += 1;
      if (overlap >= 3) break;
    }
    if (overlap >= 2) evidenceBonus = -6;
  }

  const rawQuotation = clamp(
    Math.round(14 + structuralRate * 60 + flawPenalty + toneDelta + evidenceBonus),
    6,
    96,
  );

  return {
    rawQuotation,
    structuralRate: Number(structuralRate.toFixed(4)),
    deadCount: dead.size,
    directConflicts: [...conflicts],
  };
}

function calibrateQuotations(scored) {
  const count = scored.length;
  if (count === 0) return [];
  if (count === 1) {
    return [{ ...scored[0], quotation: clamp(scored[0].rawQuotation, 10, 24) }];
  }

  // 按原始报价升序排列：第 0 项说服阻力最小（最恰当），最后一项阻力最大（最困难/含谬误）。
  const ordered = [...scored].sort((a, b) => a.rawQuotation - b.rawQuotation
    || (Number(a.option.flawLevel) || 0) - (Number(b.option.flawLevel) || 0)
    || a.deadCount - b.deadCount);

  const values = ordered.map((entry) => entry.rawQuotation);

  // 硬性约束 1：必须至少有一个「非常简单」（<= 25）和一个「非常困难」（>= 76），且两端拉开明显差距。
  values[0] = clamp(values[0], 10, 18);
  values[count - 1] = clamp(Math.max(values[count - 1], 84), 82, 95);

  // 硬性约束 2：相邻选项之间保持鲜明报价梯度（>= 18 点），使四档难度与意志减损分化清晰。
  const minGap = count <= 3 ? 22 : 18;
  for (let i = 1; i < count - 1; i += 1) {
    const ratio = i / (count - 1);
    const interpolated = Math.round(values[0] + (values[count - 1] - values[0]) * ratio);
    const blended = Math.round(values[i] * 0.55 + interpolated * 0.45);
    const lowerBound = values[i - 1] + minGap;
    const upperBound = values[count - 1] - minGap * (count - 1 - i);
    values[i] = clamp(blended, lowerBound, Math.max(lowerBound, upperBound));
  }

  return ordered.map((entry, idx) => ({
    ...entry,
    quotation: values[idx],
  }));
}

function shuffleDeterministic(items, seedText) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(h32(`${seedText}#${i}`) * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// 对单回合的 3–4 个候选话术执行完整报价打分、梯度校准与展示顺序洗牌。
export function scoreRoundOptions(rawOptions, graph, searchItems = [], { seed = '' } = {}) {
  const validGraph = Array.isArray(graph) && graph.length ? graph : normalizeBeliefGraph([]);
  const normalizedInput = (Array.isArray(rawOptions) ? rawOptions : [])
    .filter((item) => item && typeof item.text === 'string' && item.text.trim())
    .slice(0, 4);

  const scored = normalizedInput.map((option, index) => {
    const metrics = computeRawQuotation(option, validGraph, searchItems);
    return { option, index, ...metrics };
  });

  const calibrated = calibrateQuotations(scored);
  const shuffled = shuffleDeterministic(calibrated, seed || calibrated.map((item) => item.option.text).join('|'));
  const labels = ['A', 'B', 'C', 'D'];

  return shuffled.map((entry, idx) => {
    const quotation = entry.quotation;
    const difficulty = difficultyFromQuotation(quotation);
    const willpowerDelta = computeWillpowerDelta(quotation);
    const damage = -willpowerDelta;
    return {
      id: `opt-${idx + 1}`,
      label: labels[idx] ?? String(idx + 1),
      text: entry.option.text.trim(),
      tactic: String(entry.option.tactic ?? '').trim(),
      flawLevel: clamp(Number(entry.option.flawLevel) || 0, 0, 2),
      conflicts: entry.directConflicts,
      deadCount: entry.deadCount,
      quotation,
      difficulty,
      willpowerDelta,
      damage,
      appropriate: isChoiceAppropriate(difficulty),
      rationale: String(entry.option.rationale ?? '').trim(),
      knowledgePoint: entry.option.knowledgePoint && typeof entry.option.knowledgePoint === 'object'
        ? {
            title: String(entry.option.knowledgePoint.title ?? '').trim(),
            detail: String(entry.option.knowledgePoint.detail ?? '').trim(),
          }
        : null,
    };
  });
}
