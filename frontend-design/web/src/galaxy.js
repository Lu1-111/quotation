/* Mind Galaxy —— 30 条判断的三维星图
   自研透视投影，不依赖 three.js。
   - 先按信念区和依赖深度撒点，再做少量力导向松弛
   - WASD / 拖动转视角 / 点击节点
   - 手机端：单指拖动转视角，点击节点
*/

import { graph } from "./quotation-case.js";

const TAU = Math.PI * 2;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

const CLUSTERS = {
  1: { name: "推荐确实拓宽过我", color: [255, 210, 122] },
  2: { name: "选择权", color: [150, 190, 255] },
  3: { name: "怎样才算数", color: [170, 225, 205] },
  4: { name: "从别人那里听见", color: [255, 190, 160] },
};

/* 四个信念区在三维空间里的锚点 */
const CENTERS = {
  1: { x: -210, y: 120, z: 80 },
  2: { x: 230, y: 70, z: 160 },
  3: { x: 70, y: -170, z: -190 },
  4: { x: -230, y: -80, z: -170 },
};

const HOME = { x: 0, y: 30, z: 820, yaw: 0, pitch: -0.05 };
const FOV = (55 * Math.PI) / 180;
const NEAR = 8;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}

/* ---------- 布局：簇内按依赖深度铺开，再做一次轻量松弛 ---------- */
function layout() {
  const nodes = graph.map((n) => ({ ...n, deps: n.deps.slice() }));

  for (const n of nodes) {
    const c = CENTERS[n.cluster] || { x: 0, y: 0, z: 0 };
    const rng = mulberry32(hashString(n.id));
    const angle = rng() * TAU;
    const depth = (n.d || 0) * 34 + rng() * 46 + 18;
    n.pos = {
      x: c.x + Math.cos(angle) * depth,
      y: c.y + (rng() - 0.5) * 90 + (n.d || 0) * 5,
      z: c.z + Math.sin(angle) * depth,
    };
    n.vel = { x: 0, y: 0, z: 0 };
  }

  const index = new Map(nodes.map((n, i) => [n.id, i]));

  for (let iter = 0; iter < 160; iter++) {
    const fx = new Float32Array(nodes.length);
    const fy = new Float32Array(nodes.length);
    const fz = new Float32Array(nodes.length);

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[i].pos.x - nodes[j].pos.x;
        let dy = nodes[i].pos.y - nodes[j].pos.y;
        let dz = nodes[i].pos.z - nodes[j].pos.z;
        const d2 = dx * dx + dy * dy + dz * dz + 220;
        const f = 5600 / d2;
        const inv = 1 / Math.sqrt(d2);
        dx *= inv;
        dy *= inv;
        dz *= inv;
        fx[i] += dx * f;
        fy[i] += dy * f;
        fz[i] += dz * f;
        fx[j] -= dx * f;
        fy[j] -= dy * f;
        fz[j] -= dz * f;
      }
    }

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      for (const dep of n.deps) {
        const j = index.get(dep);
        if (j == null) continue;
        let dx = nodes[j].pos.x - n.pos.x;
        let dy = nodes[j].pos.y - n.pos.y;
        let dz = nodes[j].pos.z - n.pos.z;
        const d = Math.hypot(dx, dy, dz) || 1;
        const f = (d - 92) * 0.012;
        dx /= d;
        dy /= d;
        dz /= d;
        fx[i] += dx * f;
        fy[i] += dy * f;
        fz[i] += dz * f;
        fx[j] -= dx * f;
        fy[j] -= dy * f;
        fz[j] -= dz * f;
      }
    }

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const c = CENTERS[n.cluster] || { x: 0, y: 0, z: 0 };
      fx[i] += (c.x - n.pos.x) * 0.0026;
      fy[i] += (c.y - n.pos.y) * 0.0026;
      fz[i] += (c.z - n.pos.z) * 0.0026;
      fx[i] -= n.pos.x * 0.0004;
      fy[i] -= n.pos.y * 0.0004;
      fz[i] -= n.pos.z * 0.0004;
    }

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      n.vel.x = (n.vel.x + fx[i]) * 0.82;
      n.vel.y = (n.vel.y + fy[i]) * 0.82;
      n.vel.z = (n.vel.z + fz[i]) * 0.82;
      n.pos.x += n.vel.x;
      n.pos.y += n.vel.y;
      n.pos.z += n.vel.z;
    }
  }

  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const n of nodes) {
    cx += n.pos.x;
    cy += n.pos.y;
    cz += n.pos.z;
  }
  cx /= nodes.length;
  cy /= nodes.length;
  cz /= nodes.length;

  let maxR = 1;
  for (const n of nodes) {
    n.pos.x -= cx;
    n.pos.y -= cy;
    n.pos.z -= cz;
    maxR = Math.max(maxR, Math.hypot(n.pos.x, n.pos.y, n.pos.z));
  }

  const scale = 400 / maxR;
  for (const n of nodes) {
    n.pos.x *= scale;
    n.pos.y *= scale;
    n.pos.z *= scale;
    delete n.vel;
  }

  const clusterCenters = {};
  for (const n of nodes) {
    const c = (clusterCenters[n.cluster] ||= { x: 0, y: 0, z: 0, count: 0 });
    c.x += n.pos.x;
    c.y += n.pos.y;
    c.z += n.pos.z;
    c.count++;
  }
  for (const c of Object.values(clusterCenters)) {
    c.x /= c.count;
    c.y /= c.count;
    c.z /= c.count;
  }

  const dependents = new Map(nodes.map((n) => [n.id, []]));
  for (const n of nodes) {
    for (const dep of n.deps) {
      const list = dependents.get(dep);
      if (list) list.push(n);
    }
  }

  return { nodes, clusterCenters, dependents };
}

/* ---------- 辉光贴图 ---------- */
function makeGlow(color, size = 64) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2
  );
  grad.addColorStop(0, `rgba(${color[0]},${color[1]},${color[2]},.95)`);
  grad.addColorStop(0.22, `rgba(${color[0]},${color[1]},${color[2]},.38)`);
  grad.addColorStop(0.6, `rgba(${color[0]},${color[1]},${color[2]},.08)`);
  grad.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

function makeStars(count) {
  const rng = mulberry32(20261122);
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = 700 + rng() * 2400;
    const theta = rng() * TAU;
    const phi = Math.acos(2 * rng() - 1);
    out.push({
      x: r * Math.sin(phi) * Math.cos(theta),
      y: r * Math.cos(phi) * 0.62,
      z: r * Math.sin(phi) * Math.sin(theta),
      a: 0.12 + rng() * 0.5,
      s: rng() < 0.07 ? 1.8 : rng() < 0.4 ? 1.15 : 0.8,
      gold: rng() < 0.12,
      phase: rng() * TAU,
      speed: 0.54 + rng() * 1.86,
      sparkle: rng() < 0.03,
    });
  }
  return out;
}

/* 盘状星尘，给星图一点银河的厚度 */
function makeDust(count) {
  const rng = mulberry32(20261123);
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = 60 + Math.pow(rng(), 0.7) * 760;
    const theta = rng() * TAU;
    out.push({
      x: Math.cos(theta) * r,
      y: (rng() - 0.5) * (70 + r * 0.12),
      z: Math.sin(theta) * r,
      a: 0.06 + rng() * 0.22,
      s: 0.6 + rng() * 0.9,
      gold: rng() < 0.2,
      phase: rng() * TAU,
      speed: 0.36 + rng() * 1.02,
    });
  }
  return out;
}

/* ---------- 主入口 ---------- */
export function createGalaxy({ canvas, card, cardCluster, cardName, cardText, cardMeta, cardClose, hint }) {
  const ctx = canvas.getContext("2d");
  const { nodes, clusterCenters, dependents } = layout();
  for (const n of nodes) {
    const rng = mulberry32(hashString(n.id) ^ 0x9e3779b9);
    n.tw = { phase: rng() * TAU, speed: 0.84 + rng() * 1.56 };
  }
  const stars = makeStars(1300);
  const dust = makeDust(340);
  const sprites = {
    1: makeGlow(CLUSTERS[1].color),
    2: makeGlow(CLUSTERS[2].color),
    3: makeGlow(CLUSTERS[3].color),
    4: makeGlow(CLUSTERS[4].color),
    white: makeGlow([232, 238, 248]),
    gold: makeGlow([255, 210, 122]),
  };

  const camera = { ...HOME };
  const keys = new Set();
  let W = 0;
  let H = 0;
  let focal = 1;
  let running = false;
  let raf = 0;
  let last = 0;
  let selected = null;
  let hovered = null;
  let projected = [];
  let dragging = false;
  let pointerId = null;
  let downX = 0;
  let downY = 0;
  let downAt = 0;
  let moved = 0;
  let hintTimer = 0;

  /* 屏幕投影 */
  function project(x, y, z) {
    const dx = x - camera.x;
    const dy = y - camera.y;
    const dz = z - camera.z;
    const cy = Math.cos(camera.yaw);
    const sy = Math.sin(camera.yaw);
    const x1 = dx * cy - dz * sy;
    const z1 = dx * sy + dz * cy;
    const cp = Math.cos(camera.pitch);
    const sp = Math.sin(camera.pitch);
    const y2 = dy * cp + z1 * sp;
    const z2 = -dy * sp + z1 * cp;
    if (z2 > -NEAR) return null;
    const inv = focal / -z2;
    return {
      x: W / 2 + x1 * inv,
      y: H / 2 - y2 * inv,
      z: z2,
      scale: inv,
    };
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth || window.innerWidth;
    H = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    focal = H / 2 / Math.tan(FOV / 2);
  }

  function depthAlpha(z, base) {
    return clamp(base * (700 / Math.max(200, -z)), 0.04, base);
  }

  function isRelated(n, focus) {
    if (!focus) return false;
    return (
      n.id === focus.id ||
      n.deps.includes(focus.id) ||
      focus.deps.includes(n.id)
    );
  }

  function drawBackground() {
    const grad = ctx.createRadialGradient(
      W / 2, H / 2, 0,
      W / 2, H / 2, Math.max(W, H) * 0.78
    );
    grad.addColorStop(0, "#0a0d16");
    grad.addColorStop(0.55, "#07080f");
    grad.addColorStop(1, "#04050a");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  function drawNebula(t = 0) {
    ctx.globalCompositeOperation = "lighter";
    const breath = 0.5 + 0.5 * Math.sin(t * 1.2);
    const scaleBreath = 0.5 + 0.5 * Math.sin(t * 0.8);
    const scaleB = 0.988 + 0.024 * scaleBreath;

    for (const [cid, c] of Object.entries(clusterCenters)) {
      const p = project(c.x * scaleB, c.y * scaleB, c.z * scaleB);
      if (!p) continue;
      const color = CLUSTERS[cid]?.color || [255, 210, 122];
      const local = 0.5 + 0.5 * Math.sin(t * 0.6 + Number(cid) * 1.7);
      const k = 0.56 + 0.44 * (0.6 * local + 0.4 * breath);
      const r = clamp(300 * p.scale, 60, H * 0.9) * (0.94 + 0.06 * breath);
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      grad.addColorStop(
        0,
        `rgba(${color[0]},${color[1]},${color[2]},${(0.085 * k).toFixed(3)})`
      );
      grad.addColorStop(
        0.45,
        `rgba(${color[0]},${color[1]},${color[2]},${(0.03 * k).toFixed(3)})`
      );
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fill();
    }

    const core = project(0, 0, 0);
    if (core) {
      const coreK = 0.44 + 0.56 * breath;
      const r = clamp(340 * core.scale, 60, H) * (0.92 + 0.08 * breath);
      const grad = ctx.createRadialGradient(core.x, core.y, 0, core.x, core.y, r);
      grad.addColorStop(
        0,
        `rgba(210,225,255,${(0.05 * coreK).toFixed(3)})`
      );
      grad.addColorStop(
        0.5,
        `rgba(160,190,230,${(0.018 * coreK).toFixed(3)})`
      );
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(core.x, core.y, r, 0, TAU);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function drawStars(t = 0) {
    ctx.globalCompositeOperation = "lighter";

    /* 星尘盘缓慢自转，像银河在呼吸 */
    const rot = t * 0.036;
    const rc = Math.cos(rot);
    const rs = Math.sin(rot);

    for (const d of dust) {
      const p = project(d.x * rc - d.z * rs, d.y, d.x * rs + d.z * rc);
      if (!p) continue;
      const tw = 0.56 + 0.44 * Math.sin(t * d.speed + d.phase);
      ctx.globalAlpha = d.a * tw * clamp(p.scale * 1.2, 0.25, 1);
      ctx.fillStyle = d.gold
        ? "rgba(255,210,122,1)"
        : "rgba(198,214,240,1)";
      ctx.fillRect(p.x, p.y, d.s, d.s);
    }

    for (const star of stars) {
      const p = project(star.x, star.y, star.z);
      if (!p) continue;
      const s = Math.sin(t * star.speed + star.phase);
      const tw = 0.4 + 0.6 * s;
      ctx.globalAlpha = star.a * tw * clamp(p.scale * 1.4, 0.25, 1);
      ctx.fillStyle = star.gold
        ? "rgba(255,210,122,1)"
        : "rgba(226,236,255,1)";
      ctx.fillRect(p.x, p.y, star.s, star.s);

      /* 少量星星偶尔闪一下四角星芒 */
      if (star.sparkle && s > 0.76) {
        const a = ((s - 0.76) / 0.24) * 0.55;
        const len = 3 + star.s * 3;
        ctx.globalAlpha = 1;
        ctx.strokeStyle = `rgba(255,240,214,${a.toFixed(3)})`;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(p.x - len, p.y);
        ctx.lineTo(p.x + len, p.y);
        ctx.moveTo(p.x, p.y - len);
        ctx.lineTo(p.x, p.y + len);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  function drawScene(t = 0) {
    drawBackground();
    drawNebula(t);
    drawStars(t);

    const breath = 0.5 + 0.5 * Math.sin(t * 1.2);
    const scaleBreath = 0.5 + 0.5 * Math.sin(t * 0.8);
    const breathScale = 0.988 + 0.024 * scaleBreath;

    projected = [];
    for (const n of nodes) {
      const p = project(
        n.pos.x * breathScale,
        n.pos.y * breathScale,
        n.pos.z * breathScale
      );
      if (p) projected.push({ n, ...p });
    }

    const focus = selected || hovered;

    /* 普通连线 */
    ctx.globalCompositeOperation = "lighter";
    for (const item of projected) {
      const n = item.n;
      for (const dep of n.deps) {
        const target = projected.find((q) => q.n.id === dep);
        if (!target) continue;
        const related = isRelated(n, focus) || isRelated(target.n, focus);
        if (related) continue;
        const tw = n.tw
          ? 0.64 + 0.36 * Math.sin(t * n.tw.speed + n.tw.phase)
          : 1;
        const alpha = depthAlpha(Math.min(item.z, target.z), 0.16) * tw;
        ctx.strokeStyle = `rgba(168,188,220,${alpha.toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(item.x, item.y);
        ctx.lineTo(target.x, target.y);
        ctx.stroke();
      }
    }

    /* 高亮连线 */
    if (focus) {
      for (const item of projected) {
        const n = item.n;
        for (const dep of n.deps) {
          const target = projected.find((q) => q.n.id === dep);
          if (!target) continue;
          if (!isRelated(n, focus) && !isRelated(target.n, focus)) continue;
          ctx.strokeStyle = "rgba(255,210,122,.55)";
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(item.x, item.y);
          ctx.lineTo(target.x, target.y);
          ctx.stroke();
        }
      }
    }
    ctx.globalCompositeOperation = "source-over";

    /* 节点：远处先画 */
    projected.sort((a, b) => a.z - b.z);

    for (const item of projected) {
      const n = item.n;
      const color = CLUSTERS[n.cluster]?.color || [232, 238, 248];
      const base = (2.2 + n.S * 0.5) * item.scale;
      const r = clamp(base, 1.5, 15);
      const glowR = clamp(r * 5.2, 12, 150);
      const dim = focus && !isRelated(n, focus) ? 0.35 : 1;
      const alpha = depthAlpha(item.z, 0.95) * dim;
      const local = n.tw
        ? 0.5 + 0.5 * Math.sin(t * n.tw.speed + n.tw.phase)
        : 0.5;
      const steady = n === selected || n === hovered;
      const pulse = steady
        ? 1
        : n.S >= 10
          ? 0.44 + 0.56 * local
          : 0.68 + 0.32 * local;
      const glowA = alpha * pulse * (0.88 + 0.12 * breath);
      const glowSize = glowR * (0.92 + 0.08 * local);

      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = glowA;
      const sprite = sprites[n.cluster] || sprites.white;
      ctx.drawImage(
        sprite,
        item.x - glowSize,
        item.y - glowSize,
        glowSize * 2,
        glowSize * 2
      );

      /* 高承重节点加一点星芒 */
      if (n.S >= 10) {
        ctx.strokeStyle = `rgba(255,210,122,${(0.34 * alpha * pulse).toFixed(3)})`;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(item.x - r * 2.6, item.y);
        ctx.lineTo(item.x + r * 2.6, item.y);
        ctx.moveTo(item.x, item.y - r * 2.6);
        ctx.lineTo(item.x, item.y + r * 2.6);
        ctx.stroke();
      }

      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = `rgba(255,255,255,${(
        0.9 * alpha * (steady ? 1 : 0.9 + 0.1 * local)
      ).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(item.x, item.y, Math.max(0.7, r * 0.44), 0, TAU);
      ctx.fill();

      if (n === selected || n === hovered) {
        ctx.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},.85)`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(item.x, item.y, r + 5, 0, TAU);
        ctx.stroke();
      }

      /* 高承重节点常驻名字；悬停/选中时高亮 */
      const showLabel =
        n === selected || n === hovered || (n.S >= 10 && W > 640);
      if (showLabel) {
        ctx.font = '11px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.textAlign = "center";
        ctx.fillStyle =
          n === selected || n === hovered
            ? "rgba(255,210,122,.95)"
            : `rgba(232,236,244,${(0.4 * alpha).toFixed(3)})`;
        ctx.fillText(n.name, item.x, item.y + r + 14);
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ---------- 相机 ---------- */
  function updateCamera(dt) {
    let f = 0;
    let r = 0;
    if (keys.has("w") || keys.has("arrowup")) f += 1;
    if (keys.has("s") || keys.has("arrowdown")) f -= 1;
    if (keys.has("d") || keys.has("arrowright")) r += 1;
    if (keys.has("a") || keys.has("arrowleft")) r -= 1;
    if (!f && !r) return;

    const speed = (keys.has("shift") ? 640 : 270) * dt;
    const cp = Math.cos(camera.pitch);
    const sp = Math.sin(camera.pitch);
    const cy = Math.cos(camera.yaw);
    const sy = Math.sin(camera.yaw);

    const fx = -sy * cp;
    const fy = sp;
    const fz = -cy * cp;
    const rx = cy;
    const rz = -sy;

    camera.x = clamp(camera.x + (fx * f + rx * r) * speed, -2000, 2000);
    camera.y = clamp(camera.y + fy * f * speed, -1200, 1200);
    camera.z = clamp(camera.z + (fz * f + rz * r) * speed, -2000, 2000);
  }

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    updateCamera(dt);
    drawScene(reduceMotion.matches ? 0 : now / 1000);
    raf = requestAnimationFrame(frame);
  }

  /* ---------- 节点卡片 ---------- */
  function selectNode(n) {
    selected = n;
    card.hidden = false;
    cardCluster.textContent = `信念区 ${n.cluster} · ${CLUSTERS[n.cluster]?.name || ""}`;
    cardName.textContent = n.name;
    cardText.textContent = `「${n.text}」`;
    cardMeta.textContent =
      `承重 ${n.S} · 依赖 ${n.deps.length} 条 · 支撑 ${(dependents.get(n.id) || []).length} 条`;
  }

  function clearSelection() {
    selected = null;
    card.hidden = true;
  }

  function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = null;
    let bestD = Infinity;
    for (const item of projected) {
      const d = Math.hypot(item.x - x, item.y - y);
      const radius = Math.max(14, clamp((2.2 + item.n.S * 0.5) * item.scale, 1.5, 15) + 9);
      if (d < radius && d < bestD) {
        best = item.n;
        bestD = d;
      }
    }
    return best;
  }

  /* ---------- 交互 ---------- */
  function onPointerDown(e) {
    if (!running || e.button !== 0) return;
    dragging = true;
    pointerId = e.pointerId;
    downX = e.clientX;
    downY = e.clientY;
    downAt = performance.now();
    moved = 0;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  }

  function onPointerMove(e) {
    if (!running) return;
    if (dragging && e.pointerId === pointerId) {
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      if (dx || dy) {
        camera.yaw -= dx * 0.0032;
        camera.pitch = clamp(camera.pitch - dy * 0.0028, -1.4, 1.4);
        downX = e.clientX;
        downY = e.clientY;
        moved += Math.abs(dx) + Math.abs(dy);
      }
      return;
    }
    hovered = pick(e.clientX, e.clientY);
    canvas.style.cursor = hovered ? "pointer" : "grab";
  }

  function onPointerUp(e) {
    if (!running || e.pointerId !== pointerId) return;
    const wasDragging = dragging;
    dragging = false;
    pointerId = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (err) {}

    if (wasDragging && moved < 6 && performance.now() - downAt < 500) {
      const n = pick(e.clientX, e.clientY);
      if (n) selectNode(n);
      else clearSelection();
    }
    canvas.style.cursor = hovered ? "pointer" : "grab";
  }

  function onPointerLeave() {
    if (!dragging) {
      hovered = null;
      canvas.style.cursor = "grab";
    }
  }

  function isTyping(e) {
    const t = e.target;
    return (
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.isContentEditable)
    );
  }

  function onKeyDown(e) {
    if (!running || isTyping(e)) return;
    const k = e.key.toLowerCase();
    if (
      k === "w" || k === "a" || k === "s" || k === "d" ||
      k === "arrowup" || k === "arrowdown" || k === "arrowleft" || k === "arrowright" ||
      k === "shift"
    ) {
      keys.add(k);
      if (k.startsWith("arrow")) e.preventDefault();
    }
  }

  function onKeyUp(e) {
    keys.delete(e.key.toLowerCase());
  }

  function onKeyDownCapture(e) {
    if (!running) return;
    if (e.key === "Escape" && selected) {
      clearSelection();
      e.stopPropagation();
    }
  }

  function onResize() {
    resize();
  }

  function onBlur() {
    keys.clear();
    dragging = false;
    pointerId = null;
  }

  /* ---------- 生命周期 ---------- */
  function getHome() {
    const vHalf = FOV / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * (W / Math.max(1, H)));
    const minHalf = Math.min(vHalf, hHalf);
    const fit = W / Math.max(1, H) < 1 ? 1.05 : 1.08;
    const z = clamp((420 / Math.tan(minHalf)) * fit, 780, 2600);
    return { ...HOME, z };
  }

  function start() {
    if (running) return;
    running = true;
    resize();
    Object.assign(camera, getHome());
    clearSelection();
    keys.clear();
    hinted(false);
    last = performance.now();
    raf = requestAnimationFrame(frame);
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hinted(true), 9000);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    keys.clear();
    dragging = false;
    pointerId = null;
    clearSelection();
    clearTimeout(hintTimer);
    hinted(false);
  }

  function hinted(dim) {
    if (!hint) return;
    hint.classList.toggle("dim", dim);
  }

  function reset() {
    Object.assign(camera, getHome());
    clearSelection();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("keydown", onKeyDownCapture, true);
  window.addEventListener("resize", onResize);
  window.addEventListener("blur", onBlur);
  cardClose.addEventListener("click", clearSelection);

  if (new URLSearchParams(location.search).has("debug")) {
    window.__galaxy = {
      nodes,
      camera,
      project,
      get projected() {
        return projected;
      },
    };
  }

  return { start, stop, reset };
}
