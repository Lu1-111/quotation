// P1-C 补修浏览器端到端验收测试（F-C1 生成中刷新恢复当前轮次 + F-C2 慢快照/失败快照图账原子同步、空态真实版本、唯一采用标识与手机端验证）。
// 使用同源合成宿主（demo-web-host.mjs）+ 独立临时 SQLite + 随机回环端口 + 真实 Chromium，零外部凭证可复跑。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV4 } from 'ai/test';
import { startDemoWebHost } from '../demo-web-host.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');

const USAGE = {
  inputTokens: { total: 48, noCache: 48, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 24, text: 24, reasoning: 0 },
};

function loadPlaywright() {
  const candidates = [
    path.join(REPO_ROOT, 'data-collection-service', 'node_modules', 'playwright-core', 'index.js'),
    path.join(REPO_ROOT, 'agent', 'node_modules', 'playwright-core', 'index.js'),
    'playwright-core',
    'playwright',
  ];
  const req = createRequire(import.meta.url);
  for (const candidate of candidates) {
    try {
      if (candidate.startsWith('/') && !existsSync(candidate)) continue;
      return req(candidate);
    } catch {
      // 尝试下一个路径
    }
  }
  throw new Error('未找到 playwright-core，请确认 data-collection-service 已安装依赖。');
}

function resolveChromiumExecutable(chromium) {
  const envPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  if (envPath && existsSync(envPath)) return envPath;
  const knownPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const candidate of knownPaths) {
    if (existsSync(candidate)) return candidate;
  }
  if (typeof chromium.executablePath === 'function') {
    const pwPath = chromium.executablePath();
    if (pwPath && existsSync(pwPath)) return pwPath;
  }
  return undefined;
}

async function launchBrowser() {
  const { chromium } = loadPlaywright();
  const executablePath = resolveChromiumExecutable(chromium);
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

function attachNetworkTracker(page, origin) {
  const requests = [];
  const responses = [];
  const pageErrors = [];
  const consoleErrors = [];

  page.on('request', (req) => {
    const url = req.url();
    if (!url.startsWith(origin)) return;
    const parsed = new URL(url);
    requests.push({
      method: req.method(),
      pathname: parsed.pathname,
      headers: req.headers(),
    });
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.startsWith(origin)) return;
    const parsed = new URL(url);
    const entry = {
      method: res.request().method(),
      pathname: parsed.pathname,
      status: res.status(),
      contentType: res.headers()['content-type'] ?? '',
      json: null,
    };
    if (entry.contentType.includes('application/json')) {
      try {
        entry.json = await res.json();
      } catch {
        // 忽略非 JSON 响应体
      }
    }
    responses.push(entry);
  });

  page.on('pageerror', (err) => {
    pageErrors.push(err);
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  return { requests, responses, pageErrors, consoleErrors };
}

async function installTurnStatusObserver(page) {
  await page.addInitScript(() => {
    window.__quotationStatusTransitions = [];
    const attach = () => {
      const badge = document.querySelector('[data-testid="turn-status-badge"]');
      if (!badge) return false;
      let lastStatus = badge.getAttribute('data-status') ?? '';
      const observer = new MutationObserver(() => {
        const nextStatus = badge.getAttribute('data-status') ?? '';
        if (nextStatus !== lastStatus) {
          window.__quotationStatusTransitions.push({ from: lastStatus, to: nextStatus });
          lastStatus = nextStatus;
        }
      });
      observer.observe(badge, { attributes: true, attributeFilter: ['data-status'] });
      return true;
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { attach(); }, { once: true });
    } else {
      attach();
    }
  });
}

async function readStatusTransitions(page) {
  return page.evaluate(() => Array.isArray(window.__quotationStatusTransitions)
    ? window.__quotationStatusTransitions.slice()
    : []);
}

function createControllableStreamModel() {
  const pendingGates = new Map();
  let activeGate = null;
  let callIndex = 0;

  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      callIndex += 1;
      const currentCall = callIndex;
      let releaseFn;
      let released = false;
      const gate = new Promise((resolvePromise) => {
        releaseFn = () => {
          if (released) return;
          released = true;
          pendingGates.delete(currentCall);
          resolvePromise();
        };
      });
      const gateEntry = { callIndex: currentCall, release: releaseFn };
      activeGate = gateEntry;
      pendingGates.set(currentCall, gateEntry);

      return {
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: 'text-start', id: `ctrl_${currentCall}` });
            controller.enqueue({
              type: 'text-delta',
              id: `ctrl_${currentCall}`,
              delta: `【第${currentCall}轮首段流式输出】已定位当前焦点与依据。`,
            });

            if (abortSignal) {
              if (abortSignal.aborted) {
                pendingGates.delete(currentCall);
                controller.error(new DOMException('Aborted', 'AbortError'));
                return;
              }
              await new Promise((resolvePromise) => {
                const onAbort = () => resolvePromise();
                abortSignal.addEventListener('abort', onAbort, { once: true });
                gate.then(() => {
                  abortSignal.removeEventListener('abort', onAbort);
                  resolvePromise();
                });
              });
              if (abortSignal.aborted) {
                pendingGates.delete(currentCall);
                controller.error(new DOMException('Aborted', 'AbortError'));
                return;
              }
            } else {
              await gate;
            }

            controller.enqueue({
              type: 'text-delta',
              id: `ctrl_${currentCall}`,
              delta: `【第${currentCall}轮续段补齐输出】结构承重比例与引文均来自服务端核验快照。`,
            });
            controller.enqueue({ type: 'text-end', id: `ctrl_${currentCall}` });
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: USAGE,
            });
            controller.close();
          },
        }),
      };
    },
  });

  return {
    model,
    firstChunkMarker(n) {
      return `第${n}轮首段流式输出`;
    },
    secondChunkMarker(n) {
      return `第${n}轮续段补齐输出`;
    },
    getCallCount() {
      return callIndex;
    },
    releaseCurrent() {
      activeGate?.release?.();
    },
    releaseAll() {
      for (const entry of [...pendingGates.values()]) {
        entry.release();
      }
      activeGate?.release?.();
    },
  };
}

async function enterLiveDemoWorkspace(page, origin) {
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });

  const turnInput = page.getByTestId('turn-input');
  const alreadyVisible = await turnInput.isVisible().catch(() => false);
  if (!alreadyVisible) {
    const demoBtn = page.locator('#demoLogin');
    if (await demoBtn.isVisible().catch(() => false)) {
      await demoBtn.click();
    }
  }

  await turnInput.waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="session-id-label"]');
      const txt = el?.textContent?.trim() ?? '';
      return txt.length >= 6 && txt !== '—' && txt !== '未建立会话' && txt !== '未创建';
    },
    null,
    { timeout: 15_000 },
  );
}

async function waitForSessionRestored(page, sessionId, timeout = 15_000) {
  await page.getByTestId('turn-input').waitFor({ state: 'visible', timeout });
  await page.waitForFunction(
    (expectedSid) => {
      const txt = document.querySelector('[data-testid="session-id-label"]')?.textContent?.trim() ?? '';
      return txt.includes(expectedSid) || txt.includes(expectedSid.slice(0, 8));
    },
    sessionId,
    { timeout },
  );
}

async function waitForTurnStatus(page, expectedStatus, timeout = 20_000) {
  await page.waitForFunction(
    (status) => document.querySelector('[data-testid="turn-status-badge"]')?.getAttribute('data-status') === status,
    expectedStatus,
    { timeout },
  );
}

async function waitForSyncStatus(page, expectedSyncStatus, timeout = 15_000) {
  await page.waitForFunction(
    (status) => document.querySelector('[data-testid="snapshot-sync-status"]')?.getAttribute('data-sync-status') === status,
    expectedSyncStatus,
    { timeout },
  );
}

async function submitTurnActionAndWaitAccepted(page, triggerAction) {
  const postPromise = page.waitForResponse(
    (res) => res.request().method() === 'POST' && /^\/v1\/sessions\/[^/]+\/turns$/.test(new URL(res.url()).pathname),
    { timeout: 15_000 },
  );
  await triggerAction();
  const turnRes = await postPromise;
  assert.equal(turnRes.status(), 202, `提交轮次应返回 202，实际 ${turnRes.status()}`);
  const turnPayload = await turnRes.json();
  return {
    turnId: turnPayload.data.turnId,
    eventsUrl: turnPayload.data.eventsUrl,
    data: turnPayload.data,
  };
}

async function submitTurnActionAndWaitSseDone(page, triggerAction) {
  const sseFinishedByPath = new Map();
  const onResponse = (res) => {
    const req = res.request();
    if (req.method() === 'GET') {
      const pathname = new URL(res.url()).pathname;
      if (/^\/v1\/sessions\/[^/]+\/turns\/[^/]+\/events$/.test(pathname)) {
        sseFinishedByPath.set(pathname, res.finished().catch(() => {}));
      }
    }
  };
  page.on('response', onResponse);

  try {
    const accepted = await submitTurnActionAndWaitAccepted(page, triggerAction);
    if (!sseFinishedByPath.has(accepted.eventsUrl)) {
      const sseRes = await page.waitForResponse(
        (res) => res.request().method() === 'GET' && new URL(res.url()).pathname === accepted.eventsUrl,
        { timeout: 15_000 },
      );
      await sseRes.finished().catch(() => {});
    } else {
      await sseFinishedByPath.get(accepted.eventsUrl);
    }
    return accepted;
  } finally {
    page.off('response', onResponse);
  }
}

async function submitTurnActionAndWaitCommitted(page, triggerAction) {
  const accepted = await submitTurnActionAndWaitSseDone(page, triggerAction);
  await waitForTurnStatus(page, 'committed', 25_000);
  await waitForSyncStatus(page, 'idle', 15_000);
  return accepted;
}

async function submitAndWaitCommitted(page, text, buttonTestId = 'submit-turn-btn') {
  return submitTurnActionAndWaitCommitted(page, async () => {
    await page.getByTestId('turn-input').fill(text);
    await page.getByTestId(buttonTestId).click();
  });
}

async function fetchHostSnapshot(origin, internalToken, sessionId) {
  const res = await fetch(`${origin}/v1/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${internalToken}` },
  });
  assert.equal(res.status, 200, `直连获取快照失败，状态码 ${res.status}`);
  return (await res.json()).data;
}

async function waitForHostSnapshot(origin, internalToken, sessionId, predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let lastSnap = null;
  while (Date.now() < deadline) {
    lastSnap = await fetchHostSnapshot(origin, internalToken, sessionId);
    if (predicate(lastSnap)) {
      return lastSnap;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
  }
  throw new Error(`等待服务端快照满足条件超时，最后一次快照 graphVersion=${lastSnap?.graphVersion} activeTurnId=${lastSnap?.activeTurnId}`);
}

function getPrimaryQuoteFromSnapshot(snap) {
  const statements = Array.isArray(snap?.statements) ? snap.statements : [];
  const comparison = snap?.statementComparison || null;
  const quoteByStmtId = new Map(
    (Array.isArray(comparison?.quotes) ? comparison.quotes : []).map((q) => [q.statementId, q]),
  );
  for (const stmt of statements) {
    if (stmt.quote && !quoteByStmtId.has(stmt.statementId)) {
      quoteByStmtId.set(stmt.statementId, stmt.quote);
    }
  }
  const originalStmt = statements.find((s) => s.role === 'original' || s.statementId === 'stmt_original')
    ?? statements[0]
    ?? null;
  const latestPrimaryStmt = [...statements]
    .reverse()
    .find((s) => s.role === 'original' || /^stmt_\d+$/.test(s.statementId))
    ?? null;
  const primaryStmt = latestPrimaryStmt || originalStmt || statements.at(-1) || null;
  if (!primaryStmt) return { primaryStmt: null, primaryQuote: null };
  return {
    primaryStmt,
    primaryQuote: quoteByStmtId.get(primaryStmt.statementId) || primaryStmt.quote || null,
  };
}

async function readDomGraphNodeIds(page) {
  return page.getByTestId('graph-node-item').evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-node-id')).filter(Boolean),
  );
}

async function readDomFactIds(page) {
  return page.getByTestId('fact-item').evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-fact-id')).filter(Boolean),
  );
}

async function readDomImpactNodeIds(page) {
  return page.locator('#impactList li[data-node-id]').evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-node-id')).filter(Boolean),
  );
}

async function assertNoBearerLeakInBrowser(page, tracker, internalToken) {
  const browserLeak = await page.evaluate((secret) => {
    const html = document.documentElement.outerHTML;
    const cookie = document.cookie;
    const ls = Object.values(window.localStorage ?? {}).join(' ');
    const ss = Object.values(window.sessionStorage ?? {}).join(' ');
    return html.includes(secret) || cookie.includes(secret) || ls.includes(secret) || ss.includes(secret);
  }, internalToken);
  assert.equal(browserLeak, false, '浏览器 DOM / Cookie / Storage 严禁出现明文内部 Bearer');

  const sentBearer = tracker.requests.some(
    (req) => typeof req.headers.authorization === 'string' && req.headers.authorization.includes(internalToken),
  );
  assert.equal(sentBearer, false, '浏览器前端请求不应直接携带内部 Bearer 令牌');
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  return String(haystack).split(needle).length - 1;
}

test('F-C1 生成中刷新恢复当前轮次：成功提交续流、主动停止取消、刷新临界恰好提交与零重发校验', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'quotation-p1c-fc1-'));
  const dbPath = path.join(tmpDir, 'fc1-demo.sqlite');
  const controllable = createControllableStreamModel();
  const sseConnections = [];

  const host = await startDemoWebHost({
    host: '127.0.0.1',
    port: 0,
    dbPath,
    model: controllable.model,
    quiet: true,
    onSseResponse(info) {
      sseConnections.push({
        sessionId: info.sessionId,
        turnId: info.turnId,
        lastEventId: info.lastEventId,
        attempt: info.attempt,
      });
    },
  });
  const browser = await launchBrowser();

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await installTurnStatusObserver(page);
    const tracker = attachNetworkTracker(page, host.origin);

    await enterLiveDemoWorkspace(page, host.origin);
    const createResp = tracker.responses.find(
      (r) => r.method === 'POST' && r.pathname === '/v1/sessions' && r.status === 201,
    );
    assert.ok(createResp?.json?.data?.sessionId, '应成功创建合成会话');
    const sessionId = createResp.json.data.sessionId;

    const countPostTurns = () => tracker.requests.filter(
      (r) => r.method === 'POST' && r.pathname === `/v1/sessions/${sessionId}/turns`,
    ).length;

    // ===== 子场景 1：生成中刷新 -> 自动恢复 running/停止按钮/同轮 SSE -> 放行第二段成功提交 =====
    const turn1 = await submitTurnActionAndWaitAccepted(page, async () => {
      await page.getByTestId('turn-input').fill('推荐算法只会让人的兴趣越来越窄。');
      await page.getByTestId('submit-turn-btn').click();
    });

    await page.waitForFunction(
      (marker) => (document.querySelector('[data-testid="stream-explanation"]')?.textContent ?? '').includes(marker),
      controllable.firstChunkMarker(1),
      { timeout: 15_000 },
    );
    await waitForTurnStatus(page, 'running', 10_000);

    const postTurnsBeforeReload1 = countPostTurns();
    const sseCountTurn1BeforeReload = sseConnections.filter((c) => c.turnId === turn1.turnId).length;
    assert.equal(postTurnsBeforeReload1, 1, '子场景 1 刷新前应恰好提交 1 次 POST /turns');
    assert.equal(sseCountTurn1BeforeReload, 1, '子场景 1 刷新前应建立 1 次同轮 SSE 订阅');

    // 在模型阻塞于首段之后执行整页刷新
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSessionRestored(page, sessionId);
    await waitForTurnStatus(page, 'running', 15_000);

    // 断言刷新后恢复同一会话、零新增 POST /turns、停止按钮可用、重新订阅同一 turnId 的 SSE
    assert.equal(countPostTurns() - postTurnsBeforeReload1, 0, '子场景 1 刷新后页内新增 POST /turns 次数必须为 0');
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="cancel-turn-btn"]');
        return Boolean(btn) && !btn.disabled;
      },
      null,
      { timeout: 10_000 },
    );
    assert.equal(
      await page.getByTestId('cancel-turn-btn').isEnabled(),
      true,
      '子场景 1 刷新恢复 running 后停止按钮必须可用（非 disabled）',
    );
    await page.waitForFunction(
      (marker) => (document.querySelector('[data-testid="stream-explanation"]')?.textContent ?? '').includes(marker),
      controllable.firstChunkMarker(1),
      { timeout: 15_000 },
    );
    const sseCountTurn1AfterReload = sseConnections.filter((c) => c.turnId === turn1.turnId).length;
    assert.ok(
      sseCountTurn1AfterReload >= sseCountTurn1BeforeReload + 1,
      `子场景 1 刷新后必须重新订阅同一 turnId(${turn1.turnId}) 的 SSE 流`,
    );

    // 放行第二段输出，断言第一段不重复、第二段补齐并最终 committed
    controllable.releaseCurrent();
    await page.waitForFunction(
      (marker) => (document.querySelector('[data-testid="stream-explanation"]')?.textContent ?? '').includes(marker),
      controllable.secondChunkMarker(1),
      { timeout: 15_000 },
    );
    await waitForTurnStatus(page, 'committed', 20_000);
    await waitForSyncStatus(page, 'idle', 15_000);

    const explanation1 = (await page.getByTestId('stream-explanation').textContent()) ?? '';
    assert.equal(
      countOccurrences(explanation1, controllable.firstChunkMarker(1)),
      1,
      `子场景 1 刷新续流后首段文本不得重复拼接，实际：${explanation1}`,
    );
    assert.equal(
      countOccurrences(explanation1, controllable.secondChunkMarker(1)),
      1,
      `子场景 1 刷新续流后第二段文本应完整出现 1 次，实际：${explanation1}`,
    );
    assert.equal(countPostTurns() - postTurnsBeforeReload1, 0, '子场景 1 提交完成后页内仍不得有重发 POST /turns');
    assert.equal(await page.getByTestId('cancel-turn-btn').isEnabled(), false, '提交完成后停止按钮应恢复禁用');

    const transitions1 = await readStatusTransitions(page);
    const committedTransitions1 = transitions1.filter((t) => t.to === 'committed').length;
    assert.equal(
      committedTransitions1,
      1,
      `子场景 1 刷新后终态 committed 仅应应用 1 次，实际记录：${JSON.stringify(transitions1)}`,
    );

    const snapAfterTurn1 = await fetchHostSnapshot(host.origin, host.internalToken, sessionId);
    assert.equal(snapAfterTurn1.turns.length, 1, '子场景 1 后端应仅存在 1 个轮次（未重复提交）');
    assert.equal(snapAfterTurn1.turns[0].turnId, turn1.turnId);
    assert.equal(snapAfterTurn1.turns[0].status, 'committed');

    // ===== 子场景 2：生成中刷新 -> 恢复 running 与停止按钮 -> 主动点击停止 =====
    const gvBeforeCancel = snapAfterTurn1.graphVersion;
    const turn2 = await submitTurnActionAndWaitAccepted(page, async () => {
      await page.getByTestId('turn-input').fill('我确实通过推荐发现过冷门爵士专辑。');
      await page.getByTestId('submit-fact-btn').click();
    });

    await page.waitForFunction(
      (marker) => (document.querySelector('[data-testid="stream-explanation"]')?.textContent ?? '').includes(marker),
      controllable.firstChunkMarker(2),
      { timeout: 15_000 },
    );
    await waitForTurnStatus(page, 'running', 10_000);

    const postTurnsBeforeReload2 = countPostTurns();
    const sseCountTurn2BeforeReload = sseConnections.filter((c) => c.turnId === turn2.turnId).length;

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSessionRestored(page, sessionId);
    await waitForTurnStatus(page, 'running', 15_000);

    assert.equal(countPostTurns() - postTurnsBeforeReload2, 0, '子场景 2 刷新后不得重发 POST /turns');
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="cancel-turn-btn"]');
        return Boolean(btn) && !btn.disabled;
      },
      null,
      { timeout: 10_000 },
    );
    assert.equal(
      await page.getByTestId('cancel-turn-btn').isEnabled(),
      true,
      '子场景 2 刷新恢复后停止按钮必须可点击',
    );
    await page.waitForFunction(
      (marker) => (document.querySelector('[data-testid="stream-explanation"]')?.textContent ?? '').includes(marker),
      controllable.firstChunkMarker(2),
      { timeout: 15_000 },
    );
    assert.ok(
      sseConnections.filter((c) => c.turnId === turn2.turnId).length >= sseCountTurn2BeforeReload + 1,
      `子场景 2 刷新后应重新订阅同一 turnId(${turn2.turnId}) 的 SSE 流`,
    );

    const cancelRespPromise = page.waitForResponse(
      (res) => res.request().method() === 'POST'
        && new URL(res.url()).pathname === `/v1/sessions/${sessionId}/turns/${turn2.turnId}/cancel`,
      { timeout: 15_000 },
    );
    await page.getByTestId('cancel-turn-btn').click();
    const cancelRes = await cancelRespPromise;
    assert.equal(cancelRes.status(), 200, `停止轮次应返回 200，实际 ${cancelRes.status()}`);
    await waitForTurnStatus(page, 'cancelled', 15_000);
    controllable.releaseCurrent();

    assert.equal(countPostTurns() - postTurnsBeforeReload2, 0, '子场景 2 主动停止后仍不得有重发 POST /turns');
    const transitions2 = await readStatusTransitions(page);
    assert.equal(
      transitions2.filter((t) => t.to === 'cancelled').length,
      1,
      `子场景 2 刷新后终态 cancelled 仅应应用 1 次，实际记录：${JSON.stringify(transitions2)}`,
    );

    const snapAfterCancel = await waitForHostSnapshot(
      host.origin,
      host.internalToken,
      sessionId,
      (s) => s.activeTurnId === null,
    );
    assert.equal(snapAfterCancel.graphVersion, gvBeforeCancel, '主动停止轮次后 graphVersion 严禁递增');
    assert.ok(
      ((await page.getByTestId('graph-version-badge').textContent()) ?? '').includes(`v${gvBeforeCancel}`),
      '主动停止后页面星图版本号应保持不变',
    );

    // ===== 子场景 3：刷新前后临界恰好提交（快照返回 running 与 SSE 订阅之间模型完成提交） =====
    const gvBeforeTurn3 = snapAfterCancel.graphVersion;
    const turn3 = await submitTurnActionAndWaitAccepted(page, async () => {
      await page.getByTestId('turn-input').fill('我确实通过推荐发现过新乐队。');
      await page.getByTestId('submit-fact-btn').click();
    });

    await page.waitForFunction(
      (marker) => (document.querySelector('[data-testid="stream-explanation"]')?.textContent ?? '').includes(marker),
      controllable.firstChunkMarker(3),
      { timeout: 15_000 },
    );
    await waitForTurnStatus(page, 'running', 10_000);

    const postTurnsBeforeReload3 = countPostTurns();
    const turn3EventsPathname = `/v1/sessions/${sessionId}/turns/${turn3.turnId}/events`;
    let criticalWindowTriggered = false;

    await page.route(`**${turn3EventsPathname}`, async (route) => {
      const parsed = new URL(route.request().url());
      if (!criticalWindowTriggered && route.request().method() === 'GET' && parsed.pathname === turn3EventsPathname) {
        criticalWindowTriggered = true;
        // 精确制造临界窗口：刷新快照刚看到 running，SSE 建立前底层模型即完成提交
        controllable.releaseCurrent();
        await waitForHostSnapshot(
          host.origin,
          host.internalToken,
          sessionId,
          (s) => s.activeTurnId === null && s.graphVersion > gvBeforeTurn3,
          15_000,
        );
      }
      await route.continue();
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSessionRestored(page, sessionId);
    await waitForTurnStatus(page, 'committed', 20_000);
    await waitForSyncStatus(page, 'idle', 15_000);
    await page.unroute(`**${turn3EventsPathname}`);

    assert.equal(criticalWindowTriggered, true, '子场景 3 应真实命中刷新快照与 SSE 订阅之间的临界提交窗口');
    assert.equal(countPostTurns() - postTurnsBeforeReload3, 0, '子场景 3 刷新临界提交后严禁重发 POST /turns');
    assert.equal(await page.getByTestId('cancel-turn-btn').isEnabled(), false, '临界提交完成后停止按钮应禁用');

    const transitions3 = await readStatusTransitions(page);
    assert.equal(
      transitions3.filter((t) => t.to === 'committed').length,
      1,
      `子场景 3 临界提交后终态 committed 应仅应用 1 次，实际记录：${JSON.stringify(transitions3)}`,
    );

    const snapFinal = await fetchHostSnapshot(host.origin, host.internalToken, sessionId);
    assert.ok(snapFinal.graphVersion > gvBeforeTurn3, '子场景 3 本人事实提交后后端 graphVersion 应递增');
    assert.ok(snapFinal.confirmedGraph.length > 0, '子场景 3 后端应生成已确认图节点');

    await page.getByTestId('graph-node-item').first().waitFor({ state: 'visible', timeout: 10_000 });
    const domNodeIds = await readDomGraphNodeIds(page);
    assert.deepEqual(
      [...domNodeIds].sort(),
      snapFinal.confirmedGraph.map((n) => n.id).sort(),
      '子场景 3 刷新完成后星图节点必须与服务端快照完全一致',
    );
    assert.ok(
      ((await page.getByTestId('graph-version-badge').textContent()) ?? '').includes(`v${snapFinal.graphVersion}`),
      '子场景 3 星图版本号必须与服务端快照一致',
    );
    assert.ok(
      ((await page.getByTestId('bill-graph-version').textContent()) ?? '').includes(`v${snapFinal.graphVersion}`),
      '子场景 3 账单版本号必须与服务端快照一致',
    );

    const explanation3 = (await page.getByTestId('stream-explanation').textContent()) ?? '';
    assert.equal(
      countOccurrences(explanation3, controllable.firstChunkMarker(3)),
      1,
      `子场景 3 首段文本不得重复，实际：${explanation3}`,
    );
    assert.equal(
      countOccurrences(explanation3, controllable.secondChunkMarker(3)),
      1,
      `子场景 3 第二段文本应完整出现 1 次，实际：${explanation3}`,
    );

    await assertNoBearerLeakInBrowser(page, tracker, host.internalToken);
    assert.equal(
      tracker.pageErrors.length,
      0,
      `F-C1 不应出现未捕获 JS 异常：${tracker.pageErrors.map((e) => e.message).join('; ')}`,
    );
    await context.close();
  } finally {
    controllable.releaseAll();
    await browser.close();
    await host.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('F-C2 慢快照与失败快照图账原子同步、唯一采用标识、全部撤回空态真实版本及手机端恢复', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'quotation-p1c-fc2-'));
  const dbPath = path.join(tmpDir, 'fc2-demo.sqlite');
  const host = await startDemoWebHost({
    host: '127.0.0.1',
    port: 0,
    dbPath,
    quiet: true,
  });
  const browser = await launchBrowser();

  try {
    // ===== Part A：桌面端（1440x900）慢快照原子同步 -> 失败快照重试 -> 唯一采用标识 -> 全部撤回空态真实版本 =====
    const desktopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await desktopCtx.newPage();
    const tracker = attachNetworkTracker(page, host.origin);

    await enterLiveDemoWorkspace(page, host.origin);
    const createResp = tracker.responses.find(
      (r) => r.method === 'POST' && r.pathname === '/v1/sessions' && r.status === 201,
    );
    assert.ok(createResp?.json?.data?.sessionId, '桌面端应成功创建合成会话');
    const sessionId = createResp.json.data.sessionId;
    const sessionPathname = `/v1/sessions/${sessionId}`;

    // 1. 分析原句，建立空图 v0 基线
    await submitAndWaitCommitted(page, '推荐算法只会让人的兴趣越来越窄。', 'submit-turn-btn');
    const snapV0 = await fetchHostSnapshot(host.origin, host.internalToken, sessionId);
    assert.equal(snapV0.graphVersion, 0, '分析原句后尚未补充本人事实时后端图版本应为 0');
    assert.equal(snapV0.confirmedGraph.length, 0, '分析原句后已确认图应为空');
    assert.equal(await page.getByTestId('galaxy-empty-state').isVisible(), true);
    assert.equal(await page.getByTestId('bill-empty-state').isVisible(), true);
    assert.ok(((await page.getByTestId('graph-version-badge').textContent()) ?? '').includes('v0'));
    assert.ok(((await page.getByTestId('bill-graph-version').textContent()) ?? '').includes('v0'));

    // 2. 慢快照：挂起提交后的 GET /v1/sessions/:id，验证同步中提示且图账同留在 v0
    let releaseSlowSnapshot = null;
    const slowSnapshotGate = new Promise((resolvePromise) => {
      releaseSlowSnapshot = resolvePromise;
    });
    let notifySlowSnapshotHit = null;
    const slowSnapshotHitPromise = new Promise((resolvePromise) => {
      notifySlowSnapshotHit = resolvePromise;
    });
    let holdSlowSnapshot = true;

    await page.route(`**${sessionPathname}`, async (route) => {
      const parsed = new URL(route.request().url());
      if (holdSlowSnapshot && route.request().method() === 'GET' && parsed.pathname === sessionPathname) {
        notifySlowSnapshotHit();
        await slowSnapshotGate;
      }
      await route.continue();
    });

    await submitTurnActionAndWaitSseDone(page, async () => {
      await page.getByTestId('turn-input').fill('我确实通过推荐发现过新乐队。');
      await page.getByTestId('submit-fact-btn').click();
    });
    await slowSnapshotHitPromise;

    const backendSnapV1 = await waitForHostSnapshot(
      host.origin,
      host.internalToken,
      sessionId,
      (s) => s.graphVersion >= 1 && s.confirmedGraph.length > 0,
    );
    const { primaryQuote: quoteV1 } = getPrimaryQuoteFromSnapshot(backendSnapV1);
    assert.ok(quoteV1 && quoteV1.rate !== null, '补充冲突本人事实后后端 v1 报价应为具体百分比');

    // 快照挂起期间：必须显示「正在同步结果」，且星图、节点、账单、比较面板全部维持旧版本 v0
    await page.getByTestId('snapshot-sync-banner').waitFor({ state: 'visible', timeout: 10_000 });
    await waitForSyncStatus(page, 'syncing', 10_000);
    const syncingText = (await page.getByTestId('snapshot-sync-status').textContent()) ?? '';
    assert.ok(syncingText.includes('正在同步结果'), `慢快照期间同步状态应包含“正在同步结果”，实际：${syncingText}`);

    const gvWhileSlow = (await page.getByTestId('graph-version-badge').textContent()) ?? '';
    const billGvWhileSlow = (await page.getByTestId('bill-graph-version').textContent()) ?? '';
    const compGvWhileSlow = await page.getByTestId('comparison-panel').getAttribute('data-graph-version');
    const billRateWhileSlow = (await page.getByTestId('bill-rate').textContent()) ?? '';
    assert.ok(
      gvWhileSlow.includes('v0') && !gvWhileSlow.includes(`v${backendSnapV1.graphVersion}`),
      `慢快照挂起期间星图版本应维持 v0，实际：${gvWhileSlow}`,
    );
    assert.ok(
      billGvWhileSlow.includes('v0') && !billGvWhileSlow.includes(`v${backendSnapV1.graphVersion}`),
      `慢快照挂起期间账单版本应维持 v0（严禁提前跳到 v${backendSnapV1.graphVersion}），实际：${billGvWhileSlow}`,
    );
    assert.equal(compGvWhileSlow, '0', '慢快照挂起期间改写比较基准版本应维持 0');
    assert.equal(await page.getByTestId('galaxy-empty-state').isVisible(), true, '慢快照期间空图态应维持旧版');
    assert.equal(await page.getByTestId('bill-empty-state').isVisible(), true, '慢快照期间空账单态应维持旧版');
    assert.equal(await page.getByTestId('graph-node-item').count(), 0, '慢快照期间不得提前渲染新节点');
    assert.ok(
      billRateWhileSlow.includes('暂未确定'),
      `慢快照期间账单报价不得提前显示新百分比，实际：${billRateWhileSlow}`,
    );

    // 放行慢快照：图、节点列表、账单版本、报价数字、冲突项与事实同时更新至 v1
    holdSlowSnapshot = false;
    releaseSlowSnapshot();

    await waitForSyncStatus(page, 'idle', 15_000);
    await waitForTurnStatus(page, 'committed', 15_000);
    await page.unroute(`**${sessionPathname}`);
    assert.equal(await page.getByTestId('snapshot-sync-banner').isVisible(), false, '同步完成后同步提示栏应隐藏');

    assert.ok(((await page.getByTestId('graph-version-badge').textContent()) ?? '').includes(`v${backendSnapV1.graphVersion}`));
    assert.ok(((await page.getByTestId('bill-graph-version').textContent()) ?? '').includes(`v${backendSnapV1.graphVersion}`));
    assert.equal(await page.getByTestId('comparison-panel').getAttribute('data-graph-version'), String(backendSnapV1.graphVersion));
    assert.equal(await page.getByTestId('galaxy-empty-state').isVisible(), false);
    assert.equal(await page.getByTestId('bill-empty-state').isVisible(), false);

    const domNodesV1 = await readDomGraphNodeIds(page);
    assert.deepEqual(
      [...domNodesV1].sort(),
      backendSnapV1.confirmedGraph.map((n) => n.id).sort(),
      '放行慢快照后星图节点列表应与后端 v1 完全一致',
    );
    const billRateV1 = (await page.getByTestId('bill-rate').textContent()) ?? '';
    assert.ok(
      billRateV1.includes(`${Math.round(quoteV1.rate)}%`),
      `放行慢快照后账单报价应同步为 ${Math.round(quoteV1.rate)}%，实际：${billRateV1}`,
    );
    const domImpactV1 = await readDomImpactNodeIds(page);
    assert.deepEqual(
      [...domImpactV1].sort(),
      [...(quoteV1.affected ?? [])].sort(),
      '放行慢快照后账单冲突影响节点应与后端 v1 完全一致',
    );
    const domFactsV1 = await readDomFactIds(page);
    assert.deepEqual(
      [...domFactsV1].sort(),
      backendSnapV1.facts.map((f) => f.id).sort(),
      '放行慢快照后事实列表应与后端 v1 完全一致',
    );

    // 3. 失败快照 + 可见重试：提交第二条独立事实使后端推进到 v2，但拦截快照返回 500
    let failSnapshotHits = 0;
    let notifyFailSnapshotHit = null;
    const failSnapshotHitPromise = new Promise((resolvePromise) => {
      notifyFailSnapshotHit = resolvePromise;
    });
    let shouldFailSnapshot = true;

    await page.route(`**${sessionPathname}`, async (route) => {
      const parsed = new URL(route.request().url());
      if (shouldFailSnapshot && route.request().method() === 'GET' && parsed.pathname === sessionPathname) {
        failSnapshotHits += 1;
        notifyFailSnapshotHit();
        await route.fulfill({
          status: 500,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({
            schemaVersion: 1,
            protocolVersion: 'quotation-backend/v1',
            ok: false,
            data: null,
            error: { code: 'INTERNAL_ERROR', message: '模拟快照同步临时失败' },
          }),
        });
        return;
      }
      await route.continue();
    });

    await submitTurnActionAndWaitSseDone(page, async () => {
      await page.getByTestId('turn-input').fill('我本人平时也会通过播客订阅表主动探索完全陌生的冷门科普话题。');
      await page.getByTestId('submit-fact-btn').click();
    });
    await failSnapshotHitPromise;
    assert.ok(failSnapshotHits >= 1, '应真实拦截到提交后的快照 GET 并返回 500');

    const backendSnapV2 = await waitForHostSnapshot(
      host.origin,
      host.internalToken,
      sessionId,
      (s) => s.graphVersion > backendSnapV1.graphVersion && s.facts.filter((f) => f.status === 'active').length >= 2,
    );

    // 失败态：整组维持旧版本 v1，且同步栏与重试按钮可见
    await page.getByTestId('snapshot-sync-banner').waitFor({ state: 'visible', timeout: 10_000 });
    await waitForSyncStatus(page, 'error', 10_000);
    await page.getByTestId('snapshot-retry-btn').waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await page.getByTestId('snapshot-retry-btn').isEnabled(), true, '快照失败后重试按钮应可点击');

    const gvWhileFailed = (await page.getByTestId('graph-version-badge').textContent()) ?? '';
    const billGvWhileFailed = (await page.getByTestId('bill-graph-version').textContent()) ?? '';
    assert.ok(
      gvWhileFailed.includes(`v${backendSnapV1.graphVersion}`) && !gvWhileFailed.includes(`v${backendSnapV2.graphVersion}`),
      `快照失败期间星图版本应维持旧版 v${backendSnapV1.graphVersion}，实际：${gvWhileFailed}`,
    );
    assert.ok(
      billGvWhileFailed.includes(`v${backendSnapV1.graphVersion}`) && !billGvWhileFailed.includes(`v${backendSnapV2.graphVersion}`),
      `快照失败期间账单版本应维持旧版 v${backendSnapV1.graphVersion}，实际：${billGvWhileFailed}`,
    );
    assert.equal(
      await page.getByTestId('comparison-panel').getAttribute('data-graph-version'),
      String(backendSnapV1.graphVersion),
      '快照失败期间比较面板版本应维持旧版',
    );
    assert.deepEqual(
      [...(await readDomGraphNodeIds(page))].sort(),
      [...domNodesV1].sort(),
      '快照失败期间星图节点应维持旧版 v1',
    );
    assert.deepEqual(
      [...(await readDomFactIds(page))].sort(),
      [...domFactsV1].sort(),
      '快照失败期间事实列表应维持旧版 v1',
    );

    // 取消拦截后点击重试按钮 -> 图账与事实原子更新至 v2 并与后端一致
    shouldFailSnapshot = false;
    await page.unroute(`**${sessionPathname}`);
    await page.getByTestId('snapshot-retry-btn').click();

    await waitForSyncStatus(page, 'idle', 15_000);
    await waitForTurnStatus(page, 'committed', 15_000);
    assert.equal(await page.getByTestId('snapshot-sync-banner').isVisible(), false, '重试成功后同步栏应隐藏');

    assert.ok(((await page.getByTestId('graph-version-badge').textContent()) ?? '').includes(`v${backendSnapV2.graphVersion}`));
    assert.ok(((await page.getByTestId('bill-graph-version').textContent()) ?? '').includes(`v${backendSnapV2.graphVersion}`));
    assert.equal(await page.getByTestId('comparison-panel').getAttribute('data-graph-version'), String(backendSnapV2.graphVersion));
    assert.deepEqual(
      [...(await readDomGraphNodeIds(page))].sort(),
      backendSnapV2.confirmedGraph.map((n) => n.id).sort(),
      '重试成功后星图节点应原子更新至后端 v2',
    );
    assert.deepEqual(
      [...(await readDomFactIds(page))].sort(),
      backendSnapV2.facts.map((f) => f.id).sort(),
      '重试成功后事实列表应原子更新至后端 v2',
    );
    const { primaryQuote: quoteV2 } = getPrimaryQuoteFromSnapshot(backendSnapV2);
    const billRateV2 = (await page.getByTestId('bill-rate').textContent()) ?? '';
    if (quoteV2 && quoteV2.rate !== null && quoteV2.assessment !== 'insufficient_evidence') {
      assert.ok(billRateV2.includes(`${Math.round(quoteV2.rate)}%`), `重试成功后账单报价应与后端 v2 一致，实际：${billRateV2}`);
    }

    // 4. 唯一采用标识核验：提交“换语气”和“缩小范围”两份改写并采用其中一份
    await submitAndWaitCommitted(
      page,
      '换个说法：在我看来，推荐算法对人的兴趣只有变窄这一种作用。',
      'submit-rewrite-tone-btn',
    );
    await submitAndWaitCommitted(
      page,
      '如果改成：连续听同类歌曲之后，推荐里的新东西会越来越少。',
      'submit-rewrite-scope-btn',
    );

    const snapBeforeAdopt = await fetchHostSnapshot(host.origin, host.internalToken, sessionId);
    const scopeStmt = snapBeforeAdopt.statements.find(
      (s) => s.role !== 'original' && s.text.includes('连续听同类歌曲之后'),
    );
    assert.ok(scopeStmt?.statementId, '应找到缩小范围改写的真实 statementId');

    const targetCompItem = page.locator(
      `[data-testid="comparison-item"][data-statement-id="${scopeStmt.statementId}"]`,
    );
    await targetCompItem.waitFor({ state: 'visible', timeout: 10_000 });
    await submitTurnActionAndWaitCommitted(page, async () => {
      await targetCompItem.getByTestId('adopt-rewrite-btn').click();
    });

    const snapAfterAdopt = await fetchHostSnapshot(host.origin, host.internalToken, sessionId);
    assert.equal(snapAfterAdopt.adoptedStatementId, scopeStmt.statementId, '后端 adoptedStatementId 应等于采用项');

    // 断言页面上可见的 [data-testid="adopted-badge"] 严格为 1，且仅属于被采用的 statementId
    const visibleAdoptedBadges = await page.locator('[data-testid="adopted-badge"]').evaluateAll((els) =>
      els
        .filter((el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return !el.hidden && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        })
        .map((el) => ({
          id: el.id || null,
          text: el.textContent?.trim() ?? '',
          statementId: el.closest('[data-testid="comparison-item"]')?.getAttribute('data-statement-id') ?? null,
        })),
    );
    assert.equal(
      visibleAdoptedBadges.length,
      1,
      `页面上可见的 adopted-badge 数量必须严格为 1，实际：${JSON.stringify(visibleAdoptedBadges)}`,
    );
    assert.equal(
      visibleAdoptedBadges[0].statementId,
      scopeStmt.statementId,
      `唯一可见的 adopted-badge 必须属于已采用的 ${scopeStmt.statementId}，实际：${JSON.stringify(visibleAdoptedBadges[0])}`,
    );
    assert.equal(
      await page.locator('#oldAdoptedBadge').isVisible(),
      false,
      '采用改写后原句卡片的 oldAdoptedBadge 必须不可见',
    );

    const compItemsState = await page.getByTestId('comparison-item').evaluateAll((els) =>
      els.map((el) => ({
        statementId: el.getAttribute('data-statement-id'),
        adopted: el.getAttribute('data-adopted'),
        badgeCount: el.querySelectorAll('[data-testid="adopted-badge"]').length,
      })),
    );
    for (const item of compItemsState) {
      if (item.statementId === scopeStmt.statementId) {
        assert.equal(item.adopted, 'true', '已采用卡片 data-adopted 必须为 true');
        assert.equal(item.badgeCount, 1, '已采用卡片必须包含 1 个 adopted-badge');
      } else {
        assert.equal(item.adopted, 'false', `未采用卡片(${item.statementId}) data-adopted 必须为 false`);
        assert.equal(item.badgeCount, 0, `未采用卡片(${item.statementId}) 不应包含 adopted-badge`);
      }
    }

    // 5. 全部撤回后空图显示真实版本（绝不硬编码 v0）
    const activeFactsToRetract = snapAfterAdopt.facts.filter((f) => f.status === 'active');
    assert.ok(activeFactsToRetract.length >= 2, '撤回前应有至少 2 条有效事实');

    for (const fact of activeFactsToRetract) {
      const factRow = page.locator(`[data-testid="fact-item"][data-fact-id="${fact.id}"]`);
      await factRow.waitFor({ state: 'visible', timeout: 10_000 });
      await submitTurnActionAndWaitCommitted(page, async () => {
        await factRow.getByTestId('retract-fact-btn').click();
      });
    }

    const snapAfterRetractAll = await fetchHostSnapshot(host.origin, host.internalToken, sessionId);
    const finalGv = snapAfterRetractAll.graphVersion;
    assert.equal(snapAfterRetractAll.confirmedGraph.length, 0, '全部事实撤回后已确认图应为空');
    assert.ok(finalGv >= 3, `全部撤回后后端真实图版本应 >= 3，实际 v${finalGv}`);

    assert.equal(await page.getByTestId('galaxy-empty-state').isVisible(), true, '全部撤回后星图空态应可见');
    assert.equal(await page.getByTestId('bill-empty-state').isVisible(), true, '全部撤回后账单空态应可见');
    assert.equal(await page.getByTestId('graph-node-item').count(), 0);

    const galaxyEmptyText = (await page.getByTestId('galaxy-empty-state').textContent()) ?? '';
    const billEmptyText = (await page.getByTestId('bill-empty-state').textContent()) ?? '';
    assert.ok(
      galaxyEmptyText.includes(`v${finalGv}`) && !galaxyEmptyText.includes('v0'),
      `全部撤回后星图空态必须显示真实版本 v${finalGv} 且不得硬编码 v0，实际：${galaxyEmptyText}`,
    );
    assert.ok(
      billEmptyText.includes(`v${finalGv}`) && !billEmptyText.includes('v0'),
      `全部撤回后账单空态必须显示真实版本 v${finalGv} 且不得硬编码 v0，实际：${billEmptyText}`,
    );
    assert.ok(((await page.getByTestId('graph-version-badge').textContent()) ?? '').includes(`v${finalGv}`));
    assert.ok(((await page.getByTestId('bill-graph-version').textContent()) ?? '').includes(`v${finalGv}`));

    await assertNoBearerLeakInBrowser(page, tracker, host.internalToken);
    assert.equal(
      tracker.pageErrors.length,
      0,
      `桌面端 F-C2 不应出现未捕获 JS 异常：${tracker.pageErrors.map((e) => e.message).join('; ')}`,
    );
    await desktopCtx.close();

    // ===== Part B：手机端（390x844）输入、空态真实版本、快照失败重试恢复同步 =====
    const mobileCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const mobilePage = await mobileCtx.newPage();
    const mobileTracker = attachNetworkTracker(mobilePage, host.origin);

    await enterLiveDemoWorkspace(mobilePage, host.origin);
    const mobileCreateResp = mobileTracker.responses.find(
      (r) => r.method === 'POST' && r.pathname === '/v1/sessions' && r.status === 201,
    );
    assert.ok(mobileCreateResp?.json?.data?.sessionId, '手机端应成功创建合成会话');
    const mobileSessionId = mobileCreateResp.json.data.sessionId;
    const mobileSessionPathname = `/v1/sessions/${mobileSessionId}`;

    // 初始空态校验
    assert.equal(await mobilePage.getByTestId('galaxy-empty-state').isVisible(), true);
    assert.equal(await mobilePage.getByTestId('bill-empty-state').isVisible(), true);
    assert.ok(((await mobilePage.getByTestId('galaxy-empty-state').textContent()) ?? '').includes('v0'));
    assert.ok(((await mobilePage.getByTestId('bill-empty-state').textContent()) ?? '').includes('v0'));

    // 手机端提交原句
    await submitAndWaitCommitted(mobilePage, '推荐算法只会让人的兴趣越来越窄。', 'submit-turn-btn');
    const mobileFocusText = (await mobilePage.getByTestId('focus-panel').textContent()) ?? '';
    assert.ok(mobileFocusText.includes('只会'), `手机端焦点面板应展示“只会”，实际：${mobileFocusText}`);

    // 手机端提交事实后拦截快照返回 500 -> 验证可见重试入口并点击重试恢复同步
    let mobileShouldFailSnapshot = true;
    let notifyMobileFailHit = null;
    const mobileFailHitPromise = new Promise((resolvePromise) => {
      notifyMobileFailHit = resolvePromise;
    });

    await mobilePage.route(`**${mobileSessionPathname}`, async (route) => {
      const parsed = new URL(route.request().url());
      if (mobileShouldFailSnapshot && route.request().method() === 'GET' && parsed.pathname === mobileSessionPathname) {
        notifyMobileFailHit();
        await route.fulfill({
          status: 500,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({
            schemaVersion: 1,
            protocolVersion: 'quotation-backend/v1',
            ok: false,
            data: null,
            error: { code: 'INTERNAL_ERROR', message: '手机端模拟快照失败' },
          }),
        });
        return;
      }
      await route.continue();
    });

    await submitTurnActionAndWaitSseDone(mobilePage, async () => {
      await mobilePage.getByTestId('turn-input').fill('我确实通过推荐发现过新乐队。');
      await mobilePage.getByTestId('submit-fact-btn').click();
    });
    await mobileFailHitPromise;

    const mobileSnapV1 = await waitForHostSnapshot(
      host.origin,
      host.internalToken,
      mobileSessionId,
      (s) => s.graphVersion >= 1 && s.confirmedGraph.length > 0,
    );

    await mobilePage.getByTestId('snapshot-sync-banner').waitFor({ state: 'visible', timeout: 10_000 });
    await waitForSyncStatus(mobilePage, 'error', 10_000);
    const mobileRetryBtn = mobilePage.getByTestId('snapshot-retry-btn');
    await mobileRetryBtn.waitFor({ state: 'visible', timeout: 10_000 });
    const retryBox = await mobileRetryBtn.boundingBox();
    assert.ok(retryBox && retryBox.width > 0 && retryBox.height > 0, '手机端快照重试按钮应具备可见尺寸');

    // 快照失败期间手机端图账维持 v0
    assert.ok(((await mobilePage.getByTestId('graph-version-badge').textContent()) ?? '').includes('v0'));
    assert.ok(((await mobilePage.getByTestId('bill-graph-version').textContent()) ?? '').includes('v0'));

    // 取消拦截并点击重试 -> 恢复同步到 v1
    mobileShouldFailSnapshot = false;
    await mobilePage.unroute(`**${mobileSessionPathname}`);
    await mobileRetryBtn.click();

    await waitForSyncStatus(mobilePage, 'idle', 15_000);
    await waitForTurnStatus(mobilePage, 'committed', 15_000);
    assert.equal(await mobilePage.getByTestId('snapshot-sync-banner').isVisible(), false);
    assert.ok(((await mobilePage.getByTestId('graph-version-badge').textContent()) ?? '').includes(`v${mobileSnapV1.graphVersion}`));
    assert.ok(((await mobilePage.getByTestId('bill-graph-version').textContent()) ?? '').includes(`v${mobileSnapV1.graphVersion}`));
    assert.deepEqual(
      [...(await readDomGraphNodeIds(mobilePage))].sort(),
      mobileSnapV1.confirmedGraph.map((n) => n.id).sort(),
      '手机端重试成功后星图节点应与后端快照一致',
    );

    // 手机端撤回全部有效事实 -> 验证空图与空账单空态显示真实版本号（非 v0）
    const mobileActiveFacts = mobileSnapV1.facts.filter((f) => f.status === 'active');
    assert.ok(mobileActiveFacts.length >= 1);
    for (const fact of mobileActiveFacts) {
      const factRow = mobilePage.locator(`[data-testid="fact-item"][data-fact-id="${fact.id}"]`);
      await factRow.waitFor({ state: 'visible', timeout: 10_000 });
      await submitTurnActionAndWaitCommitted(mobilePage, async () => {
        await factRow.getByTestId('retract-fact-btn').click();
      });
    }

    const mobileSnapAfterRetract = await fetchHostSnapshot(host.origin, host.internalToken, mobileSessionId);
    const mobileFinalGv = mobileSnapAfterRetract.graphVersion;
    assert.equal(mobileSnapAfterRetract.confirmedGraph.length, 0);
    assert.ok(mobileFinalGv >= 2, `手机端撤回后真实图版本应 >= 2，实际 v${mobileFinalGv}`);

    const mobileGalaxyEmpty = (await mobilePage.getByTestId('galaxy-empty-state').textContent()) ?? '';
    const mobileBillEmpty = (await mobilePage.getByTestId('bill-empty-state').textContent()) ?? '';
    assert.equal(await mobilePage.getByTestId('galaxy-empty-state').isVisible(), true);
    assert.equal(await mobilePage.getByTestId('bill-empty-state').isVisible(), true);
    assert.ok(
      mobileGalaxyEmpty.includes(`v${mobileFinalGv}`) && !mobileGalaxyEmpty.includes('v0'),
      `手机端空图态必须显示真实版本 v${mobileFinalGv}，实际：${mobileGalaxyEmpty}`,
    );
    assert.ok(
      mobileBillEmpty.includes(`v${mobileFinalGv}`) && !mobileBillEmpty.includes('v0'),
      `手机端空账单态必须显示真实版本 v${mobileFinalGv}，实际：${mobileBillEmpty}`,
    );

    await assertNoBearerLeakInBrowser(mobilePage, mobileTracker, host.internalToken);
    assert.equal(
      mobileTracker.pageErrors.length,
      0,
      `手机端 F-C2 不应出现未捕获 JS 异常：${mobileTracker.pageErrors.map((e) => e.message).join('; ')}`,
    );
    await mobileCtx.close();
  } finally {
    await browser.close();
    await host.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
