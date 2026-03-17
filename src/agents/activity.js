// src/agents/activity.js
// Centralised activity logger — writes to DB and pushes via WebSocket

import { v4 as uuid } from 'uuid';
import { getDb } from '../db/migrate.js';
import { emitToBusiness } from '../ws/websocket.js';

export async function logActivity(businessId, { type, department, title, detail }) {
  const db = getDb();
  const id = uuid();
  const created_at = new Date().toISOString();

  db.prepare(`
    INSERT INTO activity (id, business_id, type, department, title, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, businessId, type, department || null, title, JSON.stringify(detail || {}), created_at);

  // Push live to any connected WebSocket clients watching this business
  emitToBusiness(businessId, {
    event: 'activity:new',
    activity: { id, type, department, title, detail, created_at }
  });

  return id;
}

export function getRecentActivity(businessId, limit = 50) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM activity
    WHERE business_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(businessId, limit);
}
