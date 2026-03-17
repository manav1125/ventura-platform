import { v4 as uuid } from 'uuid';
import { getDb } from '../db/migrate.js';
import { emitToBusiness, emitToUser } from '../ws/websocket.js';
import { logActivity } from './activity.js';
import { runGuardedOperation } from './action-operations.js';

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hydrateApproval(row) {
  if (!row) return null;
  return {
    ...row,
    payload: parseJson(row.payload),
    execution_result: parseJson(row.execution_result, null)
  };
}

function approvalDepartment(actionType) {
  return {
    deploy_website: 'engineering',
    send_email: 'operations',
    post_social: 'marketing'
  }[actionType] || 'operations';
}

async function notifyFounder(businessId, approval, event) {
  emitToBusiness(businessId, { event, approval });
  const db = getDb();
  const founder = db.prepare(`
    SELECT u.id
    FROM users u
    JOIN businesses b ON b.user_id = u.id
    WHERE b.id = ?
  `).get(businessId);
  if (founder) {
    emitToUser(founder.id, { event, approval });
  }
}

export function getApprovalById(approvalId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT a.*, b.name AS business_name
    FROM approvals a
    JOIN businesses b ON b.id = a.business_id
    WHERE a.id = ?
  `).get(approvalId);
  return hydrateApproval(row);
}

export function listApprovals(businessId, { status = null, limit = 25 } = {}) {
  const db = getDb();
  const rows = status
    ? db.prepare(`
        SELECT * FROM approvals
        WHERE business_id = ? AND status = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(businessId, status, limit)
    : db.prepare(`
        SELECT * FROM approvals
        WHERE business_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(businessId, limit);

  return rows.map(hydrateApproval);
}

export async function createApproval({
  businessId,
  taskId = null,
  actionType,
  title,
  summary = '',
  payload = {},
  requestedBy = 'agent'
}) {
  const db = getDb();
  const id = uuid();

  db.prepare(`
    INSERT INTO approvals (
      id, business_id, task_id, action_type, title, summary, payload, status, requested_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, businessId, taskId, actionType, title, summary, JSON.stringify(payload), requestedBy);

  const approval = getApprovalById(id);

  await logActivity(businessId, {
    type: 'alert',
    department: approvalDepartment(actionType),
    title: `Approval needed: ${title}`,
    detail: { approvalId: id, actionType, summary }
  });

  await notifyFounder(businessId, approval, 'approval:created');
  return approval;
}

async function executeApproval(approval) {
  const db = getDb();
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(approval.business_id);
  if (!business) throw new Error('Business not found');

  let execution;
  if (approval.action_type === 'send_email') {
    const { sendEmail } = await import('../integrations/email.js');
    const { to, subject, body, from } = approval.payload;
    execution = await runGuardedOperation({
      businessId: approval.business_id,
      taskId: approval.task_id,
      approvalId: approval.id,
      actionType: approval.action_type,
      summary: approval.summary || `${subject} → ${to}`,
      payload: approval.payload,
      execute: () => sendEmail({
        from: from || business.email_address,
        to,
        subject,
        html: body
      })
    });
  } else if (approval.action_type === 'deploy_website') {
    const { deployFiles } = await import('../integrations/deploy.js');
    execution = await runGuardedOperation({
      businessId: approval.business_id,
      taskId: approval.task_id,
      approvalId: approval.id,
      actionType: approval.action_type,
      summary: approval.payload.versionNote || approval.summary || 'Founder-approved deployment',
      payload: approval.payload,
      execute: () => deployFiles(
        approval.business_id,
        approval.payload.files || [],
        approval.payload.versionNote || approval.summary || 'Founder-approved deployment'
      )
    });
  } else if (approval.action_type === 'post_social') {
    const { postTweet, postLinkedIn, postThread } = await import('../integrations/social.js');
    const { platform, content, thread } = approval.payload;
    execution = await runGuardedOperation({
      businessId: approval.business_id,
      taskId: approval.task_id,
      approvalId: approval.id,
      actionType: approval.action_type,
      summary: approval.summary || `Publish to ${platform}`,
      payload: approval.payload,
      execute: async () => {
        if (platform === 'twitter') return postTweet(approval.business_id, content);
        if (platform === 'linkedin') return postLinkedIn(approval.business_id, { text: content });
        if (platform === 'both' && thread) return postThread(approval.business_id, Array.isArray(content) ? content : [content]);
        if (platform === 'both') {
          const twitter = await postTweet(approval.business_id, content);
          const linkedin = await postLinkedIn(approval.business_id, { text: content });
          return { twitter, linkedin };
        }
        throw new Error(`Unsupported approval action: ${approval.action_type}`);
      }
    });
  } else {
    throw new Error(`Unsupported approval action: ${approval.action_type}`);
  }

  const result = {
    ...(execution.result || {}),
    replayed: !!execution.replayed,
    operationId: execution.operation?.id || null
  };

  db.prepare(`
    UPDATE approvals
    SET status = 'executed',
        execution_result = ?,
        decided_at = COALESCE(decided_at, datetime('now'))
    WHERE id = ?
  `).run(JSON.stringify(result || {}), approval.id);

  await logActivity(approval.business_id, {
    type: 'system',
    department: approvalDepartment(approval.action_type),
    title: `Founder approved: ${approval.title}`,
    detail: { approvalId: approval.id, result }
  });

  return getApprovalById(approval.id);
}

export async function decideApproval({
  approvalId,
  businessId,
  userId,
  decision,
  note = ''
}) {
  const db = getDb();
  const approval = getApprovalById(approvalId);
  if (!approval || approval.business_id !== businessId) {
    throw Object.assign(new Error('Approval not found'), { statusCode: 404 });
  }
  if (approval.status !== 'pending') {
    throw Object.assign(new Error('Approval is no longer pending'), { statusCode: 409 });
  }

  if (!['approve', 'reject'].includes(decision)) {
    throw Object.assign(new Error('Invalid decision'), { statusCode: 400 });
  }

  const intermediateStatus = decision === 'approve' ? 'approved' : 'rejected';
  db.prepare(`
    UPDATE approvals
    SET status = ?, decision_note = ?, decided_by = ?, decided_at = datetime('now')
    WHERE id = ?
  `).run(intermediateStatus, note || null, userId, approvalId);

  if (decision === 'reject') {
    await logActivity(businessId, {
      type: 'alert',
      department: approvalDepartment(approval.action_type),
      title: `Founder rejected: ${approval.title}`,
      detail: { approvalId, note }
    });
    const rejected = getApprovalById(approvalId);
    await notifyFounder(businessId, rejected, 'approval:updated');
    return rejected;
  }

  try {
    const executed = await executeApproval(getApprovalById(approvalId));
    await notifyFounder(businessId, executed, 'approval:updated');
    return executed;
  } catch (err) {
    db.prepare(`
      UPDATE approvals
      SET status = 'failed', execution_result = ?
      WHERE id = ?
    `).run(JSON.stringify({ error: err.message }), approvalId);
    const failed = getApprovalById(approvalId);
    await logActivity(businessId, {
      type: 'alert',
      department: approvalDepartment(approval.action_type),
      title: `Approval failed: ${approval.title}`,
      detail: { approvalId, error: err.message }
    });
    await notifyFounder(businessId, failed, 'approval:updated');
    throw err;
  }
}
