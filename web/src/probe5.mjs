import { STAR } from "./mocks/star.js";

const g = STAR.nodes;

function collapse(removed) {
  const dead = new Set(removed);
  let ch = true;
  while (ch) {
    ch = false;
    for (const n of g) {
      if (dead.has(n.id) || !n.deps.length) continue;
      const alive = n.deps.filter((d) => !dead.has(d)).length;
      if (alive / n.deps.length < 0.5) {
        dead.add(n.id);
        ch = true;
      }
    }
  }
  return dead;
}

const kids = new Map(g.map((n) => [n.id, []]));
for (const n of g) for (const d of n.deps) kids.get(d).push(n.id);
const desc = new Map();
for (let i = g.length - 1; i >= 0; i--) {
  const n = g[i];
  const s = new Set();
  for (const c of kids.get(n.id)) {
    s.add(c);
    for (const x of desc.get(c)) s.add(x);
  }
  desc.set(n.id, s);
}
const S = (id) => desc.get(id).size;
const totalS = g.reduce((a, n) => a + desc.get(n.id).size, 0);

const picks = [];
for (let c = 0; c < 7; c++) {
  let best = null;
  let bg = -1;
  for (const n of g) {
    if (n.cluster !== c || !n.deps.length) continue;
    const s = collapse(new Set([n.id])).size;
    if (s > bg) {
      bg = s;
      best = n.id;
    }
  }
  picks.push(best);
}

const rateOf = (arr) => {
  const dead = collapse(new Set(arr));
  const s = g.filter((n) => dead.has(n.id)).reduce((a, n) => a + S(n.id), 0);
  return { pct: +((100 * s) / totalS).toFixed(1), n: dead.size };
};

console.log("full7", JSON.stringify(rateOf(picks)));
const byId = new Map(g.map((n) => [n.id, n]));
let bestPair = null;
for (let i = 0; i < picks.length; i++) {
  for (let j = i + 1; j < picks.length; j++) {
    const r = rateOf([picks[i], picks[j]]);
    if (!bestPair || r.pct < bestPair.r.pct) bestPair = { pair: [picks[i], picks[j]], r };
  }
}
console.log("cheapest pair", JSON.stringify(bestPair));
console.log("picks", picks.map((id) => `${id}:S${S(id)}`).join(" "));
