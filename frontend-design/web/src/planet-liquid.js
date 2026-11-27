/* 封面星球：鼠标轨迹形成的液态窗口，露出第二层星球
   - 轨迹沿鼠标实际路径生成柔软的液态缎带，边缘随时间起伏
   - 第二层图片只在轨迹内显示，并叠加球体明暗，保持立体感
   - 未加载第二层图片时使用程序生成的电影感地球兜底
   - 尊重 prefers-reduced-motion：不播放 */

const TRAIL_LIFE = 1.15; // 轨迹存活时间（秒）
const MIN_STEP = 2; // 采样最小间隔（px）

export function createLiquidPlanet(planet, canvas, imageUrl) {
  if (!planet || !canvas) return null;

  const ctx = canvas.getContext("2d");
  const mask = document.createElement("canvas");
  const mctx = mask.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const canFilter = "filter" in canvas.getContext("2d");

  const image = new Image();
  let imageReady = false;
  image.onload = () => {
    imageReady = true;
  };
  image.onerror = () => {
    imageReady = false;
  };
  image.src = imageUrl;

  let W = 0;
  let H = 0;
  let DPR = 1;
  let running = false;
  let raf = 0;
  let last = 0;
  let active = false;
  let rise = 0;
  let headSeen = 0;
  let pointer = { x: 0, y: 0 };
  let points = [];

  function resize() {
    const rect = planet.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    W = rect.width;
    H = rect.height;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    mask.width = canvas.width;
    mask.height = canvas.height;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    mctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    points = [];
    pointer = { x: W / 2, y: H / 2 };
  }

  const observer = new ResizeObserver(resize);
  observer.observe(planet);
  resize();

  function ensure() {
    if (running) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function localPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function onMove(event) {
    if (reduce.matches) return;
    const next = localPoint(event);
    const now = performance.now();
    if (!active) points = [];
    const prev = points[points.length - 1];
    if (!prev || Math.hypot(next.x - prev.x, next.y - prev.y) >= MIN_STEP) {
      points.push({ x: next.x, y: next.y, t: now });
      if (points.length > 260) points.shift();
    }
    pointer = next;
    headSeen = now;
    active = true;
    ensure();
  }

  function onLeave() {
    active = false;
    /* 离场也从这一刻开始，按轨迹自身寿命慢慢退场，不做加速淡出 */
    headSeen = performance.now();
    ensure();
  }

  planet.addEventListener("pointerenter", onMove);
  planet.addEventListener("pointermove", onMove);
  planet.addEventListener("pointerleave", onLeave);
  planet.addEventListener("pointercancel", onLeave);

  /* 电影感地球兜底纹理 */
  function drawFallback() {
    const ocean = ctx.createLinearGradient(0, 0, 0, H);
    ocean.addColorStop(0, "#0a2236");
    ocean.addColorStop(0.45, "#1c4f68");
    ocean.addColorStop(0.7, "#2f6f78");
    ocean.addColorStop(1, "#081827");
    ctx.fillStyle = ocean;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.filter = "blur(7px)";
    const lands = [
      [0.28, 0.38, 0.24, 0.17],
      [0.62, 0.58, 0.3, 0.2],
      [0.5, 0.22, 0.14, 0.1],
      [0.78, 0.35, 0.16, 0.12],
    ];
    ctx.fillStyle = "rgba(176,146,96,.55)";
    for (const [x, y, rx, ry] of lands) {
      ctx.beginPath();
      ctx.ellipse(W * x, H * y, W * rx, H * ry, 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(84,120,70,.5)";
    for (const [x, y, rx, ry] of lands) {
      ctx.beginPath();
      ctx.ellipse(
        W * (x + 0.02),
        H * (y + 0.02),
        W * rx * 0.7,
        H * ry * 0.7,
        0.4,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
    ctx.fillStyle = "rgba(255,255,255,.26)";
    for (let i = 0; i < 28; i++) {
      const x = (i * 0.137) % 1;
      const y = (i * 0.31) % 1;
      ctx.beginPath();
      ctx.ellipse(
        W * x,
        H * y,
        W * (0.05 + 0.04 * Math.sin(i)),
        H * 0.018,
        0.2,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
    ctx.restore();

    const term = ctx.createLinearGradient(W * 0.55, 0, W, 0);
    term.addColorStop(0, "rgba(255,210,122,0)");
    term.addColorStop(1, "rgba(255,180,90,.28)");
    ctx.fillStyle = term;
    ctx.fillRect(0, 0, W, H);
  }

  function drawSecondLayer() {
    if (imageReady) {
      const scale = Math.max(W / image.width, H / image.height);
      const dw = image.width * scale;
      const dh = image.height * scale;
      ctx.drawImage(image, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } else {
      drawFallback();
    }
  }

  /* 用二次曲线把一串点连成平滑路径 */
  function trace(list, move) {
    if (list.length === 1) {
      if (move) mctx.moveTo(list[0].x, list[0].y);
      else mctx.lineTo(list[0].x, list[0].y);
      return;
    }
    if (move) mctx.moveTo(list[0].x, list[0].y);
    else mctx.lineTo(list[0].x, list[0].y);
    for (let i = 1; i < list.length - 1; i++) {
      const mx = (list[i].x + list[i + 1].x) / 2;
      const my = (list[i].y + list[i + 1].y) / 2;
      mctx.quadraticCurveTo(list[i].x, list[i].y, mx, my);
    }
    const tail = list[list.length - 1];
    mctx.lineTo(tail.x, tail.y);
  }

  /* 沿鼠标路径生成液态缎带：宽度按寿命收窄，两侧边缘波长随时间流动 */
  function drawRibbon(baseHalf, now) {
    const pts = points;
    if (pts.length < 2) return;

    const t = now * 0.001;
    const left = [];
    const right = [];
    let cum = 0;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      let dx = next.x - prev.x;
      let dy = next.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;

      if (i > 0) cum += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);

      const age = Math.min(1, (now - p.t) / (TRAIL_LIFE * 1000));
      const s = 1 - age;
      const half = baseHalf * (0.1 + 0.82 * Math.sqrt(s));

      /* 两段不同频率的波叠加，边缘像被搅动的液体 */
      const wob =
        Math.sin(cum * 0.075 + t * 3.1) * half * 0.2 +
        Math.sin(cum * 0.031 - t * 2.2) * half * 0.12;

      const nx = -dy;
      const ny = dx;
      left.push({ x: p.x + nx * (half + wob), y: p.y + ny * (half + wob) });
      right.push({
        x: p.x - nx * (half - wob * 0.7),
        y: p.y - ny * (half - wob * 0.7),
      });
    }

    mctx.beginPath();
    trace(left, true);
    right.reverse();
    trace(right, false);
    mctx.closePath();
    mctx.fill();
  }

  /* 指针处的液滴：缓慢变形的圆，撑起轨迹的头部 */
  function drawHead(baseHalf, now) {
    const t = now * 0.001;
    const r = baseHalf * 1.02;
    const steps = 48;
    mctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const rr =
        r *
        (1 + 0.085 * Math.sin(a * 3 + t * 2.6) + 0.055 * Math.sin(a * 5 - t * 2.1));
      const x = pointer.x + Math.cos(a) * rr;
      const y = pointer.y + Math.sin(a) * rr;
      if (i === 0) mctx.moveTo(x, y);
      else mctx.lineTo(x, y);
    }
    mctx.closePath();
    mctx.fill();
  }

  function buildMask(headAlpha, now) {
    mctx.clearRect(0, 0, W, H);

    const baseHalf = Math.min(W, H) * 0.15;
    mctx.globalCompositeOperation = "source-over";
    mctx.fillStyle = "#fff";

    /* 轨迹按寿命自然收窄，不做整体加速淡出 */
    mctx.globalAlpha = 1;
    drawRibbon(baseHalf, now);

    mctx.globalAlpha = Math.min(1, Math.max(0, headAlpha));
    drawHead(baseHalf, now);

    mctx.globalAlpha = 1;
  }

  /* 只在露出的第二层上叠加球体明暗，保持星球立体感 */
  function shadeReveal() {
    ctx.globalCompositeOperation = "source-atop";

    const shade = ctx.createRadialGradient(
      W * 0.33,
      H * 0.27,
      0,
      W * 0.5,
      H * 0.52,
      W * 0.62
    );
    shade.addColorStop(0, "rgba(255,255,255,.14)");
    shade.addColorStop(0.45, "rgba(0,0,0,0)");
    shade.addColorStop(0.82, "rgba(15,24,38,.26)");
    shade.addColorStop(1, "rgba(8,14,24,.52)");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, W, H);

    const rim = ctx.createRadialGradient(
      W * 0.5,
      H * 0.5,
      W * 0.3,
      W * 0.5,
      H * 0.5,
      W * 0.52
    );
    rim.addColorStop(0, "rgba(255,210,122,0)");
    rim.addColorStop(1, "rgba(255,210,122,.24)");
    ctx.fillStyle = rim;
    ctx.fillRect(0, 0, W, H);

    ctx.globalCompositeOperation = "source-over";
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;

    if (active) rise = Math.min(1, rise + dt / 0.2);
    const headAge = Math.max(0, now - headSeen) / (TRAIL_LIFE * 1000);
    const headAlpha = active ? rise : rise * Math.max(0, 1 - headAge);

    const cutoff = now - TRAIL_LIFE * 1000;
    points = points.filter((p) => p.t >= cutoff);

    if (!active && headAlpha <= 0.001 && points.length === 0) {
      ctx.clearRect(0, 0, W, H);
      rise = 0;
      running = false;
      return;
    }

    ctx.clearRect(0, 0, W, H);
    drawSecondLayer();
    buildMask(headAlpha, now);

    /* 用模糊把遮罩边缘化成液体，再裁出第二层 */
    ctx.save();
    ctx.globalCompositeOperation = "destination-in";
    if (canFilter) ctx.filter = "blur(5px)";
    ctx.drawImage(mask, 0, 0, W, H);
    ctx.restore();

    shadeReveal();

    raf = requestAnimationFrame(frame);
  }

  return {
    destroy() {
      running = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
      planet.removeEventListener("pointerenter", onMove);
      planet.removeEventListener("pointermove", onMove);
      planet.removeEventListener("pointerleave", onLeave);
      planet.removeEventListener("pointercancel", onLeave);
      ctx.clearRect(0, 0, W, H);
    },
  };
}
