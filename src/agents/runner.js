// src/agents/runner.js
// The agent runner:
//   - Triggered by cron (daily) OR manually via API
//   - For each active business: creates a cycle, fetches queued tasks,
//     runs them one by one through the brain, updates metrics, logs activity
//   - Emits real-time updates via WebSocket throughout

import { v4 as uuid } from 'uuid';
import cron from 'node-cron';
import { getDb } from '../db/migrate.js';
import { runTask } from './brain.js';
import { ensureBusinessCadence, isBusinessDue, markCycleRun } from './cadence.js';
import { createArtifact, getLatestArtifactByKind, getPublishedSiteFile } from './artifacts.js';
import { getQueuedTasks, startTask, completeTask, failTask, queueTask } from './tasks.js';
import { logActivity } from './activity.js';
import { openRecoveryCase, resolveRecoveryCasesForSource } from './recovery.js';
import { syncWorkspaceData } from '../integrations/workspace-sync.js';
import { markWorkspaceAutomationTaskOutcome, runWorkspaceAutomation } from './workspace-automation.js';
import { emitToBusiness, emitToUser } from '../ws/websocket.js';
import { AGENT_CRON_SCHEDULE, AGENT_MODEL } from '../config.js';

// ─── Cron scheduler ───────────────────────────────────────────────────────────
let schedulerTask;

export function startAgentScheduler() {
  if (schedulerTask) return schedulerTask;
  console.log(`🤖 Agent scheduler started — cron: "${AGENT_CRON_SCHEDULE}"`);

  schedulerTask = cron.schedule(AGENT_CRON_SCHEDULE, async () => {
    console.log(`\n🔁 [${new Date().toISOString()}] Starting daily agent run for all businesses`);
    await runAllBusinesses('cron');
  });
  return schedulerTask;
}

export function stopAgentScheduler() {
  if (!schedulerTask) return;
  schedulerTask.stop();
  if (typeof schedulerTask.destroy === 'function') schedulerTask.destroy();
  schedulerTask = null;
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clipText(value, max = 180) {
  const cleaned = cleanString(value);
  if (!cleaned) return '';
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}

function safeParseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeDepartment(value) {
  const department = cleanString(value).toLowerCase();
  return ['engineering', 'marketing', 'operations', 'strategy', 'sales', 'finance'].includes(department)
    ? department
    : 'strategy';
}

function extractSiteHeadline(siteFile) {
  const content = cleanString(siteFile?.content);
  if (!content) return '';
  const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch?.[1]) return cleanString(titleMatch[1]);
  const h1Match = content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return cleanString((h1Match?.[1] || '').replace(/<[^>]+>/g, ' '));
}

function isWeakCycleTaskTitle(title) {
  const normalized = cleanString(title).toLowerCase();
  if (!normalized) return true;
  return [
    'write full business plan',
    '90-day roadmap',
    'define mvp feature set',
    'build core mvp',
    'build and deploy complete landing page',
    'technical architecture'
  ].some(fragment => normalized.includes(fragment));
}

function normalizeTaskCandidate(task, business) {
  const title = cleanString(task?.title);
  const description = cleanString(task?.description);
  if (!title || !description || isWeakCycleTaskTitle(title)) return null;
  return {
    title: title.length > 140 ? `${title.slice(0, 137)}...` : title,
    description: description.length > 360 ? `${description.slice(0, 357)}...` : description,
    department: normalizeDepartment(task.department || task?.dept || 'strategy')
  };
}

function buildFallbackCycleTasks({
  business,
  memory,
  workspace,
  latestPlan,
  siteHeadline,
  existingTitles = new Set()
}) {
  const audience = business.target_customer || 'target customers';
  const goal = business.goal_90d || 'the 90-day goal';
  const planOffer = cleanString(latestPlan?.metadata?.offer || memory?.launch_plan?.offer || '');
  const priorities = Array.isArray(memory?.priorities) ? memory.priorities : [];
  const tasks = [
    {
      title: `Tighten ${business.name} positioning for ${audience}`,
      department: 'strategy',
      description: `Produce a sharper positioning brief, offer framing, and CTA Ventura can reuse across the site and outreach while pushing toward ${goal}.`
    },
    {
      title: `Refresh ${business.name} homepage around the core offer`,
      department: 'engineering',
      description: `Update and deploy the live homepage so it clearly sells ${planOffer || business.description} to ${audience}, with a stronger hero, proof, and CTA.`
    },
    {
      title: `Research 15 high-fit prospects for ${business.name}`,
      department: 'marketing',
      description: `Create a prospect list with company, contact angle, and why-now notes so Ventura can start qualified outreach toward ${goal}.`
    },
    {
      title: `Set inbound response rules for ${business.name}`,
      department: 'operations',
      description: `Document inbox triage rules, reply templates, and escalation notes so Ventura can handle inbound interest without founder confusion.`
    }
  ];

  if ((workspace?.summary?.inbox_attention || 0) > 0) {
    tasks.unshift({
      title: `Clear urgent inbox work for ${business.name}`,
      department: 'operations',
      description: `Review the live inbox attention queue, draft replies, and leave a clean operating note for anything blocked on founder input.`
    });
  }

  if (siteHeadline) {
    tasks[1] = {
      title: `Upgrade ${business.name} homepage messaging`,
      department: 'engineering',
      description: `Refine the current site headline "${siteHeadline}" into a sharper, higher-converting homepage for ${audience}, then redeploy the live page.`
    };
  }

  if (priorities.length) {
    tasks[0] = {
      title: `Advance Ventura's top priority for ${business.name}`,
      department: 'strategy',
      description: `Take the current priority "${priorities[0]}" and turn it into a more specific founder-facing execution brief and next-step sequence tied to ${goal}.`
    };
  }

  return tasks.filter(task => !existingTitles.has(cleanString(task.title).toLowerCase())).slice(0, 4);
}

function buildCycleSummaryFallback({
  business,
  tasksRun,
  errors,
  completedTasks,
  failedTasks,
  queuedTasks
}) {
  const completed = completedTasks
    .map(task => clipText(task.result?.summary || task.title, 90))
    .filter(Boolean)
    .slice(0, 2);
  const nextUp = queuedTasks
    .map(task => task.title)
    .filter(Boolean)
    .slice(0, 2);

  if (!tasksRun && errors) {
    return `Ventura hit ${errors} execution issue${errors === 1 ? '' : 's'} for ${business.name}; next queued work is ${nextUp[0] || 'waiting on a founder retry'}.`;
  }

  const headline = completed.length
    ? `Ventura completed ${tasksRun} task${tasksRun === 1 ? '' : 's'} for ${business.name}: ${completed.join('; ')}.`
    : `Ventura completed ${tasksRun} task${tasksRun === 1 ? '' : 's'} for ${business.name}.`;

  if (failedTasks.length) {
    return `${headline} ${failedTasks.length} task${failedTasks.length === 1 ? '' : 's'} still need recovery.`;
  }
  if (nextUp.length) {
    return `${headline} Next up: ${nextUp.join('; ')}.`;
  }
  return headline;
}

function buildCycleReportContent({ triggeredBy, completedTasks, failedTasks, queuedTasks, summary }) {
  return [
    `Cycle trigger: ${triggeredBy}`,
    '',
    `Summary: ${summary}`,
    '',
    'Completed tasks:',
    ...(completedTasks.length
      ? completedTasks.map(task => `- [${task.department}] ${task.title}: ${clipText(task.result?.summary || task.description || 'Completed.', 220)}`)
      : ['- None completed in this cycle.']),
    '',
    'Failed tasks:',
    ...(failedTasks.length
      ? failedTasks.map(task => `- [${task.department}] ${task.title}: ${clipText(task.error || 'Execution failed.', 220)}`)
      : ['- None']),
    '',
    'Still queued:',
    ...(queuedTasks.length
      ? queuedTasks.map(task => `- [${task.department}] ${task.title}`)
      : ['- No queued follow-up tasks.'])
  ].join('\n');
}

// ─── Run all active businesses ────────────────────────────────────────────────

export async function runAllBusinesses(triggeredBy = 'cron') {
  const db = getDb();
  const activeBusinesses = db.prepare(`SELECT * FROM businesses WHERE status = 'active'`).all();
  const dueBusinesses = activeBusinesses
    .map(business => {
      ensureBusinessCadence(business.id);
      return db.prepare('SELECT * FROM businesses WHERE id = ?').get(business.id);
    })
    .filter(business => triggeredBy !== 'cron' || isBusinessDue(business));

  console.log(`📊 Running agents for ${dueBusinesses.length} due businesses (${activeBusinesses.length} active total)`);

  // Run sequentially to manage API rate limits
  // In production, parallelise with a concurrency limiter
  for (const business of dueBusinesses) {
    try {
      const cycle = startBusinessCycleIfIdle(business, triggeredBy);
      if (!cycle.started) {
        console.log(`⏭ Skipping ${business.name}: cycle already running (${cycle.cycleId})`);
        continue;
      }
      await cycle.promise;
    } catch (err) {
      console.error(`❌ Failed cycle for ${business.name}: ${err.message}`);
    }
  }
}

// ─── Single business cycle ────────────────────────────────────────────────────

export async function runBusinessCycle(business, triggeredBy = 'cron') {
  const db = getDb();
  const cycleId = uuid();
  const isLaunchCycle = ['launch', 'relaunch'].includes(triggeredBy);

  console.log(`\n▶ Starting cycle for: ${business.name} (${business.id})`);

  // Create cycle record
  db.prepare(`
    INSERT INTO agent_cycles (id, business_id, status, triggered_by, started_at)
    VALUES (?, ?, 'running', ?, datetime('now'))
  `).run(cycleId, business.id, triggeredBy);

  emitToBusiness(business.id, { event: 'cycle:started', cycleId, businessId: business.id });

  // Get the user for this business
  const user = db.prepare('SELECT id FROM users WHERE id = (SELECT user_id FROM businesses WHERE id = ?)')
    .get(business.id);

  if (user) {
    emitToUser(user.id, {
      event: 'cycle:started',
      businessName: business.name,
      businessId: business.id
    });
  }

  let tasksRun = 0;
  let errors = 0;

  try {
    const refreshedBusiness = db.prepare('SELECT * FROM businesses WHERE id = ?').get(business.id);
    const workspaceSync = await syncWorkspaceData({
      business: refreshedBusiness,
      triggeredBy: triggeredBy === 'cron' ? 'agent' : triggeredBy,
      respectSchedule: triggeredBy === 'cron'
    });
    const workspaceAutomation = await runWorkspaceAutomation({
      business: refreshedBusiness,
      workspace: workspaceSync.snapshot,
      triggeredBy: triggeredBy === 'cron' ? 'agent' : triggeredBy
    });

    const queuedBeforeGeneration = getQueuedTasks(business.id, 20);

    // Launch cycles should begin executing the freshly seeded bootstrap queue
    // instead of immediately piling on a second daily planning layer.
    if (!isLaunchCycle || queuedBeforeGeneration.length < 3) {
      const newTasks = await generateCycleTasks(refreshedBusiness);
      for (const t of newTasks) {
        await queueTask({
          businessId: business.id,
          business: refreshedBusiness,
          title: t.title,
          description: t.description,
          department: t.department,
          workflowKey: t.workflowKey,
          cycleId,
          triggeredBy: 'agent',
          priority: 3
        });
      }
    }

    // ── Run all queued tasks ──────────────────────────────────────────────────
    const tasks = getQueuedTasks(business.id, isLaunchCycle ? 2 : 8);

    for (const task of tasks) {
      try {
        console.log(`  → Task: ${task.title} [${task.department}]`);
        startTask(task.id, cycleId);
        const currentBusiness = db.prepare('SELECT * FROM businesses WHERE id = ?').get(business.id);

        const result = await runTask(task, currentBusiness, cycleId);
        completeTask(task.id, result);
        markWorkspaceAutomationTaskOutcome(task.id, 'complete');
        resolveRecoveryCasesForSource(
          business.id,
          'task',
          task.id,
          'Task completed successfully after retry.'
        );
        tasksRun++;

        console.log(`  ✓ Done: ${task.title}`);

        // Queue suggested follow-up tasks
        if (result.nextSteps?.length) {
          for (const step of result.nextSteps.slice(0, 2)) {
            await queueTask({
              businessId: business.id,
              business: currentBusiness,
              title: step,
              department: task.department,
              workflowKey: task.workflow_key || task.department,
              triggeredBy: 'agent',
              priority: 5,
              cycleId
            });
          }
        }

      } catch (err) {
        failTask(task.id, err.message);
        markWorkspaceAutomationTaskOutcome(task.id, 'failed');
        errors++;
        console.error(`  ✗ Failed: ${task.title} — ${err.message}`);

        await logActivity(business.id, {
          type: 'alert',
          department: task.department,
          title: `Task failed: ${task.title}`,
          detail: { error: err.message }
        });
        openRecoveryCase({
          businessId: business.id,
          sourceType: 'task',
          sourceId: task.id,
          severity: 'attention',
          title: `Task failed: ${task.title}`,
          summary: err.message,
          detail: {
            cycleId,
            department: task.department,
            taskId: task.id,
            error: err.message
          },
          retryAction: {
            type: 'task',
            taskId: task.id
          }
        });
      }
    }

    // ── Update day count and metrics ──────────────────────────────────────────
    if (isLaunchCycle) {
      db.prepare(`
        UPDATE businesses
        SET updated_at = datetime('now')
        WHERE id = ?
      `).run(business.id);
    } else {
      db.prepare(`
        UPDATE businesses
        SET day_count = day_count + 1, updated_at = datetime('now')
        WHERE id = ?
      `).run(business.id);
    }
    const cadence = markCycleRun(business.id, new Date(), { failure: false });

    // Refresh business object for summary
    const updatedBusiness = db.prepare('SELECT * FROM businesses WHERE id=?').get(business.id);

    // ── Generate cycle summary via AI ─────────────────────────────────────────
    const summary = await generateCycleSummary(updatedBusiness, tasksRun, errors, cycleId, triggeredBy);

    const cycleTasks = db.prepare(`
      SELECT title, department, description, status, result, error
      FROM tasks
      WHERE business_id = ?
        AND cycle_id = ?
      ORDER BY created_at ASC
    `).all(business.id, cycleId).map(task => ({
      ...task,
      result: safeParseJson(task.result, {})
    }));
    const completedCycleTasks = cycleTasks.filter(task => task.status === 'complete');
    const failedCycleTasks = cycleTasks.filter(task => task.status === 'failed');
    const queuedCycleTasks = getQueuedTasks(business.id, 8);

    createArtifact({
      businessId: business.id,
      cycleId,
      department: 'strategy',
      kind: 'cycle_report',
      title: `${isLaunchCycle ? 'Launch' : 'Daily'} cycle report`,
      summary,
      content: buildCycleReportContent({
        triggeredBy,
        completedTasks: completedCycleTasks,
        failedTasks: failedCycleTasks,
        queuedTasks: queuedCycleTasks,
        summary
      }),
      metadata: {
        triggered_by: triggeredBy,
        tasks_run: tasksRun,
        errors,
        completed_tasks: completedCycleTasks.length,
        failed_tasks: failedCycleTasks.length,
        queued_tasks: queuedCycleTasks.length
      }
    });

    // ── Complete cycle record ─────────────────────────────────────────────────
    db.prepare(`
      UPDATE agent_cycles
      SET status='complete', completed_at=datetime('now'), tasks_run=?, summary=?
      WHERE id=?
    `).run(tasksRun, summary, cycleId);

    await logActivity(business.id, {
      type: 'cycle_complete',
      department: null,
      title: `${isLaunchCycle ? 'Launch cycle complete' : 'Daily cycle complete'} — ${tasksRun} tasks run`,
      detail: { cycleId, tasksRun, errors, summary }
    });

    emitToBusiness(business.id, {
      event: 'cycle:complete',
      cycleId,
      tasksRun,
      errors,
      summary,
      cadence,
      workspace: {
        sync: workspaceSync.results,
        automation: workspaceAutomation.summary
      }
    });

    if (user) {
      emitToUser(user.id, {
        event: 'cycle:complete',
        businessName: business.name,
        businessId: business.id,
        summary,
        tasksRun
      });
    }

    console.log(`✅ Cycle complete for ${business.name}: ${tasksRun} tasks, ${errors} errors`);
    return { cycleId, tasksRun, errors, summary };

  } catch (err) {
    db.prepare(`
      UPDATE agent_cycles SET status='failed', error=?, completed_at=datetime('now') WHERE id=?
    `).run(err.message, cycleId);

    const cadence = markCycleRun(business.id, new Date(), { failure: true });
    emitToBusiness(business.id, { event: 'cycle:failed', cycleId, error: err.message });
    openRecoveryCase({
      businessId: business.id,
      sourceType: 'cycle',
      sourceId: cycleId,
      severity: 'critical',
      title: `Cycle failed: ${business.name}`,
      summary: err.message,
      detail: {
        cycleId,
        triggeredBy,
        error: err.message
      },
      retryAction: business.status === 'active'
        ? {
            type: 'cycle'
          }
        : null
    });
    emitToBusiness(business.id, { event: 'cadence:updated', businessId: business.id, cadence });
    throw err;
  }
}

export function getRunningCycle(businessId) {
  const db = getDb();
  return db.prepare(`
    SELECT id, business_id, status, triggered_by, started_at, created_at
    FROM agent_cycles
    WHERE business_id = ?
      AND status = 'running'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(businessId) || null;
}

export function startBusinessCycleIfIdle(business, triggeredBy = 'cron') {
  const running = getRunningCycle(business.id);
  if (running) {
    return {
      started: false,
      cycleId: running.id,
      running
    };
  }

  return {
    started: true,
    cycleId: null,
    promise: runBusinessCycle(business, triggeredBy)
  };
}

// ─── AI-generated cycle tasks ─────────────────────────────────────────────────
// The agent analyses the business state and decides what to work on this cycle

async function generateCycleTasks(business) {
  const db = getDb();
  const memory = JSON.parse(business.agent_memory || '{}');
  const { getWorkspacePromptContext } = await import('../integrations/workspace-sync.js');
  const latestPlan = getLatestArtifactByKind(business.id, 'launch_plan');
  const siteFile = getPublishedSiteFile(business.id, 'index.html');
  const siteHeadline = extractSiteHeadline(siteFile);
  const recentActivity = db.prepare(`
    SELECT type, department, title FROM activity
    WHERE business_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(business.id);
  const recentTasks = db.prepare(`
    SELECT title
    FROM tasks
    WHERE business_id = ?
    ORDER BY created_at DESC
    LIMIT 16
  `).all(business.id);

  const recentMetrics = db.prepare(`
    SELECT * FROM metrics WHERE business_id = ? ORDER BY date DESC LIMIT 7
  `).all(business.id);
  const workspace = getWorkspacePromptContext(business.id);
  const existingTitles = new Set(
    [
      ...getQueuedTasks(business.id, 20).map(task => task.title),
      ...recentTasks.map(task => task.title)
    ].map(title => cleanString(title).toLowerCase()).filter(Boolean)
  );
  const fallbackTasks = buildFallbackCycleTasks({
    business,
    memory,
    workspace,
    latestPlan,
    siteHeadline,
    existingTitles
  });

  // Use a fast, focused call to decide what to work on
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const { ANTHROPIC_API_KEY, AGENT_MODEL } = await import('../config.js');
  if (!ANTHROPIC_API_KEY) return fallbackTasks;
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const prompt = `You are deciding what tasks to execute for ${business.name} today.

Business goal: ${business.goal_90d}
Day: ${business.day_count}
Current MRR: $${(business.mrr_cents / 100).toFixed(2)}
Business memory: ${JSON.stringify(memory, null, 2)}
Workspace snapshot: ${JSON.stringify(workspace, null, 2)}
Latest launch plan: ${JSON.stringify(latestPlan?.metadata || {}, null, 2)}
Current site headline: ${siteHeadline || 'No live headline yet'}

Recent activity: ${JSON.stringify(recentActivity, null, 2)}
Recent metrics: ${JSON.stringify(recentMetrics, null, 2)}
Existing queued/recent task titles: ${JSON.stringify([...existingTitles], null, 2)}

Return a JSON array of 3-5 tasks to execute today. Each task: { title, description, department }.
Departments: engineering | marketing | operations | strategy | sales | finance
Focus on highest-impact actions toward the 90-day goal. Use the inbox, calendar, and accounting context where relevant. Vary departments each cycle.
Every task must be specific to ${business.name}, mention a concrete deliverable, and be something Ventura can actually execute this cycle.
Do not output placeholder/meta tasks like "write the business plan", "define the MVP", or "build the full app".
Do not repeat existing queued or recently completed work unless the task explicitly says it is a revision or retry.

IMPORTANT: Return ONLY a JSON array, no other text.`;

  try {
    const response = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0].text.trim();
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const normalized = Array.isArray(parsed)
      ? parsed
        .map(task => normalizeTaskCandidate(task, business))
        .filter(Boolean)
        .filter(task => !existingTitles.has(cleanString(task.title).toLowerCase()))
      : [];
    return normalized.length ? normalized.slice(0, 5) : fallbackTasks;
  } catch (err) {
    // Fallback tasks if AI generation fails
    console.error('Task generation failed, using fallback tasks:', err.message);
    return fallbackTasks;
  }
}

// ─── Cycle summary generator ──────────────────────────────────────────────────

async function generateCycleSummary(business, tasksRun, errors, cycleId, triggeredBy = 'cron') {
  const db = getDb();
  const cycleTasks = db.prepare(`
    SELECT title, department, description, status, result, error
    FROM tasks
    WHERE business_id = ?
      AND cycle_id = ?
    ORDER BY created_at ASC
  `).all(business.id, cycleId).map(task => ({
    ...task,
    result: safeParseJson(task.result, {})
  }));
  const completedTasks = cycleTasks.filter(task => task.status === 'complete');
  const failedTasks = cycleTasks.filter(task => task.status === 'failed');
  const queuedTasks = getQueuedTasks(business.id, 6);
  const fallback = buildCycleSummaryFallback({
    business,
    tasksRun,
    errors,
    completedTasks,
    failedTasks,
    queuedTasks
  });

  if (!AGENT_MODEL) return fallback;

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const { ANTHROPIC_API_KEY, AGENT_MODEL } = await import('../config.js');
    if (!ANTHROPIC_API_KEY) return fallback;
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: 220,
      messages: [{
        role: 'user',
        content: `Write a single founder-facing cycle summary sentence for ${business.name}.

Business goal: ${business.goal_90d}
Cycle trigger: ${triggeredBy}
Tasks run: ${tasksRun}
Errors: ${errors}
Completed tasks: ${JSON.stringify(completedTasks.map(task => ({
  title: task.title,
  department: task.department,
  summary: clipText(task.result?.summary || task.description, 140)
})), null, 2)}
Failed tasks: ${JSON.stringify(failedTasks.map(task => ({
  title: task.title,
  department: task.department,
  error: clipText(task.error, 140)
})), null, 2)}
Next queued: ${JSON.stringify(queuedTasks.slice(0, 3).map(task => task.title), null, 2)}

Rules:
- Be specific about what Ventura actually completed.
- Mention the next most important queued step if one exists.
- Do not ask the founder for more information.
- Do not mention hiring a developer or doing the work manually.
- Keep it under 38 words.`
      }]
    });

    const summary = cleanString(response.content[0].text);
    if (!summary || /\?/.test(summary) || /(hire a developer|build it yourself|use carrd|use framer|manually do)/i.test(summary)) {
      return fallback;
    }
    return summary;
  } catch {
    return fallback;
  }
}
