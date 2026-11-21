import { STAR } from "./mocks/star.js";
import { computeGraph, render, price, brightness, collapseAfter } from "./starfield.js";

const W = 1200, H = 640;
const graph = computeGraph(STAR.nodes);
const walls = [...graph].sort((a, b) => b.S - a.S).slice(0, 6).map((n) => n.id);
const wallSet = new Set(walls);
const byId = new Map(graph.map((n) => [n.id, n]));

const fmt = (x) => x.toLocaleString("en-US");

/* ---------- 算一次，四个页面共用 ---------- */
const PRICE = price(graph);
const totalS = graph.reduce((a, n) => a + n.S, 0);
// 便宜版：改写只动一个信念区——他真正的栋梁那一根。原话同时与七个区冲突，
// 所以要拆七根；改写只碰一根。塌多少由模型算，不手调。
const cheapPicks = PRICE.picks.slice().sort((a, b) => byId.get(b).S - byId.get(a).S).slice(0, 1);
const cheapDead = collapseAfter(new Set(cheapPicks), graph);
const cheapS = graph.filter((n) => cheapDead.has(n.id)).reduce((a, n) => a + n.S, 0);
const RATE = Math.round(PRICE.rate * 100);
const CHEAP_RATE = Math.round((cheapS / totalS) * 100);

// 每颗星拆了会塌多少：只算一次
const FALL = new Map();
for (const n of graph) FALL.set(n.id, collapseAfter(new Set([n.id]), graph).size - 1);

function route() {
  const r = location.hash.replace("#/", "") || "house";
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("on"));
  document.querySelectorAll(".rail-nav a").forEach((a) => a.classList.remove("on"));
  const el = document.getElementById(`s-${r}`);
  if (el) el.classList.add("on");
  const link = document.querySelector(`.rail-nav a[data-r="${r}"]`);
  if (link) link.classList.add("on");
  if (r === "house") {
    drawHouse();
    const sel = new URLSearchParams(location.search).get("sel");
    if (sel && byId.has(sel)) showNode(sel);
  }  if (r === "price") drawPrice();
  if (r === "rewrite") drawRewrite();
}
window.addEventListener("hashchange", route);

/* ---------- 01 读 ---------- */
const btnRead = document.getElementById("btnRead");
if (btnRead) btnRead.addEventListener("click", () => { document.getElementById("prog").style.width = "100%"; });

/* ---------- 02 建 ---------- */
let state = null;
let selId = null;

/* 右栏：默认列承重墙 */
function wallsPanel() {
  selId = null;
  const box = document.getElementById("wallsBox");
  box.innerHTML = "";
  walls.forEach((id, i) => {
    const n = byId.get(id);
    const div = document.createElement("div");
    div.className = "wall";
    div.innerHTML =
      `<div class="no">${String(i + 1).padStart(2, "0")}</div>` +
      `<p>${n.text}</p>` +
      `<div class="m">承重 ${n.S} · 拆了塌 ${FALL.get(id)}</div>`;
    div.addEventListener("click", () => showNode(id));
    box.appendChild(div);
  });
  state.nodeEls.forEach((el) => el.classList.remove("dead", "focus"));
}

/* 点星：塌掉的那一片暗下去 */
function showNode(id) {
  selId = id;
  const n = byId.get(id);
  const dead = collapseAfter(new Set([id]), graph);
  const fallen = graph
    .filter((x) => dead.has(x.id) && x.id !== id)
    .sort((a, b) => b.S - a.S);
  const left = graph.length - dead.size;

  state.nodeEls.forEach((el, nid) => {
    el.classList.toggle("dead", dead.has(nid));
    el.classList.toggle("focus", nid === id);
  });

  const box = document.getElementById("wallsBox");
  box.innerHTML = "";

  const head = document.createElement("div");
  head.className = "wall sel";
  head.innerHTML =
    `<div class="no">拆</div>` +
    `<p>${n.text}</p>` +
    `<div class="m">拆了塌 ${fallen.length} 个 · 还剩 ${left}</div>`;
  box.appendChild(head);

  fallen.slice(0, 6).forEach((f) => {
    const d = document.createElement("div");
    d.className = "fallen";
    d.innerHTML = `${f.text}`;
    box.appendChild(d);
  });
  if (fallen.length > 6) {
    const d = document.createElement("div");
    d.className = "m";
    d.textContent = `……还有 ${fallen.length - 6} 个`;
    box.appendChild(d);
  }

  const back = document.createElement("a");
  back.className = "hook back";
  back.href = "#/house";
  back.textContent = "← 回到承重墙";
  back.addEventListener("click", (e) => { e.preventDefault(); wallsPanel(); });
  box.appendChild(back);
}

function drawHouse() {
  if (state) return;
  const svg = document.getElementById("star");
  state = render(svg, graph, W, H, { walls });

  const darkest = Math.min(...graph.map((n) => 6.2 - 2.5 * Math.log10(1 + n.S)));
  document.getElementById("houseHead").innerHTML =
    `<span><b>${graph.length}</b> 个判断</span>` +
    `<span><b>${walls.length}</b> 堵承重墙</span>` +
    `<span>最亮 <b>${darkest.toFixed(2)}</b> 等</span>`;

  const box = document.getElementById("wallsBox");
  box.innerHTML = "";

  state.nodeEls.forEach((el, id) => {
    el.setAttribute("tabindex", "0");
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", `${byId.get(id).text}，承重 ${byId.get(id).S}`);
    el.addEventListener("click", () => showNode(id));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showNode(id); }
    });
  });

  wallsPanel();
}

/* ---------- 03 算 ---------- */
function drawPrice() {
  const res = PRICE;
  const num = document.getElementById("priceNum");
  num.innerHTML = `${RATE}<small>%</small>`;
  num.setAttribute("aria-live", "polite");

  document.getElementById("t1").textContent = fmt(res.picks.length);
  document.getElementById("t2").textContent = fmt(res.picks.filter((id) => wallSet.has(id)).length);
  document.getElementById("t3").textContent = `${fmt(res.collapsed)} / ${fmt(res.total)}`;
  document.getElementById("t4").textContent = `${(res.raw * 100).toFixed(1)}%`;

  const inset = document.getElementById("inset");
  const st = render(inset, graph, W, H, { walls: res.picks, dim: 0.6, noise: false });

  let cx = 0, cy = 0;
  res.picks.forEach((id) => { const p = st.pos.get(id); cx += p.x; cy += p.y; });
  cx /= res.picks.length; cy /= res.picks.length;
  const box = 320;
  const vx = Math.max(0, Math.min(W - box, cx - box / 2));
  const vy = Math.max(0, Math.min(H - box, cy - box / 2));
  inset.setAttribute("viewBox", `${vx} ${vy} ${box} ${box}`);

  // 熄灯：要拆的星逐颗灭掉，依赖它们的一片跟着塔下去
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    || new URLSearchParams(location.search).has("still");
  const kill = (el) => el && el.classList.add("dead");
  if (still) {
    res.dead.forEach((id) => kill(st.nodeEls.get(id)));
  } else {
    setTimeout(() => {
      res.picks.forEach((id, i) => setTimeout(() => kill(st.nodeEls.get(id)), i * 110));
      setTimeout(() => {
        res.dead.forEach((id) => kill(st.nodeEls.get(id)));
      }, res.picks.length * 110 + 160);
    }, 520);
  }

  document.getElementById("oldNum").innerHTML = `${RATE}<small>%</small>`;
  document.getElementById("newNum").innerHTML = `${CHEAP_RATE}<small>%</small>`;
  document.getElementById("rewriteNote").textContent =
    `同一个意思，少拆 ${res.picks.length - cheapPicks.length} 根柱子。`;
}

/* ---------- 04 换说法 ---------- */
function drawRewrite() {
  document.getElementById("oldNum").innerHTML = `${RATE}<small>%</small>`;
  document.getElementById("newNum").innerHTML = `${CHEAP_RATE}<small>%</small>`;
  document.getElementById("rewriteNote").textContent =
    `同一个意思，少拆 ${PRICE.picks.length - cheapPicks.length} 根柱子。`;
}

const btnCopy = document.getElementById("btnCopy");
if (btnCopy) btnCopy.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(document.getElementById("rewriteLine").textContent); } catch (_) {}
});

/* 自检：亮度分档 / 确定性 */
window.__check = () => {
  const L = brightness(graph);
  const s = [...L].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: +s[Math.floor(s.length / 2)].toFixed(3),
    over50: ((L.filter((v) => v > 0.5).length / L.length) * 100).toFixed(1) + "%",
  };
};

route();
