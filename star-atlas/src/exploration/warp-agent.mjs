// 星球探索 · 跃迁子模块（Warp Agent）：
// 从星图中某颗已有星球出发，结合其「知识点本体」与「出处」进行知识联想，
// 调用知乎搜索工具寻找强知识性且互动数据较好（赞同量、评论量、浏览量等）的知乎帖子，
// 精选出 3 个最符合条件的跃迁目标，分别展示：帖子标题、最简明摘要、以及用户通过阅读可能获得的知识或解决的疑问。
import { randomUUID } from 'node:crypto';
import { generateStructuredJson } from '../agents/llm.mjs';

const QUERY_GEN_INSTRUCTIONS = [
  '你是「星球探索 · 跃迁联想 Agent」。用户正在查看 3D 知识星图中的一颗已有知识点星球，希望通过“跃迁”发现 3 篇高质量、强知识属性的知乎延伸帖子来拓展认知。',
  '',
  '任务：根据该星球的「领域、分支、核心知识点、知识摘要」并参考其「原始出处」，联想出 3 个适合在知乎检索的高质量中文搜索关键词短语（每个 4-18 字），分别面向不同知识延伸维度：',
  '1. 原理深化或关键机制拆解；',
  '2. 实战落地、工程对比或经典案例；',
  '3. 相邻概念衔接、常见误区澄清或跨方向启发。',
  '',
  '要求：',
  '- 紧扣「让用户获取真实知识」为前提，绝不生成八卦、吐槽、网文、水贴导向的搜索词；',
  '- 搜索词应简洁自然、贴近知乎高赞硬核回答/专栏常见标题表达，不要堆砌过多生僻符号；',
  '- 只输出一个合法 JSON 对象，不要 Markdown 代码块或多余文字。',
  '',
  'JSON 结构：',
  '{ "queries": ["搜索词1", "搜索词2", "搜索词3"] }',
].join('\n');

const CURATE_TARGETS_INSTRUCTIONS = [
  '你是「星球探索 · 跃迁策展 Agent」。你已经通过知乎搜索工具获取了一批与当前知识星球相关的候选帖子，现在需要从中精选出最值得用户跃迁阅读的 3 篇帖子。',
  '',
  '筛选与排序硬性原则：',
  '1. 以「让用户获取扎实知识或解决真实疑问」为第一前提，坚决淘汰情绪吐槽、八卦、网文故事、广告软文或纯空泛鸡汤；',
  '2. 在满足知识价值的前提下，优先选择互动数据更好（赞同数、评论数、浏览量更高或排名分更高）且与原星球形成良好知识延伸（而非内容高度重复）的帖子；',
  '3. 恰好选出 3 篇最符合条件的帖子（若候选总数不足 3 篇则全选），且 3 篇尽量覆盖不同切入角度（例如：原理深化 / 实践指南 / 延伸对比）；',
  '4. 每个跃迁目标必须提供：',
  '   - candidateKey：必须严格等于候选项中的 key；',
  '   - associationAngle：4-8 字的跃迁维度标签（如「原理深化」「工程实践」「误区澄清」「跨界延伸」）；',
  '   - briefSummary：最简明摘要（25-65 字，一两句话说清帖子核心内容，去掉废话）；',
  '   - knowledgeGain：阅读收益说明（25-65 字，明确告诉用户读完这篇能学到什么具体知识，或能解决什么关键疑问）。',
  '5. 只输出一个合法 JSON 对象，不要 Markdown 代码块或多余文字。',
  '',
  'JSON 结构：',
  '{',
  '  "targets": [',
  '    {',
  '      "candidateKey": "answer:123456",',
  '      "associationAngle": "原理深化",',
  '      "briefSummary": "最简明摘要...",',
  '      "knowledgeGain": "读完可掌握……并解决……疑问。"',
  '    }',
  '  ]',
  '}',
].join('\n');

const NOISE_RE = /穿越|重生|爽文|网文|修仙|晒.*日常|吃瓜|明星.*翻车|哈哈哈|笑死我了|买什么好.*广告|引流课/;

function engagementScore(item) {
  const votes = Math.max(0, Number(item.voteCount) || 0);
  const comments = Math.max(0, Number(item.commentCount) || 0);
  const views = Math.max(0, Number(item.viewCount) || 0);
  const rank = Number.isFinite(Number(item.rankingScore)) ? Number(item.rankingScore) * 2.5 : 0;
  const excerptBonus = Math.min(2, (item.excerpt?.length || 0) / 140);
  const typeBonus = item.contentType === 'answer' || item.contentType === 'article' ? 1.2 : 0.4;
  return (
    Math.log1p(votes) * 1.6 +
    Math.log1p(comments) * 1.3 +
    Math.log1p(views) * 0.45 +
    rank +
    excerptBonus +
    typeBonus
  );
}

function isKnowledgeCandidate(item) {
  if (!item?.title || !item?.key) return false;
  const text = `${item.title} ${item.excerpt || ''}`;
  if (NOISE_RE.test(text)) return false;
  if ((item.title?.length || 0) < 4) return false;
  return true;
}

function buildFallbackQueries(planet) {
  const kp = String(planet.knowledgePoint || '').trim();
  const domain = String(planet.domain || '').trim();
  const branch = String(planet.branchName || '').trim();
  const queries = [
    `${kp} 原理`,
    branch && branch !== kp ? `${kp} ${branch} 实践` : `${kp} 实践 案例`,
    domain && domain !== kp ? `${domain} ${kp} 进阶` : `${kp} 深度解析`,
  ];
  return [...new Set(queries.map((q) => q.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 3);
}

function buildFallbackTargets(candidates, planet) {
  const angles = ['原理深化', '实践延伸', '视野拓展'];
  return candidates.slice(0, 3).map((item, idx) => ({
    candidateKey: item.key,
    associationAngle: angles[idx] || '知识延伸',
    briefSummary: (item.excerpt || item.title).replace(/\s+/g, ' ').trim().slice(0, 68),
    knowledgeGain: `围绕「${planet.knowledgePoint}」进一步拓展相关背景与实操方法，补充该方向的系统认知。`,
  }));
}

export function createWarpAgent({ starMapStore, planetsDb, searchTool, getModel }) {
  // 暂存最近的跃迁候选会话（最多保留 30 条，避免内存增长）
  const sessions = new Map();

  function rememberSession(session) {
    sessions.set(session.warpId, session);
    if (sessions.size > 30) {
      const oldestKey = sessions.keys().next().value;
      sessions.delete(oldestKey);
    }
  }

  async function propose({ planetId, signal } = {}) {
    if (!planetId) throw new Error('缺少目标星球编号 planetId。');

    const [starMap, pDb] = await Promise.all([starMapStore.read(), planetsDb.read()]);
    const planet = starMap.planets.find((p) => p.id === planetId || p.planetDbId === planetId);
    const dbRec = pDb.records.find((r) => r.id === planetId);
    if (!planet && !dbRec) {
      throw Object.assign(new Error(`未找到编号为 ${planetId} 的星球。`), { status: 404 });
    }

    const originPlanet = {
      id: planet?.id || dbRec.id,
      domain: planet?.domain || dbRec.domain,
      branchName: planet?.branchName || '',
      knowledgePoint: planet?.knowledgePoint || dbRec.knowledgePoint,
      summary: planet?.summary || dbRec.summary,
      sources: (planet?.sources?.length ? planet.sources : dbRec?.sources) || [],
    };

    const { model } = await getModel();

    // 1. 生成联想搜索词
    let queries = buildFallbackQueries(originPlanet);
    if (model) {
      try {
        const sourceTitles = originPlanet.sources.map((s) => s.title).filter(Boolean).slice(0, 3);
        const prompt = [
          `【当前星球知识点】${originPlanet.knowledgePoint}`,
          `【所属领域与分支】${originPlanet.domain}${originPlanet.branchName ? ` · ${originPlanet.branchName}` : ''}`,
          `【知识点摘要】${originPlanet.summary}`,
          sourceTitles.length ? `【原始出处参考】${sourceTitles.join('；')}` : '',
          '',
          '请基于上述知识点与出处，联想 3 个最适合知乎检索的知识拓展搜索词。',
        ]
          .filter(Boolean)
          .join('\n');
        const qJson = await generateStructuredJson({
          model,
          instructions: QUERY_GEN_INSTRUCTIONS,
          prompt,
          temperature: 0.35,
          timeoutMs: 30_000,
          signal,
        });
        if (Array.isArray(qJson?.queries) && qJson.queries.length > 0) {
          const valid = qJson.queries.map((q) => String(q || '').trim()).filter((q) => q.length >= 2).slice(0, 3);
          if (valid.length > 0) queries = valid;
        }
      } catch {
        // 模型超时或解析异常时无缝回退本地联想词
      }
    }

    // 2. 并行调用知乎搜索工具获取候选帖子
    const originKeys = new Set([
      ...originPlanet.sources.map((s) => s.key).filter(Boolean),
      ...(dbRec?.sourceRecordKeys || []),
    ]);
    const originTitles = new Set(originPlanet.sources.map((s) => (s.title || '').trim().toLowerCase()).filter(Boolean));

    const searchRuns = await Promise.all(
      queries.map((q) =>
        searchTool
          .search(q, { limit: 7, signal })
          .catch((err) => ({ provider: 'error', query: q, items: [], error: err?.message })),
      ),
    );

    const candidateMap = new Map();
    let providerUsed = null;
    let firstError = null;
    for (const run of searchRuns) {
      if (run.error && !firstError) firstError = run.error;
      if (run.provider && run.provider !== 'error') providerUsed = run.provider;
      for (const item of run.items || []) {
        if (!isKnowledgeCandidate(item)) continue;
        if (originKeys.has(item.key)) continue;
        if (originTitles.has((item.title || '').trim().toLowerCase())) continue;
        if (!candidateMap.has(item.key)) {
          candidateMap.set(item.key, { ...item, matchedQuery: run.query, _score: engagementScore(item) });
        }
      }
    }

    const rankedCandidates = [...candidateMap.values()]
      .sort((a, b) => b._score - a._score)
      .slice(0, 12);

    if (rankedCandidates.length === 0) {
      throw Object.assign(
        new Error(firstError || '未能通过知乎搜索找到合适的相关知识帖子，请检查搜索凭据或网络后重试。'),
        { status: 502 },
      );
    }

    // 3. 由跃迁策展 Agent 精选 3 个最佳跃迁目标
    let curated = null;
    if (model) {
      try {
        const candidateLines = rankedCandidates.map((c, idx) =>
          [
            `${idx + 1}. key=${c.key} | 类型=${c.contentType} | 赞同=${c.voteCount ?? '未知'} | 评论=${c.commentCount ?? '未知'} | 浏览=${c.viewCount ?? '未知'}`,
            `   标题：${c.title}`,
            c.author ? `   作者：${c.author}${c.authorBadge ? `（${c.authorBadge}）` : ''}` : '',
            c.excerpt ? `   节选：${c.excerpt.slice(0, 220)}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
        const prompt = [
          `【跃迁起点星球】${originPlanet.knowledgePoint}（${originPlanet.domain}）`,
          `【起点摘要】${originPlanet.summary}`,
          '',
          `【知乎搜索候选帖子（共 ${rankedCandidates.length} 条，已按互动与知识度初排）】`,
          candidateLines.join('\n'),
          '',
          '请从中精选最符合「获取知识 + 数据优质 + 多角度延伸」的 3 个跃迁目标。',
        ].join('\n');

        const cJson = await generateStructuredJson({
          model,
          instructions: CURATE_TARGETS_INSTRUCTIONS,
          prompt,
          temperature: 0.25,
          timeoutMs: 45_000,
          signal,
        });
        if (Array.isArray(cJson?.targets) && cJson.targets.length > 0) {
          curated = cJson.targets;
        }
      } catch {
        // 兜底
      }
    }

    const candidateByKey = new Map(rankedCandidates.map((c) => [c.key, c]));
    const finalTargets = [];
    const usedKeys = new Set();

    for (const pick of curated || []) {
      const cand = candidateByKey.get(String(pick?.candidateKey || ''));
      if (!cand || usedKeys.has(cand.key)) continue;
      usedKeys.add(cand.key);
      finalTargets.push({
        targetId: `wt-${finalTargets.length + 1}`,
        key: cand.key,
        contentId: cand.contentId,
        contentType: cand.contentType,
        title: cand.title,
        briefSummary: String(pick.briefSummary || cand.excerpt || cand.title).trim().slice(0, 120),
        knowledgeGain: String(
          pick.knowledgeGain || `围绕「${originPlanet.knowledgePoint}」拓展相关原理与实践认知。`,
        ).trim().slice(0, 120),
        associationAngle: String(pick.associationAngle || '知识延伸').trim().slice(0, 16),
        url: cand.url,
        author: cand.author || '',
        authorBadge: cand.authorBadge || '',
        voteCount: cand.voteCount,
        commentCount: cand.commentCount,
        viewCount: cand.viewCount,
        rawExcerpt: cand.excerpt || '',
      });
      if (finalTargets.length === 3) break;
    }

    // 不足 3 条时按互动评分顺延补齐
    if (finalTargets.length < 3) {
      const fallbacks = buildFallbackTargets(
        rankedCandidates.filter((c) => !usedKeys.has(c.key)),
        originPlanet,
      );
      for (const fb of fallbacks) {
        const cand = candidateByKey.get(fb.candidateKey);
        if (!cand || usedKeys.has(cand.key)) continue;
        usedKeys.add(cand.key);
        finalTargets.push({
          targetId: `wt-${finalTargets.length + 1}`,
          key: cand.key,
          contentId: cand.contentId,
          contentType: cand.contentType,
          title: cand.title,
          briefSummary: fb.briefSummary,
          knowledgeGain: fb.knowledgeGain,
          associationAngle: fb.associationAngle,
          url: cand.url,
          author: cand.author || '',
          authorBadge: cand.authorBadge || '',
          voteCount: cand.voteCount,
          commentCount: cand.commentCount,
          viewCount: cand.viewCount,
          rawExcerpt: cand.excerpt || '',
        });
        if (finalTargets.length === 3) break;
      }
    }

    const session = {
      warpId: randomUUID(),
      createdAt: new Date().toISOString(),
      originPlanet,
      queries,
      provider: providerUsed || 'unknown',
      totalCandidates: rankedCandidates.length,
      targets: finalTargets,
    };
    rememberSession(session);
    return session;
  }

  function getTarget(warpId, targetKey) {
    const sess = sessions.get(warpId);
    if (!sess) return null;
    const target = sess.targets.find((t) => t.key === targetKey || t.targetId === targetKey);
    return target ? { session: sess, target } : null;
  }

  return {
    propose,
    getTarget,
  };
}
