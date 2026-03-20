import { v4 as uuid } from 'uuid';
import { getDb } from '../db/migrate.js';
import { logActivity } from './activity.js';
import { getBlueprintTaskGuidance } from '../business/blueprints.js';

const WORKFLOW_ALIASES = {
  planning: 'planning',
  strategy: 'planning',
  engineering: 'engineering',
  marketing: 'marketing',
  sales: 'marketing',
  operations: 'operations',
  finance: 'operations'
};

const WORKFLOW_LABELS = {
  planning: 'Planning loop',
  engineering: 'Engineering loop',
  marketing: 'Growth loop',
  operations: 'Operations loop'
};

const DEFAULT_REQUIREMENTS = {
  planning: [
    'Prioritise the highest leverage next step for the business.',
    'Use current business context rather than a generic playbook.',
    'Leave a concrete 7-day direction or experiment to run next.'
  ],
  engineering: [
    'Prefer measurable product, conversion, or reliability improvements.',
    'Keep changes compatible with the live stack already provisioned.',
    'Call out anything that still needs founder review before launch.'
  ],
  marketing: [
    'Target the right founder or buyer profile for this business.',
    'Ground messaging in a specific offer, pain point, or outcome.',
    'Make the next experiment measurable.'
  ],
  operations: [
    'Reduce founder drag, operational risk, or response lag.',
    'Prefer reversible actions and clear owner handoffs.',
    'Surface anything that could create trust, compliance, or delivery risk.'
  ]
};

const DEFAULT_OUTPUTS = {
  planning: [
    'Return a concise operating summary with priorities, risks, and recommended next steps.',
    'Make any follow-up work explicit so the next cycle can continue cleanly.'
  ],
  engineering: [
    'Ship code, deployment notes, or a concrete implementation summary.',
    'State what changed, what remains, and how to verify it.'
  ],
  marketing: [
    'Produce live campaign assets, content, leads, or a channel recommendation with evidence.',
    'Capture the CTA, audience, and expected metric movement.'
  ],
  operations: [
    'Leave the workflow in a safer, clearer state than you found it.',
    'Record any alerts, inbox decisions, or operational follow-ups explicitly.'
  ]
};

const DEFAULT_SUCCESS = {
  planning: [
    'The business has a clear next move grounded in current context.',
    'Open questions are explicit rather than hidden in prose.'
  ],
  engineering: [
    'The implementation result is specific and technically traceable.',
    'Any high-risk action is either approved or clearly queued for review.'
  ],
  marketing: [
    'The result is publishable, sendable, or directly usable by the next cycle.',
    'The expected outcome or metric is explicit.'
  ],
  operations: [
    'The workflow is more reliable, responsive, or better documented after execution.',
    'Any unresolved blocker is captured as an open loop.'
  ]
};

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseJsonField(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function uniqueList(values, limit = 8) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const cleaned = cleanString(value);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function slugify(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
}

function toolLabel(tool) {
  return ({
    web_search: 'Web research',
    write_code: 'Code changes',
    deploy_website: 'Website deploy',
    send_email: 'Email send',
    post_social: 'Social publish',
    add_lead: 'Lead capture',
    create_content: 'Content creation',
    update_memory: 'Memory update',
    update_metrics: 'Metrics update',
    flag_for_review: 'Founder review flag',
    task_complete: 'Completion handoff'
  }[tool] || tool.replace(/_/g, ' '));
}

function splitDescriptionLines(description) {
  return cleanString(description)
    .split(/\n+/)
    .map(line => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

function buildConstraints(business, workflowKey) {
  const constraints = [
    `Business involvement mode: ${business.involvement}.`,
    business.web_url ? `Current web surface: ${business.web_url}.` : '',
    business.email_address ? `Business mailbox: ${business.email_address}.` : '',
    workflowKey === 'engineering' ? 'Protect reliability and avoid vague implementation claims.' : '',
    workflowKey === 'marketing' ? 'Keep claims credible and grounded in the actual offer.' : '',
    workflowKey === 'operations' ? 'Prefer reversible, auditable workflow changes.' : '',
    workflowKey === 'planning' ? 'Do not drift into generic strategy advice.' : ''
  ];
  return uniqueList(constraints, 8);
}

function buildContext(business, memory, workflowState) {
  const context = [
    business.goal_90d ? `90-day goal: ${business.goal_90d}` : '',
    business.target_customer ? `Target customer: ${business.target_customer}` : '',
    ...(safeArray(memory.priorities).slice(0, 3).map(item => `Current priority: ${item}`)),
    ...(safeArray(memory.customer_insights).slice(0, 2).map(item => `Customer insight: ${item}`)),
    ...(safeArray(memory.competitors).slice(0, 2).map(item => `Competitor context: ${item}`)),
    workflowState?.summary ? `Workflow continuity: ${workflowState.summary}` : '',
    ...(safeArray(workflowState?.open_loops).slice(0, 3).map(item => `Open loop: ${item}`))
  ];
  return uniqueList(context, 10);
}

function buildDataReferences(memory, workflowState) {
  const refs = [
    ...(safeArray(memory.learnings).slice(0, 3).map(item => `Stored learning: ${item}`)),
    ...(safeArray(memory.notes).slice(0, 2).map(item => `Founder note: ${item}`)),
    ...(safeArray(workflowState?.evidence).slice(0, 4).map(item => `Prior evidence: ${item}`))
  ];
  return uniqueList(refs, 8);
}

function expectedEvidence(workflowKey, usedTools, summary) {
  const hasContent = usedTools.includes('create_content');
  const hasCode = usedTools.includes('write_code') || usedTools.includes('deploy_website');
  const hasOutreach = usedTools.includes('send_email') || usedTools.includes('post_social');
  const hasResearch = usedTools.includes('web_search');
  const summaryPresent = cleanString(summary).length >= 32;

  const expectations = {
    planning: hasResearch || summaryPresent,
    engineering: hasCode || summaryPresent,
    marketing: hasOutreach || hasContent || hasResearch,
    operations: usedTools.length > 0 || summaryPresent
  };
  return expectations[workflowKey] ?? summaryPresent;
}

function buildVerificationChecklist(task, business, result) {
  const usedTools = uniqueList(safeArray(result.toolResults).map(item => item.tool), 12);
  const queuedForReview = safeArray(result.toolResults).some(item => item?.result?.queuedForReview);
  const summary = cleanString(result.summary);
  const workflowKey = normalizeWorkflowKey(task.workflow_key || task.department, task.department);
  const checklist = [
    {
      label: 'Concrete summary recorded',
      passed: summary.length >= 32
    },
    {
      label: 'Execution evidence captured',
      passed: usedTools.length > 0
    },
    {
      label: 'Department-specific output expectation met',
      passed: expectedEvidence(workflowKey, usedTools, summary)
    },
    {
      label: 'Next-step continuity is explicit',
      passed: safeArray(result.nextSteps).length > 0 || summary.length >= 80
    },
    {
      label: 'Control mode respected for risky actions',
      passed: business.involvement === 'autopilot' || !usedTools.some(tool => ['deploy_website', 'send_email', 'post_social'].includes(tool)) || queuedForReview
    }
  ];

  const riskNotes = [];
  if (queuedForReview) {
    riskNotes.push('Execution paused behind a founder approval gate.');
  }
  if (summary.length < 32) {
    riskNotes.push('The completion summary is thin and may hide unresolved work.');
  }
  if (!usedTools.length) {
    riskNotes.push('No tool evidence was recorded for this task.');
  }
  if (usedTools.includes('deploy_website') && business.involvement === 'autopilot') {
    riskNotes.push('A deployment was completed in autopilot mode.');
  }

  return { checklist, riskNotes, usedTools, queuedForReview };
}

function verificationStatus(checklist, queuedForReview) {
  if (queuedForReview) return 'review';
  const passed = checklist.filter(item => item.passed).length;
  const ratio = checklist.length ? passed / checklist.length : 0;
  if (ratio >= 0.8) return 'passed';
  if (ratio >= 0.6) return 'review';
  return 'revise';
}

function verificationSummary(status, task, score, riskNotes, result) {
  if (status === 'passed') {
    return `${task.title} cleared Ventura's execution checks with ${(score * 100).toFixed(0)}% confidence.`;
  }
  if (status === 'review') {
    if (riskNotes.length) return riskNotes[0];
    return `${task.title} needs founder review before Ventura should treat it as complete.`;
  }
  return cleanString(result.summary)
    ? `${task.title} completed with gaps: ${cleanString(result.summary).slice(0, 160)}`
    : `${task.title} needs revision before Ventura should rely on its output.`;
}

function deriveSkill(task, result, verification, workflowState) {
  const summary = cleanString(result.summary);
  if (!summary || verification.score < 0.66) return null;

  const usedTools = uniqueList(safeArray(result.toolResults).map(item => item.tool), 8);
  if (!usedTools.length) return null;

  const workflowKey = normalizeWorkflowKey(task.workflow_key || task.department, task.department);
  const titleBase = cleanString(task.title).replace(/^Founder dispatch:\s*/i, '').split(' — ')[0];
  const slug = slugify(`${workflowKey}-${titleBase}`) || slugify(`${workflowKey}-${usedTools.join('-')}`);
  if (!slug) return null;

  return {
    slug,
    department: task.department,
    title: titleBase || WORKFLOW_LABELS[workflowKey] || 'Execution playbook',
    summary: verification.summary,
    steps: uniqueList([
      ...usedTools.map(toolLabel),
      ...(safeArray(result.nextSteps).slice(0, 2))
    ], 6),
    confidence: Number(verification.score.toFixed(2)),
    workflow_key: workflowKey,
    source: workflowState?.summary || ''
  };
}

function upsertSkill(db, businessId, task, verification, result, workflowState) {
  const skill = deriveSkill(task, result, verification, workflowState);
  if (!skill) return null;

  const existing = db.prepare(`
    SELECT id, times_observed
    FROM skill_library
    WHERE business_id = ? AND slug = ?
  `).get(businessId, skill.slug);

  if (existing) {
    db.prepare(`
      UPDATE skill_library
      SET title = ?,
          summary = ?,
          steps = ?,
          confidence = ?,
          evidence_task_id = ?,
          times_observed = times_observed + 1,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      skill.title,
      skill.summary,
      JSON.stringify(skill.steps),
      skill.confidence,
      task.id,
      existing.id
    );
  } else {
    db.prepare(`
      INSERT INTO skill_library (
        id, business_id, department, slug, title, summary, steps, confidence, evidence_task_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuid(),
      businessId,
      task.department,
      skill.slug,
      skill.title,
      skill.summary,
      JSON.stringify(skill.steps),
      skill.confidence,
      task.id
    );
  }

  return db.prepare(`
    SELECT *
    FROM skill_library
    WHERE business_id = ? AND slug = ?
  `).get(businessId, skill.slug);
}

function parseStoredWorkflow(row) {
  if (!row) return null;
  return {
    ...row,
    open_loops: parseJsonField(row.open_loops, []),
    evidence: parseJsonField(row.evidence, [])
  };
}

function parseStoredVerification(row) {
  if (!row) return null;
  return {
    ...row,
    checklist: parseJsonField(row.checklist, []),
    risks: parseJsonField(row.risks, []),
    suggested_followups: parseJsonField(row.suggested_followups, [])
  };
}

function parseStoredSkill(row) {
  if (!row) return null;
  return {
    ...row,
    steps: parseJsonField(row.steps, [])
  };
}

function formatChecklistLines(items) {
  return safeArray(items).map(item => `${item.passed ? 'PASS' : 'FLAG'} — ${item.label}`);
}

export function normalizeWorkflowKey(value, department = 'operations') {
  return WORKFLOW_ALIASES[cleanString(value).toLowerCase()] || WORKFLOW_ALIASES[cleanString(department).toLowerCase()] || 'operations';
}

export function composeTaskBrief({ business, title, description = '', department = 'operations', workflowKey = null, workflowState = null }) {
  const memory = parseJsonField(business.agent_memory, {});
  const normalizedWorkflow = normalizeWorkflowKey(workflowKey, department);
  const descriptionLines = splitDescriptionLines(description);
  const blueprintGuide = getBlueprintTaskGuidance(business, normalizedWorkflow);
  const requirements = uniqueList([
    ...descriptionLines,
    ...(blueprintGuide.requirements || []),
    ...DEFAULT_REQUIREMENTS[normalizedWorkflow]
  ], 8);

  const data = buildDataReferences(memory, workflowState);
  const constraints = buildConstraints(business, normalizedWorkflow);
  const context = uniqueList([
    ...(blueprintGuide.context || []),
    ...buildContext(business, memory, workflowState)
  ], 10);
  const output = uniqueList([
    ...(blueprintGuide.output || []),
    ...DEFAULT_OUTPUTS[normalizedWorkflow]
  ], 5);
  const success = uniqueList([
    ...(blueprintGuide.success || []),
    ...DEFAULT_SUCCESS[normalizedWorkflow],
    ...(safeArray(workflowState?.open_loops).length ? ['Resolve or explicitly carry forward any existing open loops.'] : [])
  ], 5);

  return {
    blueprint: blueprintGuide.blueprint,
    workflow_key: normalizedWorkflow,
    what: cleanString(title),
    requirements,
    data,
    constraints,
    context,
    output,
    success
  };
}

export function formatTaskBrief(brief) {
  if (!brief) return '';
  const render = (label, items) => {
    const rows = uniqueList(items, 8);
    if (!rows.length) return '';
    return `${label}:\n${rows.map((item, index) => `${index + 1}. ${item}`).join('\n')}`;
  };

  return [
    brief.what ? `WHAT:\n${brief.what}` : '',
    render('SPECIFIC REQUIREMENTS', brief.requirements),
    render('DATA AND STATE TO USE', brief.data),
    render('CONSTRAINTS', brief.constraints),
    render('CONTEXT', brief.context),
    render('OUTPUT FORMAT', brief.output),
    render('SUCCESS CHECK', brief.success)
  ].filter(Boolean).join('\n\n');
}

export function hydrateTask(task) {
  if (!task) return null;
  return {
    ...task,
    brief: parseJsonField(task.brief_json, null)
  };
}

export function getWorkflowState(businessId, workflowKey) {
  const db = getDb();
  const normalized = normalizeWorkflowKey(workflowKey);
  return parseStoredWorkflow(
    db.prepare(`
      SELECT *
      FROM workflow_states
      WHERE business_id = ? AND workflow_key = ?
    `).get(businessId, normalized)
  );
}

export function listWorkflowStates(businessId, limit = 8) {
  const db = getDb();
  return db.prepare(`
    SELECT *
    FROM workflow_states
    WHERE business_id = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(businessId, limit).map(parseStoredWorkflow);
}

export function listTaskVerifications(businessId, limit = 12) {
  const db = getDb();
  return db.prepare(`
    SELECT tv.*, t.title, t.department, t.status AS task_status, t.completed_at, t.created_at AS task_created_at
    FROM task_verifications tv
    JOIN tasks t ON t.id = tv.task_id
    WHERE tv.business_id = ?
    ORDER BY tv.updated_at DESC, tv.created_at DESC
    LIMIT ?
  `).all(businessId, limit).map(parseStoredVerification);
}

export function getVerificationSummary(businessId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count, AVG(score) AS avg_score
    FROM task_verifications
    WHERE business_id = ?
    GROUP BY status
  `).all(businessId);

  const summary = {
    total: 0,
    passed: 0,
    review: 0,
    revise: 0,
    avg_score: 0
  };

  for (const row of rows) {
    summary.total += Number(row.count || 0);
    summary[row.status] = Number(row.count || 0);
    if (row.avg_score != null) {
      summary.avg_score += Number(row.avg_score) * Number(row.count || 0);
    }
  }

  if (summary.total) {
    summary.avg_score = Number((summary.avg_score / summary.total).toFixed(2));
  }

  return summary;
}

export function listSkillLibrary(businessId, limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT *
    FROM skill_library
    WHERE business_id = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(businessId, limit).map(parseStoredSkill);
}

export function getExecutionIntelligenceSnapshot(businessId) {
  return {
    workflows: listWorkflowStates(businessId, 8),
    recent_verifications: listTaskVerifications(businessId, 10),
    verification_summary: getVerificationSummary(businessId),
    skill_library: listSkillLibrary(businessId, 8)
  };
}

export function verifyTaskResult({ task, business, result }) {
  const { checklist, riskNotes, usedTools, queuedForReview } = buildVerificationChecklist(task, business, result);
  const passedCount = checklist.filter(item => item.passed).length;
  const score = checklist.length ? passedCount / checklist.length : 0;
  const status = verificationStatus(checklist, queuedForReview);
  const followups = uniqueList(safeArray(result.nextSteps), 6);

  return {
    status,
    score: Number(score.toFixed(2)),
    summary: verificationSummary(status, task, score, riskNotes, result),
    checklist,
    risks: riskNotes,
    suggested_followups: followups,
    tools_used: usedTools
  };
}

export function recordTaskVerification({ businessId, task, verification }) {
  const db = getDb();
  const existing = db.prepare(`
    SELECT id
    FROM task_verifications
    WHERE task_id = ?
  `).get(task.id);

  if (existing) {
    db.prepare(`
      UPDATE task_verifications
      SET status = ?,
          score = ?,
          summary = ?,
          checklist = ?,
          risks = ?,
          suggested_followups = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      verification.status,
      verification.score,
      verification.summary,
      JSON.stringify(verification.checklist),
      JSON.stringify(verification.risks),
      JSON.stringify(verification.suggested_followups),
      existing.id
    );
  } else {
    db.prepare(`
      INSERT INTO task_verifications (
        id, business_id, task_id, status, score, summary, checklist, risks, suggested_followups
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuid(),
      businessId,
      task.id,
      verification.status,
      verification.score,
      verification.summary,
      JSON.stringify(verification.checklist),
      JSON.stringify(verification.risks),
      JSON.stringify(verification.suggested_followups)
    );
  }

  db.prepare(`
    UPDATE tasks
    SET verification_status = ?, verification_summary = ?
    WHERE id = ?
  `).run(verification.status, verification.summary, task.id);

  return parseStoredVerification(db.prepare(`
    SELECT *
    FROM task_verifications
    WHERE task_id = ?
  `).get(task.id));
}

export function upsertWorkflowState({ businessId, task, result, verification, cycleId = null }) {
  const db = getDb();
  const workflowKey = normalizeWorkflowKey(task.workflow_key || task.department, task.department);
  const existing = getWorkflowState(businessId, workflowKey);
  const evidence = uniqueList([
    ...(safeArray(existing?.evidence)),
    ...safeArray(verification.tools_used).map(toolLabel),
    cleanString(result.summary)
  ], 8);
  const openLoops = uniqueList([
    ...safeArray(result.nextSteps),
    ...safeArray(existing?.open_loops)
  ], 8);
  const status = verification.status === 'passed'
    ? 'healthy'
    : verification.status === 'review'
      ? 'review'
      : 'attention';
  const title = WORKFLOW_LABELS[workflowKey] || `${workflowKey} loop`;

  const payload = {
    summary: verification.summary,
    open_loops: openLoops,
    evidence,
    last_task_id: task.id,
    last_cycle_id: cycleId || task.cycle_id || null,
    last_verification_status: verification.status
  };

  if (existing) {
    db.prepare(`
      UPDATE workflow_states
      SET department = ?,
          title = ?,
          status = ?,
          summary = ?,
          open_loops = ?,
          evidence = ?,
          last_task_id = ?,
          last_cycle_id = ?,
          last_verification_status = ?,
          last_run_at = datetime('now'),
          updated_at = datetime('now')
      WHERE business_id = ? AND workflow_key = ?
    `).run(
      task.department,
      title,
      status,
      payload.summary,
      JSON.stringify(payload.open_loops),
      JSON.stringify(payload.evidence),
      payload.last_task_id,
      payload.last_cycle_id,
      payload.last_verification_status,
      businessId,
      workflowKey
    );
  } else {
    db.prepare(`
      INSERT INTO workflow_states (
        id, business_id, workflow_key, department, title, status, summary, open_loops,
        evidence, last_task_id, last_cycle_id, last_verification_status, last_run_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      uuid(),
      businessId,
      workflowKey,
      task.department,
      title,
      status,
      payload.summary,
      JSON.stringify(payload.open_loops),
      JSON.stringify(payload.evidence),
      payload.last_task_id,
      payload.last_cycle_id,
      payload.last_verification_status
    );
  }

  return getWorkflowState(businessId, workflowKey);
}

function updateBusinessMemory(db, business, task, result, verification, workflowState, skill) {
  const memory = parseJsonField(business.agent_memory, {});
  const learnings = uniqueList([
    verification.summary,
    ...safeArray(memory.learnings)
  ], 12);
  const historyEntry = {
    at: new Date().toISOString(),
    task: task.title,
    department: task.department,
    summary: cleanString(result.summary),
    verification_status: verification.status
  };
  const history = safeArray(memory.history).slice(-9);
  history.push(historyEntry);

  const nextMemory = {
    ...memory,
    priorities: uniqueList(safeArray(memory.priorities), 12),
    learnings,
    competitors: uniqueList(safeArray(memory.competitors), 12),
    customer_insights: uniqueList(safeArray(memory.customer_insights), 12),
    notes: uniqueList(safeArray(memory.notes), 12),
    history,
    last_cycle: {
      ...(memory.last_cycle || {}),
      last_task_title: task.title,
      last_task_department: task.department,
      last_task_summary: cleanString(result.summary),
      last_verification_status: verification.status,
      open_loops: safeArray(workflowState?.open_loops).slice(0, 5),
      skill_refreshed: skill?.title || null,
      updated_at: new Date().toISOString()
    }
  };

  db.prepare(`
    UPDATE businesses
    SET agent_memory = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(nextMemory), business.id);

  return nextMemory;
}

export async function persistExecutionIntelligence({ business, task, result, cycleId = null }) {
  const db = getDb();
  const verification = recordTaskVerification({
    businessId: business.id,
    task,
    verification: verifyTaskResult({ task, business, result })
  });
  const workflowState = upsertWorkflowState({
    businessId: business.id,
    task,
    result,
    verification,
    cycleId
  });
  const skill = upsertSkill(db, business.id, task, verification, result, workflowState);
  const memory = updateBusinessMemory(db, business, task, result, verification, workflowState, skill);

  if (verification.status !== 'passed') {
    await logActivity(business.id, {
      type: 'alert',
      department: task.department,
      title: `Verification ${verification.status}: ${task.title}`,
      detail: {
        taskId: task.id,
        summary: verification.summary,
        checklist: formatChecklistLines(verification.checklist),
        followups: verification.suggested_followups
      }
    });
  } else {
    await logActivity(business.id, {
      type: 'insight',
      department: task.department,
      title: `Verified: ${task.title}`,
      detail: {
        taskId: task.id,
        summary: verification.summary,
        skill: skill?.title || null
      }
    });
  }

  return {
    verification,
    workflowState,
    skill: parseStoredSkill(skill),
    memory
  };
}
