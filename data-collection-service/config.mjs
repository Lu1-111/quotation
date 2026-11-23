import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createApiClient } from './client.mjs';

export function storagePaths(demo = false, dataDir = process.env.DATA_SERVICE_DATA_DIR) {
  const root = resolve(dataDir || fileURLToPath(new URL('./.data/server', import.meta.url)));
  return { root, database: join(root, demo ? 'demo.sqlite' : 'live.sqlite') };
}
export function configuredClient(role = 'user', credentialsFile) {
  let saved = {};
  if (credentialsFile) saved = JSON.parse(readFileSync(resolve(credentialsFile), 'utf8'));
  return createApiClient({ baseUrl: process.env.DATA_SERVICE_URL || saved.baseUrl || 'http://127.0.0.1:3005',
    token: role === 'user' ? process.env.DATA_SERVICE_USER_TOKEN || saved.userToken : role === 'reader' ? process.env.DATA_SERVICE_AGENT_TOKEN || saved.agentToken : process.env.DATA_SERVICE_DEVICE_TOKEN || saved.deviceToken });
}
export const defaultWorkerDir = () => resolve(process.env.WORKER_DATA_DIR || fileURLToPath(new URL('./.data/worker', import.meta.url)));
