// 共用个人材料授权、回环端点判定、拟外发清单校验及 HTTP Schema / 合成样例一致性单测。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AUTHORIZED_PERSONAL_FIELDS,
  DEFAULT_OUTBOUND_EXCERPT_CHARS,
  DEFAULT_OUTBOUND_MAX_ITEMS,
  DEFAULT_OUTBOUND_TITLE_CHARS,
  buildOutboundPersonalManifest,
  classifyModelEndpoint,
  clipByCodePoints,
  computeOutboundPreviewId,
  evaluateLegacyProfileGate,
  evaluateLegacyProfileOutboundPolicy,
  isLocalModelEndpoint,
  isLoopbackHost,
  isLoopbackModelEndpoint,
  normalizePersonalSnippetForOutbound,
  sanitizeModelTargetOrigin,
  verifyOutboundSnippetsMatchManifest,
} from '../material-policy.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(TEST_DIR, '../schemas/http-api-v1.schema.json');
const SNAPSHOT_EXAMPLE_PATH = path.resolve(TEST_DIR, '../examples/session-snapshot-v1.json');
const SSE_EXAMPLE_PATH = path.resolve(TEST_DIR, '../examples/sse-turn-events-v1.json');

// 轻量 Draft 2020-12 Schema 校验器，与 server-sse.test.mjs 保持相同的互斥 oneOf 校验口径。
function resolveJsonPointer(rootSchema, ref) {
  assert.equal(typeof ref, 'string');
  assert.equal(ref.startsWith('#/'), true, `仅支持文档内 JSON Pointer：${ref}`);
  let current = rootSchema;
  for (const seg of ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    assert.equal(current !== null && typeof current === 'object' && seg in current, true, `未找到 $ref：${ref}`);
    current = current[seg];
  }
  return current;
}

function matchesType(value, expected) {
  if (expected === 'null') return value === null;
  if (expected === 'boolean') return typeof value === 'boolean';
  if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'string') return typeof value === 'string';
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  return false;
}

function validateNode(rootSchema, schemaNode, value, instancePath = '$') {
  const errors = [];
  if (typeof schemaNode === 'boolean') {
    if (!schemaNode) errors.push(`${instancePath}: false schema 拒绝值`);
    return errors;
  }
  if (!schemaNode || typeof schemaNode !== 'object') return errors;

  if (typeof schemaNode.$ref === 'string') {
    errors.push(...validateNode(rootSchema, resolveJsonPointer(rootSchema, schemaNode.$ref), value, instancePath));
  }
  if ('const' in schemaNode && JSON.stringify(value) !== JSON.stringify(schemaNode.const)) {
    errors.push(`${instancePath}: 期望 const=${JSON.stringify(schemaNode.const)}，实际=${JSON.stringify(value)}`);
  }
  if (Array.isArray(schemaNode.enum) && !schemaNode.enum.some((c) => JSON.stringify(c) === JSON.stringify(value))) {
    errors.push(`${instancePath}: 值 ${JSON.stringify(value)} 不在 enum ${JSON.stringify(schemaNode.enum)}`);
  }
  if (schemaNode.type !== undefined) {
    const allowed = Array.isArray(schemaNode.type) ? schemaNode.type : [schemaNode.type];
    if (!allowed.some((t) => matchesType(value, t))) {
      errors.push(`${instancePath}: 类型不匹配，期望 ${JSON.stringify(allowed)}，实际=${JSON.stringify(value)}`);
      return errors;
    }
  }
  if (typeof value === 'number') {
    if (typeof schemaNode.minimum === 'number' && value < schemaNode.minimum) {
      errors.push(`${instancePath}: ${value} < minimum ${schemaNode.minimum}`);
    }
    if (typeof schemaNode.maximum === 'number' && value > schemaNode.maximum) {
      errors.push(`${instancePath}: ${value} > maximum ${schemaNode.maximum}`);
    }
  }
  if (Array.isArray(value) && schemaNode.items) {
    for (let i = 0; i < value.length; i += 1) {
      errors.push(...validateNode(rootSchema, schemaNode.items, value[i], `${instancePath}[${i}]`));
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if (Array.isArray(schemaNode.required)) {
      for (const reqKey of schemaNode.required) {
        if (!Object.hasOwn(value, reqKey)) {
          errors.push(`${instancePath}: 缺少必需字段 "${reqKey}"`);
        }
      }
    }
    const props = schemaNode.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) {
        errors.push(...validateNode(rootSchema, props[k], v, `${instancePath}.${k}`));
      } else if (schemaNode.additionalProperties === false) {
        errors.push(`${instancePath}: 不允许额外字段 "${k}"`);
      } else if (schemaNode.additionalProperties && typeof schemaNode.additionalProperties === 'object') {
        errors.push(...validateNode(rootSchema, schemaNode.additionalProperties, v, `${instancePath}.${k}`));
      }
    }
  }
  if (schemaNode.not !== undefined && validateNode(rootSchema, schemaNode.not, value, instancePath).length === 0) {
    errors.push(`${instancePath}: 违反 not 约束`);
  }
  if (Array.isArray(schemaNode.allOf)) {
    schemaNode.allOf.forEach((sub, idx) => {
      errors.push(...validateNode(rootSchema, sub, value, `${instancePath}<allOf:${idx}>`));
    });
  }
  if (Array.isArray(schemaNode.anyOf)) {
    const ok = schemaNode.anyOf.some((sub) => validateNode(rootSchema, sub, value, instancePath).length === 0);
    if (!ok) errors.push(`${instancePath}: 未命中 anyOf 任一分支`);
  }
  if (Array.isArray(schemaNode.oneOf)) {
    const matched = schemaNode.oneOf
      .map((sub, idx) => ({
        label: sub.$ref ?? sub.type ?? `branch_${idx}`,
        errs: validateNode(rootSchema, sub, value, instancePath),
      }))
      .filter((x) => x.errs.length === 0)
      .map((x) => x.label);
    if (matched.length !== 1) {
      errors.push(`${instancePath}: oneOf 必须仅命中 1 个分支，实际=${JSON.stringify(matched)}`);
    }
  }
  return errors;
}

function assertMatchesApiSchema(schema, envelope, expectedBranch) {
  const errors = validateNode(schema, schema, envelope, '$');
  assert.deepEqual(errors, [], `Schema 校验失败：\n${errors.join('\n')}`);
  const matchedBranches = schema.properties.data.oneOf
    .filter((sub) => validateNode(schema, sub, envelope.data, '$.data').length === 0)
    .map((sub) => sub.$ref ?? sub.type);
  assert.deepEqual(matchedBranches, [expectedBranch], `data.oneOf 必须唯一命中 ${expectedBranch}`);
}

test('常量导出与 isLoopbackHost：完整覆盖 IPv4/IPv6/映射地址及公网拒绝', () => {
  assert.equal(DEFAULT_OUTBOUND_MAX_ITEMS, 20);
  assert.equal(DEFAULT_OUTBOUND_EXCERPT_CHARS, 160);
  assert.equal(DEFAULT_OUTBOUND_TITLE_CHARS, 120);
  assert.equal(Object.isFrozen(AUTHORIZED_PERSONAL_FIELDS), true);
  assert.equal(AUTHORIZED_PERSONAL_FIELDS.includes('bodyText'), true);

  const loopbackHosts = [
    '127.0.0.1',
    '127.1.2.3',
    '127.0.0.0',
    '127.255.255.255',
    'localhost',
    'LOCALHOST',
    '  localhost  ',
    '::1',
    '[::1]',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '::FFFF:127.1.2.3',
    '[::ffff:127.0.0.1]',
  ];
  for (const host of loopbackHosts) {
    assert.equal(isLoopbackHost(host), true, `应识别为回环主机：${host}`);
  }

  const nonLoopbackHosts = [
    'api.openai.com',
    'open.bigmodel.cn',
    'localhost.evil.com',
    '127.256.0.1',
    '127.0.0.1.nip.io',
    '8.8.8.8',
    '192.168.1.10',
    '10.0.0.1',
    '0.0.0.0',
    '::',
    '::ffff:192.168.1.1',
    '',
    '   ',
    null,
    undefined,
    127001,
  ];
  for (const host of nonLoopbackHosts) {
    assert.equal(isLoopbackHost(host), false, `不应识别为回环主机：${String(host)}`);
  }
});

test('sanitizeModelTargetOrigin 与 classifyModelEndpoint：准确区分回环、云端、显式标记与非法地址', () => {
  assert.equal(sanitizeModelTargetOrigin('https://user:secret@api.cloud.example:8443/v1/chat?foo=bar'), 'https://api.cloud.example:8443');
  assert.equal(sanitizeModelTargetOrigin('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434');
  assert.equal(sanitizeModelTargetOrigin('file:///etc/passwd'), null);
  assert.equal(sanitizeModelTargetOrigin('not-a-url'), null);
  assert.equal(sanitizeModelTargetOrigin(''), null);
  assert.equal(sanitizeModelTargetOrigin(null), null);

  // 回环地址
  for (const url of [
    'http://127.0.0.1:11434/v1',
    'http://127.1.2.3:8080/v1',
    'http://localhost:11434/v1',
    'http://[::1]:11434/v1',
  ]) {
    const info = classifyModelEndpoint(url);
    assert.equal(info.configured, true, url);
    assert.equal(info.isLocalModel, true, url);
    assert.equal(info.isLoopback, true, url);
    assert.equal(info.isCloudModel, false, url);
    assert.equal(isLoopbackModelEndpoint(url), true, url);
    assert.equal(isLocalModelEndpoint(url), true, url);
  }

  // 公网 / 局域网非回环地址
  for (const url of [
    'https://api.cloud-llm.example/v1',
    'http://192.168.1.50:11434/v1',
    'https://8.8.8.8/v1',
  ]) {
    const info = classifyModelEndpoint(url);
    assert.equal(info.configured, true, url);
    assert.equal(info.isLocalModel, false, url);
    assert.equal(info.isLoopback, false, url);
    assert.equal(info.isCloudModel, true, url);
    assert.equal(isLoopbackModelEndpoint(url), false, url);
    assert.equal(isLocalModelEndpoint(url), false, url);
  }

  // 显式 isCloud / isLocal 覆写
  const forcedCloud = classifyModelEndpoint('http://127.0.0.1:11434/v1', { isCloud: true, ready: true });
  assert.equal(forcedCloud.isCloudModel, true);
  assert.equal(forcedCloud.isLocalModel, false);
  assert.equal(forcedCloud.configured, true);

  const forcedLocal = classifyModelEndpoint('https://proxy.internal/v1', { isLocal: true, ready: true });
  assert.equal(forcedLocal.isLocalModel, true);
  assert.equal(forcedLocal.isCloudModel, false);

  // 从 modelConfig.baseURL 回退读取
  const fromConfig = classifyModelEndpoint(null, { baseURL: 'https://open.bigmodel.cn/api/paas/v4' });
  assert.equal(fromConfig.targetOrigin, 'https://open.bigmodel.cn');
  assert.equal(fromConfig.isCloudModel, true);

  // 未配置 URL
  const empty = classifyModelEndpoint(null, null);
  assert.equal(empty.configured, false);
  assert.equal(empty.targetOrigin, null);
  assert.equal(empty.isLocalModel, true);
  assert.equal(empty.isCloudModel, false);

  // 非法协议与畸形 URL（fail-closed 为云端）
  const badProto = classifyModelEndpoint('ftp://127.0.0.1/v1');
  assert.equal(badProto.configured, false);
  assert.equal(badProto.isCloudModel, true);
  assert.equal(badProto.isLocalModel, false);

  const malformed = classifyModelEndpoint('://broken-url');
  assert.equal(malformed.configured, false);
  assert.equal(malformed.isCloudModel, true);
  assert.equal(malformed.isLocalModel, false);
});

test('evaluateLegacyProfileGate：关闭个人材料、未配置模型、非回环模型与回环放行', () => {
  // 1. 关闭个人材料（即便配置了就绪回环模型也必须 403 拒绝）
  const disabled = evaluateLegacyProfileGate({
    allowPersonalData: false,
    modelConfig: { ready: true, baseURL: 'http://127.0.0.1:11434/v1' },
  });
  assert.equal(disabled.allowed, false);
  assert.equal(disabled.code, 'PERSONAL_DATA_DISABLED');
  assert.equal(disabled.httpStatus, 403);

  // 2. 开启个人材料但未配置/未就绪模型 -> 503
  const unconfigured = evaluateLegacyProfileGate({
    allowPersonalData: true,
    modelConfig: { ready: false, baseURL: 'http://127.0.0.1:11434/v1' },
  });
  assert.equal(unconfigured.allowed, false);
  assert.equal(unconfigured.code, 'MODEL_NOT_CONFIGURED');
  assert.equal(unconfigured.httpStatus, 503);

  const missingModel = evaluateLegacyProfileGate({ allowPersonalData: true, modelConfig: null });
  assert.equal(missingModel.allowed, false);
  assert.equal(missingModel.code, 'MODEL_NOT_CONFIGURED');
  assert.equal(missingModel.httpStatus, 503);

  // 3. 开启个人材料且模型就绪但为非回环云端模型 -> 403 CLOUD_CONSENT_REQUIRED
  const cloudDenied = evaluateLegacyProfileGate({
    allowPersonalData: true,
    modelConfig: { ready: true, baseURL: 'https://api.cloud-llm.example/v1' },
  });
  assert.equal(cloudDenied.allowed, false);
  assert.equal(cloudDenied.code, 'CLOUD_CONSENT_REQUIRED');
  assert.equal(cloudDenied.httpStatus, 403);
  assert.equal(cloudDenied.endpoint.isCloudModel, true);

  // 4. 开启个人材料且回环模型就绪 -> 200 OK 放行
  for (const baseURL of ['http://127.0.0.1:11434/v1', 'http://localhost:11434/v1', 'http://[::1]:11434/v1']) {
    const allowed = evaluateLegacyProfileGate({
      allowPersonalData: true,
      modelConfig: { ready: true, baseURL },
    });
    assert.equal(allowed.allowed, true, baseURL);
    assert.equal(allowed.code, 'OK', baseURL);
    assert.equal(allowed.httpStatus, 200, baseURL);
    assert.equal(allowed.message, null, baseURL);
    assert.equal(allowed.endpoint.isLocalModel, true, baseURL);
  }
});

test('clipByCodePoints：中文与代理对 Emoji 240 码点精确裁剪到 160 码点且不截断尾段标记', () => {
  // 构造恰好 240 个 Unicode 码点：前 160 码点含中文与 Emoji（每个 Emoji 占 2 个 UTF-16 码元但 1 个码点），后 80 码点含尾段标记
  const headPrefix = '前段标记HEAD_OK🎵🚀🎸'; // Array.from 长度为 14
  const middlePad = '测'.repeat(160 - Array.from(headPrefix).length);
  const tailMarker = 'TAIL_SECRET_MARKER_240'; // 22 码点
  const tailPad = '尾'.repeat(80 - Array.from(tailMarker).length);
  const full240 = `${headPrefix}${middlePad}${tailMarker}${tailPad}`;

  assert.equal(Array.from(full240).length, 240);
  assert.ok(full240.length > 240, '包含代理对 Emoji 时 UTF-16 长度应大于码点数');

  const clipped = clipByCodePoints(full240, 160);
  assert.equal(Array.from(clipped.text).length, 160);
  assert.equal(clipped.start, 0);
  assert.equal(clipped.end, 160);
  assert.equal(clipped.originalLength, 240);
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.text.includes('前段标记HEAD_OK🎵🚀🎸'), true);
  assert.equal(clipped.text.includes('TAIL_SECRET_MARKER_240'), false);

  // 未超限与边界情形
  const shortRes = clipByCodePoints('短文本🎵', 160);
  assert.equal(shortRes.text, '短文本🎵');
  assert.equal(shortRes.end, 4);
  assert.equal(shortRes.originalLength, 4);
  assert.equal(shortRes.truncated, false);

  const exactRes = clipByCodePoints('🎵'.repeat(160), 160);
  assert.equal(exactRes.truncated, false);
  assert.equal(exactRes.end, 160);

  const zeroRes = clipByCodePoints('任意文本', 0);
  assert.equal(zeroRes.text, '');
  assert.equal(zeroRes.end, 0);
  assert.equal(zeroRes.truncated, true);

  const nullRes = clipByCodePoints(null, 160);
  assert.equal(nullRes.text, '');
  assert.equal(nullRes.originalLength, 0);
  assert.equal(nullRes.truncated, false);
});

test('normalizePersonalSnippetForOutbound、buildOutboundPersonalManifest 与 verifyOutboundSnippetsMatchManifest', () => {
  const longBody = `前160可见片段🎯${'甲'.repeat(150)}后段敏感标记TAIL_MUST_NOT_LEAK_${'乙'.repeat(60)}`;
  const rawPersonal1 = {
    evidenceId: 'ev_col_101',
    sourceType: 'collection_record',
    snapshotId: 'snap_001',
    contentKey: 'answer:101',
    title: '推荐算法冷启动测试',
    author: '林岚',
    attribution: 'other_author',
    locator: { field: 'bodyText' },
    textKind: 'partial_body',
    behaviorKinds: ['history', 'collections'],
    url: 'https://www.zhihu.com/question/101/answer/101',
    excerpt: longBody,
  };
  const rawPersonal2 = {
    evidenceId: 'ev_col_102',
    sourceType: 'collection_record',
    snapshotId: 'snap_001',
    contentKey: 'article:102',
    title: '序列推荐收窄分析',
    author: '沈舟',
    attribution: 'other_author',
    summary: '短期高频点击会降低候选池流派熵。',
  };
  const publicSearchItem = {
    evidenceId: 'ev_pub_901',
    sourceType: 'public_search',
    excerpt: '公开检索条目不应计入个人外发清单。',
  };

  // 单条标准化验证（含脱敏回调）
  const normalized = normalizePersonalSnippetForOutbound(rawPersonal1, 0, {
    redact: (s) => String(s ?? '').replace('🎯', '[标]'),
  });
  assert.equal(normalized.evidenceId, 'ev_col_101');
  assert.equal(normalized.field, 'bodyText');
  assert.equal(normalized.source.field, 'bodyText');
  assert.equal(normalized.source.snapshotId, 'snap_001');
  assert.equal(normalized.range.start, 0);
  assert.equal(normalized.range.end, 160);
  assert.equal(normalized.truncated, true);
  assert.equal(normalized.text, normalized.excerpt);
  assert.equal(normalized.text, normalized.preview);
  assert.equal(normalized.text.includes('TAIL_MUST_NOT_LEAK'), false);
  assert.equal(normalized.text.includes('[标]'), true);
  assert.match(normalized.digest, /^[0-9a-f]{64}$/);

  const cloudModel = {
    providerName: 'openai-compatible',
    modelName: 'glm-cloud-demo',
    baseURL: 'https://api.cloud-llm.example/v1',
  };

  // 1. 确定性 outboundPreviewId、去重、仅保留个人材料
  const manifestA = buildOutboundPersonalManifest({
    modelConfig: cloudModel,
    usePersonalMaterials: true,
    cloudConsent: false,
    evidences: [rawPersonal1, rawPersonal1, publicSearchItem, rawPersonal2],
  });
  const manifestB = buildOutboundPersonalManifest({
    modelConfig: cloudModel,
    usePersonalMaterials: true,
    cloudConsent: false,
    evidences: [rawPersonal1, rawPersonal2],
  });
  assert.match(manifestA.outboundPreviewId, /^opv_[0-9a-f]{24}$/);
  assert.equal(manifestA.outboundPreviewId, manifestB.outboundPreviewId, '相同片段与目标必须产生确定性 ID');
  assert.equal(manifestA.snippetCount, 2);
  assert.equal(manifestA.items.length, 2);
  assert.equal(manifestA.snippetPreview.length, 2);
  assert.equal(manifestA.isCloudModel, true);
  assert.equal(manifestA.isLocalModel, false);
  assert.equal(manifestA.previewConfirmed, false);

  // 2. 传入匹配的 confirmedOutboundPreviewId 且 cloudConsent: true 时 previewConfirmed 才为 true
  const confirmedManifest = buildOutboundPersonalManifest({
    modelConfig: cloudModel,
    usePersonalMaterials: true,
    cloudConsent: true,
    evidences: [rawPersonal1, rawPersonal2],
    confirmedOutboundPreviewId: manifestA.outboundPreviewId,
  });
  assert.equal(confirmedManifest.previewConfirmed, true);
  assert.equal(confirmedManifest.confirmedOutboundPreviewId, manifestA.outboundPreviewId);

  const unconfirmedWithoutConsent = buildOutboundPersonalManifest({
    modelConfig: cloudModel,
    usePersonalMaterials: true,
    cloudConsent: false,
    evidences: [rawPersonal1, rawPersonal2],
    confirmedOutboundPreviewId: manifestA.outboundPreviewId,
  });
  assert.equal(unconfirmedWithoutConsent.previewConfirmed, false);

  // 3. 任意片段变更、顺序变更、模型名或目标变更都会导致 outboundPreviewId 变化
  const changedSnippetManifest = buildOutboundPersonalManifest({
    modelConfig: cloudModel,
    usePersonalMaterials: true,
    cloudConsent: true,
    evidences: [rawPersonal1, { ...rawPersonal2, summary: '短期高频点击会降低候选池流派熵（已变更）。' }],
    confirmedOutboundPreviewId: manifestA.outboundPreviewId,
  });
  assert.notEqual(changedSnippetManifest.outboundPreviewId, manifestA.outboundPreviewId);
  assert.equal(changedSnippetManifest.previewConfirmed, false, '片段变化后旧 confirmedOutboundPreviewId 不得放行');

  const changedModelManifest = buildOutboundPersonalManifest({
    modelConfig: { ...cloudModel, modelName: 'other-model' },
    usePersonalMaterials: true,
    cloudConsent: true,
    evidences: [rawPersonal1, rawPersonal2],
  });
  assert.notEqual(changedModelManifest.outboundPreviewId, manifestA.outboundPreviewId);

  const disabledManifest = buildOutboundPersonalManifest({
    modelConfig: cloudModel,
    usePersonalMaterials: false,
    cloudConsent: true,
    evidences: [rawPersonal1, rawPersonal2],
  });
  assert.equal(disabledManifest.snippetCount, 0);
  assert.deepEqual(disabledManifest.authorizedFields, []);
  assert.deepEqual(disabledManifest.items, []);

  // 4. verifyOutboundSnippetsMatchManifest：匹配通过，各类篡改均拒绝
  assert.equal(
    verifyOutboundSnippetsMatchManifest([...confirmedManifest.items, publicSearchItem], confirmedManifest),
    true,
    '完全匹配的个人片段与忽略的公开检索片段应通过校验',
  );
  assert.equal(
    verifyOutboundSnippetsMatchManifest([confirmedManifest.items[0]], confirmedManifest),
    true,
    '已确认清单的严格子集应通过校验',
  );

  // 篡改文本
  assert.equal(
    verifyOutboundSnippetsMatchManifest(
      [{ ...confirmedManifest.items[0], text: `${confirmedManifest.items[0].text}追加` }],
      confirmedManifest,
    ),
    false,
  );
  // 篡改范围
  assert.equal(
    verifyOutboundSnippetsMatchManifest(
      [{ ...confirmedManifest.items[0], range: { start: 0, end: 159 } }],
      confirmedManifest,
    ),
    false,
  );
  assert.equal(
    verifyOutboundSnippetsMatchManifest(
      [{ ...confirmedManifest.items[0], range: { start: 1, end: 160 } }],
      confirmedManifest,
    ),
    false,
  );
  // 篡改字段
  assert.equal(
    verifyOutboundSnippetsMatchManifest(
      [{ ...confirmedManifest.items[0], field: 'summary' }],
      confirmedManifest,
    ),
    false,
  );
  // 篡改 ID
  assert.equal(
    verifyOutboundSnippetsMatchManifest(
      [{ ...confirmedManifest.items[0], evidenceId: 'ev_col_unknown' }],
      confirmedManifest,
    ),
    false,
  );
  // 异常 manifest
  assert.equal(verifyOutboundSnippetsMatchManifest(confirmedManifest.items, null), false);
  assert.equal(verifyOutboundSnippetsMatchManifest(confirmedManifest.items, {}), false);

  // 5. buildOutboundPersonalManifest：snapshotId 透传、变更影响 outboundPreviewId，以及空清单（items.length === 0）保持 previewConfirmed: false
  const noSnapRecord = {
    evidenceId: 'ev_col_nosnap',
    sourceType: 'collection_record',
    contentKey: 'answer:nosnap',
    title: '缺少 snapshotId 的记录',
    summary: '用于验证显式 snapshotId 透传与绑定。',
  };
  const snapManifest1 = buildOutboundPersonalManifest({
    modelConfig: cloudModel,
    usePersonalMaterials: true,
    cloudConsent: false,
    evidences: [noSnapRecord],
    snapshotId: 'snap_explicit_001',
  });
  assert.equal(snapManifest1.snapshotId, 'snap_explicit_001');
  assert.equal(snapManifest1.lockedSnapshotId, 'snap_explicit_001');
  assert.equal(snapManifest1.items[0].snapshotId, 'snap_explicit_001');
  assert.equal(snapManifest1.items[0].source.snapshotId, 'snap_explicit_001');

  const snapManifest2 = buildOutboundPersonalManifest({
    modelConfig: cloudModel,
    usePersonalMaterials: true,
    cloudConsent: false,
    evidences: [noSnapRecord],
    snapshotId: 'snap_explicit_002',
  });
  assert.equal(snapManifest2.snapshotId, 'snap_explicit_002');
  assert.notEqual(
    snapManifest2.outboundPreviewId,
    snapManifest1.outboundPreviewId,
    'snapshotId 变化必须改变确定性 outboundPreviewId',
  );

  const emptyId = computeOutboundPreviewId({
    targetOrigin: 'https://api.cloud-llm.example',
    modelName: cloudModel.modelName,
    items: [],
  });
  const emptyConfirmedAttempt = buildOutboundPersonalManifest({
    modelConfig: cloudModel,
    usePersonalMaterials: true,
    cloudConsent: true,
    evidences: [],
    snapshotId: 'snap_empty_001',
    confirmedOutboundPreviewId: emptyId,
  });
  assert.equal(emptyConfirmedAttempt.items.length, 0);
  assert.equal(emptyConfirmedAttempt.outboundPreviewId, emptyId);
  assert.equal(emptyConfirmedAttempt.snapshotId, 'snap_empty_001');
  assert.equal(emptyConfirmedAttempt.lockedSnapshotId, 'snap_empty_001');
  assert.equal(
    emptyConfirmedAttempt.previewConfirmed,
    false,
    'items.length === 0 时即使传入 cloudConsent: true 与空清单 ID，previewConfirmed 也必须为 false',
  );
});

test('evaluateLegacyProfileOutboundPolicy：本机展示放行、关闭授权阻断、外部检索与非回环模型需已确认清单', () => {
  const localModel = { ready: true, baseURL: 'http://127.0.0.1:11434/v1' };
  const cloudModel = { ready: true, baseURL: 'https://api.cloud-llm.example/v1' };

  // 1. 本机展示始终放行（保留画像供本机展示与本机逻辑）
  const localDisplay = evaluateLegacyProfileOutboundPolicy({
    allowPersonalData: false,
    modelConfig: cloudModel,
    demoSearch: false,
    targetKind: 'local_display',
  });
  assert.equal(localDisplay.allowed, true);
  assert.equal(localDisplay.code, 'OK');

  // 2. 关闭个人材料授权：外部检索、模型与综合交互一律拒绝
  for (const targetKind of ['external_search', 'model', 'interaction']) {
    const res = evaluateLegacyProfileOutboundPolicy({
      allowPersonalData: false,
      modelConfig: localModel,
      demoSearch: true,
      targetKind,
      confirmedOutboundPreviewId: 'opv_0123456789abcdef01234567',
    });
    assert.equal(res.allowed, false, targetKind);
    assert.equal(res.code, 'PERSONAL_DATA_DISABLED', targetKind);
  }

  // 3. 外部公开检索（非 demo）在未接入已确认外发清单前拒绝，demo 或有已确认清单时放行
  const extSearchBlocked = evaluateLegacyProfileOutboundPolicy({
    allowPersonalData: true,
    modelConfig: localModel,
    demoSearch: false,
    targetKind: 'external_search',
  });
  assert.equal(extSearchBlocked.allowed, false);
  assert.equal(extSearchBlocked.code, 'CLOUD_CONSENT_REQUIRED');

  const extSearchDemo = evaluateLegacyProfileOutboundPolicy({
    allowPersonalData: true,
    modelConfig: localModel,
    demoSearch: true,
    targetKind: 'external_search',
  });
  assert.equal(extSearchDemo.allowed, true);

  const extSearchConfirmed = evaluateLegacyProfileOutboundPolicy({
    allowPersonalData: true,
    modelConfig: localModel,
    demoSearch: false,
    targetKind: 'external_search',
    confirmedOutboundPreviewId: 'opv_abcdef0123456789abcdef01',
  });
  assert.equal(extSearchConfirmed.allowed, true);

  // 4. 模型提示词：非回环无确认拒绝、非回环有确认放行、回环放行
  const cloudModelBlocked = evaluateLegacyProfileOutboundPolicy({
    allowPersonalData: true,
    modelConfig: cloudModel,
    demoSearch: true,
    targetKind: 'model',
  });
  assert.equal(cloudModelBlocked.allowed, false);
  assert.equal(cloudModelBlocked.code, 'CLOUD_CONSENT_REQUIRED');

  const cloudModelConfirmed = evaluateLegacyProfileOutboundPolicy({
    allowPersonalData: true,
    modelConfig: cloudModel,
    demoSearch: true,
    targetKind: 'model',
    confirmedOutboundPreviewId: 'opv_abcdef0123456789abcdef01',
  });
  assert.equal(cloudModelConfirmed.allowed, true);

  const localModelAllowed = evaluateLegacyProfileOutboundPolicy({
    allowPersonalData: true,
    modelConfig: localModel,
    demoSearch: true,
    targetKind: 'model',
  });
  assert.equal(localModelAllowed.allowed, true);

  // 5. 综合交互：非回环或非 demo 公开检索无确认清单均拒绝，回环 + demo 放行，有确认清单放行
  const interactionCloudBlocked = evaluateLegacyProfileOutboundPolicy({
    allowPersonalData: true,
    modelConfig: cloudModel,
    demoSearch: true,
    targetKind: 'interaction',
  });
  assert.equal(interactionCloudBlocked.allowed, false);
  assert.equal(interactionCloudBlocked.code, 'CLOUD_CONSENT_REQUIRED');

  const interactionExtSearchBlocked = evaluateLegacyProfileOutboundPolicy({
    allowPersonalData: true,
    modelConfig: localModel,
    demoSearch: false,
    targetKind: 'interaction',
  });
  assert.equal(interactionExtSearchBlocked.allowed, false);
  assert.equal(interactionExtSearchBlocked.code, 'CLOUD_CONSENT_REQUIRED');

  const interactionLocalDemoAllowed = evaluateLegacyProfileOutboundPolicy({
    allowPersonalData: true,
    modelConfig: localModel,
    demoSearch: true,
    targetKind: 'interaction',
  });
  assert.equal(interactionLocalDemoAllowed.allowed, true);

  const interactionConfirmedAllowed = evaluateLegacyProfileOutboundPolicy({
    allowPersonalData: true,
    modelConfig: cloudModel,
    demoSearch: false,
    targetKind: 'interaction',
    confirmedOutboundPreviewId: 'opv_abcdef0123456789abcdef01',
  });
  assert.equal(interactionConfirmedAllowed.allowed, true);
});

test('HTTP Schema（Draft 2020-12）与合成样例一致性及 oneOf 严格互斥校验', () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const snapshotExample = JSON.parse(readFileSync(SNAPSHOT_EXAMPLE_PATH, 'utf8'));
  const sseExample = JSON.parse(readFileSync(SSE_EXAMPLE_PATH, 'utf8'));

  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.ok(schema.$defs.OutboundPreview, '应定义 $defs/OutboundPreview');
  assert.ok(schema.$defs.OutboundPreviewItem, '应定义 $defs/OutboundPreviewItem');

  // 1. 校验 session-snapshot-v1.json 严格命中唯一分支 #/$defs/SessionSnapshot
  assertMatchesApiSchema(
    schema,
    {
      schemaVersion: 1,
      protocolVersion: 'quotation-backend/v1',
      ok: true,
      data: snapshotExample,
      error: null,
    },
    '#/$defs/SessionSnapshot',
  );

  // 校验 session-snapshot-v1.json 中 outboundPreview 的规范字段与确定性 ID
  const snapPreview = snapshotExample.outboundPreview;
  assert.match(snapPreview.outboundPreviewId, /^opv_[0-9a-f]{24}$/);
  assert.equal(snapPreview.confirmedOutboundPreviewId, null);
  assert.equal(snapPreview.previewConfirmed, false);
  assert.equal(snapPreview.snippetCount, snapPreview.items.length);
  assert.equal(snapPreview.snippetPreview.length, snapPreview.items.length);
  assert.ok(snapPreview.items.length > 0, '快照样例应包含标准化个人材料外发预览条目');
  assert.equal(
    snapPreview.outboundPreviewId,
    computeOutboundPreviewId({
      targetOrigin: snapPreview.targetOrigin,
      modelName: snapPreview.modelName,
      items: snapPreview.items,
    }),
  );
  assert.equal(verifyOutboundSnippetsMatchManifest(snapPreview.items, snapPreview), true);
  for (const item of snapPreview.items) {
    assert.equal(typeof item.evidenceId, 'string');
    assert.equal(typeof item.source?.field, 'string');
    assert.equal(typeof item.field, 'string');
    assert.equal(Number.isInteger(item.range?.start), true);
    assert.equal(Number.isInteger(item.range?.end), true);
    assert.equal(item.text, item.excerpt);
    assert.equal(item.text, item.preview);
  }

  // 2. 校验 SessionCreated、403 CLOUD_CONSENT_REQUIRED 错误响应及既有测试中的精简 outboundPreview 兼容
  assertMatchesApiSchema(
    schema,
    {
      schemaVersion: 1,
      protocolVersion: 'quotation-backend/v1',
      ok: true,
      data: {
        sessionId: 'sess_demo_1',
        ownerId: 'owner_demo',
        graphVersion: 0,
        dataMode: 'demo',
        usePersonalMaterials: true,
        lockedSnapshotId: 'snap_1',
        materialsStatus: { state: 'loaded', count: 1 },
        outboundPreview: snapPreview,
      },
      error: null,
    },
    '#/$defs/SessionCreated',
  );

  assertMatchesApiSchema(
    schema,
    {
      schemaVersion: 1,
      protocolVersion: 'quotation-backend/v1',
      ok: false,
      data: null,
      error: {
        code: 'CLOUD_CONSENT_REQUIRED',
        message: '需确认当前拟外发预览清单。',
        details: {
          outboundPreview: {
            ...snapPreview,
            snapshotId: 'snap_schema_check_001',
            lockedSnapshotId: 'snap_schema_check_001',
          },
        },
      },
    },
    'null',
  );

  // 兼容 session-store.test.mjs 中的精简 outboundPreview 对象
  assertMatchesApiSchema(
    schema,
    {
      schemaVersion: 1,
      protocolVersion: 'quotation-backend/v1',
      ok: true,
      data: {
        ...snapshotExample,
        outboundPreview: {
          isCloudModel: true,
          cloudConsentGranted: true,
          snippetCount: 0,
          personalMaterialIncluded: false,
        },
      },
      error: null,
    },
    '#/$defs/SessionSnapshot',
  );

  // 3. 校验 sse-turn-events-v1.json 顺序、单调 id、outboundPreviewId 与无真实密钥泄露
  assert.equal(Array.isArray(sseExample), true);
  assert.ok(sseExample.length >= 4);
  for (let i = 0; i < sseExample.length; i += 1) {
    assert.equal(sseExample[i].id, i + 1, 'SSE 事件序号应从 1 严格单调递增');
  }
  assert.equal(sseExample[0].event, 'turn.started');
  assert.equal(sseExample.at(-2).event, 'turn.committed');
  assert.equal(sseExample.at(-1).event, 'turn.done');

  const ssePreview = sseExample.at(-2).data.outboundPreview;
  assert.match(ssePreview.outboundPreviewId, /^opv_[0-9a-f]{24}$/);
  assert.equal(
    ssePreview.outboundPreviewId,
    computeOutboundPreviewId({
      targetOrigin: ssePreview.targetOrigin,
      modelName: ssePreview.modelName,
      items: ssePreview.items,
    }),
  );
  const sseSerialized = JSON.stringify(sseExample);
  assert.equal(/sk-[A-Za-z0-9]{12,}|agt_[A-Za-z0-9]{12,}|usr_[A-Za-z0-9]{12,}/.test(sseSerialized), false);
});
