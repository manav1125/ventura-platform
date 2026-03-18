// src/agents/tasks.js
// Task queue: create, fetch, update, complete tasks

import { v4 as uuid } from 'uuid';
import { getDb } from '../db/migrate.js';
import { emitToBusiness } from '../ws/websocket.js';
import { logActivity } from './activity.js';
import {
  composeTaskBrief,
  getWorkflowState,
  hydrateTask,
  normalizeWorkflowKey
} from './execution-intelligence.js';
import { logTaskEvent } from './task-events.js';

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
  logTaskEvent({
    businessId,
    taskId: id,
    cycleId,
    phase: 'queued',
    title: `Task queued: ${title}`,
    detail: description || `Queued in ${department}`,
    metadata: {
      department,
      workflow_key: normalizedWorkflowKey,
      priority,
      triggered_by: triggeredBy
    }
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
  if (task) {
    emitToBusiness(task.business_id, { event: 'task:started', taskId, title: task.title });
    logTaskEvent({
      businessId: task.business_id,
      taskId,
      cycleId,
      phase: 'started',
      title: `Started ${task.title}`,
      detail: `Ventura is working on this ${task.department} task now.`,
      metadata: {
        department: task.department,
        workflow_key: task.workflow_key || null
      }
    });
  }
}

export function completeTask(taskId, result) {
  const db = getDb();
  const completed_at = new Date().toISOString();
  db.prepare(`
    UPDATE tasks SET status='complete', result=?, completed_at=? WHERE id=?
  `).run(JSON.stringify(result || {}), completed_at, taskId);

  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  if (task) {
    db.prepare(`
      INSERT INTO metrics (id, business_id, date, tasks_done)
      VALUES (?, ?, date('now'), 1)
      ON CONFLICT(business_id, date) DO UPDATE SET tasks_done = tasks_done + 1
    `).run(`task-metric-${Date.now()}`, task.business_id);

    emitToBusiness(task.business_id, {
      event: 'task:complete',
      taskId,
      title: task.title,
      department: task.department,
      result
    });
    logTaskEvent({
      businessId: task.business_id,
      taskId,
      cycleId: task.cycle_id,
      phase: 'completed',
      title: `Completed ${task.title}`,
      detail: result?.summary || 'Task finished successfully.',
      metadata: {
        department: task.department,
        next_steps: result?.nextSteps || result?.next_steps || []
      }
    });
    logActivity(task.business_id, {
      type: 'task_complete',
      department: task.department,
      title: task.title,
      detail: {
        summary: result?.summary || null,
        taskId
      }
    }).catch(() => {});
  }
}

export function failTask(taskId, error) {
  const db = getDb();
  db.prepare(`UPDATE tasks SET status='failed', error=? WHERE id=?`).run(error, taskId);
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  if (task) {
    logTaskEvent({
      businessId: task.business_id,
      taskId,
      cycleId: task.cycle_id,
      phase: 'failed',
      title: `Failed ${task.title}`,
      detail: error,
      metadata: {
        department: task.department
      }
    });
    logActivity(task.business_id, {
      type: 'alert',
      department: task.department,
      title: `Task failed: ${task.title}`,
      detail: { error, taskId }
    }).catch(() => {});
  }
}
