// src/billing/usage.js
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/migrate.js';
import { getPlanDefinition } from './plans.js';
import {
  CREDIT_VALUE_CENTS,
  CREDIT_MARGIN_MULTIPLIER,
  DEFAULT_INPUT_CENTS_PER_MILLION,
  DEFAULT_OUTPUT_CENTS_PER_MILLION,
  DEFAULT_CACHED_INPUT_CENTS_PER_MILLION
} from '../config.js';

const MILLION = 1_000_000;

function nowIso() {
  return new Date().toISOString();
}

function startOfMonthIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function normalizeUsage(usage = {}) {
  return {
    input_tokens: Number(usage.input_tokens || usage.inputTokens || 0),
    output_tokens: Number(usage.output_tokens || usage.outputTokens || 0),
    cached_input_tokens: Number(
      usage.cached_input_tokens ||
      usage.cache_read_input_tokens ||
      usage.cache_read_input_tokens ||
      usage.cache_creation_input_tokens ||
      0
    )
  };
}

function getPriceRow(db, provider, model) {
  return db.prepare(`
    SELECT provider, model, input_cents_per_million, output_cents_per_million, cached_input_cents_per_million
    FROM price_book
    WHERE provider = ? AND model = ?
    LIMIT 1
  `).get(provider, model);
}

function resolveRates(db, provider, model) {
  const row = getPriceRow(db, provider, model);
  if (row) return row;
  return {
    provider,
    model,
    input_cents_per_million: DEFAULT_INPUT_CENTS_PER_MILLION,
    output_cents_per_million: DEFAULT_OUTPUT_CENTS_PER_MILLION,
    cached_input_cents_per_million: DEFAULT_CACHED_INPUT_CENTS_PER_MILLION
  };
}

function computeCostCents(usage, rates) {
  const normalized = normalizeUsage(usage);
  const input = (normalized.input_tokens / MILLION) * Number(rates.input_cents_per_million || 0);
  const output = (normalized.output_tokens / MILLION) * Number(rates.output_cents_per_million || 0);
  const cached = (normalized.cached_input_tokens / MILLION) * Number(rates.cached_input_cents_per_million || 0);
  const total = Math.round(input + output + cached);
  return Math.max(0, total);
}

function computeCreditsFromCost(costCents) {
  const multiplier = Number.isFinite(CREDIT_MARGIN_MULTIPLIER) ? CREDIT_MARGIN_MULTIPLIER : 2;
  const unit = Math.max(1, Number(CREDIT_VALUE_CENTS || 1));
  const scaled = Math.ceil((costCents * multiplier) / unit);
  return Math.max(1, scaled);
}

function ensureMonthlyReset(db, userId) {
  const user = db.prepare(`
    SELECT credits_monthly_used, credits_monthly_reset_at
    FROM users WHERE id = ?
  `).get(userId);
  const resetAt = user?.credits_monthly_reset_at;
  const startOfMonth = startOfMonthIso();
  if (!resetAt || new Date(resetAt) < new Date(startOfMonth)) {
    db.prepare(`
      UPDATE users
      SET credits_monthly_used = 0,
          credits_monthly_reset_at = ?
      WHERE id = ?
    `).run(startOfMonth, userId);
  }
}

export function getCreditsStatus(db, userId, plan = 'trial') {
  ensureMonthlyReset(db, userId);
  const user = db.prepare(`
    SELECT credits_bonus, credits_monthly_used, credits_monthly_reset_at
    FROM users WHERE id = ?
  `).get(userId) || {};
  const definition = getPlanDefinition(plan);
  const monthly = Number(definition.economics?.credits_per_month || 0);
  const used = Number(user.credits_monthly_used || 0);
  const bonus = Number(user.credits_bonus || 0);
  const remaining = Math.max(0, (monthly - used) + bonus);
  return {
    monthly_included: monthly,
    monthly_used: used,
    bonus,
    remaining,
    reset_at: user.credits_monthly_reset_at || startOfMonthIso()
  };
}

export function canSpendCredits(db, userId, plan, creditsNeeded = 1) {
  const status = getCreditsStatus(db, userId, plan);
  return status.remaining >= creditsNeeded;
}

export function consumeCredits(db, userId, plan, credits, note = null) {
  ensureMonthlyReset(db, userId);
  const status = getCreditsStatus(db, userId, plan);
  let remaining = status.remaining;
  if (remaining <= 0) return { consumed: 0, blocked: true, status };

  const creditsToConsume = Math.min(credits, remaining);
  let monthlyRemaining = Math.max(0, status.monthly_included - status.monthly_used);

  if (monthlyRemaining >= creditsToConsume) {
    db.prepare(`
      UPDATE users
      SET credits_monthly_used = credits_monthly_used + ?
      WHERE id = ?
    `).run(creditsToConsume, userId);
  } else {
    const fromMonthly = monthlyRemaining;
    const fromBonus = creditsToConsume - fromMonthly;
    db.prepare(`
      UPDATE users
      SET credits_monthly_used = credits_monthly_used + ?,
          credits_bonus = MAX(0, credits_bonus - ?)
      WHERE id = ?
    `).run(fromMonthly, fromBonus, userId);
  }

  if (note) {
    db.prepare(`
      INSERT INTO credit_ledger (id, user_id, type, credits, note, created_at)
      VALUES (?, ?, 'usage', ?, ?, ?)
    `).run(uuid(), userId, creditsToConsume, note, nowIso());
  }

  return {
    consumed: creditsToConsume,
    blocked: creditsToConsume < credits,
    status: getCreditsStatus(db, userId, plan)
  };
}

export function grantCredits(db, userId, credits, note = null, businessId = null) {
  db.prepare(`
    UPDATE users
    SET credits_bonus = credits_bonus + ?
    WHERE id = ?
  `).run(credits, userId);
  db.prepare(`
    INSERT INTO credit_ledger (id, user_id, business_id, type, credits, note, created_at)
    VALUES (?, ?, ?, 'topup', ?, ?, ?)
  `).run(uuid(), userId, businessId, credits, note || 'Credits top-up', nowIso());
  return getCreditsStatus(db, userId, db.prepare('SELECT plan FROM users WHERE id=?').get(userId).plan);
}

export function recordUsageEvent({
  db = null,
  businessId,
  userId,
  taskId = null,
  provider = 'anthropic',
  model = 'unknown',
  usage = {},
  kind = 'agent',
  note = null
}) {
  const database = db || getDb();
  const planRow = database.prepare('SELECT plan FROM users WHERE id = ?').get(userId);
  const plan = planRow?.plan || 'trial';
  const rates = resolveRates(database, provider, model);
  const normalized = normalizeUsage(usage);
  const costCents = computeCostCents(normalized, rates);
  const credits = computeCreditsFromCost(costCents);
  const id = uuid();

  database.prepare(`
    INSERT INTO usage_events (
      id, user_id, business_id, task_id, provider, model,
      input_tokens, output_tokens, cached_input_tokens,
      cost_cents, credits, kind, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    businessId,
    taskId,
    provider,
    model,
    normalized.input_tokens,
    normalized.output_tokens,
    normalized.cached_input_tokens,
    costCents,
    credits,
    kind,
    nowIso()
  );

  const consume = consumeCredits(database, userId, plan, credits, note || `${provider}:${model}`);

  if (taskId) {
    database.prepare(`
      UPDATE tasks
      SET credits_used = COALESCE(credits_used, 0) + ?
      WHERE id = ?
    `).run(credits, taskId);
  }

  return {
    id,
    cost_cents: costCents,
    credits,
    rates,
    consumed: consume.consumed,
    blocked: consume.blocked
  };
}
