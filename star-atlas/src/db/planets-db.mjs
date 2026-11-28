// 星球数据库（本地 JSON，内置前置格式声明 + 实时变动监测）：
// 采用分条记录，每条记录拥有唯一编号，包含所属领域、知识点、内容摘要、权重。
// 每条记录代表一颗待由“星图写入 Agent”写入 3D 星图的知识星球。
import { EventEmitter } from 'node:events';
import { watch } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PLANETS_DB_SCHEMA_VERSION = 1;

export const PLANETS_DB_FORMAT_DECLARATION = Object.freeze({
  database: 'planets_database',
  title: '知识星球数据库（星图写入源）',
  schemaVersion: PLANETS_DB_SCHEMA_VERSION,
  description:
    '以分条 JSON 记录形式存储从用户浏览/互动数据中提炼出的结构化知识点。每条记录代表一颗待加入 3D 星图的星球；星图写入 Agent 会实时监听本库变动并将新增条目写入星图合适位置。',
  topLevelFields: {
    $formatDeclaration: '本格式声明对象，便于各 Agent 在读取时直接理解字段规范。',
    schemaVersion: '星球数据库格式版本号。',
    updatedAt: 'ISO-8601 字符串，最近一次变更时间。',
    nextSequence: '整数，用于自动生成下一条记录的递增编号（如 PL-0001）。',
    records: '星球记录数组（分条记录），每条记录结构见 recordSchema。',
  },
  recordSchema: {
    id: 'string，星球唯一编号（如 PL-0001）。',
    domain: 'string，知识点所属领域（完全由归纳出的知识点本身所属学科/技术领域决定，不由原帖标题或栏目决定；星图写入 Agent 会做语义归并）。',
    knowledgePoint: 'string，主标题——从帖子中归纳提炼的核心知识点概念名称（简洁、可复用，绝非原帖标题或内容粘贴）。',
    summary: 'string，对该知识点本身的结构化说明摘要（阐述概念原理、方法或结论，30-160 字）。',
    weight: 'number，知识点权重（1-100 整数）。',
    sources: 'Array<{ key: string, title: string, url: string | null, author: string, contentType: string }>，该知识点归纳自哪些原始帖子的出处列表（仅作出处溯源展示，不决定星球知识属性）。',
    status: 'string，写入星图状态："pending"（待写入星图）| "placed"（已写入星图）。',
    sourceRecordKeys: 'string[]，来源用户记录 key 列表（与 sources 对应，用于增量去重）。',
    createdAt: 'string，记录创建时间（ISO-8601）。',
    updatedAt: 'string，记录最近更新时间（ISO-8601）。',
    placedAt: 'string | null，被星图写入 Agent 写入星图的时间。',
  },
  agentRules: [
    '决定星球所有核心属性（domain、knowledgePoint、summary、weight）的是从帖子中归纳出的知识点本身，而不是用户浏览的帖子本身；原帖仅作为出处记录在 sources 字段中。',
    '数据转换 Agent 写入时必须确保每条记录具备独立知识价值，严禁写入网文、纯日常、八卦情绪帖或直接粘贴原帖内容。',
    '星图写入 Agent 读取本库时应重点处理 status === "pending" 的条目；写入星图后将其标记为 "placed"。',
    '若外部手动向 records 新增了缺少 id 或 status 的条目，数据库读取器会自动补全默认 status="pending" 并触发星图写入 Agent。',
  ],
});

export function createEmptyPlanetsDb() {
  return {
    $formatDeclaration: PLANETS_DB_FORMAT_DECLARATION,
    schemaVersion: PLANETS_DB_SCHEMA_VERSION,
    updatedAt: null,
    nextSequence: 1,
    records: [],
  };
}

function clampWeight(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 50;
  return Math.max(1, Math.min(100, Math.round(num)));
}

function cleanString(value, maxLen = 200) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeSources(rawSources) {
  if (!Array.isArray(rawSources)) return [];
  const seen = new Set();
  const out = [];
  for (const item of rawSources) {
    if (!item || typeof item !== 'object') continue;
    const key = cleanString(String(item.key || ''), 80);
    const title = cleanString(String(item.title || ''), 140);
    const url = typeof item.url === 'string' && /^https?:\/\//i.test(item.url.trim()) ? item.url.trim().slice(0, 400) : null;
    const author = cleanString(String(item.author || ''), 48);
    const contentType = cleanString(String(item.contentType || ''), 24);
    const dedup = key || url || title;
    if (!dedup || seen.has(dedup)) continue;
    seen.add(dedup);
    out.push({ key, title: title || key, url, author, contentType });
  }
  return out.slice(0, 8);
}

export function normalizePlanetEntry(raw, fallbackId) {
  const domain = cleanString(raw?.domain, 40) || '通识与跨学科';
  const knowledgePoint = cleanString(raw?.knowledgePoint, 80);
  const summary = cleanString(raw?.summary, 300);
  if (!knowledgePoint) {
    throw new Error('星球记录缺少必填字段 knowledgePoint（知识点）。');
  }
  const now = new Date().toISOString();
  const sources = normalizeSources(raw?.sources);
  const sourceKeys = [
    ...new Set([
      ...(Array.isArray(raw?.sourceRecordKeys)
        ? raw.sourceRecordKeys.map((k) => cleanString(String(k), 80)).filter(Boolean)
        : []),
      ...sources.map((s) => s.key).filter(Boolean),
    ]),
  ];
  return {
    id: cleanString(raw?.id, 32) || fallbackId,
    domain,
    knowledgePoint,
    summary: summary || `${knowledgePoint}的核心概念与知识要点。`,
    weight: clampWeight(raw?.weight),
    sources,
    status: raw?.status === 'placed' ? 'placed' : 'pending',
    sourceRecordKeys: sourceKeys,
    createdAt: typeof raw?.createdAt === 'string' && raw.createdAt ? raw.createdAt : now,
    updatedAt: typeof raw?.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : now,
    placedAt: typeof raw?.placedAt === 'string' ? raw.placedAt : null,
  };
}

function formatPlanetId(seq) {
  return `PL-${String(seq).padStart(4, '0')}`;
}

async function atomicWriteJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmpPath, filePath);
}

export function createPlanetsDatabase(filePath) {
  const events = new EventEmitter();
  let writeChain = Promise.resolve();
  let fsWatcher = null;
  let watchDebounce = null;
  let lastWrittenRaw = null;

  function enqueue(fn) {
    const task = writeChain.then(fn, fn);
    writeChain = task.catch(() => {});
    return task;
  }

  async function read() {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const records = Array.isArray(parsed.records) ? parsed.records : [];
      let nextSeq = Number.isInteger(parsed.nextSequence) && parsed.nextSequence > 0 ? parsed.nextSequence : records.length + 1;
      const normalized = records
        .map((item) => {
          if (!item || typeof item !== 'object' || !cleanString(item.knowledgePoint, 80)) return null;
          const id = cleanString(item.id, 32) || formatPlanetId(nextSeq++);
          return normalizePlanetEntry(item, id);
        })
        .filter(Boolean);
      return {
        $formatDeclaration: PLANETS_DB_FORMAT_DECLARATION,
        schemaVersion: PLANETS_DB_SCHEMA_VERSION,
        updatedAt: parsed.updatedAt || null,
        nextSequence: Math.max(nextSeq, normalized.length + 1),
        records: normalized,
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return createEmptyPlanetsDb();
      throw error;
    }
  }

  async function writeInternal(data, reason = 'update') {
    const payload = {
      ...data,
      $formatDeclaration: PLANETS_DB_FORMAT_DECLARATION,
      schemaVersion: PLANETS_DB_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    lastWrittenRaw = serialized;
    await atomicWriteJson(filePath, payload);
    events.emit('change', { reason, data: payload });
    return payload;
  }

  async function ensureInitialized() {
    return enqueue(async () => {
      try {
        await readFile(filePath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') {
          await writeInternal(createEmptyPlanetsDb(), 'init');
        } else {
          throw error;
        }
      }
      return read();
    });
  }

  // 批量新增或合并星球条目（按知识点去重合并权重；新增条目默认 status = 'pending'，触发星图写入 Agent）
  async function addPlanets(entries = []) {
    return enqueue(async () => {
      const db = await read();
      const added = [];
      const updated = [];
      let seq = db.nextSequence;

      for (const raw of entries) {
        if (!raw || !cleanString(raw.knowledgePoint, 80)) continue;
        const kpNorm = cleanString(raw.knowledgePoint, 80).toLowerCase();
        const existing = db.records.find((r) => r.knowledgePoint.toLowerCase() === kpNorm);
        if (existing) {
          // 已存在同知识点：合并来源并温和提升权重
          const mergedKeys = [
            ...new Set([
              ...(existing.sourceRecordKeys || []),
              ...(Array.isArray(raw.sourceRecordKeys) ? raw.sourceRecordKeys : []),
            ]),
          ];
          const incomingWeight = clampWeight(raw.weight);
          const nextWeight = clampWeight(Math.max(existing.weight, incomingWeight) + 4);
          existing.weight = nextWeight;
          existing.sourceRecordKeys = mergedKeys;
          existing.sources = normalizeSources([...(existing.sources || []), ...(raw.sources || [])]);
          if (cleanString(raw.summary, 300).length > existing.summary.length) {
            existing.summary = cleanString(raw.summary, 300);
          }
          existing.updatedAt = new Date().toISOString();
          updated.push(existing);
        } else {
          const entry = normalizePlanetEntry({ ...raw, status: 'pending', placedAt: null }, formatPlanetId(seq++));
          db.records.push(entry);
          added.push(entry);
        }
      }

      db.nextSequence = seq;
      if (added.length > 0 || updated.length > 0) {
        await writeInternal(db, added.length > 0 ? 'planets_added' : 'planets_updated');
      }
      return { added, updated, total: db.records.length };
    });
  }

  async function markPlaced(ids = []) {
    return enqueue(async () => {
      const idSet = new Set(ids);
      if (idSet.size === 0) return read();
      const db = await read();
      const now = new Date().toISOString();
      let changed = false;
      for (const rec of db.records) {
        if (idSet.has(rec.id) && rec.status !== 'placed') {
          rec.status = 'placed';
          rec.placedAt = now;
          rec.updatedAt = now;
          changed = true;
        }
      }
      if (changed) {
        await writeInternal(db, 'planets_placed');
      }
      return db;
    });
  }

  async function resetAllPending() {
    return enqueue(async () => {
      const db = await read();
      const now = new Date().toISOString();
      for (const rec of db.records) {
        rec.status = 'pending';
        rec.placedAt = null;
        rec.updatedAt = now;
      }
      await writeInternal(db, 'planets_reset_pending');
      return db;
    });
  }

  async function clear() {
    return enqueue(async () => {
      const empty = createEmptyPlanetsDb();
      await writeInternal(empty, 'clear');
      return empty;
    });
  }

  async function getPending() {
    const db = await read();
    return db.records.filter((r) => r.status !== 'placed');
  }

  // 启动文件系统实时监听：即使外部进程或用户直接编辑 planets-db.json，也能实时检测到变动并通知星图写入 Agent
  function startWatching() {
    if (fsWatcher) return;
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    mkdir(dir, { recursive: true })
      .then(() => {
        if (fsWatcher) return;
        try {
          fsWatcher = watch(dir, { persistent: false }, (_eventType, filename) => {
            if (filename && filename !== base) return;
            clearTimeout(watchDebounce);
            watchDebounce = setTimeout(async () => {
              try {
                const raw = await readFile(filePath, 'utf8');
                if (raw === lastWrittenRaw) return;
                lastWrittenRaw = raw;
                const data = await read();
                events.emit('change', { reason: 'external_file_change', data });
              } catch {
                // 文件正在写入中间态，忽略等待下一次事件
              }
            }, 220);
          });
        } catch {
          // 某些受限文件系统不支持 fs.watch，此时仍依赖进程内 EventEmitter
        }
      })
      .catch(() => {});
  }

  function stopWatching() {
    clearTimeout(watchDebounce);
    if (fsWatcher) {
      fsWatcher.close();
      fsWatcher = null;
    }
  }

  async function backfillSources(recordByKey) {
    return enqueue(async () => {
      if (!recordByKey || recordByKey.size === 0) return read();
      const db = await read();
      let changed = false;
      for (const rec of db.records) {
        if ((rec.sources || []).length > 0 || !(rec.sourceRecordKeys || []).length) continue;
        const resolved = [];
        for (const key of rec.sourceRecordKeys) {
          const src = recordByKey.get(key);
          if (src) {
            resolved.push({
              key: src.key,
              title: src.title || key,
              url: src.url || null,
              author: src.author || '',
              contentType: src.contentType || '',
            });
          }
        }
        if (resolved.length > 0) {
          rec.sources = normalizeSources(resolved);
          changed = true;
        }
      }
      if (changed) {
        await writeInternal(db, 'planets_sources_backfilled');
      }
      return db;
    });
  }

  return {
    filePath,
    formatDeclaration: PLANETS_DB_FORMAT_DECLARATION,
    events,
    ensureInitialized,
    read,
    addPlanets,
    backfillSources,
    markPlaced,
    resetAllPending,
    clear,
    getPending,
    startWatching,
    stopWatching,
  };
}
