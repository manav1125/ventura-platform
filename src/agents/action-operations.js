import { createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/migrate.js';

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  const entries = Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(',')}}`;
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hashPayload(payload) {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function hydrateOperation(row) {
  if (!row) return null;
  return {
    ...row,
    payload: parseJson(row.payload, {}),
    result: parseJson(row.result, null)
  };
}

export function buildOperationKey({ actionType, businessId, taskId = null, approvalId = null, payload = {} }) {
  if (approvalId) return `approval:${approvalId}:${actionType}`;
  if (taskId) return `task:${taskId}:${actionType}:${hashPayload(payload)}`;
  return `business:${businessId}:${actionType}:${hashPayload(payload)}`;
}

export function getOperationByKey(key) {
  const db = getDb();
  return hydrateOperation(db.prepare(`
    SELECT *
    FROM action_operations
    WHERE idempotency_key = ?
  `).get(key));
}

export function listActionOperations(businessId, limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT *
    FROM action_operations
    WHERE business_id = ?
    ORDER BY COALESCE(executed_at, updated_at, created_at) DESC
    LIMIT ?
  `).all(businessId, limit).map(hydrateOperation);
}

export function getActionOperationSummary(businessId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count, SUM(replay_count) AS replays
    FROM action_operations
    WHERE business_id = ?
    GROUP BY status
  `).all(businessId);

  const summary = {
    total: 0,
    succeeded: 0,
    failed: 0,
    running: 0,
    blocked: 0,
    replayed: 0
  };

  for (const row of rows) {
    summary.total += Number(row.count || 0);
    summary[row.status] = Number(row.count || 0);
    summary.replayed += Number(row.replays || 0);
  }

  return summary;
}

export async function runGuardedOperation({
  businessId,
  actionType,
  summary,
  payload = {},
  taskId = null,
  approvalId = null,
  execute
}) {
  const db = getDb();
  const idempotencyKey = buildOperationKey({ actionType, businessId, taskId, approvalId, payload });
  const existing = getOperationByKey(idempotencyKey);

  if (existing?.status === 'succeeded') {
    db.prepare(`
      UPDATE action_operations
      SET replay_count = replay_count + 1,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(existing.id);
    return {
      operation: getOperationByKey(idempotencyKey),
      result: existing.result,
      replayed: true
    };
  }

  if (existing?.status === 'running') {
    db.prepare(`
      UPDATE action_operations
      SET replay_count = replay_count + 1,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(existing.id);
    return {
      operation: getOperationByKey(idempotencyKey),
      result: existing.result,
      replayed: true,
      in_progress: true
    };
  }

  if (existing) {
    db.prepare(`
      UPDATE action_operations
      SET status = 'running',
          summary = ?,
          payload = ?,
          task_id = COALESCE(?, task_id),
          approval_id = COALESCE(?, approval_id),
          error = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(summary || existing.summary, JSON.stringify(payload), taskId, approvalId, existing.id);
  } else {
    db.prepare(`
      INSERT INTO action_operations (
        id, business_id, task_id, approval_id, action_type, idempotency_key, summary, payload, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')
    `).run(
      uuid(),
      businessId,
      taskId,
      approvalId,
      actionType,
      idempotencyKey,
      summary || null,
      JSON.stringify(payload)
    );
  }

  const running = getOperationByKey(idempotencyKey);

  try {
    const result = await execute();
    db.prepare(`
      UPDATE action_operations
      SET status = 'succeeded',
          result = ?,
          executed_at = datetime('now'),
          updated_at = datetime('now'),
          error = NULL
      WHERE idempotency_key = ?
    `).run(JSON.stringify(result || {}), idempotencyKey);

    return {
      operation: getOperationByKey(idempotencyKey),
      result,
      replayed: false
    };
  } catch (err) {
    db.prepare(`
      UPDATE action_operations
      SET status = 'failed',
          error = ?,
          updated_at = datetime('now')
      WHERE idempotency_key = ?
    `).run(err.message, idempotencyKey);
    throw Object.assign(err, { operation: getOperationByKey(idempotencyKey) || running });
  }
}
