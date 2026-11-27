import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const key = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const id = (...terms) => createHash('sha256').update(JSON.stringify(terms)).digest('hex').slice(0, 24);
const saveJson = (value) => JSON.stringify(value);

const domainAliases = [
  ['计算机技术', /编程|软件|算法|计算机|机器学习|人工智能|大模型|前端|后端|开发|操作系统|嵌入式|机器人/],
  ['影像艺术', /影像|摄影|拍照|后期|电影/],
  ['教育与学习', /教育|学习|语言|阅读|教学/],
  ['职场与管理', /管理|组织|职场|职业|就业/],
  ['生活与消费', /生活|消费|饮食|咖啡|烹饪|居住/],
  ['出行与城市', /交通|出行|通勤|旅行|城市/],
  ['心理与社会', /心理|社会|认知|沟通/],
];
const broadDomain = (name) => domainAliases.find(([label, aliases]) => label === name || aliases.test(name))?.[0];
const recordTopics = (record) => (record.topics ?? [])
  .map((topic) => typeof topic === 'string' ? topic : topic?.name)
  .filter((topic) => typeof topic === 'string' && key(topic));

function addPoint(map, { title, domain, description = '', kind, sources = [] }) {
  if (!key(title) || !key(domain)) return;
  const domainName = broadDomain(domain);
  const titleKey = key(title);
  let group = map.domains.find((item) => key(item.name) === key(domain))
    ?? map.domains.find((item) => domainName && broadDomain(item.name) === domainName);
  // 以前已有同一知识点时，保留它的位置和已有出处。
  group = map.domains.find((item) => item.points.some((point) => key(point.title) === titleKey)) ?? group;
  if (!group) {
    group = { id: id('domain', key(domain)), name: domain, points: [] };
    map.domains.push(group);
  }
  const descriptionKey = key(description);
  let point = group.points.find((item) => key(item.title) === titleKey
    || (descriptionKey && key(item.description) === descriptionKey));
  if (!point) {
    point = { id: id('point', group.id, titleKey), title, description, kind, sources: [] };
    group.points.push(point);
  } else if (kind === 'verified' && point.kind === 'encountered') {
    point.kind = kind;
    point.description = description;
  }
  for (const source of sources) {
    if (!point.sources.some((current) => id(current) === id(source))) point.sources.push(source);
  }
}

export function openKnowledgeMap(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS knowledge_maps (
      owner_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_imports (
      owner_id TEXT NOT NULL,
      settlement_id TEXT NOT NULL,
      PRIMARY KEY (owner_id, settlement_id)
    );
  `);
  const get = (owner) => {
    const row = db.prepare('SELECT payload FROM knowledge_maps WHERE owner_id=?').get(owner);
    return row ? JSON.parse(row.payload) : { version: 0, domains: [] };
  };
  const save = (owner, map) => db.prepare(`
    INSERT INTO knowledge_maps VALUES (?, ?)
    ON CONFLICT(owner_id) DO UPDATE SET payload=excluded.payload
  `).run(owner, saveJson(map));
  function atomic(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return {
    get,
    seed(owner, { profile, records, snapshotId }) {
      return atomic(() => {
        const map = get(owner);
        if (map.version) return map;
        for (const entry of profile.domains ?? []) {
          if (!key(entry.name) || map.domains.some((group) => key(group.name) === key(entry.name))) continue;
          map.domains.push({ id: id('domain', key(entry.name)), name: entry.name, points: [] });
          const titles = new Set((entry.evidence ?? []).map(key));
          const related = records.filter((item) => titles.has(key(item.title)));
          const domain = broadDomain(entry.name);
          const scoped = related.length || !domain ? related : records.filter((item) =>
            [...(item.domains ?? []), ...recordTopics(item)].some((name) => broadDomain(name) === domain));
          for (const record of scoped) {
            const terms = recordTopics(record).slice(0, 4);
            for (const title of terms.length ? terms : [record.title]) {
              addPoint(map, {
                title, domain: entry.name, kind: 'encountered',
                sources: [{ kind: 'profile', title: record.title, url: record.url ?? null, snapshotId }],
              });
            }
          }
        }
        for (const title of profile.topics ?? []) {
          if (!key(title)) continue;
          const record = records.find((item) => [...recordTopics(item), item.title]
            .some((name) => key(name).includes(key(title))));
          const domain = record?.domains?.[0] ?? broadDomain(title) ?? '待归类兴趣';
          addPoint(map, {
            title, domain, kind: 'encountered',
            sources: [{
              kind: 'profile', title: record?.title ?? '工作台画像关注点',
              url: record?.url ?? null, snapshotId,
            }],
          });
        }
        map.version = 1;
        save(owner, map);
        return map;
      });
    },
    deliver(owner, settlementId, points) {
      return atomic(() => {
        const added = db.prepare('INSERT OR IGNORE INTO knowledge_imports VALUES (?, ?)').run(owner, settlementId);
        const map = get(owner);
        if (!added.changes) return map;
        const previous = saveJson(map.domains);
        for (const point of points) addPoint(map, { ...point, kind: 'verified' });
        if (previous !== saveJson(map.domains)) {
          map.version += 1;
          save(owner, map);
        }
        return map;
      });
    },
    close: () => db.close(),
  };
}
