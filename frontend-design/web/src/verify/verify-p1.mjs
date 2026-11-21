/* P1 验收脚本：结构布局
   运行：node quotation-p0/verify-p1.mjs
   检查：确定性、分层方向、坐标范围、连线交叉数、层内分布 */

import {graph} from './quotation-case.js';
import {layoutStructure, structureLevels, structureLevelsAll, edgeRoutes, isVirtual} from './structure-layout.js';

const pass = [], fail = [];
const check = (ok, name, detail) => (ok ? pass : fail).push(`${name} — ${detail}`);

const coords = layoutStructure(graph);
const levels = structureLevels(graph);
const byId = new Map(graph.map(n => [n.id, n]));

/* ── 层次结构 ───────────────────────────────────────────── */
console.log('=== P1 分层结果（自下而上，最长路径分层）===');
levels.forEach((ids, d) => {
  const y = coords.get(ids[0])[1];
  console.log(`  L${d} (y=${y.toFixed(3)}, ${String(ids.length).padStart(2)}个)  ${ids.map(i=>byId.get(i).name).join(' · ')}`);
});

const realCoords = new Map([...coords].filter(([id]) => !isVirtual(id)));
const virtualCount = coords.size - realCoords.size;
check(realCoords.size === graph.length, '覆盖完整',
  `${realCoords.size}/${graph.length} 个真实节点都有坐标，另有 ${virtualCount} 个长边支点`);

/* ── 确定性：跑两次必须完全一致 ─────────────────────────── */
const again = layoutStructure(graph);
let identical = true;
for (const [id, c] of coords) {
  const c2 = again.get(id);
  if (!c2 || c2[0] !== c[0] || c2[1] !== c[1] || c2[2] !== c[2]) identical = false;
}
// 打乱输入顺序后也应得到同样坐标（层内初始排序已确定化）
const shuffled = [...graph].sort((a, b) => (a.id > b.id ? -1 : 1));
const fromShuffled = layoutStructure(shuffled);
let orderStable = true;
for (const [id, c] of coords) {
  const c2 = fromShuffled.get(id);
  if (!c2 || Math.abs(c2[0]-c[0]) > 1e-12 || Math.abs(c2[1]-c[1]) > 1e-12 || Math.abs(c2[2]-c[2]) > 1e-12) orderStable = false;
}
check(identical, '确定性', '同一输入连续两次调用坐标完全一致');
check(orderStable, '输入顺序无关', '打乱输入数组顺序后坐标不变');

/* ── 分层方向：被依赖的必须更低 ─────────────────────────── */
let dirOk = true, violations = [];
for (const n of graph) {
  const y = coords.get(n.id)[1];
  for (const dep of n.deps) {
    const yd = coords.get(dep)[1];
    if (!(yd < y)) { dirOk = false; violations.push(`${dep}(y=${yd.toFixed(2)}) 未低于 ${n.id}(y=${y.toFixed(2)})`); }
  }
}
check(dirOk, '承重方向', dirOk ? '每条 deps 的被依赖方都更低（地基在下）' : violations.slice(0,3).join('; '));

const ys = [...coords.values()].map(c => c[1]);
const xs = [...coords.values()].map(c => c[0]);
const zs = [...coords.values()].map(c => c[2]);
console.log('\n=== 坐标范围 ===');
console.log(`  x ${Math.min(...xs).toFixed(3)} – ${Math.max(...xs).toFixed(3)}`);
console.log(`  y ${Math.min(...ys).toFixed(3)} – ${Math.max(...ys).toFixed(3)}`);
console.log(`  z ${Math.min(...zs).toFixed(4)} – ${Math.max(...zs).toFixed(4)}`);
check(Math.min(...xs) >= -1.05 && Math.max(...xs) <= 1.05, 'x 范围', '落在 ±1.05 内');
check(Math.abs(Math.min(...ys) - (-0.95)) < 1e-9 && Math.abs(Math.max(...ys) - 0.95) < 1e-9,
  'y 范围', '地基 -0.95，顶层 0.95，与轨道量级相当');
check(zs.every(z => Math.abs(z) <= 0.04), 'z 抖动', '纵深在 ±0.04 内');
check(new Set(zs).size > 1 && zs.every(z => z !== 0), 'z 非零', '纵深有确定性微抖动，不是全 0 平面');

/* ── 连线交叉数：barycenter 的实际效果 ─────────────────── */
function crossings(levelOrder) {
  const pos = new Map();
  levelOrder.forEach(ids => ids.forEach((id, i) => pos.set(id, i)));
  // 收集相邻层之间的边，按 (下层位置, 上层位置) 统计逆序对
  let total = 0;
  for (let d = 1; d < levelOrder.length; d++) {
    const edges = [];
    for (const id of levelOrder[d])
      for (const dep of byId.get(id).deps)
        if (levelOrder[d-1].includes(dep)) edges.push([pos.get(dep), pos.get(id)]);
    for (let i = 0; i < edges.length; i++)
      for (let j = i + 1; j < edges.length; j++) {
        const [a1,b1] = edges[i], [a2,b2] = edges[j];
        if ((a1 - a2) * (b1 - b2) < 0) total++;
      }
  }
  return total;
}
// 基线：按 id 字典序的朴素分层（不做 barycenter），与被测模块同用最长路径分层
const naive = (() => {
  const byId = new Map(graph.map(n => [n.id, n]));
  const depth = new Map(graph.map(n => [n.id, 0]));
  for (let r = 0; r < graph.length; r++) {
    let changed = false;
    for (const n of graph) {
      let v = 0;
      for (const dep of n.deps) if (byId.has(dep)) v = Math.max(v, depth.get(dep) + 1);
      if (v !== depth.get(n.id)) { depth.set(n.id, v); changed = true; }
    }
    if (!changed) break;
  }
  const dmax = Math.max(...[...depth.values()]);
  const lv = Array.from({length: dmax+1}, () => []);
  for (const n of graph) lv[depth.get(n.id)].push(n.id);
  for (const l of lv) l.sort();
  return lv;
})();
const cNaive = crossings(naive), cOpt = crossings(levels);
console.log('\n=== 相邻层连线交叉数 ===');
console.log(`  朴素字典序   ${cNaive}`);
console.log(`  barycenter   ${cOpt}`);
check(cOpt <= cNaive, '交叉优化', `barycenter 后交叉 ${cOpt}，不劣于朴素排序的 ${cNaive}`);

/* ── 层内分布：不应出现同层重叠 ─────────────────────────── */
/* 层内间距：真实节点必须满足 MIN_GAP；虚拟支点只是走线用的中继，允许靠近 */
let minGap = Infinity, minGapAll = Infinity;
for (const ids of levels) {
  const sorted = ids.map(i => coords.get(i)[0]).sort((a,b)=>a-b);
  for (let i = 0; i < sorted.length - 1; i++) minGap = Math.min(minGap, sorted[i+1] - sorted[i]);
}
for (const ids of structureLevelsAll(graph)) {
  const sorted = ids.map(i => coords.get(i)[0]).sort((a,b)=>a-b);
  for (let i = 0; i < sorted.length - 1; i++) minGapAll = Math.min(minGapAll, sorted[i+1] - sorted[i]);
}
console.log(`\n  同层真实节点最小横向间距 ${minGap === Infinity ? 'n/a' : minGap.toFixed(4)}`);
console.log(`  含虚拟支点最小间距 ${minGapAll === Infinity ? 'n/a' : minGapAll.toFixed(4)}（支点是走线中继，允许靠近）`);
check(minGap === Infinity || minGap >= 0.169, '层内无重叠', `真实节点最小间距 ${minGap === Infinity ? 'n/a' : minGap.toFixed(4)}`);

/* 立柱不歪：各层中心不应单向漂移，否则整栋楼读成斜塔 */
const centers = structureLevelsAll(graph).map(ids => {
  const xs = ids.map(i => coords.get(i)[0]);
  return (Math.min(...xs) + Math.max(...xs)) / 2;
});
const tilt = Math.max(...centers) - Math.min(...centers);
const globalMid = (Math.min(...xs) + Math.max(...xs)) / 2;
console.log(`  各层中心 ${centers.map(v=>v.toFixed(2)).join(' ')}`);
console.log(`  倾斜度（层中心极差）${tilt.toFixed(3)}   全图中心偏移 ${globalMid.toFixed(4)}`);
check(tilt <= 0.25, '立柱不歪', `层中心极差 ${tilt.toFixed(3)}（阈值 0.25）`);
check(Math.abs(globalMid) < 0.02, '整体居中', `全图中心偏移 ${globalMid.toFixed(4)}`);

/* ── 连通性与长边：影响"是否读成一栋楼" ─────────────────── */
const adj = new Map(graph.map(n => [n.id, []]));
for (const n of graph) for (const d of n.deps) { adj.get(n.id).push(d); adj.get(d).push(n.id); }
const seen = new Set(); const comps = [];
for (const n of graph) {
  if (seen.has(n.id)) continue;
  const q = [n.id], c = []; seen.add(n.id);
  while (q.length) { const x = q.pop(); c.push(x); for (const y of adj.get(x)) if (!seen.has(y)) { seen.add(y); q.push(y); } }
  comps.push(c);
}
const layer = new Map();
structureLevelsAll(graph).forEach((ids, i) => ids.forEach(id => layer.set(id, i)));
const routes = edgeRoutes(graph);
const spans = [];
for (const n of graph) for (const d of n.deps) spans.push({from: d, to: n.id, span: layer.get(n.id) - layer.get(d)});
const spanDist = {};
for (const s of spans) spanDist[s.span] = (spanDist[s.span] || 0) + 1;
// 拆分后真正"悬空"的长边：跨层>1 且没有虚拟节点铺路
const unrouted = spans.filter(s => s.span > 1 && !(routes.get(`${s.from}>${s.to}`) || []).length);

console.log('\n=== 连通性与边跨层 ===');
console.log(`  连通分量 ${comps.length} 个，规模 ${comps.map(c=>c.length).join(', ')}`);
console.log(`  边跨层分布 ${JSON.stringify(spanDist)}（共 ${spans.length} 条边）`);
console.log(`  长边拆分: ${routes.size} 条，插入虚拟节点 ${[...routes.values()].reduce((a,c)=>a+c.length,0)} 个`);
for (const [key, chain] of routes)
  console.log(`    ${key.split('>').map(i=>byId.get(i)?.name ?? i).join(' → ')}  经 ${chain.length} 个支点`);
check(comps.length === 1, '全图连通', `${comps.length} 个连通分量，没有孤岛簇`);
check(unrouted.length === 0, '长边已铺路',
  unrouted.length ? unrouted.map(s=>`${s.from}→${s.to}(span=${s.span})`).join(', ')
                  : '所有跨层>1 的边都有虚拟节点沿途支点，不存在穿楼斜拉线');

/* 边段陡峭度：所有边（含普通单层边）的逐段水平位移都不应远大于层间垂直距离，
   否则画面上就是横穿全图的近水平线 */
const yStep = 1.9 / (structureLevelsAll(graph).length - 1);
const segs = [];
for (const n of graph) for (const dep of n.deps) {
  const chain = routes.get(`${dep}>${n.id}`) || [];
  const pts = [dep, ...chain, n.id].map(id => coords.get(id));
  for (let i = 0; i < pts.length - 1; i++)
    segs.push({dx: Math.abs(pts[i+1][0] - pts[i][0]), label: `${byId.get(dep).name}→${byId.get(n.id).name}`});
}
segs.sort((a, b) => b.dx - a.dx);
const worstRatio = segs[0].dx / yStep;
const meanRatio = segs.reduce((a, s) => a + s.dx, 0) / segs.length / yStep;
const steep = segs.filter(s => s.dx > yStep * 1.5);
console.log(`\n=== 边段陡峭度（层间垂直距离 ${yStep.toFixed(3)}）===`);
console.log(`  共 ${segs.length} 段，平均 |dx| = ${(meanRatio*yStep).toFixed(3)}（${meanRatio.toFixed(2)}×）`);
console.log(`  最陡 5 段：`);
for (const s of segs.slice(0, 5)) console.log(`    |dx|=${s.dx.toFixed(3)} (${(s.dx/yStep).toFixed(2)}×)  ${s.label}`);
check(steep.length === 0, '无近水平边',
  steep.length ? `${steep.length} 段超过 1.5× 层间距，最陡 ${worstRatio.toFixed(2)}×（${segs[0].label}）`
               : `所有 ${segs.length} 段的水平位移都 ≤1.5× 层间距，最陡 ${worstRatio.toFixed(2)}×`);

/* ── 汇总 ───────────────────────────────────────────────── */
console.log(`\n=== 汇总：${pass.length} 项通过，${fail.length} 项未通过 ===`);
for (const p of pass) console.log(`  [通过] ${p}`);
for (const f of fail) console.log(`  [未过] ${f}`);
process.exit(fail.length ? 1 : 0);
