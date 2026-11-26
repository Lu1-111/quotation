import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSkillClient, buildSkillEnv, resolvePythonBin } from '../skill-client.mjs';
import { createLocalAgentTools } from '../agent-tools.mjs';

test('buildSkillEnv 按官方 SKILL.md 注入认证与可选地址，不夹带无关私有变量', () => {
  const env = buildSkillEnv({
    accessSecret: 'secret-abc-123',
    openApiBaseUrl: 'https://developer.zhihu.com',
    searchUrl: 'https://custom.example/api/v1/content/zhihu_search',
    parentEnv: { PATH: '/usr/bin', UNRELATED_SECRET: 'do-not-copy' },
  });
  assert.equal(env.ZHIHU_ACCESS_SECRET, 'secret-abc-123');
  assert.equal(env.ZHIHU_OPENAPI_BASE_URL, 'https://developer.zhihu.com');
  assert.equal(env.ZHIHU_ZHIHU_SEARCH_URL, 'https://custom.example/api/v1/content/zhihu_search');
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(env.UNRELATED_SECRET, undefined);
});

test('真实调用官方 scripts/zhihu-search.py：验证 Bearer 鉴权、地址优先级、Emoji/长 ID 解析与错误脱敏', async (t) => {
  // 确保本机存在 Python 3
  const py = resolvePythonBin();
  assert.ok(py);

  let lastReq = null;
  let nextStatus = 200;
  let nextBody = null;

  const mockUpstream = createServer((req, res) => {
    lastReq = {
      url: req.url,
      headers: req.headers,
    };
    res.writeHead(nextStatus, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(nextBody);
  });
  mockUpstream.listen(0, '127.0.0.1');
  await once(mockUpstream, 'listening');
  t.after(() => new Promise((resolve) => mockUpstream.close(resolve)));

  const { port } = mockUpstream.address();

  // 1. 验证 ZHIHU_OPENAPI_BASE_URL 生效、UTF-8 Emoji 与 64 位长整数无损保留
  nextStatus = 200;
  nextBody = JSON.stringify({
    Code: 0,
    Message: 'success',
    Data: {
      HasMore: false,
      SearchHashId: 'skill-hash-1',
      Items: [{
        ContentID: '__LONG_ID__',
        ContentType: 'article',
        Title: '知乎搜索 Skill 实测 🚀',
        ContentText: '包含 <em>RAG</em> 高亮与 Emoji 😀 的摘要',
        Url: 'https://zhuanlan.zhihu.com/p/969570047710216201?utm_source=skill',
        AuthorName: '测试作者',
        VoteUpCount: 42,
        CommentCount: 5,
        RankingScore: 0.95,
      }],
    },
  }).replace('"__LONG_ID__"', '969570047710216201');

  const baseClient = createSkillClient({
    accessSecret: 'my-secret-token-999',
    openApiBaseUrl: `http://127.0.0.1:${port}`,
    searchUrl: '',
  });
  assert.equal(baseClient.provider, 'zhihu_search_skill');
  const res1 = await baseClient.search('如何理解 rave 文化', 5);
  assert.equal(lastReq.url.startsWith('/api/v1/content/zhihu_search?'), true);
  const params1 = new URL(lastReq.url, 'http://127.0.0.1').searchParams;
  assert.equal(params1.get('Query'), '如何理解 rave 文化');
  assert.equal(params1.get('Count'), '5');
  assert.equal(lastReq.headers.authorization, 'Bearer my-secret-token-999');
  assert.match(String(lastReq.headers['x-request-timestamp']), /^\d{10}$/);
  assert.equal(res1.searchHashId, 'skill-hash-1');
  assert.equal(res1.items[0].contentId, '969570047710216201');
  assert.equal(res1.items[0].contentType, 'article');
  assert.equal(res1.items[0].title, '知乎搜索 Skill 实测 🚀');
  assert.equal(res1.items[0].excerpt, '包含 RAG 高亮与 Emoji 😀 的摘要');

  // 2. 验证 ZHIHU_ZHIHU_SEARCH_URL 优先级高于 ZHIHU_OPENAPI_BASE_URL
  const overrideClient = createSkillClient({
    accessSecret: 'my-secret-token-999',
    openApiBaseUrl: 'http://127.0.0.1:1', // 不可达地址，证明被 searchUrl 覆盖
    searchUrl: `http://127.0.0.1:${port}/custom/zhihu_search`,
  });
  await overrideClient.search('RAG', 3);
  assert.equal(lastReq.url.startsWith('/custom/zhihu_search?'), true);

  // 3. 验证鉴权失败与限流错误映射，且绝不泄露密钥
  nextStatus = 401;
  nextBody = JSON.stringify({ Code: 20001, Message: 'invalid token my-secret-token-999' });
  await assert.rejects(
    baseClient.search('RAG', 2),
    (err) => err.code === 'UPSTREAM_AUTH' && err.status === 401 && !err.message.includes('my-secret-token-999'),
  );

  nextStatus = 429;
  nextBody = JSON.stringify({ Code: 30001, Message: 'rate limit' });
  await assert.rejects(
    baseClient.search('RAG', 2),
    (err) => err.code === 'RATE_LIMITED' && err.status === 429,
  );

  // 4. 验证 createLocalAgentTools 默认走官方 zhihu_search_skill
  nextStatus = 200;
  nextBody = JSON.stringify({
    Code: 0,
    Message: 'success',
    Data: {
      HasMore: false,
      SearchHashId: 'skill-tools-e2e',
      Items: [{
        ContentID: '888',
        ContentType: 'Answer',
        Title: 'Agent 工具走 Skill 链路',
        ContentText: '摘要文本',
        Url: 'https://www.zhihu.com/answer/888',
        AuthorName: '答主',
      }],
    },
  });
  const dir = mkdtempSync(join(tmpdir(), 'quotation-skill-tools-'));
  const dbPath = join(dir, 'search.sqlite');
  const tools = createLocalAgentTools({
    accessSecret: 'my-secret-token-999',
    openApiBaseUrl: `http://127.0.0.1:${port}`,
    dataFile: dbPath,
  });
  t.after(async () => {
    await tools.close();
    rmSync(dbPath, { force: true });
    rmdirSync(dir);
  });
  const toolRes = await tools.call('zhihu_search', { query: 'Skill', maxQueries: 1 });
  assert.equal(toolRes.ok, true);
  assert.equal(toolRes.data.provider, 'zhihu_search_skill');
  assert.equal(toolRes.data.items.length, 1);
});
