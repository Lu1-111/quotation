/* P1 · 结构布局：把判断图排成一栋楼
   被依赖的在下（地基），依赖它的在上。给 P2 的形变提供目标坐标。

   坐标系与 orbit-system.js / stellar-disc.js 的 project() 对齐：
   - project() 中 +coord[1] 对应屏幕上方，所以 y 越大越高
   - 地基排在最下（y = -0.95），顶层排在最上（y = 0.95）
   - 量级与轨道半长轴 a≈0.72–0.77 相当，整体落在 ±1.05 内

   分层用最长路径深度，不是 computeGraph() 的最短深度 d（原因见 longestDepth 注释）。

   确定性：同一份输入必定产出同一份输出。不使用 Math.random。
   纵深抖动用 h32() 哈希，与 starfield.js 的布点保持同一套随机源。

   ⚠ 依赖项：需要 starfield.js 导出 h32()。
   该函数目前是 starfield.js 的模块内私有函数（文件顶部「确定性哈希」一节），
   移植时在其定义前加 export 即可，不要在这里复制第二份实现。
*/

import {h32} from './starfield.js';

const Y_BOTTOM = -0.95;   // 地基高度
const Y_SPAN = 1.9;       // 顶层与地基的落差
const X_SPAN = 1.05;      // 横向半宽
const Z_JITTER = 0.04;    // 纵深微抖动幅度
const SWEEPS = 2;         // barycenter 上下各扫几轮

/* 分层：用最长路径深度，而不是 computeGraph() 的最短深度 d。

   为什么不直接用 d：d 是最短依赖深度（min(dep)+1）。双依赖节点会和自己
   某个更深的依赖落在同一层，那条边在画面上变成水平线，「地基在下」就读不出来。
   本数据实测有 3 条这样的边：
     digdeep(d=2) -> widen(d=2)、counting(d=3) -> method(d=3)、choose(d=4) -> loop(d=4)
   改用最长路径后同层边为 0，每条 deps 都严格跨层。

   d 仍然保留给亮度/承重之外的用途，这里只做布局分层。 */
function longestDepth(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const depth = new Map(nodes.map(n => [n.id, 0]));
  // 迭代松弛：不假设输入已是拓扑序。DAG 下最多 nodes.length 轮收敛。
  // computeGraph 的输出本身有序，但本函数不依赖调用方维持这一点。
  for (let round = 0; round < nodes.length; round++) {
    let changed = false;
    for (const n of nodes) {
      let v = 0;
      for (const dep of n.deps) {
        if (!byId.has(dep)) continue;
        v = Math.max(v, depth.get(dep) + 1);
      }
      if (v !== depth.get(n.id)) { depth.set(n.id, v); changed = true; }
    }
    if (!changed) break;
  }
  return depth;
}

/* 分层统一走 solve()，不另留一套 groupByDepth，避免两处逻辑漂移 */

/* 层内位置索引：用于 barycenter 计算 */
function indexOf(levels) {
  const pos = new Map();
  for (const level of levels)
    level.forEach((n, i) => pos.set(n.id, i));
  return pos;
}

/* barycenter 启发式：把每个节点挪到它邻居的平均位置附近，减少连线交叉。
   向上扫时参考 deps（下层），向下扫时参考子节点（上层）。 */
function barycenterSweep(levels, kids) {
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    // 自下而上：按 deps 的平均位置重排
    for (let d = 1; d < levels.length; d++) {
      const pos = indexOf(levels);
      reorder(levels[d], n => n.deps.map(id => pos.get(id)));
    }
    // 自上而下：按子节点的平均位置重排
    for (let d = levels.length - 2; d >= 0; d--) {
      const pos = indexOf(levels);
      reorder(levels[d], n => (kids.get(n.id) || []).map(id => pos.get(id)));
    }
  }
}

/* 用邻居平均位置排序。无邻居或邻居不在已排层时保持原位（用当前下标兜底）。 */
function reorder(level, neighbours) {
  const key = new Map();
  level.forEach((n, i) => {
    const refs = neighbours(n).filter(v => v !== undefined && Number.isFinite(v));
    key.set(n.id, refs.length ? refs.reduce((s, v) => s + v, 0) / refs.length : i);
  });
  // 稳定排序：平均位置相同时按 id 比较，保证确定性
  level.sort((a, b) => {
    const ka = key.get(a.id), kb = key.get(b.id);
    if (ka !== kb) return ka - kb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/* 长边拆分：跨多层的边插入虚拟节点（Sugiyama 的标准做法）。

   为什么需要：本数据有一条 口味可拓展(L1) → 和我的经历对不上(L8) 的边跨 7 层。
   不拆的话它是一条穿过整栋楼的斜拉线，既压过其他层，也让 barycenter
   无法把它的中段纳入排序，画面上先被看到的就是这条歪线。
   拆开后它沿途每层都有支点，P3 画边时顺着这些点连成折线即可。

   虚拟节点 id 形如 `~from>to#k`，不参与承重与拾取，只用于布局与走线。 */
const VIRTUAL_PREFIX = '~';
export const isVirtual = id => id.startsWith(VIRTUAL_PREFIX);

function splitLongEdges(nodes, depth) {
  const real = nodes.map(n => ({id: n.id, deps: [], _real: true}));
  const byId = new Map(real.map(n => [n.id, n]));
  const virtuals = [];
  const routes = new Map();   // "from>to" -> 沿途虚拟节点 id（自下而上）

  for (const n of nodes) {
    for (const dep of n.deps) {
      if (!byId.has(dep)) continue;
      const span = depth.get(n.id) - depth.get(dep);
      if (span <= 1) { byId.get(n.id).deps.push(dep); continue; }
      // 在 dep 与 n 之间逐层插入虚拟节点
      const chain = [];
      let prev = dep;
      for (let k = 1; k < span; k++) {
        const vid = `${VIRTUAL_PREFIX}${dep}>${n.id}#${k}`;
        const v = {id: vid, deps: [prev], _real: false, _layer: depth.get(dep) + k};
        virtuals.push(v); byId.set(vid, v);
        chain.push(vid); prev = vid;
      }
      byId.get(n.id).deps.push(prev);
      routes.set(`${dep}>${n.id}`, chain);
    }
  }
  return {items: [...real, ...virtuals], byId, routes};
}
/**
 * 把判断图排成分层结构，返回每个节点的三维目标坐标。
 * 返回的 Map 含真实节点，也含长边沿途的虚拟节点（id 以 ~ 开头，用 isVirtual 判断）。
 * P2 做形变时只需取真实节点；P3 画边时用 edgeRoutes() 取折线路径。
 * @param {Array} nodes computeGraph() 的输出，需含 id / deps
 * @returns {Map<string, [number, number, number]>}
 */
export function layoutStructure(nodes) {
  if (!nodes.length) return new Map();
  const {levels, routes} = solve(nodes);

  const dmax = levels.length - 1;
  const coords = new Map();
  levels.forEach((level, d) => {
    const y = dmax === 0 ? Y_BOTTOM + Y_SPAN / 2 : Y_BOTTOM + Y_SPAN * (d / dmax);
    const count = level.length;
    level.forEach((n, i) => {
      const x = ((i + 0.5) / count * 2 - 1) * X_SPAN;
      const z = (h32(n.id + 'z') - 0.5) * 2 * Z_JITTER;
      coords.set(n.id, [x, y, z]);
    });
  });
  alignColumns(coords, levels);
  straightenRoutes(coords, levels, routes);
  return coords;
}

/* 横向对齐：把每个节点拉向它上下邻居的平均横坐标，形成竖直立柱。

   为什么需要：层内等距分配只保证同层均匀，不管边的走向。相邻两层节点数不同时
   （本数据 L1 有 7 个、L2 有 5 个），同一条边的两端会被推到相距很远的格位上。
   实测有 7 段边的水平位移超过层间距的 1.5 倍，最大 3.79 倍（推荐的反例→顺着线索走），
   画面上就是横穿全图的近水平线。

   做法：迭代松弛，每轮把节点移向邻居均值，再在层内重新排序并保持最小间距。
   层内相对顺序由 barycenter 决定，这里只调间距，不改顺序。 */
const ALIGN_ROUNDS = 60;
const ALIGN_RATE = 0.5;
const UPRIGHT_RATE = 0.35;  // 逐层回正力度，防止上层被单侧拉成斜塔（0.18~0.8 扫描后取最优）
const MIN_GAP = 0.17;

function alignColumns(coords, levels) {
  const neighbours = new Map();
  for (const level of levels)
    for (const n of level) {
      if (!neighbours.has(n.id)) neighbours.set(n.id, []);
      for (const dep of n.deps) {
        if (!coords.has(dep)) continue;
        neighbours.get(n.id).push(dep);
        if (!neighbours.has(dep)) neighbours.set(dep, []);
        neighbours.get(dep).push(n.id);
      }
    }

  for (let round = 0; round < ALIGN_ROUNDS; round++) {
    // 1) 朝邻居均值移动
    const want = new Map();
    for (const level of levels)
      for (const n of level) {
        const refs = neighbours.get(n.id) || [];
        if (!refs.length) { want.set(n.id, coords.get(n.id)[0]); continue; }
        const avg = refs.reduce((s, id) => s + coords.get(id)[0], 0) / refs.length;
        want.set(n.id, coords.get(n.id)[0] + (avg - coords.get(n.id)[0]) * ALIGN_RATE);
      }
    for (const [id, x] of want) coords.get(id)[0] = x;

    // 2) 逐层回正：上层节点少、被邻居单侧拉扯会形成"斜塔"。
    //    实测无回正时各层中心从 L0 的 +0.34 一路漂到 L7 的 -0.86。
    for (const level of levels) {
      if (level.length < 2) continue;
      const xs = level.map(n => coords.get(n.id)[0]);
      const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
      if (Math.abs(mid) < 1e-9) continue;
      for (const n of level) coords.get(n.id)[0] -= mid * UPRIGHT_RATE;
    }

    // 3) 居中。只做居中，不强制铺满画幅。
    //    早先版本在这里等比放大到 ±X_SPAN，结果把边的水平位移一起放大，
    //    最陡边段从 1.29× 反弹到 1.55× 层间距，层内间距也被压到 0.06。
    //    画面偏窄不是问题（渲染侧可整体缩放），边变横才是问题。
    const all = [...coords.values()];
    if (!all.length) continue;
    const xs = all.map(v => v[0]);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    if (Math.abs(mid) > 1e-9) for (const v of all) v[0] -= mid;

    // 4) 层内最小间距，推开后按原中心回正，避免整层被推向一侧
    for (const level of levels) {
      if (level.length < 2) continue;
      const order = [...level].sort((a, b) => coords.get(a.id)[0] - coords.get(b.id)[0]);
      const before = (coords.get(order[0].id)[0] + coords.get(order[order.length-1].id)[0]) / 2;
      for (let i = 1; i < order.length; i++) {
        const prev = coords.get(order[i-1].id)[0], cur = coords.get(order[i].id)[0];
        if (cur - prev < MIN_GAP) coords.get(order[i].id)[0] = prev + MIN_GAP;
      }
      const after = (coords.get(order[0].id)[0] + coords.get(order[order.length-1].id)[0]) / 2;
      const shift = after - before;
      if (Math.abs(shift) > 1e-9) for (const n of order) coords.get(n.id)[0] -= shift;
      for (const n of order) {
        const v = coords.get(n.id);
        v[0] = Math.max(-X_SPAN, Math.min(X_SPAN, v[0]));
      }
    }
  }
}

/* 走线平滑：把长边的虚拟支点向"起点↔终点"的直线拉近。

   为什么需要：虚拟节点只参与 barycenter 排序，横坐标仍按层内等距分配，
   于是折线被强行拉开。本数据实测那条跨 7 层的边单段水平位移达 0.700，
   是层间垂直距离 0.238 的 2.9 倍，画面上仍然读成一条横向大甩的穿楼线。

   做法：虚拟支点的 x 按线性插值重算，再夹到相邻真实节点的间隙中点，
   避免压到同层的真实节点上。真实节点坐标不动。 */
function straightenRoutes(coords, levels, routes) {
  const layerIndex = new Map();
  levels.forEach((level, d) => level.forEach(n => layerIndex.set(n.id, d)));

  for (const [key, chain] of routes) {
    if (!chain.length) continue;
    const [from, to] = key.split('>');
    const a = coords.get(from), b = coords.get(to);
    if (!a || !b) continue;
    chain.forEach((vid, k) => {
      const t = (k + 1) / (chain.length + 1);
      const want = a[0] + (b[0] - a[0]) * t;
      const d = layerIndex.get(vid);
      // 同层真实节点的占位，避免支点压到实点上
      const occupied = levels[d]
        .filter(n => n._real)
        .map(n => coords.get(n.id)[0])
        .sort((p, q) => p - q);
      coords.get(vid)[0] = nudgeClear(want, occupied, 0.12);
    });
  }
}

/* 把 x 推离最近的占位点，至少留出 gap。只做一次最小位移，保持确定性。 */
function nudgeClear(x, occupied, gap) {
  let best = x;
  for (const o of occupied) {
    if (Math.abs(best - o) >= gap) continue;
    const left = o - gap, right = o + gap;
    best = Math.abs(x - left) <= Math.abs(x - right) ? left : right;
  }
  return Math.max(-X_SPAN, Math.min(X_SPAN, best));
}

/** 长边的折线路径：Map<"from>to", 沿途虚拟节点 id 数组（自下而上）>。P3 画边时用。 */
export function edgeRoutes(nodes) {
  return solve(nodes).routes;
}

/* 分层 + 拆长边 + barycenter，三步一次算定 */
function solve(nodes) {
  const depth = longestDepth(nodes);
  const {items, routes} = splitLongEdges(nodes, depth);

  // 虚拟节点的层号已记在 _layer，真实节点用 depth
  const layerOf = n => (n._real ? depth.get(n.id) : n._layer);
  const dmax = Math.max(...items.map(layerOf));
  const levels = Array.from({length: dmax + 1}, () => []);
  for (const n of items) levels[layerOf(n)].push(n);
  for (const level of levels) level.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const kids = new Map(items.map(n => [n.id, []]));
  for (const n of items)
    for (const dep of n.deps)
      if (kids.has(dep)) kids.get(dep).push(n.id);

  barycenterSweep(levels, kids);
  return {levels, routes};
}

/** 调试用：返回排序后的层次结构（只含真实节点），便于核对层内顺序与交叉数 */
export function structureLevels(nodes) {
  return solve(nodes).levels.map(level => level.filter(n => n._real).map(n => n.id));
}

/** 调试用：含虚拟节点的完整层次结构 */
export function structureLevelsAll(nodes) {
  return solve(nodes).levels.map(level => level.map(n => n.id));
}
