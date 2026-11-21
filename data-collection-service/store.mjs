import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defaultSettings, parseSettings, validateSnapshot } from './contracts.mjs';
import { ServiceError } from './errors.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const nonce = () => randomBytes(32).toString('base64url');
const deny = (code, message, status = 409) => { throw new ServiceError(code, message, status); };

export function createServiceStore(filename, { demo = false, now = Date.now, clientLeaseMs = 90_000, workerLeaseMs = 45_000 } = {}) {
  const path = resolve(filename); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); closeSync(openSync(path, 'a', 0o600));
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS service_users (id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, settings TEXT NOT NULL, account_ref TEXT);
    CREATE TABLE IF NOT EXISTS service_devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES service_users(id), label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, last_seen INTEGER);
    CREATE TABLE IF NOT EXISTS service_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES service_users(id), requested_device TEXT, claimed_device TEXT,
      state TEXT NOT NULL, settings TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, client_until INTEGER NOT NULL,
      lease_hash TEXT, worker_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT, error_message TEXT, snapshot_id TEXT, delivery_hash TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON service_jobs(user_id) WHERE state IN ('queued','running');
    CREATE TABLE IF NOT EXISTS service_snapshots (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES service_users(id), device_id TEXT NOT NULL,
      job_id TEXT NOT NULL UNIQUE, received_at INTEGER NOT NULL, account_ref TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS snapshots_by_user ON service_snapshots(user_id,received_at);`);
  const q = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const iso = (value) => value == null ? null : new Date(value).toISOString();
  const atomic = (action) => { db.exec('BEGIN IMMEDIATE'); try { const result = action(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  function publicJob(row) {
    return row && { id: row.id, state: row.state, deviceId: row.claimed_device || row.requested_device || null, settings: JSON.parse(row.settings), attempts: row.attempts,
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), clientLeaseExpiresAt: iso(row.client_until), workerLeaseExpiresAt: iso(row.worker_until),
      snapshotId: row.snapshot_id || null, error: row.error_code ? { code: row.error_code, message: row.error_message } : null };
  }
  function ownedJob(userId, id) { const row = q('SELECT * FROM service_jobs WHERE user_id=? AND id=?', userId, id); if (!row) deny('NOT_FOUND', '任务不存在。', 404); return row; }
  function sweep() {
    run("UPDATE service_jobs SET state='cancelled', error_code='CLIENT_OFFLINE', error_message='调用方未续期，采集已停止。', updated_at=? WHERE state IN ('queued','running') AND client_until<=?", now(), now());
    run("UPDATE service_jobs SET state=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END, claimed_device=NULL, lease_hash=NULL, worker_until=NULL, error_code='WORKER_OFFLINE', error_message='采集设备连接失效。', updated_at=? WHERE state='running' AND worker_until<=?", now(), now());
  }
  function activeLease(device, id, leaseToken) {
    const row = ownedJob(device.userId, id);
    if (row.state !== 'running' || row.claimed_device !== device.deviceId || row.lease_hash !== hash(leaseToken) || row.worker_until <= now() || row.client_until <= now()) deny('LEASE_EXPIRED', '任务已取消、转交或租约失效。');
    return row;
  }
  function snapshot(userId, id) {
    const row = id ? q('SELECT * FROM service_snapshots WHERE user_id=? AND id=?', userId, id)
      : q('SELECT * FROM service_snapshots WHERE user_id=? ORDER BY received_at DESC,rowid DESC LIMIT 1', userId);
    if (!row) deny('NOT_FOUND', '尚无对应采集结果。', 404);
    return { schemaVersion: 1, module: 'data-collection-service', kind: 'collection_snapshot', userId, snapshotId: row.id, deviceId: row.device_id,
      jobId: row.job_id, receivedAt: iso(row.received_at), snapshot: JSON.parse(row.payload) };
  }
  return {
    demo, clientLeaseMs, workerLeaseMs,
    provision(label, deviceLabel = 'desktop', deliver = (value) => value) {
      if (typeof label !== 'string' || !label.trim() || label.length > 80 || typeof deviceLabel !== 'string' || !deviceLabel.trim() || deviceLabel.length > 80) deny('INVALID_ARGUMENTS', '用户和设备名称需为 1 至 80 个字符。', 400);
      return atomic(() => {
        const userId = randomUUID(), deviceId = randomUUID(), userToken = `usr_${nonce()}`, deviceToken = `dev_${nonce()}`;
        run('INSERT INTO service_users VALUES (?,?,?,?,NULL)', userId, label, hash(userToken), JSON.stringify(defaultSettings));
        run('INSERT INTO service_devices VALUES (?,?,?,?,NULL)', deviceId, userId, deviceLabel, hash(deviceToken));
        return deliver({ userId, deviceId, userToken, deviceToken, demo });
      });
    },
    addDevice(userId, label, deliver = (value) => value) {
      if (!q('SELECT id FROM service_users WHERE id=?', userId)) deny('NOT_FOUND', '应用用户不存在。', 404);
      if (typeof label !== 'string' || !label.trim() || label.length > 80) deny('INVALID_ARGUMENTS', '设备名称需为 1 至 80 个字符。', 400);
      return atomic(() => { const deviceId = randomUUID(), deviceToken = `dev_${nonce()}`;
        run('INSERT INTO service_devices VALUES (?,?,?,?,NULL)', deviceId, userId, label, hash(deviceToken)); return deliver({ userId, deviceId, deviceToken, demo }); });
    },
    revokeDevice(userId, deviceId) {
      return atomic(() => {
        if (!q('SELECT id FROM service_devices WHERE user_id=? AND id=?', userId, deviceId)) deny('NOT_FOUND', '设备不存在。', 404);
        run("UPDATE service_jobs SET state='cancelled',error_code='DEVICE_REVOKED',error_message='设备凭证已撤回。',updated_at=? WHERE user_id=? AND state IN ('queued','running') AND (claimed_device=? OR requested_device=?)", now(), userId, deviceId, deviceId);
        run('DELETE FROM service_devices WHERE user_id=? AND id=?', userId, deviceId); return { userId, deviceId, revoked: true };
      });
    },
    rotateUserToken(userId, deliver = (value) => value) {
      if (!q('SELECT id FROM service_users WHERE id=?', userId)) deny('NOT_FOUND', '应用用户不存在。', 404);
      const userToken = `usr_${nonce()}`;
      return atomic(() => { run('UPDATE service_users SET token_hash=? WHERE id=?', hash(userToken), userId);
        run("UPDATE service_jobs SET state='cancelled',error_code='TOKEN_ROTATED',error_message='调用凭证已更换。',updated_at=? WHERE user_id=? AND state IN ('queued','running')", now(), userId);
        return deliver({ userId, userToken, demo }); });
    },
    authenticate(token, role) {
      if (typeof token !== 'string' || !new RegExp(`^${role === 'user' ? 'usr' : 'dev'}_[A-Za-z0-9_-]{43}$`).test(token)) deny('UNAUTHORIZED', '缺少有效的应用凭证。', 401);
      if (role === 'user') { const row = q('SELECT id FROM service_users WHERE token_hash=?', hash(token)); if (row) return { userId: row.id, role }; }
      else { const row = q('SELECT id,user_id FROM service_devices WHERE token_hash=?', hash(token)); if (row) { run('UPDATE service_devices SET last_seen=? WHERE id=?', now(), row.id); return { userId: row.user_id, deviceId: row.id, role }; } }
      deny('UNAUTHORIZED', '应用凭证无效或已撤销。', 401);
    },
    settings(userId, value) {
      const user = q('SELECT settings FROM service_users WHERE id=?', userId); if (!user) deny('NOT_FOUND', '应用用户不存在。', 404);
      if (value !== undefined) { const settings = parseSettings(value); run('UPDATE service_users SET settings=? WHERE id=?', JSON.stringify(settings), userId); return settings; }
      return JSON.parse(user.settings);
    },
    status(userId) {
      sweep(); const user = q('SELECT label,account_ref FROM service_users WHERE id=?', userId);
      const latest = q('SELECT id,received_at FROM service_snapshots WHERE user_id=? ORDER BY received_at DESC,rowid DESC LIMIT 1', userId);
      return { userId, label: user.label, demo, accountBound: Boolean(user.account_ref), settings: this.settings(userId),
        devices: all('SELECT id,label,last_seen FROM service_devices WHERE user_id=?', userId).map((row) => ({ id: row.id, label: row.label, lastSeenAt: iso(row.last_seen), online: row.last_seen != null && row.last_seen > now() - 45_000 })),
        activeJob: publicJob(q("SELECT * FROM service_jobs WHERE user_id=? AND state IN ('queued','running')", userId)),
        latestSnapshot: latest ? { snapshotId: latest.id, receivedAt: iso(latest.received_at) } : null };
    },
    createJob(userId, { settings, deviceId } = {}) {
      return atomic(() => {
        sweep(); if (q("SELECT id FROM service_jobs WHERE user_id=? AND state IN ('queued','running')", userId)) deny('BUSY', '已有采集任务，请等待或取消。');
        if (deviceId && !q('SELECT id FROM service_devices WHERE user_id=? AND id=?', userId, deviceId)) deny('NOT_FOUND', '设备不存在。', 404);
        const selected = parseSettings(settings || this.settings(userId)), id = randomUUID();
        run("INSERT INTO service_jobs(id,user_id,requested_device,state,settings,created_at,updated_at,client_until) VALUES (?,?,?,'queued',?,?,?,?)", id, userId, deviceId || null, JSON.stringify(selected), now(), now(), now() + clientLeaseMs);
        return publicJob(ownedJob(userId, id));
      });
    },
    job(userId, id) { sweep(); return publicJob(ownedJob(userId, id)); },
    keepalive(userId, id) { sweep(); const row = ownedJob(userId, id); if (['queued', 'running'].includes(row.state)) run('UPDATE service_jobs SET client_until=?,updated_at=? WHERE id=?', now() + clientLeaseMs, now(), id); return this.job(userId, id); },
    cancel(userId, id) { ownedJob(userId, id); run("UPDATE service_jobs SET state='cancelled',error_code='CANCELLED',error_message='调用方取消了任务。',updated_at=? WHERE id=? AND state IN ('queued','running')", now(), id); return this.job(userId, id); },
    claim(device) {
      return atomic(() => {
        sweep(); const row = q("SELECT * FROM service_jobs WHERE user_id=? AND state='queued' AND (requested_device IS NULL OR requested_device=?) ORDER BY created_at,rowid LIMIT 1", device.userId, device.deviceId);
        if (!row) return null;
        const leaseToken = nonce();
        run("UPDATE service_jobs SET state='running',claimed_device=?,lease_hash=?,worker_until=?,updated_at=?,attempts=attempts+1,error_code=NULL,error_message=NULL WHERE id=?", device.deviceId, hash(leaseToken), now() + workerLeaseMs, now(), row.id);
        return { job: publicJob(ownedJob(device.userId, row.id)), leaseToken, heartbeatSeconds: Math.max(1, Math.floor(workerLeaseMs / 3000)) };
      });
    },
    heartbeat(device, id, token) { sweep(); const row = ownedJob(device.userId, id);
      // 成功交付与最后一次心跳可能交错，确认相同租约即可返回终态，不复活任务。
      if (row.state === 'succeeded' && row.claimed_device === device.deviceId && row.lease_hash === hash(token)) return publicJob(row);
      activeLease(device, id, token); run('UPDATE service_jobs SET worker_until=?,updated_at=? WHERE id=?', now() + workerLeaseMs, now(), id); return this.job(device.userId, id); },
    complete(device, id, { leaseToken, accountRef, snapshot: input }) {
      const row = ownedJob(device.userId, id), value = validateSnapshot(input, JSON.parse(row.settings), demo);
      const digest = hash(JSON.stringify({ accountRef, snapshot: value }));
      return atomic(() => {
        sweep(); const current = ownedJob(device.userId, id);
        if (current.state === 'succeeded' && current.claimed_device === device.deviceId && current.lease_hash === hash(leaseToken) && current.delivery_hash === digest) return snapshot(device.userId, current.snapshot_id);
        activeLease(device, id, leaseToken);
        const user = q('SELECT account_ref FROM service_users WHERE id=?', device.userId);
        if (user.account_ref && user.account_ref !== accountRef) deny('ACCOUNT_MISMATCH', '该应用用户已绑定其他知乎账号，结果未保存。');
        const snapshotId = randomUUID();
        run('INSERT INTO service_snapshots VALUES (?,?,?,?,?,?,?)', snapshotId, device.userId, device.deviceId, id, now(), accountRef, JSON.stringify(value));
        run('UPDATE service_users SET account_ref=? WHERE id=?', accountRef, device.userId);
        run("UPDATE service_jobs SET state='succeeded',snapshot_id=?,delivery_hash=?,worker_until=NULL,updated_at=? WHERE id=?", snapshotId, digest, now(), id);
        return snapshot(device.userId, snapshotId);
      });
    },
    fail(device, id, leaseToken, code) { sweep(); activeLease(device, id, leaseToken); const known = {
      CONSENT_REQUIRED: '本机尚未同意采集。', CONSENT_SCOPE_MISMATCH: '本机没有允许本次请求的类别或过滤范围。', LOGIN_REQUIRED: '本机知乎登录已失效，请本人重新登录。',
      ACCOUNT_MISMATCH: '本机账号与登记授权不一致。', COLLECTION_FAILED: '本机采集失败，请检查设备、登录状态或平台验证。' };
      const chosen = Object.hasOwn(known, code) ? code : 'COLLECTION_FAILED';
      run("UPDATE service_jobs SET state='failed',error_code=?,error_message=?,worker_until=NULL,updated_at=? WHERE id=?", chosen, known[chosen], now(), id);
      return this.job(device.userId, id);
    },
    snapshot,
    page(userId, { snapshotId, offset, limit, summaryMaxChars }) {
      const value = snapshot(userId, snapshotId); const { records, excluded, ...metadata } = value.snapshot;
      const items = records.slice(offset, offset + limit).map((record) => {
        const summary = [...record.summary];
        return { key: record.key, contentId: record.contentId, contentType: record.contentType, title: [...record.title].slice(0, 300).join(''),
          summary: summary.slice(0, summaryMaxChars).join(''), summaryTruncated: summary.length > summaryMaxChars, url: record.url,
          author: [...(record.author || '')].slice(0, 120).join(''), kinds: record.kinds || [record.kind], observedAt: record.observedAt,
          sourceReadTime: record.sourceReadTime, signals: record.signals, topics: (record.topics || []).slice(0, 20).map((topic) => ({ ...topic, name: [...topic.name].slice(0, 80).join('') })),
          voteCount: record.voteCount, commentCount: record.commentCount, metricsMissing: record.metricsMissing,
          weight: record.weight, weightDetails: record.weightDetails, bodyStatus: record.bodyStatus || 'unavailable',
          ruleDecision: record.analysis?.decision, contentTrust: 'external_untrusted' };
      });
      const hasMore = offset + items.length < records.length;
      return { schemaVersion: 1, module: 'data-collection-service', kind: 'collection_page', userId, snapshotId: value.snapshotId,
        deviceId: value.deviceId, jobId: value.jobId, receivedAt: value.receivedAt, metadata, excludedCount: excluded.length,
        page: { offset, limit, total: records.length, returned: items.length, hasMore, nextOffset: hasMore ? offset + items.length : null }, items };
    },
    clear(userId) { return atomic(() => { run("UPDATE service_jobs SET state='cancelled',error_code='DATA_CLEARED',error_message='用户清除了数据。',updated_at=? WHERE user_id=? AND state IN ('queued','running')", now(), userId);
      run('DELETE FROM service_snapshots WHERE user_id=?', userId); run('UPDATE service_users SET account_ref=NULL WHERE id=?', userId); return { cleared: true }; }); },
    sweep,
    close() { db.close(); },
  };
}
