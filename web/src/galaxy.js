/* 真星系渲染：三层分离 + 加性混合 + 差速自转 + 视差
   A 数据层（217 个判断，亮度=承重，不视差，刚性旋转）
   B 星尘层（3800，只管好看，带视差，差速自转）
   C 大气层（核球 / 尘埃带 / 暗角 / 颗粒）  */

const DUST = 3800;
const FAR = 220;
const R_IN = 13;                      // 螺距角
const INCL = Math.cos(28 * Math.PI / 180); // 0.88
const ROLL = -8 * Math.PI / 180;

const GOLD = [255, 210, 122];
const RED = [214, 74, 50];
const WHITE = [255, 255, 255];

/* 确定性随机 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/* 64×64 径向光斑，按色温预生成 */
function sprite(rgb) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0.00, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`);
  grad.addColorStop(0.18, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.55)`);
  grad.addColorStop(0.45, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.12)`);
  grad.addColorStop(1.00, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}

export function createGalaxy(canvas, nodes, opts = {}) {
  const sp = { gold: sprite(GOLD), red: sprite(RED), white: sprite(WHITE) };
  const grain = grainTile();
  const rand = rng(0x5eed2026);

  let W = 1, H = 1, R = 1, dpr = 1;
  let ctx = canvas.getContext("2d", { alpha: false });
  let cam = { s: 1, tx: 0, ty: 0, o: 1 };
  let spin = 0;                 // A 层刚性转角
  let dust = [], far = [], data = [];
  let mark = null;
  let last = 0, raf = 0, reduced = false;

  reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- 布局 ---------- */
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.min(3840, Math.round(W * dpr));
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    R = Math.min(W, H) * 0.46;

    buildFar();
    buildDust();
    buildData();
  }

  function toPlane(r, th) {
    // 对数螺旋 + 倾角压扁 + 整体滚转
    const x0 = r * Math.cos(th);
    const y0 = r * Math.sin(th) * INCL;
    return [
      x0 * Math.cos(ROLL) - y0 * Math.sin(ROLL),
      x0 * Math.sin(ROLL) + y0 * Math.cos(ROLL),
    ];
  }

  function buildFar() {
    far = [];
    for (let i = 0; i < FAR; i++) {
      far.push({
        x: rand() * W,
        y: rand() * H,
        r: 0.5 + rand() * 1.1,
        a: 0.08 + rand() * 0.10,
      });
    }
  }

  function buildDust() {
    dust = [];
    const armWidth = (r) => 0.06 + 0.16 * r;
    for (let i = 0; i < DUST; i++) {
      // 指数盘 + 双旋臂加权
      let r = -Math.log(1 - rand() * 0.985) * 0.42;
      if (r > 1.15) r = 1.15 - rand() * 0.1;
      const arm = i % 2;
      const base = Math.log(Math.max(r, 0.02) / 0.06) / Math.tan(R_IN * Math.PI / 180);
      const spread = (rand() + rand() + rand() - 1.5) * armWidth(r) * 3.6;
      const th = base + arm * Math.PI + spread;
      const [x, y] = toPlane(r * R, th);
      dust.push({
        x, y,
        r: 0.45 + Math.pow(rand(), 2.6) * 1.15,
        z: rand(),
        a: 0.12 + rand() * 0.5,
        base: th,
        rr: r,
      });
    }
    // 臂上的年轻星团：最亮的东西不在核心
    for (let c = 0; c < 8; c++) {
      const r = 0.35 + rand() * 0.55;
      const th = Math.log(Math.max(r, 0.02) / 0.06) / Math.tan(R_IN * Math.PI / 180) + (c % 2) * Math.PI + (rand() - 0.5) * 0.2;
      const [x, y] = toPlane(r * R, th);
      for (let k = 0; k < 26; k++) {
        dust.push({
          x: x + (rand() - 0.5) * 26,
          y: y + (rand() - 0.5) * 26 * INCL,
          r: 0.9 + rand() * 1.2,
          z: 0.3 + rand() * 0.7,
          a: 0.26 + rand() * 0.24,
          base: th, rr: r,
        });
      }
    }
  }

  function buildData() {
    const sorted = nodes.slice().sort((a, b) => b.S - a.S);
    const n = sorted.length;
    data = sorted.map((node, i) => {
      // 越重越靠核心：亮度与半径同向，符合"质量集中在核球"
      const t = Math.pow(i / Math.max(1, n - 1), 0.72);
      const r = R * (0.05 + 0.92 * t);
      const arm = i % 2;
      const base = Math.log(Math.max(r / R, 0.02) / 0.06) / Math.tan(R_IN * Math.PI / 180);
      const th = base + arm * Math.PI + (rand() - 0.5) * 0.16;
      const [x, y] = toPlane(r, th);
      return {
        id: node.id,
        x, y,
        L: node.L,
        wall: !!node.wall,
        base: th,
        rr: r / R,
      };
    });
  }

  /* ---------- 每帧投影 ---------- */
  function place(p, parallax) {
    const cx = W / 2 + cam.tx;
    const cy = H / 2 + cam.ty;
    const k = parallax ? 0.60 + 0.80 * p.z : 1;
    return [
      cx + p.x * cam.s * k * 0.62,
      cy + p.y * cam.s * k * 0.62,
    ];
  }

  /* ---------- 绘制 ---------- */
  function draw(t, quiet) {
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 0.016;
    last = t;
    if (!reduced) spin += (0.35 * Math.PI / 180) * dt; // 刚性，整层一起转

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#07080F";
    ctx.fillRect(0, 0, W, H);

    // 远场星：无限远，无视差
    ctx.globalCompositeOperation = "lighter";
    for (const f of far) {
      ctx.globalAlpha = f.a;
      ctx.drawImage(sp.white, f.x - f.r, f.y - f.r, f.r * 2, f.r * 2);
    }

    drawAtmosphere(true);
    drawArms();

    // B 星尘
    const cs = Math.cos(spin), sn = Math.sin(spin);
    for (const d of dust) {
      const wx = d.x * cs - d.y * sn;
      const wy = d.x * sn + d.y * cs;
      const [x, y] = place({ x: wx, y: wy, z: d.z }, true);
      if (x < -40 || x > W + 40 || y < -40 || y > H + 40) continue;
      const a = d.a * (0.55 + 0.45 * d.z) * cam.o;
      const r = d.r * (0.7 + 0.5 * cam.s);
      ctx.globalAlpha = Math.min(1, a * 0.95);
      ctx.drawImage(sp.gold, x - r * 3.5, y - r * 3.5, r * 7, r * 7);
      ctx.globalAlpha = Math.min(1, a * 1.1);
      ctx.drawImage(sp.white, x - r * 0.7, y - r * 0.7, r * 1.4, r * 1.4);
    }

    // A 数据层：三档辉光，不视差，刚性跟随 spin
    for (const d of data) {
      const wx = d.x * cs - d.y * sn;
      const wy = d.x * sn + d.y * cs;
      const [x, y] = place({ x: wx, y: wy, z: 0 }, false);
      if (x < -60 || x > W + 60 || y < -60 || y > H + 60) continue;
      const L = d.L;
      const rad = (1.2 + 2.6 * Math.pow(L, 0.45)) * cam.s;
      const img = d.wall ? sp.red : sp.gold;
      const isMark = mark ? mark.has(d.id) : false;
      const dk = mark ? (isMark ? 1 : 0.40) : 1;
      ctx.globalAlpha = Math.min(1, (0.10 + 0.16 * L) * cam.o * dk);
      ctx.drawImage(img, x - rad * 10, y - rad * 10, rad * 20, rad * 20);
      ctx.globalAlpha = Math.min(1, (0.3 + 0.35 * L) * cam.o * dk);
      ctx.drawImage(img, x - rad * 4, y - rad * 4, rad * 8, rad * 8);
      ctx.globalAlpha = Math.min(1, cam.o * dk);
      ctx.drawImage(sp.white, x - rad * 0.9, y - rad * 0.9, rad * 1.8, rad * 1.8);
      if (isMark) {
        ctx.globalAlpha = Math.min(1, cam.o);
        ctx.strokeStyle = "rgba(214,74,50,0.95)";
        ctx.lineWidth = Math.max(1, 1.15 * cam.s);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(7, rad * 2.8), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    drawAtmosphere(false);
    drawDustLane();
    if (!quiet) drawGrain();
  }

  function drawAtmosphere(first) {
    const cx = W / 2 + cam.tx;
    const cy = H / 2 + cam.ty;
    const rr = R * 0.30 * cam.s * 0.62;

    if (first) {
      // 核球：软径向渐变，中心烧白
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr * 3.4);
      g.addColorStop(0.00, "rgba(255,246,228,0.70)");
      g.addColorStop(0.10, "rgba(255,240,210,0.55)");
      g.addColorStop(0.26, "rgba(255,216,142,0.26)");
      g.addColorStop(0.52, "rgba(255,205,120,0.055)");
      g.addColorStop(0.78, "rgba(255,200,115,0.014)");
      g.addColorStop(1.00, "rgba(255,200,115,0)");
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, rr * 3.4, 0, Math.PI * 2);
      ctx.fill();

      // 核心过曝：一小团纯白，往外才回落成金
      const hot = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr * 0.62);
      hot.addColorStop(0.00, "rgba(255,255,255,1)");
      hot.addColorStop(0.35, "rgba(255,255,255,0.92)");
      hot.addColorStop(0.70, "rgba(255,250,240,0.38)");
      hot.addColorStop(1.00, "rgba(255,250,240,0)");
      ctx.fillStyle = hot;
      ctx.beginPath();
      ctx.arc(cx, cy, rr * 0.62, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // 臂间暖色气带：极淡、无硬边
      const g2 = ctx.createRadialGradient(cx, cy, rr * 1.2, cx, cy, R * 1.05 * cam.s * 0.62);
      g2.addColorStop(0, "rgba(255,210,122,0.07)");
      g2.addColorStop(0.6, "rgba(255,210,122,0.035)");
      g2.addColorStop(1, "rgba(255,210,122,0)");
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 1;
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.05 * cam.s * 0.62, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawArms() {
    const cx = W / 2 + cam.tx;
    const cy = H / 2 + cam.ty;
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255,206,130,1)";
    for (let arm = 0; arm < 2; arm++) {
      for (let pass = 0; pass < 3; pass++) {
        ctx.beginPath();
        for (let i = 0; i <= 64; i++) {
          const t = i / 64;
          const r = R * (0.09 + 0.98 * t);
          const th = Math.log(Math.max(r / R, 0.02) / 0.06) / Math.tan(R_IN * Math.PI / 180) + arm * Math.PI;
          const [x0, y0] = toPlane(r, th);
          const x = cx + x0 * cam.s * 0.62;
          const y = cy + y0 * cam.s * 0.62;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.globalAlpha = [0.085, 0.05, 0.026][pass] * cam.o;
        ctx.lineWidth = (24 + pass * 30) * cam.s * 0.62;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  function drawDustLane() {
    const cx = W / 2 + cam.tx;
    const cy = H / 2 + cam.ty;
    ctx.globalCompositeOperation = "source-over";
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(7,8,15,1)";
    const SEG = 64;
    for (let k = 0; k < 4; k++) {
      const off = -0.15 - k * 0.06;
      for (let i = 0; i < SEG; i++) {
        const t0 = i / SEG;
        const t1 = (i + 1) / SEG;
        // 两端淡出，避免在内圈形成一圈硬边
        const fade = Math.pow(Math.sin(Math.PI * Math.min(1, t0 * 1.06)), 1.3);
        ctx.globalAlpha = (0.30 - k * 0.055) * fade * cam.o * Math.min(1, 1.15 / Math.max(1, cam.s));
        if (ctx.globalAlpha < 0.008) continue;
        ctx.beginPath();
        for (let j = 0; j < 2; j++) {
          const t = j ? t1 : t0;
          const r = R * (0.12 + 0.92 * t) * cam.s * 0.62;
          const th = Math.log(Math.max(r / (R * cam.s * 0.62), 0.02) / 0.06) / Math.tan(R_IN * Math.PI / 180)
            + off + t * 0.9 + Math.sin(t * 11 + k * 2.1) * 0.05;
          const [x0, y0] = toPlane(r, th);
          const x = cx + x0;
          const y = cy + y0;
          j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.lineWidth = (5 + k * 3.5) * Math.min(cam.s, 1.5) * 0.62;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawGrain() {
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = 0.025;
    const g = ctx.createPattern(grain, "repeat");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    // 暗角 12%
    const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,0.12)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }

  /* ---------- 循环：30fps 上限，切后台停 ---------- */
  function loop(t) {
    raf = requestAnimationFrame(loop);
    if (document.hidden) return;
    if (t - (loop.last || 0) < 33) return;
    loop.last = t;
    draw(t);
  }

  function start() {
    if (!raf) raf = requestAnimationFrame(loop);
  }

  resize();
  window.addEventListener("resize", () => { resize(); if (!raf) draw(performance.now()); });
  document.addEventListener("visibilitychange", () => { last = 0; });

  return {
    start,
    /* 把同一张星系画进另一块画布（换说法页的两半用它，不是两份数据） */
    renderTo(target, c, quiet) {
      const saved = { ctx, cam, mark };
      if (marks !== undefined) mark = marks ? new Set(marks) : null;
      const g = target.getContext("2d", { alpha: false });
      if (target.width !== canvas.width || target.height !== canvas.height) {
        target.width = canvas.width;
        target.height = canvas.height;
      }
      ctx = g; cam = c;
      draw(performance.now(), quiet);
      ctx = saved.ctx; cam = saved.cam; mark = saved.mark;
    },
    draw: () => draw(performance.now()),
    resize,
    setMark(ids) { mark = ids ? new Set(ids) : null; draw(performance.now(), true); },
    setCamera(c) { cam = c; },
    /* 数据星在屏幕上的位置（供标签引线用） */
    project(id) {
      const d = data.find((n) => String(n.id) === String(id));
      if (!d) return null;
      const cs = Math.cos(spin), sn = Math.sin(spin);
      const [x, y] = place({ x: d.x * cs - d.y * sn, y: d.x * sn + d.y * cs, z: 0 }, false);
      return { x, y };
    },
  };
}

function grainTile() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const img = g.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}
