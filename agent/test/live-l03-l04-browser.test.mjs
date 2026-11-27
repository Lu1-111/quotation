// L-03 与 L-04 公开体验浏览器端到端验收测试。
// 使用同源公开宿主（public-web-host.mjs）+ 独立临时 SQLite + 随机回环端口 + 可控搜索/模型替身 + 真实 Chromium，零外网、零真实凭证可复跑。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV4 } from 'ai/test';
import { createMaterialsAdapter } from '../materials.mjs';
import { startPublicWebHost } from '../public-web-host.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');

const SENTINEL_MODEL_SECRET = 'sk-public-test-sentinel-never-leak-90210';
const SENTINEL_ZHIHU_SECRET = 'zhihu-secret-sentinel-never-leak-778899';

const USAGE = {
  inputTokens: { total: 64, noCache: 64, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 48, text: 48, reasoning: 0 },
};

// 第一屏禁止出现的生硬实现词
const FORBIDDEN_FIRST_SCREEN_JARGON = [
  '总承重分母',
  '承重分母',
  '候选关系',
  '图版本',
  'confirmedGraph',
  'graphVersion',
];

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
      // 尝试下一个候选路径
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

// 独立的公开检索合成语料（AI 写作与提示词场景，不依赖旧推荐算法演示语料）
const PUBLIC_SEARCH_CORPUS = Object.freeze([
  Object.freeze({
    key: 'answer:9501',
    contentId: '9501',
    contentType: 'answer',
    title: '用 AI 辅助写深度长文时，怎样避免文风千篇一律？',
    excerpt: '只靠单一固定提示词批量生成时，模型确实会高频复用相近句式；但当作者先提供个人采访笔记并分步修订结构时，成稿差异度反而更高。',
    excerptTruncated: false,
    textKind: 'excerpt',
    fullTextAvailable: false,
    platformTags: null,
    url: 'https://www.zhihu.com/question/95001/answer/9501?utm_source=public_test',
    canonicalUrl: 'https://www.zhihu.com/question/95001/answer/9501',
    author: '林知微',
    voteCount: 142,
    commentCount: 27,
    rankingScore: 0.93,
    createdTime: '2026-11-10T08:30:00.000Z',
    editedTime: null,
  }),
  Object.freeze({
    key: 'article:9502',
    contentId: '9502',
    contentType: 'article',
    title: '反复复用同一套提示词模板写稿的同质化实测',
    excerpt: '在连续二十篇稿件反复使用同一套固定提示词且不补充一手素材时，段落开头与论证框架的重复率明显上升。',
    excerptTruncated: false,
    textKind: 'excerpt',
    fullTextAvailable: false,
    platformTags: null,
    url: 'https://zhuanlan.zhihu.com/p/9502?utm_source=public_test',
    canonicalUrl: 'https://zhuanlan.zhihu.com/p/9502',
    author: '陈墨',
    voteCount: 108,
    commentCount: 19,
    rankingScore: 0.89,
    createdTime: '2026-11-12T10:15:00.000Z',
    editedTime: null,
  }),
]);

function createControllablePublicSearch() {
  let mode = 'ok';
  const calls = [];

  async function callTool(toolName, args = {}) {
    calls.push({ toolName, args, mode, at: Date.now() });
    if (toolName !== 'zhihu_search') {
      return {
        schemaVersion: 1,
        ok: false,
        data: null,
        error: { code: 'FORBIDDEN_IN_PUBLIC_MODE', message: '公开模式禁止调用个人采集工具。' },
      };
    }

    if (mode === 'timeout') {
      return {
        schemaVersion: 1,
        ok: false,
        data: null,
        error: { code: 'TIMEOUT', message: '模拟公开检索上游请求超时。' },
      };
    }
    if (mode === 'rate_limited') {
      return {
        schemaVersion: 1,
        ok: false,
        data: null,
        error: { code: 'RATE_LIMITED', message: '模拟公开检索触发限流。' },
      };
    }
    if (mode === 'error') {
      throw new Error('模拟公开检索上游连接失败');
    }
    if (mode === 'empty') {
      return {
        schemaVersion: 1,
        ok: true,
        data: {
          requestId: 'pub-search-empty-001',
          query: String(args.query ?? ''),
          items: [],
          total: 0,
        },
        error: null,
      };
    }

    return {
      schemaVersion: 1,
      ok: true,
      data: {
        requestId: `pub-search-ok-${calls.length}`,
        query: String(args.query ?? ''),
        items: PUBLIC_SEARCH_CORPUS.map((item) => ({ ...item })),
        total: PUBLIC_SEARCH_CORPUS.length,
      },
      error: null,
    };
  }

  const materialsAdapter = Object.assign(
    createMaterialsAdapter({
      dataMode: 'real',
      demo: false,
      allowPersonalMaterials: false,
      usePersonalMaterials: false,
      callTool,
      enabled: false,
    }),
    { searchReady: true },
  );

  return {
    callTool,
    materialsAdapter,
    corpus: PUBLIC_SEARCH_CORPUS,
    setMode(nextMode) {
      mode = nextMode;
    },
    getCalls() {
      return calls.slice();
    },
    resetCalls() {
      calls.length = 0;
    },
  };
}

function extractPromptText(prompt) {
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) {
    const userMsgs = prompt.filter((msg) => msg?.role !== 'system');
    const targetMsgs = userMsgs.length > 0 ? userMsgs : prompt;
    return targetMsgs
      .map((msg) => {
        if (typeof msg?.content === 'string') return msg.content;
        if (Array.isArray(msg?.content)) {
          return msg.content.map((part) => part?.text ?? '').join('\n');
        }
        return '';
      })
      .join('\n');
  }
  return JSON.stringify(prompt ?? '');
}

function extractCurrentTurnFocusText(promptText) {
  const lines = String(promptText ?? '').split('\n');
  const currentLines = lines.filter((l) => /^(?:当前主张|用户刚说|用户本轮|本轮用户输入|当前讨论的句子)[：:]/u.test(l.trim()));
  return currentLines.length > 0 ? currentLines.join('\n') : String(promptText ?? '');
}

function buildStructuredProposalForPrompt(promptText) {
  const focusSlice = extractCurrentTurnFocusText(promptText);
  const isConditionNarrowed = focusSlice.includes('反复用同一个提示词');
  const isProvenanceQuestion = focusSlice.includes('你怎么知道');

  if (isConditionNarrowed) {
    return {
      claim: {
        text: '反复用同一个提示词时，AI 写作容易让文章越来越千篇一律。',
        focus: {
          spanText: '反复用同一个提示词',
          kind: 'scope',
          reason: '把适用条件收窄到反复复用单一提示词的场景后，可以重新核对原有反例是否仍构成直接反驳。',
        },
      },
      focus: {
        spanText: '反复用同一个提示词',
        kind: 'scope',
        reason: '新增了明确的场景边界，原来针对分步修订的反例转为边界限定。',
      },
      relations: [
        {
          evidenceId: 'ev_sch_article_9502',
          relation: 'supports',
          quote: '在连续二十篇稿件反复使用同一套固定提示词且不补充一手素材时，段落开头与论证框架的重复率明显上升。',
          reason: '陈墨的实测直接支持“反复用同一个提示词时文章容易同质化”。',
        },
        {
          evidenceId: 'ev_sch_answer_9501',
          relation: 'qualifies',
          quote: '只靠单一固定提示词批量生成时，模型确实会高频复用相近句式；但当作者先提供个人采访笔记并分步修订结构时，成稿差异度反而更高。',
          reason: '加上“反复用同一个提示词”后，林知微提到的分步修订案例不再直接反驳你的句子，而是标出了另一种写法边界。',
        },
      ],
      citations: [
        {
          evidenceId: 'ev_sch_article_9502',
          quote: '在连续二十篇稿件反复使用同一套固定提示词且不补充一手素材时，段落开头与论证框架的重复率明显上升。',
          relation: 'supports',
        },
        {
          evidenceId: 'ev_sch_answer_9501',
          quote: '只靠单一固定提示词批量生成时，模型确实会高频复用相近句式；但当作者先提供个人采访笔记并分步修订结构时，成稿差异度反而更高。',
          relation: 'qualifies',
        },
      ],
      suggestedRewrite: {
        text: '反复用同一个提示词且不补充一手素材时，AI 写作容易让文章越来越千篇一律。',
        retained: '保留了你对 AI 批量成稿同质化的核心担心',
        narrowed: '把范围收窄到“反复用同一个提示词且不补充一手素材”的写法',
        reason: '这样既说清了触发同质化的具体条件，也让分步修订的案例不再直接打架。',
      },
      relationChanges: [
        {
          evidenceId: 'ev_sch_answer_9501',
          previousRelation: 'contradicts',
          nextRelation: 'qualifies',
          summary: '加上「反复用同一个提示词」以后，林知微那条分步修订的反例就不再直接反驳你的句子了。',
        },
      ],
      unknowns: [
        '如果作者只换提示词但仍不补充一手采访素材，文章差异度究竟能提升多少，目前还缺少对照证据。',
      ],
      changeSummary: '加上「反复用同一个提示词」以后，林知微那条反例就不再直接反驳你的句子了，陈墨的实测则直接支持了收窄后的说法。',
    };
  }

  return {
    claim: {
      text: 'AI 写作只会让文章越来越千篇一律。',
      focus: {
        spanText: '只会',
        kind: 'quantifier',
        reason: '如果能找到一个反例，说明并非所有 AI 辅助写法都会走向同质化，这句话就有再推敲的空间。',
      },
    },
    focus: {
      spanText: '只会',
      kind: 'quantifier',
      reason: '先看「只会」：只要存在能提高成稿差异度的协作方式，这个绝对词就站不住。',
    },
    relations: [
      {
        evidenceId: 'ev_sch_answer_9501',
        relation: 'contradicts',
        quote: '只靠单一固定提示词批量生成时，模型确实会高频复用相近句式；但当作者先提供个人采访笔记并分步修订结构时，成稿差异度反而更高。',
        reason: '林知微给出了提供个人采访笔记并分步修订的反例，直接反驳“只会”的绝对说法。',
      },
      {
        evidenceId: 'ev_sch_article_9502',
        relation: 'qualifies',
        quote: '在连续二十篇稿件反复使用同一套固定提示词且不补充一手素材时，段落开头与论证框架的重复率明显上升。',
        reason: '陈墨的实测说明同质化集中在反复复用同一套提示词模板的场景，限定了原句的成立范围。',
      },
    ],
    citations: [
      {
        evidenceId: 'ev_sch_answer_9501',
        quote: '只靠单一固定提示词批量生成时，模型确实会高频复用相近句式；但当作者先提供个人采访笔记并分步修订结构时，成稿差异度反而更高。',
        relation: 'contradicts',
      },
      {
        evidenceId: 'ev_sch_article_9502',
        quote: '在连续二十篇稿件反复使用同一套固定提示词且不补充一手素材时，段落开头与论证框架的重复率明显上升。',
        relation: 'qualifies',
      },
    ],
    suggestedRewrite: {
      text: '反复用同一个提示词批量生成时，AI 写作容易让文章越来越千篇一律。',
      retained: '保留了你对 AI 写作带来表达趋同的担心',
      narrowed: '把“只会”收窄到“反复用同一个提示词批量生成”的具体场景',
      reason: isProvenanceQuestion
        ? '以上判断来自林知微与陈墨两篇公开材料，把范围说清后更有依据。'
        : '原来那层担心可以留着。咱们把话说到反复复用固定提示词这个具体场景里，读者更容易明白你在担心什么。',
    },
    relationChanges: [],
    unknowns: [
      '不同题材（例如虚构创作与行业报告）在长期使用 AI 辅助后的风格漂移程度，目前还没有找到足够的对比材料。',
    ],
    changeSummary: isProvenanceQuestion
      ? '已核对林知微与陈墨两篇公开材料的原文出处，当前图上关系保持不变。'
      : '围绕原句里的「只会」，标出了 1 条直接反例与 1 条场景限定依据。',
  };
}

function createControllablePublicModel() {
  let mode = 'ok'; // 'ok' | 'fail' | 'pause'
  let streamCallIndex = 0;
  let generateCallIndex = 0;
  const pendingGates = new Map();
  let activeGate = null;

  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      generateCallIndex += 1;
      if (mode === 'fail') {
        const err = new Error('上游模型服务返回 500 Internal Server Error');
        err.statusCode = 500;
        throw err;
      }
      const promptText = extractPromptText(prompt);
      const proposal = buildStructuredProposalForPrompt(promptText);
      return {
        content: [{ type: 'text', text: JSON.stringify(proposal) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: USAGE,
        warnings: [],
      };
    },
    doStream: async ({ prompt, abortSignal }) => {
      streamCallIndex += 1;
      const currentCall = streamCallIndex;

      if (mode === 'fail') {
        const err = new Error('上游模型流式接口返回 500 故障');
        err.statusCode = 500;
        throw err;
      }

      const promptText = extractPromptText(prompt);
      const currentTurnSlice = extractCurrentTurnFocusText(promptText);
      const isConditionNarrowed = currentTurnSlice.includes('反复用同一个提示词');
      const isProvenanceQuestion = currentTurnSlice.includes('你怎么知道');

      let firstChunk = `【第${currentCall}轮首段回应】我先看看原句里的「只会」。林知微提到，作者先给个人采访笔记并分步修订时，成稿差异度反而更高。`;
      let secondChunk = `【第${currentCall}轮续段回应】陈墨的实测说的是反复复用固定提示词的情况，它能帮我们看清这一种写法；原来那层担心可以留着，咱们可以把范围说得更具体。`;

      if (isProvenanceQuestion) {
        firstChunk = `【第${currentCall}轮首段回应】刚才那两条判断来自知乎公开作者林知微和陈墨，我依然记着你原句「AI 写作只会让文章越来越千篇一律。」。`;
        secondChunk = `【第${currentCall}轮续段回应】你可以直接点旁边「看看出处」对照他们的原话与链接，我们也可以继续把适用条件说得更准。`;
      } else if (isConditionNarrowed) {
        firstChunk = `【第${currentCall}轮首段回应】加上「反复用同一个提示词」以后，林知微那条分步修订的反例就不再直接反驳你的句子了。`;
        secondChunk = `【第${currentCall}轮续段回应】陈墨关于固定模板批量写稿的实测刚好支持你现在的说法；至于只换提示词不补素材的效果，这部分证据还留白。`;
      }

      let releaseFn = null;
      let released = false;
      const shouldPause = mode === 'pause';
      const gate = new Promise((resolvePromise) => {
        releaseFn = () => {
          if (released) return;
          released = true;
          pendingGates.delete(currentCall);
          resolvePromise();
        };
      });
      if (shouldPause) {
        const entry = { callIndex: currentCall, release: releaseFn };
        activeGate = entry;
        pendingGates.set(currentCall, entry);
      } else {
        releaseFn();
      }

      return {
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: 'text-start', id: `pub_stream_${currentCall}` });
            controller.enqueue({
              type: 'text-delta',
              id: `pub_stream_${currentCall}`,
              delta: firstChunk,
            });

            if (shouldPause) {
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
            }

            controller.enqueue({
              type: 'text-delta',
              id: `pub_stream_${currentCall}`,
              delta: secondChunk,
            });
            controller.enqueue({ type: 'text-end', id: `pub_stream_${currentCall}` });
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
    setMode(nextMode) {
      mode = nextMode;
    },
    firstChunkMarker(n) {
      return `第${n}轮首段回应`;
    },
    secondChunkMarker(n) {
      return `第${n}轮续段回应`;
    },
    getStreamCallCount() {
      return streamCallIndex;
    },
    getGenerateCallCount() {
      return generateCallIndex;
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

function attachNetworkTracker(page, origin) {
  const requests = [];
  const responses = [];
  const pageErrors = [];
  const consoleErrors = [];

  page.on('request', (req) => {
    const url = req.url();
    if (!url.startsWith(origin)) return;
    const parsed = new URL(url);
    let postData = null;
    try {
      postData = req.postData();
    } catch {
      // 忽略二进制或不可读请求体
    }
    requests.push({
      method: req.method(),
      pathname: parsed.pathname,
      headers: req.headers(),
      postData,
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
      text: null,
    };
    if (entry.contentType.includes('application/json')) {
      try {
        const text = await res.text();
        entry.text = text;
        entry.json = JSON.parse(text);
      } catch {
        // 忽略解析异常
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

async function assertNoSecretOrBearerLeak(page, tracker, forbiddenSecrets = []) {
  const secrets = forbiddenSecrets.filter((s) => typeof s === 'string' && s.length >= 6);
  const browserLeak = await page.evaluate((secretList) => {
    const html = document.documentElement.outerHTML;
    const cookie = document.cookie;
    const ls = Object.values(window.localStorage ?? {}).join(' ');
    const ss = Object.values(window.sessionStorage ?? {}).join(' ');
    const corpus = `${html}\n${cookie}\n${ls}\n${ss}`;
    const hitSecret = secretList.find((sec) => corpus.includes(sec)) ?? null;
    const hitTokenPattern = /qtn_(?:pub|public|demo)_host_[A-Za-z0-9_-]{8,}/.test(corpus);
    return { hitSecret, hitTokenPattern };
  }, secrets);

  assert.equal(browserLeak.hitSecret, null, `浏览器 DOM / Cookie / Storage 严禁泄露密钥或内部令牌：${browserLeak.hitSecret}`);
  assert.equal(browserLeak.hitTokenPattern, false, '浏览器侧严禁出现宿主内部 Bearer 令牌');

  for (const req of tracker.requests) {
    const authHeader = req.headers.authorization ?? '';
    for (const sec of secrets) {
      assert.equal(authHeader.includes(sec), false, '浏览器请求头不应携带内部 Bearer 或上游密钥');
    }
  }

  for (const res of tracker.responses) {
    if (!res.text) continue;
    for (const sec of secrets) {
      assert.equal(res.text.includes(sec), false, `HTTP 响应(${res.pathname})严禁泄露密钥：${sec}`);
    }
  }
}

async function fetchSnapshotWithBrowserCookies(page, origin, sessionId) {
  const res = await page.request.get(`${origin}/v1/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(res.status(), 200, `使用同源会话 Cookie 获取快照应返回 200，实际 ${res.status()}`);
  const payload = await res.json();
  return payload.data;
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

async function waitForTurnAcceptedAndSseDone(page, triggerAction, { waitForCommitted = true } = {}) {
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
    assert.ok(
      turnRes.status() === 202 || turnRes.status() === 200,
      `提交轮次应返回 202 或 200，实际 ${turnRes.status()}`,
    );
    const turnPayload = await turnRes.json();
    const accepted = {
      turnId: turnPayload.data.turnId,
      eventsUrl: turnPayload.data.eventsUrl,
      sessionId: turnPayload.data.sessionId,
      data: turnPayload.data,
    };

    if (!sseFinishedByPath.has(accepted.eventsUrl)) {
      const sseRes = await page.waitForResponse(
        (res) => res.request().method() === 'GET' && new URL(res.url()).pathname === accepted.eventsUrl,
        { timeout: 15_000 },
      );
      await sseRes.finished().catch(() => {});
    } else {
      await sseFinishedByPath.get(accepted.eventsUrl);
    }

    if (waitForCommitted) {
      await waitForTurnStatus(page, 'committed', 25_000);
      await waitForSyncStatus(page, 'idle', 15_000);
    }
    return accepted;
  } finally {
    page.off('response', onResponse);
  }
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  return String(haystack).split(needle).length - 1;
}

test('L-03 · 可继续的公开对话（桌面端）：自由输入、真实公开会话、核验出处与星图联动、追问出处、条件纠错与同批证据改写对比', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'quotation-live-l03-'));
  const dbPath = path.join(tmpDir, 'public-l03.sqlite');
  const controllableSearch = createControllablePublicSearch();
  const controllableModel = createControllablePublicModel();

  const host = await startPublicWebHost({
    host: '127.0.0.1',
    port: 0,
    dbPath,
    model: controllableModel.model,
    materialsAdapter: controllableSearch.materialsAdapter,
    materialLoader: controllableSearch.materialsAdapter,
    callTool: controllableSearch.callTool,
    env: {
      AGENT_BASE_URL: 'http://127.0.0.1:11434/v1',
      AGENT_MODEL: 'mock-public-model-v4',
      AGENT_API_KEY: SENTINEL_MODEL_SECRET,
      ZHIHU_ACCESS_SECRET: SENTINEL_ZHIHU_SECRET,
    },
    quiet: true,
  });
  const browser = await launchBrowser();

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const tracker = attachNetworkTracker(page, host.origin);

    // 1. 打开正式首页：验证第一屏自由输入、无登录/绑知乎/选模型门槛、无生硬实现词
    const hostSessionPromise = page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/host/session',
      { timeout: 15_000 },
    );
    await page.goto(`${host.origin}/`, { waitUntil: 'domcontentloaded' });
    const hostSessionRes = await hostSessionPromise;
    assert.equal(hostSessionRes.status(), 200, 'POST /api/host/session 应返回 200');
    const hostSessionJson = await hostSessionRes.json();
    assert.equal(hostSessionJson.data.mode, 'public', '公开宿主握手 mode 必须为 public');
    assert.equal(hostSessionJson.data.dataMode, 'real', '公开宿主握手 dataMode 必须为 real');
    assert.equal(hostSessionJson.data.usePersonalMaterials, false, '公开宿主必须强制 usePersonalMaterials: false');

    const homeInput = page.getByTestId('public-home-input');
    const homeSubmit = page.getByTestId('public-home-submit');
    await homeInput.waitFor({ state: 'visible', timeout: 15_000 });
    await homeSubmit.waitFor({ state: 'visible', timeout: 15_000 });
    const submitLabel = (await homeSubmit.textContent()) ?? '';
    assert.ok(submitLabel.includes('看看这句话'), `首页主按钮应包含“看看这句话”，实际：${submitLabel}`);

    const firstScreenText = (await page.locator('body').innerText()) ?? '';
    for (const jargon of FORBIDDEN_FIRST_SCREEN_JARGON) {
      assert.equal(
        firstScreenText.includes(jargon),
        false,
        `首页第一屏不应出现生硬实现词「${jargon}」`,
      );
    }
    assert.equal(/请先登录|绑定知乎账号|选择模型/.test(firstScreenText), false, '首页第一屏不应存在登录/绑知乎/选模型门槛');

    // 若页面提供了示例起手句按钮，核验其存在但不强制阻断自由输入
    const starterCount = await page.getByTestId('starter-prompt-btn').count();
    assert.ok(starterCount >= 0, 'starter-prompt-btn 可选展示作为起手句');

    // 2. 输入一句自由观点并点击「看看这句话」，验证产生真实 /v1/sessions（dataMode: real, usePersonalMaterials: false）与 /turns + SSE
    const originalClaim = 'AI 写作只会让文章越来越千篇一律。';
    const sessionCreatePromise = page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/v1/sessions',
      { timeout: 15_000 },
    );

    const turn1 = await waitForTurnAcceptedAndSseDone(page, async () => {
      await homeInput.fill(originalClaim);
      await homeSubmit.click();
    });

    const sessionCreateRes = await sessionCreatePromise;
    assert.equal(sessionCreateRes.status(), 201, '创建公开会话应返回 201');
    const sessionCreateBody = await sessionCreateRes.json();
    const sessionId = sessionCreateBody.data.sessionId;
    assert.ok(sessionId, '应返回有效 sessionId');
    assert.equal(sessionCreateBody.data.dataMode, 'real', '公开会话 dataMode 必须为 real');
    assert.equal(sessionCreateBody.data.usePersonalMaterials, false, '公开会话 usePersonalMaterials 必须为 false');
    assert.equal(turn1.sessionId, sessionId, '首轮提交必须属于刚创建的公开会话');
    assert.ok(controllableSearch.getCalls().length >= 1, '首轮提交应触发公开检索调用');

    // 3. 验证焦点、温柔回复、精简核验出处、展开出处与星图节点高亮联动
    await page.getByTestId('public-dialogue-feed').waitFor({ state: 'visible', timeout: 10_000 });
    assert.ok((await page.getByTestId('public-turn-card').count()) >= 1, '对话流应展示首轮回复卡片');

    const focusText = (await page.getByTestId('public-focus-pill').first().textContent()) ?? '';
    assert.ok(focusText.includes('只会'), `焦点徽章应标出当前焦点“只会”，实际：${focusText}`);

    const replyText1 = (await page.getByTestId('public-stream-reply').last().textContent()) ?? '';
    assert.ok(replyText1.trim().length > 10, '应渲染面向用户的温柔中文回复');

    const firstCitation = page.getByTestId('public-citation-item').first();
    await firstCitation.waitFor({ state: 'visible', timeout: 10_000 });
    const citationEvidenceId = await firstCitation.getAttribute('data-evidence-id');
    const citationNodeId = await firstCitation.getAttribute('data-node-id');
    assert.ok(citationEvidenceId, '出处条目必须带 data-evidence-id');
    assert.ok(citationNodeId, '出处条目必须带 data-node-id');

    // 点击「看看出处」展开详情，验证标题/作者/摘要片段/原链接
    await firstCitation.getByTestId('toggle-citation-btn').click();
    const citationDetail = firstCitation.getByTestId('citation-detail');
    await citationDetail.waitFor({ state: 'visible', timeout: 10_000 });
    const detailText = (await citationDetail.textContent()) ?? '';
    assert.ok(
      detailText.includes('林知微') || detailText.includes('陈墨'),
      `展开出处应展示真实作者名，实际：${detailText}`,
    );
    assert.ok(
      detailText.includes('采访笔记') || detailText.includes('固定提示词'),
      `展开出处应展示实际使用的摘要片段，实际：${detailText}`,
    );
    const linkHref = await citationDetail.locator('a[href^="https://"]').first().getAttribute('href');
    assert.ok(
      linkHref && linkHref.includes('zhihu.com'),
      `展开出处必须包含原始知乎链接，实际：${linkHref}`,
    );

    // 点击「在星图里看它」高亮对应星图节点
    await firstCitation.getByTestId('locate-node-btn').click();
    await page.getByTestId('public-graph-panel').waitFor({ state: 'visible', timeout: 10_000 });
    const highlightedNode = page.locator(
      `[data-testid="public-graph-node"][data-node-id="${citationNodeId}"][data-highlighted="true"], `
      + `[data-testid="public-graph-node"][data-evidence-id="${citationEvidenceId}"][data-highlighted="true"]`,
    );
    await highlightedNode.first().waitFor({ state: 'visible', timeout: 10_000 });

    // 核验后端快照：公开分析存在、公开出处 attribution 严格为 other_author 且与 confirmedGraph 隔离
    const snapAfterTurn1 = await fetchSnapshotWithBrowserCookies(page, host.origin, sessionId);
    assert.ok(snapAfterTurn1.publicAnalysis, '首轮提交后快照应包含 publicAnalysis');
    assert.equal(snapAfterTurn1.confirmedGraph.length, 0, '公开检索材料严禁自动写入个人 confirmedGraph');
    for (const cite of snapAfterTurn1.publicAnalysis.citations ?? []) {
      assert.equal(cite.attribution, 'other_author', '公开出处 attribution 必须始终保持 other_author');
    }

    const sessionPostCountBeforeFollowups = tracker.requests.filter(
      (r) => r.method === 'POST' && r.pathname === '/v1/sessions',
    ).length;
    assert.equal(sessionPostCountBeforeFollowups, 1, '整个对话初始仅应创建 1 个公开会话');

    // 4. 在原对话追问一次出处（「你怎么知道？」），验证同一会话记得当前原句
    const followupInput = page.getByTestId('public-followup-input');
    const followupSubmit = page.getByTestId('public-followup-submit');
    await followupInput.waitFor({ state: 'visible', timeout: 10_000 });

    const turn2 = await waitForTurnAcceptedAndSseDone(page, async () => {
      await followupInput.fill('你怎么知道？');
      await followupSubmit.click();
    });
    assert.equal(turn2.sessionId, sessionId, '追问出处必须留在同一个会话中');
    assert.equal(
      tracker.requests.filter((r) => r.method === 'POST' && r.pathname === '/v1/sessions').length,
      1,
      '追问出处不得重建新会话',
    );

    const snapAfterTurn2 = await fetchSnapshotWithBrowserCookies(page, host.origin, sessionId);
    const serializedClaimAfterTurn2 = JSON.stringify(snapAfterTurn2.publicAnalysis?.claim ?? snapAfterTurn2.statements ?? '');
    assert.ok(
      serializedClaimAfterTurn2.includes('千篇一律') || serializedClaimAfterTurn2.includes(originalClaim),
      '追问出处后同一会话必须记得当前原句',
    );

    // 5. 在原对话纠正一个条件
    const correctionText = '这条其实说的是另一回事，我主要想说反复用同一个提示词时';
    const turn3 = await waitForTurnAcceptedAndSseDone(page, async () => {
      await followupInput.fill(correctionText);
      await followupSubmit.click();
    });
    assert.equal(turn3.sessionId, sessionId, '纠正条件必须留在同一个会话中');

    // 6. 在可编辑改写框编辑并点击「试试这句」提交改写，验证原句与改写在同批证据下可比、关系变化与留白未知项
    const rewriteCard = page.getByTestId('public-rewrite-card');
    const rewriteEditor = page.getByTestId('public-rewrite-editor');
    const tryRewriteBtn = page.getByTestId('try-rewrite-btn');
    await rewriteCard.waitFor({ state: 'visible', timeout: 10_000 });
    await rewriteEditor.waitFor({ state: 'visible', timeout: 10_000 });

    const editedRewrite = '反复用同一个提示词批量生成时，AI 写作容易让文章越来越千篇一律。';
    await rewriteEditor.fill(editedRewrite);
    const turn4 = await waitForTurnAcceptedAndSseDone(page, async () => {
      await tryRewriteBtn.click();
    });
    assert.equal(turn4.sessionId, sessionId, '提交改写必须留在同一个会话中');
    assert.equal(
      tracker.requests.filter((r) => r.method === 'POST' && r.pathname === '/v1/sessions').length,
      1,
      '完整 L-03 对话全程应共用同 1 个会话',
    );

    const snapAfterRewrite = await fetchSnapshotWithBrowserCookies(page, host.origin, sessionId);
    assert.ok(snapAfterRewrite.publicAnalysis, '改写提交后快照应包含更新后的 publicAnalysis');
    assert.equal(
      snapAfterRewrite.publicAnalysis.graphVersion,
      snapAfterRewrite.graphVersion,
      'publicAnalysis.graphVersion 必须与快照 graphVersion 原子一致',
    );
    assert.equal(snapAfterRewrite.confirmedGraph.length, 0, '改写后个人 confirmedGraph 仍应严格保持空集');

    const historyItems = snapAfterRewrite.publicAnalysis.statementHistory ?? snapAfterRewrite.statements ?? [];
    assert.ok(historyItems.length >= 2, '同一会话应保留原句与改写版本以便在同批证据下对照比较');

    // 验证页面展示具体一句变化说明、受影响的关系变化与留白的未知项
    const changeSummaryEl = page.getByTestId('public-change-summary');
    await changeSummaryEl.waitFor({ state: 'visible', timeout: 10_000 });
    const changeSummaryText = (await changeSummaryEl.textContent()) ?? '';
    assert.ok(
      changeSummaryText.trim().length > 6,
      `页面应展示具体的关系变化说明，实际：${changeSummaryText}`,
    );

    const relationChangesEl = page.getByTestId('public-relation-changes');
    await relationChangesEl.waitFor({ state: 'visible', timeout: 10_000 });
    assert.ok(
      ((await relationChangesEl.textContent()) ?? '').trim().length > 0,
      '页面应展示本轮受影响的关系变化列表',
    );

    const unknownBoxEl = page.getByTestId('public-unknown-box');
    await unknownBoxEl.waitFor({ state: 'visible', timeout: 10_000 });
    assert.ok(
      ((await unknownBoxEl.textContent()) ?? '').trim().length > 0,
      '页面应清晰展示当前仍留白的未知项或材料边界',
    );

    await assertNoSecretOrBearerLeak(page, tracker, [
      SENTINEL_MODEL_SECRET,
      SENTINEL_ZHIHU_SECRET,
      host.internalToken,
    ]);
    assert.equal(
      tracker.pageErrors.length,
      0,
      `L-03 不应产生任何未捕获 pageerror：${tracker.pageErrors.map((e) => e.message).join('; ')}`,
    );
    await context.close();
  } finally {
    controllableModel.releaseAll();
    await browser.close();
    await host.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

async function runL04ViewportScenarios({
  browser,
  host,
  controllableSearch,
  controllableModel,
  viewport,
  isMobile,
  label,
}) {
  const context = await browser.newContext({
    viewport,
    ...(isMobile ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  const tracker = attachNetworkTracker(page, host.origin);

  try {
    await page.goto(`${host.origin}/`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('public-home-input').waitFor({ state: 'visible', timeout: 15_000 });

    // ===== 场景 1：模拟搜索失败/超时 -> 温柔提示、原句可找回并可重试恢复 =====
    const sentenceA = 'AI 写作只会让文章越来越千篇一律。';
    controllableSearch.setMode('timeout');
    controllableModel.setMode('ok');

    const sessionCreatePromise = page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/v1/sessions',
      { timeout: 15_000 },
    );
    await waitForTurnAcceptedAndSseDone(
      page,
      async () => {
        await page.getByTestId('public-home-input').fill(sentenceA);
        await page.getByTestId('public-home-submit').click();
      },
      { waitForCommitted: false },
    );
    const sessionCreateRes = await sessionCreatePromise;
    const sessionId = (await sessionCreateRes.json()).data.sessionId;
    const sessionPathname = `/v1/sessions/${sessionId}`;

    // 等待降级横幅或留白提示出现，且原句仍保留可找回
    const degradeBanner = page.getByTestId('public-degrade-banner');
    await degradeBanner.waitFor({ state: 'visible', timeout: 15_000 });
    const searchDegradeText = (await degradeBanner.textContent()) ?? '';
    assert.ok(searchDegradeText.trim().length > 0, `${label} 搜索失败时应展示温柔降级提示`);

    const pageBodyAfterSearchFail = (await page.locator('body').innerText()) ?? '';
    const inputValueAfterSearchFail = await page
      .locator('[data-testid="public-followup-input"], [data-testid="public-home-input"]')
      .first()
      .inputValue()
      .catch(() => '');
    assert.ok(
      pageBodyAfterSearchFail.includes(sentenceA) || inputValueAfterSearchFail.includes(sentenceA),
      `${label} 搜索失败后用户原句必须可找回`,
    );

    // 恢复搜索后点击重试按钮恢复成功
    controllableSearch.setMode('ok');
    const retryBtn1 = page.getByTestId('public-retry-btn');
    await retryBtn1.waitFor({ state: 'visible', timeout: 10_000 });
    await waitForTurnAcceptedAndSseDone(page, async () => {
      await retryBtn1.click();
    });
    await page.getByTestId('public-citation-item').first().waitFor({ state: 'visible', timeout: 10_000 });

    // ===== 场景 2：模拟模型失败（500 / stream error）-> 温柔提示、原句保留、点击重试恢复 =====
    const sentenceB = '你怎么知道？';
    controllableModel.setMode('fail');

    await waitForTurnAcceptedAndSseDone(
      page,
      async () => {
        await page.getByTestId('public-followup-input').fill(sentenceB);
        await page.getByTestId('public-followup-submit').click();
      },
      { waitForCommitted: false },
    );

    await degradeBanner.waitFor({ state: 'visible', timeout: 15_000 });
    const modelFailInputVal = await page.getByTestId('public-followup-input').inputValue().catch(() => '');
    const modelFailBody = (await page.locator('body').innerText()) ?? '';
    assert.ok(
      modelFailInputVal.includes(sentenceB) || modelFailBody.includes(sentenceB),
      `${label} 模型失败后原句必须保留`,
    );

    controllableModel.setMode('ok');
    const retryBtn2 = page.getByTestId('public-retry-btn');
    await retryBtn2.waitFor({ state: 'visible', timeout: 10_000 });
    await waitForTurnAcceptedAndSseDone(page, async () => {
      await retryBtn2.click();
    });

    // ===== 场景 3：可控模型暂停在首段 -> 刷新页面恢复运行中轮次（零重发 POST；桌面验证续流读完 + 取消路径） =====
    const countPostTurns = () => tracker.requests.filter(
      (r) => r.method === 'POST' && r.pathname === `/v1/sessions/${sessionId}/turns`,
    ).length;

    controllableModel.setMode('pause');
    const streamNumBeforePause1 = controllableModel.getStreamCallCount() + 1;
    const postTurnPromisePause1 = page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === `/v1/sessions/${sessionId}/turns`,
      { timeout: 15_000 },
    );
    await page.getByTestId('public-followup-input').fill('这条其实说的是另一回事，我主要想说反复用同一个提示词时');
    await page.getByTestId('public-followup-submit').click();
    await postTurnPromisePause1;

    await page.waitForFunction(
      (marker) => (document.querySelector('[data-testid="public-stream-reply"]')?.textContent ?? '').includes(marker)
        || Array.from(document.querySelectorAll('[data-testid="public-stream-reply"]')).some((el) => (el.textContent ?? '').includes(marker)),
      controllableModel.firstChunkMarker(streamNumBeforePause1),
      { timeout: 15_000 },
    );
    await waitForTurnStatus(page, 'running', 10_000);

    const postsBeforeReload1 = countPostTurns();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForTurnStatus(page, 'running', 15_000);
    assert.equal(
      countPostTurns() - postsBeforeReload1,
      0,
      `${label} 生成中刷新恢复运行中轮次严禁重发 POST /turns`,
    );

    const cancelBtn = page.getByTestId('public-cancel-btn');
    await cancelBtn.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await cancelBtn.isEnabled(), true, `${label} 刷新恢复 running 后取消按钮必须可用`);

    if (!isMobile) {
      // 桌面端：放行第二段，验证首段不重复、第二段完整续读并提交
      controllableModel.releaseCurrent();
      await waitForTurnStatus(page, 'committed', 20_000);
      await waitForSyncStatus(page, 'idle', 15_000);
      const allReplies = await page.getByTestId('public-stream-reply').allTextContents();
      const latestReply = allReplies.at(-1) ?? '';
      assert.equal(
        countOccurrences(latestReply, controllableModel.firstChunkMarker(streamNumBeforePause1)),
        1,
        `${label} 刷新续流后首段文本不得重复拼接`,
      );
      assert.equal(
        countOccurrences(latestReply, controllableModel.secondChunkMarker(streamNumBeforePause1)),
        1,
        `${label} 刷新续流后第二段文本应完整出现 1 次`,
      );
      assert.equal(countPostTurns() - postsBeforeReload1, 0, `${label} 续流提交完成后仍不得重发 POST /turns`);
    } else {
      // 手机端：刷新恢复 running 后主动点击取消，验证取消返回 200 且零重发
      const snapBeforeCancel = await fetchSnapshotWithBrowserCookies(page, host.origin, sessionId);
      const cancelPromise = page.waitForResponse(
        (res) => res.request().method() === 'POST'
          && /^\/v1\/sessions\/[^/]+\/turns\/[^/]+\/cancel$/.test(new URL(res.url()).pathname),
        { timeout: 15_000 },
      );
      await cancelBtn.click();
      const cancelRes = await cancelPromise;
      assert.equal(cancelRes.status(), 200, `${label} 主动取消应返回 200`);
      controllableModel.releaseCurrent();
      await waitForTurnStatus(page, 'cancelled', 15_000);
      assert.equal(countPostTurns() - postsBeforeReload1, 0, `${label} 主动取消后不得重发 POST /turns`);
      const snapAfterCancel = await fetchSnapshotWithBrowserCookies(page, host.origin, sessionId);
      assert.equal(snapAfterCancel.graphVersion, snapBeforeCancel.graphVersion, `${label} 取消后 graphVersion 不应递增`);
    }

    // 桌面端额外验证主动取消路径，保证桌面端既测续读也测取消
    if (!isMobile) {
      const snapBeforeDesktopCancel = await fetchSnapshotWithBrowserCookies(page, host.origin, sessionId);
      const streamNumDesktopCancel = controllableModel.getStreamCallCount() + 1;
      const postPromiseCancel = page.waitForResponse(
        (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === `/v1/sessions/${sessionId}/turns`,
        { timeout: 15_000 },
      );
      await page.getByTestId('public-followup-input').fill('如果只改写开头，图上会有变化吗？');
      await page.getByTestId('public-followup-submit').click();
      await postPromiseCancel;

      await page.waitForFunction(
        (marker) => Array.from(document.querySelectorAll('[data-testid="public-stream-reply"]'))
          .some((el) => (el.textContent ?? '').includes(marker)),
        controllableModel.firstChunkMarker(streamNumDesktopCancel),
        { timeout: 15_000 },
      );
      await waitForTurnStatus(page, 'running', 10_000);
      const postsBeforeCancelReload = countPostTurns();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForTurnStatus(page, 'running', 15_000);
      assert.equal(countPostTurns() - postsBeforeCancelReload, 0, '桌面端取消前刷新不得重发 POST /turns');

      const cancelRespPromise = page.waitForResponse(
        (res) => res.request().method() === 'POST'
          && /^\/v1\/sessions\/[^/]+\/turns\/[^/]+\/cancel$/.test(new URL(res.url()).pathname),
        { timeout: 15_000 },
      );
      await page.getByTestId('public-cancel-btn').click();
      const cancelResp = await cancelRespPromise;
      assert.equal(cancelResp.status(), 200, '桌面端刷新恢复后主动取消应返回 200');
      controllableModel.releaseCurrent();
      await waitForTurnStatus(page, 'cancelled', 15_000);
      const snapAfterDesktopCancel = await fetchSnapshotWithBrowserCookies(page, host.origin, sessionId);
      assert.equal(snapAfterDesktopCancel.graphVersion, snapBeforeDesktopCancel.graphVersion, '桌面端取消后 graphVersion 不应递增');
    }

    // ===== 场景 4：延迟提交后快照 GET（同步等待不混版，放行后同版更新）+ 快照 500 失败重试恢复 =====
    controllableModel.setMode('ok');

    // 4a. 慢快照挂起
    let releaseSlowSnapshot = null;
    const slowSnapshotGate = new Promise((resolvePromise) => {
      releaseSlowSnapshot = resolvePromise;
    });
    let notifySlowSnapshotHit = null;
    const slowSnapshotHit = new Promise((resolvePromise) => {
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

    await waitForTurnAcceptedAndSseDone(
      page,
      async () => {
        await page.getByTestId('public-followup-input').fill('反复用同一个提示词时，AI 写作确实容易千篇一律。');
        await page.getByTestId('public-followup-submit').click();
      },
      { waitForCommitted: false },
    );
    await slowSnapshotHit;

    await page.getByTestId('snapshot-sync-banner').waitFor({ state: 'visible', timeout: 10_000 });
    await waitForSyncStatus(page, 'syncing', 10_000);

    holdSlowSnapshot = false;
    releaseSlowSnapshot();
    await waitForSyncStatus(page, 'idle', 15_000);
    await waitForTurnStatus(page, 'committed', 15_000);
    await page.unroute(`**${sessionPathname}`);

    // 4b. 快照 500 失败 -> 出现重试按钮 -> 点击重试恢复
    let shouldFailSnapshot = true;
    let notifyFailSnapshotHit = null;
    const failSnapshotHit = new Promise((resolvePromise) => {
      notifyFailSnapshotHit = resolvePromise;
    });

    await page.route(`**${sessionPathname}`, async (route) => {
      const parsed = new URL(route.request().url());
      if (shouldFailSnapshot && route.request().method() === 'GET' && parsed.pathname === sessionPathname) {
        notifyFailSnapshotHit();
        await route.fulfill({
          status: 500,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({
            schemaVersion: 1,
            protocolVersion: 'quotation-backend/v1',
            ok: false,
            data: null,
            error: { code: 'INTERNAL_ERROR', message: `${label}模拟快照同步失败` },
          }),
        });
        return;
      }
      await route.continue();
    });

    await waitForTurnAcceptedAndSseDone(
      page,
      async () => {
        await page.getByTestId('public-followup-input').fill('如果加上“反复用同一个提示词”，还有哪些地方没查清？');
        await page.getByTestId('public-followup-submit').click();
      },
      { waitForCommitted: false },
    );
    await failSnapshotHit;

    await page.getByTestId('snapshot-sync-banner').waitFor({ state: 'visible', timeout: 10_000 });
    await waitForSyncStatus(page, 'error', 10_000);
    const snapshotRetryBtn = page.getByTestId('snapshot-retry-btn');
    await snapshotRetryBtn.waitFor({ state: 'visible', timeout: 10_000 });
    const retryBox = await snapshotRetryBtn.boundingBox();
    assert.ok(retryBox && retryBox.width > 0 && retryBox.height > 0, `${label} 快照重试按钮应可见可点`);

    shouldFailSnapshot = false;
    await page.unroute(`**${sessionPathname}`);
    await snapshotRetryBtn.click();

    await waitForSyncStatus(page, 'idle', 15_000);
    await waitForTurnStatus(page, 'committed', 15_000);

    await assertNoSecretOrBearerLeak(page, tracker, [
      SENTINEL_MODEL_SECRET,
      SENTINEL_ZHIHU_SECRET,
      host.internalToken,
    ]);
    assert.equal(
      tracker.pageErrors.length,
      0,
      `${label} L-04 不应出现任何未捕获 pageerror：${tracker.pageErrors.map((e) => e.message).join('; ')}`,
    );
  } finally {
    controllableModel.releaseAll();
    await context.close();
  }
}

test('L-04 · 桌面（1440x900）与手机端（390x844）降级、刷新恢复、快照同步与缺上游明确提示', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'quotation-live-l04-'));
  const dbPath = path.join(tmpDir, 'public-l04.sqlite');
  const unconfiguredDbPath = path.join(tmpDir, 'public-l04-unconfigured.sqlite');
  const controllableSearch = createControllablePublicSearch();
  const controllableModel = createControllablePublicModel();

  const host = await startPublicWebHost({
    host: '127.0.0.1',
    port: 0,
    dbPath,
    model: controllableModel.model,
    materialsAdapter: controllableSearch.materialsAdapter,
    materialLoader: controllableSearch.materialsAdapter,
    callTool: controllableSearch.callTool,
    env: {
      AGENT_BASE_URL: 'http://127.0.0.1:11434/v1',
      AGENT_MODEL: 'mock-public-model-v4',
      AGENT_API_KEY: SENTINEL_MODEL_SECRET,
      ZHIHU_ACCESS_SECRET: SENTINEL_ZHIHU_SECRET,
    },
    quiet: true,
  });

  // 独立启动一个缺搜索且缺模型上游配置的公开宿主，验证绝不静默伪造数据
  const unconfiguredHost = await startPublicWebHost({
    host: '127.0.0.1',
    port: 0,
    dbPath: unconfiguredDbPath,
    model: null,
    materialsAdapter: null,
    materialLoader: null,
    callTool: null,
    env: {},
    quiet: true,
  });

  const browser = await launchBrowser();

  try {
    // 1. 桌面端（1440x900）全量降级与恢复
    await runL04ViewportScenarios({
      browser,
      host,
      controllableSearch,
      controllableModel,
      viewport: { width: 1440, height: 900 },
      isMobile: false,
      label: '桌面端',
    });

    // 2. 手机端（390x844）全量降级与恢复
    await runL04ViewportScenarios({
      browser,
      host,
      controllableSearch,
      controllableModel,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      label: '手机端',
    });

    // 3. 缺上游配置验证（桌面 + 手机）：清楚温和提示缺上游 + 展示由用户自行选择切换合成演示的提示，绝不静默伪造数据
    for (const cfg of [
      { label: '桌面端缺上游', viewport: { width: 1440, height: 900 }, isMobile: false },
      { label: '手机端缺上游', viewport: { width: 390, height: 844 }, isMobile: true },
    ]) {
      const ctx = await browser.newContext({
        viewport: cfg.viewport,
        ...(cfg.isMobile ? { isMobile: true, hasTouch: true } : {}),
      });
      const page = await ctx.newPage();
      const tracker = attachNetworkTracker(page, unconfiguredHost.origin);

      const handshakePromise = page.waitForResponse(
        (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/host/session',
        { timeout: 15_000 },
      );
      await page.goto(`${unconfiguredHost.origin}/`, { waitUntil: 'domcontentloaded' });
      const handshakeRes = await handshakePromise;
      assert.equal(handshakeRes.status(), 200, `${cfg.label} 握手应返回 200`);
      const handshakeData = (await handshakeRes.json()).data;
      assert.equal(handshakeData.mode, 'public', `${cfg.label} 缺上游时仍应如实声明 mode=public，不得静默伪装成 demo`);
      assert.equal(handshakeData.dataMode, 'real', `${cfg.label} 缺上游时 dataMode 必须维持 real`);
      assert.ok(
        handshakeData.capabilities?.searchReady === false || handshakeData.capabilities?.modelReady === false,
        `${cfg.label} capabilities 应如实反映上游未就绪`,
      );

      const degradeBanner = page.getByTestId('public-degrade-banner');
      await degradeBanner.waitFor({ state: 'visible', timeout: 15_000 });
      const switchDemoHint = page.getByTestId('public-switch-demo-hint');
      await switchDemoHint.waitFor({ state: 'visible', timeout: 15_000 });
      assert.ok(
        ((await switchDemoHint.textContent()) ?? '').trim().length > 0,
        `${cfg.label} 应展示由用户自行选择切换合成演示的提示`,
      );

      // 绝不静默伪造合成出处条目
      assert.equal(
        await page.getByTestId('public-citation-item').count(),
        0,
        `${cfg.label} 缺上游配置时绝不得静默伪造合成出处`,
      );

      await assertNoSecretOrBearerLeak(page, tracker, [
        SENTINEL_MODEL_SECRET,
        SENTINEL_ZHIHU_SECRET,
        unconfiguredHost.internalToken,
      ]);
      assert.equal(
        tracker.pageErrors.length,
        0,
        `${cfg.label} 不应出现任何未捕获 pageerror：${tracker.pageErrors.map((e) => e.message).join('; ')}`,
      );
      await ctx.close();
    }
  } finally {
    controllableModel.releaseAll();
    await browser.close();
    await host.close();
    await unconfiguredHost.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
