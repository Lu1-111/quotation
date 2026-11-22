/* 第 0 屏 · 封面交互
   - 白天 / 夜晚切换：以按钮为圆心的圆形裁切
   - 主题写入 localStorage；也支持 ?theme=dark 便于截图与分享
   - 登录入口目前是占位，后续接入后端与 Mind Galaxy */

const root = document.documentElement;
const body = document.body;
const toggle = document.getElementById("themeToggle");
const toastEl = document.getElementById("toast");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const planet = document.getElementById("planet");
const demoLogin = document.getElementById("demoLogin");
const backHome = document.getElementById("backHome");
const galaxy = document.getElementById("galaxy");
const galaxyBack = document.getElementById("galaxyBack");
const pageChrome = [
  document.querySelector(".topbar"),
  document.querySelector(".cover"),
  document.querySelector(".foot"),
].filter(Boolean);

function syncChrome() {
  const dark = root.dataset.theme === "dark";
  toggle.setAttribute("aria-pressed", String(dark));
  toggle.setAttribute("aria-label", dark ? "切换到白天模式" : "切换到夜间模式");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#07080f" : "#e9edf2");
}

function applyTheme(theme, persist = true) {
  root.dataset.theme = theme;
  if (persist) {
    try {
      localStorage.setItem("quotation-theme", theme);
    } catch (err) {
      /* 隐私模式下 localStorage 可能不可用，忽略即可 */
    }
  }
  syncChrome();
}

syncChrome();

let switching = false;
let viewSwitching = false;

toggle.addEventListener("click", () => {
  if (switching || viewSwitching) return;
  const next = root.dataset.theme === "dark" ? "light" : "dark";

  // 减少动画的系统设置，或浏览器不支持 View Transitions：直接换
  if (reduceMotion.matches || !document.startViewTransition) {
    applyTheme(next);
    return;
  }

  const rect = toggle.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const radius = Math.hypot(
    Math.max(x, innerWidth - x),
    Math.max(y, innerHeight - y)
  );

  switching = true;
  let transition;
  try {
    transition = document.startViewTransition(() => applyTheme(next));
  } catch (err) {
    switching = false;
    applyTheme(next);
    return;
  }

  transition.ready
    .then(() => {
      root.animate(
        {
          clipPath: [
            `circle(0px at ${x}px ${y}px)`,
            `circle(${radius}px at ${x}px ${y}px)`,
          ],
        },
        {
          duration: 900,
          easing: "cubic-bezier(.22,1,.36,1)",
          pseudoElement: "::view-transition-new(root)",
        }
      );
    })
    .catch(() => {});

  transition.finished.then(
    () => { switching = false; },
    () => { switching = false; }
  );
});

/* 说明面板 */
const about = document.getElementById("about");
const aboutBtn = document.getElementById("aboutBtn");

function setAbout(open) {
  about.hidden = !open;
  aboutBtn.setAttribute("aria-expanded", String(open));
}

aboutBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  setAbout(about.hidden);
});

document.addEventListener("click", (event) => {
  if (!about.hidden && !about.contains(event.target)) setAbout(false);
});

/* 视角切换：封面 ⇄ 信息页 */
function applyView(view) {
  body.dataset.view = view;
  planet.setAttribute(
    "aria-label",
    view === "info" ? "进入 Mind Galaxy" : "你的世界观星球"
  );
}

function transitionView(view) {
  if (viewSwitching || switching || body.dataset.view === view) return;
  setAbout(false);

  if (reduceMotion.matches || !document.startViewTransition) {
    applyView(view);
    return;
  }

  viewSwitching = true;
  root.dataset.vt = "view";
  try {
    const transition = document.startViewTransition(() => applyView(view));
    transition.finished.then(
      () => {
        delete root.dataset.vt;
        viewSwitching = false;
      },
      () => {
        delete root.dataset.vt;
        viewSwitching = false;
      }
    );
  } catch (err) {
    delete root.dataset.vt;
    viewSwitching = false;
    applyView(view);
  }
}

/* 星球 → 星图占位层（第三阶段替换为真正的星图） */
let galaxyClosing = false;

function setPageInert(on) {
  for (const el of pageChrome) el.inert = on;
}

function openGalaxy() {
  if (viewSwitching || switching || galaxy.classList.contains("on")) return;
  const rect = planet.getBoundingClientRect();
  galaxy.style.setProperty("--gx", `${rect.left + rect.width / 2}px`);
  galaxy.style.setProperty("--gy", `${rect.top + rect.height / 2}px`);
  setPageInert(true);
  galaxy.setAttribute("aria-hidden", "false");
  galaxy.classList.remove("closing");
  void galaxy.offsetWidth;
  galaxy.classList.add("on");
  setTimeout(() => galaxyBack.focus({ preventScroll: true }), 750);
}

function closeGalaxy() {
  if (!galaxy.classList.contains("on") || galaxyClosing) return;
  galaxyClosing = true;
  galaxy.classList.add("closing");
  setTimeout(() => {
    galaxy.classList.remove("on", "closing");
    galaxy.setAttribute("aria-hidden", "true");
    setPageInert(false);
    galaxyClosing = false;
    planet.focus({ preventScroll: true });
  }, 340);
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (galaxy.classList.contains("on")) {
    closeGalaxy();
    return;
  }
  if (body.dataset.view === "info") {
    transitionView("cover");
    return;
  }
  if (!about.hidden) {
    setAbout(false);
    aboutBtn.focus();
  }
});

/* 轻提示 */
let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("on"), 2800);
}

demoLogin.addEventListener("click", () => transitionView("info"));

planet.addEventListener("click", () => {
  if (body.dataset.view === "info") openGalaxy();
  else transitionView("info");
});

backHome.addEventListener("click", () => transitionView("cover"));
galaxyBack.addEventListener("click", closeGalaxy);

/* ---------- Liquid Glass：边缘折射 ----------
   思路来自 shuding/liquid-glass：用 feDisplacementMap 只在边缘把背景
   向中心拉一点，中间保持不形变。玻璃表面本身保持干净，靠折射 + 细边高光
   表现材质，而不是堆一层白色高光。 */

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const supportsGlassFilter =
  CSS.supports("backdrop-filter", "url(#x)") ||
  CSS.supports("-webkit-backdrop-filter", "url(#x)");

if (supportsGlassFilter) {
  const defs = document.createElementNS(SVG_NS, "defs");
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:fixed;left:0;top:0;pointer-events:none;";
  svg.appendChild(defs);
  document.body.appendChild(svg);

  let glassSeq = 0;

  function smoothstep(t) {
    t = Math.max(0, Math.min(1, t));
    return t * t * (3 - 2 * t);
  }

  function buildMap(w, h, radius, edge, strength) {
    const W = Math.max(2, Math.round(w));
    const H = Math.max(2, Math.round(h));
    const a = W / 2;
    const b = H / 2;
    const r = Math.min(radius, a, b);
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(W, H);
    const dxs = new Float32Array(W * H);
    const dys = new Float32Array(W * H);
    let maxD = 0;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const qx = Math.abs(x + 0.5 - a) - a + r;
        const qy = Math.abs(y + 0.5 - b) - b + r;
        const sdf =
          Math.min(Math.max(qx, qy), 0) +
          Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) -
          r;
        const t = smoothstep(-sdf / edge);
        const dx = (a - (x + 0.5)) * t * strength;
        const dy = (b - (y + 0.5)) * t * strength;
        const i = y * W + x;
        dxs[i] = dx;
        dys[i] = dy;
        maxD = Math.max(maxD, Math.abs(dx), Math.abs(dy));
      }
    }

    const m = maxD || 1;
    for (let i = 0; i < W * H; i++) {
      const j = i * 4;
      image.data[j] = (dxs[i] / (2 * m) + 0.5) * 255;
      image.data[j + 1] = (dys[i] / (2 * m) + 0.5) * 255;
      image.data[j + 2] = 0;
      image.data[j + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return { url: canvas.toDataURL(), scale: m };
  }

  function liquidGlass(el, options = {}) {
    const id = `lg-${++glassSeq}`;
    const filter = document.createElementNS(SVG_NS, "filter");
    filter.setAttribute("id", id);
    filter.setAttribute("filterUnits", "userSpaceOnUse");
    filter.setAttribute("color-interpolation-filters", "sRGB");
    filter.setAttribute("x", "0");
    filter.setAttribute("y", "0");

    const feImage = document.createElementNS(SVG_NS, "feImage");
    feImage.setAttribute("x", "0");
    feImage.setAttribute("y", "0");
    feImage.setAttribute("result", "map");

    const feDisp = document.createElementNS(SVG_NS, "feDisplacementMap");
    feDisp.setAttribute("in", "SourceGraphic");
    feDisp.setAttribute("in2", "map");
    feDisp.setAttribute("xChannelSelector", "R");
    feDisp.setAttribute("yChannelSelector", "G");

    filter.appendChild(feImage);
    filter.appendChild(feDisp);
    defs.appendChild(filter);

    let lastW = 0;
    let lastH = 0;

    function update() {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (!w || !h) return;
      if (Math.abs(w - lastW) < 1 && Math.abs(h - lastH) < 1) return;
      lastW = w;
      lastH = h;

      const radius = Math.min(options.radius ?? h / 2, h / 2);
      const edge = Math.max(4, Math.min(w, h) * (options.edge ?? 0.28));
      const map = buildMap(w, h, radius, edge, options.strength ?? 0.18);

      filter.setAttribute("width", w);
      filter.setAttribute("height", h);
      feImage.setAttribute("width", w);
      feImage.setAttribute("height", h);
      feImage.setAttribute("href", map.url);
      feImage.setAttributeNS(XLINK_NS, "xlink:href", map.url);
      feDisp.setAttribute("scale", map.scale);
      el.style.setProperty(
        "--lg-filter",
        `url(#${id}) blur(0.6px) saturate(1.5) contrast(1.04)`
      );
    }

    update();
    new ResizeObserver(update).observe(el);
    window.addEventListener("resize", update, { passive: true });
  }

  for (const el of document.querySelectorAll(".theme-toggle")) {
    liquidGlass(el, { strength: 0.24, edge: 0.3 });
  }
  const actionsEl = document.querySelector(".actions");
  if (actionsEl) liquidGlass(actionsEl, { strength: 0.18, edge: 0.26 });
  const toastGlass = document.getElementById("toast");
  if (toastGlass) liquidGlass(toastGlass, { strength: 0.2, edge: 0.3 });
}
