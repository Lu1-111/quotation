// 3D 星图持久化存储（由星图写入 Agent 维护，供前端 3D 星图实时渲染）：
// 包含领域星系（galaxies）、知识分支（branches，同分支同色/不同分支异色）、
// 星球节点（planets，大小与亮度随权重变化）以及分支内/跨分支关联连线（links）。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const STAR_MAP_SCHEMA_VERSION = 1;

export const STAR_MAP_FORMAT_DECLARATION = Object.freeze({
  database: 'star_map_store',
  title: '3D 知识星图结构存储',
  schemaVersion: STAR_MAP_SCHEMA_VERSION,
  description:
    '由星图写入 Agent 根据星球数据库实时构建并更新。前端 3D 星图引擎直接读取本数据渲染星系、分支色系、星球体积亮度及关联连线。',
  structure: {
    galaxies: '领域星系数组，每个星系代表一个语义统一的知识领域，包含中心 3D 坐标 center、同义领域别名 aliases 和内部 branches。',
    planets: '星图星球数组，每颗星球绑定一条星球数据库记录（planetDbId），具备 3D 坐标 pos、branchColor、weight、sizeFactor、brightness。',
    links: '星球间关联连线数组，包含 from、to、reason、strength 以及 crossBranch（是否跨分支/跨星系连线）。',
  },
});

export function createEmptyStarMap() {
  return {
    $formatDeclaration: STAR_MAP_FORMAT_DECLARATION,
    schemaVersion: STAR_MAP_SCHEMA_VERSION,
    updatedAt: null,
    galaxies: [],
    planets: [],
    links: [],
  };
}

async function atomicWriteJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmpPath, filePath);
}

export function createStarMapStore(filePath) {
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
        $formatDeclaration: STAR_MAP_FORMAT_DECLARATION,
        schemaVersion: STAR_MAP_SCHEMA_VERSION,
        updatedAt: parsed.updatedAt || null,
        galaxies: Array.isArray(parsed.galaxies) ? parsed.galaxies : [],
        planets: Array.isArray(parsed.planets) ? parsed.planets : [],
        links: Array.isArray(parsed.links) ? parsed.links : [],
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return createEmptyStarMap();
      throw error;
    }
  }

  async function save(data) {
    return enqueue(async () => {
      const next = {
        $formatDeclaration: STAR_MAP_FORMAT_DECLARATION,
        schemaVersion: STAR_MAP_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        galaxies: Array.isArray(data.galaxies) ? data.galaxies : [],
        planets: Array.isArray(data.planets) ? data.planets : [],
        links: Array.isArray(data.links) ? data.links : [],
      };
      await atomicWriteJson(filePath, next);
      return next;
    });
  }

  async function clear() {
    return save(createEmptyStarMap());
  }

  async function ensureInitialized() {
    return enqueue(async () => {
      try {
        await readFile(filePath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') {
          await atomicWriteJson(filePath, createEmptyStarMap());
        } else {
          throw error;
        }
      }
      return read();
    });
  }

  return {
    filePath,
    ensureInitialized,
    read,
    save,
    clear,
  };
}
