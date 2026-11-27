// P1-C 同源合成宿主单元测试：覆盖同源 Cookie 会话、隐藏内部 Bearer、Bearer 直连兼容、防路径穿越、路由白名单、零外部凭证启动与 SSE 真流式续读。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import {
  SESSION_COOKIE_NAME,
  main as demoWebHostMain,
  parseDemoWebHostArgs,
  startDemoWebHost,
} from '../demo-web-host.mjs';

const USAGE = {
  inputTokens: { total: 40, noCache: 40, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

function createRawHttpRequest({ port, host = '127.0.0.1', method = 'GET', rawPath = '/', headers = {} }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request(
      {
        hostname: host,
        port,
        method,
        path: rawPath,
        headers: {
          Host: `${host}:${port}`,
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolvePromise({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', rejectPromise);
    req.end();
  });
}

function extractCookiePair(setCookieHeader) {
  assert.ok(setCookieHeader, '应签发 Set-Cookie 响应头');
  const firstSegment = String(setCookieHeader).split(';')[0].trim();
  assert.ok(firstSegment.startsWith(`${SESSION_COOKIE_NAME}=`), `Cookie 名称应为 ${SESSION_COOKIE_NAME}`);
  return firstSegment;
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

test('CLI 参数解析支持 --help、--host、--port 0 与 --db，并拦截非法参数', async () => {
  const helpParsed = parseDemoWebHostArgs(['--help']);
  assert.equal(helpParsed.help, true);

  const customParsed = parseDemoWebHostArgs(['--host', '127.0.0.1', '--port', '0', '--db', '.data/custom.sqlite']);
  assert.equal(customParsed.help, false);
  assert.deepEqual(customParsed.options, {
    host: '127.0.0.1',
    port: 0,
    dbPath: '.data/custom.sqlite',
  });

  assert.throws(() => parseDemoWebHostArgs(['--port', '70000']), /0 到 65535/);
  assert.throws(() => parseDemoWebHostArgs(['--port', 'abc']), /0 到 65535/);
  assert.throws(() => parseDemoWebHostArgs(['--unknown-flag']), /参数无效/);

  let out = '';
  let err = '';
  const exitCode = await demoWebHostMain(['--help'], {
    env: {},
    stdout: { write(chunk) { out += chunk; } },
    stderr: { write(chunk) { err += chunk; } },
  });
  assert.equal(exitCode, 0);
  assert.match(out, /serve:demo:web/);
  assert.equal(err, '');
});

test('零外部凭证启动、静态资源 MIME/缓存头、防路径穿越与绝不泄露内部 Bearer', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'quotation-demo-host-static-'));
  const dbPath = path.join(tmpDir, 'demo-web.sqlite');
  const fixedSecret = 'qtn_secret_must_never_leak_to_browser_998877';
  let stderrLog = '';

  const runtime = await startDemoWebHost({
    host: '127.0.0.1',
    port: 0,
    dbPath,
    internalToken: fixedSecret,
    stderr: { write(chunk) { stderrLog += chunk; } },
  });

  try {
    assert.equal(runtime.dataMode, 'demo');
    assert.equal(existsSync(dbPath), true, '应创建独立的演示 SQLite 数据库文件');
    assert.equal(stderrLog.includes(fixedSecret), false, '启动日志绝不能打印内部 Bearer 令牌');

    // 1. GET /health
    const healthRes = await fetch(`${runtime.origin}/health`);
    assert.equal(healthRes.status, 200);
    const healthBody = await healthRes.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.data.dataMode, 'demo');

    // 2. GET / 与 /index.html 签发 HttpOnly SameSite=Strict Cookie 且不泄露令牌
    const indexRes = await fetch(`${runtime.origin}/`);
    assert.equal(indexRes.status, 200);
    assert.match(indexRes.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(indexRes.headers.get('cache-control'), 'no-store');
    const setCookie = indexRes.headers.get('set-cookie');
    assert.ok(setCookie, 'GET / 应自动签发同源会话 Cookie');
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\//i);
    assert.equal(setCookie.includes(fixedSecret), false, 'Cookie 值绝不能包含内部 Bearer');
    const html = await indexRes.text();
    assert.match(html, /<!doctype html>/i);
    assert.equal(html.includes(fixedSecret), false, 'HTML 响应绝不能出现明文 Bearer');

    // 3. 静态资产 MIME 类型检查（.css / .js / .webp）与 Cache-Control: no-store
    const cssRes = await fetch(`${runtime.origin}/src/theme.css`);
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get('content-type') ?? '', /text\/css/);
    assert.equal(cssRes.headers.get('cache-control'), 'no-store');

    const jsRes = await fetch(`${runtime.origin}/src/cover.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get('content-type') ?? '', /text\/javascript/);
    assert.equal(jsRes.headers.get('cache-control'), 'no-store');
    const jsText = await jsRes.text();
    assert.equal(jsText.includes(fixedSecret), false, 'JS 静态资产绝不能出现明文 Bearer');

    const webpRes = await fetch(`${runtime.origin}/src/assets/black-hole.webp`);
    assert.equal(webpRes.status, 200);
    assert.equal(webpRes.headers.get('content-type'), 'image/webp');
    assert.equal(webpRes.headers.get('cache-control'), 'no-store');

    // 4. 路径穿越与越界目录全部拦截（使用原始 http.request 保留未规范化路径）
    const traversalPaths = [
      '/src/../../agent/server.mjs',
      '/src/%2e%2e/%2e%2e/agent/package.json',
      '/src/../index.html',
      '/../shots/demo.png',
      '/src/verify/verify-p0.mjs',
      '/src/.env',
      '/package.json',
    ];
    for (const badPath of traversalPaths) {
      const raw = await createRawHttpRequest({ port: runtime.port, rawPath: badPath });
      assert.ok(
        raw.status === 403 || raw.status === 404,
        `非法路径 ${badPath} 应返回 403/404，实际返回 ${raw.status}`,
      );
      assert.equal(raw.body.includes('createQuotationServer'), false, `路径 ${badPath} 不得泄露仓库源码`);
    }
  } finally {
    await runtime.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('同源 Cookie 会话鉴权、跨源/非法 Host 拒绝、路由白名单与显式 Bearer 直连兼容', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'quotation-demo-host-auth-'));
  const dbPath = path.join(tmpDir, 'demo-auth.sqlite');
  const fixedSecret = 'qtn_host_auth_test_token_1122334455';

  const runtime = await startDemoWebHost({
    host: '127.0.0.1',
    port: 0,
    dbPath,
    internalToken: fixedSecret,
    quiet: true,
  });

  try {
    // 1. 无 Cookie 且无 Bearer 拒绝
    const unauthRes = await fetch(`${runtime.origin}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usePersonalMaterials: true }),
    });
    assert.equal(unauthRes.status, 401);

    // 2. 伪造 Cookie 拒绝
    const forgedRes = await fetch(`${runtime.origin}/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${SESSION_COOKIE_NAME}=forged-invalid-sid`,
      },
      body: JSON.stringify({ usePersonalMaterials: true }),
    });
    assert.equal(forgedRes.status, 401);

    // 3. 通过 POST /api/host/session 建立有效同源 Cookie
    const bootRes = await fetch(`${runtime.origin}/api/host/session`, { method: 'POST' });
    assert.equal(bootRes.status, 200);
    const bootText = await bootRes.text();
    assert.equal(bootText.includes(fixedSecret), false, '/api/host/session 绝不能返回内部 Bearer');
    const cookiePair = extractCookiePair(bootRes.headers.get('set-cookie'));

    // 4. 跨源 Origin / Sec-Fetch-Site / 非法 Host 即使带有效 Cookie 也必须拒绝
    const badOriginRes = await fetch(`${runtime.origin}/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookiePair,
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({}),
    });
    assert.equal(badOriginRes.status, 403);

    const crossSiteRes = await fetch(`${runtime.origin}/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookiePair,
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({}),
    });
    assert.equal(crossSiteRes.status, 403);

    const badHostRes = await createRawHttpRequest({
      port: runtime.port,
      method: 'GET',
      rawPath: '/health',
      headers: { Host: 'evil.example:3006' },
    });
    assert.equal(badHostRes.status, 403);

    // 5. 允许路由白名单：非白名单 /v1 路由或方法即使带有效 Cookie 也被拒绝
    for (const [method, route] of [
      ['GET', '/v1/sessions'],
      ['DELETE', '/v1/sessions/sess_123'],
      ['POST', '/v1/admin/reset'],
      ['PUT', '/v1/sessions/sess_123'],
    ]) {
      const blocked = await fetch(`${runtime.origin}${route}`, {
        method,
        headers: { Cookie: cookiePair },
      });
      assert.ok(blocked.status === 403 || blocked.status === 404, `${method} ${route} 不应被白名单放行`);
    }

    // 6. 同源 Cookie 全链路：建会话 -> 推荐算法首轮 -> SSE 确定性解释流 -> 跨领域句子（远程办公 / 换班）均有合成证据
    const createRes = await fetch(`${runtime.origin}/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookiePair,
        Origin: runtime.origin,
      },
      body: JSON.stringify({ usePersonalMaterials: true }),
    });
    assert.equal(createRes.status, 201);
    const createdBody = await createRes.json();
    const sessionId = createdBody.data.sessionId;
    assert.ok(sessionId);
    assert.equal(createdBody.data.dataMode, 'demo');
    assert.ok(createdBody.data.lockedSnapshotId, '合成演示模式应自动锁定合成快照');

    // 提交推荐算法原句
    const turn1Res = await fetch(`${runtime.origin}/v1/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookiePair,
        Origin: runtime.origin,
      },
      body: JSON.stringify({
        clientRequestId: 'demo-host-t1',
        baseGraphVersion: 0,
        text: '推荐算法只会让人的兴趣越来越窄。',
      }),
    });
    assert.equal(turn1Res.status, 202);
    const turn1Data = (await turn1Res.json()).data;

    const sse1 = await readSseStream(`${runtime.origin}${turn1Data.eventsUrl}`, { Cookie: cookiePair });
    assert.equal(sse1.rawText.includes(fixedSecret), false, 'SSE 事件流绝不能泄露内部 Bearer');
    const eventNames = sse1.events.map((e) => e.event);
    assert.equal(eventNames[0], 'turn.started');
    assert.equal(eventNames[1], 'focus.selected');
    assert.ok(eventNames.includes('evidence.verified'), '首轮应输出 evidence.verified');
    assert.ok(eventNames.includes('text.delta'), '无自定义模型时应启用确定性解释流输出 text.delta');
    assert.ok(eventNames.includes('turn.committed'));
    assert.equal(eventNames.at(-1), 'turn.done');

    const focusEv = sse1.events.find((e) => e.event === 'focus.selected').data.focus;
    assert.equal(focusEv.spanText, '只会');
    const verifiedEv = sse1.events.find((e) => e.event === 'evidence.verified').data.verifiedEvidence;
    assert.ok(verifiedEv.length >= 1, '推荐算法首轮应命中带来源的合成证据（含周牧）');
    assert.ok(verifiedEv.some((ev) => ev.author === '周牧'), '应包含合成个人收藏中的周牧回答');

    // 跨领域句子（工厂换班）也能在零外部凭证下获得有来源的合成公开证据
    const crossSessionRes = await fetch(`${runtime.origin}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookiePair },
      body: JSON.stringify({ usePersonalMaterials: true }),
    });
    assert.equal(crossSessionRes.status, 201);
    const crossSessionId = (await crossSessionRes.json()).data.sessionId;

    const shiftTurnRes = await fetch(`${runtime.origin}/v1/sessions/${crossSessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookiePair },
      body: JSON.stringify({
        clientRequestId: 'demo-host-shift-t1',
        baseGraphVersion: 0,
        text: '工厂允许弹性换班必然导致产线良率下降。',
      }),
    });
    assert.equal(shiftTurnRes.status, 202);
    const shiftTurn = (await shiftTurnRes.json()).data;
    const shiftSse = await readSseStream(`${runtime.origin}${shiftTurn.eventsUrl}`, { Cookie: cookiePair });
    const shiftEvidence = shiftSse.events.find((e) => e.event === 'evidence.verified')?.data?.verifiedEvidence ?? [];
    assert.ok(shiftEvidence.length >= 1, '换班跨领域句子也应返回有来源的合成证据');

    // 7. 显式 Bearer 直连兼容（无需 Cookie）
    const bearerSessionRes = await fetch(`${runtime.origin}/v1/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${fixedSecret}` },
    });
    assert.equal(bearerSessionRes.status, 200);
    const bearerSnap = (await bearerSessionRes.json()).data;
    assert.equal(bearerSnap.sessionId, sessionId);

    // 8. 携带错误/畸形 Authorization 头时，即使同时附带有效 Cookie 也不得放行
    const wrongBearerWithCookie = await fetch(`${runtime.origin}/v1/sessions/${sessionId}`, {
      headers: {
        Authorization: 'Bearer wrong-token-value',
        Cookie: cookiePair,
      },
    });
    assert.equal(wrongBearerWithCookie.status, 401);

    const malformedAuthWithCookie = await fetch(`${runtime.origin}/v1/sessions/${sessionId}`, {
      headers: {
        Authorization: 'Basic dXNlcjpwYXNz',
        Cookie: cookiePair,
      },
    });
    assert.equal(malformedAuthWithCookie.status, 401);
  } finally {
    await runtime.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SSE 真实流式转发不缓冲，且支持 Last-Event-ID 无损续读', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'quotation-demo-host-sse-'));
  const dbPath = path.join(tmpDir, 'demo-sse.sqlite');

  let releaseSecondChunk;
  const secondChunkGate = new Promise((resolvePromise) => {
    releaseSecondChunk = resolvePromise;
  });

  const pausedModel = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: 'text-start', id: 's1' });
          controller.enqueue({ type: 'text-delta', id: 's1', delta: '【第一段即时流式解释】' });
          await secondChunkGate;
          controller.enqueue({ type: 'text-delta', id: 's1', delta: '【第二段续读补齐解释】' });
          controller.enqueue({ type: 'text-end', id: 's1' });
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

  const runtime = await startDemoWebHost({
    host: '127.0.0.1',
    port: 0,
    dbPath,
    model: pausedModel,
    quiet: true,
  });

  try {
    const boot = await fetch(`${runtime.origin}/api/host/session`, { method: 'POST' });
    const cookiePair = extractCookiePair(boot.headers.get('set-cookie'));

    const created = (await (await fetch(`${runtime.origin}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookiePair },
      body: JSON.stringify({ usePersonalMaterials: true }),
    })).json()).data;

    const turnRes = await fetch(`${runtime.origin}/v1/sessions/${created.sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookiePair },
      body: JSON.stringify({
        clientRequestId: 'sse-stream-check-1',
        baseGraphVersion: 0,
        text: '推荐算法只会让人的兴趣越来越窄。',
      }),
    });
    assert.equal(turnRes.status, 202);
    const { eventsUrl } = (await turnRes.json()).data;

    // 在模型卡在 secondChunkGate 之前，SSE 必须立即推送第一段 text.delta（证明未缓冲）
    const abortFirst = new AbortController();
    const firstStreamRes = await fetch(`${runtime.origin}${eventsUrl}`, {
      headers: { Cookie: cookiePair },
      signal: abortFirst.signal,
    });
    assert.equal(firstStreamRes.status, 200);

    const reader = firstStreamRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let firstDeltaEventId = null;
    let sawFirstDelta = false;

    while (!sawFirstDelta) {
      const { value, done } = await reader.read();
      assert.equal(done, false, '在释放第二段前连接不应提前结束');
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        if (!block.trim() || block.startsWith(':')) continue;
        let id = null;
        let event = '';
        let dataLine = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('id:')) id = Number(line.slice(3).trim());
          else if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (event === 'text.delta' && dataLine.includes('第一段即时流式解释')) {
          firstDeltaEventId = id;
          sawFirstDelta = true;
          break;
        }
      }
    }

    assert.ok(Number.isInteger(firstDeltaEventId) && firstDeltaEventId > 0);
    // 主动断开第一条 SSE 订阅，然后放行第二段模型输出
    abortFirst.abort();
    await reader.cancel().catch(() => {});
    releaseSecondChunk();

    // 携带 Last-Event-ID 续读剩余事件
    const resumed = await readSseStream(`${runtime.origin}${eventsUrl}`, {
      Cookie: cookiePair,
      'Last-Event-ID': String(firstDeltaEventId),
    });
    assert.ok(resumed.events.length >= 2);
    assert.ok(resumed.events.every((e) => e.id > firstDeltaEventId), '续读不得重复旧事件');
    assert.ok(
      resumed.events.some((e) => e.event === 'text.delta' && e.data?.delta?.includes('第二段续读补齐解释')),
      '续读应无损补齐第二段增量文本',
    );
    assert.ok(resumed.events.some((e) => e.event === 'turn.committed'));
    assert.equal(resumed.events.at(-1).event, 'turn.done');
  } finally {
    releaseSecondChunk();
    await runtime.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
