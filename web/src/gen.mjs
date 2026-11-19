// 生成 mocks/star.js —— 确定性。同一 seed 永远同一张图。
// node web/src/gen.mjs

const SEED = 20261119;
const N = 217;
const K = 7;          // 信念簇
const P1 = 0.30;      // 单依赖比例
const LOCAL = 0.70;   // 依赖落在同一簇的比例
const WINDOW = 45;    // 只往回看这么远，避免长出“一句话撑着全部”

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);

const SUBJ = [
  "算法推荐", "短视频", "考研", "大厂", "远程办公", "AI 编程", "房价",
  "体制内", "读博", "创业", "健身", "社交媒体", "应试教育", "互联网医疗",
  "消费降级", "一线城市", "婚姻", "养老金", "开源项目", "自媒体",
];
const PRED = [
  "让人变窄", "正在摧毁注意力", "是被高估的解法", "本质是资源分配",
  "只是把问题往后推", "比努力更重要", "不该被浪漫化", "三年内会失效",
  "是阶层筛选器", "解决不了信任问题", "在放大既有差距",
];

const pool = [];
for (const s of SUBJ) for (const p of PRED) pool.push(`${s}${p}，也不全是。`);
for (let i = pool.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}

const clusterOf = (i) => Math.floor((i * K) / N);
const nodes = pool.slice(0, N).map((text, i) => ({ id: `n${i}`, text, deps: [], cluster: clusterOf(i) }));

for (let i = 1; i < N; i++) {
  const r = rnd();
  // 12% 是根：一个人总有一些没来由就信了的东西
  const k = r < 0.12 ? 0 : r < 0.37 ? 1 : r < 0.82 ? 2 : 3;
  const ds = [];
  const lo = Math.max(0, i - WINDOW);
  for (let d = 0; d < k; d++) {
    let j;
    if (rnd() < LOCAL) {
      const cLo = Math.max(lo, clusterOf(i) * (N / K));
      const cHi = Math.min(i, cLo + Math.ceil(N / K));
      j = cHi > cLo ? cLo + Math.floor(rnd() * (cHi - cLo)) : lo + Math.floor(rnd() * (i - lo));
    } else {
      j = lo + Math.floor(rnd() * (i - lo));
    }
    let guard = 0;
    while (ds.includes(j) && guard++ < 20) j = lo + Math.floor(rnd() * (i - lo));
    if (!ds.includes(j) && j < i) ds.push(j);
  }
  nodes[i].deps = ds.map((j) => `n${j}`);
}

for (const n of nodes) {
  for (const d of n.deps) {
    if (!nodes[+d.slice(1)]) throw new Error(`悬空依赖 ${n.id} -> ${d}`);
    if (+d.slice(1) >= +n.id.slice(1)) throw new Error(`非拓扑序 ${n.id} -> ${d}`);
  }
}

const out =
  `// 自动生成，勿手改。node web/src/gen.mjs\n` +
  `export const STAR = ${JSON.stringify({ user: "林行", seed: SEED, clusters: K, nodes })};\n`;

import { writeFileSync } from "node:fs";
writeFileSync(new URL("./mocks/star.js", import.meta.url), out);
console.log(`nodes=${nodes.length} deps=${nodes.reduce((a, n) => a + n.deps.length, 0)} bytes=${out.length}`);
