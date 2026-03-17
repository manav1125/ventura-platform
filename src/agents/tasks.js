// src/agents/tasks.js
// Task queue: create, fetch, update, complete tasks

import { v4 as uuid } from 'uuid';
import { getDb } from '../db/migrate.js';
import { emitToBusiness } from '../ws/websocket.js';
import {
  composeTaskBrief,
  getWorkflowState,
  hydrateTask,
  normalizeWorkflowKey
} from './execution-intelligence.js';

export async function queueTask({
  businessId,
  business = null,
  title,
  description,
  department,
  workflowKey = null,
  triggeredBy = 'user',
  priority = 5,
  cycleId = null
}) {
  const db = getDb();
  const id = uuid();
  const normalizedWorkflowKey = normalizeWorkflowKey(workflowKey, department);
  const workflowState = business ? getWorkflowState(businessId, normalizedWorkflowKey) : null;
  const brief = business ? composeTaskBrief({
    business,
    title,
    description,
    department,
    workflowKey: normalizedWorkflowKey,
    workflowState
  }) : null;

  db.prepare(`
    INSERT INTO tasks (
      id, business_id, cycle_id, title, description, department, workflow_key, brief_json, status, triggered_by, priority
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
  `).run(
    id,
    businessId,
    cycleId,
    title,
    description || null,
    department,
    normalizedWorkflowKey,
    brief ? JSON.stringify(brief) : null,
    triggeredBy,
    priority
  );

  emitToBusiness(businessId, {
    event: 'task:queued',
    task: { id, title, department, workflow_key: normalizedWorkflowKey, brief, status: 'queued', priority }
  });

  return id;
}

export function getQueuedTasks(businessId, limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM tasks
    WHERE business_id = ? AND status = 'queued'
    ORDER BY priority ASC, created_at ASC
    LIMIT ?
  `).all(businessId, limit).map(hydrateTask);
}

export function getAllTasks(businessId, limit = 50) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM tasks
    WHERE business_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(businessId, limit).map(hydrateTask);
}

export function startTask(taskId, cycleId) {
  const db = getDb();
  const started_at = new Date().toISOString();
  db.prepare(`
    UPDATE tasks SET status='running', started_at=?, cycle_id=? WHERE id=?
  `).run(started_at, cycleId, taskId);

  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  if (task) emitToBusiness(task.business_id, { event: 'task:started', taskId, title: task.title });
}

export function completeTask(taskId, result) {
  const db = getDb();
  const completed_at = new Date().toISOString();
  db.prepare(`
    UPDATE tasks SET status='complete', result=?, completed_at=? WHERE id=?
  `).run(JSON.stringify(result || {}), completed_at, taskId);

  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  if (task) emitToBusiness(task.business_id, {
    event: 'task:complete',
    taskId,
    title: task.title,
    department: task.department,
    result
  });
}

export function failTask(taskId, error) {
  const db = getDb();
  db.prepare(`UPDATE tasks SET status='failed', error=? WHERE id=?`).run(error, taskId);
}
