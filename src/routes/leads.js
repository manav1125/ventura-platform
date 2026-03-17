// src/routes/leads.js
// CRM / leads pipeline for each business

import express from 'express';
import { v4 as uuid } from 'uuid';
import { requireAuth } from '../auth/auth.js';
import { getDb } from '../db/migrate.js';
import { logActivity } from '../agents/activity.js';

const router = express.Router({ mergeParams: true }); // mergeParams to access :bizId

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Middleware: confirm business belongs to user
async function ownsBusiness(req, res, next) {
  const db = getDb();
  const biz = db.prepare('SELECT id FROM businesses WHERE id=? AND user_id=?')
    .get(req.params.bizId, req.user.sub);
  if (!biz) return res.status(404).json({ error: 'Business not found' });
  req.businessId = req.params.bizId;
  next();
}

router.use(requireAuth, ownsBusiness);

// GET /api/businesses/:bizId/leads
router.get('/', asyncHandler(async (req, res) => {
  const db = getDb();
  const { status, source, limit = 100 } = req.query;

  let query = 'SELECT * FROM leads WHERE business_id=?';
  const params = [req.businessId];

  if (status) { query += ' AND status=?'; params.push(status); }
  if (source) { query += ' AND source=?'; params.push(source); }
  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(parseInt(limit));

  const leads = db.prepare(query).all(...params);

  // Summary counts by status
  const summary = db.prepare(`
    SELECT status, COUNT(*) as count FROM leads
    WHERE business_id=? GROUP BY status
  `).all(req.businessId);

  res.json({ leads, summary });
}));

// POST /api/businesses/:bizId/leads
router.post('/', asyncHandler(async (req, res) => {
  const db = getDb();
  const { name, email, company, source = 'other', notes } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  const id = uuid();
  db.prepare(`
    INSERT INTO leads (id, business_id, name, email, company, source, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.businessId, name || null, email, company || null, source, notes || null);

  await logActivity(req.businessId, {
    type: 'lead', department: 'sales',
    title: `Lead added: ${name || email}${company ? ' @ ' + company : ''}`,
    detail: { id, email, source }
  });

  res.status(201).json({ leadId: id });
}));

// PATCH /api/businesses/:bizId/leads/:id — update status, notes
router.patch('/:id', asyncHandler(async (req, res) => {
  const db = getDb();
  const lead = db.prepare('SELECT * FROM leads WHERE id=? AND business_id=?')
    .get(req.params.id, req.businessId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const allowed = ['status', 'notes', 'last_contact', 'name', 'company'];
  const updates = Object.entries(req.body)
    .filter(([k]) => allowed.includes(k) && req.body[k] !== undefined);

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  const setClauses = updates.map(([k]) => `${k}=?`).join(', ');
  const values = [...updates.map(([, v]) => v), req.params.id];
  db.prepare(`UPDATE leads SET ${setClauses} WHERE id=?`).run(...values);

  if (req.body.status && req.body.status !== lead.status) {
    await logActivity(req.businessId, {
      type: 'lead', department: 'sales',
      title: `Lead ${lead.name || lead.email} → ${req.body.status}`,
      detail: { from: lead.status, to: req.body.status }
    });
  }

  res.json({ success: true });
}));

// DELETE /api/businesses/:bizId/leads/:id
router.delete('/:id', asyncHandler(async (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM leads WHERE id=? AND business_id=?').run(req.params.id, req.businessId);
  res.json({ success: true });
}));

// GET /api/businesses/:bizId/leads/export — CSV download
router.get('/export/csv', asyncHandler(async (req, res) => {
  const db = getDb();
  const leads = db.prepare('SELECT * FROM leads WHERE business_id=? ORDER BY created_at DESC').all(req.businessId);

  const header = 'name,email,company,status,source,notes,created_at\n';
  const rows = leads.map(l =>
    [l.name, l.email, l.company, l.status, l.source, l.notes, l.created_at]
      .map(v => `"${(v || '').replace(/"/g, '""')}"`)
      .join(',')
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="leads-${req.businessId}.csv"`);
  res.send(header + rows);
}));

export default router;
