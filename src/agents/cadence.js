import { getDb } from '../db/migrate.js';

function clampHour(value, fallback = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(23, Math.floor(n)));
}

function clampInterval(value, fallback = 24) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(168, Math.floor(n)));
}

export function normalizeCadence(input = {}) {
  const mode = ['daily', 'hourly', 'manual'].includes(input?.cadence_mode || input?.mode)
    ? (input.cadence_mode || input.mode)
    : 'daily';
  const intervalHours = clampInterval(input?.cadence_interval_hours ?? input?.intervalHours, mode === 'hourly' ? 6 : 24);
  const preferredHourUtc = clampHour(input?.preferred_run_hour_utc ?? input?.preferredHourUtc, 2);
  return {
    mode,
    intervalHours,
    preferredHourUtc
  };
}

export function computeNextRunAt(input = {}, fromDate = new Date()) {
  const cadence = normalizeCadence(input);
  if (cadence.mode === 'manual') return null;

  const base = new Date(fromDate);
  if (cadence.mode === 'hourly') {
    base.setUTCMinutes(0, 0, 0);
    base.setUTCHours(base.getUTCHours() + cadence.intervalHours);
    return base.toISOString();
  }

  const next = new Date(base);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(cadence.preferredHourUtc, 0, 0, 0);
  if (next <= base) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

export function getCadenceSnapshot(business = {}) {
  const cadence = normalizeCadence(business);
  const nextRunAt = business.next_run_at || computeNextRunAt(cadence);
  return {
    mode: cadence.mode,
    interval_hours: cadence.intervalHours,
    preferred_run_hour_utc: cadence.preferredHourUtc,
    next_run_at: nextRunAt,
    last_cycle_at: business.last_cycle_at || null,
    paused: business.status === 'paused',
    label: cadence.mode === 'manual'
      ? 'Manual only'
      : cadence.mode === 'hourly'
        ? `Every ${cadence.intervalHours} hour${cadence.intervalHours === 1 ? '' : 's'}`
        : `Daily at ${String(cadence.preferredHourUtc).padStart(2, '0')}:00 UTC`
  };
}

export function ensureBusinessCadence(businessId) {
  const db = getDb();
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  if (!business) return null;

  const nextRunAt = business.next_run_at || computeNextRunAt(business);
  if (!business.next_run_at && nextRunAt) {
    db.prepare(`
      UPDATE businesses
      SET next_run_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(nextRunAt, businessId);
  }

  const refreshed = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  return getCadenceSnapshot(refreshed);
}

export function scheduleNextRun(businessId, overrides = {}, fromDate = new Date()) {
  const db = getDb();
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  if (!business) return null;

  const merged = {
    cadence_mode: overrides.mode ?? business.cadence_mode,
    cadence_interval_hours: overrides.intervalHours ?? business.cadence_interval_hours,
    preferred_run_hour_utc: overrides.preferredHourUtc ?? business.preferred_run_hour_utc
  };

  const nextRunAt = computeNextRunAt(merged, fromDate);
  db.prepare(`
    UPDATE businesses
    SET cadence_mode = ?,
        cadence_interval_hours = ?,
        preferred_run_hour_utc = ?,
        next_run_at = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    merged.cadence_mode,
    merged.cadence_interval_hours,
    merged.preferred_run_hour_utc,
    nextRunAt,
    businessId
  );

  const refreshed = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  return getCadenceSnapshot(refreshed);
}

export function markCycleRun(businessId, finishedAt = new Date(), { failure = false } = {}) {
  const db = getDb();
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  if (!business) return null;

  const cadence = normalizeCadence(business);
  let nextRunAt = null;
  if (cadence.mode !== 'manual') {
    const nextBase = failure && cadence.mode === 'daily'
      ? new Date(new Date(finishedAt).getTime() + (6 * 60 * 60 * 1000))
      : finishedAt;
    nextRunAt = computeNextRunAt(cadence, nextBase);
  }

  db.prepare(`
    UPDATE businesses
    SET last_cycle_at = ?,
        next_run_at = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(new Date(finishedAt).toISOString(), nextRunAt, businessId);

  const refreshed = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  return getCadenceSnapshot(refreshed);
}

export function isBusinessDue(business, now = new Date()) {
  if (!business || business.status !== 'active') return false;
  const cadence = normalizeCadence(business);
  if (cadence.mode === 'manual') return false;
  const nextRunAt = business.next_run_at || computeNextRunAt(cadence, new Date(Date.now() - 24 * 60 * 60 * 1000));
  if (!nextRunAt) return false;
  return new Date(nextRunAt) <= now;
}
