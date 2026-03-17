// src/db/migrate.js
// Full schema for Ventura — runs on startup, idempotent

import Database from 'better-sqlite3';
import { DB_PATH } from '../config.js';
import { getPlanEconomics } from '../billing/plans.js';

let db;

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function backfillBusinessEconomics(db) {
  const businesses = db.prepare(`
    SELECT b.id, u.plan
    FROM businesses b
    LEFT JOIN users u ON u.id = b.user_id
  `).all();

  const update = db.prepare(`
    UPDATE businesses
    SET monthly_subscription_cents = ?,
        api_budget_cents = ?,
        revenue_share_pct = ?,
        tasks_included_per_month = ?,
        infrastructure_included = ?
    WHERE id = ?
      AND (
        monthly_subscription_cents < 0 OR
        api_budget_cents < 0 OR
        revenue_share_pct < 0 OR
        tasks_included_per_month < 0 OR
        infrastructure_included < 0
      )
  `);

  for (const business of businesses) {
    const economics = getPlanEconomics(business.plan || 'trial');
    update.run(
      economics.monthly_subscription_cents,
      economics.api_budget_cents,
      economics.revenue_share_pct,
      economics.tasks_included_per_month,
      economics.infrastructure_included ? 1 : 0,
      business.id
    );
  }
}

export function getDb() {
  if (db) return db;

  db = new Database(DB_PATH);
  db.pragma(DB_PATH === ':memory:' ? 'journal_mode = MEMORY' : 'journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function runMigrations() {
  const db = getDb();

  db.exec(`
    -- ─────────────────────────────────────────
    -- USERS (founders)
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      plan          TEXT NOT NULL DEFAULT 'trial',  -- trial | builder | fleet
      email_verified INTEGER NOT NULL DEFAULT 0,
      email_verified_at TEXT,
      is_admin      INTEGER NOT NULL DEFAULT 0,
      stripe_customer_id TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────────
    -- BUSINESSES
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS businesses (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      slug          TEXT UNIQUE NOT NULL,
      type          TEXT NOT NULL,          -- saas | agency | ecommerce | content | marketplace | education | other
      description   TEXT NOT NULL,
      target_customer TEXT NOT NULL,
      goal_90d      TEXT NOT NULL,
      involvement   TEXT NOT NULL DEFAULT 'autopilot',  -- autopilot | review | daily
      status        TEXT NOT NULL DEFAULT 'provisioning', -- provisioning | active | paused | cancelled
      day_count     INTEGER NOT NULL DEFAULT 0,

      -- Infrastructure
      web_url       TEXT,
      db_name       TEXT,
      email_address TEXT,
      stripe_account_id TEXT,

      -- Financials
      mrr_cents     INTEGER NOT NULL DEFAULT 0,
      arr_cents     INTEGER NOT NULL DEFAULT 0,
      total_revenue_cents INTEGER NOT NULL DEFAULT 0,
      monthly_subscription_cents INTEGER NOT NULL DEFAULT 4900,
      api_budget_cents INTEGER NOT NULL DEFAULT 500,
      revenue_share_pct INTEGER NOT NULL DEFAULT 20,
      tasks_included_per_month INTEGER NOT NULL DEFAULT 5,
      infrastructure_included INTEGER NOT NULL DEFAULT 1,

      -- Agent memory
      agent_memory  TEXT DEFAULT '{}',     -- JSON blob: persistent context

      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_businesses_user ON businesses(user_id);
    CREATE INDEX IF NOT EXISTS idx_businesses_slug ON businesses(slug);

    -- ─────────────────────────────────────────
    -- AGENT CYCLES
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS agent_cycles (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      status        TEXT NOT NULL DEFAULT 'queued', -- queued | running | complete | failed
      triggered_by  TEXT NOT NULL DEFAULT 'cron',  -- cron | manual | webhook
      started_at    TEXT,
      completed_at  TEXT,
      tasks_run     INTEGER NOT NULL DEFAULT 0,
      summary       TEXT,                          -- AI-generated summary of the cycle
      error         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_cycles_business ON agent_cycles(business_id);
    CREATE INDEX IF NOT EXISTS idx_cycles_status ON agent_cycles(status);

    -- ─────────────────────────────────────────
    -- TASKS
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      cycle_id      TEXT REFERENCES agent_cycles(id),
      title         TEXT NOT NULL,
      description   TEXT,
      department    TEXT NOT NULL,  -- engineering | marketing | operations | strategy | sales | finance
      status        TEXT NOT NULL DEFAULT 'queued', -- queued | running | complete | failed | cancelled
      triggered_by  TEXT NOT NULL DEFAULT 'agent',  -- agent | user
      priority      INTEGER NOT NULL DEFAULT 5,     -- 1 (highest) - 10 (lowest)
      result        TEXT,                           -- JSON: output, files changed, etc.
      error         TEXT,
      credits_used  INTEGER NOT NULL DEFAULT 1,
      started_at    TEXT,
      completed_at  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_business ON tasks(business_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_department ON tasks(department);

    -- ─────────────────────────────────────────
    -- ACTIVITY FEED (real-time events)
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS activity (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      type          TEXT NOT NULL,  -- task_complete | task_started | deploy | email_sent | lead | revenue | alert | insight
      department    TEXT,
      title         TEXT NOT NULL,
      detail        TEXT,           -- JSON: extra metadata
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_activity_business ON activity(business_id);
    CREATE INDEX IF NOT EXISTS idx_activity_type ON activity(type);

    -- ─────────────────────────────────────────
    -- METRICS (daily snapshots)
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS metrics (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      date          TEXT NOT NULL,   -- YYYY-MM-DD
      mrr_cents     INTEGER NOT NULL DEFAULT 0,
      active_users  INTEGER NOT NULL DEFAULT 0,
      new_users     INTEGER NOT NULL DEFAULT 0,
      tasks_done    INTEGER NOT NULL DEFAULT 0,
      leads         INTEGER NOT NULL DEFAULT 0,
      emails_sent   INTEGER NOT NULL DEFAULT 0,
      deployments   INTEGER NOT NULL DEFAULT 0,
      revenue_cents INTEGER NOT NULL DEFAULT 0,
      UNIQUE(business_id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_metrics_business ON metrics(business_id);

    -- ─────────────────────────────────────────
    -- LEADS / CRM
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS leads (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      name          TEXT,
      email         TEXT NOT NULL,
      company       TEXT,
      status        TEXT NOT NULL DEFAULT 'new',  -- new | contacted | replied | qualified | won | lost
      source        TEXT,                          -- cold_email | organic | referral | ad
      notes         TEXT,
      last_contact  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_leads_business ON leads(business_id);
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

    -- ─────────────────────────────────────────
    -- CHAT MESSAGES (agent <> founder)
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS messages (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      role          TEXT NOT NULL,  -- user | assistant
      content       TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_business ON messages(business_id);

    -- ─────────────────────────────────────────
    -- DEPLOYMENTS
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS deployments (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      task_id       TEXT REFERENCES tasks(id),
      version       TEXT NOT NULL,
      description   TEXT NOT NULL,
      files_changed INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'live',  -- live | rolled_back
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────────
    -- APPROVALS (founder control layer)
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS approvals (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      task_id       TEXT REFERENCES tasks(id),
      action_type   TEXT NOT NULL,
      title         TEXT NOT NULL,
      summary       TEXT,
      payload       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | executed | failed
      requested_by  TEXT NOT NULL DEFAULT 'agent',
      decision_note TEXT,
      decided_by    TEXT REFERENCES users(id),
      decided_at    TEXT,
      execution_result TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_approvals_business ON approvals(business_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

    -- ─────────────────────────────────────────
    -- INTEGRATIONS / INFRA REGISTRY
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS integrations (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL,
      provider      TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      config        TEXT DEFAULT '{}',
      secrets       TEXT DEFAULT '{}',
      last_sync_at  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(business_id, kind)
    );

    CREATE INDEX IF NOT EXISTS idx_integrations_business ON integrations(business_id);

    -- ─────────────────────────────────────────
    -- REFRESH TOKENS
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash    TEXT UNIQUE NOT NULL,
      expires_at    TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

    -- ─────────────────────────────────────────
    -- PASSWORD RESET TOKENS
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash    TEXT UNIQUE NOT NULL,
      expires_at    TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);

    -- ─────────────────────────────────────────
    -- EMAIL VERIFICATION TOKENS
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash    TEXT UNIQUE NOT NULL,
      expires_at    TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user ON email_verification_tokens(user_id);
  `);

  // Existing SQLite tables do not gain new columns from CREATE TABLE IF NOT EXISTS,
  // so we add and backfill the business economics columns separately.
  ensureColumn(db, 'businesses', 'monthly_subscription_cents', 'INTEGER NOT NULL DEFAULT -1');
  ensureColumn(db, 'businesses', 'api_budget_cents', 'INTEGER NOT NULL DEFAULT -1');
  ensureColumn(db, 'businesses', 'revenue_share_pct', 'INTEGER NOT NULL DEFAULT -1');
  ensureColumn(db, 'businesses', 'tasks_included_per_month', 'INTEGER NOT NULL DEFAULT -1');
  ensureColumn(db, 'businesses', 'infrastructure_included', 'INTEGER NOT NULL DEFAULT -1');
  ensureColumn(db, 'integrations', 'secrets', "TEXT DEFAULT '{}'");
  ensureColumn(db, 'integrations', 'updated_at', 'TEXT');
  ensureColumn(db, 'users', 'email_verified', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'users', 'email_verified_at', 'TEXT');
  db.prepare(`
    UPDATE integrations
    SET secrets = COALESCE(secrets, '{}'),
        updated_at = COALESCE(updated_at, created_at, datetime('now'))
    WHERE secrets IS NULL OR updated_at IS NULL
  `).run();
  db.prepare(`
    UPDATE users
    SET email_verified_at = COALESCE(email_verified_at, created_at)
    WHERE email_verified = 1
  `).run();
  backfillBusinessEconomics(db);

  console.log('✅ Database migrations complete');
  return db;
}

export function closeDb() {
  if (!db) return;
  db.close();
  db = null;
}
