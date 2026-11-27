// 真实公开同源宿主与官方知乎检索单元测试：覆盖浏览器会话隔离、安全边界拦截、统一握手、零密钥泄露、四类降级状态、Bearer 直连与 CLI --help。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import {
  PUBLIC_SESSION_COOKIE_NAME,
  main as publicWebHostMain,
  parsePublicWebHostArgs,
  startPublicWebHost,
} from '../public-web-host.mjs';
import { startDemoWebHost } from '../demo-web-host.mjs';
import {
  createMaterialsAdapter,
  planPublicSearchQueries,
  searchGapMaterials,
} from '../materials.mjs';

const USAGE = {
  inputTokens: { total: 42, noCache: 42, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 24, text: 24, reasoning: 0 },
};

function extractPublicCookiePair(setCookieHeader) {
  assert.ok(setCookieHeader, '应签发 Set-Cookie 响应头');
  assert.match(setCookieHeader, /HttpOnly/i);
  assert.match(setCookieHeader, /SameSite=Strict/i);
  assert.match(setCookieHeader, /Path=\//i);
  const firstSegment = String(setCookieHeader).split(';')[0].trim();
  assert.ok(
    firstSegment.startsWith(`${PUBLIC_SESSION_COOKIE_NAME}=`),
    `Cookie 名称应为 ${PUBLIC_SESSION_COOKIE_NAME}`,
  );
  return firstSegment;
}

function createStreamingMockModel(text) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-start', id: 'p1' });
          controller.enqueue({ type: 'text-delta', id: 'p1', delta: text });
          controller.enqueue({ type: 'text-end', id: 'p1' });
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: USAGE,
          });
          controller.close();
        },
      }),
    }),
  });
}

async function readSseStream(url, headers = {}) {
  const res = await fetch(url, { headers });
  assert.equal(res.status, 200, `SSE 响应状态应为 200，收到 ${res.status}`);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const rawChunks = [];
  const events = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    rawChunks.push(text);
    buffer += text;
    let sepIdx;
    while ((sepIdx = buffer.indexOf('\n\n')) >= 0) {
      const rawBlock = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);
      if (!rawBlock.trim() || rawBlock.startsWith(':')) continue;
      let id = null;
      let event = 'message';
      const dataLines = [];
      for (const line of rawBlock.split('\n')) {
        if (line.startsWith('id:')) id = Number(line.slice(3).trim());
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      events.push({
        id,
        event,
        data: dataLines.length ? JSON.parse(dataLines.join('\n')) : null,
      });
    }
  }
  return { events, rawText: rawChunks.join('') };
}

test('CLI 参数解析支持 --help、--host、--port 0、--db、--base-url、--model 并拦截非法参数', async () => {
  const helpParsed = parsePublicWebHostArgs(['--help']);
  assert.equal(helpParsed.help, true);

  const customParsed = parsePublicWebHostArgs([
    '--host', '127.0.0.1',
    '--port', '0',
    '--db', '.data/public-custom.sqlite',
    '--base-url', 'http://127.0.0.1:11434/v1',
    '--model', 'qwen2.5:7b',
  ]);
  assert.equal(customParsed.help, false);
  assert.deepEqual(customParsed.options, {
    host: '127.0.0.1',
    port: 0,
    dbPath: '.data/public-custom.sqlite',
    baseURL: 'http://127.0.0.1:11434/v1',
    modelName: 'qwen2.5:7b',
  });

  assert.throws(() => parsePublicWebHostArgs(['--port', '70000']), /0 到 65535/);
  assert.throws(() => parsePublicWebHostArgs(['--port', 'abc']), /0 到 65535/);
  assert.throws(() => parsePublicWebHostArgs(['--base-url', '']), /--base-url 不能为空/);
  assert.throws(() => parsePublicWebHostArgs(['--model', '   ']), /--model 不能为空/);
  assert.throws(() => parsePublicWebHostArgs(['--unknown-flag']), /参数无效/);

  let out = '';
  let err = '';
  const exitCode = await publicWebHostMain(['--help'], {
    env: {},
    stdout: { write(chunk) { out += chunk; } },
    stderr: { write(chunk) { err += chunk; } },
  });
  assert.equal(exitCode, 0);
  assert.match(out, /serve:public:web/);
  assert.equal(err, '');
});

test('浏览器 Cookie 按独立 ownerId 隔离，跨浏览器访问返回 403 SESSION_FORBIDDEN，且绝不连接个人采集服务', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'quotation-public-isolation-'));
  const dbPath = path.join(tmpDir, 'public-isolation.sqlite');
  let connectedServerIds = [];

  const mockSearchAdapter = createMaterialsAdapter({
    dataMode: 'real',
    demo: false,
    allowPersonalMaterials: false,
    usePersonalMaterials: false,
    enabled: false,
    callTool: async (toolName) => {
      assert.equal(toolName, 'zhihu_search', '公开模式仅允许调用 zhihu_search');
      return {
        schemaVersion: 1,
        ok: true,
        data: {
          requestId: 'req_pub_iso_1',
          items: [
            {
              key: 'answer:5001',
              contentId: '5001',
              contentType: 'answer',
              title: 'AI 批量写稿与人工编辑协作的边界在哪里？',
              excerpt: '在模板化资讯稿件中 AI 确实容易产出套话，但在记者现场采访整理提纲时能辅助拓展视角。',
              excerptTruncated: false,
              url: 'https://www.zhihu.com/question/4001/answer/5001?utm_source=test',
              canonicalUrl: 'https://www.zhihu.com/question/4001/answer/5001',
              author: '沈知远',
            },
          ],
          page: { offset: 0, limit: 6, total: 1, returned: 1, nextOffset: null, hasMore: false },
        },
        error: null,
      };
    },
  });

  const runtime = await startPublicWebHost({
    host: '127.0.0.1',
    port: 0,
    dbPath,
    env: {
      AGENT_ALLOW_PERSONAL_DATA: 'true',
      DATA_SERVICE_AGENT_TOKEN: 'agt_must_never_be_connected_or_leaked_12345',
      ZHIHU_ACCESS_SECRET: 'zh_sec_test_only_123456',
    },
    connectServers: async (cfg) => {
      connectedServerIds = (cfg.servers ?? []).map((s) => s.id);
      return { tools: {}, enabled: connectedServerIds, close: async () => {} };
    },
    materialsAdapter: mockSearchAdapter,
    model: createStreamingMockModel('我先看看「只会」。沈知远提到批量写稿和现场采访整理提纲的情况不同。'),
    quiet: true,
  });

  try {
    assert.equal(runtime.dataMode, 'real');
    assert.equal(existsSync(dbPath), true);
    assert.equal(connectedServerIds.includes('collection'), false, '公开宿主绝不能连接 collection 服务');

    // 浏览器 A 与浏览器 B 分别握手，拿到各自独立的 Cookie
    const bootA = await fetch(`${runtime.origin}/api/host/session`, { method: 'POST' });
    assert.equal(bootA.status, 200);
    const cookieA = extractPublicCookiePair(bootA.headers.get('set-cookie'));
    const bootABody = await bootA.json();
    assert.deepEqual(bootABody.data, {
      mode: 'public',
      dataMode: 'real',
      hostReady: true,
      usePersonalMaterials: false,
      capabilities: {
        searchReady: true,
        searchStatus: 'ready',
        modelReady: true,
        modelStatus: 'ready',
        canSwitchToDemo: true,
      },
    });

    const bootB = await fetch(`${runtime.origin}/api/host/session`, { method: 'POST' });
    assert.equal(bootB.status, 200);
    const cookieB = extractPublicCookiePair(bootB.headers.get('set-cookie'));
    assert.notEqual(cookieA, cookieB, '不同浏览器应签发不同的独立会话 Cookie');

    // 浏览器 A 创建会话（省略 usePersonalMaterials，由宿主自动规范为 false）
    const createA = await fetch(`${runtime.origin}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({}),
    });
    assert.equal(createA.status, 201);
    const sessionA = (await createA.json()).data;
    assert.match(sessionA.ownerId, /^pub_[0-9a-f]{16}$/, '公开浏览器 ownerId 应为独立的 pub_<16hex>');
    assert.equal(sessionA.dataMode, 'real');
    assert.equal(sessionA.usePersonalMaterials, false);
    assert.equal(sessionA.lockedSnapshotId, null);

    // 浏览器 B 创建自己的会话，确认 ownerId 独立
    const createB = await fetch(`${runtime.origin}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieB },
      body: JSON.stringify({}),
    });
    assert.equal(createB.status, 201);
    const sessionB = (await createB.json()).data;
    assert.match(sessionB.ownerId, /^pub_[0-9a-f]{16}$/);
    assert.notEqual(sessionA.ownerId, sessionB.ownerId, '浏览器 A 与浏览器 B 必须拥有不同的 ownerId');

    // 浏览器 A 提交一轮对话并读取 SSE
    const turnA = await fetch(`${runtime.origin}/v1/sessions/${sessionA.sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({
        clientRequestId: 'pub-iso-turn-1',
        baseGraphVersion: 0,
        text: 'AI 写作只会让文章越来越同质化。',
      }),
    });
    assert.equal(turnA.status, 202);
    const turnAData = (await turnA.json()).data;

    // 浏览器 B 跨会话读取快照、提交轮次、订阅 SSE、取消轮次 -> 全部返回 403 SESSION_FORBIDDEN
    const crossGet = await fetch(`${runtime.origin}/v1/sessions/${sessionA.sessionId}`, {
      headers: { Cookie: cookieB },
    });
    assert.equal(crossGet.status, 403);
    assert.equal((await crossGet.json()).error.code, 'SESSION_FORBIDDEN');

    const crossTurn = await fetch(`${runtime.origin}/v1/sessions/${sessionA.sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieB },
      body: JSON.stringify({
        clientRequestId: 'pub-cross-turn-1',
        baseGraphVersion: 0,
        text: '试图写入他人会话',
      }),
    });
    assert.equal(crossTurn.status, 403);
    assert.equal((await crossTurn.json()).error.code, 'SESSION_FORBIDDEN');

    const crossSse = await fetch(`${runtime.origin}${turnAData.eventsUrl}`, {
      headers: { Cookie: cookieB },
    });
    assert.equal(crossSse.status, 403);
    assert.equal((await crossSse.json()).error.code, 'SESSION_FORBIDDEN');

    const crossCancel = await fetch(
      `${runtime.origin}/v1/sessions/${sessionA.sessionId}/turns/${turnAData.turnId}/cancel`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieB },
        body: JSON.stringify({ reason: 'cross-browser-attempt' }),
      },
    );
    assert.equal(crossCancel.status, 403);
    assert.equal((await crossCancel.json()).error.code, 'SESSION_FORBIDDEN');

    // 浏览器 A 自身可以正常读取自己的 SSE 与会话快照
    const sseA = await readSseStream(`${runtime.origin}${turnAData.eventsUrl}`, { Cookie: cookieA });
    assert.equal(sseA.events.at(-1)?.event, 'turn.done');

    const ownGet = await fetch(`${runtime.origin}/v1/sessions/${sessionA.sessionId}`, {
      headers: { Cookie: cookieA },
    });
    assert.equal(ownGet.status, 200);
  } finally {
    await runtime.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('安全边界：拒绝 usePersonalMaterials: true、snapshotId、initialGraph、预置提议、action.proposal 与外部地址字段', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'quotation-public-security-'));
  const dbPath = path.join(tmpDir, 'public-security.sqlite');

  const runtime = await startPublicWebHost({
    host: '127.0.0.1',
    port: 0,
    dbPath,
    env: {},
    model: createStreamingMockModel('测试回复'),
    quiet: true,
  });

  try {
    const boot = await fetch(`${runtime.origin}/api/host/session`, { method: 'POST' });
    const cookie = extractPublicCookiePair(boot.headers.get('set-cookie'));

    const forbiddenSessionPayloads = [
      { label: 'usePersonalMaterials: true', body: { usePersonalMaterials: true }, expectedCode: 'PERSONAL_DATA_FORBIDDEN' },
      { label: 'snapshotId', body: { snapshotId: 'snap_private_001' }, expectedCode: 'PERSONAL_DATA_FORBIDDEN' },
      { label: 'initialGraph', body: { initialGraph: [{ id: 'n1', text: '注入节点' }] }, expectedCode: 'SESSION_FORBIDDEN' },
      { label: 'dataMode: demo', body: { dataMode: 'demo' }, expectedCode: 'DATA_MODE_MISMATCH' },
      {
        label: 'metadata.proposalsByRequestId',
        body: { metadata: { proposalsByRequestId: { req1: { candidateNodes: [] } } } },
        expectedCode: 'SESSION_FORBIDDEN',
      },
      {
        label: 'metadata.proposalsByTurnNumber',
        body: { metadata: { proposalsByTurnNumber: { 1: { candidateNodes: [] } } } },
        expectedCode: 'SESSION_FORBIDDEN',
      },
      { label: 'baseURL 外部地址', body: { baseURL: 'https://evil.example/v1' }, expectedCode: 'SESSION_FORBIDDEN' },
      { label: 'apiUrl 外部地址', body: { apiUrl: 'https://evil.example/api' }, expectedCode: 'SESSION_FORBIDDEN' },
      { label: 'searchUrl 外部地址', body: { searchUrl: 'https://evil.example/search' }, expectedCode: 'SESSION_FORBIDDEN' },
      { label: 'endpoint 外部地址', body: { metadata: { endpoint: 'https://evil.example' } }, expectedCode: 'SESSION_FORBIDDEN' },
      { label: 'apiKey 注入', body: { apiKey: 'sk-injected-key' }, expectedCode: 'SESSION_FORBIDDEN' },
    ];

    for (const item of forbiddenSessionPayloads) {
      const res = await fetch(`${runtime.origin}/v1/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(item.body),
      });
      assert.equal(res.status, 403, `${item.label} 应返回 403`);
      const json = await res.json();
      assert.equal(json.ok, false);
      assert.equal(json.error.code, item.expectedCode, `${item.label} 错误码应为 ${item.expectedCode}`);
    }

    // 正常创建一个公开会话后，验证 turns 端点同样拦截 action.proposal 与外部地址字段
    const validSessionRes = await fetch(`${runtime.origin}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(validSessionRes.status, 201);
    const { sessionId } = (await validSessionRes.json()).data;

    const forbiddenTurnPayloads = [
      {
        label: 'action.proposal',
        body: {
          clientRequestId: 'sec-t1',
          baseGraphVersion: 0,
          text: '测试句子',
          action: { type: 'analyze_statement', proposal: { candidateNodes: [] } },
        },
      },
      {
        label: 'top-level proposal',
        body: {
          clientRequestId: 'sec-t2',
          baseGraphVersion: 0,
          text: '测试句子',
          proposal: { candidateNodes: [] },
        },
      },
      {
        label: 'turn baseURL',
        body: {
          clientRequestId: 'sec-t3',
          baseGraphVersion: 0,
          text: '测试句子',
          baseURL: 'https://evil.example/v1',
        },
      },
      {
        label: 'turn usePersonalMaterials',
        body: {
          clientRequestId: 'sec-t4',
          baseGraphVersion: 0,
          text: '测试句子',
          usePersonalMaterials: true,
        },
      },
    ];

    for (const item of forbiddenTurnPayloads) {
      const res = await fetch(`${runtime.origin}/v1/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(item.body),
      });
      assert.equal(res.status, 403, `${item.label} 应返回 403`);
      const json = await res.json();
      assert.equal(json.ok, false);
      assert.ok(
        json.error.code === 'SESSION_FORBIDDEN' || json.error.code === 'PERSONAL_DATA_FORBIDDEN',
        `${item.label} 应返回明确拒绝错误码`,
      );
    }
  } finally {
    await runtime.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('缺凭证不崩溃启动、统一握手（public 与 demo 结构一致）、严格零密钥泄露与 Bearer 直连兼容', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'quotation-public-secrets-'));
  const pubDbPath = path.join(tmpDir, 'public-unconfigured.sqlite');
  const demoDbPath = path.join(tmpDir, 'demo-handshake.sqlite');

  const secretApiKey = 'sk-public-secret-api-key-99887766';
  const secretZhihu = 'zhihu-secret-token-must-never-leak-554433';
  const directBearer = 'qtn_direct_bearer_real_test_11223344';
  let stderrLog = '';
  const accessLogs = [];

  // 1) 缺少 ZHIHU_ACCESS_SECRET 与 AGENT_BASE_URL/AGENT_MODEL 时仍可平滑启动，握手如实上报 not_configured
  const unconfiguredHost = await startPublicWebHost({
    host: '127.0.0.1',
    port: 0,
    dbPath: pubDbPath,
    env: {
      AGENT_API_KEY: secretApiKey,
      ZHIHU_ACCESS_SECRET: '',
    },
    bearerToken: directBearer,
    stderr: { write(chunk) { stderrLog += chunk; } },
    logger: (entry) => accessLogs.push(entry),
  });

  // 2) 同时启动一个有模型（故意在流文本中回显密钥）的宿主验证 SSE/JSON/HTML/JS/Cookie/日志脱敏
  const leakTestDbPath = path.join(tmpDir, 'public-leak-test.sqlite');
  const leakCheckHost = await startPublicWebHost({
    host: '127.0.0.1',
    port: 0,
    dbPath: leakTestDbPath,
    env: {
      AGENT_API_KEY: secretApiKey,
      ZHIHU_ACCESS_SECRET: secretZhihu,
    },
    connectServers: async () => ({
      tools: {
        zhihu_search: {
          execute: async () => ({
            schemaVersion: 1,
            ok: true,
            data: { requestId: 'req_empty_1', items: [], page: { offset: 0, limit: 6, total: 0, returned: 0, nextOffset: null, hasMore: false } },
            error: null,
          }),
        },
      },
      enabled: ['search'],
      close: async () => {},
    }),
    bearerToken: directBearer,
    model: createStreamingMockModel(`安全解释文本，附带测试泄露串 ${secretApiKey} 与 ${secretZhihu} 与 ${directBearer}。`),
    stderr: { write(chunk) { stderrLog += chunk; } },
  });

  // 3) 启动 demo-web-host 校验统一握手结构
  const demoHost = await startDemoWebHost({
    host: '127.0.0.1',
    port: 0,
    dbPath: demoDbPath,
    quiet: true,
  });

  try {
    // 验证未配置态握手
    const unconfBoot = await fetch(`${unconfiguredHost.origin}/api/host/session`, { method: 'POST' });
    assert.equal(unconfBoot.status, 200);
    const unconfData = (await unconfBoot.json()).data;
    assert.deepEqual(unconfData, {
      mode: 'public',
      dataMode: 'real',
      hostReady: true,
      usePersonalMaterials: false,
      capabilities: {
        searchReady: false,
        searchStatus: 'not_configured',
        modelReady: false,
        modelStatus: 'not_configured',
        canSwitchToDemo: true,
      },
    });

    // 验证 demo 宿主统一握手结构
    const demoBoot = await fetch(`${demoHost.origin}/api/host/session`, { method: 'POST' });
    assert.equal(demoBoot.status, 200);
    const demoData = (await demoBoot.json()).data;
    assert.deepEqual(demoData, {
      mode: 'demo',
      dataMode: 'demo',
      hostReady: true,
      usePersonalMaterials: true,
      capabilities: {
        searchReady: true,
        searchStatus: 'ready',
        modelReady: true,
        modelStatus: 'ready',
        canSwitchToDemo: false,
      },
    });

    // 验证 HTML / JS / Cookie / JSON / SSE / 日志均不泄露任何密钥与令牌
    const indexRes = await fetch(`${leakCheckHost.origin}/`);
    assert.equal(indexRes.status, 200);
    const cookieHeader = indexRes.headers.get('set-cookie');
    const cookiePair = extractPublicCookiePair(cookieHeader);
    const html = await indexRes.text();
    const jsRes = await fetch(`${leakCheckHost.origin}/src/live-session.js`);
    assert.equal(jsRes.status, 200);
    const jsText = await jsRes.text();

    const sessRes = await fetch(`${leakCheckHost.origin}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookiePair },
      body: JSON.stringify({}),
    });
    assert.equal(sessRes.status, 201);
    const sessRaw = await sessRes.text();
    const { sessionId } = JSON.parse(sessRaw).data;

    const turnRes = await fetch(`${leakCheckHost.origin}/v1/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookiePair },
      body: JSON.stringify({
        clientRequestId: 'leak-check-t1',
        baseGraphVersion: 0,
        text: '测试密钥脱敏保护是否生效。',
      }),
    });
    assert.equal(turnRes.status, 202);
    const { eventsUrl } = (await turnRes.json()).data;
    const sse = await readSseStream(`${leakCheckHost.origin}${eventsUrl}`, { Cookie: cookiePair });

    const allSurfaces = [
      html,
      jsText,
      String(cookieHeader),
      sessRaw,
      sse.rawText,
      stderrLog,
      JSON.stringify(accessLogs),
    ].join('\n');

    for (const secret of [secretApiKey, secretZhihu, directBearer, 'qtn_pub_host_']) {
      assert.equal(allSurfaces.includes(secret), false, `输出面绝不能泄露敏感串：${secret}`);
    }

    // 验证显式 Authorization: Bearer 直连兼容
    const bearerCreate = await fetch(`${leakCheckHost.origin}/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${directBearer}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(bearerCreate.status, 201);
    const bearerSession = (await bearerCreate.json()).data;
    assert.equal(bearerSession.ownerId, 'public-api-owner');
    assert.equal(bearerSession.usePersonalMaterials, false);

    const bearerRead = await fetch(`${leakCheckHost.origin}/v1/sessions/${bearerSession.sessionId}`, {
      headers: { Authorization: `Bearer ${directBearer}` },
    });
    assert.equal(bearerRead.status, 200);

    // 携带错误 Bearer 时即使带有效 Cookie 也必须拒绝 401
    const wrongBearer = await fetch(`${leakCheckHost.origin}/v1/sessions/${sessionId}`, {
      headers: {
        Authorization: 'Bearer invalid-token-xyz',
        Cookie: cookiePair,
      },
    });
    assert.equal(wrongBearer.status, 401);
  } finally {
    await Promise.all([
      unconfiguredHost.close(),
      leakCheckHost.close(),
      demoHost.close(),
    ]);
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('公开检索查询规划、canonicalUrl/contentId 去重保留原始链接，以及四类降级状态（not_configured/rate_limited/timeout/empty）清晰可区分', async () => {
  // 1) 查询规划：支持模型透传 plannedQueries 与去重/脱敏
  const customPlanned = planPublicSearchQueries({
    sentence: '远程办公必然降低研发团队协作效率',
    maxQueries: 2,
    plannedQueries: [
      { query: '远程办公 研发团队 异步文档 反例', aspect: 'counterexample' },
      { query: '远程办公 研发团队 跨时区 适用条件', aspect: 'boundary' },
      { query: '第三条应被 maxQueries=2 截断', aspect: 'extra' },
    ],
  });
  assert.equal(customPlanned.length, 2);
  assert.equal(customPlanned[0].query, '远程办公 研发团队 异步文档 反例');
  assert.equal(customPlanned[1].query, '远程办公 研发团队 跨时区 适用条件');

  // 2) canonicalUrl 与 contentId 去重，保留 rawUrl / canonicalUrl / title / author / excerpt
  const dedupRes = await searchGapMaterials({
    sentence: '在夜班交接时临时换班必然导致产线良率下降',
    forceSearch: true,
    maxQueries: 1,
    callTool: async () => ({
      schemaVersion: 1,
      ok: true,
      data: {
        requestId: 'req_dedup_1',
        items: [
          {
            key: 'answer:7001',
            contentId: '7001',
            contentType: 'answer',
            title: '电子厂夜班换班制度实测',
            excerpt: '在推行书面点检表后，夜班提前报备换班并没有拉低良率。',
            url: 'https://www.zhihu.com/question/5001/answer/7001?utm_source=q1',
            canonicalUrl: 'https://www.zhihu.com/question/5001/answer/7001',
            author: '林澈',
            matchedQueries: ['夜班 换班 反例'],
          },
          {
            key: 'answer:7001_dup',
            contentId: '7001_alt',
            contentType: 'answer',
            title: '电子厂夜班换班制度实测',
            excerpt: '在推行书面点检表后，夜班提前报备换班并没有拉低良率，反而减少了连续加班疲劳失误。',
            url: 'https://www.zhihu.com/question/5001/answer/7001?utm_source=q2#top',
            canonicalUrl: 'https://www.zhihu.com/question/5001/answer/7001',
            author: '林澈',
            matchedQueries: ['夜班 换班 适用条件'],
          },
          {
            key: 'article:7002',
            contentId: '7002',
            contentType: 'article',
            title: '无交接清单的临时换班风险',
            excerpt: '当交接时间不足十分钟且缺少书面记录时，漏检风险明显上升。',
            url: 'https://zhuanlan.zhihu.com/p/7002?share=1',
            canonicalUrl: 'https://zhuanlan.zhihu.com/p/7002',
            author: '程安',
            matchedQueries: ['夜班 换班 适用条件'],
          },
        ],
        page: { offset: 0, limit: 8, total: 3, returned: 3, nextOffset: null, hasMore: false },
      },
      error: null,
    }),
  });
  assert.equal(dedupRes.status, 'ok');
  assert.equal(dedupRes.evidence.length, 2, '相同 canonicalUrl 的重复条目应合并为 1 条');
  const linChe = dedupRes.evidence.find((e) => e.author === '林澈');
  assert.ok(linChe);
  assert.equal(linChe.canonicalUrl, 'https://www.zhihu.com/question/5001/answer/7001');
  assert.ok(linChe.rawUrl.startsWith('https://www.zhihu.com/question/5001/answer/7001'));
  assert.match(linChe.excerpt, /疲劳失误/, '合并同链接条目时应保留更完整的摘要');
  assert.equal(linChe.querySource.length, 2, '合并后应保留两条命中查询');

  // 3) 四类降级状态清晰可区分：not_configured / rate_limited / timeout / empty
  const cases = [
    {
      name: 'not_configured',
      toolResult: { schemaVersion: 1, ok: false, data: null, error: { code: 'NOT_CONFIGURED', message: '未配置' } },
      expectedStatus: 'not_configured',
      expectedOk: false,
      expectedErrorCode: 'NOT_CONFIGURED',
    },
    {
      name: 'rate_limited',
      toolResult: { schemaVersion: 1, ok: false, data: null, error: { code: 'RATE_LIMITED', message: '限频' } },
      expectedStatus: 'rate_limited',
      expectedOk: false,
      expectedErrorCode: 'RATE_LIMITED',
    },
    {
      name: 'timeout',
      toolResult: { schemaVersion: 1, ok: false, data: null, error: { code: 'TIMEOUT', message: '超时' } },
      expectedStatus: 'timeout',
      expectedOk: false,
      expectedErrorCode: 'TIMEOUT',
    },
    {
      name: 'empty',
      toolResult: {
        schemaVersion: 1,
        ok: true,
        data: { requestId: 'req_empty_x', items: [], page: { offset: 0, limit: 6, total: 0, returned: 0, nextOffset: null, hasMore: false } },
        error: null,
      },
      expectedStatus: 'empty',
      expectedOk: true,
      expectedErrorCode: null,
    },
  ];

  for (const c of cases) {
    const adapter = createMaterialsAdapter({
      dataMode: 'real',
      demo: false,
      allowPersonalMaterials: false,
      usePersonalMaterials: false,
      enabled: false,
      callTool: async () => c.toolResult,
    });
    const res = await adapter.searchPublicEvidence({
      sentence: '咖啡因一定会让人晚上失眠',
      maxQueries: 1,
    });
    assert.equal(res.status, c.expectedStatus, `${c.name} 状态应为 ${c.expectedStatus}`);
    assert.equal(res.ok, c.expectedOk, `${c.name} ok 标志应为 ${c.expectedOk}`);
    assert.ok(typeof res.message === 'string' && res.message.length >= 10, `${c.name} 应提供温柔清晰的中文提示`);
    assert.equal(res.message.includes('Error:'), false, '提示不应暴露内部堆栈或英文异常前缀');
    if (c.expectedErrorCode) {
      assert.equal(res.error?.code, c.expectedErrorCode);
    }
  }
});
