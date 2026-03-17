import { v4 as uuid } from 'uuid';
import { getDb } from '../db/migrate.js';
import { queueTask } from './tasks.js';
import { logActivity } from './activity.js';
import { getIntegration } from '../integrations/registry.js';
import { getWorkspaceSnapshot } from '../integrations/workspace-sync.js';

const DEFAULT_POLICIES = {
  inbox: {
    enabled: true,
    max_items: 2
  },
  calendar: {
    enabled: true,
    prep_window_hours: 36,
    max_items: 2
  },
  accounting: {
    enabled: true,
    max_items: 2
  }
};

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clampPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeExternalId(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workspace-item';
}

function timestampMs(value) {
  const ts = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(ts) ? ts : null;
}

function buildFingerprint(record) {
  return JSON.stringify({
    status: record.status || null,
    summary: record.summary || null,
    occurred_at: record.occurred_at || null,
    starts_at: record.payload?.starts_at || null,
    amount_cents: record.metadata?.amount_cents || record.payload?.amount_cents || 0
  });
}

function getKindPolicy(businessId, kind) {
  const defaults = DEFAULT_POLICIES[kind] || { enabled: true, max_items: 2 };
  const integration = getIntegration(businessId, kind);
  const config = integration?.config || {};

  return {
    enabled: config.automation_enabled !== false,
    max_items: clampPositiveInt(config.automation_max_items || config.automationMaxItems, defaults.max_items),
    prep_window_hours: clampPositiveInt(config.prep_window_hours || config.prepWindowHours, defaults.prep_window_hours || 36)
  };
}

function getWorkspacePolicies(businessId) {
  return {
    inbox: getKindPolicy(businessId, 'inbox'),
    calendar: getKindPolicy(businessId, 'calendar'),
    accounting: getKindPolicy(businessId, 'accounting')
  };
}

function listRecentActions(businessId, limit = 20, status = null) {
  const db = getDb();
  const rows = status
    ? db.prepare(`
        SELECT *
        FROM workspace_automation_actions
        WHERE business_id = ? AND status = ?
        ORDER BY datetime(updated_at) DESC
        LIMIT ?
      `).all(businessId, status, limit)
    : db.prepare(`
        SELECT *
        FROM workspace_automation_actions
        WHERE business_id = ?
        ORDER BY datetime(updated_at) DESC
        LIMIT ?
      `).all(businessId, limit);

  return rows.map(row => ({
    ...row
  }));
}

export function listWorkspaceAutomationRuns(businessId, limit = 12) {
  const db = getDb();
  return db.prepare(`
    SELECT *
    FROM workspace_automation_runs
    WHERE business_id = ?
    ORDER BY datetime(COALESCE(completed_at, created_at)) DESC
    LIMIT ?
  `).all(businessId, limit);
}

export function listWorkspaceAutomationActions(businessId, { limit = 20, status = null } = {}) {
  return listRecentActions(businessId, limit, status);
}

export function getWorkspaceAutomationSnapshot(businessId) {
  const actions = listWorkspaceAutomationActions(businessId, { limit: 20 });
  const runs = listWorkspaceAutomationRuns(businessId, 12);
  const policies = getWorkspacePolicies(businessId);

  return {
    summary: {
      open_actions: actions.filter(item => item.status === 'open').length,
      retry_actions: actions.filter(item => item.status === 'needs_retry').length,
      closed_actions: actions.filter(item => item.status === 'closed').length,
      last_run_at: runs[0]?.completed_at || runs[0]?.created_at || null
    },
    policies,
    actions,
    runs
  };
}

function startAutomationRun({ businessId, triggeredBy }) {
  const db = getDb();
  const id = uuid();
  db.prepare(`
    INSERT INTO workspace_automation_runs (
      id, business_id, triggered_by, status, created_at
    ) VALUES (?, ?, ?, 'running', datetime('now'))
  `).run(id, businessId, triggeredBy);
  return id;
}

function finishAutomationRun(id, { status = 'complete', summary = '', itemsReviewed = 0, tasksCreated = 0, error = null }) {
  const db = getDb();
  db.prepare(`
    UPDATE workspace_automation_runs
    SET status = ?,
        summary = ?,
        items_reviewed = ?,
        tasks_created = ?,
        error = ?,
        completed_at = datetime('now')
    WHERE id = ?
  `).run(status, summary || null, itemsReviewed, tasksCreated, error, id);
}

function findAction(businessId, kind, externalId, actionKey) {
  const db = getDb();
  return db.prepare(`
    SELECT *
    FROM workspace_automation_actions
    WHERE business_id = ? AND kind = ? AND external_id = ? AND action_key = ?
  `).get(businessId, kind, externalId, actionKey);
}

function getTaskStatus(taskId) {
  if (!taskId) return null;
  const db = getDb();
  return db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId)?.status || null;
}

function upsertAction({
  businessId,
  kind,
  externalId,
  actionKey,
  title,
  summary,
  department,
  workflowKey,
  sourceStatus,
  sourceFingerprint,
  taskId,
  status = 'open'
}) {
  const db = getDb();
  const existing = findAction(businessId, kind, externalId, actionKey);
  if (existing) {
    db.prepare(`
      UPDATE workspace_automation_actions
      SET title = ?,
          summary = ?,
          department = ?,
          workflow_key = ?,
          source_status = ?,
          source_fingerprint = ?,
          task_id = ?,
          status = ?,
          completed_at = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      title,
      summary || null,
      department,
      workflowKey,
      sourceStatus || null,
      sourceFingerprint,
      taskId || existing.task_id || null,
      status,
      status === 'closed' ? new Date().toISOString() : null,
      existing.id
    );
    return existing.id;
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO workspace_automation_actions (
      id, business_id, kind, external_id, action_key, title, summary, department, workflow_key,
      source_status, source_fingerprint, task_id, status, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
  `).run(
    id,
    businessId,
    kind,
    externalId,
    actionKey,
    title,
    summary || null,
    department,
    workflowKey,
    sourceStatus || null,
    sourceFingerprint,
    taskId || null,
    status,
    status === 'closed' ? new Date().toISOString() : null
  );
  return id;
}

function buildInboxAction(record, business) {
  const source = cleanString(record.metadata?.source || record.payload?.thread_state).toLowerCase();
  const mapping = source.includes('investor')
    ? {
        actionKey: 'investor-reply',
        department: 'strategy',
        priority: 4,
        prefix: 'Reply to investor thread',
        objective: 'stabilize the relationship, answer the request clearly, and surface any founder-sensitive risk immediately.'
      }
    : source.includes('lead') || source.includes('prospect') || source.includes('sales')
      ? {
          actionKey: 'lead-follow-up',
          department: 'sales',
          priority: 4,
          prefix: 'Reply to high-intent lead',
          objective: 'move the buyer toward a demo, trial, or close while capturing any objections for the founder.'
        }
      : source.includes('customer')
        ? {
            actionKey: 'customer-follow-up',
            department: 'operations',
            priority: 3,
            prefix: 'Resolve customer inbox thread',
            objective: 'unblock the customer, preserve trust, and decide whether the founder needs to step in.'
          }
        : {
            actionKey: 'reply',
            department: 'operations',
            priority: 2,
            prefix: 'Reply to inbox thread',
            objective: 'send the highest leverage reply, resolve the blocker, and update the founder on any risk or follow-up.'
          };

  return {
    actionKey: mapping.actionKey,
    department: mapping.department,
    priority: mapping.priority,
    workflowKey: `workspace.inbox.${normalizeExternalId(record.external_id || record.id)}.${mapping.actionKey}`,
    title: `${mapping.prefix}: ${record.title}`,
    description: [
      `Source thread: ${record.title}`,
      record.summary,
      `Business: ${business.name}`,
      `Current thread state: ${record.payload?.thread_state || record.status || 'open'}`,
      `Objective: ${mapping.objective}`
    ].filter(Boolean).join('\n\n')
  };
}

function buildCalendarAction(record, business) {
  const meetingType = cleanString(record.metadata?.type) || 'meeting';
  const startsAt = timestampMs(record.payload?.starts_at || record.occurred_at);
  const endsAt = timestampMs(record.payload?.ends_at) || startsAt;
  const now = Date.now();
  const completedRecently = endsAt && endsAt <= now && endsAt >= now - (8 * 60 * 60 * 1000);
  const mapping = meetingType === 'sales_demo'
    ? (completedRecently
      ? {
          department: 'sales',
          actionKey: 'demo-follow-up',
          prefix: 'Send demo follow-up',
          objective: 'capture next steps, draft the follow-up sequence, and push the opportunity forward while the context is fresh.'
        }
      : {
          department: 'sales',
          actionKey: 'demo-brief',
          prefix: 'Prepare for sales demo',
          objective: 'gather account context, objections, and the best path to a strong live demo.'
        })
    : meetingType === 'launch'
      ? (completedRecently
        ? {
            department: 'engineering',
            actionKey: 'launch-retro',
            prefix: 'Review launch outcome',
            objective: 'capture launch results, remaining incidents, and the follow-up backlog.'
          }
        : {
            department: 'engineering',
            actionKey: 'launch-prep',
            prefix: 'Prepare launch checklist',
            objective: 'gather dependencies, release risks, and the exact checklist before the launch window begins.'
          })
      : (completedRecently
        ? {
            department: 'strategy',
            actionKey: 'meeting-follow-up',
            prefix: 'Capture founder follow-up',
            objective: 'turn the meeting into concrete actions, owner assignments, and any founder notes that should persist.'
          }
        : {
            department: 'strategy',
            actionKey: 'meeting-brief',
            prefix: 'Prepare founder brief',
            objective: 'gather context, identify prep work, and leave the founder with a concise execution brief.'
          });

  return {
    actionKey: mapping.actionKey,
    department: mapping.department,
    priority: completedRecently ? 4 : 3,
    workflowKey: `workspace.calendar.${normalizeExternalId(record.external_id || record.id)}.${mapping.actionKey}`,
    title: `${mapping.prefix}: ${record.title}`,
    description: [
      `Calendar item: ${record.title}`,
      record.summary,
      `Business: ${business.name}`,
      `Starts at: ${record.payload?.starts_at || record.occurred_at || 'scheduled soon'}`,
      record.payload?.ends_at ? `Ends at: ${record.payload.ends_at}` : null,
      `Objective: ${mapping.objective}`
    ].filter(Boolean).join('\n\n')
  };
}

function buildAccountingAction(record, business) {
  const amount = Number(record.metadata?.amount_cents || record.payload?.amount_cents || 0);
  const direction = cleanString(record.payload?.direction).toLowerCase();
  const category = cleanString(record.metadata?.category).toLowerCase();
  const mapping = direction === 'expense'
    ? {
        actionKey: 'expense-review',
        prefix: 'Review expense outflow',
        objective: 'confirm the expense is legitimate, categorize it correctly, and flag anything that threatens runway.'
      }
    : amount >= 100000
      ? {
          actionKey: 'large-payment-review',
          prefix: 'Review large incoming payment',
          objective: 'verify the transaction, route any follow-up, and update the founder on the revenue impact.'
        }
      : category === 'revenue_share'
        ? {
            actionKey: 'revenue-share-check',
            prefix: 'Confirm revenue share accrual',
            objective: 'verify the platform share math and confirm the founder-facing revenue picture stays accurate.'
          }
        : {
            actionKey: 'reconcile',
            prefix: 'Reconcile ledger item',
            objective: 'reconcile the entry, determine whether founder review is required, and update the revenue picture.'
          };
  return {
    actionKey: mapping.actionKey,
    department: 'finance',
    priority: amount >= 100000 ? 4 : 2,
    workflowKey: `workspace.accounting.${normalizeExternalId(record.external_id || record.id)}.${mapping.actionKey}`,
    title: `${mapping.prefix}: ${record.title}`,
    description: [
      `Ledger item: ${record.title}`,
      record.summary,
      amount ? `Amount: ${(amount / 100).toFixed(2)} ${(record.metadata?.currency || 'usd').toUpperCase()}` : null,
      `Business: ${business.name}`,
      `Direction: ${direction || 'unknown'}`,
      `Objective: ${mapping.objective}`
    ].filter(Boolean).join('\n\n')
  };
}

function selectCandidates(kind, workspace, policy) {
  if (kind === 'inbox') {
    return workspace.inbox
      .filter(item => item.status === 'attention')
      .slice(0, policy.max_items);
  }

  if (kind === 'calendar') {
    const now = Date.now();
    return workspace.calendar
      .filter(item => ['upcoming', 'draft'].includes(item.status) || !!timestampMs(item.payload?.ends_at))
      .filter(item => {
        const startsAt = item.payload?.starts_at ? new Date(item.payload.starts_at).getTime() : null;
        const endsAt = item.payload?.ends_at ? new Date(item.payload.ends_at).getTime() : null;
        if (endsAt && endsAt <= now && endsAt >= now - (8 * 60 * 60 * 1000)) return true;
        if (!startsAt) return true;
        return startsAt <= now + (policy.prep_window_hours * 60 * 60 * 1000);
      })
      .slice(0, policy.max_items);
  }

  if (kind === 'accounting') {
    return workspace.accounting
      .filter(item => item.status === 'pending' || cleanString(item.metadata?.category).toLowerCase() === 'revenue_share')
      .slice(0, policy.max_items);
  }

  return [];
}

async function ensureTaskForRecord({ business, kind, record }) {
  const descriptor = kind === 'inbox'
    ? buildInboxAction(record, business)
    : kind === 'calendar'
      ? buildCalendarAction(record, business)
      : buildAccountingAction(record, business);
  const fingerprint = buildFingerprint(record);
  const existing = findAction(business.id, kind, record.external_id, descriptor.actionKey);

  if (existing) {
    const currentTaskStatus = getTaskStatus(existing.task_id);
    if (currentTaskStatus === 'complete') {
      upsertAction({
        businessId: business.id,
        kind,
        externalId: record.external_id,
        actionKey: descriptor.actionKey,
        title: descriptor.title,
        summary: record.summary,
        department: descriptor.department,
        workflowKey: descriptor.workflowKey,
        sourceStatus: record.status,
        sourceFingerprint: fingerprint,
        taskId: existing.task_id,
        status: 'closed'
      });
      return { created: false, actionId: existing.id };
    }

    if (
      existing.source_fingerprint === fingerprint &&
      (existing.status === 'open' || existing.status === 'closed' || existing.status === 'needs_retry')
    ) {
      return { created: false, actionId: existing.id };
    }
  }

  const taskId = await queueTask({
    businessId: business.id,
    business,
    title: descriptor.title,
    description: descriptor.description,
    department: descriptor.department,
    workflowKey: descriptor.workflowKey,
    triggeredBy: 'agent',
    priority: descriptor.priority
  });

  const actionId = upsertAction({
    businessId: business.id,
    kind,
    externalId: record.external_id,
    actionKey: descriptor.actionKey,
    title: descriptor.title,
    summary: record.summary,
    department: descriptor.department,
    workflowKey: descriptor.workflowKey,
    sourceStatus: record.status,
    sourceFingerprint: fingerprint,
    taskId,
    status: 'open'
  });

  return { created: true, actionId, taskId, descriptor };
}

export function markWorkspaceAutomationTaskOutcome(taskId, taskStatus) {
  if (!taskId) return;
  const status = taskStatus === 'complete'
    ? 'closed'
    : taskStatus === 'failed'
      ? 'needs_retry'
      : 'open';

  const db = getDb();
  db.prepare(`
    UPDATE workspace_automation_actions
    SET status = ?,
        completed_at = ?,
        updated_at = datetime('now')
    WHERE task_id = ?
  `).run(status, status === 'closed' ? new Date().toISOString() : null, taskId);
}

export async function runWorkspaceAutomation({ business, workspace = null, triggeredBy = 'agent' }) {
  const snapshot = workspace || getWorkspaceSnapshot(business.id);
  const policies = getWorkspacePolicies(business.id);
  const runId = startAutomationRun({ businessId: business.id, triggeredBy });
  let itemsReviewed = 0;
  let tasksCreated = 0;

  try {
    for (const kind of ['inbox', 'calendar', 'accounting']) {
      const policy = policies[kind];
      if (!policy?.enabled) continue;

      const candidates = selectCandidates(kind, snapshot, policy);
      itemsReviewed += candidates.length;

      for (const record of candidates) {
        const result = await ensureTaskForRecord({ business, kind, record });
        if (result.created) tasksCreated += 1;
      }
    }

    const summary = tasksCreated
      ? `Workspace automation queued ${tasksCreated} operating tasks`
      : 'Workspace automation reviewed synced data with no new tasks needed';

    finishAutomationRun(runId, {
      status: 'complete',
      summary,
      itemsReviewed,
      tasksCreated
    });

    if (tasksCreated > 0) {
      await logActivity(business.id, {
        type: 'system',
        department: 'operations',
        title: summary,
        detail: {
          items_reviewed: itemsReviewed,
          tasks_created: tasksCreated
        }
      });
    }

    return getWorkspaceAutomationSnapshot(business.id);
  } catch (err) {
    finishAutomationRun(runId, {
      status: 'failed',
      summary: 'Workspace automation failed',
      itemsReviewed,
      tasksCreated,
      error: err.message
    });
    throw err;
  }
}
