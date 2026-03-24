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
      blueprint_key TEXT,
      blueprint_label TEXT,
      blueprint_version TEXT,
      blueprint_config TEXT DEFAULT '{}',
      day_count     INTEGER NOT NULL DEFAULT 0,
      cadence_mode  TEXT NOT NULL DEFAULT 'daily', -- daily | hourly | manual
      cadence_interval_hours INTEGER NOT NULL DEFAULT 24,
      preferred_run_hour_utc INTEGER NOT NULL DEFAULT 2,
      next_run_at   TEXT,
      last_cycle_at TEXT,

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
    CREATE INDEX IF NOT EXISTS idx_businesses_next_run ON businesses(next_run_at);

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
      workflow_key  TEXT,
      brief_json    TEXT,
      status        TEXT NOT NULL DEFAULT 'queued', -- queued | running | complete | failed | cancelled
      triggered_by  TEXT NOT NULL DEFAULT 'agent',  -- agent | user
      priority      INTEGER NOT NULL DEFAULT 5,     -- 1 (highest) - 10 (lowest)
      result        TEXT,                           -- JSON: output, files changed, etc.
      error         TEXT,
      verification_status TEXT,
      verification_summary TEXT,
      credits_used  INTEGER NOT NULL DEFAULT 1,
      started_at    TEXT,
      completed_at  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_business ON tasks(business_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_department ON tasks(department);
    CREATE INDEX IF NOT EXISTS idx_tasks_workflow_key ON tasks(workflow_key);

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
    -- ARTIFACTS (plans, outputs, site files)
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS artifacts (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      task_id       TEXT REFERENCES tasks(id),
      cycle_id      TEXT REFERENCES agent_cycles(id),
      department    TEXT,
      kind          TEXT NOT NULL, -- launch_plan | task_summary | content | email | social_post | research | site_file
      title         TEXT NOT NULL,
      summary       TEXT,
      path          TEXT,
      content       TEXT,
      content_type  TEXT NOT NULL DEFAULT 'text/markdown',
      status        TEXT NOT NULL DEFAULT 'published', -- draft | published | superseded | archived
      metadata      TEXT DEFAULT '{}',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_business ON artifacts(business_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(kind);
    CREATE INDEX IF NOT EXISTS idx_artifacts_path ON artifacts(path);

    -- ─────────────────────────────────────────
    -- TASK EVENTS (live execution telemetry)
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS task_events (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      cycle_id      TEXT REFERENCES agent_cycles(id),
      phase         TEXT NOT NULL, -- queued | started | tool_started | tool_succeeded | tool_failed | completed | failed | note
      title         TEXT NOT NULL,
      detail        TEXT,
      metadata      TEXT DEFAULT '{}',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_task_events_business ON task_events(business_id);
    CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_events_cycle ON task_events(cycle_id);

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
    -- WORKFLOW STATE (persistent continuity per operating loop)
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS workflow_states (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      workflow_key  TEXT NOT NULL,
      department    TEXT NOT NULL,
      title         TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'healthy',
      summary       TEXT,
      open_loops    TEXT DEFAULT '[]',
      evidence      TEXT DEFAULT '[]',
      last_task_id  TEXT REFERENCES tasks(id),
      last_cycle_id TEXT REFERENCES agent_cycles(id),
      last_verification_status TEXT,
      last_run_at   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(business_id, workflow_key)
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_states_business ON workflow_states(business_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_states_key ON workflow_states(workflow_key);

    -- ─────────────────────────────────────────
    -- TASK VERIFICATION
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS task_verifications (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      status        TEXT NOT NULL DEFAULT 'review', -- passed | review | revise
      score         REAL NOT NULL DEFAULT 0,
      summary       TEXT,
      checklist     TEXT DEFAULT '[]',
      risks         TEXT DEFAULT '[]',
      suggested_followups TEXT DEFAULT '[]',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(task_id)
    );

    CREATE INDEX IF NOT EXISTS idx_task_verifications_business ON task_verifications(business_id);
    CREATE INDEX IF NOT EXISTS idx_task_verifications_status ON task_verifications(status);

    -- ─────────────────────────────────────────
    -- SKILL LIBRARY (forced post-task extraction)
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS skill_library (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      department    TEXT NOT NULL,
      slug          TEXT NOT NULL,
      title         TEXT NOT NULL,
      summary       TEXT,
      steps         TEXT DEFAULT '[]',
      confidence    REAL NOT NULL DEFAULT 0,
      evidence_task_id TEXT REFERENCES tasks(id),
      times_observed INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(business_id, slug)
    );

    CREATE INDEX IF NOT EXISTS idx_skill_library_business ON skill_library(business_id);
    CREATE INDEX IF NOT EXISTS idx_skill_library_department ON skill_library(department);

    -- ─────────────────────────────────────────
    -- ACTION OPERATIONS (idempotent side effects)
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS action_operations (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      task_id       TEXT REFERENCES tasks(id),
      approval_id   TEXT REFERENCES approvals(id),
      action_type   TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      summary       TEXT,
      payload       TEXT DEFAULT '{}',
      result        TEXT,
      status        TEXT NOT NULL DEFAULT 'running', -- running | succeeded | failed | blocked
      replay_count  INTEGER NOT NULL DEFAULT 0,
      error         TEXT,
      executed_at   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_action_operations_business ON action_operations(business_id);
    CREATE INDEX IF NOT EXISTS idx_action_operations_status ON action_operations(status);
    CREATE INDEX IF NOT EXISTS idx_action_operations_task ON action_operations(task_id);

    -- ─────────────────────────────────────────
    -- RECOVERY CASES (explicit failure + retry queue)
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS recovery_cases (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      source_type   TEXT NOT NULL,
      source_id     TEXT,
      fingerprint   TEXT NOT NULL UNIQUE,
      severity      TEXT NOT NULL DEFAULT 'attention', -- attention | critical
      status        TEXT NOT NULL DEFAULT 'open', -- open | resolved
      title         TEXT NOT NULL,
      summary       TEXT,
      detail        TEXT DEFAULT '{}',
      retry_action  TEXT,
      retryable     INTEGER NOT NULL DEFAULT 0,
      occurrences   INTEGER NOT NULL DEFAULT 1,
      resolution_note TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_recovery_cases_business ON recovery_cases(business_id);
    CREATE INDEX IF NOT EXISTS idx_recovery_cases_status ON recovery_cases(status);
    CREATE INDEX IF NOT EXISTS idx_recovery_cases_source ON recovery_cases(source_type, source_id);

    -- ─────────────────────────────────────────
    -- WORKSPACE RECORDS (business-scoped synced context)
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS workspace_records (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL,
      provider      TEXT NOT NULL,
      external_id   TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active',
      title         TEXT NOT NULL,
      summary       TEXT,
      owner         TEXT,
      metadata      TEXT DEFAULT '{}',
      payload       TEXT DEFAULT '{}',
      occurred_at   TEXT,
      last_synced_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(business_id, kind, external_id)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_records_business ON workspace_records(business_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_records_kind ON workspace_records(kind);
    CREATE INDEX IF NOT EXISTS idx_workspace_records_status ON workspace_records(status);

    -- ─────────────────────────────────────────
    -- WORKSPACE SYNC RUNS
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS workspace_sync_runs (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL,
      provider      TEXT NOT NULL,
      triggered_by  TEXT NOT NULL DEFAULT 'founder',
      status        TEXT NOT NULL DEFAULT 'complete',
      summary       TEXT,
      items_synced  INTEGER NOT NULL DEFAULT 0,
      error         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_sync_runs_business ON workspace_sync_runs(business_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_sync_runs_kind ON workspace_sync_runs(kind);

    -- ─────────────────────────────────────────
    -- WORKSPACE AUTOMATION RUNS
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS workspace_automation_runs (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      triggered_by  TEXT NOT NULL DEFAULT 'agent',
      status        TEXT NOT NULL DEFAULT 'complete',
      summary       TEXT,
      items_reviewed INTEGER NOT NULL DEFAULT 0,
      tasks_created INTEGER NOT NULL DEFAULT 0,
      error         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_automation_runs_business ON workspace_automation_runs(business_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_automation_runs_status ON workspace_automation_runs(status);

    -- ─────────────────────────────────────────
    -- WORKSPACE AUTOMATION ACTIONS
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS workspace_automation_actions (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL,
      external_id   TEXT NOT NULL,
      action_key    TEXT NOT NULL,
      title         TEXT NOT NULL,
      summary       TEXT,
      department    TEXT NOT NULL,
      workflow_key  TEXT NOT NULL,
      source_status TEXT,
      source_fingerprint TEXT NOT NULL,
      task_id       TEXT REFERENCES tasks(id),
      status        TEXT NOT NULL DEFAULT 'open', -- open | closed | needs_retry | suppressed
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT,
      UNIQUE(business_id, kind, external_id, action_key)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_automation_actions_business ON workspace_automation_actions(business_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_automation_actions_status ON workspace_automation_actions(status);
    CREATE INDEX IF NOT EXISTS idx_workspace_automation_actions_task ON workspace_automation_actions(task_id);

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
    -- INFRASTRUCTURE ASSETS
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS infrastructure_assets (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL,
      provider      TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      config        TEXT DEFAULT '{}',
      checks        TEXT DEFAULT '{}',
      last_checked_at TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(business_id, kind)
    );

    CREATE INDEX IF NOT EXISTS idx_infrastructure_assets_business ON infrastructure_assets(business_id);

    -- ─────────────────────────────────────────
    -- MARKETPLACE DOMAIN (vertical blueprint data)
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS marketplace_founder_profiles (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      founder_name  TEXT NOT NULL,
      founder_email TEXT,
      company_name  TEXT NOT NULL,
      company_url   TEXT,
      stage         TEXT,
      sectors       TEXT DEFAULT '[]',
      geography     TEXT,
      traction_summary TEXT,
      raise_summary TEXT,
      raise_target_cents INTEGER,
      status        TEXT NOT NULL DEFAULT 'applied', -- applied | reviewing | approved | rejected | matched
      metadata      TEXT DEFAULT '{}',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_marketplace_founders_business ON marketplace_founder_profiles(business_id);
    CREATE INDEX IF NOT EXISTS idx_marketplace_founders_status ON marketplace_founder_profiles(status);

    CREATE TABLE IF NOT EXISTS marketplace_investor_profiles (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      email         TEXT,
      firm          TEXT,
      title         TEXT,
      stage_focus   TEXT DEFAULT '[]',
      sector_focus  TEXT DEFAULT '[]',
      geography_focus TEXT DEFAULT '[]',
      check_size_min_cents INTEGER,
      check_size_max_cents INTEGER,
      thesis        TEXT,
      status        TEXT NOT NULL DEFAULT 'active', -- active | paused | archived
      metadata      TEXT DEFAULT '{}',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_marketplace_investors_business ON marketplace_investor_profiles(business_id);
    CREATE INDEX IF NOT EXISTS idx_marketplace_investors_status ON marketplace_investor_profiles(status);

    CREATE TABLE IF NOT EXISTS marketplace_matches (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      founder_profile_id TEXT NOT NULL REFERENCES marketplace_founder_profiles(id) ON DELETE CASCADE,
      investor_profile_id TEXT NOT NULL REFERENCES marketplace_investor_profiles(id) ON DELETE CASCADE,
      status        TEXT NOT NULL DEFAULT 'candidate', -- candidate | queued_intro | sent | accepted | declined | archived
      score         REAL NOT NULL DEFAULT 0,
      rationale     TEXT,
      founder_summary TEXT,
      investor_summary TEXT,
      intro_draft   TEXT,
      metadata      TEXT DEFAULT '{}',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(business_id, founder_profile_id, investor_profile_id)
    );

    CREATE INDEX IF NOT EXISTS idx_marketplace_matches_business ON marketplace_matches(business_id);
    CREATE INDEX IF NOT EXISTS idx_marketplace_matches_status ON marketplace_matches(status);

    CREATE TABLE IF NOT EXISTS marketplace_reviews (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      subject_type  TEXT NOT NULL,
      subject_id    TEXT NOT NULL,
      decision      TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
      notes         TEXT,
      decided_by    TEXT REFERENCES users(id),
      decided_at    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_marketplace_reviews_business ON marketplace_reviews(business_id);
    CREATE INDEX IF NOT EXISTS idx_marketplace_reviews_subject ON marketplace_reviews(subject_type, subject_id);

    CREATE TABLE IF NOT EXISTS marketplace_conversations (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      match_id      TEXT NOT NULL REFERENCES marketplace_matches(id) ON DELETE CASCADE,
      status        TEXT NOT NULL DEFAULT 'open', -- open | waiting | replied | closed
      channel       TEXT NOT NULL DEFAULT 'email',
      thread_subject TEXT,
      last_message_at TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_marketplace_conversations_business ON marketplace_conversations(business_id);
    CREATE INDEX IF NOT EXISTS idx_marketplace_conversations_match ON marketplace_conversations(match_id);

    -- ─────────────────────────────────────────
    -- INTELLIGENCE DOCUMENTS (blueprints, playbooks, refinements)
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS intelligence_documents (
      id            TEXT PRIMARY KEY,
      business_id   TEXT REFERENCES businesses(id) ON DELETE CASCADE,
      author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      scope         TEXT NOT NULL DEFAULT 'business', -- business | platform
      blueprint_key TEXT,
      workflow_key  TEXT,
      kind          TEXT NOT NULL, -- blueprint_refinement | playbook_note | operating_rule | refinement_note | prompt_note
      title         TEXT NOT NULL,
      content       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active', -- active | archived
      metadata      TEXT DEFAULT '{}',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_intelligence_documents_business ON intelligence_documents(business_id);
    CREATE INDEX IF NOT EXISTS idx_intelligence_documents_scope ON intelligence_documents(scope);
    CREATE INDEX IF NOT EXISTS idx_intelligence_documents_blueprint ON intelligence_documents(blueprint_key);
    CREATE INDEX IF NOT EXISTS idx_intelligence_documents_workflow ON intelligence_documents(workflow_key);

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

    -- ─────────────────────────────────────────
    -- SOCIAL OAUTH STATES
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS oauth_states (
      id            TEXT PRIMARY KEY,
      provider      TEXT NOT NULL,
      business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state_hash    TEXT UNIQUE NOT NULL,
      code_verifier TEXT,
      metadata      TEXT DEFAULT '{}',
      expires_at    TEXT NOT NULL,
      consumed_at   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_oauth_states_provider ON oauth_states(provider);
    CREATE INDEX IF NOT EXISTS idx_oauth_states_business ON oauth_states(business_id);
  `);

  // Existing SQLite tables do not gain new columns from CREATE TABLE IF NOT EXISTS,
  // so we add and backfill the business economics columns separately.
  ensureColumn(db, 'businesses', 'monthly_subscription_cents', 'INTEGER NOT NULL DEFAULT -1');
  ensureColumn(db, 'businesses', 'api_budget_cents', 'INTEGER NOT NULL DEFAULT -1');
  ensureColumn(db, 'businesses', 'revenue_share_pct', 'INTEGER NOT NULL DEFAULT -1');
  ensureColumn(db, 'businesses', 'tasks_included_per_month', 'INTEGER NOT NULL DEFAULT -1');
  ensureColumn(db, 'businesses', 'infrastructure_included', 'INTEGER NOT NULL DEFAULT -1');
  ensureColumn(db, 'businesses', 'cadence_mode', "TEXT NOT NULL DEFAULT 'daily'");
  ensureColumn(db, 'businesses', 'cadence_interval_hours', 'INTEGER NOT NULL DEFAULT 24');
  ensureColumn(db, 'businesses', 'preferred_run_hour_utc', 'INTEGER NOT NULL DEFAULT 2');
  ensureColumn(db, 'businesses', 'next_run_at', 'TEXT');
  ensureColumn(db, 'businesses', 'last_cycle_at', 'TEXT');
  ensureColumn(db, 'businesses', 'blueprint_key', 'TEXT');
  ensureColumn(db, 'businesses', 'blueprint_label', 'TEXT');
  ensureColumn(db, 'businesses', 'blueprint_version', 'TEXT');
  ensureColumn(db, 'businesses', 'blueprint_config', "TEXT DEFAULT '{}'");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_businesses_blueprint ON businesses(blueprint_key);
  `);
  ensureColumn(db, 'tasks', 'workflow_key', 'TEXT');
  ensureColumn(db, 'tasks', 'brief_json', 'TEXT');
  ensureColumn(db, 'tasks', 'verification_status', 'TEXT');
  ensureColumn(db, 'tasks', 'verification_summary', 'TEXT');
  ensureColumn(db, 'action_operations', 'replay_count', 'INTEGER NOT NULL DEFAULT 0');
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
  db.prepare(`
    DELETE FROM oauth_states
    WHERE consumed_at IS NOT NULL OR datetime(expires_at) <= datetime('now')
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
