/* P1 结构预览生成器（开发辅助，不进仓库）
   用 P1 的真实布局 + starfield 的真实公式画一张静态结构图，用于肉眼核对。
   运行：node quotation-p0/preview-structure.mjs
   输出：structure-preview.svg

   配色与边状态严格对应塌陷规则的三种情形，不要合并上色：
     存活        金实线
     支柱已断但本节点未塌（过半规则的关键情形）  橙实线
     本节点已塌  红虚线 */

import {writeFileSync} from 'node:fs';
import {graph, versions} from './quotation-case.js';
import {layoutStructure, edgeRoutes, structureLevelsAll} from './structure-layout.js';
import {brightnessMonotonic, radius, glowR, glowA, collapseAfter} from './starfield.js';

const W = 1280, H = 860, PAD_X = 140, PAD_R = 104, PAD_T = 118, PAD_B = 104;
const GOLD = '#FFD27A', RED = '#D64A32', HELD = '#A8ADB5';

const coords = layoutStructure(graph);
const routes = edgeRoutes(graph);
const levels = structureLevelsAll(graph);
const L = brightnessMonotonic(graph);
const idx = new Map(graph.map((n, i) => [n.id, i]));

const conflicts = versions.original.conflicts;
const dead = collapseAfter(new Set(conflicts), graph);
const totalS = graph.reduce((a, n) => a + n.S, 0);
const lostS = graph.filter(n => dead.has(n.id)).reduce((a, n) => a + n.S, 0);
const rate = Math.round(100 * lostS / totalS);

/* 视口按布局的实际包围盒自适应，而不是固定映射 ±1.05。
   布局输出是归一化坐标，实测只占用画幅 57.5%（x ∈ -0.592 … 0.616）；
   若按 ±1.05 硬映射，两侧会各空出一大块黑边，看起来像"楼缩在中间"。
   这是渲染端的取景问题，不要为此去改布局坐标。 */
const allX = [...coords.values()].map(v => v[0]);
const X_LO = Math.min(...allX), X_HI = Math.max(...allX);
const X_RANGE = (X_HI - X_LO) || 1;
const PX = x => PAD_X + (x - X_LO) / X_RANGE * (W - PAD_X - PAD_R);
const PY = y => H - PAD_B - (y + 0.95) / 1.9 * (H - PAD_T - PAD_B);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
const out = [];
out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
out.push(`<rect width="${W}" height="${H}" fill="#07080f"/>`);
out.push(`<defs><marker id="ar" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
<path d="M0 1 L6 4 L0 7 z" fill="${GOLD}" opacity="0.5"/></marker></defs>`);

/* 楼层标尺：只在左侧留短刻度，不画贯穿全幅的横线。
   贯穿线会把画面压成坐标纸，读起来像横格纸而不是结构图。
   地基线是唯一例外：L0 画满宽，给"楼"一个地面。 */
levels.forEach((ids, d) => {
  const y = PY(coords.get(ids[0])[1]);
  if (d === 0) {
    out.push(`<line x1="${PAD_X-34}" y1="${y.toFixed(1)}" x2="${W-PAD_X+24}" y2="${y.toFixed(1)}" stroke="#3a4150" stroke-width="1" opacity="0.8"/>`);
  } else {
    out.push(`<line x1="${PAD_X-34}" y1="${y.toFixed(1)}" x2="${PAD_X-12}" y2="${y.toFixed(1)}" stroke="#2b2f3a" stroke-width="0.8" opacity="0.7"/>`);
  }
  out.push(`<text x="${PAD_X-44}" y="${(y+4).toFixed(1)}" fill="#6a7079" font-size="11" text-anchor="end" font-family="Noto Serif SC,serif">${d === 0 ? 'L0 地基' : 'L' + d}</text>`);
});
out.push(`<text x="${PAD_X-44}" y="${(PY(-0.95)+26).toFixed(1)}" fill="#6a7079" font-size="10.5" text-anchor="end" font-family="Noto Serif SC,serif">↑ 依赖向上</text>`);

/* 边：按三种状态分色，长边沿虚拟支点走折线 */
for (const n of graph) {
  for (const dep of n.deps) {
    const chain = routes.get(`${dep}>${n.id}`) || [];
    const pts = [dep, ...chain, n.id].map(id => coords.get(id));
    const pathStr = pts.map(p => `${PX(p[0]).toFixed(1)},${PY(p[1]).toFixed(1)}`).join(' ');
    let stroke = GOLD, op = 0.34, dash = '', mark = ' marker-end="url(#ar)"';
    if (dead.has(n.id)) { stroke = RED; op = 0.5; dash = ' stroke-dasharray="4 3"'; mark = ''; }
    else if (dead.has(dep)) { stroke = HELD; op = 0.75; dash = ' stroke-dasharray="1.5 3"'; mark = ''; }
    out.push(`<polyline points="${pathStr}" fill="none" stroke="${stroke}" stroke-width="1.2" opacity="${op}"${dash}${mark}/>`);
  }
}

/* 节点：半径与辉光来自 starfield 公式，梯度另乘一个放大系数便于肉眼分辨 */
const rPix = i => 2.6 * Math.pow(radius(L[i]), 2.1);
for (const n of graph) {
  const i = idx.get(n.id), p = coords.get(n.id), r = rPix(i);
  const x = PX(p[0]), y = PY(p[1]);
  const die = dead.has(n.id), isCut = conflicts.includes(n.id);
  out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(glowR(L[i])*1.5).toFixed(1)}" fill="${die?RED:GOLD}" opacity="${(glowA(L[i])*(die?0.5:1)).toFixed(3)}"/>`);
  out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${die?'#24100d':'#fff6e2'}" stroke="${die?RED:'none'}" stroke-width="1.5"/>`);
  if (isCut) {
    out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(r+7).toFixed(1)}" fill="none" stroke="${RED}" stroke-width="2"/>`);
    const d = r * 0.52;
    out.push(`<path d="M${(x-d).toFixed(1)} ${(y-d).toFixed(1)} L${(x+d).toFixed(1)} ${(y+d).toFixed(1)} M${(x+d).toFixed(1)} ${(y-d).toFixed(1)} L${(x-d).toFixed(1)} ${(y+d).toFixed(1)}" stroke="${RED}" stroke-width="1.8"/>`);
  }
  out.push(`<text x="${x.toFixed(1)}" y="${(y+r+14).toFixed(1)}" fill="${die?'#c08276':'#8a8f98'}" font-size="11.5" text-anchor="middle" font-family="Noto Serif SC,serif">${esc(n.name)}</text>`);
  if (L[i] > 0.5) out.push(`<text x="${x.toFixed(1)}" y="${(y+r+27).toFixed(1)}" fill="${GOLD}" font-size="10" text-anchor="middle" font-family="Noto Serif SC,serif">承重 ${n.S}</text>`);
}

/* 标题与图例：两个口径分开写，避免 54% 与 12/30 被读成同一个数 */
out.push(`<text x="${PAD_X-44}" y="36" fill="${GOLD}" font-size="18" font-family="Noto Serif SC,serif">承重结构 · 拆掉「${esc(graph.find(n=>n.id===conflicts[0]).name)}」「${esc(graph.find(n=>n.id===conflicts[1]).name)}」两条地基</text>`);
out.push(`<text x="${PAD_X-44}" y="58" fill="#8a8f98" font-size="12" font-family="Noto Serif SC,serif">承重损失率 ${rate}%（${lostS}/${totalS} 承重） · 按个数算 ${dead.size}/${graph.length}（${Math.round(100*dead.size/graph.length)}%） · 两个口径不同</text>`);
const lx = W - 300, ly = 36;
const legend = [
  [`圆面积 = 承重`, '#8a8f98'],
  [`金实线 → 支撑关系（箭头指向被支撑方）`, GOLD],
  [`灰点线 = 支柱断了但本条未塌（过半规则）`, HELD],
  [`深红填充 + 红环 = 连带塌陷（红色专指塌陷）`, RED],
  [`红叉双圈 = 被直接拆掉的地基`, RED],
];
legend.forEach(([t, c], i) => out.push(`<text x="${lx}" y="${ly + i*16}" fill="${c}" font-size="10.5" font-family="Noto Serif SC,serif">${esc(t)}</text>`));

out.push('</svg>');
writeFileSync(new URL('./structure-preview.svg', import.meta.url), out.join('\n'));
console.log(`structure-preview.svg 已生成  rate=${rate}%  塌陷=${dead.size}/${graph.length}  半径梯度=${(rPix(idx.get(graph.reduce((a,b)=>a.S>b.S?a:b).id))/rPix(idx.get(graph.reduce((a,b)=>a.S<b.S?a:b).id))).toFixed(2)}:1`);
