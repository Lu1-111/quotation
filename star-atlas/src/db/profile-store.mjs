// 用户画像持久化存储（由画像 Agent 写入，供其他 Agent 与前端界面读取）。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function atomicWriteJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmpPath, filePath);
}

export function createProfileStore(filePath) {
  let writeChain = Promise.resolve();

  function enqueue(fn) {
    const task = writeChain.then(fn, fn);
    writeChain = task.catch(() => {});
    return task;
  }

  async function read() {
    try {
      const raw = await readFile(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function save(profile) {
    return enqueue(async () => {
      await atomicWriteJson(filePath, profile);
      return profile;
    });
  }

  async function clear() {
    return enqueue(async () => {
      await atomicWriteJson(filePath, null);
      return null;
    });
  }

  return {
    filePath,
    read,
    save,
    clear,
  };
}
