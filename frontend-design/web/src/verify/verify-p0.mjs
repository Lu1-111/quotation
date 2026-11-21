/* P0 验收脚本：对真实 JS 代码跑验收 1/3/4，并打印 #rate、#t1–#t4 的口径值。
   运行：node quotation-p0/verify-p0.mjs
   注：导入的 ./starfield.js 是本地测试替身（源自运行中 demo 的原文摘录），
   在仓库里应指向真正的 src/starfield.js。 */

import {graph, versions, quote, SPINE} from './quotation-case.js';
import {
  brightness, brightnessMonotonic, radius, glowR, glowA,
  collapseAfter, conflictSet,
} from './starfield.js';

const pass = [];
const fail = [];
const check = (ok, name, detail) => (ok ? pass : fail).push(`${name} — ${detail}`);

/* ── 结构概览 ───────────────────────────────────────────── */
const withDeps = graph.filter(n => n.deps.length);
const twoDeps = withDeps.filter(n => n.deps.length === 2);
const depths = {};
for (const n of graph) depths[n.d] = (depths[n.d] || 0) + 1;
const clusters = {};
for (const n of graph) clusters[n.cluster] = (clusters[n.cluster] || 0) + 1;

console.log('=== P0 结构 ===');
console.log(`节点数 ${graph.length}`);
console.log(`有依赖 ${withDeps.length}，双依赖 ${twoDeps.length} → ${Math.round(100*twoDeps.length/withDeps.length)}%`);
console.log(`地基(d=0) ${graph.filter(n=>n.d===0).map(n=>n.id).join(', ')}`);
console.log(`最大深度 ${Math.max(...graph.map(n=>n.d))}`);
console.log(`深度分布 ${JSON.stringify(depths)}`);
console.log(`信念区分布 ${JSON.stringify(clusters)}`);
console.log(`主线 ${SPINE.join(', ')}`);

/* 拓扑序 + 引用完整性 */
const ids = new Set();
let topoOk = true, refOk = true;
const all = new Set(graph.map(n => n.id));
for (const n of graph) {
  for (const d of n.deps) {
    if (!all.has(d)) refOk = false;
    if (!ids.has(d)) topoOk = false;
  }
  ids.add(n.id);
}
check(refOk, '引用完整性', '所有 deps 指向存在的节点');
check(topoOk, '拓扑序', 'deps 只指向更早节点（computeGraph 的深度计算前提）');
check(SPINE.every(id => all.has(id)), '主线保留', `${SPINE.length} 条原有判断仍在图中`);

/* ── 验收 1：S 与视觉编码严格单调 ─────────────────────────── */
function spearman(a, b) {
  const rank = v => {
    const order = [...v.keys()].sort((i, j) => v[i] - v[j]);
    const r = new Array(v.length);
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && v[order[j + 1]] === v[order[i]]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[order[k]] = avg;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a), rb = rank(b), n = a.length;
  const ma = ra.reduce((s, v) => s + v, 0) / n, mb = rb.reduce((s, v) => s + v, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb);
    va += (ra[i] - ma) ** 2; vb += (rb[i] - mb) ** 2;
  }
  return cov / Math.sqrt(va * vb);
}
const S = graph.map(n => n.S);
const strictViolations = L => {
  const p = S.map((s, i) => [s, L[i]]).sort((x, y) => x[0] - y[0]);
  let bad = 0;
  for (let i = 0; i < p.length - 1; i++)
    if (p[i + 1][0] > p[i][0] && p[i + 1][1] <= p[i][1]) bad++;
  return bad;
};

console.log('\n=== 验收1：S ↔ 视觉编码 ===');
for (const [label, fn] of [['现状 brightness', brightness], ['修正 brightnessMonotonic', brightnessMonotonic]]) {
  const L = fn(graph);
  const bright = L.filter(v => v > 0.5).length;
  console.log(`${label}:`);
  console.log(`  Spearman  L=${spearman(S,L).toFixed(6)}  radius=${spearman(S,L.map(radius)).toFixed(6)}  glowR=${spearman(S,L.map(glowR)).toFixed(6)}  glowA=${spearman(S,L.map(glowA)).toFixed(6)}`);
  console.log(`  严格单调破坏对 ${strictViolations(L)}`);
  console.log(`  L>0.5 的星 ${bright}/${L.length} = ${(100*bright/L.length).toFixed(1)}%（源码约束 ≤8%）`);
  console.log(`  承重墙 ${graph.filter((_,i)=>L[i]>0.5).map(n=>n.name).join('、')}`);
}
const Lfix = brightnessMonotonic(graph);
check(strictViolations(Lfix) === 0, '验收1 严格单调', 'brightnessMonotonic 下 Spearman = 1.000000');
check(Lfix.filter(v=>v>0.5).length / Lfix.length <= 0.08, '分位约束', 'L>0.5 的星 ≤8%');

/* ── 验收 3：承重高但连带塌陷为 0 ───────────────────────── */
const rows = graph.map(n => ({
  id: n.id, name: n.name, S: n.S,
  collapse: collapseAfter(new Set([n.id]), graph).size - 1,
})).sort((a, b) => b.S - a.S);
const zero = rows.filter(r => r.S >= 3 && r.collapse === 0);

console.log('\n=== 验收3：承重 vs 连带塌陷（S 降序前 8）===');
console.log('id'.padEnd(14) + 'name'.padEnd(20) + '承重S'.padStart(6) + '连带塌'.padStart(8));
for (const r of rows.slice(0, 8))
  console.log(r.id.padEnd(14) + r.name.padEnd(20) + String(r.S).padStart(6) + String(r.collapse).padStart(8));
console.log(`满足「S≥3 且连带塌陷=0」的节点 ${zero.length} 个：${zero.slice(0,4).map(r=>`${r.name}(承重${r.S}·塌0)`).join('、')}`);
check(zero.length >= 2, '验收3 反直觉节点', `${zero.length} 个节点承重高却拆了不塌（要求 ≥2）`);

/* ── 验收 4：承重损失率区间 ─────────────────────────────── */
console.log('\n=== 验收4：三个版本的报价 ===');
let rateOk = true, noTotalCollapse = true;
for (const [key, v] of Object.entries(versions)) {
  const r = quote(v.conflicts);
  const dead = r.dead.size;
  console.log(`${key.padEnd(9)} conflicts=[${v.conflicts.join(', ')}]`.padEnd(46) +
    `rate=${String(r.rate).padStart(3)}%  塌 ${dead}/${graph.length}`);
  if (key !== 'scope') {
    if (!(r.rate >= 45 && r.rate <= 60)) rateOk = false;
    if (dead === graph.length) noTotalCollapse = false;
  }
}
const orig = quote(versions.original.conflicts);
check(rateOk, '验收4 损失率区间', `original/faithful 的 rate=${orig.rate}%，落在 45–60%`);
check(noTotalCollapse, '验收4 无全塌', `塌陷 ${orig.dead.size}/${graph.length}，未出现 100% 多米诺`);
check(quote(versions.scope.conflicts).rate === 0, 'scope 版本', '缩小主张范围后 rate=0%，不撞承重墙');

/* ── 口径：#rate / #t1–#t4 ──────────────────────────────── */
console.log('\n=== #rate / #t1–#t4（公式不变，数值随数据更新）===');
const conflicts = versions.original.conflicts;
console.log(`  #rate 承重损失率   = ${orig.rate}%`);
console.log(`  #t1 要拆掉的判断   = ${conflicts.length}`);
console.log(`  #t2 损失承重/总承重 = ${orig.lost} / ${orig.total}`);
console.log(`  #t3 连带塌陷       = ${orig.dead.size - conflicts.length}`);
console.log(`  #t4 若按个数算     = ${orig.dead.size} / ${graph.length}（${Math.round(100*orig.dead.size/graph.length)}%）`);

/* ── cluster 字段可用性 ─────────────────────────────────── */
const cs = conflictSet(graph);
console.log('\n=== conflictSet（验证 cluster 字段已补齐）===');
for (const id of cs) {
  const n = graph.find(x => x.id === id);
  console.log(`  cluster${n.cluster}: ${id}（${n.name}）S=${n.S}`);
}
check(cs.length === Object.keys(clusters).length,
  'cluster 字段', `conflictSet 在 ${cs.length} 个信念区各选出一个节点`);

/* ── 汇总 ───────────────────────────────────────────────── */
console.log(`\n=== 汇总：${pass.length} 项通过，${fail.length} 项未通过 ===`);
for (const p of pass) console.log(`  [通过] ${p}`);
for (const f of fail) console.log(`  [未过] ${f}`);
process.exit(fail.length ? 1 : 0);
