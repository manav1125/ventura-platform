// src/db/migrate.js
// Full schema for Ventura — runs on startup, idempotent

import Database from 'better-sqlite3';
import { DB_PATH } from '../config.js';

export function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
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
  `);

  console.log('✅ Database migrations complete');
  return db;
}
