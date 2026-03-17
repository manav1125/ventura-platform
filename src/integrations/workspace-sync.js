import { v4 as uuid } from 'uuid';
import { getDb } from '../db/migrate.js';
import { getIntegration, upsertIntegration } from './registry.js';

export const WORKSPACE_KINDS = ['inbox', 'calendar', 'accounting'];
const DEFAULT_SYNC_INTERVAL_HOURS = {
  inbox: 4,
  calendar: 12,
  accounting: 24
};

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toStringArray(value) {
  return Array.isArray(value)
    ? value.map(item => cleanString(item)).filter(Boolean)
    : [];
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function hoursFromNow(hours) {
  return new Date(Date.now() + (hours * 60 * 60 * 1000)).toISOString();
}

function hoursAgo(hours) {
  return new Date(Date.now() - (hours * 60 * 60 * 1000)).toISOString();
}

function normalizeSyncMode(kind, value) {
  const raw = cleanString(value).toLowerCase();
  if (!raw) {
    return kind === 'accounting' ? 'derived' : (kind === 'inbox' ? 'hourly' : 'daily');
  }
  if (raw === 'live') return 'on_cycle';
  if (raw === 'preview') return kind === 'accounting' ? 'derived' : 'manual';
  if (['manual', 'hourly', 'daily', 'on_cycle', 'derived'].includes(raw)) return raw;
  return kind === 'accounting' ? 'derived' : 'manual';
}

function getDefaultSyncInterval(kind) {
  return DEFAULT_SYNC_INTERVAL_HOURS[kind] || 24;
}

function clampSyncInterval(value, fallback) {
  return Math.min(168, Math.max(1, parseInteger(value, fallback)));
}

function isDueAt(timestamp) {
  return !!timestamp && new Date(timestamp).getTime() <= Date.now();
}

function normalizeInboxConfig(config = {}) {
  const inboxAddress = cleanString(config.inbox_address || config.inboxAddress || config.address);
  const provider = cleanString(config.provider) || (inboxAddress ? 'business-inbox' : 'preview-inbox');
  const supportAliases = toStringArray(config.support_aliases || config.supportAliases);
  const connected = !!(config.connected || inboxAddress);
  const syncMode = normalizeSyncMode('inbox', config.sync_mode || config.syncMode);
  const syncIntervalHours = clampSyncInterval(
    config.sync_interval_hours || config.syncIntervalHours,
    getDefaultSyncInterval('inbox')
  );
  return {
    provider,
    status: connected ? 'connected' : 'preview',
    config: {
      connected,
      inbox_address: inboxAddress || null,
      support_aliases: supportAliases,
      owner_email: cleanString(config.owner_email || config.ownerEmail) || null,
      sync_mode: syncMode,
      sync_interval_hours: syncIntervalHours,
      automation_enabled: config.automation_enabled !== false && config.automationEnabled !== false,
      last_message_at: cleanString(config.last_message_at || config.lastMessageAt) || null,
      preview: !connected
    }
  };
}

function normalizeCalendarConfig(config = {}) {
  const provider = cleanString(config.provider) || (cleanString(config.calendar_id || config.calendarId) ? 'business-calendar' : 'preview-calendar');
  const calendarId = cleanString(config.calendar_id || config.calendarId);
  const connected = !!(config.connected || calendarId);
  const syncMode = normalizeSyncMode('calendar', config.sync_mode || config.syncMode);
  const syncIntervalHours = clampSyncInterval(
    config.sync_interval_hours || config.syncIntervalHours,
    getDefaultSyncInterval('calendar')
  );
  return {
    provider,
    status: connected ? 'connected' : 'preview',
    config: {
      connected,
      calendar_id: calendarId || null,
      timezone: cleanString(config.timezone) || 'UTC',
      owner_email: cleanString(config.owner_email || config.ownerEmail) || null,
      sync_mode: syncMode,
      sync_interval_hours: syncIntervalHours,
      automation_enabled: config.automation_enabled !== false && config.automationEnabled !== false,
      calendar_label: cleanString(config.calendar_label || config.calendarLabel) || null,
      preview: !connected
    }
  };
}

function normalizeAccountingConfig(config = {}) {
  const provider = cleanString(config.provider) || (cleanString(config.account_external_id || config.accountExternalId) ? 'business-ledger' : 'preview-ledger');
  const externalId = cleanString(config.account_external_id || config.accountExternalId);
  const connected = !!(config.connected || externalId || cleanString(config.account_label || config.accountLabel));
  const syncMode = normalizeSyncMode('accounting', config.sync_mode || config.syncMode);
  const syncIntervalHours = clampSyncInterval(
    config.sync_interval_hours || config.syncIntervalHours,
    getDefaultSyncInterval('accounting')
  );
  return {
    provider,
    status: connected ? 'configured' : 'preview',
    config: {
      connected,
      account_external_id: externalId || null,
      account_label: cleanString(config.account_label || config.accountLabel) || null,
      currency: cleanString(config.currency) || 'usd',
      sync_mode: syncMode,
      sync_interval_hours: syncIntervalHours,
      automation_enabled: config.automation_enabled !== false && config.automationEnabled !== false,
      owner_email: cleanString(config.owner_email || config.ownerEmail) || null,
      preview: !connected
    }
  };
}

function normalizeWorkspaceIntegration(kind, updates = {}) {
  if (kind === 'inbox') return normalizeInboxConfig(updates);
  if (kind === 'calendar') return normalizeCalendarConfig(updates);
  if (kind === 'accounting') return normalizeAccountingConfig(updates);
  throw new Error(`Unsupported workspace integration: ${kind}`);
}

function hydrateRecord(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: parseJson(row.metadata, {}),
    payload: parseJson(row.payload, {})
  };
}

function hydrateRun(row) {
  if (!row) return null;
  return row;
}

function computeNextSyncAt(kind, config = {}, from = new Date()) {
  const mode = normalizeSyncMode(kind, config.sync_mode || config.syncMode);
  if (mode === 'manual') return null;
  if (mode === 'on_cycle' || mode === 'derived') return 'on_cycle';

  const intervalHours = clampSyncInterval(
    config.sync_interval_hours || config.syncIntervalHours,
    getDefaultSyncInterval(kind)
  );
  return new Date(from.getTime() + (intervalHours * 60 * 60 * 1000)).toISOString();
}

function getSyncStatus(kind, integration) {
  const config = integration?.config || {};
  const mode = normalizeSyncMode(kind, config.sync_mode || config.syncMode);
  const intervalHours = clampSyncInterval(
    config.sync_interval_hours || config.syncIntervalHours,
    getDefaultSyncInterval(kind)
  );
  const lastSyncAt = cleanString(integration?.last_sync_at || config.last_synced_at || config.lastSyncAt) || null;
  const nextSyncAt = mode === 'manual'
    ? null
    : mode === 'on_cycle' || mode === 'derived'
      ? 'on_cycle'
      : computeNextSyncAt(kind, config, lastSyncAt ? new Date(lastSyncAt) : new Date());

  return {
    kind,
    provider: integration?.provider || null,
    status: integration?.status || 'pending',
    connected: !!config.connected,
    automation_enabled: config.automation_enabled !== false,
    mode,
    interval_hours: intervalHours,
    last_sync_at: lastSyncAt,
    next_sync_at: nextSyncAt,
    due: mode === 'manual'
      ? false
      : mode === 'on_cycle' || mode === 'derived'
        ? true
        : !lastSyncAt || isDueAt(nextSyncAt)
  };
}

export function getWorkspaceSyncPlan(businessId) {
  return WORKSPACE_KINDS.map(kind => {
    const integration = getIntegration(businessId, kind);
    if (!integration) {
      return getSyncStatus(kind, {
        provider: null,
        status: 'pending',
        config: {
          sync_mode: normalizeSyncMode(kind, null),
          sync_interval_hours: getDefaultSyncInterval(kind),
          automation_enabled: true
        },
        last_sync_at: null
      });
    }
    return getSyncStatus(kind, integration);
  });
}

export function saveWorkspaceIntegrationSettings({ businessId, kind, updates = {} }) {
  const existing = getIntegration(businessId, kind, { includeSecrets: true });
  const normalized = normalizeWorkspaceIntegration(kind, {
    ...(existing?.config || {}),
    ...updates
  });

  upsertIntegration({
    businessId,
    kind,
    provider: normalized.provider,
    status: normalized.status,
    config: normalized.config,
    secrets: existing?.secrets || {},
    lastSyncAt: existing?.last_sync_at || null
  });

  return getIntegration(businessId, kind);
}

export function upsertWorkspaceRecord({
  businessId,
  kind,
  provider,
  externalId,
  status = 'active',
  title,
  summary = '',
  owner = null,
  metadata = {},
  payload = {},
  occurredAt = null
}) {
  const db = getDb();
  const existing = db.prepare(`
    SELECT id
    FROM workspace_records
    WHERE business_id = ? AND kind = ? AND external_id = ?
  `).get(businessId, kind, externalId);

  if (existing) {
    db.prepare(`
      UPDATE workspace_records
      SET provider = ?,
          status = ?,
          title = ?,
          summary = ?,
          owner = ?,
          metadata = ?,
          payload = ?,
          occurred_at = ?,
          last_synced_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      provider,
      status,
      title,
      summary || null,
      owner,
      JSON.stringify(metadata || {}),
      JSON.stringify(payload || {}),
      occurredAt,
      existing.id
    );
    return existing.id;
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO workspace_records (
      id, business_id, kind, provider, external_id, status, title, summary, owner, metadata, payload, occurred_at, last_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    id,
    businessId,
    kind,
    provider,
    externalId,
    status,
    title,
    summary || null,
    owner,
    JSON.stringify(metadata || {}),
    JSON.stringify(payload || {}),
    occurredAt
  );
  return id;
}

function startSyncRun({ businessId, kind, provider, triggeredBy }) {
  const db = getDb();
  const id = uuid();
  db.prepare(`
    INSERT INTO workspace_sync_runs (
      id, business_id, kind, provider, triggered_by, status, created_at
    ) VALUES (?, ?, ?, ?, ?, 'running', datetime('now'))
  `).run(id, businessId, kind, provider, triggeredBy);
  return id;
}

function finishSyncRun(id, { status = 'complete', summary = '', itemsSynced = 0, error = null }) {
  const db = getDb();
  db.prepare(`
    UPDATE workspace_sync_runs
    SET status = ?,
        summary = ?,
        items_synced = ?,
        error = ?,
        completed_at = datetime('now')
    WHERE id = ?
  `).run(status, summary || null, itemsSynced, error, id);
}

function buildInboxRecords(business, integration) {
  const db = getDb();
  const leads = db.prepare(`
    SELECT name, email, company, status
    FROM leads
    WHERE business_id = ?
    ORDER BY created_at DESC
    LIMIT 2
  `).all(business.id);
  const primaryLead = leads[0];
  const secondaryLead = leads[1];
  const inboxAddress = integration.config.inbox_address || business.email_address || `support@${business.slug}.${business.slug}.local`;
  return [
    {
      externalId: 'support-thread-annual-plan',
      status: 'attention',
      title: primaryLead
        ? `${primaryLead.name || primaryLead.email} asked about annual pricing`
        : `New pricing question in ${business.name} inbox`,
      summary: primaryLead
        ? `${primaryLead.email} wants a founder reply on annual billing and onboarding timing.`
        : 'A prospect is waiting on pricing clarification and timing.',
      owner: inboxAddress,
      metadata: {
        channel: 'email',
        requires_reply: true,
        sentiment: 'warm',
        source: primaryLead?.status || 'lead'
      },
      payload: {
        from: primaryLead?.email || 'prospect@example.com',
        to: inboxAddress,
        thread_state: 'awaiting_reply'
      },
      occurredAt: hoursAgo(3)
    },
    {
      externalId: 'support-thread-customer-success',
      status: 'waiting',
      title: `${business.name} customer wants onboarding help`,
      summary: 'A recent signup replied asking for the fastest path to value and whether white-glove setup is available.',
      owner: inboxAddress,
      metadata: {
        channel: 'email',
        requires_reply: false,
        sentiment: 'neutral',
        source: 'customer'
      },
      payload: {
        from: secondaryLead?.email || 'customer@example.com',
        to: inboxAddress,
        thread_state: 'waiting_on_customer'
      },
      occurredAt: hoursAgo(8)
    },
    {
      externalId: 'support-thread-investor',
      status: 'handled',
      title: 'Investor follow-up archived by Ventura',
      summary: 'Ventura drafted and sent a status update, then archived the thread after the investor confirmed receipt.',
      owner: inboxAddress,
      metadata: {
        channel: 'email',
        requires_reply: false,
        sentiment: 'positive',
        source: 'investor'
      },
      payload: {
        from: 'investor@example.com',
        to: inboxAddress,
        thread_state: 'closed'
      },
      occurredAt: hoursAgo(22)
    }
  ];
}

function buildCalendarRecords(business, integration) {
  const ownerEmail = integration.config.owner_email || business.email_address || 'founder@ventura.ai';
  return [
    {
      externalId: 'calendar-founder-revenue-review',
      status: 'upcoming',
      title: `${business.name} revenue review`,
      summary: 'Founder + Ventura review the latest revenue, pipeline conversion, and the next 7 days of work.',
      owner: ownerEmail,
      metadata: {
        location: 'Google Meet',
        attendee_count: 2,
        type: 'ops_review'
      },
      payload: {
        starts_at: hoursFromNow(18),
        ends_at: hoursFromNow(19)
      },
      occurredAt: hoursFromNow(18)
    },
    {
      externalId: 'calendar-sales-demo',
      status: 'upcoming',
      title: 'Prospect demo scheduled',
      summary: 'A product demo with a high-intent buyer is on the calendar and needs a founder-ready briefing.',
      owner: ownerEmail,
      metadata: {
        location: 'Zoom',
        attendee_count: 3,
        type: 'sales_demo'
      },
      payload: {
        starts_at: hoursFromNow(28),
        ends_at: hoursFromNow(29)
      },
      occurredAt: hoursFromNow(28)
    },
    {
      externalId: 'calendar-launch-window',
      status: 'draft',
      title: 'Feature launch window reserved',
      summary: 'Ventura blocked time for a release, QA sweep, and announcement prep.',
      owner: ownerEmail,
      metadata: {
        location: 'Async sprint',
        attendee_count: 1,
        type: 'launch'
      },
      payload: {
        starts_at: hoursFromNow(52),
        ends_at: hoursFromNow(54)
      },
      occurredAt: hoursFromNow(52)
    }
  ];
}

function buildAccountingRecords(business, integration) {
  const monthlyBase = Number(business.monthly_subscription_cents || 0);
  const revenue = Number(business.total_revenue_cents || 0);
  const revenueSharePct = Number(business.revenue_share_pct || 0);
  const platformShare = Math.floor(revenue * (revenueSharePct / 100));
  const owner = integration.config.account_label || `${business.name} ledger`;
  return [
    {
      externalId: 'ledger-monthly-base-fee',
      status: 'posted',
      title: 'Monthly Ventura base fee',
      summary: `Base subscription fee recorded for ${business.name}.`,
      owner,
      metadata: {
        amount_cents: monthlyBase,
        currency: integration.config.currency || 'usd',
        category: 'subscription'
      },
      payload: {
        direction: 'expense',
        amount_cents: monthlyBase
      },
      occurredAt: hoursAgo(48)
    },
    {
      externalId: 'ledger-platform-share-accrual',
      status: 'posted',
      title: 'Platform revenue share accrual',
      summary: `Ventura accrued ${revenueSharePct}% of tracked revenue.`,
      owner,
      metadata: {
        amount_cents: platformShare,
        currency: integration.config.currency || 'usd',
        category: 'revenue_share'
      },
      payload: {
        direction: 'income',
        amount_cents: platformShare
      },
      occurredAt: hoursAgo(24)
    },
    {
      externalId: 'ledger-customer-receipt',
      status: 'pending',
      title: 'Customer payment pending reconciliation',
      summary: `A ${business.name} payment needs founder review against the bank feed or Stripe payout.`,
      owner,
      metadata: {
        amount_cents: Math.max(monthlyBase, 9900),
        currency: integration.config.currency || 'usd',
        category: 'customer_payment'
      },
      payload: {
        direction: 'income',
        amount_cents: Math.max(monthlyBase, 9900)
      },
      occurredAt: hoursAgo(6)
    }
  ];
}

function recordsForKind(kind, business, integration) {
  if (kind === 'inbox') return buildInboxRecords(business, integration);
  if (kind === 'calendar') return buildCalendarRecords(business, integration);
  if (kind === 'accounting') return buildAccountingRecords(business, integration);
  return [];
}

export function listWorkspaceRecords(businessId, kind = null, limit = 20) {
  const db = getDb();
  const rows = kind
    ? db.prepare(`
        SELECT *
        FROM workspace_records
        WHERE business_id = ? AND kind = ?
        ORDER BY datetime(COALESCE(occurred_at, last_synced_at, created_at)) DESC
        LIMIT ?
      `).all(businessId, kind, limit)
    : db.prepare(`
        SELECT *
        FROM workspace_records
        WHERE business_id = ?
        ORDER BY datetime(COALESCE(occurred_at, last_synced_at, created_at)) DESC
        LIMIT ?
      `).all(businessId, limit);

  return rows.map(hydrateRecord);
}

export function listWorkspaceSyncRuns(businessId, limit = 12) {
  const db = getDb();
  return db.prepare(`
    SELECT *
    FROM workspace_sync_runs
    WHERE business_id = ?
    ORDER BY datetime(COALESCE(completed_at, created_at)) DESC
    LIMIT ?
  `).all(businessId, limit).map(hydrateRun);
}

export function getWorkspaceSnapshot(businessId) {
  const inbox = listWorkspaceRecords(businessId, 'inbox', 8);
  const calendar = listWorkspaceRecords(businessId, 'calendar', 8);
  const accounting = listWorkspaceRecords(businessId, 'accounting', 8);
  const syncRuns = listWorkspaceSyncRuns(businessId, 12);
  const syncPlan = getWorkspaceSyncPlan(businessId);

  return {
    summary: {
      inbox_attention: inbox.filter(item => item.status === 'attention').length,
      inbox_total: inbox.length,
      upcoming_events: calendar.filter(item => ['upcoming', 'draft'].includes(item.status)).length,
      posted_entries: accounting.filter(item => item.status === 'posted').length,
      pending_entries: accounting.filter(item => item.status === 'pending').length,
      last_sync_at: syncRuns[0]?.completed_at || syncRuns[0]?.created_at || null,
      due_syncs: syncPlan.filter(item => item.due && item.mode !== 'manual').length
    },
    inbox,
    calendar,
    accounting,
    sync_runs: syncRuns,
    sync_plan: syncPlan
  };
}

export function getWorkspacePromptContext(businessId) {
  const snapshot = getWorkspaceSnapshot(businessId);
  return {
    summary: snapshot.summary,
    inbox: snapshot.inbox.slice(0, 3).map(item => ({
      title: item.title,
      status: item.status,
      summary: item.summary
    })),
    calendar: snapshot.calendar.slice(0, 3).map(item => ({
      title: item.title,
      status: item.status,
      starts_at: item.payload?.starts_at || item.occurred_at
    })),
    accounting: snapshot.accounting.slice(0, 3).map(item => ({
      title: item.title,
      status: item.status,
      amount_cents: item.metadata?.amount_cents || item.payload?.amount_cents || 0
    }))
  };
}

export function syncWorkspaceData({
  business,
  kinds = WORKSPACE_KINDS,
  triggeredBy = 'founder',
  respectSchedule = false
}) {
  const normalizedKinds = WORKSPACE_KINDS.filter(kind => kinds.includes(kind));
  const results = [];

  for (const kind of normalizedKinds) {
    const existing = getIntegration(business.id, kind, { includeSecrets: true });
    const integration = existing || saveWorkspaceIntegrationSettings({ businessId: business.id, kind, updates: {} });
    const schedule = getSyncStatus(kind, integration);

    if (respectSchedule && !schedule.due) {
      results.push({
        kind,
        provider: integration.provider,
        items_synced: 0,
        status: 'skipped',
        next_sync_at: schedule.next_sync_at
      });
      continue;
    }

    const runId = startSyncRun({
      businessId: business.id,
      kind,
      provider: integration.provider,
      triggeredBy
    });

    try {
      const records = recordsForKind(kind, business, integration);
      for (const record of records) {
        upsertWorkspaceRecord({
          businessId: business.id,
          kind,
          provider: integration.provider,
          ...record
        });
      }

      upsertIntegration({
        businessId: business.id,
        kind,
        provider: integration.provider,
        status: integration.status,
        config: {
          ...(integration.config || {}),
          last_synced_at: nowIso(),
          items_synced: records.length,
          next_sync_at: computeNextSyncAt(kind, integration.config || {}, new Date())
        },
        secrets: integration.secrets || {},
        lastSyncAt: nowIso()
      });

      finishSyncRun(runId, {
        status: 'complete',
        summary: `${kind} sync completed`,
        itemsSynced: records.length
      });

      results.push({
        kind,
        provider: integration.provider,
        items_synced: records.length,
        status: 'complete',
        next_sync_at: computeNextSyncAt(kind, integration.config || {}, new Date())
      });
    } catch (err) {
      finishSyncRun(runId, {
        status: 'failed',
        summary: `${kind} sync failed`,
        error: err.message
      });
      results.push({
        kind,
        provider: integration.provider,
        items_synced: 0,
        status: 'failed',
        error: err.message
      });
    }
  }

  return {
    results,
    snapshot: getWorkspaceSnapshot(business.id)
  };
}
