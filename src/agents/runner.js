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
import { getQueuedTasks, startTask, completeTask, failTask, queueTask } from './tasks.js';
import { logActivity } from './activity.js';
import { emitToBusiness, emitToUser } from '../ws/websocket.js';
import { AGENT_CRON_SCHEDULE } from '../config.js';

// ─── Cron scheduler ───────────────────────────────────────────────────────────

export function startAgentScheduler() {
  console.log(`🤖 Agent scheduler started — cron: "${AGENT_CRON_SCHEDULE}"`);

  cron.schedule(AGENT_CRON_SCHEDULE, async () => {
    console.log(`\n🔁 [${new Date().toISOString()}] Starting daily agent run for all businesses`);
    await runAllBusinesses('cron');
  });
}

// ─── Run all active businesses ────────────────────────────────────────────────

export async function runAllBusinesses(triggeredBy = 'cron') {
  const db = getDb();
  const businesses = db.prepare(`SELECT * FROM businesses WHERE status = 'active'`).all();

  console.log(`📊 Running agents for ${businesses.length} active businesses`);

  // Run sequentially to manage API rate limits
  // In production, parallelise with a concurrency limiter
  for (const business of businesses) {
    try {
      await runBusinessCycle(business, triggeredBy);
    } catch (err) {
      console.error(`❌ Failed cycle for ${business.name}: ${err.message}`);
    }
  }
}

// ─── Single business cycle ────────────────────────────────────────────────────

export async function runBusinessCycle(business, triggeredBy = 'cron') {
  const db = getDb();
  const cycleId = uuid();

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
    // ── Generate new tasks for this cycle ────────────────────────────────────
    const newTasks = await generateCycleTasks(business);
    for (const t of newTasks) {
      await queueTask({ businessId: business.id, ...t, cycleId, triggeredBy: 'agent', priority: 3 });
    }

    // ── Run all queued tasks ──────────────────────────────────────────────────
    const tasks = getQueuedTasks(business.id, 8); // max 8 tasks per cycle

    for (const task of tasks) {
      try {
        console.log(`  → Task: ${task.title} [${task.department}]`);
        startTask(task.id, cycleId);

        const result = await runTask(task, business);
        completeTask(task.id, result);
        tasksRun++;

        console.log(`  ✓ Done: ${task.title}`);

        // Queue suggested follow-up tasks
        if (result.nextSteps?.length) {
          for (const step of result.nextSteps.slice(0, 2)) {
            await queueTask({
              businessId: business.id,
              title: step,
              department: task.department,
              triggeredBy: 'agent',
              priority: 5,
              cycleId
            });
          }
        }

      } catch (err) {
        failTask(task.id, err.message);
        errors++;
        console.error(`  ✗ Failed: ${task.title} — ${err.message}`);

        await logActivity(business.id, {
          type: 'alert',
          department: task.department,
          title: `Task failed: ${task.title}`,
          detail: { error: err.message }
        });
      }
    }

    // ── Update day count and metrics ──────────────────────────────────────────
    db.prepare(`
      UPDATE businesses
      SET day_count = day_count + 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(business.id);

    // Refresh business object for summary
    const updatedBusiness = db.prepare('SELECT * FROM businesses WHERE id=?').get(business.id);

    // ── Generate cycle summary via AI ─────────────────────────────────────────
    const summary = await generateCycleSummary(updatedBusiness, tasksRun, errors);

    // ── Complete cycle record ─────────────────────────────────────────────────
    db.prepare(`
      UPDATE agent_cycles
      SET status='complete', completed_at=datetime('now'), tasks_run=?, summary=?
      WHERE id=?
    `).run(tasksRun, summary, cycleId);

    await logActivity(business.id, {
      type: 'cycle_complete',
      department: null,
      title: `Daily cycle complete — ${tasksRun} tasks run`,
      detail: { cycleId, tasksRun, errors, summary }
    });

    emitToBusiness(business.id, {
      event: 'cycle:complete',
      cycleId,
      tasksRun,
      errors,
      summary
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

    emitToBusiness(business.id, { event: 'cycle:failed', cycleId, error: err.message });
    throw err;
  }
}

// ─── AI-generated cycle tasks ─────────────────────────────────────────────────
// The agent analyses the business state and decides what to work on this cycle

async function generateCycleTasks(business) {
  const db = getDb();
  const memory = JSON.parse(business.agent_memory || '{}');
  const recentActivity = db.prepare(`
    SELECT type, department, title FROM activity
    WHERE business_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(business.id);

  const recentMetrics = db.prepare(`
    SELECT * FROM metrics WHERE business_id = ? ORDER BY date DESC LIMIT 7
  `).all(business.id);

  // Use a fast, focused call to decide what to work on
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const { ANTHROPIC_API_KEY, AGENT_MODEL } = await import('../config.js');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const prompt = `You are deciding what tasks to execute for ${business.name} today.

Business goal: ${business.goal_90d}
Day: ${business.day_count}
Current MRR: $${(business.mrr_cents / 100).toFixed(2)}
Business memory: ${JSON.stringify(memory, null, 2)}

Recent activity: ${JSON.stringify(recentActivity, null, 2)}
Recent metrics: ${JSON.stringify(recentMetrics, null, 2)}

Return a JSON array of 3-5 tasks to execute today. Each task: { title, description, department }.
Departments: engineering | marketing | operations | strategy | sales | finance
Focus on highest-impact actions toward the 90-day goal. Vary departments each cycle.

IMPORTANT: Return ONLY a JSON array, no other text.`;

  try {
    const response = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0].text.trim();
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    // Fallback tasks if AI generation fails
    console.error('Task generation failed, using fallback tasks:', err.message);
    return [
      { title: 'Review and improve website conversion rate', department: 'engineering', description: 'Analyse the current website and make improvements to increase visitor-to-lead conversion.' },
      { title: 'Send weekly progress email to leads', department: 'marketing', description: 'Write and send a value-adding email to all leads in the pipeline.' },
      { title: 'Handle inbox and respond to any outstanding messages', department: 'operations', description: 'Review the business inbox and respond to any messages that require attention.' },
    ];
  }
}

// ─── Cycle summary generator ──────────────────────────────────────────────────

async function generateCycleSummary(business, tasksRun, errors) {
  if (!AGENT_MODEL) return `Completed ${tasksRun} tasks.`;

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const { ANTHROPIC_API_KEY, AGENT_MODEL } = await import('../config.js');
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Write a 1-sentence summary for the founder of ${business.name}. Today's agent ran ${tasksRun} tasks (${errors} errors). MRR: $${(business.mrr_cents / 100).toFixed(2)}, day ${business.day_count}. Be specific and action-oriented, mention the most impactful thing done.`
      }]
    });

    return response.content[0].text.trim();
  } catch {
    return `Completed ${tasksRun} tasks across engineering, marketing, and operations.`;
  }
}
