// src/routes/index.js
// All REST API routes mounted under /api

import express from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import {
  registerUser, loginUser, issueTokens, rotateRefreshToken,
  requireAuth, getUserById
} from '../auth/auth.js';
import { provisionBusiness } from '../provisioning/provision.js';
import { runBusinessCycle } from '../agents/runner.js';
import { queueTask, getAllTasks, getQueuedTasks } from '../agents/tasks.js';
import { listApprovals, decideApproval } from '../agents/approvals.js';
import { getRecentActivity } from '../agents/activity.js';
import { getDb } from '../db/migrate.js';
import { getStats } from '../ws/websocket.js';
import { handleStripeWebhook } from '../integrations/stripe.js';
import { getDeployments } from '../integrations/deploy.js';
import { listIntegrations, seedDefaultIntegrations } from '../integrations/registry.js';
import { getPlanDefinition, serializePlan } from '../billing/plans.js';
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, AGENT_MODEL } from '../config.js';

const router = express.Router();

// ─── Validation helpers ───────────────────────────────────────────────────────

function validate(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const messages = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
    throw Object.assign(new Error(messages.join(', ')), { statusCode: 400 });
  }
  return result.data;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function getUserUsage(db, userId, plan) {
  const limits = getPlanDefinition(plan).limits;
  const tasksUsed = db.prepare(`
    SELECT COUNT(*) AS n
    FROM tasks t
    JOIN businesses b ON b.id = t.business_id
    WHERE b.user_id = ?
      AND t.triggered_by = 'user'
      AND date(t.created_at) >= date('now', 'start of month')
  `).get(userId).n;
  const businessCount = db.prepare('SELECT COUNT(*) AS n FROM businesses WHERE user_id = ?').get(userId).n;

  return {
    tasks: {
      used: tasksUsed,
      limit: limits.tasks_per_month,
      remaining: Math.max(0, limits.tasks_per_month - tasksUsed)
    },
    businesses: {
      used: businessCount,
      limit: limits.businesses,
      remaining: Math.max(0, limits.businesses - businessCount)
    }
  };
}

function getSpecialistSummary(db, businessId) {
  const rows = db.prepare(`
    SELECT department,
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
           MAX(created_at) AS last_run
    FROM tasks
    WHERE business_id = ?
    GROUP BY department
  `).all(businessId);

  const mapped = {
    planning: { id: 'planning', label: 'Planning', departments: ['strategy'], total: 0, completed: 0, running: 0, last_run: null },
    engineering: { id: 'engineering', label: 'Engineering', departments: ['engineering'], total: 0, completed: 0, running: 0, last_run: null },
    marketing: { id: 'marketing', label: 'Marketing', departments: ['marketing', 'sales'], total: 0, completed: 0, running: 0, last_run: null },
    operations: { id: 'operations', label: 'Operations', departments: ['operations', 'finance'], total: 0, completed: 0, running: 0, last_run: null }
  };

  for (const row of rows) {
    const bucket = row.department === 'strategy'
      ? mapped.planning
      : ['engineering'].includes(row.department)
        ? mapped.engineering
        : ['marketing', 'sales'].includes(row.department)
          ? mapped.marketing
          : mapped.operations;

    bucket.total += row.total || 0;
    bucket.completed += row.completed || 0;
    bucket.running += row.running || 0;
    if (!bucket.last_run || new Date(row.last_run) > new Date(bucket.last_run)) {
      bucket.last_run = row.last_run;
    }
  }

  return Object.values(mapped);
}

function getOwnedBusiness(db, businessId, userId) {
  return db.prepare('SELECT * FROM businesses WHERE id = ? AND user_id = ?').get(businessId, userId);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/auth/register
router.post('/auth/register', asyncHandler(async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    name: z.string().min(2).max(80),
    password: z.string().min(8)
  });
  const body = validate(schema, req.body);
  const user = await registerUser(body);
  const tokens = issueTokens(user);
  res.status(201).json({ user: { id: user.id, email: user.email, name: user.name }, ...tokens });
}));

// POST /api/auth/login
router.post('/auth/login', asyncHandler(async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    password: z.string()
  });
  const body = validate(schema, req.body);
  const user = await loginUser(body);
  const tokens = issueTokens(user);
  const safeUser = { id: user.id, email: user.email, name: user.name, plan: user.plan };
  res.json({ user: safeUser, ...tokens });
}));

// POST /api/auth/refresh
router.post('/auth/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  const tokens = rotateRefreshToken(refreshToken);
  res.json(tokens);
}));

// GET /api/auth/me
router.get('/auth/me', requireAuth, asyncHandler(async (req, res) => {
  const user = getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
}));

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/businesses — list all businesses for the logged-in user
router.get('/businesses', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const businesses = db.prepare(`
    SELECT id, name, slug, type, status, day_count, web_url, email_address,
           mrr_cents, total_revenue_cents, created_at
    FROM businesses WHERE user_id = ? ORDER BY created_at DESC
  `).all(req.user.sub);
  res.json({ businesses });
}));

// POST /api/businesses — launch a new business
router.post('/businesses', requireAuth, asyncHandler(async (req, res) => {
  const schema = z.object({
    name: z.string().min(2).max(100),
    type: z.enum(['saas', 'agency', 'ecommerce', 'content', 'marketplace', 'education', 'other']),
    description: z.string().min(20).max(2000),
    targetCustomer: z.string().min(5).max(500),
    goal90d: z.string().min(5).max(500),
    involvement: z.enum(['autopilot', 'review', 'daily']).default('autopilot')
  });
  const body = validate(schema, req.body);

  // Plan limits
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.sub);
  const usage = getUserUsage(db, req.user.sub, user.plan);

  if (usage.businesses.used >= usage.businesses.limit) {
    return res.status(403).json({ error: `Plan limit reached. Upgrade to add more businesses.` });
  }

  res.status(202).json({ message: 'Provisioning started', status: 'provisioning' });

  // Kick off provisioning in the background (don't await)
  provisionBusiness({ userId: req.user.sub, ...body })
    .then(result => console.log(`✅ Business provisioned: ${result.businessId}`))
    .catch(err => console.error(`❌ Provisioning failed: ${err.message}`));
}));

// GET /api/businesses/:id — get a single business
router.get('/businesses/:id', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  // Parse JSON field
  business.agent_memory = JSON.parse(business.agent_memory || '{}');
  res.json({ business });
}));

// PATCH /api/businesses/:id — update business settings
router.patch('/businesses/:id', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const schema = z.object({
    name: z.string().min(2).max(100).optional(),
    type: z.enum(['saas', 'agency', 'ecommerce', 'content', 'marketplace', 'education', 'other']).optional(),
    description: z.string().optional(),
    goal90d: z.string().optional(),
    involvement: z.enum(['autopilot', 'review', 'daily']).optional(),
    status: z.enum(['active', 'paused']).optional()
  });
  const rawBody = validate(schema, req.body);
  const body = {
    ...rawBody,
    goal_90d: rawBody.goal90d
  };
  delete body.goal90d;

  const updates = Object.entries(body)
    .filter(([_, v]) => v !== undefined)
    .map(([k, _]) => `${k} = ?`).join(', ');
  const values = [...Object.values(body).filter(v => v !== undefined), req.params.id];

  if (updates) {
    db.prepare(`UPDATE businesses SET ${updates}, updated_at=datetime('now') WHERE id=?`).run(...values);
  }

  res.json({ success: true });
}));

// ─────────────────────────────────────────────────────────────────────────────
// AGENT ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/businesses/:id/run — manually trigger agent cycle
router.post('/businesses/:id/run', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Business not found' });
  if (business.status !== 'active') return res.status(400).json({ error: 'Business is not active' });

  // Check no cycle already running
  const running = db.prepare(`SELECT id FROM agent_cycles WHERE business_id=? AND status='running'`).get(req.params.id);
  if (running) return res.status(409).json({ error: 'A cycle is already running', cycleId: running.id });

  res.status(202).json({ message: 'Agent cycle started', businessId: req.params.id });

  // Run in background
  runBusinessCycle(business, 'manual')
    .catch(err => console.error(`Manual cycle failed: ${err.message}`));
}));

// GET /api/businesses/:id/cycles — list agent cycles
router.get('/businesses/:id/cycles', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const cycles = db.prepare(`
    SELECT * FROM agent_cycles WHERE business_id=? ORDER BY created_at DESC LIMIT 30
  `).all(req.params.id);
  res.json({ cycles });
}));

// ─────────────────────────────────────────────────────────────────────────────
// TASK ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/businesses/:id/tasks
router.get('/businesses/:id/tasks', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });
  const tasks = getAllTasks(req.params.id, 100);
  res.json({ tasks });
}));

// POST /api/businesses/:id/tasks — queue a task manually
router.post('/businesses/:id/tasks', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const user = db.prepare('SELECT plan FROM users WHERE id=?').get(req.user.sub);
  const usage = getUserUsage(db, req.user.sub, user.plan);
  if (usage.tasks.used >= usage.tasks.limit) {
    return res.status(403).json({ error: `Monthly founder task limit reached for ${user.plan}.` });
  }

  const schema = z.object({
    title: z.string().min(3).max(300),
    description: z.string().optional(),
    department: z.enum(['engineering', 'marketing', 'operations', 'strategy', 'sales', 'finance']),
    priority: z.number().int().min(1).max(10).default(3)
  });
  const body = validate(schema, req.body);

  const taskId = await queueTask({
    businessId: req.params.id,
    ...body,
    triggeredBy: 'user'
  });
  res.status(201).json({ taskId });
}));

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/businesses/:id/activity
router.get('/businesses/:id/activity', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });
  const limit = parseInt(req.query.limit) || 50;
  const activity = getRecentActivity(req.params.id, limit);
  res.json({ activity });
}));

// ─────────────────────────────────────────────────────────────────────────────
// METRICS ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/businesses/:id/metrics
router.get('/businesses/:id/metrics', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = db.prepare('SELECT id,mrr_cents,total_revenue_cents,day_count FROM businesses WHERE id=? AND user_id=?')
    .get(req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const daily = db.prepare(`
    SELECT * FROM metrics WHERE business_id=? ORDER BY date DESC LIMIT 30
  `).all(req.params.id);

  const leads = db.prepare(`
    SELECT status, COUNT(*) as count FROM leads WHERE business_id=? GROUP BY status
  `).all(req.params.id);

  res.json({ business, daily, leads });
}));

// ─────────────────────────────────────────────────────────────────────────────
// CHAT ROUTES (agent conversation)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/businesses/:id/messages
router.get('/businesses/:id/messages', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const messages = db.prepare(`
    SELECT * FROM messages WHERE business_id=? ORDER BY created_at ASC LIMIT 100
  `).all(req.params.id);
  res.json({ messages });
}));

// POST /api/businesses/:id/messages — send a message to the agent
router.post('/businesses/:id/messages', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const schema = z.object({ content: z.string().min(1).max(4000) });
  const { content } = validate(schema, req.body);

  // Save user message
  const userMsgId = uuid();
  db.prepare(`INSERT INTO messages (id, business_id, role, content) VALUES (?, ?, 'user', ?)`).run(userMsgId, req.params.id, content);

  // Build history for context
  const history = db.prepare(`
    SELECT role, content FROM messages WHERE business_id=? ORDER BY created_at ASC LIMIT 20
  `).all(req.params.id);

  // Get agent reply
  const memory = JSON.parse(business.agent_memory || '{}');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const systemPrompt = `You are the AI operator for "${business.name}", a ${business.type} business. You have been running this business for ${business.day_count} days.

Current MRR: $${(business.mrr_cents / 100).toFixed(2)}
Website: ${business.web_url}
Goal: ${business.goal_90d}

Memory context: ${JSON.stringify(memory, null, 2)}

You are talking directly with the founder. Be direct, specific, and helpful. Reference real data about the business when relevant. You can suggest tasks, explain decisions you made, and give strategic advice. Keep responses conversational and under 200 words.`;

  const aiResponse = await client.messages.create({
    model: AGENT_MODEL,
    max_tokens: 512,
    system: systemPrompt,
    messages: history.map(m => ({ role: m.role, content: m.content }))
  });

  const aiContent = aiResponse.content[0].text;

  // Save AI reply
  const aiMsgId = uuid();
  db.prepare(`INSERT INTO messages (id, business_id, role, content) VALUES (?, ?, 'assistant', ?)`).run(aiMsgId, req.params.id, aiContent);

  // Push via WebSocket
  const { emitToBusiness } = await import('../ws/websocket.js');
  emitToBusiness(req.params.id, { event: 'message:new', role: 'assistant', content: aiContent, id: aiMsgId });

  res.json({ message: { id: aiMsgId, role: 'assistant', content: aiContent } });
}));

// GET /api/businesses/:id/deployments
router.get('/businesses/:id/deployments', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });
  res.json({ deployments: getDeployments(req.params.id, 30) });
}));

// GET /api/businesses/:id/approvals
router.get('/businesses/:id/approvals', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });
  res.json({ approvals: listApprovals(req.params.id, { status: req.query.status || null, limit: parseInt(req.query.limit || '25', 10) }) });
}));

// POST /api/businesses/:id/approvals/:approvalId/decision
router.post('/businesses/:id/approvals/:approvalId/decision', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const schema = z.object({
    decision: z.enum(['approve', 'reject']),
    note: z.string().max(500).optional()
  });
  const body = validate(schema, req.body);
  const approval = await decideApproval({
    approvalId: req.params.approvalId,
    businessId: req.params.id,
    userId: req.user.sub,
    decision: body.decision,
    note: body.note || ''
  });
  res.json({ approval });
}));

// GET /api/businesses/:id/control-center
router.get('/businesses/:id/control-center', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(req.user.sub);
  const recentCycles = db.prepare(`
    SELECT id, status, triggered_by, started_at, completed_at, tasks_run, summary, error, created_at
    FROM agent_cycles
    WHERE business_id = ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(req.params.id);

  const latestCycle = recentCycles[0] || null;
  const approvals = listApprovals(req.params.id, { limit: 10 });
  let deployments = getDeployments(req.params.id, 10);
  let integrations = listIntegrations(req.params.id);
  if (!integrations.length) {
    seedDefaultIntegrations({
      businessId: business.id,
      slug: business.slug,
      emailAddress: business.email_address,
      webUrl: business.web_url,
      stripeAccountId: business.stripe_account_id
    });
    integrations = listIntegrations(req.params.id);
  }
  if (!deployments.length) {
    deployments = db.prepare(`
      SELECT id,
             business_id,
             printf('activity-%s', substr(id, 1, 8)) AS version,
             title AS description,
             0 AS files_changed,
             'live' AS status,
             created_at
      FROM activity
      WHERE business_id = ? AND type = 'deploy'
      ORDER BY created_at DESC
      LIMIT 10
    `).all(req.params.id);
  }
  const specialists = getSpecialistSummary(db, req.params.id);
  const recentActivity = getRecentActivity(req.params.id, 8);
  const usage = getUserUsage(db, req.user.sub, user.plan);

  res.json({
    business,
    latestCycle,
    recentCycles,
    recentActivity,
    approvals,
    deployments,
    integrations,
    specialists,
    usage,
    plan: serializePlan(user.plan)
  });
}));

// GET /api/live — public transparency feed
router.get('/live', asyncHandler(async (req, res) => {
  const db = getDb();
  const feed = db.prepare(`
    SELECT a.id, a.type, a.department, a.title, a.created_at,
           b.name AS business_name, b.slug AS business_slug
    FROM activity a
    JOIN businesses b ON b.id = a.business_id
    ORDER BY a.created_at DESC
    LIMIT 40
  `).all();
  res.json({ feed });
}));

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE WEBHOOK (raw body needed)
// ─────────────────────────────────────────────────────────────────────────────

router.post('/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  asyncHandler(handleStripeWebhook)
);

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    ws: getStats()
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ERROR HANDLER
// ─────────────────────────────────────────────────────────────────────────────

router.use((err, req, res, next) => {
  console.error(`API Error [${req.method} ${req.path}]:`, err.message);

  if (err.message === 'EMAIL_TAKEN') return res.status(409).json({ error: 'Email already registered' });
  if (err.message === 'INVALID_CREDENTIALS') return res.status(401).json({ error: 'Invalid email or password' });
  if (err.message === 'INVALID_REFRESH_TOKEN') return res.status(401).json({ error: 'Invalid or expired refresh token' });
  if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });

  res.status(500).json({ error: err.message || 'Internal server error' });
});

export default router;
