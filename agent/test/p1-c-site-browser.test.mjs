// P1-C 浏览器端到端验收测试（R-C1 正常闭环 + R-C2 桌面/手机尺寸、恢复与异常）。
// 使用同源合成宿主（demo-web-host.mjs）+ 真实 Chromium，零外部凭证可复跑。
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
      return txt.length >= 6 && txt !== '—' && txt !== '未创建';
    },
    null,
    { timeout: 15_000 },
  );
}

async function waitForTurnStatus(page, expectedStatus, timeout = 20_000) {
  await page.waitForFunction(
    (status) => {
      const badge = document.querySelector('[data-testid="turn-status-badge"]');
      return badge?.getAttribute('data-status') === status;
    },
    expectedStatus,
    { timeout },
  );
}

async function submitTurnActionAndWaitCommitted(page, triggerAction) {
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
    const postPromise = page.waitForResponse(
      (res) => res.request().method() === 'POST' && /^\/v1\/sessions\/[^/]+\/turns$/.test(new URL(res.url()).pathname),
      { timeout: 15_000 },
    );
    await triggerAction();
    const turnRes = await postPromise;
    assert.equal(turnRes.status(), 202, `提交轮次应返回 202，实际 ${turnRes.status()}`);
    const turnPayload = await turnRes.json();
    const { turnId, eventsUrl } = turnPayload.data;

    if (!sseFinishedByPath.has(eventsUrl)) {
      const sseRes = await page.waitForResponse(
        (res) => res.request().method() === 'GET' && new URL(res.url()).pathname === eventsUrl,
        { timeout: 15_000 },
      );
      await sseRes.finished().catch(() => {});
    } else {
      await sseFinishedByPath.get(eventsUrl);
    }

    await waitForTurnStatus(page, 'committed', 25_000);
    await page.waitForTimeout(80);
    return { turnId, turnPayload: turnPayload.data };
  } finally {
    page.off('response', onResponse);
  }
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
  assert.equal(res.status, 200);
  return (await res.json()).data;
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

function createControllableStreamModel() {
  let activeGate = null;
  let callIndex = 0;

  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      callIndex += 1;
      const currentCall = callIndex;
      let releaseFn;
      const gate = new Promise((resolvePromise) => {
        releaseFn = resolvePromise;
      });
      activeGate = { callIndex: currentCall, release: releaseFn };

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
    releaseCurrent() {
      activeGate?.release?.();
    },
  };
}

test('R-C1 正式首页合成会话正常闭环：分析原句、证据核验、补充事实、双改写同图比较与采用、指定撤回及跨领域输入', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'quotation-p1c-rc1-'));
  const dbPath = path.join(tmpDir, 'rc1-demo.sqlite');
  const host = await startDemoWebHost({
    host: '127.0.0.1',
    port: 0,
    dbPath,
    quiet: true,
  });
  const browser = await launchBrowser();

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const tracker = attachNetworkTracker(page, host.origin);

    // 1. 从正式首页进入合成会话
    await enterLiveDemoWorkspace(page, host.origin);

    const modeBadgeText = (await page.getByTestId('live-mode-badge').textContent())?.trim() ?? '';
    assert.ok(modeBadgeText.length > 0, '应明确展示当前为合成演示模式');

    const createResp = tracker.responses.find(
      (r) => r.method === 'POST' && r.pathname === '/v1/sessions' && r.status === 201,
    );
    assert.ok(createResp?.json?.data?.sessionId, '应实际发出 POST /v1/sessions 创建合成会话');
    const sessionId = createResp.json.data.sessionId;

    const displayedSessionId = (await page.getByTestId('session-id-label').textContent())?.trim() ?? '';
    assert.ok(
      displayedSessionId.includes(sessionId) || displayedSessionId.includes(sessionId.slice(0, 8)),
      `页面应展示真实会话 ID（期望包含 ${sessionId}，实际 ${displayedSessionId}）`,
    );

    // 初始空图与空账单空态可见
    assert.equal(await page.getByTestId('galaxy-empty-state').isVisible(), true, '空图时应显示可继续操作的空态');
    assert.equal(await page.getByTestId('bill-empty-state').isVisible(), true, '初始无报价时应显示账单空态');

    // 2. 输入“推荐算法只会让人的兴趣越来越窄”
    await submitAndWaitCommitted(page, '推荐算法只会让人的兴趣越来越窄。', 'submit-turn-btn');

    const focusText = (await page.getByTestId('focus-panel').textContent()) ?? '';
    assert.ok(focusText.includes('只会'), `焦点面板应展示系统拆出的焦点“只会”，实际：${focusText}`);

    const explanationText = (await page.getByTestId('stream-explanation').textContent())?.trim() ?? '';
    assert.ok(explanationText.length > 10, '应渲染来自真实 SSE 流的增量解释');

    const evidenceCards = page.getByTestId('evidence-card');
    await evidenceCards.first().waitFor({ state: 'visible', timeout: 10_000 });
    const firstEvId = await evidenceCards.first().getAttribute('data-evidence-id');
    assert.ok(firstEvId, '证据卡应绑定后端返回的真实 data-evidence-id');
    // 点击打开一条有来源的合成证据
    await evidenceCards.first().click();
    const evidenceListText = (await page.getByTestId('evidence-list').textContent()) ?? '';
    assert.ok(evidenceListText.includes('周牧') || evidenceListText.includes('推荐'), '证据列表应展示真实合成来源');

    // 3. 授权者角色补充本人事实：“我确实通过推荐发现过新乐队”
    await submitAndWaitCommitted(page, '我确实通过推荐发现过新乐队。', 'submit-fact-btn');
    const snapAfterFact1 = await fetchHostSnapshot(host.origin, host.internalToken, sessionId);
    assert.ok(snapAfterFact1.graphVersion >= 1, '补充本人事实后后端 graphVersion 应递增');

    const gvText1 = (await page.getByTestId('graph-version-badge').textContent()) ?? '';
    const billGvText1 = (await page.getByTestId('bill-graph-version').textContent()) ?? '';
    assert.ok(gvText1.includes(String(snapAfterFact1.graphVersion)), '星图版本号应与后端提交版本一致');
    assert.ok(billGvText1.includes(String(snapAfterFact1.graphVersion)), '账单版本号应与星图版本一致');

    const graphItems = page.getByTestId('graph-node-item');
    await graphItems.first().waitFor({ state: 'visible', timeout: 10_000 });
    const firstNodeId = await graphItems.first().getAttribute('data-node-id');
    assert.ok(
      snapAfterFact1.confirmedGraph.some((n) => n.id === firstNodeId),
      `星图节点 data-node-id(${firstNodeId}) 必须来自后端真实已确认图`,
    );

    // 验证点击节点绑定焦点操作
    const bindBtn = graphItems.first().getByTestId('bind-focus-node-btn');
    if (await bindBtn.isVisible().catch(() => false)) {
      await bindBtn.click();
    } else {
      await graphItems.first().click();
    }

    const activeFact1 = snapAfterFact1.facts.find((f) => f.status === 'active');
    assert.ok(activeFact1?.id, '后端快照应存在首条已激活事实');
    await page.locator(`[data-testid="fact-item"][data-fact-id="${activeFact1.id}"]`).waitFor({ state: 'visible' });

    // 4. 再补充一条独立事实
    await submitAndWaitCommitted(
      page,
      '我本人平时也会通过播客订阅表主动探索完全陌生的冷门科普话题。',
      'submit-fact-btn',
    );
    const snapAfterFact2 = await fetchHostSnapshot(host.origin, host.internalToken, sessionId);
    const activeFactsAfter2 = snapAfterFact2.facts.filter((f) => f.status === 'active');
    assert.ok(activeFactsAfter2.length >= 2, '补充第二条独立事实后应有至少 2 条有效事实');
    const secondFact = activeFactsAfter2.find((f) => f.id !== activeFact1.id);
    assert.ok(secondFact?.id);

    // 5. 提交“换语气”和“缩小范围”两份改写
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

    const snapAfterRewrites = await fetchHostSnapshot(host.origin, host.internalToken, sessionId);
    const expectedGv = String(snapAfterRewrites.graphVersion);

    const compPanel = page.getByTestId('comparison-panel');
    await compPanel.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(
      await compPanel.getAttribute('data-graph-version'),
      expectedGv,
      '改写比较面板必须使用与账单、星图相同的 graphVersion',
    );
    assert.ok(
      ((await page.getByTestId('bill-graph-version').textContent()) ?? '').includes(expectedGv),
      '账单版本必须与比较面板同步',
    );

    const compItems = page.getByTestId('comparison-item');
    assert.ok((await compItems.count()) >= 3, '应并列展示原句与两份改写');

    const compText = (await compPanel.textContent()) ?? '';
    assert.ok(compText.includes('推荐算法只会让人的兴趣越来越窄'), '比较区应包含原句');
    assert.ok(compText.includes('暂未确定'), '空比例（证据不足）的缩小范围改写应显示“暂未确定”');

    // 6. 明确采用其中一份改写（按后端实际 statementId）
    const scopeStmt = snapAfterRewrites.statements.find(
      (s) => s.role !== 'original' && s.text.includes('连续听同类歌曲之后'),
    );
    assert.ok(scopeStmt?.statementId, '后端应返回缩小范围改写的真实 statementId');

    const targetCompItem = page.locator(
      `[data-testid="comparison-item"][data-statement-id="${scopeStmt.statementId}"]`,
    );
    await targetCompItem.waitFor({ state: 'visible' });
    await submitTurnActionAndWaitCommitted(page, async () => {
      await targetCompItem.getByTestId('adopt-rewrite-btn').click();
    });

    await targetCompItem.getByTestId('adopted-badge').waitFor({ state: 'visible', timeout: 10_000 });
    const snapAfterAdopt = await fetchHostSnapshot(host.origin, host.internalToken, sessionId);
    assert.equal(snapAfterAdopt.adoptedStatementId, scopeStmt.statementId, '后端 adoptedStatementId 应与界面采用结果一致');

    // 7. 撤回最早的指定事实（activeFact1），验证对应节点和报价更新，独立事实（secondFact）仍在
    const earliestFactItem = page.locator(`[data-testid="fact-item"][data-fact-id="${activeFact1.id}"]`);
    await submitTurnActionAndWaitCommitted(page, async () => {
      await earliestFactItem.getByTestId('retract-fact-btn').click();
    });

    const snapAfterRetract = await fetchHostSnapshot(host.origin, host.internalToken, sessionId);
    assert.ok(snapAfterRetract.graphVersion > snapAfterAdopt.graphVersion, '撤回最早事实后 graphVersion 应递增');

    const retractedFactInDom = page.locator(`[data-testid="fact-item"][data-fact-id="${activeFact1.id}"]`);
    assert.equal(
      await retractedFactInDom.getAttribute('data-fact-status'),
      'retracted',
      '被撤回事实在界面中应标记为 retracted',
    );
    const preservedFactInDom = page.locator(`[data-testid="fact-item"][data-fact-id="${secondFact.id}"]`);
    assert.equal(
      await preservedFactInDom.getAttribute('data-fact-status'),
      'active',
      '独立事实在撤回最早事实后必须继续保持 active',
    );

    const billGvAfterRetract = (await page.getByTestId('bill-graph-version').textContent()) ?? '';
    assert.ok(billGvAfterRetract.includes(String(snapAfterRetract.graphVersion)), '撤回后账单版本号应同步刷新');

    // 8. 换一句来自其他领域的输入，验证页面可提交并展示真实响应
    await submitAndWaitCommitted(page, '远程办公必然降低所有团队的协作效率。', 'submit-turn-btn');
    const otherDomainFocus = (await page.getByTestId('focus-panel').textContent()) ?? '';
    assert.ok(otherDomainFocus.includes('必然'), `其他领域新句应识别焦点“必然”，实际：${otherDomainFocus}`);
    const otherDomainExplanation = (await page.getByTestId('stream-explanation').textContent()) ?? '';
    assert.ok(otherDomainExplanation.trim().length > 10, '其他领域新句应展示真实流式响应');

    // 9. 断言真实发生了创建、提交、SSE 与快照请求，无 Bearer 泄露，无未捕获异常
    assert.ok(tracker.requests.some((r) => r.method === 'POST' && r.pathname === '/v1/sessions'));
    assert.ok(tracker.requests.some((r) => r.method === 'POST' && /^\/v1\/sessions\/[^/]+\/turns$/.test(r.pathname)));
    assert.ok(tracker.requests.some((r) => r.method === 'GET' && /^\/v1\/sessions\/[^/]+\/turns\/[^/]+\/events$/.test(r.pathname)));
    assert.ok(tracker.requests.some((r) => r.method === 'GET' && /^\/v1\/sessions\/[^/]+$/.test(r.pathname)));
    await assertNoBearerLeakInBrowser(page, tracker, host.internalToken);
    assert.equal(tracker.pageErrors.length, 0, `页面不应出现未捕获 JS 异常：${tracker.pageErrors.map((e) => e.message).join('; ')}`);

    await context.close();
  } finally {
    await browser.close();
    await host.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('R-C2 桌面与手机尺寸空态/证据不足/异常提示，以及可控模型断线按事件 ID 续读、主动取消与页面刷新恢复', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'quotation-p1c-rc2-'));
  const dbPath = path.join(tmpDir, 'rc2-demo.sqlite');
  const controllable = createControllableStreamModel();

  const sseConnections = [];
  let dropNextSseConnection = false;
  let activeSseResToDrop = null;

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
      if (dropNextSseConnection) {
        dropNextSseConnection = false;
        activeSseResToDrop = info.response;
      }
    },
  });
  const browser = await launchBrowser();

  try {
    // ===== Part A：桌面端（1440x900）可控流暂停 -> 断线按 Last-Event-ID 恢复 -> 主动取消 -> 刷新恢复 -> 请求失败与 409 版本过期 =====
    const desktopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await desktopCtx.newPage();
    const tracker = attachNetworkTracker(page, host.origin);

    await enterLiveDemoWorkspace(page, host.origin);
    const createdResp = tracker.responses.find(
      (r) => r.method === 'POST' && r.pathname === '/v1/sessions' && r.status === 201,
    );
    assert.ok(createdResp?.json?.data?.sessionId);
    const sessionId = createdResp.json.data.sessionId;

    // A1. 断线续读：第一段已显示时中断 SSE，再放行第二段，验证按 Last-Event-ID 自动恢复且无重复
    dropNextSseConnection = true;
    await page.getByTestId('turn-input').fill('推荐算法只会让人的兴趣越来越窄。');
    await page.getByTestId('submit-turn-btn').click();

    await page.waitForFunction(
      () => (document.querySelector('[data-testid="stream-explanation"]')?.textContent ?? '').includes('第1轮首段流式输出'),
      null,
      { timeout: 15_000 },
    );

    // 确认状态处于运行/加载中，然后服务端强制中断第一条 SSE 连接
    assert.ok(activeSseResToDrop, '应已捕获第一条 SSE 响应对象');
    activeSseResToDrop.destroy();
    activeSseResToDrop = null;

    // 放行可控模型第二段输出
    controllable.releaseCurrent();
    await waitForTurnStatus(page, 'committed', 20_000);

    const resumedText = (await page.getByTestId('stream-explanation').textContent()) ?? '';
    assert.ok(resumedText.includes('第1轮首段流式输出'), '断线恢复后第一段文本应保留');
    assert.ok(resumedText.includes('第1轮续段补齐输出'), '断线恢复后第二段文本应按事件 ID 补齐');
    assert.equal(
      resumedText.split('第1轮首段流式输出').length - 1,
      1,
      '按 Last-Event-ID 续读去重后不得重复拼接第一段文本',
    );
    assert.ok(
      sseConnections.some((c) => c.lastEventId !== null && Number(c.lastEventId) > 0),
      '断线重连请求必须携带非零 Last-Event-ID 头',
    );

    // 验证空图/证据不足时账单显示“暂未确定”
    const billRateText = (await page.getByTestId('bill-rate').textContent()) ?? '';
    assert.ok(billRateText.includes('暂未确定') || (await page.getByTestId('bill-empty-state').isVisible()), '尚无本人已确认图时报价应为暂未确定或空态');

    // A2. 提交一条本人事实并放行，形成 graphVersion >= 1，为后续取消与刷新恢复建立基线
    await page.getByTestId('turn-input').fill('我确实通过推荐发现过新乐队。');
    await page.getByTestId('submit-fact-btn').click();
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="stream-explanation"]')?.textContent ?? '').includes('第2轮首段流式输出'),
      null,
      { timeout: 15_000 },
    );
    controllable.releaseCurrent();
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="stream-explanation"]')?.textContent ?? '').includes('第2轮续段补齐输出'),
      null,
      { timeout: 15_000 },
    );
    await waitForTurnStatus(page, 'committed', 20_000);

    const snapBeforeCancel = await fetchHostSnapshot(host.origin, host.internalToken, sessionId);
    assert.ok(snapBeforeCancel.graphVersion >= 1);

    // A3. 主动取消：启动新轮次后在流式暂停期间点击停止按钮
    await page.getByTestId('turn-input').fill('如果改成：连续听同类歌曲之后，推荐里的新东西会越来越少。');
    await page.getByTestId('submit-turn-btn').click();
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="stream-explanation"]')?.textContent ?? '').includes('第3轮首段流式输出'),
      null,
      { timeout: 15_000 },
    );
    await page.getByTestId('cancel-turn-btn').click();
    await waitForTurnStatus(page, 'cancelled', 15_000);
    controllable.releaseCurrent();

    assert.ok(
      tracker.requests.some((r) => r.method === 'POST' && /^\/v1\/sessions\/[^/]+\/turns\/[^/]+\/cancel$/.test(r.pathname)),
      '点击停止按钮必须真实调用 cancel 接口',
    );
    const snapAfterCancel = await fetchHostSnapshot(host.origin, host.internalToken, sessionId);
    assert.equal(snapAfterCancel.graphVersion, snapBeforeCancel.graphVersion, '取消轮次不得递增 graphVersion');

    // A4. 浏览器刷新恢复同一会话（GET /v1/sessions/:id）
    const snapshotCountBeforeReload = tracker.requests.filter(
      (r) => r.method === 'GET' && r.pathname === `/v1/sessions/${sessionId}`,
    ).length;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('turn-input').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForFunction(
      (expectedSid) => {
        const txt = document.querySelector('[data-testid="session-id-label"]')?.textContent?.trim() ?? '';
        return txt.includes(expectedSid) || txt.includes(expectedSid.slice(0, 8));
      },
      sessionId,
      { timeout: 15_000 },
    );

    const snapshotCountAfterReload = tracker.requests.filter(
      (r) => r.method === 'GET' && r.pathname === `/v1/sessions/${sessionId}`,
    ).length;
    assert.ok(snapshotCountAfterReload > snapshotCountBeforeReload, '刷新后应通过 GET /v1/sessions/:id 恢复同一会话');
    await page.getByTestId('graph-node-item').first().waitFor({ state: 'visible', timeout: 10_000 });
    assert.ok(
      ((await page.getByTestId('graph-version-badge').textContent()) ?? '').includes(String(snapAfterCancel.graphVersion)),
      '刷新后应恢复同一 graphVersion',
    );

    // A5. 模拟请求失败（500）与版本过期（409 STALE_GRAPH_VERSION）
    let failOnce = true;
    await page.route('**/v1/sessions/*/turns', async (route) => {
      if (failOnce && route.request().method() === 'POST') {
        failOnce = false;
        await route.fulfill({
          status: 500,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({
            schemaVersion: 1,
            protocolVersion: 'quotation-backend/v1',
            ok: false,
            data: null,
            error: { code: 'INTERNAL_ERROR', message: '模拟上游临时失败' },
          }),
        });
        return;
      }
      await route.continue();
    });
    await page.getByTestId('turn-input').fill('测试失败提示恢复路径。');
    await page.getByTestId('submit-turn-btn').click();
    await page.getByTestId('error-banner').waitFor({ state: 'visible', timeout: 10_000 });
    await page.unroute('**/v1/sessions/*/turns');

    let staleOnce = true;
    await page.route('**/v1/sessions/*/turns', async (route) => {
      if (staleOnce && route.request().method() === 'POST') {
        staleOnce = false;
        await route.fulfill({
          status: 409,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({
            schemaVersion: 1,
            protocolVersion: 'quotation-backend/v1',
            ok: false,
            data: null,
            error: {
              code: 'STALE_GRAPH_VERSION',
              message: '图版本已更新，请刷新最新状态后决定是否重试。',
              details: { currentGraphVersion: snapAfterCancel.graphVersion },
            },
          }),
        });
        return;
      }
      await route.continue();
    });
    await page.getByTestId('turn-input').fill('测试版本过期提示与重试。');
    await page.getByTestId('submit-turn-btn').click();
    await page.getByTestId('stale-version-banner').waitFor({ state: 'visible', timeout: 10_000 });
    await page.unroute('**/v1/sessions/*/turns');
    await page.getByTestId('stale-retry-btn').waitFor({ state: 'visible', timeout: 5_000 });

    await assertNoBearerLeakInBrowser(page, tracker, host.internalToken);
    assert.equal(tracker.pageErrors.length, 0, `桌面端不应有未捕获 JS 异常：${tracker.pageErrors.map((e) => e.message).join('; ')}`);
    await desktopCtx.close();

    // ===== Part B：手机端（390x844）覆盖加载、空图、证据不足与请求失败 =====
    const mobileCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const mobilePage = await mobileCtx.newPage();
    const mobileTracker = attachNetworkTracker(mobilePage, host.origin);

    await enterLiveDemoWorkspace(mobilePage, host.origin);
    assert.equal(await mobilePage.getByTestId('galaxy-empty-state').isVisible(), true, '手机端空图应展示空态');
    assert.equal(await mobilePage.getByTestId('bill-empty-state').isVisible(), true, '手机端初始账单应展示空态');

    // 提交一条无匹配个人事实的新话题，观察加载状态与证据不足结果
    await mobilePage.getByTestId('turn-input').fill('深海热泉生态系统的化学合成微生物不会受到洋流变化影响。');
    await mobilePage.getByTestId('submit-turn-btn').click();

    await mobilePage.waitForFunction(
      () => {
        const s = document.querySelector('[data-testid="turn-status-badge"]')?.getAttribute('data-status');
        const txt = document.querySelector('[data-testid="stream-explanation"]')?.textContent ?? '';
        return s === 'running' || s === 'streaming' || txt.includes('首段流式输出');
      },
      null,
      { timeout: 15_000 },
    );
    controllable.releaseCurrent();
    await mobilePage.waitForFunction(
      () => (document.querySelector('[data-testid="stream-explanation"]')?.textContent ?? '').includes('续段补齐输出'),
      null,
      { timeout: 15_000 },
    );
    await waitForTurnStatus(mobilePage, 'committed', 20_000);

    const mobileBillText = (await mobilePage.getByTestId('bill-rate').textContent()) ?? '';
    assert.ok(
      mobileBillText.includes('暂未确定') || (await mobilePage.getByTestId('bill-empty-state').isVisible()),
      '手机端证据不足时应展示暂未确定或空态',
    );

    // 手机端请求失败可见提示
    await mobilePage.route('**/v1/sessions/*/turns', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 503,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({
            schemaVersion: 1,
            protocolVersion: 'quotation-backend/v1',
            ok: false,
            data: null,
            error: { code: 'MODEL_ERROR', message: '手机端模拟服务暂不可用' },
          }),
        });
        return;
      }
      await route.continue();
    });
    await mobilePage.getByTestId('turn-input').fill('手机端触发异常提示。');
    await mobilePage.getByTestId('submit-turn-btn').click();
    await mobilePage.getByTestId('error-banner').waitFor({ state: 'visible', timeout: 10_000 });
    await mobilePage.unroute('**/v1/sessions/*/turns');

    await assertNoBearerLeakInBrowser(mobilePage, mobileTracker, host.internalToken);
    assert.equal(mobileTracker.pageErrors.length, 0, `手机端不应有未捕获 JS 异常：${mobileTracker.pageErrors.map((e) => e.message).join('; ')}`);
    await mobileCtx.close();
  } finally {
    controllable.releaseCurrent();
    await browser.close();
    await host.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
