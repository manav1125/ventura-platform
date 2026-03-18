import { v4 as uuid } from 'uuid';
import { getDb } from '../db/migrate.js';
import { emitToBusiness } from '../ws/websocket.js';

function hydrateEvent(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: safeParse(row.metadata, {})
  };
}

function safeParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function logTaskEvent({
  businessId,
  taskId,
  cycleId = null,
  phase,
  title,
  detail = '',
  metadata = {}
}) {
  const db = getDb();
  const id = uuid();
  db.prepare(`
    INSERT INTO task_events (
      id, business_id, task_id, cycle_id, phase, title, detail, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    id,
    businessId,
    taskId,
    cycleId,
    phase,
    title,
    detail || null,
    JSON.stringify(metadata || {})
  );

  const event = hydrateEvent(db.prepare('SELECT * FROM task_events WHERE id = ?').get(id));
  emitToBusiness(businessId, { event: 'task:event', taskEvent: event });
  return event;
}

export function listTaskEvents(businessId, { taskId = null, cycleId = null, limit = 100 } = {}) {
  const db = getDb();
  const filters = ['business_id = ?'];
  const values = [businessId];

  if (taskId) {
    filters.push('task_id = ?');
    values.push(taskId);
  }
  if (cycleId) {
    filters.push('cycle_id = ?');
    values.push(cycleId);
  }

  values.push(limit);
  return db.prepare(`
    SELECT *
    FROM task_events
    WHERE ${filters.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...values).map(hydrateEvent);
}
