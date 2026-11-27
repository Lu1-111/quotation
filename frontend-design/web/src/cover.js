/* 第 0 屏 · 封面交互、公开自由对话体验与 `/v1` 实时工作台编排
   - 白天 / 夜晚切换：以按钮为圆心的圆形裁切
   - 同源握手：启动时调用 GET /health + POST /api/host/session，按宿主返回决定 public | demo | static 模式
   - public 模式：首页第一屏直接自由输入「这句话，你想怎么说？」，同一会话承接温柔对话、核验出处、可编辑改写与双向星图
   - demo 模式：完整保留「使用演示账号」与工作台交互，确保 R-C1/R-C2/F-C1/F-C2 零回归 */

import { createGalaxy } from "./galaxy.js?v=33";
import { createLiquidPlanet } from "./planet-liquid.js?v=35";
import { renderLiveAnalysis } from "./analysis.js?v=33";
import {
  createLiveSessionController,
  STAGE_LABELS,
  PUBLIC_STAGE_LABELS,
  TURN_STATUS_LABELS,
  PUBLIC_TURN_STATUS_LABELS,
  SOURCE_TYPE_LABELS,
  getRelationLabel,
  formatGentleError,
} from "./live-session.js?v=33";

const root = document.documentElement;
const body = document.body;
const workbenchMode = body.dataset.hostMode === "workbench_debate";
let workbench;
const toggle = document.getElementById("themeToggle");
const toastEl = document.getElementById("toast");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const planet = document.getElementById("planet");
const planetCanvas = document.getElementById("planetLiquid");
const demoLogin = document.getElementById("demoLogin");
const backHome = document.getElementById("backHome");
const galaxy = document.getElementById("galaxy");
const galaxyBack = document.getElementById("galaxyBack");
const galaxyEmptyBack = document.getElementById("galaxyEmptyBack");
const galaxyCanvas = document.getElementById("galaxyCanvas");
const galaxyHint = document.getElementById("galaxyHint");
const nodeCard = document.getElementById("nodeCard");
const cardCluster = document.getElementById("cardCluster");
const cardName = document.getElementById("cardName");
const cardText = document.getElementById("cardText");
const cardMeta = document.getElementById("cardMeta");
const cardClose = document.getElementById("nodeCardClose");
const blackHole = document.getElementById("blackHole");

// 封面与说明 DOM
const publicCoverIntro = document.getElementById("publicCoverIntro");
const demoCoverIntro = document.getElementById("demoCoverIntro");
const publicHomeForm = document.getElementById("publicHomeForm");
const publicHomeInput = document.getElementById("publicHomeInput");
const publicHomeSubmit = document.getElementById("publicHomeSubmit");
const infoNameEl = document.getElementById("infoName");
const infoMetaEl = document.getElementById("infoMeta");
const infoHintEl = document.getElementById("infoHint");
const scrollCueLabel = document.getElementById("scrollCueLabel");
const aboutLinePrimary = document.getElementById("aboutLinePrimary");
const aboutLineSecondary = document.getElementById("aboutLineSecondary");

// 公开模式降级提示栏
const publicDegradeDock = document.getElementById("publicDegradeDock");
const publicDegradeBanner = document.getElementById("publicDegradeBanner");
const publicDegradeTitle = document.getElementById("publicDegradeTitle");
const publicDegradeText = document.getElementById("publicDegradeText");
const publicDegradeSaved = document.getElementById("publicDegradeSaved");
const publicSwitchDemoHint = document.getElementById("publicSwitchDemoHint");
const publicRetryBtn = document.getElementById("publicRetryBtn");
const publicSwitchDemoBtn = document.getElementById("publicSwitchDemoBtn");
const publicDegradeDismissBtn = document.getElementById("publicDegradeDismissBtn");

// 公开模式对话与星图 DOM
const publicDialogueSection = document.getElementById("publicDialogue");
const publicWorkspaceSub = document.getElementById("publicWorkspaceSub");
const openGalaxyFromPublic = document.getElementById("openGalaxyFromPublic");
const openGalaxyFromPanel = document.getElementById("openGalaxyFromPanel");
const publicNewTopicBtn = document.getElementById("publicNewTopicBtn");
const publicDialogueFeed = document.getElementById("publicDialogueFeed");
const publicChangeCard = document.getElementById("publicChangeCard");
const publicChangeSummary = document.getElementById("publicChangeSummary");
const publicRelationChanges = document.getElementById("publicRelationChanges");
const publicUnknownBox = document.getElementById("publicUnknownBox");
const publicUnknownText = document.getElementById("publicUnknownText");
const publicUnknownList = document.getElementById("publicUnknownList");
const publicRewriteCard = document.getElementById("publicRewriteCard");
const publicRewriteExplain = document.getElementById("publicRewriteExplain");
const publicRewriteNotes = document.getElementById("publicRewriteNotes");
const publicRewriteEditor = document.getElementById("publicRewriteEditor");
const tryRewriteBtn = document.getElementById("tryRewriteBtn");
const copyPublicRewriteBtn = document.getElementById("copyPublicRewriteBtn");
const publicFollowupForm = document.getElementById("publicFollowupForm");
const publicFollowupInput = document.getElementById("publicFollowupInput");
const publicFollowupSubmit = document.getElementById("publicFollowupSubmit");
const publicCancelBtn = document.getElementById("publicCancelBtn");
const publicGraphPanel = document.getElementById("publicGraphPanel");
const publicGraphSub = document.getElementById("publicGraphSub");
const publicGraphSvg = document.getElementById("publicGraphSvg");
const publicGraphEmpty = document.getElementById("publicGraphEmpty");
const publicGraphNodeList = document.getElementById("publicGraphNodeList");
const publicGraphNodeDetail = document.getElementById("publicGraphNodeDetail");
const publicGraphDetailRel = document.getElementById("publicGraphDetailRel");
const publicGraphDetailAuthor = document.getElementById("publicGraphDetailAuthor");
const publicGraphDetailText = document.getElementById("publicGraphDetailText");
const publicGraphDetailLink = document.getElementById("publicGraphDetailLink");
const publicGraphDetailClose = document.getElementById("publicGraphDetailClose");

// 共用与演示工作台 DOM
const sharedStatusStrip = document.getElementById("sharedStatusStrip");
const workbenchSection = document.getElementById("workbench");
const liveModeBadge = document.getElementById("liveModeBadge");
const sessionIdLabel = document.getElementById("sessionIdLabel");
const graphVersionBadge = document.getElementById("graphVersionBadge");
const materialsStatusText = document.getElementById("materialsStatusText");
const openGalaxyFromWorkbench = document.getElementById("openGalaxyFromWorkbench");
const newDemoSessionBtn = document.getElementById("newDemoSessionBtn");
const staleVersionBanner = document.getElementById("staleVersionBanner");
const staleVersionText = document.getElementById("staleVersionText");
const staleRetryBtn = document.getElementById("staleRetryBtn");
const staleDismissBtn = document.getElementById("staleDismissBtn");
const snapshotSyncBanner = document.getElementById("snapshotSyncBanner");
const snapshotSyncStatus = document.getElementById("snapshotSyncStatus");
const snapshotSyncDetail = document.getElementById("snapshotSyncDetail");
const snapshotRetryBtn = document.getElementById("snapshotRetryBtn");
const galaxyEmptyOverlay = document.getElementById("galaxyEmpty");
const galaxyEmptyTitle = document.getElementById("galaxyEmptyTitle");
const errorBanner = document.getElementById("errorBanner");
const errorBannerCode = document.getElementById("errorBannerCode");
const errorBannerText = document.getElementById("errorBannerText");
const errorDismissBtn = document.getElementById("errorDismissBtn");
const turnStatusBadge = document.getElementById("turnStatusBadge");
const boundFocusChip = document.getElementById("boundFocusChip");
const boundFocusText = document.getElementById("boundFocusText");
const clearBoundFocusBtn = document.getElementById("clearBoundFocusBtn");
const turnInput = document.getElementById("turnInput");
const submitTurnBtn = document.getElementById("submitTurnBtn");
const submitFactBtn = document.getElementById("submitFactBtn");
const submitToneRewriteBtn = document.getElementById("submitToneRewriteBtn");
const submitScopeRewriteBtn = document.getElementById("submitScopeRewriteBtn");
const cancelTurnBtn = document.getElementById("cancelTurnBtn");
const stageBadge = document.getElementById("stageBadge");
const focusPanel = document.getElementById("focusPanel");
const streamExplanation = document.getElementById("streamExplanation");
const streamMeta = document.getElementById("streamMeta");
const graphNodeCount = document.getElementById("graphNodeCount");
const galaxyEmptyState = document.getElementById("galaxyEmptyState");
const graphNodeList = document.getElementById("graphNodeList");
const workbenchNodeCard = document.getElementById("workbenchNodeCard");
const wbNodeId = document.getElementById("wbNodeId");
const wbNodeText = document.getElementById("wbNodeText");
const wbNodeMeta = document.getElementById("wbNodeMeta");
const wbNodeEvidence = document.getElementById("wbNodeEvidence");
const wbNodeClose = document.getElementById("wbNodeClose");
const bindFocusNodeBtn = document.getElementById("bindFocusNodeBtn");
const evidenceCountBadge = document.getElementById("evidenceCountBadge");
const evidenceListEl = document.getElementById("evidenceList");
const factsCountBadge = document.getElementById("factsCountBadge");
const factsListEl = document.getElementById("factsList");

const live = createLiveSessionController();
let selectedWorkbenchNodeId = null;
const expandedEvidenceIds = new Set();

// 公开模式前端交互态（展开的出处、双向高亮节点、改写框同步版本、收起提示状态）
const expandedPublicCitationIds = new Set();
let highlightedPublicNodeId = null;
let highlightedPublicEvidenceId = null;
let lastSyncedRewriteKey = null;
let degradeDismissed = false;

let galaxyScene = null;
let bhActive = false;
let bhAnimations = [];
let bhTimers = [];

function locatePublicCitationFromGraph(evidenceId, nodeId, { closeGalaxy: shouldClose = false, scroll = true } = {}) {
  highlightedPublicNodeId = nodeId || null;
  highlightedPublicEvidenceId = evidenceId || null;
  if (evidenceId) {
    expandedPublicCitationIds.add(evidenceId);
  }
  if (shouldClose && galaxy.classList.contains("on")) {
    closeGalaxy();
  }
  renderPublicWorkspace(live.getState());
  if (scroll && evidenceId) {
    requestAnimationFrame(() => {
      const target = publicDialogueFeed?.querySelector(
        `[data-testid="public-citation-item"][data-evidence-id="${CSS.escape(evidenceId)}"]`,
      );
      target?.scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "center" });
    });
  }
}

function locatePublicNodeFromCitation(nodeId, evidenceId) {
  highlightedPublicNodeId = nodeId || null;
  highlightedPublicEvidenceId = evidenceId || null;
  renderPublicWorkspace(live.getState());
  if (galaxyScene && nodeId) {
    galaxyScene.selectNodeById(nodeId);
  }
  if (nodeId) {
    requestAnimationFrame(() => {
      const target = publicGraphNodeList?.querySelector(
        `[data-testid="public-graph-node"][data-node-id="${CSS.escape(nodeId)}"]`,
      );
      target?.scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "nearest" });
    });
  }
}

function syncGalaxyWithState(state) {
  if (!galaxyScene || state.mode !== "live") return;
  if (state.hostMode === "public" && state.publicAnalysis?.nodes?.length > 0) {
    galaxyScene.setPublicGraphData(state.publicAnalysis, {
      graphVersion: state.publicAnalysis.graphVersion ?? state.graphVersion,
      evidenceIndex: state.evidenceIndex,
      highlightedNodeId: highlightedPublicNodeId,
    });
  } else {
    galaxyScene.setGraphData(state.confirmedGraph, {
      graphVersion: state.graphVersion,
      evidenceIndex: state.evidenceIndex,
      boundFocusNodeId: state.boundFocusNodeId,
    });
  }
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
      onBindFocusNode: (nodeId) => {
        live.setBoundFocusNode(nodeId);
        toast(nodeId ? `已绑定节点焦点：${nodeId}` : "已清除节点焦点");
      },
      onLocateEvidence: (evidenceId, nodeId, opts = {}) => {
        locatePublicCitationFromGraph(evidenceId, nodeId, {
          closeGalaxy: Boolean(opts.closeGalaxy),
          scroll: Boolean(opts.closeGalaxy),
        });
      },
    });
    syncGalaxyWithState(live.getState());
  }
  return galaxyScene;
}

/* 封面星球：鼠标液态窗口露出第二层星球 */
if (planetCanvas) {
  createLiquidPlanet(
    planet,
    planetCanvas,
    new URL("./assets/planet-second.webp", import.meta.url).href
  );
}

const pageChrome = [
  document.querySelector(".topbar"),
  document.querySelector(".cover"),
  document.querySelector(".public-degrade-dock"),
  document.querySelector(".analysis"),
  document.getElementById("debateWorkspace"),
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
    } catch {
      /* 隐私模式下 localStorage 可能不可用，忽略即可 */
    }
  }
  syncChrome();
}

syncChrome();

/* 下滑后淡出信息页的“承重账单”提示 */
let wasScrolled = false;
function syncScrollCue() {
  const scrolled = window.scrollY > 40;
  if (scrolled === wasScrolled) return;
  wasScrolled = scrolled;
  body.classList.toggle("is-scrolled", scrolled);
}
addEventListener("scroll", syncScrollCue, { passive: true });
syncScrollCue();

let switching = false;
let viewSwitching = false;

toggle.addEventListener("click", () => {
  if (switching || viewSwitching) return;
  const next = root.dataset.theme === "dark" ? "light" : "dark";

  if (reduceMotion.matches || !document.startViewTransition) {
    applyTheme(next);
    return;
  }

  const rect = toggle.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const radius = Math.hypot(
    Math.max(x, innerWidth - x),
    Math.max(y, innerHeight - y),
  );

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
        },
      );
    })
    .catch(() => {});

  transition.finished.then(
    () => { switching = false; },
    () => { switching = false; },
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

/* 视角切换：封面 ⇄ 对话/信息页 */
function applyView(view) {
  body.dataset.view = view;
  planet.setAttribute(
    "aria-label",
    workbenchMode ? "打开我的三维知识星图" : (view === "info" ? "进入 Mind Galaxy" : "你的世界观星球"),
  );
  try {
    window.scrollTo({ top: 0, behavior: "instant" });
  } catch {
    window.scrollTo(0, 0);
  }
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
      },
    );
  } catch {
    delete root.dataset.vt;
    viewSwitching = false;
    applyView(view);
  }
}

/* 星球 → Mind Galaxy */
let galaxyClosing = false;
let galaxyOpener = null;

function setPageInert(on) {
  for (const el of pageChrome) el.inert = on;
}

function beginGalaxyReveal(pointId) {
  setPageInert(true);
  galaxy.setAttribute("aria-hidden", "false");
  galaxy.classList.remove("closing");
  void galaxy.offsetWidth;
  galaxy.classList.add("on");
  const scene = ensureGalaxy();
  syncGalaxyWithState(live.getState());
  scene.start();
  const focus = pointId && scene.selectNodeById(pointId) ? cardClose : galaxyBack;
  focus.focus({ preventScroll: true });
}

function cleanupBlackHole() {
  for (const id of bhTimers) clearTimeout(id);
  bhTimers = [];
  for (const anim of bhAnimations) {
    try {
      anim.cancel();
    } catch {
      // 忽略
    }
  }
  bhAnimations = [];
  bhActive = false;
  body.classList.remove("bh-active");
  blackHole.classList.remove("on", "vanish");
  if (!galaxy.classList.contains("on")) setPageInert(false);
}

function playBlackHole(cx, cy, pointId) {
  bhActive = true;
  setPageInert(true);
  root.style.setProperty("--bhx", `${cx}px`);
  root.style.setProperty("--bhy", `${cy}px`);

  body.classList.add("bh-active");
  blackHole.classList.remove("vanish");
  blackHole.classList.add("on");

  const targets = [
    document.querySelector(".topbar-left"),
    document.querySelector(".topbar-right"),
    document.querySelector(".galaxy-label"),
    document.querySelector(".info"),
    document.querySelector(".scroll-cue"),
    document.querySelector(".foot"),
    document.querySelector(".orbit"),
  ].filter(Boolean);

  const planetAnim = planet.animate(
    [
      { transform: "scale(1)", filter: "brightness(1)", opacity: 1 },
      { transform: "scale(.86)", filter: "brightness(.75)", opacity: 1, offset: 0.3 },
      { transform: "scale(.03)", filter: "brightness(.2) blur(3px)", opacity: 0.9 },
    ],
    { duration: 780, easing: "cubic-bezier(.5,0,.9,.35)", fill: "forwards" },
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
        { translate: "0 0", rotate: "0deg", scale: "1", opacity: 1, filter: "blur(0)" },
        {
          translate: `${dx * 0.6}px ${dy * 0.6}px`,
          rotate: `${angle * 0.55}deg`,
          scale: ".55",
          opacity: 0.65,
          filter: "blur(1px)",
          offset: 0.6,
        },
        {
          translate: `${dx}px ${dy}px`,
          rotate: `${angle}deg`,
          scale: ".04",
          opacity: 0,
          filter: "blur(4px)",
        },
      ],
      {
        duration: 850,
        delay: i * 35,
        easing: "cubic-bezier(.45,0,.9,.4)",
        fill: "forwards",
      },
    );
    bhAnimations.push(anim);
  });

  bhTimers.push(
    setTimeout(() => {
      if (!bhActive) return;
      beginGalaxyReveal(pointId);
      blackHole.classList.remove("on");
      blackHole.classList.add("vanish");
    }, 1000),
  );

  bhTimers.push(
    setTimeout(() => {
      body.classList.remove("bh-active");
    }, 1600),
  );
}

function openGalaxy(initialPoint) {
  if (viewSwitching || switching || bhActive || galaxy.classList.contains("on")) {
    return;
  }

  const pointId = typeof initialPoint === "string" ? initialPoint : null;
  galaxyOpener = document.activeElement;
  const rect = planet.getBoundingClientRect();
  const cx = rect.width ? rect.left + rect.width / 2 : innerWidth / 2;
  const cy = rect.height ? rect.top + rect.height / 2 : innerHeight / 2;
  const radius = Math.hypot(
    Math.max(cx, innerWidth - cx),
    Math.max(cy, innerHeight - cy),
  );
  galaxy.style.setProperty("--gx", `${cx}px`);
  galaxy.style.setProperty("--gy", `${cy}px`);
  galaxy.style.setProperty("--gr", `${radius + 6}px`);

  if (!reduceMotion.matches && window.scrollY < 160 && body.dataset.hostMode !== "public") {
    playBlackHole(cx, cy, pointId);
  } else {
    beginGalaxyReveal(pointId);
  }
}

function closeGalaxy() {
  if (bhActive && !galaxy.classList.contains("on")) {
    cleanupBlackHole();
    galaxyOpener?.focus({ preventScroll: true });
    return;
  }
  if (!galaxy.classList.contains("on") || galaxyClosing) return;
  galaxyClosing = true;
  if (galaxyScene) galaxyScene.stop();
  cleanupBlackHole();
  galaxy.classList.add("closing");
  setTimeout(() => {
    galaxy.classList.remove("on", "closing");
    setPageInert(false);
    const returnFocus = galaxyOpener?.isConnected && galaxyOpener !== document.body
      ? galaxyOpener : (workbenchMode && body.dataset.view === "info" ? document.getElementById("galaxy-tab") : planet);
    returnFocus.focus({ preventScroll: true });
    galaxy.setAttribute("aria-hidden", "true");
    galaxyClosing = false;
  }, 470);
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (galaxy.classList.contains("on") || bhActive) {
    closeGalaxy();
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

async function copyPlainText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/* ---------- 宿主模式外壳渲染（启动握手完成即可生效，不依赖先创建会话） ---------- */
function renderHostModeChrome(state) {
  const isPublic = state.hostMode === "public";
  body.dataset.hostMode = state.hostMode || "static";

  if (publicCoverIntro) publicCoverIntro.hidden = !isPublic;
  if (demoCoverIntro) demoCoverIntro.hidden = isPublic;

  if (aboutLinePrimary && aboutLineSecondary) {
    if (isPublic) {
      aboutLinePrimary.textContent = "把你想写的那句话放在这里。我们会去知乎公开讨论里翻看相关材料，挑出会影响判断的依据，和你一起斟酌怎么说更稳妥。";
      aboutLineSecondary.textContent = "公开材料始终保留原作者，只用于本次讨论；报价是一张帮你看清边界的星图，不是判决书。";
    } else {
      aboutLinePrimary.textContent = "合成演示模式通过本机同源 /v1 服务运行，使用合成材料演示拆焦点、核证据、算承重、改写对比与撤回。";
      aboutLineSecondary.textContent = "正式版只读取你本人授权的内容。报价是一张估算图，不是判决书。";
    }
  }

  if (isPublic) {
    if (infoNameEl) {
      const claim = state.publicAnalysis?.claimText || state.activeTurnUserText || state.lastSubmittedText;
      infoNameEl.textContent = claim
        ? (claim.length > 26 ? `「${claim.slice(0, 26)}…」` : `「${claim}」`)
        : "正在听你说";
    }
    if (infoMetaEl) {
      const citeCount = state.publicAnalysis?.citations?.length || 0;
      infoMetaEl.textContent = citeCount > 0
        ? `已找到 ${citeCount} 条相关公开依据 · 点击星球可进入三维星图`
        : "知乎公开讨论核验 · 无需登录";
    }
    if (infoHintEl) {
      infoHintEl.textContent = "点一下星球可以进入三维星图";
    }
    if (scrollCueLabel) scrollCueLabel.textContent = "查看对话与星图";
  }

  renderPublicDegradeBanner(state);
}

/* ---------- 公开模式：温和降级与异常恢复提示栏 ---------- */
function renderPublicDegradeBanner(state) {
  if (!publicDegradeDock || !publicDegradeBanner) return;
  if (state.hostMode !== "public") {
    publicDegradeDock.hidden = true;
    return;
  }

  const runtimeErr = state.error || state.lastFailedTurn?.error || null;
  const capIssue = state.capabilityIssue || null;
  const boundary = state.publicAnalysis?.materialBoundary || null;
  const boundaryState = boundary?.searchStatus || boundary?.state || "ok";
  const boundaryIsUpstreamError = boundary && ["not_configured", "auth_error", "rate_limited", "timeout", "error"].includes(boundaryState);

  const shouldShow = Boolean(!degradeDismissed && (runtimeErr || capIssue || boundaryIsUpstreamError));
  publicDegradeDock.hidden = !shouldShow;
  if (!shouldShow) return;

  let title = "这次没能查到资料";
  let message = "你的原句还在这里，等一下可以再试。";
  let showDemoSwitch = false;

  if (runtimeErr) {
    const gentle = formatGentleError(runtimeErr);
    title = gentle.title;
    message = gentle.message;
    showDemoSwitch = gentle.suggestDemo || Boolean(capIssue);
  } else if (boundaryIsUpstreamError) {
    if (boundary.state === "not_configured") {
      title = "服务端还没有配好公开检索";
      message = boundary.message || "你的原句还在这里。配好检索服务后可以再试，也可以自己切换到离线合成体验。";
      showDemoSwitch = true;
    } else if (boundary.state === "rate_limited") {
      title = "查资料的通道这会儿有点忙";
      message = boundary.message || "你的原句还在这里，过一小会儿再试一次就好。";
    } else {
      title = "这次等待资料的时间有点长";
      message = boundary.message || "你的原句还在这里，等一下可以再试。";
    }
  } else if (capIssue) {
    title = capIssue.title;
    message = capIssue.message;
    showDemoSwitch = true;
  }

  if (publicDegradeTitle) publicDegradeTitle.textContent = title;
  if (publicDegradeText) publicDegradeText.textContent = message;

  const savedText = state.lastFailedTurn?.text || state.lastSubmittedText || "";
  if (publicDegradeSaved) {
    if (savedText && (runtimeErr || boundaryIsUpstreamError)) {
      publicDegradeSaved.textContent = `保留的原句：「${savedText}」`;
      publicDegradeSaved.hidden = false;
    } else {
      publicDegradeSaved.textContent = "";
      publicDegradeSaved.hidden = true;
    }
  }

  if (publicSwitchDemoHint) {
    publicSwitchDemoHint.hidden = !showDemoSwitch;
    if (showDemoSwitch && capIssue?.demoHint) {
      publicSwitchDemoHint.textContent = capIssue.demoHint;
    }
  }
  if (publicSwitchDemoBtn) {
    publicSwitchDemoBtn.hidden = !showDemoSwitch;
  }
  if (publicRetryBtn) {
    const isBusy = state.turnStatus === "running" || state.loading || state.syncStatus === "syncing";
    publicRetryBtn.disabled = isBusy;
    publicRetryBtn.textContent = state.lastFailedTurn?.text ? "用原句再试一次" : "再试一次";
  }
}

/* ---------- 公开模式：对话流、核验出处、关系变化、可编辑改写、双向星图 ---------- */
function renderPublicCitationCard(citation, state) {
  const evId = citation.evidenceId;
  const isExpanded = expandedPublicCitationIds.has(evId);
  const isHighlighted = Boolean(
    (highlightedPublicEvidenceId && highlightedPublicEvidenceId === evId)
    || (highlightedPublicNodeId && citation.nodeId && highlightedPublicNodeId === citation.nodeId),
  );

  const item = document.createElement("div");
  item.className = `public-citation-item${isHighlighted ? " is-highlighted" : ""}`;
  item.setAttribute("data-testid", "public-citation-item");
  item.dataset.evidenceId = evId;
  if (citation.nodeId) item.dataset.nodeId = citation.nodeId;
  item.dataset.highlighted = String(isHighlighted);

  const head = document.createElement("div");
  head.className = "public-citation-head";

  const summary = document.createElement("div");
  summary.className = "public-citation-summary";

  const relBadge = document.createElement("span");
  relBadge.className = `public-rel-badge is-${citation.relation || "unknown"}`;
  relBadge.textContent = citation.relationLabel || getRelationLabel(citation.relation);

  const authorSpan = document.createElement("span");
  authorSpan.className = "public-citation-author";
  authorSpan.textContent = citation.author || "公开作者";

  const shortTitle = document.createElement("span");
  shortTitle.className = "public-citation-short-title";
  shortTitle.textContent = citation.title || "公开讨论片段";

  summary.append(relBadge, authorSpan, shortTitle);

  const btns = document.createElement("div");
  btns.className = "public-citation-btns";

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "inline-mini-btn";
  toggleBtn.setAttribute("data-testid", "toggle-citation-btn");
  toggleBtn.setAttribute("aria-expanded", String(isExpanded));
  toggleBtn.textContent = isExpanded ? "收起出处" : "看看出处";
  toggleBtn.addEventListener("click", () => {
    if (expandedPublicCitationIds.has(evId)) expandedPublicCitationIds.delete(evId);
    else expandedPublicCitationIds.add(evId);
    renderPublicWorkspace(live.getState());
  });
  btns.append(toggleBtn);

  const hasMatchingGraphNode = Boolean(
    citation.nodeId
    && state.publicAnalysis?.nodes?.some((n) => n.id === citation.nodeId),
  );
  if (hasMatchingGraphNode) {
    const locateBtn = document.createElement("button");
    locateBtn.type = "button";
    locateBtn.className = "inline-mini-btn";
    locateBtn.setAttribute("data-testid", "locate-node-btn");
    locateBtn.textContent = "在星图里看它";
    locateBtn.addEventListener("click", () => {
      locatePublicNodeFromCitation(citation.nodeId, evId);
    });
    btns.append(locateBtn);
  }

  head.append(summary, btns);
  item.append(head);

  const detail = document.createElement("div");
  detail.className = "citation-detail";
  detail.setAttribute("data-testid", "citation-detail");
  detail.hidden = !isExpanded;

  const titleP = document.createElement("p");
  titleP.className = "citation-detail-title";
  titleP.textContent = citation.title || "公开讨论";

  const authorP = document.createElement("p");
  authorP.className = "citation-detail-author";
  authorP.textContent = `原作者：${citation.author || "公开作者"}（公开讨论，非本人立场）`;

  const quoteEl = document.createElement("blockquote");
  quoteEl.className = "citation-detail-quote";
  quoteEl.textContent = citation.quote || citation.excerpt || "（暂无摘要片段）";

  detail.append(titleP, authorP, quoteEl);

  if (citation.reason) {
    const reasonP = document.createElement("p");
    reasonP.className = "citation-detail-reason";
    reasonP.textContent = citation.reason;
    detail.append(reasonP);
  }

  if (citation.url) {
    const link = document.createElement("a");
    link.className = "evidence-link";
    link.href = citation.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "查看知乎原文 ↗";
    detail.append(link);
  }

  item.append(detail);
  return item;
}

function renderPublicDialogueFeed(state) {
  if (!publicDialogueFeed) return;
  publicDialogueFeed.replaceChildren();

  const history = Array.isArray(state.conversationHistory) ? state.conversationHistory : [];
  const isRunning = state.turnStatus === "running" || state.syncStatus === "syncing";

  // 合并已持久化历史轮次 + 尚未写入快照的当前进行中轮次
  const displayTurns = history.map((item) => ({ ...item, isLiveStreaming: false }));
  const runningInHistoryIdx = state.activeTurnId
    ? displayTurns.findIndex((t) => t.turnId === state.activeTurnId)
    : -1;

  if (isRunning) {
    if (runningInHistoryIdx >= 0) {
      displayTurns[runningInHistoryIdx] = {
        ...displayTurns[runningInHistoryIdx],
        status: state.turnStatus,
        userText: displayTurns[runningInHistoryIdx].userText || state.activeTurnUserText || state.lastSubmittedText,
        focus: state.currentFocus || displayTurns[runningInHistoryIdx].focus,
        replyText: state.explanationText || displayTurns[runningInHistoryIdx].replyText,
        isLiveStreaming: true,
      };
    } else if (state.activeTurnUserText || state.explanationText || state.syncStatus === "syncing") {
      displayTurns.push({
        turnId: state.activeTurnId || state.pendingSyncTurnId || "live_turn",
        status: state.turnStatus,
        userText: state.activeTurnUserText || state.lastSubmittedText,
        focus: state.currentFocus,
        replyText: state.explanationText,
        citations: [],
        isLiveStreaming: true,
      });
    }
  }

  if (displayTurns.length === 0) {
    const empty = document.createElement("div");
    empty.className = "public-empty-feed";
    empty.textContent = "把你想写的那句话放在下面。我们一起看看，哪里有依据，哪里还想再斟酌一下。";
    publicDialogueFeed.append(empty);
    return;
  }

  displayTurns.forEach((turn, idx) => {
    const isLastTurn = idx === displayTurns.length - 1;
    const card = document.createElement("article");
    card.className = "public-turn-card";
    card.setAttribute("data-testid", "public-turn-card");
    card.dataset.turnId = turn.turnId || String(idx + 1);
    card.dataset.status = turn.status || "committed";

    if (turn.userText) {
      const userQuote = document.createElement("blockquote");
      userQuote.className = "public-user-quote";
      userQuote.textContent = turn.userText;
      card.append(userQuote);
    }

    if (turn.focus?.spanText || (turn.isLiveStreaming && state.currentStage)) {
      const focusRow = document.createElement("div");
      focusRow.className = "public-focus-row";

      if (turn.focus?.spanText) {
        const pill = document.createElement("span");
        pill.className = "public-focus-pill";
        pill.setAttribute("data-testid", "public-focus-pill");
        const rawSpan = String(turn.focus.spanText);
        const displaySpan = rawSpan.length > 18 ? `${rawSpan.slice(0, 16)}…` : rawSpan;
        pill.textContent = `先看看「${displaySpan}」`;
        if (rawSpan.length > 18) pill.title = rawSpan;
        focusRow.append(pill);
      }

      if (turn.isLiveStreaming && (state.currentStage || state.syncStatus === "syncing")) {
        const stageEl = document.createElement("p");
        stageEl.className = "public-stage-hint";
        stageEl.textContent = state.syncStatus === "syncing"
          ? "正在整理这一轮的依据和星图…"
          : (PUBLIC_STAGE_LABELS[state.currentStage] || "正在翻看相关讨论…");
        focusRow.append(stageEl);
      }

      card.append(focusRow);
    }

    // 等待/检索/整理阶段的动态呼吸星轨条：让等待过程有节奏感，不显得干等或无聊
    if (turn.isLiveStreaming && !turn.replyText) {
      const stageKey = state.syncStatus === "syncing" ? "syncing" : (state.currentStage || "checking_local_graph");
      const activeIdx = stageKey === "checking_local_graph"
        ? 0
        : (stageKey === "retrieving_evidence" ? 1 : (stageKey === "verifying_candidates" ? 2 : 3));
      const steps = [
        "先读懂你这句话",
        "去知乎翻找公开讨论",
        "挑出能对得上的依据",
        "正在组织温和回复",
      ];

      const progressWrap = document.createElement("div");
      progressWrap.className = "public-live-orbit";
      progressWrap.setAttribute("data-testid", "public-live-orbit");
      progressWrap.setAttribute("aria-live", "polite");

      const orb = document.createElement("span");
      orb.className = "public-live-orb";
      orb.setAttribute("aria-hidden", "true");

      const stepList = document.createElement("div");
      stepList.className = "public-live-steps";
      steps.forEach((label, sIdx) => {
        const chip = document.createElement("span");
        chip.className = `public-live-step${sIdx < activeIdx ? " is-done" : (sIdx === activeIdx ? " is-active" : "")}`;
        chip.textContent = label;
        stepList.append(chip);
      });

      progressWrap.append(orb, stepList);
      card.append(progressWrap);
    }

    const replyEl = document.createElement("div");
    replyEl.className = `public-reply-text${turn.isLiveStreaming && turn.replyText ? " is-streaming" : ""}`;
    if (isLastTurn) {
      replyEl.setAttribute("data-testid", "public-stream-reply");
    }
    if (turn.replyText) {
      replyEl.textContent = turn.replyText;
    } else if (turn.isLiveStreaming) {
      replyEl.classList.add("is-waiting");
      replyEl.textContent = turn.focus?.spanText
        ? `我先看看「${turn.focus.spanText}」。如果能找到一个例外，这句话就有再推敲的地方。`
        : "先顺着你这句话去翻翻公开讨论，马上回来跟你聊…";
    } else if (turn.status === "cancelled") {
      replyEl.textContent = "这一轮已经先停下来了。你可以修改一下句子，或者随时再继续。";
    } else if (turn.status === "failed") {
      replyEl.textContent = "这一轮没能顺利拿到结果。你的原句还在这里，等一下可以再试。";
    } else {
      replyEl.textContent = "这一轮已经整理好。";
    }
    card.append(replyEl);

    // 紧挨回复展示本轮精选的核验出处（默认收起，点击「看看出处」再展开）
    const citations = Array.isArray(turn.citations) ? turn.citations : [];
    if (citations.length > 0 && !turn.isLiveStreaming) {
      const citesWrap = document.createElement("div");
      citesWrap.className = "public-citations-wrap";

      const label = document.createElement("p");
      label.className = "public-citations-label";
      label.textContent = `这一轮挑出的依据（${citations.length} 条）`;
      citesWrap.append(label);

      for (const citation of citations) {
        citesWrap.append(renderPublicCitationCard(citation, state));
      }
      card.append(citesWrap);
    }

    publicDialogueFeed.append(card);
  });
}

function renderPublicChangeAndBoundary(state) {
  const pa = state.publicAnalysis;

  // 图上变化一句说清 + 关系对比（仅在有改写/纠错变化或已有多轮对照时展示，首轮不误标“这一改，哪里变了”）
  if (publicChangeCard && publicChangeSummary && publicRelationChanges) {
    const hasSummary = Boolean(pa?.changeSummary);
    const changes = Array.isArray(pa?.relationChanges) ? pa.relationChanges : [];
    const hasComparisonHistory = Array.isArray(pa?.statementHistory) && pa.statementHistory.length >= 2;
    const showChange = changes.length > 0 || (hasSummary && hasComparisonHistory);
    publicChangeCard.hidden = !showChange;
    if (showChange) {
      publicChangeSummary.textContent = pa?.changeSummary
        || "在同一批公开依据下，换一种说法后的关系变化如下：";
      publicRelationChanges.replaceChildren();
      publicRelationChanges.hidden = changes.length === 0;
      for (const item of changes) {
        const row = document.createElement("div");
        row.className = `public-change-row${item.changed ? " is-changed" : ""}`;

        const left = document.createElement("div");
        left.textContent = item.author ? `${item.author} · ${item.title}` : item.title;

        const right = document.createElement("div");
        right.className = "public-change-arrow";

        const beforeBadge = document.createElement("span");
        beforeBadge.className = `public-rel-badge is-${item.before || "unknown"}`;
        beforeBadge.textContent = item.beforeLabel;

        const arrow = document.createElement("span");
        arrow.textContent = "→";

        const afterBadge = document.createElement("span");
        afterBadge.className = `public-rel-badge is-${item.after || "unknown"}`;
        afterBadge.textContent = item.afterLabel;

        right.append(beforeBadge, arrow, afterBadge);
        row.append(left, right);
        publicRelationChanges.append(row);
      }
    }
  }

  // 材料边界与未知留白
  if (publicUnknownBox && publicUnknownText && publicUnknownList) {
    const mb = pa?.materialBoundary || null;
    const unknowns = Array.isArray(pa?.unknowns) ? pa.unknowns : [];
    const hasCommittedTurn = state.turns.some((t) => t.status === "committed");
    const isEmptyEvidence = Boolean(
      hasCommittedTurn
      && pa
      && (pa.citations?.length || 0) === 0
      && (!mb || mb.state === "empty" || mb.state === "ok"),
    );
    const showUnknown = Boolean(
      unknowns.length > 0
      || (mb && mb.state === "empty")
      || (mb && mb.message && mb.state === "ok" && unknowns.length > 0)
      || isEmptyEvidence,
    );

    publicUnknownBox.hidden = !showUnknown;
    if (showUnknown) {
      publicUnknownText.textContent = mb?.message
        || "我找到了一些相近的说法，还缺一条能直接回答你这个问题的证据。这句先留着，我们可以一起把范围说清。";
      publicUnknownList.replaceChildren();
      publicUnknownList.hidden = unknowns.length === 0;
      for (const u of unknowns) {
        const li = document.createElement("li");
        li.textContent = u;
        publicUnknownList.append(li);
      }
    }
  }
}

function renderPublicRewriteCard(state) {
  if (!publicRewriteCard || !publicRewriteEditor) return;
  const pa = state.publicAnalysis;
  const sr = pa?.suggestedRewrite || null;
  const hasCommittedTurn = state.turns.some((t) => t.status === "committed");
  const isBusy = state.turnStatus === "running" || state.loading || state.syncStatus === "syncing";

  if (!sr && !hasCommittedTurn) {
    publicRewriteCard.hidden = true;
    return;
  }

  publicRewriteCard.hidden = false;
  const rewriteSyncKey = `${state.sessionId || ""}:${pa?.graphVersion ?? state.graphVersion}:${pa?.turnId || ""}:${sr?.text || ""}`;
  if (rewriteSyncKey !== lastSyncedRewriteKey) {
    lastSyncedRewriteKey = rewriteSyncKey;
    if (sr?.text) {
      publicRewriteEditor.value = sr.text;
    } else if (!publicRewriteEditor.value.trim() && pa?.claimText) {
      publicRewriteEditor.value = pa.claimText;
    }
  }

  if (publicRewriteExplain) {
    publicRewriteExplain.textContent = sr?.explanation
      || "原来那层担心可以留着。试着把范围说得更具体一点，再看看同一批依据会怎么回应。";
  }

  if (publicRewriteNotes) {
    publicRewriteNotes.replaceChildren();
    const notes = [];
    if (sr?.preserved) notes.push(`保留了：${sr.preserved}`);
    if (sr?.narrowed) notes.push(`收窄了：${sr.narrowed}`);
    publicRewriteNotes.hidden = notes.length === 0;
    for (const note of notes) {
      const span = document.createElement("span");
      span.className = "public-rewrite-note-pill";
      span.textContent = note;
      publicRewriteNotes.append(span);
    }
  }

  if (tryRewriteBtn) {
    tryRewriteBtn.disabled = isBusy;
  }
}

function renderPublicGraphSvg(nodes, edges) {
  if (!publicGraphSvg) return;
  const SVG_NS = "http://www.w3.org/2000/svg";
  publicGraphSvg.replaceChildren();
  if (!Array.isArray(nodes) || nodes.length === 0) return;

  const W = 360;
  const H = 250;
  const cx = W / 2;
  const cy = H / 2;
  const claimNode = nodes.find((n) => n.kind === "claim") || nodes[0];
  const others = nodes.filter((n) => n.id !== claimNode.id);

  const posById = new Map();
  posById.set(claimNode.id, { x: cx, y: cy });
  others.forEach((n, i) => {
    const angle = (-Math.PI / 2) + (i * Math.PI * 2) / Math.max(1, others.length);
    const rx = others.length <= 2 ? 105 : 118;
    const ry = others.length <= 2 ? 64 : 84;
    posById.set(n.id, {
      x: cx + Math.cos(angle) * rx,
      y: cy + Math.sin(angle) * ry,
    });
  });

  const relStroke = {
    supports: "#74d9a8",
    refutes: "#ff8e7a",
    qualifies: "#8bbcff",
    unknown: "#9aa6be",
  };

  // 画连线
  const drawnPairs = new Set();
  const edgeList = edges.length > 0
    ? edges
    : others.map((n) => ({ from: n.id, to: claimNode.id, relation: n.relation || "unknown" }));
  for (const edge of edgeList) {
    const p1 = posById.get(edge.from);
    const p2 = posById.get(edge.to);
    if (!p1 || !p2) continue;
    const key = [edge.from, edge.to].sort().join("--");
    if (drawnPairs.has(key)) continue;
    drawnPairs.add(key);

    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", p1.x.toFixed(1));
    line.setAttribute("y1", p1.y.toFixed(1));
    line.setAttribute("x2", p2.x.toFixed(1));
    line.setAttribute("y2", p2.y.toFixed(1));
    const isHigh = highlightedPublicNodeId && (edge.from === highlightedPublicNodeId || edge.to === highlightedPublicNodeId);
    line.setAttribute("stroke", isHigh ? "#ffd27a" : (relStroke[edge.relation] || relStroke.unknown));
    line.setAttribute("stroke-opacity", isHigh ? "0.95" : "0.55");
    line.setAttribute("stroke-width", isHigh ? "2.2" : "1.4");
    publicGraphSvg.append(line);
  }

  // 画节点
  for (const node of nodes) {
    const p = posById.get(node.id);
    if (!p) continue;
    const isClaim = node.id === claimNode.id;
    const isHigh = Boolean(
      (highlightedPublicNodeId && highlightedPublicNodeId === node.id)
      || (highlightedPublicEvidenceId && node.evidenceId === highlightedPublicEvidenceId),
    );
    const fill = isClaim ? "#ffd27a" : (relStroke[node.relation] || relStroke.unknown);

    const g = document.createElementNS(SVG_NS, "g");
    g.style.cursor = "pointer";

    if (isHigh || isClaim) {
      const halo = document.createElementNS(SVG_NS, "circle");
      halo.setAttribute("cx", p.x.toFixed(1));
      halo.setAttribute("cy", p.y.toFixed(1));
      halo.setAttribute("r", isClaim ? "17" : "14");
      halo.setAttribute("fill", fill);
      halo.setAttribute("fill-opacity", isHigh ? "0.28" : "0.18");
      g.append(halo);
    }

    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", p.x.toFixed(1));
    dot.setAttribute("cy", p.y.toFixed(1));
    dot.setAttribute("r", isClaim ? "8" : "5.5");
    dot.setAttribute("fill", fill);
    if (isHigh) {
      dot.setAttribute("stroke", "#ffffff");
      dot.setAttribute("stroke-width", "1.8");
    }
    g.append(dot);

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", p.x.toFixed(1));
    label.setAttribute("y", (p.y + (isClaim ? 22 : 18)).toFixed(1));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("fill", isHigh ? "#ffd27a" : "rgba(232,236,244,0.82)");
    label.setAttribute("font-size", "10.5");
    const shortName = isClaim
      ? "当前句子"
      : (node.author || node.label || "依据").slice(0, 8);
    label.textContent = shortName;
    g.append(label);

    g.addEventListener("click", () => {
      if (node.evidenceId) {
        locatePublicCitationFromGraph(node.evidenceId, node.id, { scroll: true });
      } else {
        highlightedPublicNodeId = node.id;
        highlightedPublicEvidenceId = null;
        renderPublicWorkspace(live.getState());
      }
    });

    publicGraphSvg.append(g);
  }
}

function renderPublicGraphPanel(state) {
  if (!publicGraphPanel || !publicGraphNodeList) return;
  const pa = state.publicAnalysis;
  const nodes = Array.isArray(pa?.nodes) ? pa.nodes : [];
  const edges = Array.isArray(pa?.edges) ? pa.edges : [];
  const panelVersion = pa?.graphVersion ?? state.graphVersion ?? 0;

  publicGraphPanel.dataset.graphVersion = String(panelVersion);

  if (publicGraphEmpty) {
    publicGraphEmpty.hidden = nodes.length > 0;
  }
  if (publicGraphSub) {
    const evNodes = nodes.filter((n) => n.kind !== "claim");
    publicGraphSub.textContent = evNodes.length > 0
      ? `点开任一条依据，可以和左侧出处互相定位（共 ${evNodes.length} 条依据）。`
      : "只放这一轮真正相关的依据，点一颗星就能看到出处。";
  }

  renderPublicGraphSvg(nodes, edges);

  publicGraphNodeList.replaceChildren();
  for (const node of nodes) {
    const isHighlighted = Boolean(
      (highlightedPublicNodeId && highlightedPublicNodeId === node.id)
      || (highlightedPublicEvidenceId && node.evidenceId === highlightedPublicEvidenceId),
    );
    const li = document.createElement("li");
    li.className = "public-graph-node-item";
    li.setAttribute("data-testid", "public-graph-node");
    li.dataset.nodeId = node.id;
    if (node.evidenceId) li.dataset.evidenceId = node.evidenceId;
    li.dataset.highlighted = String(isHighlighted);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "public-graph-node-btn";

    const top = document.createElement("div");
    top.className = "public-graph-node-top";

    const labelSpan = document.createElement("span");
    labelSpan.className = "public-graph-node-label";
    labelSpan.textContent = node.kind === "claim"
      ? "当前讨论的句子"
      : (node.author ? `${node.author} · ${node.label}` : node.label);

    const relSpan = document.createElement("span");
    relSpan.className = `public-rel-badge is-${node.kind === "claim" ? "unknown" : (node.relation || "unknown")}`;
    relSpan.textContent = node.kind === "claim" ? "主张" : (node.relationLabel || "待定");

    top.append(labelSpan, relSpan);

    const snippetP = document.createElement("p");
    snippetP.className = "public-graph-node-snippet";
    const fullText = node.text || node.label || "";
    snippetP.textContent = fullText.length > 56 ? `${fullText.slice(0, 56)}…` : fullText;

    btn.append(top, snippetP);
    btn.addEventListener("click", () => {
      if (node.evidenceId) {
        locatePublicCitationFromGraph(node.evidenceId, node.id, { scroll: true });
      } else {
        highlightedPublicNodeId = node.id;
        highlightedPublicEvidenceId = null;
        renderPublicWorkspace(live.getState());
      }
    });

    li.append(btn);
    publicGraphNodeList.append(li);
  }

  // 右侧星图节点详情卡（点击节点时展示原作者、摘要片段与原文链接）
  if (publicGraphNodeDetail) {
    const selectedNode = highlightedPublicNodeId
      ? nodes.find((n) => n.id === highlightedPublicNodeId) || null
      : null;
    if (!selectedNode) {
      publicGraphNodeDetail.hidden = true;
    } else {
      publicGraphNodeDetail.hidden = false;
      if (publicGraphDetailRel) {
        publicGraphDetailRel.className = `public-rel-badge is-${selectedNode.kind === "claim" ? "unknown" : (selectedNode.relation || "unknown")}`;
        publicGraphDetailRel.textContent = selectedNode.kind === "claim" ? "当前句子" : (selectedNode.relationLabel || "待定");
      }
      if (publicGraphDetailAuthor) {
        publicGraphDetailAuthor.textContent = selectedNode.kind === "claim"
          ? "你正在斟酌的这句话"
          : `原作者：${selectedNode.author || "公开作者"}`;
      }
      if (publicGraphDetailText) {
        publicGraphDetailText.textContent = selectedNode.text || selectedNode.label || "";
      }
      if (publicGraphDetailLink) {
        if (selectedNode.url) {
          publicGraphDetailLink.href = selectedNode.url;
          publicGraphDetailLink.hidden = false;
        } else {
          publicGraphDetailLink.removeAttribute("href");
          publicGraphDetailLink.hidden = true;
        }
      }
    }
  }
}

function renderPublicWorkspace(state) {
  if (state.hostMode !== "public") return;

  if (publicDialogueSection) publicDialogueSection.hidden = false;
  if (workbenchSection) workbenchSection.hidden = true;

  if (publicWorkspaceSub) {
    publicWorkspaceSub.textContent = state.publicAnalysis?.citations?.length
      ? "找到的公开资料保留原作者，点开「看看出处」就能核对原文与片段。"
      : "我们一起从最关键的那个词看起，找到的公开资料会保留原作者。";
  }

  renderPublicDialogueFeed(state);
  renderPublicChangeAndBoundary(state);
  renderPublicRewriteCard(state);
  renderPublicGraphPanel(state);

  const isBusy = state.turnStatus === "running" || state.loading || state.busyAction || state.syncStatus === "syncing";
  const canCancel = Boolean(state.activeTurnId) && state.turnStatus === "running";
  if (publicFollowupSubmit) publicFollowupSubmit.disabled = isBusy;
  if (publicCancelBtn) publicCancelBtn.disabled = !canCancel;
  if (publicHomeSubmit) publicHomeSubmit.disabled = isBusy;
  if (publicNewTopicBtn) publicNewTopicBtn.disabled = isBusy;

  // 若最近一轮失败，自动把原句放回续问输入框（若当前输入框为空），确保用户随时可改可重试
  if (state.lastFailedTurn?.text && publicFollowupInput && !publicFollowupInput.value.trim()) {
    publicFollowupInput.value = state.lastFailedTurn.text;
  }
}

/* ---------- 合成演示工作台渲染（100% 保持既有 demo 行为） ---------- */
function renderFocusPanel(focus) {
  if (!focusPanel) return;
  focusPanel.replaceChildren();
  if (!focus) {
    const p = document.createElement("p");
    p.className = "focus-empty";
    p.textContent = "提交句子后，此处会先展示系统拆解出的焦点词与原因。";
    focusPanel.append(p);
    return;
  }

  const head = document.createElement("div");
  head.className = "focus-head";

  const spanBadge = document.createElement("span");
  spanBadge.className = "focus-span";
  spanBadge.textContent = `焦点：「${focus.spanText || "—"}」`;

  const kindBadge = document.createElement("span");
  kindBadge.className = "focus-kind mono";
  kindBadge.textContent = focus.nodeId ? `${focus.kind || "node"} · ${focus.nodeId}` : (focus.kind || "premise");

  head.append(spanBadge, kindBadge);

  const reason = document.createElement("p");
  reason.className = "focus-reason";
  reason.textContent = focus.reason || "";

  focusPanel.append(head, reason);
}

function renderWorkbenchNodeCard(state) {
  if (!workbenchNodeCard) return;
  const node = selectedWorkbenchNodeId
    ? state.confirmedGraph.find((n) => n.id === selectedWorkbenchNodeId) || null
    : null;
  if (!node) {
    workbenchNodeCard.hidden = true;
    return;
  }
  workbenchNodeCard.hidden = false;
  wbNodeId.textContent = `节点 ${node.id}`;
  wbNodeText.textContent = node.text;
  const depCount = Array.isArray(node.deps) ? node.deps.length : 0;
  wbNodeMeta.textContent = `承重 S=${node.S ?? 0} · 深度 d=${node.d ?? 0} · 依赖 ${depCount} 条 · v${state.graphVersion}`;

  const evIds = Array.isArray(node.evidenceIds) ? node.evidenceIds : [];
  if (evIds.length > 0) {
    const evMap = new Map(state.evidenceIndex.map((e) => [e.id || e.evidenceId, e]));
    wbNodeEvidence.textContent = `关联证据：${evIds.map((id) => {
      const ev = evMap.get(id);
      return ev ? `${id}（${ev.author || "self"}）` : id;
    }).join("、")}`;
    wbNodeEvidence.hidden = false;
  } else {
    wbNodeEvidence.hidden = true;
  }

  const isBound = state.boundFocusNodeId === node.id;
  bindFocusNodeBtn.textContent = isBound ? "已绑定为焦点 · 点击取消" : "以此节点为焦点";
  bindFocusNodeBtn.dataset.nodeId = node.id;
}

function renderGraphNodeList(state) {
  const nodes = state.confirmedGraph;
  if (graphNodeCount) graphNodeCount.textContent = `${nodes.length} 节点`;
  if (galaxyEmptyState) {
    galaxyEmptyState.hidden = nodes.length > 0;
    galaxyEmptyState.dataset.graphVersion = String(state.graphVersion);
    if (nodes.length === 0) {
      galaxyEmptyState.textContent = state.graphVersion > 0
        ? `当前已确认图为空（v${state.graphVersion}）。当前已确认节点已清空或撤回，可继续补充本人亲身事实，星图节点与承重账单将同步更新。`
        : `当前已确认图为空（v${state.graphVersion}）。请先输入待分析句子，再补充本人亲身事实，星图节点与承重账单将同步更新。`;
    }
  }
  if (!graphNodeList) return;

  graphNodeList.hidden = nodes.length === 0;
  graphNodeList.replaceChildren();

  for (const node of nodes) {
    const li = document.createElement("li");
    const isBound = state.boundFocusNodeId === node.id;
    const isSelected = selectedWorkbenchNodeId === node.id;
    li.className = `node-index-item${isBound ? " is-bound" : ""}${isSelected ? " is-selected" : ""}`;
    li.setAttribute("data-testid", "graph-node-item");
    li.dataset.nodeId = node.id;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "node-index-btn";

    const top = document.createElement("div");
    top.className = "node-index-top";

    const idSpan = document.createElement("span");
    idSpan.className = "mono node-index-id";
    idSpan.textContent = node.id;

    const loadSpan = document.createElement("span");
    loadSpan.className = "mono node-index-load";
    loadSpan.textContent = `承重 ${node.S ?? 0}${isBound ? " · 焦点" : ""}`;

    const textP = document.createElement("p");
    textP.className = "node-index-text";
    textP.textContent = node.text;

    top.append(idSpan, loadSpan);
    btn.append(top, textP);
    btn.addEventListener("click", () => {
      selectedWorkbenchNodeId = node.id;
      renderWorkbenchNodeCard(live.getState());
    });

    li.append(btn);
    graphNodeList.append(li);
  }

  renderWorkbenchNodeCard(state);
}

function renderEvidenceList(state) {
  if (!evidenceListEl) return;

  const pendingByEvId = new Map();
  for (const pc of state.pendingConfirmations) {
    if (pc.evidenceId) pendingByEvId.set(pc.evidenceId, pc);
  }
  const deniedIdSet = new Set(state.deniedAttributions.map((d) => d.evidenceId || d.contentKey));

  const ordered = [];
  const seen = new Set();
  const pushEv = (ev) => {
    if (!ev) return;
    const id = ev.id || ev.evidenceId;
    if (!id || seen.has(id)) return;
    seen.add(id);
    ordered.push(ev);
  };

  for (const ev of state.lastVerifiedEvidence) pushEv(ev);
  for (const pc of state.pendingConfirmations) {
    const matched = state.evidenceIndex.find((e) => (e.id || e.evidenceId) === pc.evidenceId);
    if (matched) pushEv(matched);
    else {
      pushEv({
        id: pc.evidenceId || pc.id,
        evidenceId: pc.evidenceId || pc.id,
        sourceType: "collection_record",
        title: pc.scopeText ? `待确认适用条件：${pc.scopeText}` : "候选线索",
        author: pc.author || "他人作者",
        attribution: pc.attribution || "other_author",
        excerpt: pc.text,
        contentKey: pc.contentKey,
      });
    }
  }
  for (const ev of state.evidenceIndex) pushEv(ev);

  if (evidenceCountBadge) {
    evidenceCountBadge.textContent = `${ordered.length} 条${state.pendingConfirmations.length ? ` · ${state.pendingConfirmations.length} 待确认` : ""}`;
  }

  evidenceListEl.replaceChildren();
  if (ordered.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-inline";
    p.textContent = "提交句子后，此处会展示带来源的合成采集证据与公开检索摘要。";
    evidenceListEl.append(p);
    return;
  }

  const isRunning = state.turnStatus === "running" || state.loading || state.syncStatus === "syncing";

  for (const ev of ordered.slice(0, 12)) {
    const evId = ev.id || ev.evidenceId;
    const pending = pendingByEvId.get(evId) || null;
    const isDenied = deniedIdSet.has(evId) || deniedIdSet.has(ev.contentKey) || ev.deniedSelfAttribution === true;
    const isExpanded = expandedEvidenceIds.has(evId);

    const card = document.createElement("article");
    card.className = `evidence-card${pending ? " is-pending" : ""}${isDenied ? " is-denied" : ""}`;
    card.setAttribute("data-testid", "evidence-card");
    card.dataset.evidenceId = evId;
    card.dataset.sourceType = ev.sourceType || "unknown";
    card.dataset.attribution = ev.attribution || "other_author";

    const headerBtn = document.createElement("button");
    headerBtn.type = "button";
    headerBtn.className = "evidence-card-trigger";
    headerBtn.setAttribute("aria-expanded", String(isExpanded));

    const metaRow = document.createElement("div");
    metaRow.className = "evidence-meta-row";

    const srcTag = document.createElement("span");
    srcTag.className = "ev-tag";
    srcTag.textContent = SOURCE_TYPE_LABELS[ev.sourceType] || ev.sourceType || "来源";

    const attrTag = document.createElement("span");
    attrTag.className = `ev-attr ${ev.attribution === "self" ? "is-self" : "is-other"}`;
    attrTag.textContent = ev.attribution === "self"
      ? "本人陈述"
      : (isDenied ? `已排除 · 作者 ${ev.author || "他人"}` : `他人作者 · ${ev.author || "未知"}`);

    metaRow.append(srcTag, attrTag);

    const titleEl = document.createElement("p");
    titleEl.className = "evidence-title";
    titleEl.textContent = ev.title || `证据 ${evId}`;

    const snippetEl = document.createElement("p");
    snippetEl.className = "evidence-snippet";
    const fullExcerpt = String(ev.excerpt || "");
    snippetEl.textContent = !isExpanded && fullExcerpt.length > 72
      ? `${fullExcerpt.slice(0, 72)}…`
      : fullExcerpt;

    headerBtn.append(metaRow, titleEl, snippetEl);
    headerBtn.addEventListener("click", () => {
      if (expandedEvidenceIds.has(evId)) expandedEvidenceIds.delete(evId);
      else expandedEvidenceIds.add(evId);
      renderEvidenceList(live.getState());
    });

    card.append(headerBtn);

    if (isExpanded) {
      const detail = document.createElement("div");
      detail.className = "evidence-detail";

      const idLine = document.createElement("p");
      idLine.className = "mono evidence-detail-line";
      idLine.textContent = `ID：${evId} · 内容键：${ev.contentKey || "-"} · 文本类型：${ev.textKind || "-"}`;
      detail.append(idLine);

      const fullP = document.createElement("p");
      fullP.className = "evidence-detail-excerpt";
      fullP.textContent = fullExcerpt;
      detail.append(fullP);

      if (ev.url) {
        const link = document.createElement("a");
        link.className = "evidence-link mono";
        link.href = ev.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = ev.url;
        detail.append(link);
      }

      card.append(detail);
    }

    if (pending && pending.kind === "candidate_counterexample" && !isDenied) {
      const actions = document.createElement("div");
      actions.className = "evidence-actions";

      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "inline-mini-btn";
      confirmBtn.dataset.action = "confirm-pending";
      confirmBtn.disabled = isRunning;
      confirmBtn.textContent = "确认归属为本人事实";
      confirmBtn.addEventListener("click", () => {
        live.submitTurn({
          text: `我自己也经历过类似情况：${fullExcerpt.slice(0, 80)}`,
          action: { type: "provide_self_fact" },
        });
      });

      const denyBtn = document.createElement("button");
      denyBtn.type = "button";
      denyBtn.className = "inline-mini-btn";
      denyBtn.dataset.action = "deny-pending";
      denyBtn.disabled = isRunning;
      denyBtn.textContent = "否认归属（非本人观点）";
      denyBtn.addEventListener("click", () => {
        live.submitTurn({
          text: `那条作者“${ev.author || "他人"}”的回答只是我收藏/浏览的他人观点，不是我自己说的。`,
          action: {
            type: "deny_attribution",
            targetId: evId || pending.contentKey || pending.id,
          },
        });
      });

      actions.append(confirmBtn, denyBtn);
      card.append(actions);
    }

    evidenceListEl.append(card);
  }
}

function renderFactsList(state) {
  if (!factsListEl) return;
  const facts = state.facts;
  const activeCount = facts.filter((f) => f.status === "active").length;
  if (factsCountBadge) {
    factsCountBadge.textContent = `${activeCount} 生效 / 共 ${facts.length} 条`;
  }

  factsListEl.replaceChildren();
  if (facts.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-inline";
    li.textContent = "尚无已确认的本人事实。补充本人经历后将在此显示并支持精确撤回。";
    factsListEl.append(li);
    return;
  }

  const isRunning = state.turnStatus === "running" || state.loading || state.syncStatus === "syncing";

  for (const fact of facts) {
    const isActive = fact.status === "active";
    const li = document.createElement("li");
    li.className = `fact-item${isActive ? " is-active" : " is-retracted"}`;
    li.setAttribute("data-testid", "fact-item");
    li.dataset.factId = fact.id;
    li.dataset.factStatus = isActive ? "active" : "retracted";

    const top = document.createElement("div");
    top.className = "fact-item-top";

    const idSpan = document.createElement("span");
    idSpan.className = "mono fact-id";
    idSpan.textContent = fact.id;

    const statusSpan = document.createElement("span");
    statusSpan.className = `fact-status ${isActive ? "is-active" : "is-retracted"}`;
    statusSpan.textContent = isActive ? "生效中" : "已撤回";

    top.append(idSpan, statusSpan);

    const textP = document.createElement("p");
    textP.className = "fact-text";
    textP.textContent = fact.text;

    li.append(top, textP);

    if (Array.isArray(fact.nodeIds) && fact.nodeIds.length > 0) {
      const nodesLine = document.createElement("p");
      nodesLine.className = "fact-nodes mono";
      nodesLine.textContent = `关联节点：${fact.nodeIds.join(", ")}`;
      li.append(nodesLine);
    }

    if (isActive) {
      const retractBtn = document.createElement("button");
      retractBtn.type = "button";
      retractBtn.className = "inline-mini-btn danger-outline";
      retractBtn.setAttribute("data-testid", "retract-fact-btn");
      retractBtn.dataset.factId = fact.id;
      retractBtn.disabled = isRunning;
      retractBtn.textContent = "撤回此事实";
      retractBtn.addEventListener("click", () => {
        live.submitTurn({
          text: `我撤回事实 ${fact.id}`,
          action: {
            type: "retract_fact",
            targetId: fact.id,
            factId: fact.id,
          },
        });
      });
      li.append(retractBtn);
    }

    factsListEl.append(li);
  }
}

function renderSharedSyncAndStatus(state) {
  const isPublic = state.hostMode === "public";
  const normalizedStatus = ["idle", "pending", "running", "committed", "cancelled", "failed"].includes(state.turnStatus)
    ? state.turnStatus
    : "idle";
  const syncStatus = ["idle", "syncing", "error"].includes(state.syncStatus) ? state.syncStatus : "idle";

  if (sharedStatusStrip) {
    sharedStatusStrip.hidden = state.mode !== "live" && !(isPublic && body.dataset.view === "info");
  }

  if (sessionIdLabel) {
    sessionIdLabel.textContent = state.sessionId || "未建立会话";
    sessionIdLabel.dataset.sessionId = state.sessionId || "";
  }
  if (graphVersionBadge) {
    const gv = isPublic && Number.isInteger(state.publicAnalysis?.graphVersion)
      ? state.publicAnalysis.graphVersion
      : state.graphVersion;
    graphVersionBadge.textContent = `v${gv}`;
    graphVersionBadge.dataset.graphVersion = String(gv);
  }

  if (turnStatusBadge) {
    turnStatusBadge.dataset.status = normalizedStatus;
    turnStatusBadge.dataset.loading = String(Boolean(state.loading));
    if (syncStatus === "syncing") {
      turnStatusBadge.textContent = isPublic ? "正在对齐最新结果…" : "正在同步结果…";
    } else if (syncStatus === "error") {
      turnStatusBadge.textContent = isPublic ? "同步没成功 · 可重试" : "同步失败 · 待重试";
    } else if (isPublic) {
      turnStatusBadge.textContent = PUBLIC_TURN_STATUS_LABELS[normalizedStatus] || normalizedStatus;
    } else {
      const pendingSuffix = normalizedStatus === "committed" && state.pendingConfirmations.length > 0
        ? ` · ${state.pendingConfirmations.length} 项待确认`
        : "";
      turnStatusBadge.textContent = state.loading
        ? `${TURN_STATUS_LABELS[normalizedStatus] || "加载中"} · 加载中…`
        : `${TURN_STATUS_LABELS[normalizedStatus] || normalizedStatus}${pendingSuffix}`;
    }
  }

  // 图账 / 公开分析原子快照同步提示栏
  if (snapshotSyncBanner && snapshotSyncStatus) {
    snapshotSyncStatus.dataset.syncStatus = syncStatus;
    if (syncStatus === "syncing") {
      snapshotSyncBanner.hidden = false;
      snapshotSyncBanner.classList.remove("alert-error");
      snapshotSyncBanner.classList.add("alert-warn");
      snapshotSyncStatus.textContent = "正在同步结果…";
      if (snapshotSyncDetail) {
        snapshotSyncDetail.textContent = isPublic
          ? "这一轮已经整理好，正在把依据和星图对齐到同一版本。"
          : `本轮已提交${Number.isInteger(state.pendingSyncVersion) ? `至 v${state.pendingSyncVersion}` : ""}，正在拉取完整快照以同步星图与承重账单（就绪前保持 v${state.graphVersion}）。`;
      }
      if (snapshotRetryBtn) {
        snapshotRetryBtn.hidden = true;
        snapshotRetryBtn.disabled = true;
      }
    } else if (syncStatus === "error") {
      snapshotSyncBanner.hidden = false;
      snapshotSyncBanner.classList.remove("alert-warn");
      snapshotSyncBanner.classList.add("alert-error");
      snapshotSyncStatus.textContent = isPublic
        ? "这次没能同步最新结果（星图和对话仍保留上一版）"
        : "结果同步失败（已保留上一版本）";
      if (snapshotSyncDetail) {
        snapshotSyncDetail.textContent = state.syncError?.message
          || (isPublic
            ? "刚才的对话还在，点一下重试就能把最新依据和星图对齐过来。"
            : `读取最新会话快照失败，星图与承重账单继续保持 v${state.graphVersion}，请点击重试同步。`);
      }
      if (snapshotRetryBtn) {
        snapshotRetryBtn.hidden = false;
        snapshotRetryBtn.disabled = false;
      }
    } else {
      snapshotSyncBanner.hidden = true;
      snapshotSyncBanner.classList.remove("alert-error");
      snapshotSyncBanner.classList.add("alert-warn");
      snapshotSyncStatus.textContent = "已同步";
      if (snapshotSyncDetail) snapshotSyncDetail.textContent = "";
      if (snapshotRetryBtn) {
        snapshotRetryBtn.hidden = true;
        snapshotRetryBtn.disabled = true;
      }
    }
  }

  // 409 版本过期提示栏
  if (staleVersionBanner && staleVersionText) {
    if (state.staleConflict) {
      staleVersionBanner.hidden = false;
      staleVersionText.textContent = state.staleConflict.message;
    } else {
      staleVersionBanner.hidden = true;
      staleVersionText.textContent = "";
    }
  }
}

function renderLiveState(state) {
  renderHostModeChrome(state);

  const isPublic = state.hostMode === "public";
  if (state.mode !== "live") {
    if (isPublic && body.dataset.view === "info") {
      renderSharedSyncAndStatus(state);
      renderPublicWorkspace(state);
    }
    return;
  }

  renderSharedSyncAndStatus(state);

  // 保持增量解释元素同步（方便共用观察器与两种模式复用）
  if (streamExplanation) {
    streamExplanation.textContent = state.explanationText
      || (state.turnStatus === "running" ? "正在生成增量解释…" : "尚无本轮解释输出。");
  }

  if (isPublic) {
    renderPublicWorkspace(state);
  } else {
    if (publicDialogueSection) publicDialogueSection.hidden = true;
    if (workbenchSection) workbenchSection.hidden = false;

    if (liveModeBadge) {
      liveModeBadge.textContent = `合成演示模式 · ${state.dataMode || "demo"}`;
    }
    if (materialsStatusText) {
      materialsStatusText.textContent = state.materialsStatus?.message
        || "已连接本机同源 /v1 合成演示服务（零外部凭证）。";
    }
    if (infoNameEl) {
      infoNameEl.textContent = "合成演示会话";
    }
    if (infoMetaEl) {
      infoMetaEl.textContent = `合成演示模式 (${state.dataMode}) · ${state.confirmedGraph.length} 条已确认节点 · v${state.graphVersion}`;
    }

    const syncStatus = ["idle", "syncing", "error"].includes(state.syncStatus) ? state.syncStatus : "idle";
    const isBusy = state.turnStatus === "running" || state.loading || state.busyAction || syncStatus === "syncing";
    const canCancel = Boolean(state.activeTurnId) && state.turnStatus === "running";
    if (submitTurnBtn) submitTurnBtn.disabled = isBusy;
    if (submitFactBtn) submitFactBtn.disabled = isBusy;
    if (submitToneRewriteBtn) submitToneRewriteBtn.disabled = isBusy;
    if (submitScopeRewriteBtn) submitScopeRewriteBtn.disabled = isBusy;
    if (newDemoSessionBtn) newDemoSessionBtn.disabled = isBusy;
    if (cancelTurnBtn) cancelTurnBtn.disabled = !canCancel;

    if (boundFocusChip && boundFocusText) {
      if (state.boundFocusNodeId) {
        boundFocusChip.hidden = false;
        boundFocusText.textContent = `已绑定焦点节点：${state.boundFocusNodeId}`;
      } else {
        boundFocusChip.hidden = true;
        boundFocusText.textContent = "";
      }
    }

    if (errorBanner && errorBannerCode && errorBannerText) {
      if (state.error) {
        errorBanner.hidden = false;
        errorBannerCode.textContent = `请求未完成（${state.error.code || "ERROR"}）`;
        errorBannerText.textContent = state.error.message || "请重试当前操作。";
      } else {
        errorBanner.hidden = true;
        errorBannerCode.textContent = "";
        errorBannerText.textContent = "";
      }
    }

    if (stageBadge) {
      if (syncStatus === "syncing") {
        stageBadge.textContent = "正在同步结果…";
        stageBadge.dataset.stage = "syncing";
      } else if (syncStatus === "error") {
        stageBadge.textContent = "结果同步失败";
        stageBadge.dataset.stage = "sync_error";
      } else if (state.currentStage) {
        stageBadge.textContent = STAGE_LABELS[state.currentStage] || state.currentStage;
        stageBadge.dataset.stage = state.currentStage;
      } else if (state.loading) {
        stageBadge.textContent = "加载中…";
        stageBadge.dataset.stage = "loading";
      } else if (state.turnStatus === "committed") {
        stageBadge.textContent = "本轮已完成";
        stageBadge.dataset.stage = "done";
      } else if (state.turnStatus === "pending") {
        stageBadge.textContent = "等待同步";
        stageBadge.dataset.stage = "pending";
      } else if (state.turnStatus === "cancelled") {
        stageBadge.textContent = "已主动停止";
        stageBadge.dataset.stage = "cancelled";
      } else if (state.turnStatus === "failed") {
        stageBadge.textContent = "本轮失败";
        stageBadge.dataset.stage = "failed";
      } else {
        stageBadge.textContent = "等待提交";
        stageBadge.dataset.stage = "idle";
      }
    }

    renderFocusPanel(state.currentFocus);

    if (streamMeta) {
      const parts = [];
      if (state.activeTurnId) parts.push(`轮次 ${state.activeTurnId}`);
      if (state.lastEventId > 0) parts.push(`Last-Event-ID=${state.lastEventId}`);
      if (state.reconnectCount > 0) parts.push(`已断线续读 ${state.reconnectCount} 次`);
      streamMeta.hidden = parts.length === 0;
      streamMeta.textContent = parts.join(" · ");
    }

    renderGraphNodeList(state);
    renderEvidenceList(state);
    renderFactsList(state);
  }

  // 同步更新 3D 星图空态覆盖层的真实版本号（即便尚未打开 3D 画布）
  if (galaxyEmptyOverlay) {
    galaxyEmptyOverlay.dataset.graphVersion = String(state.graphVersion);
  }
  if (galaxyEmptyTitle) {
    galaxyEmptyTitle.textContent = isPublic
      ? "这里还在等你的一句话"
      : `当前已确认图为空（v${state.graphVersion}）`;
  }

  // 同版本同步更新 3D 星图与承重账单/改写比较
  syncGalaxyWithState(state);

  renderLiveAnalysis(state, {
    onAdoptRewrite: (stmt) => {
      live.submitTurn({
        text: `收束并采用改写版本 ${stmt.statementId}`,
        action: {
          type: "converge",
          adoptStatementId: stmt.statementId,
        },
      });
    },
    onBindFocusNode: (nodeId) => {
      live.setBoundFocusNode(nodeId);
      toast(nodeId ? `已绑定节点焦点：${nodeId}` : "已清除节点焦点");
    },
  });
}

if (!workbenchMode) live.subscribe(renderLiveState);

/* ---------- 交互按钮绑定 ---------- */
async function enterDemoInfoView() {
  transitionView("info");
  const st = live.getState();
  if (st.offlineDemoChosen) return;
  const hostOk = st.hostChecked ? st.hostAvailable : await live.checkHostAvailable();
  if (!hostOk) return;
  if (!live.getState().sessionId) {
    try {
      await live.createSession({ usePersonalMaterials: true });
    } catch {
      // 错误已在 errorBanner 中展示
    }
  }
}

async function submitPublicSentence(rawText, { action = null, fromHome = false } = {}) {
  const cleanText = String(rawText || "").trim();
  if (!cleanText) {
    toast("先把你想说的那句话写下来吧");
    (fromHome ? publicHomeInput : publicFollowupInput)?.focus();
    return;
  }

  degradeDismissed = false;
  if (body.dataset.view !== "info") {
    applyView("info");
  }
  renderLiveState(live.getState());

  const res = await live.submitTurn({ text: cleanText, action });
  if (res && !res.stale) {
    if (fromHome && publicHomeInput) publicHomeInput.value = "";
    if (!fromHome && publicFollowupInput) publicFollowupInput.value = "";
  }
}

publicHomeForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  submitPublicSentence(publicHomeInput?.value, { fromHome: true });
});

publicHomeInput?.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    submitPublicSentence(publicHomeInput.value, { fromHome: true });
  }
});

for (const chip of document.querySelectorAll('[data-testid="starter-prompt-btn"]')) {
  chip.addEventListener("click", () => {
    const promptText = chip.dataset.prompt || chip.textContent?.trim() || "";
    if (publicHomeInput) {
      publicHomeInput.value = promptText;
      publicHomeInput.focus();
    }
  });
}

publicFollowupForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  submitPublicSentence(publicFollowupInput?.value, { fromHome: false });
});

publicFollowupInput?.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    submitPublicSentence(publicFollowupInput.value, { fromHome: false });
  }
});

for (const chip of document.querySelectorAll("[data-quick-ask]")) {
  chip.addEventListener("click", () => {
    const q = chip.dataset.quickAsk || chip.textContent?.trim() || "";
    submitPublicSentence(q, { fromHome: false });
  });
}

tryRewriteBtn?.addEventListener("click", () => {
  const edited = publicRewriteEditor?.value?.trim() || "";
  if (!edited) {
    toast("改写框里还是空的，先写一句再试试吧");
    publicRewriteEditor?.focus();
    return;
  }
  submitPublicSentence(edited, {
    action: { type: "compare_rewrite", statementRole: "rewrite_scope" },
    fromHome: false,
  });
});

copyPublicRewriteBtn?.addEventListener("click", async () => {
  const text = publicRewriteEditor?.value?.trim() || "";
  if (!text) return;
  const ok = await copyPlainText(text);
  toast(ok ? "已复制这句改写" : "复制失败，可以手动选中复制");
});

publicCancelBtn?.addEventListener("click", async () => {
  const currentText = live.getState().activeTurnUserText;
  await live.cancelActiveTurn();
  if (currentText && publicFollowupInput && !publicFollowupInput.value.trim()) {
    publicFollowupInput.value = currentText;
  }
});

publicNewTopicBtn?.addEventListener("click", () => {
  expandedPublicCitationIds.clear();
  highlightedPublicNodeId = null;
  highlightedPublicEvidenceId = null;
  lastSyncedRewriteKey = null;
  degradeDismissed = false;
  if (publicRewriteEditor) publicRewriteEditor.value = "";
  if (publicFollowupInput) publicFollowupInput.value = "";
  live.resetPublicSession();
  transitionView("cover");
  requestAnimationFrame(() => publicHomeInput?.focus());
});

publicRetryBtn?.addEventListener("click", async () => {
  degradeDismissed = false;
  await live.retryLastFailedTurn();
});

publicSwitchDemoBtn?.addEventListener("click", () => {
  degradeDismissed = false;
  live.chooseOfflineDemoPreview();
  const costSection = document.getElementById("cost");
  const rewriteSection = document.getElementById("rewrite");
  if (costSection) costSection.hidden = false;
  if (rewriteSection) rewriteSection.hidden = false;
  if (publicDialogueSection) publicDialogueSection.hidden = true;
  if (workbenchSection) workbenchSection.hidden = true;
  if (sharedStatusStrip) sharedStatusStrip.hidden = true;
  applyView("info");
  toast("已切换到离线合成体验");
});

publicDegradeDismissBtn?.addEventListener("click", () => {
  degradeDismissed = true;
  renderPublicDegradeBanner(live.getState());
});

publicGraphDetailClose?.addEventListener("click", () => {
  highlightedPublicNodeId = null;
  highlightedPublicEvidenceId = null;
  renderPublicWorkspace(live.getState());
});

demoLogin.addEventListener("click", () => {
  enterDemoInfoView();
});

planet.addEventListener("click", () => {
  if (workbenchMode) { workbench?.openMap(); return; }
  if (body.dataset.view === "info") openGalaxy();
  else if (live.getState().hostMode === "public") publicHomeInput?.focus();
  else enterDemoInfoView();
});

backHome.addEventListener("click", () => {
  workbench?.leaveWorkspace();
  transitionView("cover");
});
galaxyBack.addEventListener("click", closeGalaxy);
galaxyEmptyBack?.addEventListener("click", closeGalaxy);
openGalaxyFromWorkbench?.addEventListener("click", openGalaxy);
openGalaxyFromPublic?.addEventListener("click", openGalaxy);
openGalaxyFromPanel?.addEventListener("click", openGalaxy);

newDemoSessionBtn?.addEventListener("click", async () => {
  selectedWorkbenchNodeId = null;
  expandedEvidenceIds.clear();
  try {
    await live.createSession({ usePersonalMaterials: true });
    toast("已创建新的合成演示会话");
  } catch {
    // 错误已在 errorBanner 展示
  }
});

async function submitFromComposer(action = null) {
  const text = turnInput?.value?.trim() || "";
  if (!text) {
    toast("请先输入句子、本人事实或改写内容");
    turnInput?.focus();
    return;
  }
  const res = await live.submitTurn({ text, action });
  if (res && !res.stale && turnInput) {
    turnInput.value = "";
  }
}

submitTurnBtn?.addEventListener("click", () => submitFromComposer(null));
submitFactBtn?.addEventListener("click", () => submitFromComposer({ type: "provide_self_fact" }));
submitToneRewriteBtn?.addEventListener("click", () =>
  submitFromComposer({ type: "compare_rewrite", statementRole: "rewrite_tone" }),
);
submitScopeRewriteBtn?.addEventListener("click", () =>
  submitFromComposer({ type: "compare_rewrite", statementRole: "rewrite_scope" }),
);
cancelTurnBtn?.addEventListener("click", () => live.cancelActiveTurn());

turnInput?.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    submitFromComposer(null);
  }
});

snapshotRetryBtn?.addEventListener("click", () => live.retrySnapshotSync());
staleRetryBtn?.addEventListener("click", () => live.retryStaleTurn());
staleDismissBtn?.addEventListener("click", () => live.dismissStaleConflict());
errorDismissBtn?.addEventListener("click", () => live.clearError());
clearBoundFocusBtn?.addEventListener("click", () => live.setBoundFocusNode(null));

wbNodeClose?.addEventListener("click", () => {
  selectedWorkbenchNodeId = null;
  renderWorkbenchNodeCard(live.getState());
});

bindFocusNodeBtn?.addEventListener("click", () => {
  const nodeId = bindFocusNodeBtn.dataset.nodeId;
  if (!nodeId) return;
  const current = live.getState().boundFocusNodeId;
  const nextId = current === nodeId ? null : nodeId;
  live.setBoundFocusNode(nextId);
  toast(nextId ? `已绑定节点焦点：${nextId}` : "已清除节点焦点");
});

/* ---------- 启动探测：握手同源 `/v1` 主机并自动恢复已保存会话（刷新恢复） ---------- */
(async function bootstrapLiveMode() {
  if (workbenchMode) return;
  const hostOk = await live.checkHostAvailable();
  if (!hostOk) return;
  const restored = await live.restoreSavedSession();
  if (restored) {
    applyView("info");
    renderLiveState(live.getState());
  }
})();

/* ---------- Liquid Glass：边缘折射 ---------- */
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
        `url(#${id}) blur(0.6px) saturate(1.5) contrast(1.04)`,
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

if (workbenchMode) {
  demoCoverIntro.querySelector(".lede").textContent = "挑一句让你想摇头的话，试试哪一个理由，能让对方再想一想。";
  aboutLinePrimary.textContent = "每轮选一句最想说的话。对方会接着你的理由往下谈，你也可以随时翻看知乎原文。";
  aboutLineSecondary.textContent = "十二轮后，能查到出处的收获会留在你的知识星图里。";
  infoNameEl.textContent = "你的观点交锋";
  infoMetaEl.textContent = "十二轮选择 · 知乎公开出处";
  infoHintEl.textContent = "点星球，看看阅读与交锋留下的星点。";
  const workspace = document.getElementById("debateWorkspace");
  workspace.hidden = false;
  planet.setAttribute("aria-label", "打开我的三维知识星图");
  galaxyCanvas.setAttribute("aria-label", "按领域排列的个人知识星图");
  galaxyEmptyBack.hidden = true;
  const { mountWorkbench } = await import("./workbench-starfield.js");
  workbench = mountWorkbench({
    enterWorkspace() { applyView("info"); },
    closeMap: closeGalaxy,
    openMapScene(map, sourceDetails, pointId, workbenchUrl) {
      const scene = ensureGalaxy();
      scene.setKnowledgeMap(map, sourceDetails);
      const connectLink = document.getElementById("galaxyConnectWorkbench");
      connectLink.hidden = !workbenchUrl;
      if (workbenchUrl) connectLink.href = workbenchUrl;
      else connectLink.removeAttribute("href");
      openGalaxy(pointId);
    },
  });
  document.getElementById("startDebate").addEventListener("click", workbench.openDebate);
  document.getElementById("openKnowledge").addEventListener("click", workbench.openMap);
  await workbench.connect();
}
