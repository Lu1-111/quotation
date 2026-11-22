// 星图：数据 → 视觉。所有数字按公式，不凭感觉调。

const GOLD = "#FFD27A";
const RED = "#D64A32";
const NS = "http://www.w3.org/2000/svg";

/* ---------- 确定性哈希（替代随机抖动） ---------- */
// 导出：structure-layout.js 的纵深抖动需要与本文件共用同一套随机源，
// 不要在别处复制第二份实现。
export function h32(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return ((x >>> 0) / 4294967296);
}

/* ---------- 图：S（承重数）与 d（最短依赖深度） ---------- */
export function computeGraph(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map(nodes.map((n) => [n.id, []]));
  for (const n of nodes) for (const dep of n.deps) kids.get(dep).push(n.id);

  // 最短依赖深度：节点按拓扑序（deps 只指向更早），一趟即可
  const depth = new Map();
  for (const n of nodes) depth.set(n.id, n.deps.length ? Infinity : 0);
  for (const n of nodes) {
    const d = depth.get(n.id);
    for (const c of kids.get(n.id)) if (d + 1 < depth.get(c)) depth.set(c, d + 1);
  }

  // 承重数：传递闭包下有多少节点依赖它
  const desc = new Map();
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    const s = new Set();
    for (const c of kids.get(n.id)) { s.add(c); for (const x of desc.get(c)) s.add(x); }
    desc.set(n.id, s);
  }

  return nodes.map((n) => ({
    ...n,
    S: desc.get(n.id).size,
    d: depth.get(n.id),
    depsOf: n.deps,
  }));
}

/* ---------- 亮度：星等公式 + 约束校准 ---------- */
export function brightness(g) {
  const raw = g.map((n) => {
    const m = 6.2 - 2.5 * Math.log10(1 + n.S);      // 承重越大，星等越小
    return Math.pow(10, -0.4 * (m - 1.2));          // 到达眼睛的亮度
  });
  const max = Math.max(...raw);
  const x = raw.map((v) => v / max);                // 归一到 0..1

  const sorted = [...x].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 1e-6;

  // 求 γ 使 P50 落在 0.18：0.04 + 0.96·med^γ = 0.18
  let gamma = Math.log(0.1458) / Math.log(med);
  if (!isFinite(gamma) || gamma <= 0) gamma = 1;

  const map = (v) => Math.min(1, Math.max(0.04, 0.04 + 0.96 * Math.pow(v, gamma)));
  let L = x.map(map);

  // 分位强制：L>0.5 的星不得超过 8%。用秩映射，而不是整体缩放（缩放不会减少个数）。
  const sortedL = [...L].sort((a, b) => a - b);
  const cut = Math.floor(0.92 * L.length);
  const q = sortedL[cut];
  const top = sortedL[sortedL.length - 1];
  if (q < 1 && top > 0.5) {
    L = L.map((v) =>
      v <= q ? Math.min(v, 0.499) : 0.5 + 0.5 * ((v - q) / (top - q || 1))
    );
  }
  return L;
}

/* ---------- 亮度（严格单调版本） ----------
   brightness() 的分位强制段里，下半段用 Math.min(v, 0.499) 做硬截断。
   截断会把超过阈值的节点并到同一个亮度值上：30 节点数据实测
   timbre(S=9) 与 example(S=10) 同时落在 L=0.499000，
   于是「承重越大越亮」在这两档之间失效，S ↔ L 的 Spearman 只有 0.999663。

   这里把下半段改为保序线性压缩到 [0.04, 0.499)，不并档。
   上半段与分位约束（L>0.5 的星不超过 8%）保持原样。
   实测：Spearman = 1.000000，L>0.5 仍为 2/30 = 6.7%，承重墙不变。

   需要「亮度严格等于承重」时用这个；保留 brightness() 以免影响现有调用。 */
export function brightnessMonotonic(g) {
  const raw = g.map((n) => {
    const m = 6.2 - 2.5 * Math.log10(1 + n.S);
    return Math.pow(10, -0.4 * (m - 1.2));
  });
  const max = Math.max(...raw);
  const x = raw.map((v) => v / max);

  const sorted = [...x].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 1e-6;

  let gamma = Math.log(0.1458) / Math.log(med);
  if (!isFinite(gamma) || gamma <= 0) gamma = 1;

  const map = (v) => Math.min(1, Math.max(0.04, 0.04 + 0.96 * Math.pow(v, gamma)));
  let L = x.map(map);

  const sortedL = [...L].sort((a, b) => a - b);
  const cut = Math.floor(0.92 * L.length);
  const q = sortedL[cut];
  const top = sortedL[sortedL.length - 1];
  if (q < 1 && top > 0.5) {
    const lo = Math.min(...L);
    const span = (q - lo) || 1;
    L = L.map((v) =>
      v <= q
        ? 0.04 + 0.459 * ((v - lo) / span)              // 保序压缩，不截断
        : 0.5 + 0.5 * ((v - q) / (top - q || 1))
    );
  }
  return L;
}

/* ---------- 尺寸 ---------- */
export const radius = (L) => 1.0 + 1.9 * Math.pow(L, 0.45);   // 核心半径，上限 2.9
export const glowR = (L) => 2.4 + 11 * Math.pow(L, 1.7);
export const glowA = (L) => 0.035 + 0.26 * Math.pow(L, 1.5);

/* ---------- 布点：螺旋星系，一次算定 ---------- */
export function layout(g, W, H, walls) {
  const wallSet = new Set(walls);
  const cx = W / 2, cy = H / 2;
  const R = H * 0.46;
  const stretch = (W / H) * 0.88;   // 横向拉开，不留一个圆盘

  const bulge = g.filter((n) => wallSet.has(n.id) || n.d === 0);
  const arms = g.filter((n) => !(wallSet.has(n.id) || n.d === 0));

  const pos = new Map();
  // 核球：0–10%
  bulge.forEach((n, i) => {
    const t = (i + 1) / (bulge.length + 1);
    const a = i * 2.39996 + h32(n.id) * 0.8;
    const r = R * 0.10 * Math.sqrt(t);
    pos.set(n.id, { x: cx + Math.cos(a) * r * 1.9, y: cy + Math.sin(a) * r * 0.9 });
  });
  // 旋臂：两臂，半径向外张开
  arms.forEach((n, i) => {
    const j = i + 1;
    const t = j / (arms.length + 1);
    const arm = j % 2;
    const theta = arm * Math.PI + t * 4.1 + (h32(n.id) - 0.5) * 0.42;
    const r = R * (0.14 + 0.86 * Math.pow(t, 0.82)) * (0.92 + h32(n.id + "r") * 0.16);
    pos.set(n.id, { x: cx + Math.cos(theta) * r * stretch, y: cy + Math.sin(theta) * r * 0.9 });
  });

  // 碰撞：12 轮后停止，绝不继续抖
  const ids = [...pos.keys()];
  for (let round = 0; round < 12; round++) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i]), b = pos.get(ids[j]);
        let dx = b.x - a.x, dy = b.y - a.y;
        let dist = Math.hypot(dx, dy) || 0.01;
        const min = 7;
        if (dist < min) {
          const push = (min - dist) / 2;
          dx /= dist; dy /= dist;
          a.x -= dx * push; a.y -= dy * push;
          b.x += dx * push; b.y += dy * push;
        }
      }
    }
  }
  return pos;
}

/* ---------- 渲染 ---------- */
let renderSeq = 0;

export function render(svg, graph, W, H, opt = {}) {
  const uid = `f${++renderSeq}`;
  const walls = opt.walls || [];
  const dim = opt.dim == null ? 1 : opt.dim;
  const L = brightness(graph);
  const pos = layout(graph, W, H, walls);
  const wallSet = new Set(walls);

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = "";

  const defs = document.createElementNS(NS, "defs");
  defs.innerHTML = `
    <filter id="glow-${uid}" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="2.2"/>
    </filter>
    <filter id="grain-${uid}">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
    </filter>`;
  svg.appendChild(defs);

  // 依赖连线
  const edges = document.createElementNS(NS, "g");
  for (const n of graph) {
    const a = pos.get(n.id);
    for (const d of n.deps) {
      const b = pos.get(d);
      if (!a || !b) continue;
      const ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", a.x); ln.setAttribute("y1", a.y);
      ln.setAttribute("x2", b.x); ln.setAttribute("y2", b.y);
      ln.setAttribute("class", "edge");
      edges.appendChild(ln);
    }
  }
  svg.appendChild(edges);

  // 辉光：整组模糊一次
  const glow = document.createElementNS(NS, "g");
  glow.setAttribute("filter", `url(#glow-${uid})`);
  graph.forEach((n, i) => {
    const p = pos.get(n.id);
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", p.x); c.setAttribute("cy", p.y);
    c.setAttribute("r", glowR(L[i]).toFixed(2));
    c.setAttribute("fill", GOLD);
    c.setAttribute("opacity", (glowA(L[i]) * (wallSet.has(n.id) ? 1 : dim)).toFixed(3));
    c.dataset.id = n.id;
    glow.appendChild(c);
  });
  svg.appendChild(glow);

  // 星核 + 承重墙环 + 命中区
  const cores = document.createElementNS(NS, "g");
  const nodeEls = new Map();
  graph.forEach((n, i) => {
    const p = pos.get(n.id);
    const gEl = document.createElementNS(NS, "g");
    gEl.setAttribute("class", "node");
    gEl.dataset.id = n.id;

    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", p.x); c.setAttribute("cy", p.y);
    c.setAttribute("r", radius(L[i]).toFixed(2));
    c.setAttribute("class", "core");
    c.setAttribute("opacity", ((0.35 + 0.65 * L[i]) * (wallSet.has(n.id) ? 1 : dim)).toFixed(3));
    gEl.appendChild(c);

    if (wallSet.has(n.id)) {
      const r = document.createElementNS(NS, "circle");
      r.setAttribute("cx", p.x); r.setAttribute("cy", p.y);
      r.setAttribute("r", (radius(L[i]) + 3.4).toFixed(2));
      r.setAttribute("class", "ring");
      gEl.appendChild(r);
    }

    const hit = document.createElementNS(NS, "circle");
    hit.setAttribute("cx", p.x); hit.setAttribute("cy", p.y);
    hit.setAttribute("r", Math.max(8, radius(L[i]) + 6).toFixed(2));
    hit.setAttribute("class", "hit");
    hit.dataset.id = n.id;
    gEl.appendChild(hit);

    cores.appendChild(gEl);
    nodeEls.set(n.id, gEl);
  });
  svg.appendChild(cores);

  // 3% 极细噪点，防 OLED 大面积纯黑发死
  if (opt.noise !== false) {
    const noise = document.createElementNS(NS, "rect");
    noise.setAttribute("width", W); noise.setAttribute("height", H);
    noise.setAttribute("filter", `url(#grain-${uid})`);
    noise.setAttribute("opacity", "0.03");
    noise.setAttribute("pointer-events", "none");
    svg.appendChild(noise);
  }

  return { pos, L, nodeEls, walls: wallSet, W, H };
}

/* ---------- 报价：最小拆除集 → 熄灭 ---------- */
// 塔陷规则：一个判断失去过半根据就站不住（不是全失去才塔）。
// 现实里人不是与门：三根支柱倒了一根，他还会撑着；倒了两根，这句话就废了。
export function collapseAfter(removed, graph) {
  const dead = new Set(removed);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of graph) {
      if (dead.has(n.id) || !n.deps.length) continue;
      const alive = n.deps.filter((d) => !dead.has(d)).length;
      if (alive / n.deps.length < 0.5) { dead.add(n.id); changed = true; }
    }
  }
  return dead;
}

export function conflictSet(graph) {
  // 为让一句新话成立，每个信念区各拆掉最“伤筋”的那一个。
  const clusters = [...new Set(graph.map((n) => n.cluster))].sort((a, b) => a - b);
  const picks = [];
  for (const c of clusters) {
    const inC = graph.filter((n) => n.cluster === c && n.deps.length);
    let best = null, bestGain = -1;
    for (const n of inC) {
      const gain = collapseAfter(new Set([n.id]), graph).size;
      if (gain > bestGain) { bestGain = gain; best = n; }
    }
    if (best) picks.push(best.id);
  }
  return picks;
}

export function price(graph) {
  const removed = new Set(conflictSet(graph));
  const dead = collapseAfter(removed, graph);
  const totalS = graph.reduce((a, n) => a + n.S, 0);
  const deadS = graph.filter((n) => dead.has(n.id)).reduce((a, n) => a + n.S, 0);
  return {
    picks: [...removed],
    dead,
    collapsed: dead.size - removed.size,
    total: graph.length,
    rate: totalS ? deadS / totalS : 0,   // 承重损失率：按重量算
    raw: dead.size / graph.length,       // 换算：按个数算
  };
}
