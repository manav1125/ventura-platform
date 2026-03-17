// src/routes/admin.js
// Platform admin routes — protected by admin role
// Provides oversight of all users, businesses, agent cycles, and revenue

import express from 'express';
import { requireAuth } from '../auth/auth.js';
import { getDb } from '../db/migrate.js';
import { runAllBusinesses } from '../agents/runner.js';
import { broadcast, getStats } from '../ws/websocket.js';

const router = express.Router();

// ── Admin guard middleware ─────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// All admin routes require auth + admin role
router.use(requireAuth);
router.use(requireAdmin);

// ── Platform overview ─────────────────────────────────────────────────────────

// GET /api/admin/stats
router.get('/stats', asyncHandler(async (req, res) => {
  const db = getDb();

  const stats = {
    users: {
      total: db.prepare('SELECT COUNT(*) as n FROM users').get().n,
      by_plan: db.prepare('SELECT plan, COUNT(*) as n FROM users GROUP BY plan').all(),
      new_today: db.prepare("SELECT COUNT(*) as n FROM users WHERE date(created_at) = date('now')").get().n,
    },
    businesses: {
      total: db.prepare('SELECT COUNT(*) as n FROM businesses').get().n,
      active: db.prepare("SELECT COUNT(*) as n FROM businesses WHERE status='active'").get().n,
      by_type: db.prepare('SELECT type, COUNT(*) as n FROM businesses GROUP BY type').all(),
      new_today: db.prepare("SELECT COUNT(*) as n FROM businesses WHERE date(created_at) = date('now')").get().n,
    },
    revenue: {
      total_mrr_cents: db.prepare('SELECT COALESCE(SUM(mrr_cents),0) as n FROM businesses').get().n,
      total_revenue_cents: db.prepare('SELECT COALESCE(SUM(total_revenue_cents),0) as n FROM businesses').get().n,
    },
    agent: {
      cycles_today: db.prepare("SELECT COUNT(*) as n FROM agent_cycles WHERE date(created_at) = date('now')").get().n,
      tasks_today: db.prepare("SELECT COUNT(*) as n FROM tasks WHERE date(created_at) = date('now')").get().n,
      running_now: db.prepare("SELECT COUNT(*) as n FROM agent_cycles WHERE status='running'").get().n,
    },
    websocket: getStats(),
  };

  res.json({ stats });
}));

// GET /api/admin/users
router.get('/users', asyncHandler(async (req, res) => {
  const db = getDb();
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const offset = (page - 1) * limit;

  const users = db.prepare(`
    SELECT u.id, u.email, u.name, u.plan, u.created_at,
           COUNT(b.id) as business_count,
           COALESCE(SUM(b.mrr_cents), 0) as total_mrr_cents
    FROM users u
    LEFT JOIN businesses b ON b.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  const total = db.prepare('SELECT COUNT(*) as n FROM users').get().n;

  res.json({ users, total, page, pages: Math.ceil(total / limit) });
}));

// GET /api/admin/businesses
router.get('/businesses', asyncHandler(async (req, res) => {
  const db = getDb();
  const status = req.query.status;
  const query = status
    ? 'SELECT b.*, u.email as founder_email, u.name as founder_name FROM businesses b JOIN users u ON u.id = b.user_id WHERE b.status = ? ORDER BY b.created_at DESC LIMIT 100'
    : 'SELECT b.*, u.email as founder_email, u.name as founder_name FROM businesses b JOIN users u ON u.id = b.user_id ORDER BY b.created_at DESC LIMIT 100';

  const businesses = status
    ? db.prepare(query).all(status)
    : db.prepare(query).all();

  res.json({ businesses });
}));

// GET /api/admin/cycles — recent agent cycles across all businesses
router.get('/cycles', asyncHandler(async (req, res) => {
  const db = getDb();
  const cycles = db.prepare(`
    SELECT ac.*, b.name as business_name, b.slug, u.email as founder_email
    FROM agent_cycles ac
    JOIN businesses b ON b.id = ac.business_id
    JOIN users u ON u.id = b.user_id
    ORDER BY ac.created_at DESC
    LIMIT 100
  `).all();
  res.json({ cycles });
}));

// POST /api/admin/run-all — manually trigger cycles for all businesses
router.post('/run-all', asyncHandler(async (req, res) => {
  res.json({ message: 'Running all business cycles', status: 'started' });
  runAllBusinesses('admin_manual').catch(err => console.error('Admin run-all failed:', err));
}));

// POST /api/admin/broadcast — send a WebSocket message to all connected clients
router.post('/broadcast', asyncHandler(async (req, res) => {
  const { event, payload } = req.body;
  if (!event) return res.status(400).json({ error: 'event required' });
  broadcast({ event, ...payload });
  res.json({ sent: true, connections: getStats().totalConnections });
}));

// PATCH /api/admin/users/:id/plan — upgrade/downgrade a user's plan
router.patch('/users/:id/plan', asyncHandler(async (req, res) => {
  const { plan } = req.body;
  if (!['trial', 'builder', 'fleet'].includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan' });
  }
  const db = getDb();
  db.prepare("UPDATE users SET plan=?, updated_at=datetime('now') WHERE id=?").run(plan, req.params.id);
  res.json({ success: true });
}));

// DELETE /api/admin/businesses/:id — hard delete a business
router.delete('/businesses/:id', asyncHandler(async (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM businesses WHERE id=?').run(req.params.id);
  res.json({ success: true });
}));

export default router;
