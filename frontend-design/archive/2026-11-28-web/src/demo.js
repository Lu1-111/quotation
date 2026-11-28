/* 报价 / QUOTATION — 四屏完整 demo
   数字全部来自已验证模块，这里不另写一套数学：
     quotation-case.js   30 条判断 + 依赖 + 报价口径（P0）
     structure-layout.js 结构态坐标 + 长边折线支点（P1）
     structure-morph.js  形变量 / 相机（含 roll）/ 坐标插值（P2）
     starfield.js        承重 → 亮度 / 半径 / 辉光

   ⚠ 轨道部分是替身：仓库里的 orbit-system.js 未取到完整源码，
   这里用一组椭圆近似星空态，只为提供形变起点，不是真实实现。
   结构态坐标、承重、塌陷波次、报价百分比都是真实计算结果。
*/

import {graph, versions, quote, SPINE} from './quotation-case.js';
import {layoutStructure, edgeRoutes, isVirtual} from './structure-layout.js';
import {
  morphAmount, cameraTarget, blendCoord, veilAmount, isFrozen,
  debugMorph, discOpacity, MORPH_TO,
} from './structure-morph.js';
import {brightnessMonotonic, radius, glowR, glowA, collapseAfter, h32} from './starfield.js';

const $ = id => document.getElementById(id);
const canvas = $('sky');
const ctx = canvas.getContext('2d');
const TAU = Math.PI * 2;
const GOLD = [255, 210, 122], RED = [214, 74, 50], HELD = [168, 173, 181];
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (p, a, b) => { const t = clamp((p - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/* ── 预解算 ─────────────────────────────────────────────── */
const structure = layoutStructure(graph);
const routes = edgeRoutes(graph);
const L = brightnessMonotonic(graph);
const idx = new Map(graph.map((n, i) => [n.id, i]));
const byId = new Map(graph.map(n => [n.id, n]));
const Lmax = Math.max(...L);
const spine = new Set(SPINE);

const conflicts = versions.original.conflicts;
const priced = quote(conflicts);
const finalDead = priced.dead;
const walls = graph.filter((n, i) => L[i] > 0.5).map(n => n.id);

/* 塌陷波次：同一套过半规则，末态必须等于 collapseAfter */
function collapseWaves(ids) {
  const dead = new Set(ids), out = [[...ids]];
  for (;;) {
    const next = [];
    for (const n of graph) {
      if (dead.has(n.id) || !n.deps.length) continue;
      if (n.deps.filter(d => !dead.has(d)).length / n.deps.length < 0.5) next.push(n.id);
    }
    if (!next.length) break;
    next.forEach(id => dead.add(id));
    out.push(next);
  }
  return out;
}
const waves = collapseWaves(conflicts);
const EXTINGUISH = new Map();
{
  let t = 0;
  waves.forEach(w => { w.forEach((id, k) => EXTINGUISH.set(id, t + k * 0.04)); t += 0.18 + w.length * 0.04; });
}
const COLLAPSE_END = Math.max(...EXTINGUISH.values()) + 0.42;

/* ── 轨道替身 ───────────────────────────────────────────── */
const orbits = graph.map((n, i) => {
  const s = h32(n.id), s2 = h32(n.id + 'o');
  const w = L[i] / Lmax;
  return {id: n.id, a: 0.42 + 0.46 * (1 - w) + s * 0.16, e: 0.03 + s2 * 0.07,
    inc: (s - 0.5) * 0.5, node: s2 * TAU, phase: s * TAU, speed: 0.16 + 0.26 * s2};
});
const orbitCoord = new Map([...graph.map(n => [n.id, [0, 0, 0]]),
  ...[...structure.keys()].filter(isVirtual).map(id => [id, [0, 0, 0]])]);
function advance(t) {
  for (const o of orbits) {
    const th = o.phase + t * o.speed;
    const r = o.a * (1 - o.e * o.e) / (1 + o.e * Math.cos(th));
    const x = Math.cos(th) * r, z = Math.sin(th) * r;
    const cn = Math.cos(o.node), sn = Math.sin(o.node);
    const out = orbitCoord.get(o.id);
    out[0] = x * cn - z * sn;
    out[1] = Math.sin(th) * r * Math.sin(o.inc) * 0.55;
    out[2] = (x * sn + z * cn) * Math.cos(o.inc);
  }
  // 虚拟支点：轨道态下跟随它两端的中点，避免形变时从原点飞出
  for (const [key, chain] of routes) {
    const [from, to] = key.split('>');
    const a = orbitCoord.get(from), b = orbitCoord.get(to);
    if (!a || !b) continue;
    chain.forEach((vid, k) => {
      const q = (k + 1) / (chain.length + 1), out = orbitCoord.get(vid);
      if (!out) return;
      out[0] = lerp(a[0], b[0], q); out[1] = lerp(a[1], b[1], q); out[2] = lerp(a[2], b[2], q);
    });
  }
}

const dust = Array.from({length: 460}, (_, i) => {
  const s = h32('d' + i), s2 = h32('d' + i + 'b');
  const r = 0.25 + Math.pow(s, 0.7) * 1.5;
  return {r, th: s2 * TAU + Math.log(1 + r * 2.8) * 3.65,
    y: (h32('d' + i + 'y') - 0.5) * 0.3 * (1.4 - r), b: 0.05 + s2 * 0.16, sz: 0.5 + s * 1.1};
});

/* ── 相机与投影（照 stellar-disc.js 的 project，roll 从 cam 读）── */
let view = {w: 0, h: 0, dpr: 1};
const cam = {yaw: 0.27, tilt: 0.52, roll: -0.26, zoom: 0.52, offset: 0.1};
function project(c) {
  const cs = Math.cos(cam.yaw), sn = Math.sin(cam.yaw);
  const ct = Math.cos(cam.tilt), st = Math.sin(cam.tilt);
  const cr = Math.cos(cam.roll), sr = Math.sin(cam.roll);
  const extent = Math.min(view.w * 0.445, view.h * 0.75) * cam.zoom;
  const u = c[0] * cs - c[2] * sn, v = c[0] * sn + c[2] * cs;
  const up = v * st - c[1] * ct, depth = v * ct + c[1] * st;
  const persp = 3.9 / (3.9 - depth);
  return {sx: view.w * 0.5 + (u * cr - up * sr) * extent * persp,
    sy: view.h * (0.5 + cam.offset) + (u * sr + up * cr) * extent * persp, persp, depth};
}
/* 结构态的 zoom 必须按视口算，不能写死。
   原来固定 0.82，实测 1920×1080 下顶部溢出 97px、底部 82px，
   最下一层的节点标签和「承重 N」会被视口切掉。
   这里二分出能让整栋楼落进安全框的最大 zoom：
   顶部留 TOP_PAD 给标题，底部留 BOT_PAD 给标签 + 承重字 + 控制条。 */
const TOP_PAD = 96, BOT_PAD = 124, SIDE_PAD = 76;
let structZoom = 0.55;

function fitStructZoom() {
  const saved = {...cam};
  const t = cameraTarget(1, 0.27, 0.52);
  cam.yaw = t.yaw; cam.tilt = t.tilt; cam.roll = t.roll; cam.offset = 0;
  const coords = [...structure.values()];
  const ok = z => {
    cam.zoom = z;
    let lo = Infinity, hi = -Infinity, xl = Infinity, xr = -Infinity;
    for (const c of coords) {
      const p = project(c);
      if (p.sy < lo) lo = p.sy; if (p.sy > hi) hi = p.sy;
      if (p.sx < xl) xl = p.sx; if (p.sx > xr) xr = p.sx;
    }
    return lo >= TOP_PAD && hi <= view.h - BOT_PAD && xl >= SIDE_PAD && xr <= view.w - SIDE_PAD;
  };
  let lo = 0.08, hi = 1.8;
  for (let i = 0; i < 26; i++) { const mid = (lo + hi) / 2; if (ok(mid)) lo = mid; else hi = mid; }
  structZoom = lo;
  Object.assign(cam, saved);
}

function resize() {
  view.dpr = Math.min(devicePixelRatio || 1, 2);
  view.w = innerWidth; view.h = innerHeight;
  canvas.width = Math.round(view.w * view.dpr);
  canvas.height = Math.round(view.h * view.dpr);
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  fitStructZoom();
}
addEventListener('resize', resize); resize();

/* ── 状态 ───────────────────────────────────────────────── */
let simTime = 0, lastFrame = 0, collapseT = -1, forcedM = null, hoverId = null;
const screenPos = new Map();
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

function aliveOf(id) {
  if (collapseT < 0) return 1;
  const t0 = EXTINGUISH.get(id);
  if (t0 === undefined) return 1;
  if (reduced.matches) return 0;
  return 1 - clamp((collapseT - t0) / 0.42, 0, 1);
}
const deadNow = () => graph.filter(n => aliveOf(n.id) < 0.5);

/* ── 绘制 ───────────────────────────────────────────────── */
function draw(m, discA) {
  ctx.clearRect(0, 0, view.w, view.h);
  if (discA <= 0.01) { screenPos.clear(); return; }
  ctx.globalAlpha = discA;

  const veil = veilAmount(m), spin = simTime * 0.08;
  for (const d of dust) {
    const th = d.th + spin / (1 + Math.pow(d.r / 0.42, 1.5));
    const p = project([Math.cos(th) * d.r, d.y, Math.sin(th) * d.r]);
    const a = d.b * veil * clamp(p.persp * 0.8, 0.3, 1.3);
    if (a <= 0.004) continue;
    ctx.fillStyle = `rgba(255,228,190,${a.toFixed(3)})`;
    ctx.fillRect(p.sx, p.sy, d.sz, d.sz);
  }

  screenPos.clear();
  const pts = new Map();
  for (const n of graph) {
    const p = project(blendCoord(orbitCoord.get(n.id), structure.get(n.id), m, [0, 0, 0]));
    pts.set(n.id, p);
    const r = Math.max(1.4, radius(L[idx.get(n.id)]) * 2.0 * p.persp * Math.sqrt(cam.zoom) * 1.9);
    screenPos.set(n.id, {sx: p.sx, sy: p.sy, r});
  }
  for (const [id, coord] of structure) {
    if (isVirtual(id)) pts.set(id, project(blendCoord(orbitCoord.get(id) || coord, coord, m, [0, 0, 0])));
  }

  const edgeK = 0.18 + 0.82 * m;
  for (const n of graph) {
    for (const dep of n.deps) {
      const seq = [dep, ...(routes.get(`${dep}>${n.id}`) || []), n.id].map(i => pts.get(i)).filter(Boolean);
      if (seq.length < 2) continue;
      const aN = aliveOf(n.id), aD = aliveOf(dep);
      let col = GOLD, alpha = 0.10 * edgeK, dash = null;
      if (aN < 0.5) { col = RED; alpha = 0.42 * edgeK; dash = [4, 3]; }
      else if (aD < 0.5) { col = HELD; alpha = 0.55 * edgeK; dash = [1.5, 3]; }
      if (hoverId) alpha = (n.id === hoverId || dep === hoverId) ? Math.max(alpha, 0.6) : alpha * 0.18;
      ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${alpha.toFixed(3)})`;
      ctx.lineWidth = 1; ctx.setLineDash(dash || []);
      ctx.beginPath(); ctx.moveTo(seq[0].sx, seq[0].sy);
      for (let k = 1; k < seq.length; k++) ctx.lineTo(seq[k].sx, seq[k].sy);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);

  for (const n of [...graph].sort((a, b) => pts.get(a.id).depth - pts.get(b.id).depth)) {
    const i = idx.get(n.id), p = pts.get(n.id), sp = screenPos.get(n.id);
    const w = L[i] / Lmax, alive = aliveOf(n.id);
    const r = sp.r * lerp(0.55, 1, alive);
    const near = !hoverId || hoverId === n.id
      || byId.get(hoverId).deps.includes(n.id) || n.deps.includes(hoverId);
    const dim = near ? 1 : 0.3;
    const warm = alive > 0.5 ? GOLD : RED;

    const gr = Math.max(r * 2, glowR(L[i]) * p.persp * 1.5);
    const ga = glowA(L[i]) * lerp(0.25, 1, alive) * dim;
    const g = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, gr);
    g.addColorStop(0, `rgba(${warm[0]},${warm[1]},${warm[2]},${(ga * 1.5).toFixed(3)})`);
    g.addColorStop(0.45, `rgba(${warm[0]},${warm[1]},${warm[2]},${(ga * 0.4).toFixed(3)})`);
    g.addColorStop(1, 'rgba(255,190,120,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.sx, p.sy, gr, 0, TAU); ctx.fill();

    // 星芒强度 = 承重。墙纸只有小光点，承重墙自带十字
    const flare = (0.15 + 0.85 * w) * alive * dim;
    if (flare > 0.22) {
      const len = r * (2.2 + 7 * w), fa = (flare * 0.3).toFixed(3);
      for (const horiz of [true, false]) {
        const grad = horiz
          ? ctx.createLinearGradient(p.sx - len, p.sy, p.sx + len, p.sy)
          : ctx.createLinearGradient(p.sx, p.sy - len, p.sx, p.sy + len);
        grad.addColorStop(0, 'rgba(255,237,204,0)');
        grad.addColorStop(0.5, `rgba(255,237,204,${fa})`);
        grad.addColorStop(1, 'rgba(255,237,204,0)');
        ctx.fillStyle = grad;
        if (horiz) ctx.fillRect(p.sx - len, p.sy - 0.6, len * 2, 1.2);
        else ctx.fillRect(p.sx - 0.6, p.sy - len, 1.2, len * 2);
      }
    }

    ctx.fillStyle = alive > 0.5
      ? `rgba(255,250,238,${(lerp(0.5, 1, w) * dim).toFixed(3)})`
      : `rgba(${RED[0]},${RED[1]},${RED[2]},${(0.55 * dim).toFixed(3)})`;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, r * 0.42, 0, TAU); ctx.fill();

    if (conflicts.includes(n.id) && collapseT >= 0 && alive < 0.98) {
      ctx.strokeStyle = `rgba(${RED[0]},${RED[1]},${RED[2]},0.9)`;
      ctx.lineWidth = 1.4;
      const rr = r * 1.1 + 6, d2 = rr * 0.5;
      ctx.beginPath(); ctx.arc(p.sx, p.sy, rr, 0, TAU); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.sx - d2, p.sy - d2); ctx.lineTo(p.sx + d2, p.sy + d2);
      ctx.moveTo(p.sx + d2, p.sy - d2); ctx.lineTo(p.sx - d2, p.sy + d2);
      ctx.stroke();
    }

    if (w > 0.45 || n.id === hoverId || (m > 0.75 && spine.has(n.id))) {
      ctx.font = '11.5px "Noto Serif SC",serif'; ctx.textAlign = 'center';
      ctx.fillStyle = alive > 0.5 ? `rgba(200,206,214,${(0.9 * dim).toFixed(2)})`
                                  : `rgba(192,130,118,${(0.9 * dim).toFixed(2)})`;
      ctx.fillText(n.name, p.sx, p.sy + r + 15);
      if (w > 0.45) {
        ctx.font = '10px "Noto Serif SC",serif';
        ctx.fillStyle = `rgba(255,210,122,${(0.65 * dim).toFixed(2)})`;
        ctx.fillText(`承重 ${n.S}`, p.sx, p.sy + r + 28);
      }
    }
  }

  if (m > 0.3) {
    const a = project([-1.25, -0.95, 0]), b = project([1.25, -0.95, 0]);
    ctx.strokeStyle = `rgba(58,65,80,${(0.85 * (m - 0.3) / 0.7).toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/* ── 账单：数值由熄灭进度驱动，不是独立计时器 ──────────── */
function updateBill() {
  const dead = deadNow();
  const lost = dead.reduce((s, n) => s + n.S, 0);
  $('rate').textContent = Math.round(100 * lost / priced.total);
  $('t1').textContent = collapseT < 0 ? 0 : conflicts.length;
  $('t2').textContent = `${lost} / ${priced.total}`;
  $('t3').textContent = Math.max(0, dead.length - (collapseT < 0 ? 0 : conflicts.length));
  $('t4').textContent = `${dead.length} / ${graph.length}（${Math.round(100 * dead.length / graph.length)}%）`;
  $('sub').textContent = collapseT < 0 ? '尚未拆除任何判断'
    : `拆掉「${byId.get(conflicts[0]).name}」「${byId.get(conflicts[1]).name}」两条地基`;
}

/* 账单屏的静态内容 */
$('evidence').textContent = `「${byId.get(conflicts[0]).text}」`;
$('evidenceWhy').textContent =
  `「只会变窄」与这段亲身经历冲突。报价按判断之间的支撑关系计算：拆掉它，`
  + `所有以它为依据的判断会跟着失去支撑。`;
$('verdict').textContent = '「只会」排除了他经历过的例外。';
$('impactCap').textContent = `受影响的 ${finalDead.size} 条判断`;
{
  const ol = $('impact');
  for (const n of graph.filter(x => finalDead.has(x.id))) {
    const li = document.createElement('li');
    const direct = conflicts.includes(n.id);
    li.innerHTML = `<b>${direct ? '直接冲突' : '随依据失去支撑'}</b> · ${n.name} · 承重 ${n.S}<br>${n.text}`;
    ol.append(li);
  }
}
$('cRate').textContent = priced.rate;
$('cT1').textContent = conflicts.length;
$('cT0').textContent = conflicts.filter(id => walls.includes(id)).length;
$('cT3').textContent = finalDead.size - conflicts.length;
$('cT2').textContent = `${priced.lost} / ${priced.total}`;

/* ── 改写屏 ─────────────────────────────────────────────── */
const LABELS = {original: '保留原意（换语气）', faithful: '保留原意（换语气）', scope: '缩小主张范围'};
{
  const sel = $('revision');
  for (const [key, v] of Object.entries(versions)) {
    if (key === 'original') continue;
    const o = document.createElement('option');
    o.value = key; o.textContent = LABELS[key] || key;
    sel.append(o);
  }
  sel.value = 'scope';
}
$('oldText').innerHTML = versions.original.text.replace('只会', '<mark>只会</mark>');
$('oldNum').textContent = priced.rate;

function showRevision() {
  const key = $('revision').value, v = versions[key];
  const r = quote(v.conflicts);
  $('newNum').textContent = r.rate;
  $('say').textContent = v.text;
  $('note').textContent = v.reason || '';
  $('feedback').textContent = '';
}
$('revision').onchange = showRevision;
showRevision();

for (const [btn, src] of [['copy', 'say'], ['copyOld', 'oldText']]) {
  $(btn).onclick = async () => {
    const text = $(src).textContent;
    try {
      await navigator.clipboard.writeText(text);
      $('feedback').textContent = src === 'say' ? '改写已复制' : '原话已复制';
    } catch {
      const range = document.createRange();
      range.selectNodeContents($(src));
      getSelection().removeAllRanges(); getSelection().addRange(range);
      $('feedback').textContent = '已选中，可按 Ctrl+C';
    }
  };
}

/* ── 四屏显隐 ───────────────────────────────────────────── */
const SCREENS = [
  {el: $('s1'), in: [0, 0], out: [0.62, 1.0]},
  {el: $('s2'), in: [0.72, 1.05], out: [2.62, 2.88]},
  {el: $('s3'), in: [2.78, 3.0], out: [3.72, 3.96]},
  {el: $('s4'), in: [3.86, 4.08], out: [9, 9]},
];
function layoutScreens(p) {
  let active = 0;
  SCREENS.forEach((s, i) => {
    const a = (s.in[1] > s.in[0] ? smooth(p, s.in[0], s.in[1]) : 1)
            * (1 - (s.out[1] > s.out[0] ? smooth(p, s.out[0], s.out[1]) : 0));
    s.el.style.opacity = a.toFixed(3);
    s.el.classList.toggle('on', a > 0.5);
    if (a > 0.5) active = i;
  });
  [...$('ticks').children].forEach((d, i) => d.classList.toggle('on', i === active));

  /* 控制条按屏浮现：每组只在它真正起作用的那一屏出现。
     形变滑杆属于第 2 屏，塌陷重播属于第 3 屏；
     之前两个按钮常驻，但「播放塌陷」在前两屏点了没有任何可见反馈。 */
  $('grpMorph').classList.toggle('off', !(p > 0.8 && p < 2.75));
  $('grpPlay').classList.toggle('off', !(p > 2.85 && p < 3.85));
  return active;
}

/* ── 主循环 ─────────────────────────────────────────────── */
/* 塌陷进度：优先跟随滚动（滑进第 3 屏时逐步浮现），
   手动点「重播」则切到计时器驱动，直到下次滚动再交还给滚动。 */
let scrubbing = true;   // true = 由滚动驱动
function frame(now) {
  const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0.016;
  lastFrame = now;

  const p = scrollY / innerHeight;
  const urlM = debugMorph(location.search);
  const m = forcedM !== null ? forcedM : (urlM !== null ? urlM : morphAmount(p));

  if (!isFrozen(m)) simTime += dt * (1 - m);
  advance(simTime);

  const t = cameraTarget(m, 0.27, 0.52);
  const k = 1 - Math.exp(-dt / 0.14);
  cam.yaw = lerp(cam.yaw, t.yaw, k);
  cam.tilt = lerp(cam.tilt, t.tilt, k);
  cam.roll = lerp(cam.roll, t.roll, k);
  cam.zoom = lerp(cam.zoom, lerp(0.52, structZoom, m), k);
  cam.offset = lerp(cam.offset, 0.1 * (1 - m), k);

  const active = layoutScreens(p);

  /* 塌陷随滚动逐步浮现：p 从 2.80 到 3.35 之间，把整条塌陷时间线铺开。
     这样滑进第 3 屏时能看见"每灭一颗，数字涨一点"，
     而不是进屏后触发一次与滚动无关的定时动画。 */
  if (scrubbing) {
    const q = smooth(p, 2.80, 3.35);
    collapseT = q <= 0 ? -1 : q * COLLAPSE_END;
    updateBill();
  } else if (collapseT >= 0 && collapseT < COLLAPSE_END) {
    collapseT += dt;
    updateBill();
  }

  draw(m, discOpacity(p));
  $('mval').textContent = m.toFixed(2);
  if (document.activeElement !== $('m')) $('m').value = m;
  $('stage').innerHTML = m < 0.08
    ? '每颗星是他的一条判断。亮度、大小、星芒都等于<b>它撑着多少条</b>——所以少数几颗特别亮，那是承重墙。'
    : m > 0.92
      ? '同一批判断，换个看法：<b>地基在下，依赖向上</b>。现在能看见哪几根抽掉会塌一片。'
      : '正在形变：一片星空正在变成<b>一栋楼</b>。';
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ── 交互 ───────────────────────────────────────────────── */
$('m').addEventListener('input', e => { forcedM = Number(e.target.value); });
addEventListener('scroll', () => { forcedM = null; scrubbing = true; }, {passive: true});
$('play').onclick = () => { scrubbing = false; collapseT = 0; updateBill(); };
$('reset').onclick = () => { scrubbing = false; collapseT = -1; updateBill(); };
[...$('ticks').children].forEach(d => {
  d.onclick = () => { forcedM = null; scrollTo({top: Number(d.dataset.p) * innerHeight, behavior: 'smooth'}); };
});

const tip = $('tip');
addEventListener('pointermove', e => {
  let best = null, bestD = Infinity;
  for (const [id, pos] of screenPos) {
    const d = Math.hypot(pos.sx - e.clientX, pos.sy - e.clientY);
    if (d < Math.max(14, pos.r + 9) && d < bestD) { bestD = d; best = id; }
  }
  hoverId = best;
  if (!best) { tip.style.opacity = '0'; return; }
  const n = byId.get(best);
  const solo = collapseAfter(new Set([best]), graph).size - 1;
  tip.innerHTML = `<b>${n.name}</b>${n.text}<s>承重 ${n.S} · 单独拆掉它会连带塌 ${solo} 条`
    + `${finalDead.has(best) ? ` · 属于这次塌陷的 ${finalDead.size} 条` : ''}`
    + `${aliveOf(best) < 0.5 ? ' · 已熄灭' : ''}</s>`;
  tip.style.transform = `translate(${Math.min(e.clientX + 16, innerWidth - 330)}px,`
    + `${Math.min(e.clientY + 14, innerHeight - 150)}px)`;
  tip.style.opacity = '1';
});

updateBill();
console.log(`[demo] 节点 ${graph.length} · 边 ${graph.reduce((a, n) => a + n.deps.length, 0)}`
  + ` · 报价 ${priced.rate}% · 塌陷 ${finalDead.size}/${graph.length}`
  + ` · 波次 ${waves.map(w => w.length).join('+')} · 承重墙 ${walls.length}`);
