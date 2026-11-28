// 星图写入 Agent（实时监听星球数据库变动，语义归类星系与分支，写入 3D 星图）：
// 核心职责：
// 1. 实时监听 planets-db.json 的变动（进程内事件 + fs.watch 文件变更），按序将新增条目写入星图；
// 2. 语义判断知识领域：严禁死板按字面字符串拆分（例如“AI”与“人工智能”归为同一领域），优先归入已有星系，不可随意新建大量零散区域；仅在明显属于尚不存在的新领域时开辟新星系；
// 3. 分支与配色：同一知识领域内的不同方向作为不同分支（如人工智能下的“多模态学习”与“强化学习”），同分支星球颜色完全相同，不同分支星球颜色明显区分；
// 4. 关联连线：既支持同分支内相关星球连线，也支持跨分支（乃至跨星系）确有关联的知识点连线；
// 5. 权重视觉编码：星球大小与亮度严格随权重单调递增（权重越高，星球越大越亮）。
import { EventEmitter } from 'node:events';
import { generateStructuredJson } from './llm.mjs';

// 12 组高对比、协调的星图分支 RGB 色板（确保不同分支色彩鲜明区分，同分支严格同色）
export const BRANCH_PALETTE = Object.freeze([
  [114, 188, 255], // 天穹蓝
  [255, 198, 102], // 琥珀金
  [120, 232, 186], // 极光青绿
  [244, 132, 178], // 星云玫粉
  [178, 148, 255], // 曜石紫
  [255, 148, 108], // 日珥珊瑚橙
  [92, 224, 238],  // 冰晶青
  [196, 236, 114], // 萤石嫩绿
  [255, 116, 132], // 红巨星绯红
  [136, 162, 255], // 靛青星辉
  [246, 214, 146], // 暖沙金
  [148, 226, 213], // 碧玉青
]);

// 常见同义领域词表（用于语义归并辅助校验与离线兜底，防止字面不同导致错误拆星系）
const SEMANTIC_DOMAIN_GROUPS = [
  ['人工智能', ['ai', 'aigc', 'llm', '大模型', '机器学习', '深度学习', '计算机与人工智能', '人工智能与深度学习', '神经网络', '自然语言处理', '计算机视觉', '多模态', '强化学习']],
  ['物理学', ['物理', '量子力学', '量子物理', '理论物理', '天体物理', '经典力学', '自然科学与物理']],
  ['认知心理学', ['心理学', '心理', '认知科学', '认知心理', '脑科学', '行为心理学', '医学与心理']],
  ['经济学与决策', ['经济学', '行为经济学', '金融', '金融学', '博弈论', '微观经济学', '宏观经济学', '决策科学']],
  ['数学与信息论', ['数学', '信息论', '概率论', '统计学', '概率与统计', '应用数学']],
  ['生物医学', ['生物学', '分子生物学', '基因工程', '免疫学', '医学', '生命科学', '临床医学', '神经生物学']],
  ['计算机系统与工程', ['计算机', '计算机科学', '操作系统', '分布式系统', '软件工程', '数据库', '编程语言']],
  ['人文与社会', ['历史', '哲学', '社会学', '文学', '法学', '政治学', '人文社科']],
];

export const STAR_WRITER_INSTRUCTIONS = [
  '你是「星图写入 Agent」，负责将星球数据库中新增的知识点逐一写入 3D 知识星图中的最合理位置，并维护星系、分支、色彩一致性与知识点连线。',
  '',
  '【必须严格遵守的领域与位置决策规则】',
  '1. 语义归类，严禁死板字面匹配：',
  '   - 在决定一条知识点属于哪个星系（领域）时，绝不能机械比较字段字符串是否完全一致！',
  '   - 必须从语义内涵判断：例如“AI”“人工智能”“大模型”“机器学习”“强化学习”“多模态”在语义上都属于同一个领域（人工智能），必须归入已有星系，绝不可拆分成多个星系！',
  '   - 同样，“心理学”与“认知心理学”、“物理”与“量子力学”、“概率论”与“数学与信息论”应优先归入语义覆盖的已有星系。',
  '   - 只有在知识点明显属于当前星图中完全不存在的独立大领域（例如已有星图只有人工智能和心理学，新来了“生物医学”或“物理学”）时，才允许设置 createNewGalaxy: true 开辟一个新星系！切忌随意新建大量零散星系。',
  '2. 分支划分（branchName）：',
  '   - 一个领域星系内部包含若干细分方向（分支），例如“人工智能”星系下可有“多模态学习”“强化学习与对齐”“大模型推理与架构”等分支。',
  '   - 能契合已有分支的优先归入已有分支（同分支星球将共享完全相同的颜色）；属于该领域内新的细分方向时，给出简洁清晰的新分支名（2-10 字，系统会自动分配不同颜色）。',
  '   - 每个星系内的分支数量保持克制（通常 2-6 个清晰方向，不要一颗星球就建一个分支）。',
  '3. 关联连线（links）：',
  '   - 从“已有星球列表”中挑选与新知识点存在真实知识关联（前置依赖、互补机制、跨学科类比、共享数学/理论基础等）的 1-3 颗星球建立连线。',
  '   - 优先连接同星系内的相关星球；若与其他分支（甚至其他星系）的某个知识点确实存在实质关联（例如“信息熵”连接“对比学习”或“GRPO KL 散度”，“双系统理论”连接“前景理论”），也应当大方建立跨分支连线并写明简短理由 reason！',
  '   - 不要为了凑数胡乱连线；确实没有任何相关星球时 links 可为空数组。',
  '4. 只输出一个合法 JSON 对象，不要 Markdown 代码块，不要任何多余解释。',
  '',
  'JSON 输出结构：',
  '{',
  '  "placements": [',
  '    {',
  '      "planetDbId": "PL-0001",',
  '      "createNewGalaxy": false,',
  '      "galaxyId": "已有星系 id（当 createNewGalaxy=false 时必填）",',
  '      "newGalaxyName": "新星系规范名称（仅当 createNewGalaxy=true 时填写）",',
  '      "branchName": "所属分支名（优先复用该星系已有分支名）",',
  '      "links": [',
  '        { "targetPlanetId": "已有星球 id 或本批次中靠前的 planetDbId", "reason": "简短关联说明（10-28字）", "strength": 0.85 }',
  '      ]',
  '    }',
  '  ]',
  '}',
].join('\n');

export function canonicalizeDomainName(rawDomain) {
  const norm = String(rawDomain || '').trim().toLowerCase();
  if (!norm) return '跨学科探索';
  for (const [canonical, aliases] of SEMANTIC_DOMAIN_GROUPS) {
    if (canonical.toLowerCase() === norm || aliases.some((a) => norm === a || norm.includes(a) || a.includes(norm))) {
      return canonical;
    }
  }
  return String(rawDomain || '').trim();
}

export function findSemanticMatchingGalaxy(galaxies, rawDomain, knowledgePoint = '') {
  const targetCanonical = canonicalizeDomainName(rawDomain);
  const normRaw = String(rawDomain || '').trim().toLowerCase();
  const text = `${rawDomain || ''} ${knowledgePoint || ''}`.toLowerCase();

  for (const g of galaxies) {
    const gCanonical = canonicalizeDomainName(g.name);
    if (gCanonical === targetCanonical) return g;
    if (g.name.toLowerCase() === normRaw) return g;
    if ((g.aliases || []).some((alias) => alias.toLowerCase() === normRaw || canonicalizeDomainName(alias) === targetCanonical)) {
      return g;
    }
  }
  // 再按关键词语义组匹配一次
  for (const [canonical, aliases] of SEMANTIC_DOMAIN_GROUPS) {
    if (aliases.some((a) => a.length >= 2 && text.includes(a))) {
      const hit = galaxies.find((g) => canonicalizeDomainName(g.name) === canonical);
      if (hit) return hit;
    }
  }
  return null;
}

// 暂取消大小与亮度区分（统一为 1.0），保留 weight 字段供后续按需开启视觉权重区分
export function computeVisualMetricsFromWeight(weight) {
  const w = Math.max(1, Math.min(100, Number(weight) || 50));
  return {
    weight: Math.round(w),
    sizeFactor: 1,
    brightness: 1,
  };
}

// 为新星系计算 3D 空间中心坐标（黄金角立体分布，确保星系间彼此独立且视觉均衡）
export function computeNextGalaxyCenter(existingCount) {
  if (existingCount === 0) return { x: 0, y: 0, z: 0 };
  const goldenAngle = 2.399963229728653; // ~137.508°
  const ring = Math.ceil(existingCount / 6);
  const radius = 320 + (ring - 1) * 210 + (existingCount % 2) * 35;
  const theta = existingCount * goldenAngle;
  const elev = Math.sin(existingCount * 1.35) * 115;
  return {
    x: Number((Math.cos(theta) * radius).toFixed(2)),
    y: Number(elev.toFixed(2)),
    z: Number((Math.sin(theta) * radius).toFixed(2)),
  };
}

function pickDistinctBranchColor(galaxy, allGalaxies) {
  const usedInGalaxy = new Set((galaxy.branches || []).map((b) => JSON.stringify(b.color)));
  for (const color of BRANCH_PALETTE) {
    if (!usedInGalaxy.has(JSON.stringify(color))) return [...color];
  }
  const totalBranches = allGalaxies.reduce((sum, g) => sum + (g.branches?.length || 0), 0);
  return [...BRANCH_PALETTE[totalBranches % BRANCH_PALETTE.length]];
}

// 为星球计算位于其所属星系与分支扇区内的无碰撞 3D 坐标
function computePlanetPosition(galaxy, branch, existingPlanets, weight) {
  const branchIndex = Math.max(0, (galaxy.branches || []).findIndex((b) => b.id === branch.id));
  const branchCount = Math.max(1, (galaxy.branches || []).length);
  const baseAngle = branch.sectorAngle ?? (branchIndex * 2.3999632) % (Math.PI * 2);

  const peersInBranch = existingPlanets.filter((p) => p.galaxyId === galaxy.id && p.branchId === branch.id);
  const rank = peersInBranch.length;

  // 权重越高越靠近分支主干与星系内圈，形成星核—星臂层次感
  const weightPull = 1 - ((Math.max(1, Math.min(100, weight)) - 1) / 99) * 0.42;
  let bestPos = null;

  for (let attempt = 0; attempt < 28; attempt += 1) {
    const spread = ((attempt % 7) - 3) * 0.16 + (rank % 3 - 1) * 0.22;
    const angle = baseAngle + spread + Math.floor(attempt / 7) * 0.35;
    const radialDist = (44 + rank * 22 + attempt * 7) * weightPull + (branchCount > 1 ? 18 : 0);
    const yOffset = Math.sin((rank + attempt + 1) * 1.7 + branchIndex) * (32 + rank * 6);

    const candidate = {
      x: Number((galaxy.center.x + Math.cos(angle) * radialDist).toFixed(2)),
      y: Number((galaxy.center.y + yOffset).toFixed(2)),
      z: Number((galaxy.center.z + Math.sin(angle) * radialDist).toFixed(2)),
    };

    const minDist = existingPlanets.reduce((min, p) => {
      const dx = p.pos.x - candidate.x;
      const dy = p.pos.y - candidate.y;
      const dz = p.pos.z - candidate.z;
      return Math.min(min, Math.hypot(dx, dy, dz));
    }, Infinity);

    if (minDist >= 30 || attempt === 27) {
      bestPos = candidate;
      break;
    }
  }

  return bestPos;
}

// 规则兜底分支命名（仅在无模型配置时启用）
function inferBranchFallback(galaxyName, entry) {
  const text = `${entry.domain} ${entry.knowledgePoint} ${entry.summary}`.toLowerCase();
  if (canonicalizeDomainName(galaxyName) === '人工智能') {
    if (/多模态|视觉|图像|clip|vlm|扩散|diffusion|projector/.test(text)) return '多模态与生成';
    if (/强化学习|rlhf|grpo|ppo|奖励|对齐|策略/.test(text)) return '强化学习与对齐';
    if (/推理|kv cache|attention|rope|位置编码|架构|显存|部署/.test(text)) return '大模型架构与推理';
    return '通用智能基础';
  }
  if (canonicalizeDomainName(galaxyName) === '生物医学') {
    if (/基因|crispr|dna|编辑/.test(text)) return '基因与分子编辑';
    if (/疫苗|免疫|mrna|lnp/.test(text)) return '免疫与核酸递送';
    return '生命科学基础';
  }
  if (canonicalizeDomainName(galaxyName) === '认知心理学') {
    if (/记忆|组块|学习/.test(text)) return '记忆与学习机制';
    return '认知与判断偏差';
  }
  if (canonicalizeDomainName(galaxyName) === '经济学与决策') {
    return '行为经济与风险决策';
  }
  if (canonicalizeDomainName(galaxyName) === '数学与信息论') {
    return /熵|信息论/.test(text) ? '信息论基础' : '概率与贝叶斯推断';
  }
  if (canonicalizeDomainName(galaxyName) === '物理学') {
    return /量子/.test(text) ? '量子力学基础' : '基础物理原理';
  }
  return `${galaxyName}核心分支`;
}

// 规则兜底关联探测（支持同分支与跨分支语义连线）
function inferLinksFallback(entry, existingPlanets) {
  const text = `${entry.knowledgePoint} ${entry.summary}`.toLowerCase();
  const scored = [];
  const crossKeywords = [
    ['kl', '散度', '熵'],
    ['概率', '贝叶斯', '决策', '偏差', '前景理论'],
    ['注意力', '投影', '多模态', '扩散', 'clip'],
    ['记忆', '认知', '双系统', '决策'],
    ['rna', '基因', '免疫', '疫苗'],
  ];

  for (const peer of existingPlanets) {
    const peerText = `${peer.knowledgePoint} ${peer.summary}`.toLowerCase();
    let score = 0;
    let reason = '';

    if (canonicalizeDomainName(peer.domain) === canonicalizeDomainName(entry.domain)) {
      score += 0.45;
      reason = `同属「${peer.domain}」领域的相关知识节点`;
    }
    for (const group of crossKeywords) {
      const aHit = group.some((kw) => text.includes(kw));
      const bHit = group.some((kw) => peerText.includes(kw));
      if (aHit && bHit) {
        score += 0.55;
        reason =
          canonicalizeDomainName(peer.domain) === canonicalizeDomainName(entry.domain)
            ? `共享核心机制与概念脉络（${group.find((kw) => text.includes(kw))}）`
            : `跨分支/跨领域理论关联（${group.find((kw) => text.includes(kw))}）`;
        break;
      }
    }

    if (score >= 0.45) {
      scored.push({ targetPlanetId: peer.id, reason, strength: Math.min(0.95, score) });
    }
  }

  return scored.sort((a, b) => b.strength - a.strength).slice(0, 2);
}

function buildWriterPrompt(starMap, pendingBatch) {
  const galaxiesSummary = starMap.galaxies.map((g) => ({
    galaxyId: g.id,
    name: g.name,
    aliases: g.aliases || [],
    branches: (g.branches || []).map((b) => b.name),
  }));

  const existingPlanets = starMap.planets.slice(-80).map((p) => ({
    id: p.id,
    galaxyId: p.galaxyId,
    domain: p.domain,
    branchName: p.branchName,
    knowledgePoint: p.knowledgePoint,
    summary: p.summary.slice(0, 80),
  }));

  const incoming = pendingBatch.map((e) => ({
    planetDbId: e.id,
    domain: e.domain,
    knowledgePoint: e.knowledgePoint,
    summary: e.summary,
    weight: e.weight,
  }));

  return [
    '【当前星图已有星系（领域）与分支】',
    galaxiesSummary.length ? JSON.stringify(galaxiesSummary, null, 2) : '（当前星图为空，尚无星系）',
    '',
    '【当前星图已有星球（可用于建立同分支或跨分支连线）】',
    existingPlanets.length ? JSON.stringify(existingPlanets, null, 2) : '（尚无已有星球）',
    '',
    `【星球数据库新增待写入条目（共 ${incoming.length} 条）】`,
    JSON.stringify(incoming, null, 2),
    '',
    '请为以上每条待写入条目决策归属星系（严禁死板字面拆分同义领域）、所属分支与关联连线。',
  ].join('\n');
}

export function createStarWriterAgent({ planetsDb, starMapStore, getModel, onStarMapUpdated }) {
  const events = new EventEmitter();
  let queue = Promise.resolve();
  let processing = false;
  let watching = false;
  let lastRunStats = null;

  function ensureGalaxy(starMap, { createNewGalaxy, galaxyId, newGalaxyName, rawDomain, knowledgePoint }) {
    // 1. 优先按显式 galaxyId 查找
    if (!createNewGalaxy && galaxyId) {
      const byId = starMap.galaxies.find((g) => g.id === galaxyId);
      if (byId) {
        if (rawDomain && !byId.aliases.includes(rawDomain) && byId.name !== rawDomain) {
          byId.aliases.push(rawDomain);
        }
        return { galaxy: byId, created: false };
      }
    }

    // 2. 语义防重复兜底：即使模型误设 createNewGalaxy=true，若语义上与已有星系一致，仍归入已有星系！
    const semanticMatch = findSemanticMatchingGalaxy(starMap.galaxies, newGalaxyName || rawDomain, knowledgePoint);
    if (semanticMatch) {
      if (rawDomain && !semanticMatch.aliases.includes(rawDomain) && semanticMatch.name !== rawDomain) {
        semanticMatch.aliases.push(rawDomain);
      }
      return { galaxy: semanticMatch, created: false };
    }

    // 3. 确实属于新领域：开辟新星系
    const canonicalName = canonicalizeDomainName(newGalaxyName || rawDomain);
    const id = `gal-${starMap.galaxies.length + 1}`;
    const galaxy = {
      id,
      name: canonicalName,
      aliases: rawDomain && rawDomain !== canonicalName ? [rawDomain] : [],
      center: computeNextGalaxyCenter(starMap.galaxies.length),
      branches: [],
      createdAt: new Date().toISOString(),
    };
    starMap.galaxies.push(galaxy);
    return { galaxy, created: true };
  }

  function ensureBranch(starMap, galaxy, branchName) {
    const cleanName = String(branchName || '').trim().slice(0, 24) || `${galaxy.name}综合分支`;
    const existing = galaxy.branches.find(
      (b) => b.name.toLowerCase() === cleanName.toLowerCase() || b.name.includes(cleanName) || cleanName.includes(b.name),
    );
    if (existing) return existing;

    const branchIndex = galaxy.branches.length;
    const branch = {
      id: `${galaxy.id}-br-${branchIndex + 1}`,
      name: cleanName,
      color: pickDistinctBranchColor(galaxy, starMap.galaxies),
      sectorAngle: Number(((branchIndex * 2.3999632) % (Math.PI * 2)).toFixed(4)),
    };
    galaxy.branches.push(branch);
    return branch;
  }

  function applyPlacementToStarMap(starMap, entry, decision) {
    const alreadyExists = starMap.planets.find((p) => p.planetDbId === entry.id);
    if (alreadyExists) {
      // 已写入则只同步最新权重、摘要与出处列表
      const metrics = computeVisualMetricsFromWeight(entry.weight);
      alreadyExists.weight = metrics.weight;
      alreadyExists.sizeFactor = metrics.sizeFactor;
      alreadyExists.brightness = metrics.brightness;
      alreadyExists.summary = entry.summary;
      if (Array.isArray(entry.sources) && entry.sources.length) {
        alreadyExists.sources = entry.sources;
      }
      return { planet: alreadyExists, createdGalaxy: false, addedLinks: [] };
    }

    const { galaxy, created: createdGalaxy } = ensureGalaxy(starMap, {
      createNewGalaxy: Boolean(decision?.createNewGalaxy),
      galaxyId: decision?.galaxyId,
      newGalaxyName: decision?.newGalaxyName,
      rawDomain: entry.domain,
      knowledgePoint: entry.knowledgePoint,
    });

    const branch = ensureBranch(
      starMap,
      galaxy,
      decision?.branchName || inferBranchFallback(galaxy.name, entry),
    );

    const metrics = computeVisualMetricsFromWeight(entry.weight);
    const pos = computePlanetPosition(galaxy, branch, starMap.planets, metrics.weight);

    const planet = {
      id: entry.id,
      planetDbId: entry.id,
      galaxyId: galaxy.id,
      domain: galaxy.name,
      rawDomain: entry.domain,
      branchId: branch.id,
      branchName: branch.name,
      color: [...branch.color],
      knowledgePoint: entry.knowledgePoint,
      summary: entry.summary,
      weight: metrics.weight,
      sizeFactor: metrics.sizeFactor,
      brightness: metrics.brightness,
      pos,
      sourceRecordKeys: entry.sourceRecordKeys || [],
      sources: Array.isArray(entry.sources) ? entry.sources : [],
      placedAt: new Date().toISOString(),
    };
    starMap.planets.push(planet);

    // 写入关联连线（允许同分支与跨分支/跨星系连线）
    const addedLinks = [];
    const candidateLinks = Array.isArray(decision?.links) ? decision.links : [];
    for (const rawLink of candidateLinks.slice(0, 4)) {
      const targetId = String(rawLink?.targetPlanetId || '').trim();
      if (!targetId || targetId === planet.id) continue;
      const target = starMap.planets.find((p) => p.id === targetId || p.planetDbId === targetId);
      if (!target) continue;

      const duplicate = starMap.links.some(
        (l) => (l.from === planet.id && l.to === target.id) || (l.from === target.id && l.to === planet.id),
      );
      if (duplicate) continue;

      const crossBranch = planet.branchId !== target.branchId || planet.galaxyId !== target.galaxyId;
      const crossGalaxy = planet.galaxyId !== target.galaxyId;
      const link = {
        from: planet.id,
        to: target.id,
        reason: String(rawLink?.reason || '知识点关联').trim().slice(0, 60),
        strength: Number(Math.max(0.3, Math.min(1, Number(rawLink?.strength) || 0.75)).toFixed(2)),
        crossBranch,
        crossGalaxy,
      };
      starMap.links.push(link);
      addedLinks.push(link);
    }

    return { planet, createdGalaxy, addedLinks };
  }

  async function processPendingInternal() {
    const pending = await planetsDb.getPending();
    if (pending.length === 0) {
      const currentMap = await starMapStore.read();
      return {
        placedCount: 0,
        newGalaxies: 0,
        addedLinks: 0,
        totalGalaxies: currentMap.galaxies.length,
        totalPlanets: currentMap.planets.length,
        totalLinks: currentMap.links.length,
        starMap: currentMap,
      };
    }

    processing = true;
    try {
      const starMap = await starMapStore.read();
      const { model } = await getModel();
      const mode = model ? 'llm' : 'fallback_rules';
      const batchSize = 8;
      let placedCount = 0;
      let newGalaxies = 0;
      let addedLinks = 0;
      const placedIds = [];
      const newlyPlacedPlanets = [];

      for (let i = 0; i < pending.length; i += batchSize) {
        const batch = pending.slice(i, i + batchSize);
        let placementsById = new Map();

        if (model) {
          const json = await generateStructuredJson({
            model,
            instructions: STAR_WRITER_INSTRUCTIONS,
            prompt: buildWriterPrompt(starMap, batch),
            temperature: 0.15,
            timeoutMs: 90_000,
          });
          const list = Array.isArray(json?.placements) ? json.placements : [];
          for (const item of list) {
            if (item?.planetDbId) placementsById.set(String(item.planetDbId), item);
          }
        }

        for (const entry of batch) {
          let decision = placementsById.get(entry.id);
          if (!decision) {
            // 兜底逻辑（无模型配置或单条缺失时）
            const match = findSemanticMatchingGalaxy(starMap.galaxies, entry.domain, entry.knowledgePoint);
            const targetDomain = match ? match.name : canonicalizeDomainName(entry.domain);
            decision = {
              planetDbId: entry.id,
              createNewGalaxy: !match,
              galaxyId: match?.id || null,
              newGalaxyName: match ? null : targetDomain,
              branchName: inferBranchFallback(targetDomain, entry),
              links: inferLinksFallback(entry, starMap.planets),
            };
          }

          const { planet, createdGalaxy, addedLinks: links } = applyPlacementToStarMap(starMap, entry, decision);
          placedIds.push(entry.id);
          newlyPlacedPlanets.push(planet);
          placedCount += 1;
          if (createdGalaxy) newGalaxies += 1;
          addedLinks += links.length;
        }
      }

      const savedMap = await starMapStore.save(starMap);
      await planetsDb.markPlaced(placedIds);

      lastRunStats = {
        mode,
        placedCount,
        newGalaxies,
        addedLinks,
        totalGalaxies: savedMap.galaxies.length,
        totalPlanets: savedMap.planets.length,
        totalLinks: savedMap.links.length,
        updatedAt: savedMap.updatedAt,
      };

      events.emit('placed', { stats: lastRunStats, newlyPlacedPlanets, starMap: savedMap });
      onStarMapUpdated?.({ stats: lastRunStats, newlyPlacedPlanets, starMap: savedMap });

      return { ...lastRunStats, starMap: savedMap };
    } finally {
      processing = false;
    }
  }

  function processPending() {
    const task = queue.then(() => processPendingInternal(), () => processPendingInternal());
    queue = task.catch(() => {});
    return task;
  }

  async function rebuildAll() {
    await starMapStore.clear();
    await planetsDb.resetAllPending();
    return processPending();
  }

  const handleDbChange = ({ reason }) => {
    // 忽略自身刚写回 placed 状态或出处回填触发的事件，避免空循环
    if (reason === 'planets_placed' || reason === 'planets_sources_backfilled' || reason === 'init') return;
    processPending().catch((err) => {
      events.emit('error', err);
    });
  };

  function startWatching() {
    if (watching) return;
    watching = true;
    planetsDb.events.on('change', handleDbChange);
    planetsDb.startWatching();
    // 启动时自动检查是否已有待写入条目
    processPending().catch((err) => {
      events.emit('error', err);
    });
  }

  function stopWatching() {
    if (!watching) return;
    watching = false;
    planetsDb.events.off('change', handleDbChange);
    planetsDb.stopWatching();
  }

  return {
    events,
    startWatching,
    stopWatching,
    processPending,
    rebuildAll,
    isProcessing: () => processing,
    getLastStats: () => lastRunStats,
  };
}
