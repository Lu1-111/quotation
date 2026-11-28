// 用户数据库（本地 JSON，内置前置格式声明）：
// 沿用原数据采集模块的快照与记录结构，并在文件顶部附带 `$formatDeclaration`，
// 便于画像 Agent、数据转换 Agent 等下游智能体读取时准确理解字段含义与约束。
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const USER_DB_SCHEMA_VERSION = 3;

export const USER_DB_FORMAT_DECLARATION = Object.freeze({
  database: 'user_database',
  title: '用户阅读行为与采集数据库（沿用原框架格式）',
  schemaVersion: USER_DB_SCHEMA_VERSION,
  description:
    '保存用户授权采集的知乎浏览历史、点赞与收藏记录。供画像 Agent 生成用户知识面貌与偏好画像，供数据转换 Agent 过滤噪音并提炼知识点。',
  topLevelFields: {
    $formatDeclaration: '本格式声明对象，用于说明数据库结构与字段语义。',
    schemaVersion: '数据结构版本号（沿用原框架 v3）。',
    source: '数据来源标识：zhihu_selected_data（真实知乎采集）或 demo_history（演示数据）。',
    account: '{ nickname: string }，采集所属账号昵称，不含敏感凭证或 Cookie。',
    syncedAt: 'ISO-8601 字符串，最近一次采集完成时间。',
    policyVersion: '基础规则预过滤策略版本（如 knowledge-v1）。',
    revision: '本次快照内容哈希，用于判定画像或转换任务是否需要更新。',
    settings: '本次采集启用的开关（history / likes / collections / knowledgeFilter / fetchFullText）。',
    counts: '各类别有效记录条数统计：{ history, likes, collections }。',
    syncStats: '最近一次采集的性能统计：{ mode, durationMs, fetchedCount, newCount, withinBudget }。',
    records: '按综合权重降序排列的有效用户记录数组，每条记录结构见 recordSchema。',
    excluded: '被基础规则预过滤排除的低质/非知识记录（仅作审计留痕）。',
    convertedKeys: '已被数据转换 Agent 处理过的记录 key 列表，避免增量同步重复转换。',
  },
  recordSchema: {
    key: 'string，内容唯一键，格式 "<contentType>:<contentId>"。',
    contentId: 'string，知乎内容 ID。',
    contentType: 'string，内容类型：answer | article | pin | question | zvideo。',
    kinds: 'string[]，行为来源列表：history（浏览）/ likes（点赞）/ collections（收藏）。',
    title: 'string，原始内容标题。',
    summary: 'string，原始内容摘要或节选（非全文）。',
    author: 'string，作者昵称。',
    url: 'string | null，原始内容链接。',
    topics: 'Array<{ id: string | null, name: string }>，知乎平台话题标签。',
    voteCount: 'number | null，赞同/点赞数。',
    commentCount: 'number | null，评论数。',
    sourceReadTime: 'string | null，原始浏览时间戳（秒）。',
    observedAt: 'string，首次采集落库的 ISO 时间。',
    weight: 'number | null，本地规则排序权重（内容类型 + 行为倍率 + 互动分 + 同主题加分 × 时间衰减）。',
    weightDetails: 'object，权重拆解明细。',
    analysis: 'object，本地规则预审结果（decision: keep | review | exclude）。',
  },
  agentReadingNotes: [
    'records 中的 weight 仅表示本窗口排序信号，并非绝对兴趣强度。',
    '严禁将 title 或 summary 原样粘贴为星球知识点；数据转换 Agent 必须提炼结构化知识点并过滤网文/日常等非知识条目。',
    '画像 Agent 不得推断用户年龄、性别、收入、职业等敏感人口学属性，只归纳知识兴趣与偏好领域。',
  ],
});

export function createEmptyUserDb() {
  return {
    $formatDeclaration: USER_DB_FORMAT_DECLARATION,
    schemaVersion: USER_DB_SCHEMA_VERSION,
    source: 'zhihu_selected_data',
    account: { nickname: '' },
    syncedAt: null,
    policyVersion: 'knowledge-v1',
    revision: null,
    settings: {
      history: true,
      likes: false,
      collections: false,
      knowledgeFilter: true,
      fetchFullText: false,
      aiReview: false,
    },
    counts: { history: 0, likes: 0, collections: 0 },
    syncStats: null,
    records: [],
    excluded: [],
    convertedKeys: [],
  };
}

async function atomicWriteJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmpPath, filePath);
}

export function createUserDatabase(filePath) {
  let writeChain = Promise.resolve();

  function enqueue(fn) {
    const task = writeChain.then(fn, fn);
    writeChain = task.catch(() => {});
    return task;
  }

  async function read() {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        ...createEmptyUserDb(),
        ...parsed,
        $formatDeclaration: USER_DB_FORMAT_DECLARATION,
        records: Array.isArray(parsed.records) ? parsed.records : [],
        excluded: Array.isArray(parsed.excluded) ? parsed.excluded : [],
        convertedKeys: Array.isArray(parsed.convertedKeys) ? parsed.convertedKeys : [],
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return createEmptyUserDb();
      throw error;
    }
  }

  async function ensureInitialized() {
    return enqueue(async () => {
      try {
        await readFile(filePath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') {
          await atomicWriteJson(filePath, createEmptyUserDb());
        } else {
          throw error;
        }
      }
      return read();
    });
  }

  async function saveSnapshot(snapshot, { syncStats = null, resetConverted = false } = {}) {
    return enqueue(async () => {
      const prev = await read();
      const records = Array.isArray(snapshot.records) ? snapshot.records : [];
      const excluded = Array.isArray(snapshot.excluded) ? snapshot.excluded : [];
      const revision =
        snapshot.revision ||
        createHash('sha256')
          .update(JSON.stringify({ records: records.map((r) => [r.key, r.title, r.weight]), excluded: excluded.length }))
          .digest('hex');

      const next = {
        $formatDeclaration: USER_DB_FORMAT_DECLARATION,
        schemaVersion: USER_DB_SCHEMA_VERSION,
        source: snapshot.source || 'zhihu_selected_data',
        account: { nickname: snapshot.account?.nickname || '' },
        syncedAt: snapshot.syncedAt || new Date().toISOString(),
        policyVersion: snapshot.policyVersion || 'knowledge-v1',
        revision,
        settings: { ...prev.settings, ...(snapshot.settings || {}) },
        counts: snapshot.counts || {
          history: records.filter((r) => (r.kinds || ['history']).includes('history')).length,
          likes: records.filter((r) => (r.kinds || []).includes('likes')).length,
          collections: records.filter((r) => (r.kinds || []).includes('collections')).length,
        },
        syncStats: syncStats ?? prev.syncStats ?? null,
        records,
        excluded,
        convertedKeys: resetConverted ? [] : prev.convertedKeys,
      };
      await atomicWriteJson(filePath, next);
      return next;
    });
  }

  async function markConverted(keys = []) {
    return enqueue(async () => {
      const current = await read();
      const set = new Set(current.convertedKeys || []);
      for (const k of keys) {
        if (typeof k === 'string' && k.trim()) set.add(k.trim());
      }
      const next = {
        ...current,
        $formatDeclaration: USER_DB_FORMAT_DECLARATION,
        convertedKeys: [...set],
      };
      await atomicWriteJson(filePath, next);
      return next;
    });
  }

  async function clear() {
    return enqueue(async () => {
      const empty = createEmptyUserDb();
      await atomicWriteJson(filePath, empty);
      return empty;
    });
  }

  return {
    filePath,
    formatDeclaration: USER_DB_FORMAT_DECLARATION,
    ensureInitialized,
    read,
    saveSnapshot,
    markConverted,
    clear,
  };
}
