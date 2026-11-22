/* 承重分析：账单与改写对比
   数据来自 quotation-case.js，与星图使用同一张判断表。 */

import { graph, versions, quote } from "./quotation-case.js";
import { brightnessMonotonic } from "./starfield.js";

const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

const byId = new Map(graph.map((n) => [n.id, n]));
const conflicts = versions.original.conflicts;
const priced = quote(conflicts);
const brightness = brightnessMonotonic(graph);
const walls = new Set(
  graph.filter((n, i) => brightness[i] > 0.5).map((n) => n.id)
);
const dead = graph.filter((n) => priced.dead.has(n.id));
const collapsed = dead.filter((n) => !conflicts.includes(n.id));

/* 账单 */
$("costRate").textContent = priced.rate;
$("costDirect").textContent = conflicts.length;
$("costWalls").textContent = conflicts.filter((id) => walls.has(id)).length;
$("costLost").textContent = `${priced.lost} / ${priced.total}`;
$("costCollapsed").textContent = collapsed.length;
$("costCount").textContent =
  `${dead.length} / ${graph.length}（${Math.round((100 * dead.length) / graph.length)}%）`;
$("impactCount").textContent = dead.length;

const first = byId.get(conflicts[0]);
$("costQuote").textContent = `「${first.text}」`;
$("costWhy").textContent =
  "「只会变窄」与他这段亲身经历冲突。报价按判断之间的支撑关系计算：" +
  "拆掉它，所有以它为依据的判断会跟着失去支撑。";

/* 受影响判断列表 */
const list = $("impactList");
for (const n of dead) {
  const direct = conflicts.includes(n.id);
  const li = document.createElement("li");
  if (direct) li.classList.add("direct");

  const top = document.createElement("div");
  top.className = "impact-top";

  const name = document.createElement("span");
  name.className = "impact-name";
  name.textContent = n.name;

  const weight = document.createElement("span");
  weight.className = "impact-weight";
  weight.textContent = `承重 ${n.S}`;

  const tag = document.createElement("span");
  tag.className = "impact-tag";
  tag.textContent = direct ? "直接冲突" : "随依据失去支撑";

  const text = document.createElement("p");
  text.textContent = n.text;

  top.append(name, weight);
  li.append(top, tag, text);
  list.append(li);
}

/* 原话 */
$("oldRateValue").textContent = priced.rate;
$("oldText").textContent = versions.original.text;

/* 改写切换 */
const modes = {
  faithful: versions.faithful,
  scope: versions.scope,
};
let mode = "scope";

function showMode(key) {
  mode = key;
  const version = modes[key];
  const result = quote(version.conflicts);

  $("newRateValue").textContent = result.rate;
  $("newRate").classList.toggle("danger", result.rate >= 40);
  $("newText").textContent = version.text;
  $("newNote").textContent = version.reason || "";
  $("rewriteCaption").textContent =
    key === "scope"
      ? `换语气仍是 ${priced.rate}%；缩小主张范围后降到 ${result.rate}%。`
      : `只换语气不降价：仍是 ${result.rate}%。`;

  for (const tab of document.querySelectorAll(".rewrite-tab")) {
    const on = tab.dataset.mode === key;
    tab.classList.toggle("is-on", on);
    tab.setAttribute("aria-selected", String(on));
  }
}

for (const tab of document.querySelectorAll(".rewrite-tab")) {
  tab.addEventListener("click", () => showMode(tab.dataset.mode));
}
showMode("scope");

/* 复制 */
let feedbackTimer = 0;

async function copyText(text) {
  const feedback = $("copyFeedback");
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (err) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try {
      ok = document.execCommand("copy");
    } catch (e) {}
    ta.remove();
  }
  feedback.textContent = ok ? "已复制" : "复制失败，请手动选择文本";
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    feedback.textContent = "";
  }, 2400);
}

$("copyOld").addEventListener("click", () => copyText(versions.original.text));
$("copyNew").addEventListener("click", () => copyText(modes[mode].text));

/* 滚动出现 */
const reveals = [...document.querySelectorAll(".reveal")];

if (reduceMotion.matches || !("IntersectionObserver" in window)) {
  for (const el of reveals) el.classList.add("in");
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -8%" }
  );
  for (const el of reveals) observer.observe(el);
}
