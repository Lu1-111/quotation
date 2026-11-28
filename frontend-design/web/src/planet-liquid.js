/* 封面星球：鼠标轨迹形成的液态窗口，露出第二层星球
   - 轨迹沿鼠标实际路径生成柔软的液态缎带，边缘随时间起伏
   - 速度越快，头部拉长、缎带收细，慢速时更饱满
   - 第二层带轻微视差与放大，像球壳下面的世界
   - 边缘按画布尺寸做模糊，并描一圈液面高光
   - 未加载第二层图片时使用程序生成的电影感地球兜底
   - 尊重 prefers-reduced-motion：不播放 */

const TRAIL_LIFE = 1.15; // 轨迹存活时间（秒）
const MIN_STEP = 2; // 采样最小间隔（px）
const LAYER_ZOOM = 1.04; // 第二层放大倍数，给视差留余量
const PARALLAX = 0.035; // 视差强度

export function createLiquidPlanet(planet, canvas, imageUrl) {
  if (!planet || !canvas) return null;

  const ctx = canvas.getContext("2d");
  const mask = document.createElement("canvas");
  const mctx = mask.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const canFilter = "filter" in ctx;

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
  let smoothSpeed = 0;
  let parX = 0;
  let parY = 0;
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

  /* 触屏抬手后不一定有 pointerleave，主动收尾 */
  function onUp(event) {
    if (event.pointerType === "touch") onLeave();
  }

  planet.addEventListener("pointerenter", onMove);
  planet.addEventListener("pointermove", onMove);
  planet.addEventListener("pointerleave", onLeave);
  planet.addEventListener("pointercancel", onLeave);
  planet.addEventListener("pointerup", onUp);

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

  /* 第二层：随指针反向轻移并微微放大，读起来像球壳下的另一颗星球 */
  function drawSecondLayer() {
    ctx.save();
    ctx.translate(W / 2 + parX, H / 2 + parY);
    ctx.scale(LAYER_ZOOM, LAYER_ZOOM);
    ctx.translate(-W / 2, -H / 2);

    if (imageReady) {
      const scale = Math.max(W / image.width, H / image.height);
      const dw = image.width * scale;
      const dh = image.height * scale;
      ctx.drawImage(image, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } else {
      drawFallback();
    }
    ctx.restore();
  }

  /* 用二次曲线把一串点连成平滑路径 */
  function trace(c, list, move) {
    if (!list.length) return;
    if (move) c.moveTo(list[0].x, list[0].y);
    else c.lineTo(list[0].x, list[0].y);
    if (list.length === 1) return;
    for (let i = 1; i < list.length - 1; i++) {
      const mx = (list[i].x + list[i + 1].x) / 2;
      const my = (list[i].y + list[i + 1].y) / 2;
      c.quadraticCurveTo(list[i].x, list[i].y, mx, my);
    }
    const tail = list[list.length - 1];
    c.lineTo(tail.x, tail.y);
  }

  function addHeadPath(c, shape) {
    if (!shape || !shape.length) return;
    c.moveTo(shape[0].x, shape[0].y);
    for (let i = 1; i < shape.length; i++) c.lineTo(shape[i].x, shape[i].y);
    c.closePath();
  }

  /* 指针速度（px/s），用最近两个采样点估算 */
  function pointerVelocity() {
    const n = points.length;
    if (n < 2) return { vx: 0, vy: 0, speed: 0 };
    const a = points[n - 2];
    const b = points[n - 1];
    const ms = Math.max(8, b.t - a.t);
    const vx = ((b.x - a.x) / ms) * 1000;
    const vy = ((b.y - a.y) / ms) * 1000;
    return { vx, vy, speed: Math.hypot(vx, vy) };
  }

  /* 沿鼠标路径生成液态缎带：宽度按寿命收窄，并按速度变细 */
  function ribbonPoints(baseHalf, now) {
    const pts = points;
    if (pts.length < 2) return null;

    const t = now * 0.001;
    const left = [];
    const right = [];
    let cum = 0;
    let speedFactor = 1;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      let dx = next.x - prev.x;
      let dy = next.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;

      if (i > 0) {
        const step = Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
        cum += step;
        const ms = Math.max(8, p.t - pts[i - 1].t);
        const sp = (step / ms) * 1000;
        const raw = 1 / (1 + 0.4 * Math.min(1, sp / 1800));
        speedFactor += (raw - speedFactor) * 0.35;
      }

      const age = Math.min(1, (now - p.t) / (TRAIL_LIFE * 1000));
      const s = 1 - age;
      const half = baseHalf * (0.1 + 0.82 * Math.sqrt(s)) * speedFactor;

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

    return { left, right };
  }

  /* 指针处的液滴：静止时是缓慢变形的圆，移动时沿速度方向拉长 */
  function headShape(baseHalf, now) {
    const t = now * 0.001;
    const k = Math.min(1, smoothSpeed / 2200);
    const along = baseHalf * 1.02 * (1 + 0.55 * k);
    const across = baseHalf * 1.02 * (1 - 0.2 * k);

    const pv = pointerVelocity();
    const angle = k > 0.04 ? Math.atan2(pv.vy, pv.vx) : 0;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);

    const steps = 48;
    const shape = [];
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const wob =
        1 + 0.085 * Math.sin(a * 3 + t * 2.6) + 0.055 * Math.sin(a * 5 - t * 2.1);
      const lx = Math.cos(a) * along * wob;
      const ly = Math.sin(a) * across * wob;
      shape.push({
        x: pointer.x + lx * ca - ly * sa,
        y: pointer.y + lx * sa + ly * ca,
      });
    }
    return shape;
  }

  function buildMask(headAlpha, now) {
    mctx.clearRect(0, 0, W, H);

    const baseHalf = Math.min(W, H) * 0.15;
    mctx.globalCompositeOperation = "source-over";
    mctx.fillStyle = "#fff";

    const geom = ribbonPoints(baseHalf, now);
    const head = headShape(baseHalf, now);

    /* 轨迹按寿命自然收窄，不做整体加速淡出 */
    mctx.globalAlpha = 1;
    if (geom) {
      mctx.beginPath();
      trace(mctx, geom.left, true);
      trace(mctx, geom.right.slice().reverse(), false);
      mctx.closePath();
      mctx.fill();
    }

    mctx.globalAlpha = Math.min(1, Math.max(0, headAlpha));
    mctx.beginPath();
    addHeadPath(mctx, head);
    mctx.fill();

    mctx.globalAlpha = 1;
    return { geom, head };
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

  /* 沿窗口边缘描一圈液面高光，只落在已经露出的范围里 */
  function drawEdge(geom, head, alpha) {
    if (alpha <= 0.01 || (!geom && !head)) return;
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    const build = () => {
      ctx.beginPath();
      if (geom) {
        trace(ctx, geom.left, true);
        trace(ctx, geom.right.slice().reverse(), false);
        ctx.closePath();
      }
      addHeadPath(ctx, head);
    };

    ctx.strokeStyle = `rgba(255, 198, 126, ${(0.1 * alpha).toFixed(3)})`;
    ctx.lineWidth = 5;
    build();
    ctx.stroke();

    ctx.strokeStyle = `rgba(255, 228, 180, ${(0.3 * alpha).toFixed(3)})`;
    ctx.lineWidth = 1.3;
    build();
    ctx.stroke();

    ctx.restore();
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;

    if (active) rise = Math.min(1, rise + dt / 0.2);
    const headAge = Math.max(0, now - headSeen) / (TRAIL_LIFE * 1000);
    const headAlpha = active ? rise : rise * Math.max(0, 1 - headAge);

    const pv = pointerVelocity();
    const targetSpeed = active ? pv.speed : 0;
    smoothSpeed += (targetSpeed - smoothSpeed) * (1 - Math.exp(-dt * 14));

    const parTargetX = -(pointer.x - W / 2) * PARALLAX;
    const parTargetY = -(pointer.y - H / 2) * PARALLAX;
    const kp = 1 - Math.exp(-dt * 6);
    parX += (parTargetX - parX) * kp;
    parY += (parTargetY - parY) * kp;

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
    const { geom, head } = buildMask(headAlpha, now);

    /* 用与画布尺寸匹配的模糊把遮罩边缘化成液体，再裁出第二层 */
    const blurPx = Math.max(2, Math.min(10, Math.min(W, H) * 0.022));
    ctx.save();
    ctx.globalCompositeOperation = "destination-in";
    if (canFilter) ctx.filter = `blur(${blurPx.toFixed(1)}px)`;
    ctx.drawImage(mask, 0, 0, W, H);
    ctx.restore();

    shadeReveal();
    drawEdge(geom, head, active ? 1 : Math.max(0, headAlpha));

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
      planet.removeEventListener("pointerup", onUp);
      ctx.clearRect(0, 0, W, H);
    },
  };
}
