import * as z from 'zod/v4';
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotSchema, deliverySchema, collectionPageSchema, knowledgeProfileSchema } from '../contracts.mjs';
import { getToolDefinitions } from '../agent-tools.mjs';
import { createServiceStore } from '../store.mjs';

const directory = new URL('../schemas/', import.meta.url); mkdirSync(directory, { recursive: true });
for (const [name, schema] of Object.entries({ 'snapshot-v3': snapshotSchema, 'delivery-v1': deliverySchema, 'collection-page-v1': collectionPageSchema, 'knowledge-profile-v1': knowledgeProfileSchema })) {
  writeFileSync(new URL(`${name}.schema.json`, directory), JSON.stringify(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' }), null, 2) + '\n');
}
writeFileSync(new URL('tools.json', directory), JSON.stringify(getToolDefinitions(), null, 2) + '\n');
const snapshot = snapshotSchema.parse(JSON.parse(readFileSync(new URL('../examples/snapshot-v3.json', import.meta.url), 'utf8')));
const example = deliverySchema.parse({ schemaVersion: 1, module: 'data-collection-service', kind: 'collection_snapshot',
  userId: '00000000-0000-4000-8000-000000000001', snapshotId: '00000000-0000-4000-8000-000000000002', deviceId: '00000000-0000-4000-8000-000000000003',
  jobId: '00000000-0000-4000-8000-000000000004', receivedAt: snapshot.syncedAt, snapshot });
writeFileSync(new URL('../examples/delivery-v1.json', import.meta.url), JSON.stringify(example, null, 2) + '\n');
const temporary = mkdtempSync(join(tmpdir(), 'zhihu-schema-example-'));
const store = createServiceStore(join(temporary, 'example.sqlite'), { demo: true, now: () => Date.parse(snapshot.syncedAt) });
try {
  const credentials = store.provision('合成示例'); const device = store.authenticate(credentials.deviceToken, 'device');
  const job = store.createJob(credentials.userId, { settings: snapshot.settings }); const claim = store.claim(device);
  store.complete(device, job.id, { leaseToken: claim.leaseToken, accountRef: 'a'.repeat(64), snapshot });
  const page = store.page(credentials.userId, { offset: 0, limit: 10, summaryMaxChars: 600 });
  for (const key of ['userId', 'snapshotId', 'deviceId', 'jobId']) page[key] = example[key];
  writeFileSync(new URL('../examples/collection-page-v1.json', import.meta.url), JSON.stringify(collectionPageSchema.parse(page), null, 2) + '\n');
  const profile = store.profilePage(credentials.userId, { offset: 0, limit: 10, summaryMaxChars: 600 });
  for (const key of ['userId', 'snapshotId']) profile[key] = example[key];
  writeFileSync(new URL('../examples/knowledge-profile-v1.json', import.meta.url), JSON.stringify(knowledgeProfileSchema.parse(profile), null, 2) + '\n');
  writeFileSync(new URL('../examples/output-format.json', import.meta.url), JSON.stringify(store.outputFormat(), null, 2) + '\n');
} finally { store.close(); for (const name of readdirSync(temporary)) unlinkSync(join(temporary, name)); rmdirSync(temporary); }
