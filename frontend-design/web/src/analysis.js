/* 承重分析：账单与改写对比
   - 静态离线预览时沿用 quotation-case.js（不修改既有验收数据）
   - 接入 `/v1` 实时会话后，所有报价数字、冲突项、引文与改写比较严格从服务端结构化响应同图版本渲染
   - 当 rate === null 或 assessment === 'insufficient_evidence' 时一律显示「暂未确定」（绝不显示 null% / NaN%） */

import { graph as staticGraph, versions as staticVersions, quote as staticQuote } from "./quotation-case.js";
import { brightnessMonotonic } from "./starfield.js";
import { ASSESSMENT_LABELS, formatRateDisplay } from "./live-session.js";

const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

let liveActive = false;
let currentCopyOldText = staticVersions.original.text;
let currentCopyNewText = staticVersions.scope.text;
let staticMode = "scope";
let feedbackTimer = 0;

function setRateElement(valueId, unitId, formatted) {
  const valEl = $(valueId);
  const unitEl = $(unitId);
  if (valEl) valEl.textContent = formatted.text;
  if (unitEl) unitEl.hidden = !formatted.hasUnit;
}

async function copyText(text) {
  const feedback = $("copyFeedback");
  if (!text) return;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
  }
  if (feedback) {
    feedback.textContent = ok ? "已复制" : "复制失败，请手动选择文本";
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      feedback.textContent = "";
    }, 2400);
  }
}

/* ---------- 静态演示回退（仅未接入实时 `/v1` 主机时展示） ---------- */
function renderStaticFallback() {
  const byId = new Map(staticGraph.map((n) => [n.id, n]));
  const conflicts = staticVersions.original.conflicts;
  const priced = staticQuote(conflicts);
  const brightness = brightnessMonotonic(staticGraph);
  const walls = new Set(staticGraph.filter((n, i) => brightness[i] > 0.5).map((n) => n.id));
  const dead = staticGraph.filter((n) => priced.dead.has(n.id));
  const collapsed = dead.filter((n) => !conflicts.includes(n.id));

  setRateElement("costRate", "costRateUnit", { text: String(priced.rate), hasUnit: true });
  $("costDirect").textContent = String(conflicts.length);
  $("costWalls").textContent = String(conflicts.filter((id) => walls.has(id)).length);
  $("costLost").textContent = `${priced.lost} / ${priced.total}`;
  $("costCollapsed").textContent = String(collapsed.length);
  $("costCount").textContent =
    `${dead.length} / ${staticGraph.length}（${Math.round((100 * dead.length) / staticGraph.length)}%）`;
  $("impactCount").textContent = String(dead.length);

  const first = byId.get(conflicts[0]);
  $("costQuote").textContent = `「${first.text}」`;
  $("costWhy").textContent =
    "「只会变窄」与他这段亲身经历冲突。报价按判断之间的支撑关系计算：" +
    "拆掉它，所有以它为依据的判断会跟着失去支撑。";
  const verdictEl = $("costVerdict");
  if (verdictEl) verdictEl.textContent = "「只会」排除了他经历过的例外。";

  const list = $("impactList");
  list.replaceChildren();
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

  currentCopyOldText = staticVersions.original.text;
  setRateElement("oldRateValue", "oldRateUnit", { text: String(priced.rate), hasUnit: true });
  $("oldText").textContent = staticVersions.original.text;

  showStaticRewriteMode(staticMode);
}

function showStaticRewriteMode(key) {
  staticMode = key;
  const modes = {
    faithful: staticVersions.faithful,
    scope: staticVersions.scope,
  };
  const version = modes[key] || staticVersions.scope;
  const result = staticQuote(version.conflicts);
  const priced = staticQuote(staticVersions.original.conflicts);

  currentCopyNewText = version.text;
  setRateElement("newRateValue", "newRateUnit", { text: String(result.rate), hasUnit: true });
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

function roleLabel(role, idx) {
  if (role === "original") return "原句";
  if (role === "rewrite_tone") return "换语气改写";
  if (role === "rewrite_scope") return "缩小范围改写";
  return `改写版本 ${idx + 1}`;
}

/* ---------- 实时 `/v1` 结构化账单与同图改写比较渲染 ---------- */
export function renderLiveAnalysis(state, { onAdoptRewrite = null, onBindFocusNode = null } = {}) {
  liveActive = true;

  const graphNodes = Array.isArray(state.confirmedGraph) ? state.confirmedGraph : [];
  const costSection = $("cost");
  const rewriteSection = $("rewrite");
  const hidePersonalCostInPublic = state.hostMode === "public" && graphNodes.length === 0;
  if (costSection) costSection.hidden = hidePersonalCostInPublic;
  if (rewriteSection) rewriteSection.hidden = hidePersonalCostInPublic;
  if (hidePersonalCostInPublic) return;

  const graphById = new Map(graphNodes.map((n) => [n.id, n]));
  const evidenceById = new Map(
    (Array.isArray(state.evidenceIndex) ? state.evidenceIndex : []).map((e) => [e.id || e.evidenceId, e]),
  );
  const statements = Array.isArray(state.statements) ? state.statements : [];
  const comparison = state.statementComparison || null;
  const graphVersion = Number.isInteger(comparison?.graphVersion)
    ? comparison.graphVersion
    : (Number.isInteger(state.graphVersion) ? state.graphVersion : 0);
  const rawAdoptedId = state.adoptedStatementId
    ?? comparison?.adoptedStatementId
    ?? null;
  const adoptedStatementId = typeof rawAdoptedId === "string" && rawAdoptedId.trim()
    ? rawAdoptedId.trim()
    : null;

  const compQuotes = Array.isArray(comparison?.quotes) ? comparison.quotes : [];
  const quoteByStmtId = new Map(compQuotes.map((q) => [q.statementId, q]));
  for (const stmt of statements) {
    if (stmt.quote && !quoteByStmtId.has(stmt.statementId)) {
      quoteByStmtId.set(stmt.statementId, stmt.quote);
    }
  }

  // 主账单句：若最近提交的是新的非改写原句（如切换其他领域句子），优先展示最新主句，否则展示原句
  const originalStmt = statements.find((s) => s.role === "original" || s.statementId === "stmt_original")
    ?? statements[0]
    ?? null;
  const latestPrimaryStmt = [...statements]
    .reverse()
    .find((s) => s.role === "original" || /^stmt_\d+$/.test(s.statementId)) ?? null;
  const primaryStmt = latestPrimaryStmt || originalStmt || statements.at(-1) || null;
  const primaryQuote = primaryStmt
    ? (quoteByStmtId.get(primaryStmt.statementId) || primaryStmt.quote || null)
    : null;

  const costVersionBadge = $("costGraphVersionBadge");
  if (costVersionBadge) {
    costVersionBadge.hidden = false;
    costVersionBadge.textContent = `v${graphVersion} · 已确认节点 ${graphNodes.length} 条`;
    costVersionBadge.dataset.graphVersion = String(graphVersion);
  }

  const assessmentBadge = $("costAssessmentBadge");
  if (assessmentBadge) {
    assessmentBadge.hidden = false;
    if (!primaryStmt) {
      assessmentBadge.textContent = "等待输入句子";
      assessmentBadge.dataset.assessment = "empty";
    } else {
      const assess = primaryQuote?.assessment || primaryStmt.assessment || "insufficient_evidence";
      assessmentBadge.textContent = ASSESSMENT_LABELS[assess] || assess;
      assessmentBadge.dataset.assessment = assess;
    }
  }

  const billEmptyEl = $("billEmptyState");
  if (billEmptyEl) {
    const isEmptyBill = graphNodes.length === 0;
    billEmptyEl.hidden = !isEmptyBill;
    billEmptyEl.dataset.graphVersion = String(graphVersion);
    if (isEmptyBill) {
      billEmptyEl.textContent = primaryStmt
        ? `当前已确认图为空（v${graphVersion}），当前无生效的本人核验事实，报价暂未确定。请在上方补充本人事实后再算价。`
        : `当前已确认图为空（v${graphVersion}），尚无待评估句子与核验节点。请在上方输入句子并补充本人事实。`;
    }
  }

  const primaryRate = formatRateDisplay(primaryQuote);
  setRateElement("costRate", "costRateUnit", primaryRate);

  const directIds = Array.isArray(primaryQuote?.directConflicts) ? primaryQuote.directConflicts : [];
  const collateralIds = Array.isArray(primaryQuote?.collateral) ? primaryQuote.collateral : [];
  const affectedIds = Array.isArray(primaryQuote?.affected) ? primaryQuote.affected : [];
  const numerator = Number.isInteger(primaryQuote?.numerator) ? primaryQuote.numerator : 0;
  const denominator = Number.isInteger(primaryQuote?.denominator)
    ? primaryQuote.denominator
    : graphNodes.reduce((sum, n) => sum + (Number(n.S) || 0), 0);
  const highLoadWalls = directIds.filter((id) => (graphById.get(id)?.S ?? 0) >= 1).length;

  $("costDirect").textContent = String(directIds.length);
  $("costWalls").textContent = String(highLoadWalls);
  $("costLost").textContent = `${numerator} / ${denominator}`;
  $("costCollapsed").textContent = String(collateralIds.length);
  $("costCount").textContent = graphNodes.length > 0
    ? `${affectedIds.length} / ${graphNodes.length}（${Math.round((100 * affectedIds.length) / graphNodes.length)}%）`
    : "0 / 0（空图）";
  $("impactCount").textContent = String(affectedIds.length);

  // 冲突引文与结构说明（仅来自服务端结构化字段）
  const quoteEl = $("costQuote");
  const whyEl = $("costWhy");
  const verdictEl = $("costVerdict");
  const citationEl = $("costCitation");

  if (!primaryStmt) {
    quoteEl.textContent = "「当前尚未提交待核验句子」";
    whyEl.textContent = graphNodes.length === 0
      ? `当前已确认图为空（v${graphVersion}）。请在上方工作台输入句子，系统会先拆解焦点并展示可核对的合成依据；补充本人事实后星图与账单将同步更新。`
      : "请在上方工作台输入任意句子，系统将基于当前已确认图实时计算结构承重报价。";
    if (verdictEl) verdictEl.textContent = "暂未确定";
    if (citationEl) {
      citationEl.textContent = "";
      citationEl.hidden = true;
    }
  } else {
    const conflictReasons = Array.isArray(primaryQuote?.conflictReasons) ? primaryQuote.conflictReasons : [];
    const firstConflict = conflictReasons[0] || null;
    if (firstConflict) {
      const conflictNode = graphById.get(firstConflict.nodeId);
      quoteEl.textContent = `「${firstConflict.nodeText || conflictNode?.text || firstConflict.nodeId}」`;
      whyEl.textContent = primaryQuote?.reason || firstConflict.reason || "";
      if (verdictEl) {
        verdictEl.textContent = `与节点 [${firstConflict.nodeId}] 直接冲突 · 承重影响 ${primaryRate.hasUnit ? `${primaryRate.text}%` : primaryRate.text}`;
      }
      if (citationEl) {
        const evIds = [
          ...(Array.isArray(firstConflict.evidenceIds) ? firstConflict.evidenceIds : []),
          ...(Array.isArray(primaryQuote?.verifiedEvidenceIds) ? primaryQuote.verifiedEvidenceIds : []),
        ];
        const uniqueEvIds = [...new Set(evIds)];
        if (uniqueEvIds.length > 0) {
          const evLabels = uniqueEvIds.map((eid) => {
            const ev = evidenceById.get(eid);
            return ev ? `[${eid}] ${ev.author || "self"}：${(ev.excerpt || "").slice(0, 60)}` : `[${eid}]`;
          });
          citationEl.textContent = `核验引文：${evLabels.join("；")}`;
          citationEl.hidden = false;
        } else {
          citationEl.hidden = true;
        }
      }
    } else {
      quoteEl.textContent = `「${primaryStmt.text}」`;
      whyEl.textContent = primaryQuote?.reason || "当前已确认图中尚无针对该主张范围的本人核验节点，维持暂未确定。";
      if (verdictEl) {
        verdictEl.textContent = primaryQuote?.assessment === "compatible"
          ? "与当前已确认图相容（无直接冲突）。"
          : "证据不足：暂未确定（可补充本人事实或核对候选依据）。";
      }
      if (citationEl) {
        citationEl.textContent = primaryQuote?.interpretationNote || "";
        citationEl.hidden = !primaryQuote?.interpretationNote;
      }
    }
  }

  // 受影响节点列表（展示后端真实节点 ID 与承重 S）
  const list = $("impactList");
  list.replaceChildren();
  if (affectedIds.length === 0) {
    const emptyLi = document.createElement("li");
    emptyLi.className = "impact-empty";
    emptyLi.textContent = graphNodes.length === 0
      ? `当前已确认图为空（v${graphVersion}），尚未产生受影响节点。补充本人事实后可在此查看承重变化。`
      : "当前版本下暂无直接冲突或连带坍塌节点。";
    list.append(emptyLi);
  } else {
    for (const nid of affectedIds) {
      const node = graphById.get(nid);
      const direct = directIds.includes(nid);
      const li = document.createElement("li");
      li.dataset.nodeId = nid;
      if (direct) li.classList.add("direct");

      const top = document.createElement("div");
      top.className = "impact-top";

      const name = document.createElement("span");
      name.className = "impact-name";
      name.textContent = nid;

      const weight = document.createElement("span");
      weight.className = "impact-weight";
      weight.textContent = `承重 ${node?.S ?? 0}`;

      const tag = document.createElement("span");
      tag.className = "impact-tag";
      tag.textContent = direct ? "直接冲突" : "随依据失去支撑";

      const text = document.createElement("p");
      text.textContent = node?.text || nid;

      top.append(name, weight);
      li.append(top, tag, text);

      if (typeof onBindFocusNode === "function" && node) {
        const focusBtn = document.createElement("button");
        focusBtn.type = "button";
        focusBtn.className = "inline-mini-btn";
        focusBtn.textContent = state.boundFocusNodeId === nid ? "已绑定焦点" : "设为焦点";
        focusBtn.addEventListener("click", () => onBindFocusNode(state.boundFocusNodeId === nid ? null : nid));
        li.append(focusBtn);
      }

      list.append(li);
    }
  }

  /* ---------- 同图版本改写比较与显式采用（03 / REWRITE） ---------- */
  const compPanel = $("rewrite");
  if (compPanel) {
    compPanel.dataset.graphVersion = String(graphVersion);
  }

  const compHeader = $("comparisonGraphVersion");
  if (compHeader) {
    compHeader.hidden = false;
    compHeader.textContent = `同图对比基准：v${graphVersion} · 总承重分母 ${denominator} · 句数 ${statements.length}`;
  }

  const adoptedBanner = $("adoptedBanner");
  if (adoptedBanner) {
    if (adoptedStatementId) {
      const adoptedStmt = statements.find((s) => s.statementId === adoptedStatementId);
      adoptedBanner.hidden = false;
      adoptedBanner.dataset.adoptedStatementId = adoptedStatementId;
      adoptedBanner.textContent = `已采用版本：${adoptedStatementId}${adoptedStmt ? ` —— 「${adoptedStmt.text}」` : ""}`;
    } else {
      adoptedBanner.hidden = true;
      delete adoptedBanner.dataset.adoptedStatementId;
      adoptedBanner.textContent = "";
    }
  }

  // 左侧原句卡片
  const baseStmt = originalStmt;
  const baseQuote = baseStmt ? (quoteByStmtId.get(baseStmt.statementId) || baseStmt.quote || null) : null;
  const baseRate = formatRateDisplay(baseQuote);
  const oldCard = $("originalComparisonCard");
  const oldAdoptedBadge = $("oldAdoptedBadge");

  setRateElement("oldRateValue", "oldRateUnit", baseRate);
  $("oldText").textContent = baseStmt ? baseStmt.text : "尚未提交原句，请在上方工作台输入句子。";
  currentCopyOldText = baseStmt ? baseStmt.text : "";

  const baseAdopted = Boolean(baseStmt && adoptedStatementId && adoptedStatementId === baseStmt.statementId);
  if (oldCard) {
    if (baseStmt) {
      oldCard.setAttribute("data-testid", "comparison-item");
      oldCard.dataset.statementId = baseStmt.statementId;
      oldCard.dataset.statementRole = baseStmt.role || "original";
      oldCard.dataset.graphVersion = String(Number.isInteger(baseQuote?.graphVersion) ? baseQuote.graphVersion : graphVersion);
      oldCard.dataset.adopted = String(baseAdopted);
      oldCard.classList.toggle("is-adopted", baseAdopted);
    } else {
      oldCard.removeAttribute("data-testid");
      oldCard.classList.remove("is-adopted");
      delete oldCard.dataset.statementId;
      delete oldCard.dataset.statementRole;
      delete oldCard.dataset.graphVersion;
      delete oldCard.dataset.adopted;
    }
  }
  if (oldAdoptedBadge) {
    oldAdoptedBadge.hidden = !baseAdopted;
    if (baseAdopted) {
      oldAdoptedBadge.setAttribute("data-testid", "adopted-badge");
      oldAdoptedBadge.textContent = `已采用 · ${baseStmt.statementId}`;
    } else {
      oldAdoptedBadge.removeAttribute("data-testid");
      oldAdoptedBadge.textContent = "";
    }
  }

  const oldStmtIdEl = $("oldStatementMeta");
  if (oldStmtIdEl) {
    oldStmtIdEl.hidden = !baseStmt;
    oldStmtIdEl.textContent = baseStmt
      ? `${baseStmt.statementId} · v${baseQuote?.graphVersion ?? graphVersion} · ${ASSESSMENT_LABELS[baseQuote?.assessment] || "待评估"}`
      : "";
  }

  // 右侧改写比较卡片区（全部改写同图并列，并隐藏旧静态 tab 避免误导）
  const staticTabs = document.querySelector(".rewrite-tabs");
  const staticNewRate = $("newRate");
  const staticNewText = $("newText");
  const staticNewNote = $("newNote");
  const staticActions = document.querySelector(".rewrite-actions");
  const liveRewriteContainer = $("rewriteCards");

  if (staticTabs) staticTabs.hidden = true;
  if (staticNewRate) staticNewRate.hidden = true;
  if (staticNewText) staticNewText.hidden = true;
  if (staticNewNote) staticNewNote.hidden = true;
  if (staticActions) staticActions.hidden = true;

  if (liveRewriteContainer) {
    liveRewriteContainer.hidden = false;
    liveRewriteContainer.replaceChildren();

    const rewrites = statements.filter((s) => s.statementId !== baseStmt?.statementId);
    if (rewrites.length === 0) {
      const emptyBox = document.createElement("div");
      emptyBox.className = "rewrite-empty";
      emptyBox.textContent = "尚未提交改写版本。请在上方工作台输入改写句，点击「提交换语气改写」或「提交缩小范围改写」在同一图版本下比较。";
      liveRewriteContainer.append(emptyBox);
      $("rewriteCaption").textContent = `当前图版本 v${graphVersion}：提交换语气与缩小范围改写后可在此并列比较结构影响并明确采用。`;
    } else {
      const compMap = new Map((comparison?.comparisons || []).map((c) => [c.statementId, c]));
      rewrites.forEach((stmt, idx) => {
        const q = quoteByStmtId.get(stmt.statementId) || stmt.quote || null;
        const rateInfo = formatRateDisplay(q);
        const compEntry = compMap.get(stmt.statementId) || null;
        const isAdopted = Boolean(adoptedStatementId && adoptedStatementId === stmt.statementId);
        const stmtVersion = Number.isInteger(q?.graphVersion) ? q.graphVersion : graphVersion;

        const item = document.createElement("article");
        item.className = `rewrite-item${isAdopted ? " is-adopted" : ""}`;
        item.setAttribute("data-testid", "comparison-item");
        item.dataset.statementId = stmt.statementId;
        item.dataset.statementRole = stmt.role || "rewrite";
        item.dataset.graphVersion = String(stmtVersion);
        item.dataset.adopted = String(isAdopted);

        const head = document.createElement("div");
        head.className = "rewrite-item-head";

        const roleSpan = document.createElement("span");
        roleSpan.className = "rewrite-role-tag";
        roleSpan.textContent = `${roleLabel(stmt.role, idx)} · ${stmt.statementId}`;

        const headRight = document.createElement("span");
        headRight.className = "rewrite-item-head-right";

        if (isAdopted) {
          const adoptedTag = document.createElement("span");
          adoptedTag.className = "adopted-pill";
          adoptedTag.setAttribute("data-testid", "adopted-badge");
          adoptedTag.textContent = `已采用 · ${stmt.statementId}`;
          headRight.append(adoptedTag);
        }

        const verSpan = document.createElement("span");
        verSpan.className = "rewrite-ver-tag mono";
        verSpan.textContent = `v${stmtVersion}`;
        headRight.append(verSpan);

        head.append(roleSpan, headRight);

        const rateLine = document.createElement("p");
        rateLine.className = `rewrite-item-rate${rateInfo.numeric !== null && rateInfo.numeric >= 40 ? " danger" : ""}`;
        rateLine.textContent = rateInfo.hasUnit ? `${rateInfo.text}%` : rateInfo.text;

        const assessSpan = document.createElement("span");
        assessSpan.className = "rewrite-item-assess";
        const deltaNote = compEntry && compEntry.deltaRate !== null
          ? `（相对原句 ${compEntry.deltaRate > 0 ? `+${compEntry.deltaRate}` : compEntry.deltaRate}%）`
          : "";
        assessSpan.textContent = `${ASSESSMENT_LABELS[q?.assessment] || q?.assessment || "暂未确定"}${deltaNote}`;

        const textEl = document.createElement("p");
        textEl.className = "rewrite-item-text";
        textEl.textContent = stmt.text;

        const reasonEl = document.createElement("p");
        reasonEl.className = "rewrite-item-reason";
        reasonEl.textContent = q?.reason || "";

        const actionRow = document.createElement("div");
        actionRow.className = "rewrite-item-actions";

        const adoptBtn = document.createElement("button");
        adoptBtn.type = "button";
        adoptBtn.className = `analysis-btn${isAdopted ? " primary" : ""}`;
        adoptBtn.setAttribute("data-testid", "adopt-rewrite-btn");
        adoptBtn.dataset.adoptStatementId = stmt.statementId;
        adoptBtn.disabled = state.turnStatus === "running" || state.loading || state.syncStatus === "syncing";
        adoptBtn.textContent = isAdopted ? "已采用此改写" : "采用此改写";
        adoptBtn.addEventListener("click", () => {
          if (typeof onAdoptRewrite === "function") {
            onAdoptRewrite(stmt);
          }
        });

        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "analysis-btn";
        copyBtn.textContent = "复制";
        copyBtn.addEventListener("click", () => copyText(stmt.text));

        actionRow.append(adoptBtn, copyBtn);
        item.append(head, rateLine, assessSpan, textEl, reasonEl, actionRow);
        liveRewriteContainer.append(item);
      });

      $("rewriteCaption").textContent =
        `以上 ${statements.length} 个句版本均基于同一图版本 v${graphVersion}（总承重分母 ${denominator}）计算并对比。`;
    }
  }
}

/* ---------- 事件初始化 ---------- */
for (const tab of document.querySelectorAll(".rewrite-tab")) {
  tab.addEventListener("click", () => {
    if (!liveActive) showStaticRewriteMode(tab.dataset.mode);
  });
}

$("copyOld")?.addEventListener("click", () => copyText(currentCopyOldText));
$("copyNew")?.addEventListener("click", () => copyText(currentCopyNewText));

// 首次加载先做静态保底渲染；一旦实时会话就绪，renderLiveAnalysis 会全面接管
renderStaticFallback();

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
    { threshold: 0.08, rootMargin: "0px 0px -4%" }
  );
  for (const el of reveals) observer.observe(el);
}
