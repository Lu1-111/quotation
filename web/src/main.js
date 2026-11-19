import { STAR } from "./mocks/star.js";
import { computeGraph, brightness, collapseAfter, price } from "./starfield.js";
import { createGalaxy } from "./galaxy.js";

/* ---------- 数据 ---------- */
const graph = computeGraph(STAR.nodes);
const byId = new Map(graph.map((n) => [n.id, n]));
const totalS = graph.reduce((a, n) => a + n.S, 0);

const PRICE = price(graph);
const picks = PRICE.picks;
const heavy = picks.slice().sort((a, b) => byId.get(b).S - byId.get(a).S)[0];
const cheapPicks = [heavy];
const cheapDead = collapseAfter(new Set(cheapPicks), graph);
const cheapS = graph.filter((n) => cheapDead.has(n.id)).reduce((a, n) => a + n.S, 0);

const RATE = Math.round(PRICE.rate * 100);
const CHEAP = Math.round((cheapS / totalS) * 100);
const WALLS = graph.slice().sort((a, b) => b.S - a.S).slice(0, 5);
const WALL_IDS = WALLS.map((n) => n.id);

/* ---------- 星图（canvas 手绘星系） ---------- */
const sky = document.getElementById("sky");
const pinsBox = document.getElementById("pins");
let VW = window.innerWidth, VH = window.innerHeight;

const LS = brightness(graph);
const NODES = graph.map((n, i) => ({
  id: n.id,
  S: n.S,
  L: LS[i],
  wall: WALL_IDS.includes(n.id),
}));

const galaxy = createGalaxy(document.getElementById("skyCanvas"), NODES);

/* 五条承重墙标签，坐标每帧跟着镜头走 */
const pins = WALLS.map((n, i) => {
  const el = document.createElement("div");
  el.className = "pin";
  el.innerHTML = `<p>${n.text}</p><b>承重 ${n.S} · 塌 ${collapseAfter(new Set([n.id]), graph).size - 1}</b>`;
  pinsBox.appendChild(el);

  const lead = document.createElement("div");
  lead.className = "lead";
  pinsBox.appendChild(lead);
  return { el, lead, id: n.id };
});

/* ---------- 镜头 ---------- */
const K = [
  { s: 1.0, tx: 0, ty: 120, o: 1 },
  { s: 2.3, tx: 0, ty: 30, o: 1 },
  { s: 0.72, tx: 0, ty: 0, o: 0.18 },
  { s: 0.9, tx: 0, ty: 0, o: 0 },
];
const BASE = 0.62; // #skySvg 自身的底缩放

const cam = { s: K[0].s, tx: K[0].tx, ty: K[0].ty, o: K[0].o };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

let frozen = null;

function target() {
  if (frozen !== null) return { ...K[frozen], p: frozen };
  const p = clamp(window.scrollY / window.innerHeight, 0, 3);
  const i = Math.min(2, Math.floor(p));
  const f = ease(clamp(p - i, 0, 1));
  const a = K[i], b = K[i + 1];
  return {
    s: a.s + (b.s - a.s) * f,
    tx: a.tx + (b.tx - a.tx) * f,
    ty: a.ty + (b.ty - a.ty) * f,
    o: a.o + (b.o - a.o) * f,
    p,
  };
}

let raf = 0, last = 0;

function frame(t) {
  const dt = Math.min(0.05, (t - last) / 1000 || 0.016);
  last = t;
  const T = target();
  const k = 1 - Math.exp(-dt * 6);

  cam.s += (T.s - cam.s) * k;
  cam.tx += (T.tx - cam.tx) * k;
  cam.ty += (T.ty - cam.ty) * k;
  cam.o += (T.o - cam.o) * k;

  galaxy.setCamera(cam);
  sky.style.opacity = cam.o.toFixed(3);

  // 标签跟着星走：相机变换后星点在屏幕上的位置
  const near = clamp(1 - Math.abs(T.p - 1) * 2.4, 0, 1);
  pinsBox.style.opacity = (near * cam.o).toFixed(3);
  if (near > 0.01) {
    const arr = [];
    for (const pin of pins) {
      const q = galaxy.project(pin.id);
      if (!q) continue;
      arr.push({ pin, x: q.x, y: q.y });
    }
    // 标签打架：按 y 排序后向下推开，最后整体上顶回屏内
    arr.sort((a, b) => a.y - b.y);
    let prev = -1e9;
    for (const it of arr) { it.ly = Math.max(it.y, prev + 34); prev = it.ly; }
    const over = arr.length ? arr[arr.length - 1].ly - (VH - 72) : 0;
    if (over > 0) for (const it of arr) it.ly -= over;

    const colX = Math.max(VW * 0.34, 486);
    for (const it of arr) {
      const vis = it.x > -400 && it.x < VW - 80 ? "visible" : "hidden";
      const dx = colX - it.x;
      const dy = it.ly - it.y;
      it.pin.el.style.left = colX.toFixed(1) + "px";
      it.pin.el.style.top = it.ly.toFixed(1) + "px";
      it.pin.el.style.visibility = vis;
      it.pin.lead.style.left = it.x.toFixed(1) + "px";
      it.pin.lead.style.top = it.y.toFixed(1) + "px";
      it.pin.lead.style.width = Math.hypot(dx, dy).toFixed(1) + "px";
      it.pin.lead.style.transform = `rotate(${(Math.atan2(dy, dx) * 180 / Math.PI).toFixed(2)}deg)`;
      it.pin.lead.style.visibility = vis;
    }
  }

  document.body.classList.toggle("at-s2", T.p > 0.55 && T.p < 1.45);
  if (T.p > 2.35) paintHalves(false);

  const settled =
    Math.abs(T.s - cam.s) < 0.0008 &&
    Math.abs(T.tx - cam.tx) < 0.05 &&
    Math.abs(T.ty - cam.ty) < 0.05 &&
    Math.abs(T.o - cam.o) < 0.0008;

  raf = settled ? 0 : requestAnimationFrame(frame);
}

function kick() {
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
}

/* ---------- 章节刻度 ---------- */
const ticks = [...document.querySelectorAll(".ticks a")];
function syncTicks() {
  const i = Math.round(clamp(window.scrollY / window.innerHeight, 0, 3));
  ticks.forEach((a, j) => a.classList.toggle("on", j === i));
}

/* ---------- 03 报价 ---------- */
document.getElementById("rate").innerHTML = `${RATE}<small>%</small>`;
document.getElementById("t1").textContent = picks.length;
document.getElementById("t2").textContent = picks.filter((id) => WALL_IDS.includes(id) || byId.get(id).S > 120).length;
document.getElementById("t3").textContent = `${PRICE.collapsed} / ${PRICE.total}`;
document.getElementById("t4").textContent = (PRICE.raw * 100).toFixed(1) + "%";
document.getElementById("meta").textContent =
  `${graph.length} 判断 · ${WALL_IDS.length} 承重墙 · 视星等 0.50`;

/* ---------- 04 换说法：同一张星系渲染一次，再按竖线切成两半 —— 不是两份数据 ---------- */
const halfA = document.getElementById("halfA");
const halfB = document.getElementById("halfB");
const off = document.createElement("canvas");
let halfAt = 0;

function paintHalves(force) {
  const now = performance.now();
  if (!force && halfAt && now - halfAt < 400) return;
  halfAt = now;
  VW = window.innerWidth; VH = window.innerHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const sw = Math.round((VW / 2) * dpr);
  const sh = Math.round(VH * dpr);

  for (const c of [halfA, halfB]) {
    if (c.width !== sw || c.height !== sh) { c.width = sw; c.height = sh; }
  }
  const srcW = Math.round(off.width / 2);
  const ga = halfA.getContext("2d");
  const gb = halfB.getContext("2d");

  // 左：原话——七根柱子全标红
  galaxy.renderTo(off, { s: 0.9, tx: 0, ty: 0, o: 1 }, true, PRICE.picks);
  ga.drawImage(off, 0, 0, srcW, off.height, 0, 0, sw, sh);

  // 右：改后——只剩最轻的那两根
  galaxy.renderTo(off, { s: 0.9, tx: 0, ty: 0, o: 1 }, true, cheapPicks);
  gb.drawImage(off, off.width - srcW, 0, srcW, off.height, 0, 0, sw, sh);
}

document.getElementById("oldNum").textContent = RATE;
document.getElementById("newNum").textContent = CHEAP;
document.getElementById("note").textContent =
  `同一个意思，少拆 ${picks.length - cheapPicks.length} 根柱子。`;

document.getElementById("copy").addEventListener("click", async () => {
  const t = document.getElementById("say").textContent;
  try {
    await navigator.clipboard.writeText(t);
    document.getElementById("copy").textContent = "已复制";
  } catch {
    document.getElementById("copy").textContent = "选中后复制";
  }
});

/* ---------- 启动 ---------- */
function boot() {
  galaxy.setCamera(cam);
  galaxy.start();
  paintHalves();
  syncTicks();
  kick();
}

window.addEventListener("scroll", () => { syncTicks(); kick(); }, { passive: true });
window.addEventListener("resize", () => {
  VW = window.innerWidth; VH = window.innerHeight;
  galaxy.resize();
  paintHalves();
  kick();
});
window.addEventListener("load", kick);

boot();

// 调试：?only=1 只留第二屏并把镜头直接推到位（截图用）
const only = new URLSearchParams(location.search).get("only");
if (only !== null) {
  const n = Number(only);
  document.querySelectorAll(".s").forEach((el, i) => { el.style.display = i === n ? "block" : "none"; });
  document.documentElement.style.scrollSnapType = "none";
  frozen = n;
  Object.assign(cam, K[n]);
  kick();
}

// 调试：?dbg=1 把滚动量写到标题里
if (new URLSearchParams(location.search).get("dbg")) {
  setTimeout(() => {
    document.title = `sy=${scrollY} ih=${innerHeight} dh=${document.documentElement.scrollHeight} p=${(scrollY / innerHeight).toFixed(2)}`;
  }, 800);
}
