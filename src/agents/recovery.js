import { v4 as uuid } from 'uuid';
import { getDb } from '../db/migrate.js';

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hydrateRecoveryCase(row) {
  if (!row) return null;
  return {
    ...row,
    retryable: !!row.retryable,
    detail: parseJson(row.detail, {}),
    retry_action: parseJson(row.retry_action, null)
  };
}

function buildFingerprint({ businessId, sourceType, sourceId = null, title = '', summary = '' }) {
  if (sourceId) return `${businessId}:${sourceType}:${sourceId}`;
  return `${businessId}:${sourceType}:${title}:${summary}`.slice(0, 500);
}

export function getRecoveryCaseById(caseId) {
  const db = getDb();
  return hydrateRecoveryCase(db.prepare(`
    SELECT *
    FROM recovery_cases
    WHERE id = ?
  `).get(caseId));
}

export function listRecoveryCases(businessId, { status = 'open', limit = 20 } = {}) {
  const db = getDb();
  const rows = status
    ? db.prepare(`
        SELECT *
        FROM recovery_cases
        WHERE business_id = ?
          AND status = ?
        ORDER BY last_seen_at DESC, updated_at DESC
        LIMIT ?
      `).all(businessId, status, limit)
    : db.prepare(`
        SELECT *
        FROM recovery_cases
        WHERE business_id = ?
        ORDER BY last_seen_at DESC, updated_at DESC
        LIMIT ?
      `).all(businessId, limit);

  return rows.map(hydrateRecoveryCase);
}

export function getRecoverySummary(businessId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
      SUM(CASE WHEN status = 'open' AND severity = 'critical' THEN 1 ELSE 0 END) AS critical,
      SUM(CASE WHEN status = 'open' AND severity = 'attention' THEN 1 ELSE 0 END) AS attention,
      SUM(CASE WHEN status = 'open' AND retryable = 1 THEN 1 ELSE 0 END) AS retryable,
      SUM(occurrences) AS occurrences
    FROM recovery_cases
    WHERE business_id = ?
  `).get(businessId);

  return {
    total: Number(row?.total || 0),
    open: Number(row?.open || 0),
    resolved: Number(row?.resolved || 0),
    critical: Number(row?.critical || 0),
    attention: Number(row?.attention || 0),
    retryable: Number(row?.retryable || 0),
    occurrences: Number(row?.occurrences || 0)
  };
}

export function openRecoveryCase({
  businessId,
  sourceType,
  sourceId = null,
  severity = 'attention',
  title,
  summary = '',
  detail = {},
  retryAction = null
}) {
  const db = getDb();
  const fingerprint = buildFingerprint({ businessId, sourceType, sourceId, title, summary });
  const existing = db.prepare(`
    SELECT id
    FROM recovery_cases
    WHERE fingerprint = ?
  `).get(fingerprint);

  if (existing) {
    db.prepare(`
      UPDATE recovery_cases
      SET status = 'open',
          severity = ?,
          title = ?,
          summary = ?,
          detail = ?,
          retry_action = ?,
          retryable = ?,
          occurrences = occurrences + 1,
          resolved_at = NULL,
          resolution_note = NULL,
          last_seen_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      severity,
      title,
      summary || null,
      JSON.stringify(detail || {}),
      retryAction ? JSON.stringify(retryAction) : null,
      retryAction ? 1 : 0,
      existing.id
    );
    return getRecoveryCaseById(existing.id);
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO recovery_cases (
      id, business_id, source_type, source_id, fingerprint, severity, status, title, summary,
      detail, retry_action, retryable, occurrences, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
  `).run(
    id,
    businessId,
    sourceType,
    sourceId,
    fingerprint,
    severity,
    title,
    summary || null,
    JSON.stringify(detail || {}),
    retryAction ? JSON.stringify(retryAction) : null,
    retryAction ? 1 : 0
  );

  return getRecoveryCaseById(id);
}

export function resolveRecoveryCase(caseId, resolutionNote = '') {
  const db = getDb();
  db.prepare(`
    UPDATE recovery_cases
    SET status = 'resolved',
        resolution_note = ?,
        resolved_at = COALESCE(resolved_at, datetime('now')),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(resolutionNote || null, caseId);
  return getRecoveryCaseById(caseId);
}

export function resolveRecoveryCasesForSource(businessId, sourceType, sourceId, resolutionNote = '') {
  const db = getDb();
  db.prepare(`
    UPDATE recovery_cases
    SET status = 'resolved',
        resolution_note = ?,
        resolved_at = COALESCE(resolved_at, datetime('now')),
        updated_at = datetime('now')
    WHERE business_id = ?
      AND source_type = ?
      AND source_id = ?
      AND status = 'open'
  `).run(resolutionNote || null, businessId, sourceType, sourceId);
}
