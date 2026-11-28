// Star Atlas 封面与星图控制器：
// - 100% 沿用远程 origin/main 原版 galaxy.js（零修改）与原版封面/黑洞坍缩交互
// - 仅做数据桥接：将星图写入 Agent 生成的 star-map.json（星球与连线）映射为原版 galaxy.js 的 setGraphData 节点格式
// - 不在星图画布上额外绘制文字，取消大小与亮度区分（所有星球采用统一 S 值）
import { createGalaxy } from './galaxy.js';
import { createLiquidPlanet } from './planet-liquid.js';

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const body = document.body;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const planet = $('planet');
const planetCanvas = $('planetLiquid');
const toggle = $('themeToggle');
const aboutBtn = $('aboutBtn');
const about = $('about');
const toastEl = $('toast');
const blackHole = $('blackHole');
const galaxy = $('galaxy');
const galaxyCanvas = $('galaxyCanvas');
const galaxyBack = $('galaxyBack');
const galaxyEmptyBack = $('galaxyEmptyBack');
const galaxyHint = $('galaxyHint');
const nodeCard = $('nodeCard');
const cardCluster = $('cardCluster');
const cardName = $('cardName');
const cardText = $('cardText');
const cardMeta = $('cardMeta');
const cardClose = $('nodeCardClose');

const pageChrome = [
  document.querySelector('.topbar'),
  document.querySelector('.cover'),
  document.querySelector('.foot'),
].filter(Boolean);

const state = {
  starMap: { galaxies: [], planets: [], links: [] },
  planetsDb: { records: [] },
  profile: null,
  status: null,
};

let galaxyScene = null;
let switching = false;
let bhActive = false;
let bhAnimations = [];
let bhTimers = [];
let galaxyClosing = false;
let galaxyOpener = null;
let toastTimer = null;

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 3200);
}

async function api(url, { method = 'GET', body: payload } = {}) {
  const res = await fetch(url, {
    method,
    headers: payload ? { 'Content-Type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

// ---------- 将星图写入 Agent 产出的 star-map.json 适配为原版 galaxy.js 的节点与连线 ----------
function toOriginalGalaxyNodes(starMap) {
  const galaxies = Array.isArray(starMap?.galaxies) ? starMap.galaxies : [];
  const planets = Array.isArray(starMap?.planets) ? starMap.planets : [];
  const links = Array.isArray(starMap?.links) ? starMap.links : [];

  const galaxyMap = new Map(galaxies.map((g) => [g.id, g]));
  // 为每个分支稳定分配原版 galaxy.js 的 4 种星云颜色槽位（同分支同色，不同分支异色）
  const branchSlot = new Map();
  let nextSlot = 0;
  for (const g of galaxies) {
    for (const br of g.branches || []) {
      if (!branchSlot.has(br.id)) {
        branchSlot.set(br.id, (nextSlot % 4) + 1);
        nextSlot += 1;
      }
    }
  }

  // 构建双向邻接依赖，使原版 galaxy.js 渲染同分支及跨分支连线
  const depsByPlanet = new Map(planets.map((p) => [p.id, []]));
  for (const link of links) {
    if (depsByPlanet.has(link.from) && depsByPlanet.has(link.to)) {
      depsByPlanet.get(link.from).push(link.to);
    }
  }

  return planets.map((p) => {
    const g = galaxyMap.get(p.galaxyId);
    const slot = branchSlot.get(p.branchId) || 1;
    return {
      id: p.id,
      // 取消大小和亮度区分：所有星球赋予统一承重值 S = 2，不区分体积与亮度
      S: 2,
      d: 1,
      cluster: slot,
      // 注意：故意不传 n.domain，避免原版 galaxy.js 在 3D 画布上绘制常驻领域文字；
      // 真实领域、分支与出处通过下方 knowledgeSources 回调渲染在详情卡中。
      center: g?.center || p.pos || { x: 0, y: 0, z: 0 },
      name: p.knowledgePoint,
      text: p.summary,
      deps: depsByPlanet.get(p.id) || [],
      sources: {
        id: p.id,
        domain: p.domain,
        branchName: p.branchName,
        weight: p.weight,
        items: Array.isArray(p.sources) ? p.sources : [],
      },
    };
  });
}

const CONTENT_TYPE_LABELS = { answer: '知乎回答', article: '知乎专栏', pin: '知乎想法', question: '知乎问题', zvideo: '知乎视频' };

// 利用原版 galaxy.js 内置的 knowledgeSources 回调渲染星球详情卡：
// - 顶行显示真实语义领域与分支（取代旧版“推荐确实拓宽过我”）
// - 主标题为归纳出的知识点（由 galaxy.js 的 cardName 渲染）
// - 下方为知识点摘要与可点击跳转的原始出处列表（同时自动隐藏旧版承重/坍缩/焦点按钮）
function renderPlanetProvenance(meta) {
  if (!meta || typeof meta !== 'object') return null;
  cardCluster.textContent = meta.branchName ? `${meta.domain} · ${meta.branchName}` : meta.domain || '';
  cardMeta.textContent = `知识点编号 ${meta.id} · 所属领域：${meta.domain || '未分类'}`;

  const wrap = document.createElement('div');
  wrap.className = 'ks-box';

  const heading = document.createElement('p');
  heading.className = 'ks-title';
  heading.textContent = '出处与溯源';
  wrap.appendChild(heading);

  const items = Array.isArray(meta.items) ? meta.items : [];
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'ks-empty';
    empty.textContent = '由工作台手动录入或直接归纳自知识库。';
    wrap.appendChild(empty);
    return wrap;
  }

  const list = document.createElement('ul');
  list.className = 'ks-list';
  for (const src of items) {
    const li = document.createElement('li');
    li.className = 'ks-item';

    const titleEl = src.url ? document.createElement('a') : document.createElement('span');
    titleEl.className = 'ks-link';
    titleEl.textContent = src.title || src.key || '知乎原帖';
    if (src.url) {
      titleEl.href = src.url;
      titleEl.target = '_blank';
      titleEl.rel = 'noopener noreferrer';
    }
    li.appendChild(titleEl);

    const subParts = [];
    if (src.contentType && CONTENT_TYPE_LABELS[src.contentType]) subParts.push(CONTENT_TYPE_LABELS[src.contentType]);
    if (src.author) subParts.push(`作者：${src.author}`);
    if (subParts.length) {
      const sub = document.createElement('span');
      sub.className = 'ks-sub';
      sub.textContent = subParts.join(' · ');
      li.appendChild(sub);
    }
    list.appendChild(li);
  }
  wrap.appendChild(list);
  return wrap;
}

function ensureGalaxy() {
  if (!galaxyScene) {
    galaxyScene = createGalaxy({
      canvas: galaxyCanvas,
      card: nodeCard,
      cardCluster,
      cardName,
      cardText,
      cardMeta,
      cardClose,
      hint: galaxyHint,
    });
  }
  return galaxyScene;
}

function pushStarMapToOriginalGalaxy() {
  const scene = ensureGalaxy();
  const nodes = toOriginalGalaxyNodes(state.starMap);
  // 传入原版 galaxy.js 支持的 knowledgeSources 渲染器：
  // 画布零文字（因节点不含 n.domain），点击星球时卡片展示“主标题知识点 + 摘要 + 出处原帖”
  scene.setGraphData(nodes, { graphVersion: nodes.length, knowledgeSources: renderPlanetProvenance });

  const { galaxies, planets, links } = state.starMap;
  const userEl = $('galaxyUser');
  if (userEl) {
    userEl.textContent = planets.length > 0 ? `${galaxies.length} 个星系 · ${planets.length} 颗星球 · ${links.length} 条连线` : '';
  }
  const foot = $('footStatus');
  if (foot) {
    foot.textContent = planets.length > 0 ? `v0.4 / ${galaxies.length} 星系 · ${planets.length} 星球` : 'v0.4 / star-atlas-live';
  }
}

// ---------- 原版浅色新拟态 / 深色液态玻璃圆形裁切主题切换 ----------
function syncChrome() {
  const dark = root.dataset.theme === 'dark';
  toggle.setAttribute('aria-pressed', String(dark));
  toggle.setAttribute('aria-label', dark ? '切换到白天模式' : '切换到夜间模式');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#07080f' : '#e9edf2');
}

function applyTheme(theme) {
  root.dataset.theme = theme;
  try {
    localStorage.setItem('quotation-theme', theme);
  } catch {
    // ignore
  }
  syncChrome();
}

toggle.addEventListener('click', () => {
  if (switching) return;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  if (reduceMotion.matches || !document.startViewTransition) {
    applyTheme(next);
    return;
  }
  const rect = toggle.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  switching = true;
  let transition;
  try {
    transition = document.startViewTransition(() => applyTheme(next));
  } catch {
    switching = false;
    applyTheme(next);
    return;
  }
  transition.ready
    .then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 900, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)' },
      );
    })
    .catch(() => {});
  transition.finished.then(
    () => { switching = false; },
    () => { switching = false; },
  );
});

syncChrome();

// ---------- 说明弹层 ----------
function setAbout(open) {
  about.hidden = !open;
  aboutBtn.setAttribute('aria-expanded', String(open));
}
aboutBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setAbout(about.hidden);
});
document.addEventListener('click', (e) => {
  if (!about.hidden && !about.contains(e.target)) setAbout(false);
});

// ---------- 原版黑洞坍缩转场 -> 原版 Mind Galaxy ----------
function setPageInert(on) {
  for (const el of pageChrome) el.inert = on;
}

function beginGalaxyReveal() {
  setPageInert(true);
  galaxy.setAttribute('aria-hidden', 'false');
  galaxy.classList.remove('closing');
  void galaxy.offsetWidth;
  galaxy.classList.add('on');
  pushStarMapToOriginalGalaxy();
  ensureGalaxy().start();
  galaxyBack.focus({ preventScroll: true });
}

function cleanupBlackHole() {
  for (const id of bhTimers) clearTimeout(id);
  bhTimers = [];
  for (const anim of bhAnimations) {
    try {
      anim.cancel();
    } catch {
      // ignore
    }
  }
  bhAnimations = [];
  bhActive = false;
  body.classList.remove('bh-active');
  blackHole.classList.remove('on', 'vanish');
  if (!galaxy.classList.contains('on')) setPageInert(false);
}

function playBlackHole(cx, cy) {
  bhActive = true;
  setPageInert(true);
  root.style.setProperty('--bhx', `${cx}px`);
  root.style.setProperty('--bhy', `${cy}px`);

  body.classList.add('bh-active');
  blackHole.classList.remove('vanish');
  blackHole.classList.add('on');

  const targets = [
    document.querySelector('.topbar-left'),
    document.querySelector('.topbar-right'),
    document.querySelector('.galaxy-label'),
    document.querySelector('.stage-label'),
    document.querySelector('.intro'),
    document.querySelector('.foot'),
    document.querySelector('.orbit'),
  ].filter(Boolean);

  const planetAnim = planet.animate(
    [
      { transform: 'scale(1)', filter: 'brightness(1)', opacity: 1 },
      { transform: 'scale(.86)', filter: 'brightness(.75)', opacity: 1, offset: 0.3 },
      { transform: 'scale(.03)', filter: 'brightness(.2) blur(3px)', opacity: 0.9 },
    ],
    { duration: 780, easing: 'cubic-bezier(.5,0,.9,.35)', fill: 'forwards' },
  );
  bhAnimations.push(planetAnim);

  targets.forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const ex = rect.left + rect.width / 2;
    const ey = rect.top + rect.height / 2;
    const dx = cx - ex;
    const dy = cy - ey;
    const angle = (i % 2 ? 1 : -1) * (120 + i * 42);
    const anim = el.animate(
      [
        { translate: '0 0', rotate: '0deg', scale: '1', opacity: 1, filter: 'blur(0)' },
        {
          translate: `${dx * 0.6}px ${dy * 0.6}px`,
          rotate: `${angle * 0.55}deg`,
          scale: '.55',
          opacity: 0.65,
          filter: 'blur(1px)',
          offset: 0.6,
        },
        {
          translate: `${dx}px ${dy}px`,
          rotate: `${angle}deg`,
          scale: '.04',
          opacity: 0,
          filter: 'blur(4px)',
        },
      ],
      { duration: 850, delay: i * 35, easing: 'cubic-bezier(.45,0,.9,.4)', fill: 'forwards' },
    );
    bhAnimations.push(anim);
  });

  bhTimers.push(
    setTimeout(() => {
      if (!bhActive) return;
      beginGalaxyReveal();
      blackHole.classList.remove('on');
      blackHole.classList.add('vanish');
    }, 1000),
  );

  bhTimers.push(
    setTimeout(() => {
      body.classList.remove('bh-active');
    }, 1600),
  );
}

function openGalaxy({ skipBlackHole = false } = {}) {
  if (switching || bhActive || galaxy.classList.contains('on')) return;
  setAbout(false);
  galaxyOpener = document.activeElement;
  const rect = planet.getBoundingClientRect();
  const cx = rect.width ? rect.left + rect.width / 2 : innerWidth / 2;
  const cy = rect.height ? rect.top + rect.height / 2 : innerHeight / 2;
  const radius = Math.hypot(Math.max(cx, innerWidth - cx), Math.max(cy, innerHeight - cy));
  galaxy.style.setProperty('--gx', `${cx}px`);
  galaxy.style.setProperty('--gy', `${cy}px`);
  galaxy.style.setProperty('--gr', `${radius + 6}px`);

  if (!skipBlackHole && !reduceMotion.matches) {
    playBlackHole(cx, cy);
  } else {
    beginGalaxyReveal();
  }
}

function closeGalaxy() {
  if (bhActive && !galaxy.classList.contains('on')) {
    cleanupBlackHole();
    galaxyOpener?.focus({ preventScroll: true });
    return;
  }
  if (!galaxy.classList.contains('on') || galaxyClosing) return;
  galaxyClosing = true;
  if (galaxyScene) galaxyScene.stop();
  cleanupBlackHole();
  galaxy.classList.add('closing');
  setTimeout(() => {
    galaxy.classList.remove('on', 'closing');
    setPageInert(false);
    const returnFocus = galaxyOpener?.isConnected && galaxyOpener !== document.body ? galaxyOpener : planet;
    returnFocus.focus({ preventScroll: true });
    galaxy.setAttribute('aria-hidden', 'true');
    galaxyClosing = false;
  }, 470);
}

async function refreshStarMap() {
  state.starMap = await api('/api/starmap');
  pushStarMapToOriginalGalaxy();
}

function connectSse() {
  const es = new EventSource('/api/events');
  es.addEventListener('starmap.updated', (ev) => {
    const payload = JSON.parse(ev.data);
    state.starMap = payload.starMap;
    pushStarMapToOriginalGalaxy();
    if (payload.stats?.placedCount > 0) {
      toast(`星图写入 Agent 已写入 ${payload.stats.placedCount} 颗星球`);
    }
  });
}

function bindEvents() {
  planet.addEventListener('click', () => openGalaxy());
  $('openKnowledge').addEventListener('click', () => openGalaxy());
  $('openWorkbench').addEventListener('click', () => { location.href = '/workbench'; });
  $('topWorkbenchBtn').addEventListener('click', () => { location.href = '/workbench'; });
  galaxyBack.addEventListener('click', () => closeGalaxy());
  galaxyEmptyBack?.addEventListener('click', () => closeGalaxy());

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (galaxy.classList.contains('on') || bhActive) {
      closeGalaxy();
      return;
    }
    if (!about.hidden) {
      setAbout(false);
      aboutBtn.focus();
    }
  });
}

async function bootstrap() {
  if (planetCanvas) {
    createLiquidPlanet(planet, planetCanvas, new URL('./assets/planet-second.webp', import.meta.url).href);
  }
  bindEvents();
  connectSse();
  await refreshStarMap();
  if (location.hash === '#galaxy') {
    openGalaxy({ skipBlackHole: true });
  }
}

bootstrap().catch((err) => {
  console.error(err);
  toast(`初始化失败：${err.message}`);
});
