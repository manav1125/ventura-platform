// src/routes/index.js
// All REST API routes mounted under /api

import express from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import {
  registerUser, loginUser, issueTokens, rotateRefreshToken,
  requireAuth, getUserById, getUserByEmail,
  createEmailVerificationToken, verifyEmailToken,
  createPasswordResetToken, resetPasswordWithToken
} from '../auth/auth.js';
import { provisionBusiness } from '../provisioning/provision.js';
import { runBusinessCycle } from '../agents/runner.js';
import { queueTask, getAllTasks, getQueuedTasks } from '../agents/tasks.js';
import { listApprovals, decideApproval } from '../agents/approvals.js';
import { getRecentActivity, logActivity } from '../agents/activity.js';
import { getDb } from '../db/migrate.js';
import { getStats } from '../ws/websocket.js';
import {
  handleStripeWebhook,
  createConnectAccount,
  createDashboardLoginLink,
  createOnboardingLink,
  getConnectAccountSnapshot,
  isMockStripeAccount
} from '../integrations/stripe.js';
import { getDeployments } from '../integrations/deploy.js';
import {
  disconnectSocialProviderConnection,
  getIntegration,
  listIntegrations,
  saveSocialProviderConnection,
  saveStripeIntegrationState,
  syncBusinessIntegrations
} from '../integrations/registry.js';
import {
  completeSocialOauthCallback,
  createSocialOauthSession,
  getSocialOauthMetadata,
  resolveSocialOauthFailure
} from '../integrations/social-oauth.js';
import { getPlanDefinition, resolveBusinessEconomics, serializePlan } from '../billing/plans.js';
import { dispatchSpecialistTask } from '../business/specialists.js';
import {
  getInfrastructureSnapshot,
  testAnalyticsAsset,
  testMailboxAsset,
  updateAnalyticsAsset,
  updateDomainAsset,
  updateMailboxAsset,
  verifyDomainAsset
} from '../infrastructure/assets.js';
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, AGENT_MODEL, STRIPE_SECRET_KEY, FRONTEND_URL } from '../config.js';
import { sendPasswordReset, sendEmailVerification } from '../integrations/email.js';

const router = express.Router();

// ─── Validation helpers ───────────────────────────────────────────────────────

function validate(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const messages = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
    throw Object.assign(new Error(messages.join(', ')), { statusCode: 400 });
  }
  return result.data;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function serializeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    plan: user.plan,
    email_verified: !!user.email_verified,
    email_verified_at: user.email_verified_at || null,
    created_at: user.created_at
  };
}

function getUserUsage(db, userId, plan) {
  const limits = getPlanDefinition(plan).limits;
  const tasksUsed = db.prepare(`
    SELECT COUNT(*) AS n
    FROM tasks t
    JOIN businesses b ON b.id = t.business_id
    WHERE b.user_id = ?
      AND t.triggered_by = 'user'
      AND date(t.created_at) >= date('now', 'start of month')
  `).get(userId).n;
  const businessCount = db.prepare('SELECT COUNT(*) AS n FROM businesses WHERE user_id = ?').get(userId).n;

  return {
    tasks: {
      used: tasksUsed,
      limit: limits.tasks_per_month,
      remaining: Math.max(0, limits.tasks_per_month - tasksUsed)
    },
    businesses: {
      used: businessCount,
      limit: limits.businesses,
      remaining: Math.max(0, limits.businesses - businessCount)
    }
  };
}

function getSpecialistSummary(db, businessId) {
  const rows = db.prepare(`
    SELECT department,
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
           MAX(created_at) AS last_run
    FROM tasks
    WHERE business_id = ?
    GROUP BY department
  `).all(businessId);

  const mapped = {
    planning: { id: 'planning', label: 'Planning', departments: ['strategy'], total: 0, completed: 0, running: 0, last_run: null },
    engineering: { id: 'engineering', label: 'Engineering', departments: ['engineering'], total: 0, completed: 0, running: 0, last_run: null },
    marketing: { id: 'marketing', label: 'Marketing', departments: ['marketing', 'sales'], total: 0, completed: 0, running: 0, last_run: null },
    operations: { id: 'operations', label: 'Operations', departments: ['operations', 'finance'], total: 0, completed: 0, running: 0, last_run: null }
  };

  for (const row of rows) {
    const bucket = row.department === 'strategy'
      ? mapped.planning
      : ['engineering'].includes(row.department)
        ? mapped.engineering
        : ['marketing', 'sales'].includes(row.department)
          ? mapped.marketing
          : mapped.operations;

    bucket.total += row.total || 0;
    bucket.completed += row.completed || 0;
    bucket.running += row.running || 0;
    if (!bucket.last_run || new Date(row.last_run) > new Date(bucket.last_run)) {
      bucket.last_run = row.last_run;
    }
  }

  return Object.values(mapped);
}

function getOwnedBusiness(db, businessId, userId) {
  return db.prepare('SELECT * FROM businesses WHERE id = ? AND user_id = ?').get(businessId, userId);
}

function getBusinessIntegrations(business) {
  let integrations = listIntegrations(business.id);
  if (!integrations.length) {
    integrations = syncBusinessIntegrations(business);
  }
  return integrations.map(integration => {
    if (integration.kind !== 'social') return integration;
    return {
      ...integration,
      config: {
        ...integration.config,
        twitter: {
          ...(integration.config?.twitter || {}),
          oauth: getSocialOauthMetadata('twitter', business.id)
        },
        linkedin: {
          ...(integration.config?.linkedin || {}),
          oauth: getSocialOauthMetadata('linkedin', business.id)
        }
      }
    };
  });
}

function parseJsonField(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normaliseStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') {
        return Object.values(item).filter(Boolean).join(' — ').trim();
      }
      return '';
    })
    .filter(Boolean);
}

function normaliseMemory(rawMemory, business = null) {
  const parsed = parseJsonField(rawMemory, {});
  return {
    business: {
      ...(parsed.business || {}),
      ...(business ? {
        name: business.name,
        type: business.type,
        description: business.description,
        targetCustomer: business.target_customer,
        goal90d: business.goal_90d,
        involvement: business.involvement
      } : {})
    },
    priorities: normaliseStringList(parsed.priorities),
    learnings: normaliseStringList(parsed.learnings),
    competitors: normaliseStringList(parsed.competitors),
    customer_insights: normaliseStringList(parsed.customer_insights),
    notes: normaliseStringList(parsed.notes),
    history: Array.isArray(parsed.history) ? parsed.history.slice(-10) : [],
    last_cycle: parsed.last_cycle || null
  };
}

function sumBy(rows, field) {
  return rows.reduce((total, row) => total + Number(row?.[field] || 0), 0);
}

function averageBy(rows, field) {
  if (!rows.length) return 0;
  return sumBy(rows, field) / rows.length;
}

function calcPctChange(current, previous) {
  if (!previous && !current) return 0;
  if (!previous) return 100;
  return Math.round(((current - previous) / previous) * 100);
}

function getPortfolioOverview(db, userId, plan) {
  const businesses = db.prepare(`
    SELECT b.id, b.name, b.slug, b.type, b.status, b.involvement, b.day_count, b.web_url,
           b.mrr_cents, b.total_revenue_cents, b.revenue_share_pct, b.monthly_subscription_cents,
           (
             SELECT COUNT(*)
             FROM approvals a
             WHERE a.business_id = b.id
               AND a.status = 'pending'
           ) AS pending_approvals,
           (
             SELECT c.status
             FROM agent_cycles c
             WHERE c.business_id = b.id
             ORDER BY c.created_at DESC
             LIMIT 1
           ) AS latest_cycle_status,
           (
             SELECT c.summary
             FROM agent_cycles c
             WHERE c.business_id = b.id
             ORDER BY c.created_at DESC
             LIMIT 1
           ) AS latest_cycle_summary,
           (
             SELECT a.created_at
             FROM activity a
             WHERE a.business_id = b.id
             ORDER BY a.created_at DESC
             LIMIT 1
           ) AS latest_activity_at
    FROM businesses b
    WHERE b.user_id = ?
    ORDER BY b.created_at DESC
  `).all(userId);

  const summary = businesses.reduce((acc, business) => {
    acc.businesses += 1;
    if (business.status === 'active') acc.active_businesses += 1;
    acc.total_mrr_cents += Number(business.mrr_cents || 0);
    acc.total_revenue_cents += Number(business.total_revenue_cents || 0);
    acc.pending_approvals += Number(business.pending_approvals || 0);
    acc.platform_share_cents += Math.floor(Number(business.total_revenue_cents || 0) * (Number(business.revenue_share_pct || 0) / 100));
    return acc;
  }, {
    businesses: 0,
    active_businesses: 0,
    total_mrr_cents: 0,
    total_revenue_cents: 0,
    pending_approvals: 0,
    platform_share_cents: 0
  });

  const running_cycles = db.prepare(`
    SELECT COUNT(*) AS n
    FROM agent_cycles c
    JOIN businesses b ON b.id = c.business_id
    WHERE b.user_id = ?
      AND c.status = 'running'
  `).get(userId).n;
  const alerts_14d = db.prepare(`
    SELECT COUNT(*) AS n
    FROM activity a
    JOIN businesses b ON b.id = a.business_id
    WHERE b.user_id = ?
      AND a.type = 'alert'
      AND datetime(a.created_at) >= datetime('now', '-14 days')
  `).get(userId).n;

  return {
    summary: {
      ...summary,
      running_cycles,
      alerts_14d
    },
    businesses,
    usage: getUserUsage(db, userId, plan),
    plan: serializePlan(plan)
  };
}

function getOperatingSystemSnapshot(db, business, userPlan = 'trial') {
  const metrics = db.prepare(`
    SELECT date, mrr_cents, active_users, new_users, tasks_done, leads, emails_sent, deployments, revenue_cents
    FROM metrics
    WHERE business_id = ?
    ORDER BY date DESC
    LIMIT 30
  `).all(business.id);
  const trend = metrics.slice().reverse();
  const latest = trend[trend.length - 1] || {};
  const previousWeek = trend.slice(Math.max(0, trend.length - 14), Math.max(0, trend.length - 7));
  const latestWeek = trend.slice(Math.max(0, trend.length - 7));
  const tasks = db.prepare(`
    SELECT id, title, description, department, status, priority, triggered_by, created_at, completed_at
    FROM tasks
    WHERE business_id = ?
    ORDER BY created_at DESC
    LIMIT 60
  `).all(business.id);
  const activity = db.prepare(`
    SELECT id, type, department, title, detail, created_at
    FROM activity
    WHERE business_id = ?
    ORDER BY created_at DESC
    LIMIT 80
  `).all(business.id).map(item => ({
    ...item,
    detail: parseJsonField(item.detail, {})
  }));
  const deployments = getDeployments(business.id, 20);
  const approvals = listApprovals(business.id, { limit: 25 });
  const leadsByStatus = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM leads
    WHERE business_id = ?
    GROUP BY status
    ORDER BY count DESC, status ASC
  `).all(business.id);
  const leadsBySource = db.prepare(`
    SELECT source, COUNT(*) AS count
    FROM leads
    WHERE business_id = ?
    GROUP BY source
    ORDER BY count DESC, source ASC
    LIMIT 8
  `).all(business.id);
  const recentLeads = db.prepare(`
    SELECT id, name, email, company, status, source, created_at, last_contact
    FROM leads
    WHERE business_id = ?
    ORDER BY created_at DESC
    LIMIT 8
  `).all(business.id);
  const now = Date.now();
  const since7d = now - (7 * 86400000);
  const since14d = now - (14 * 86400000);
  const since30d = now - (30 * 86400000);
  const memory = normaliseMemory(business.agent_memory, business);
  const economics = resolveBusinessEconomics(business, userPlan);
  const integrations = getBusinessIntegrations(business);
  const infrastructure = getInfrastructureSnapshot(business, integrations);
  const stripeIntegration = integrations.find(integration => integration.kind === 'stripe');
  const stripeConfig = stripeIntegration?.config || {};
  const engineeringTasks = tasks.filter(task => task.department === 'engineering');
  const marketingTasks = tasks.filter(task => ['marketing', 'sales'].includes(task.department));
  const operationsTasks = tasks.filter(task => ['operations', 'finance'].includes(task.department));
  const engineeringActivity = activity.filter(item => ['deploy', 'code'].includes(item.type) || item.department === 'engineering');
  const marketingActivity = activity.filter(item => ['marketing', 'sales'].includes(item.department) || ['email_sent', 'content', 'lead', 'research'].includes(item.type));
  const operationsActivity = activity.filter(item => ['operations', 'finance'].includes(item.department) || ['alert', 'system'].includes(item.type));
  const marketingActivity30d = marketingActivity.filter(item => new Date(item.created_at).getTime() >= since30d);
  const operationsActivity30d = operationsActivity.filter(item => new Date(item.created_at).getTime() >= since30d);
  const pendingApprovals = approvals.filter(item => item.status === 'pending');
  const recentAlertItems = activity.filter(item => item.type === 'alert' && new Date(item.created_at).getTime() >= since14d);
  const alertRows = recentAlertItems.slice(0, 8);
  const founderInbox = [
    ...pendingApprovals.map(approval => ({
      kind: 'approval',
      id: approval.id,
      title: approval.title,
      summary: approval.summary || 'Founder review required',
      status: approval.status,
      created_at: approval.created_at
    })),
    ...alertRows.map(alert => ({
      kind: 'alert',
      id: alert.id,
      title: alert.title,
      summary: alert.detail?.detail || alert.detail?.summary || 'Ventura flagged this for review',
      status: 'review',
      created_at: alert.created_at
    }))
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 12);

  const deployments30d = sumBy(trend, 'deployments');
  const tasks30d = sumBy(trend, 'tasks_done');
  const leads30d = sumBy(trend, 'leads');
  const emails30d = sumBy(trend, 'emails_sent');
  const revenue30d = sumBy(trend, 'revenue_cents');
  const activeUsersCurrent = Number(latest.active_users || 0);
  const activeUsersPrevious = Math.round(averageBy(previousWeek, 'active_users'));
  const mrrCurrent = Number(latest.mrr_cents || business.mrr_cents || 0);
  const mrrPrevious = Math.round(averageBy(previousWeek, 'mrr_cents'));
  const openEngineeringTasks = engineeringTasks.filter(task => !['complete', 'cancelled'].includes(task.status)).length;
  const runningOperations = operationsTasks.filter(task => task.status === 'running').length;
  const handledOps30d = operationsActivity30d.filter(item => item.type === 'email_sent').length;
  const content30d = marketingActivity30d.filter(item => item.type === 'content').length;
  const campaigns30d = marketingActivity30d.filter(item => ['email_sent', 'content', 'lead'].includes(item.type)).length;
  const qualifiedLeads = leadsByStatus.find(item => item.status === 'qualified')?.count || 0;
  const wonLeads = leadsByStatus.find(item => item.status === 'won')?.count || 0;
  const totalLeads = db.prepare('SELECT COUNT(*) AS n FROM leads WHERE business_id = ?').get(business.id).n;
  const openReviews = pendingApprovals.length + recentAlertItems.length;
  const recentAlerts = recentAlertItems.length;
  const uptimePct = Math.max(97, Number((99.9 - Math.min(recentAlerts * 0.3, 2.5)).toFixed(1)));

  return {
    business: {
      id: business.id,
      name: business.name,
      slug: business.slug,
      type: business.type,
      description: business.description,
      target_customer: business.target_customer,
      goal_90d: business.goal_90d,
      day_count: business.day_count,
      web_url: business.web_url,
      email_address: business.email_address,
      involvement: business.involvement,
      status: business.status,
      stripe_account_id: business.stripe_account_id,
      mrr_cents: business.mrr_cents,
      arr_cents: business.arr_cents,
      total_revenue_cents: business.total_revenue_cents
    },
    billing: {
      plan: serializePlan(userPlan),
      economics,
      stripe: {
        configured: !!STRIPE_SECRET_KEY,
        connected: !!stripeConfig.connected,
        mocked: !!stripeConfig.mocked,
        status: stripeIntegration?.status || (STRIPE_SECRET_KEY ? 'pending' : 'mocked'),
        account_id: stripeConfig.account_id || business.stripe_account_id || null,
        onboarding_complete: !!stripeConfig.onboarding_complete,
        charges_enabled: !!stripeConfig.charges_enabled,
        payouts_enabled: !!stripeConfig.payouts_enabled,
        details_submitted: !!stripeConfig.details_submitted,
        requirements_due: Number(stripeConfig.requirements_due || 0),
        requirements: Array.isArray(stripeConfig.requirements) ? stripeConfig.requirements : [],
        dashboard_ready: !!stripeConfig.dashboard_ready
      }
    },
    memory,
    engineering: {
      summary: {
        deployments_30d: deployments30d,
        open_tasks: openEngineeringTasks,
        completed_7d: engineeringTasks.filter(task => task.status === 'complete' && new Date(task.completed_at || task.created_at).getTime() >= since7d).length,
        uptime_pct: uptimePct
      },
      deployments,
      tasks: engineeringTasks.slice(0, 12),
      activity: engineeringActivity.slice(0, 12),
      preview: {
        url: business.web_url,
        email: business.email_address
      }
    },
    marketing: {
      summary: {
        emails_30d: emails30d,
        campaigns_30d: campaigns30d,
        content_30d: content30d,
        leads_total: totalLeads,
        qualified_leads: qualifiedLeads,
        won_leads: wonLeads
      },
      campaigns: marketingActivity.slice(0, 14),
      leads: {
        by_status: leadsByStatus,
        by_source: leadsBySource,
        recent: recentLeads
      },
      tasks: marketingTasks.slice(0, 12)
    },
    operations: {
      summary: {
        pending_reviews: openReviews,
        handled_30d: handledOps30d,
        alerts_14d: recentAlerts,
        running_tasks: runningOperations
      },
      founder_inbox: founderInbox,
      alerts: alertRows,
      tasks: operationsTasks.slice(0, 12)
    },
    analytics: {
      summary: {
        mrr_cents: mrrCurrent,
        arr_cents: Number(business.arr_cents || (mrrCurrent * 12)),
        total_revenue_cents: Number(business.total_revenue_cents || 0),
        revenue_30d_cents: revenue30d,
        revenue_share_pct: Number(economics.revenue_share_pct || business.revenue_share_pct || 0),
        platform_share_cents: Math.floor(Number(business.total_revenue_cents || 0) * ((Number(economics.revenue_share_pct || business.revenue_share_pct || 0)) / 100)),
        active_users: activeUsersCurrent,
        active_users_change_pct: calcPctChange(activeUsersCurrent, activeUsersPrevious),
        mrr_change_pct: calcPctChange(mrrCurrent, mrrPrevious),
        tasks_30d: tasks30d,
        leads_30d: leads30d,
        emails_30d: emails30d,
        deployments_30d: deployments30d
      },
      trend,
      funnel: leadsByStatus
    },
    infrastructure
  };
}

function sanitizePublicIntegration(kind, config = {}) {
  if (kind === 'database') return { namespace: config.namespace || null };
  if (kind === 'website') return { url: config.url || null, domain: config.domain || null };
  if (kind === 'email') return { address: config.address || null };
  if (kind === 'stripe') return {
    connected: !!config.connected,
    mocked: !!config.mocked,
    onboarding_complete: !!config.onboarding_complete
  };
  if (kind === 'analytics') return { source: config.source || null };
  if (kind === 'search') return { live_research: !!config.live_research };
  if (kind === 'social') return {
    connected_providers: Array.isArray(config.connected_providers) ? config.connected_providers : [],
    twitter: !!(config.twitter?.connected || config.twitter === true),
    linkedin: !!(config.linkedin?.connected || config.linkedin === true)
  };
  if (kind === 'calendar') return { note: config.note || null };
  return {};
}

function sanitizePublicInfrastructureAsset(asset = {}) {
  if (asset.kind === 'domain') {
    return {
      kind: 'domain',
      status: asset.status,
      active_domain: asset.config?.active_domain || null,
      custom_domain: asset.config?.custom_domain || null,
      using_platform_domain: !!asset.config?.using_platform_domain
    };
  }
  if (asset.kind === 'mailbox') {
    return {
      kind: 'mailbox',
      status: asset.status,
      address: asset.config?.address || null,
      delivery_mode: asset.config?.delivery_mode || null
    };
  }
  if (asset.kind === 'analytics') {
    return {
      kind: 'analytics',
      status: asset.status,
      provider: asset.config?.provider || null,
      site: asset.config?.site || null
    };
  }
  return { kind: asset.kind, status: asset.status };
}

function serializePublicBusiness(row, fallbackPlan = 'trial') {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type,
    status: row.status,
    involvement: row.involvement,
    day_count: row.day_count,
    web_url: row.web_url,
    description: row.description,
    target_customer: row.target_customer,
    goal_90d: row.goal_90d,
    mrr_cents: row.mrr_cents,
    total_revenue_cents: row.total_revenue_cents,
    latest_headline: row.latest_headline,
    latest_activity_at: row.latest_activity_at,
    economics: resolveBusinessEconomics(row, fallbackPlan)
  };
}

function getApprovalSummary(db, businessId) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM approvals
    WHERE business_id = ?
    GROUP BY status
  `).all(businessId);

  const summary = {
    pending: 0,
    approved: 0,
    rejected: 0,
    executed: 0,
    failed: 0,
    total: 0
  };

  for (const row of rows) {
    summary[row.status] = row.count;
    summary.total += row.count;
  }

  return summary;
}

function getPublicBusinessDetail(db, businessRow, fallbackPlan = 'trial') {
  const business = serializePublicBusiness(businessRow, fallbackPlan);
  const integrations = getBusinessIntegrations(businessRow);
  const infrastructure = getInfrastructureSnapshot(businessRow, integrations);

  const recentActivity = db.prepare(`
    SELECT type, department, title, created_at
    FROM activity
    WHERE business_id = ?
    ORDER BY created_at DESC
    LIMIT 12
  `).all(businessRow.id);
  const deployments = getDeployments(businessRow.id, 8);
  const recentCycles = db.prepare(`
    SELECT status, triggered_by, tasks_run, summary, created_at
    FROM agent_cycles
    WHERE business_id = ?
    ORDER BY created_at DESC
    LIMIT 5
  `).all(businessRow.id);
  const recentApprovals = listApprovals(businessRow.id, { limit: 12 }).map(approval => ({
    id: approval.id,
    action_type: approval.action_type,
    title: approval.title,
    summary: approval.summary,
    status: approval.status,
    decision_note: approval.decision_note || null,
    execution_result: approval.execution_result || null,
    created_at: approval.created_at,
    decided_at: approval.decided_at || null
  }));
  const specialists = getSpecialistSummary(db, businessRow.id);
  const tasks7d = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed
    FROM tasks
    WHERE business_id = ?
      AND datetime(created_at) >= datetime('now', '-7 days')
  `).get(businessRow.id);
  const email7d = db.prepare(`
    SELECT COUNT(*) AS total
    FROM activity
    WHERE business_id = ?
      AND type = 'email_sent'
      AND datetime(created_at) >= datetime('now', '-7 days')
  `).get(businessRow.id);
  const deploy30d = db.prepare(`
    SELECT COUNT(*) AS total
    FROM deployments
    WHERE business_id = ?
      AND datetime(created_at) >= datetime('now', '-30 days')
  `).get(businessRow.id);

  return {
    business,
    infrastructure: {
      summary: {
        connected_assets: infrastructure.assets.filter(asset => ['connected', 'configured'].includes(asset.status)).length,
        total_assets: infrastructure.assets.length
      },
      assets: infrastructure.assets.map(sanitizePublicInfrastructureAsset)
    },
    integrations: integrations.map(integration => ({
      kind: integration.kind,
      provider: integration.provider,
      status: integration.status,
      last_sync_at: integration.last_sync_at,
      config: sanitizePublicIntegration(integration.kind, integration.config)
    })),
    recentActivity,
    deployments,
    recentCycles,
    recentApprovals,
    approvalSummary: getApprovalSummary(db, businessRow.id),
    specialists,
    stats: {
      tasks_7d: tasks7d.total || 0,
      tasks_completed_7d: tasks7d.completed || 0,
      emails_7d: email7d.total || 0,
      deployments_30d: deploy30d.total || 0
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/auth/register
router.post('/auth/register', asyncHandler(async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    name: z.string().min(2).max(80),
    password: z.string().min(8)
  });
  const body = validate(schema, req.body);
  const user = await registerUser(body);
  const verificationToken = createEmailVerificationToken(user.id);
  sendEmailVerification(user.email, user.name, `${FRONTEND_URL}#verify-email/${verificationToken}`)
    .catch(err => console.error(`Verification email failed: ${err.message}`));
  const tokens = issueTokens(user);
  res.status(201).json({
    user: serializeUser(user),
    verification: { required: true },
    ...tokens
  });
}));

// POST /api/auth/login
router.post('/auth/login', asyncHandler(async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    password: z.string()
  });
  const body = validate(schema, req.body);
  const user = await loginUser(body);
  const tokens = issueTokens(user);
  const safeUser = serializeUser(user);
  res.json({ user: safeUser, ...tokens });
}));

// POST /api/auth/refresh
router.post('/auth/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  const tokens = rotateRefreshToken(refreshToken);
  res.json(tokens);
}));

// GET /api/auth/me
router.get('/auth/me', requireAuth, asyncHandler(async (req, res) => {
  const user = getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: serializeUser(user) });
}));

// POST /api/auth/forgot-password
router.post('/auth/forgot-password', asyncHandler(async (req, res) => {
  const schema = z.object({
    email: z.string().email()
  });
  const body = validate(schema, req.body);
  const user = getUserByEmail(body.email);

  if (user) {
    const resetToken = createPasswordResetToken(user.id);
    sendPasswordReset(user.email, `${FRONTEND_URL}#reset-password/${resetToken}`)
      .catch(err => console.error(`Password reset email failed: ${err.message}`));
  }

  res.json({
    success: true,
    message: 'If that email exists, a password reset link is on the way.'
  });
}));

// POST /api/auth/reset-password
router.post('/auth/reset-password', asyncHandler(async (req, res) => {
  const schema = z.object({
    token: z.string().min(10),
    newPassword: z.string().min(8)
  });
  const body = validate(schema, req.body);
  await resetPasswordWithToken(body.token, body.newPassword);
  res.json({ success: true, message: 'Password updated. You can sign in now.' });
}));

// POST /api/auth/resend-verification
router.post('/auth/resend-verification', requireAuth, asyncHandler(async (req, res) => {
  const user = getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.email_verified) {
    return res.json({ success: true, alreadyVerified: true });
  }

  const verificationToken = createEmailVerificationToken(user.id);
  sendEmailVerification(user.email, user.name, `${FRONTEND_URL}#verify-email/${verificationToken}`)
    .catch(err => console.error(`Resend verification failed: ${err.message}`));

  res.json({ success: true });
}));

// POST /api/auth/verify-email
router.post('/auth/verify-email', asyncHandler(async (req, res) => {
  const schema = z.object({
    token: z.string().min(10)
  });
  const body = validate(schema, req.body);
  const user = verifyEmailToken(body.token);
  res.json({ success: true, user: serializeUser(user) });
}));

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/businesses — list all businesses for the logged-in user
router.get('/businesses', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const businesses = db.prepare(`
    SELECT id, name, slug, type, status, involvement, day_count, web_url, email_address,
           mrr_cents, total_revenue_cents, monthly_subscription_cents, revenue_share_pct, created_at
    FROM businesses WHERE user_id = ? ORDER BY created_at DESC
  `).all(req.user.sub);
  res.json({ businesses });
}));

// POST /api/businesses — launch a new business
router.post('/businesses', requireAuth, asyncHandler(async (req, res) => {
  const schema = z.object({
    name: z.string().min(2).max(100),
    type: z.enum(['saas', 'agency', 'ecommerce', 'content', 'marketplace', 'education', 'other']),
    description: z.string().min(20).max(2000),
    targetCustomer: z.string().min(5).max(500),
    goal90d: z.string().min(5).max(500),
    involvement: z.enum(['autopilot', 'review', 'daily']).default('autopilot')
  });
  const body = validate(schema, req.body);

  // Plan limits
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.sub);
  const usage = getUserUsage(db, req.user.sub, user.plan);

  if (usage.businesses.used >= usage.businesses.limit) {
    return res.status(403).json({ error: `Plan limit reached. Upgrade to add more businesses.` });
  }

  res.status(202).json({ message: 'Provisioning started', status: 'provisioning' });

  // Kick off provisioning in the background (don't await)
  provisionBusiness({ userId: req.user.sub, ...body })
    .then(result => console.log(`✅ Business provisioned: ${result.businessId}`))
    .catch(err => console.error(`❌ Provisioning failed: ${err.message}`));
}));

// GET /api/businesses/:id — get a single business
router.get('/businesses/:id', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  // Parse JSON field
  business.agent_memory = JSON.parse(business.agent_memory || '{}');
  res.json({ business });
}));

// PATCH /api/businesses/:id — update business settings
router.patch('/businesses/:id', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const schema = z.object({
    name: z.string().min(2).max(100).optional(),
    type: z.enum(['saas', 'agency', 'ecommerce', 'content', 'marketplace', 'education', 'other']).optional(),
    description: z.string().optional(),
    targetCustomer: z.string().optional(),
    goal90d: z.string().optional(),
    involvement: z.enum(['autopilot', 'review', 'daily']).optional(),
    status: z.enum(['active', 'paused']).optional()
  });
  const rawBody = validate(schema, req.body);
  const body = {
    ...rawBody,
    goal_90d: rawBody.goal90d,
    target_customer: rawBody.targetCustomer
  };
  delete body.goal90d;
  delete body.targetCustomer;

  const updates = Object.entries(body)
    .filter(([_, v]) => v !== undefined)
    .map(([k, _]) => `${k} = ?`).join(', ');
  const values = [...Object.values(body).filter(v => v !== undefined), req.params.id];

  if (updates) {
    db.prepare(`UPDATE businesses SET ${updates}, updated_at=datetime('now') WHERE id=?`).run(...values);

    if (body.status && body.status !== business.status) {
      await logActivity(req.params.id, {
        type: 'system',
        department: 'operations',
        title: body.status === 'paused' ? 'Founder paused the autonomous loop' : 'Founder resumed the autonomous loop',
        detail: { previous: business.status, next: body.status }
      });
    }

    if (body.involvement && body.involvement !== business.involvement) {
      await logActivity(req.params.id, {
        type: 'system',
        department: 'strategy',
        title: `Founder changed control mode to ${body.involvement}`,
        detail: { previous: business.involvement, next: body.involvement }
      });
    }

    if (body.name || body.description || body.target_customer || body.goal_90d || body.type) {
      await logActivity(req.params.id, {
        type: 'system',
        department: 'strategy',
        title: 'Founder updated the business profile',
        detail: {
          name: body.name || business.name,
          type: body.type || business.type
        }
      });
    }
  }

  res.json({ success: true });
}));

// ─────────────────────────────────────────────────────────────────────────────
// AGENT ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/businesses/:id/run — manually trigger agent cycle
router.post('/businesses/:id/run', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Business not found' });
  if (business.status !== 'active') return res.status(400).json({ error: 'Business is not active' });

  // Check no cycle already running
  const running = db.prepare(`SELECT id FROM agent_cycles WHERE business_id=? AND status='running'`).get(req.params.id);
  if (running) return res.status(409).json({ error: 'A cycle is already running', cycleId: running.id });

  res.status(202).json({ message: 'Agent cycle started', businessId: req.params.id });

  // Run in background
  runBusinessCycle(business, 'manual')
    .catch(err => console.error(`Manual cycle failed: ${err.message}`));
}));

// GET /api/businesses/:id/cycles — list agent cycles
router.get('/businesses/:id/cycles', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const cycles = db.prepare(`
    SELECT * FROM agent_cycles WHERE business_id=? ORDER BY created_at DESC LIMIT 30
  `).all(req.params.id);
  res.json({ cycles });
}));

// ─────────────────────────────────────────────────────────────────────────────
// TASK ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/businesses/:id/tasks
router.get('/businesses/:id/tasks', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });
  const tasks = getAllTasks(req.params.id, 100);
  res.json({ tasks });
}));

// POST /api/businesses/:id/tasks — queue a task manually
router.post('/businesses/:id/tasks', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const user = db.prepare('SELECT plan FROM users WHERE id=?').get(req.user.sub);
  const usage = getUserUsage(db, req.user.sub, user.plan);
  if (usage.tasks.used >= usage.tasks.limit) {
    return res.status(403).json({ error: `Monthly founder task limit reached for ${user.plan}.` });
  }

  const schema = z.object({
    title: z.string().min(3).max(300),
    description: z.string().optional(),
    department: z.enum(['engineering', 'marketing', 'operations', 'strategy', 'sales', 'finance']),
    priority: z.number().int().min(1).max(10).default(3)
  });
  const body = validate(schema, req.body);

  const taskId = await queueTask({
    businessId: req.params.id,
    ...body,
    triggeredBy: 'user'
  });
  res.status(201).json({ taskId });
}));

// GET /api/businesses/:id/integrations
router.get('/businesses/:id/integrations', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  res.json({ integrations: getBusinessIntegrations(business) });
}));

// POST /api/businesses/:id/integrations/sync
router.post('/businesses/:id/integrations/sync', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const integrations = syncBusinessIntegrations(business);
  const infrastructure = getInfrastructureSnapshot(business, integrations);
  await logActivity(req.params.id, {
    type: 'system',
    department: 'operations',
    title: 'Founder synced the integration registry',
    detail: { integrations: integrations.length }
  });
  res.json({ integrations, infrastructure, syncedAt: new Date().toISOString() });
}));

// POST /api/businesses/:id/integrations/social/:provider/oauth/start
router.post('/businesses/:id/integrations/social/:provider/oauth/start', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const provider = req.params.provider;
  if (!['twitter', 'linkedin'].includes(provider)) {
    return res.status(400).json({ error: 'Unsupported social provider' });
  }

  const session = await createSocialOauthSession({
    provider,
    businessId: business.id,
    userId: req.user.sub
  });

  await logActivity(req.params.id, {
    type: 'system',
    department: 'marketing',
    title: `Founder started ${provider === 'twitter' ? 'X' : 'LinkedIn'} OAuth`,
    detail: { provider }
  });

  res.json(session);
}));

// PATCH /api/businesses/:id/integrations/social/:provider
router.patch('/businesses/:id/integrations/social/:provider', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const provider = req.params.provider;
  if (!['twitter', 'linkedin'].includes(provider)) {
    return res.status(400).json({ error: 'Unsupported social provider' });
  }

  const schema = provider === 'twitter'
    ? z.object({
      handle: z.string().max(80).optional(),
      profileUrl: z.union([z.string().url(), z.literal('')]).optional(),
      accountLabel: z.string().max(120).optional(),
      accountId: z.string().max(180).optional(),
      accessToken: z.string().max(5000).optional(),
      refreshToken: z.string().max(5000).optional(),
      expiresAt: z.string().max(120).optional()
    })
    : z.object({
      organization: z.string().max(160).optional(),
      organizationUrn: z.string().max(220).optional(),
      authorUrn: z.string().max(220).optional(),
      pageUrl: z.union([z.string().url(), z.literal('')]).optional(),
      accessToken: z.string().max(5000).optional(),
      refreshToken: z.string().max(5000).optional(),
      expiresAt: z.string().max(120).optional()
    });

  const body = validate(schema, req.body || {});
  const integration = saveSocialProviderConnection({
    businessId: business.id,
    provider,
    updates: body
  });

  await logActivity(req.params.id, {
    type: 'system',
    department: 'marketing',
    title: `Founder updated ${provider === 'twitter' ? 'X' : 'LinkedIn'} connection`,
    detail: {
      provider,
      connected: !!integration?.config?.[provider]?.connected
    }
  });

  res.json({ integration });
}));

// DELETE /api/businesses/:id/integrations/social/:provider
router.delete('/businesses/:id/integrations/social/:provider', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const provider = req.params.provider;
  if (!['twitter', 'linkedin'].includes(provider)) {
    return res.status(400).json({ error: 'Unsupported social provider' });
  }

  const integration = disconnectSocialProviderConnection({
    businessId: business.id,
    provider
  });

  await logActivity(req.params.id, {
    type: 'system',
    department: 'marketing',
    title: `Founder disconnected ${provider === 'twitter' ? 'X' : 'LinkedIn'}`,
    detail: { provider }
  });

  res.json({ integration });
}));

// GET /api/oauth/:provider/callback
router.get('/oauth/:provider/callback', asyncHandler(async (req, res) => {
  const provider = req.params.provider;
  if (!['twitter', 'linkedin'].includes(provider)) {
    return res.status(400).json({ error: 'Unsupported social provider' });
  }

  if (req.query.error) {
    const redirectUrl = resolveSocialOauthFailure({
      provider,
      state: req.query.state || '',
      error: cleanString(req.query.error_description || req.query.error)
    });
    return res.redirect(302, redirectUrl);
  }

  if (!req.query.code || !req.query.state) {
    const redirectUrl = resolveSocialOauthFailure({
      provider,
      state: req.query.state || '',
      fallbackMessage: 'This social connection callback is missing required data'
    });
    return res.redirect(302, redirectUrl);
  }

  try {
    const redirectUrl = await completeSocialOauthCallback({
      provider,
      code: String(req.query.code || ''),
      state: String(req.query.state || '')
    });
    return res.redirect(302, redirectUrl);
  } catch (err) {
    const redirectUrl = resolveSocialOauthFailure({
      provider,
      state: req.query.state || '',
      businessId: err.businessId || '',
      fallbackMessage: err.message || `${provider} connection failed`
    });
    return res.redirect(302, redirectUrl);
  }
}));

// POST /api/businesses/:id/specialists/:specialist/run
router.post('/businesses/:id/specialists/:specialist/run', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });
  if (business.status === 'cancelled') return res.status(400).json({ error: 'Business is cancelled' });

  const schema = z.object({
    brief: z.string().max(500).optional()
  });
  const body = validate(schema, req.body || {});

  const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(req.user.sub);
  const usage = getUserUsage(db, req.user.sub, user.plan);
  if (usage.tasks.used >= usage.tasks.limit) {
    return res.status(403).json({ error: `Monthly founder task limit reached for ${user.plan}.` });
  }

  const task = await dispatchSpecialistTask({
    business,
    specialist: req.params.specialist,
    brief: body.brief || '',
    triggeredBy: 'user'
  });

  await logActivity(req.params.id, {
    type: 'system',
    department: task.department,
    title: `Founder dispatched ${task.label} specialist`,
    detail: { specialist: task.specialist, taskId: task.taskId, brief: body.brief || '' }
  });

  res.status(201).json(task);
}));

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/businesses/:id/activity
router.get('/businesses/:id/activity', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });
  const limit = parseInt(req.query.limit) || 50;
  const activity = getRecentActivity(req.params.id, limit);
  res.json({ activity });
}));

// ─────────────────────────────────────────────────────────────────────────────
// METRICS ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/businesses/:id/metrics
router.get('/businesses/:id/metrics', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = db.prepare('SELECT id,mrr_cents,total_revenue_cents,day_count FROM businesses WHERE id=? AND user_id=?')
    .get(req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const daily = db.prepare(`
    SELECT * FROM metrics WHERE business_id=? ORDER BY date DESC LIMIT 30
  `).all(req.params.id);

  const leads = db.prepare(`
    SELECT status, COUNT(*) as count FROM leads WHERE business_id=? GROUP BY status
  `).all(req.params.id);

  res.json({ business, daily, leads });
}));

// ─────────────────────────────────────────────────────────────────────────────
// CHAT ROUTES (agent conversation)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/businesses/:id/messages
router.get('/businesses/:id/messages', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const messages = db.prepare(`
    SELECT * FROM messages WHERE business_id=? ORDER BY created_at ASC LIMIT 100
  `).all(req.params.id);
  res.json({ messages });
}));

// POST /api/businesses/:id/messages — send a message to the agent
router.post('/businesses/:id/messages', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const schema = z.object({ content: z.string().min(1).max(4000) });
  const { content } = validate(schema, req.body);

  // Save user message
  const userMsgId = uuid();
  db.prepare(`INSERT INTO messages (id, business_id, role, content) VALUES (?, ?, 'user', ?)`).run(userMsgId, req.params.id, content);

  // Build history for context
  const history = db.prepare(`
    SELECT role, content FROM messages WHERE business_id=? ORDER BY created_at ASC LIMIT 20
  `).all(req.params.id);

  // Get agent reply
  const memory = JSON.parse(business.agent_memory || '{}');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const systemPrompt = `You are the AI operator for "${business.name}", a ${business.type} business. You have been running this business for ${business.day_count} days.

Current MRR: $${(business.mrr_cents / 100).toFixed(2)}
Website: ${business.web_url}
Goal: ${business.goal_90d}

Memory context: ${JSON.stringify(memory, null, 2)}

You are talking directly with the founder. Be direct, specific, and helpful. Reference real data about the business when relevant. You can suggest tasks, explain decisions you made, and give strategic advice. Keep responses conversational and under 200 words.`;

  const aiResponse = await client.messages.create({
    model: AGENT_MODEL,
    max_tokens: 512,
    system: systemPrompt,
    messages: history.map(m => ({ role: m.role, content: m.content }))
  });

  const aiContent = aiResponse.content[0].text;

  // Save AI reply
  const aiMsgId = uuid();
  db.prepare(`INSERT INTO messages (id, business_id, role, content) VALUES (?, ?, 'assistant', ?)`).run(aiMsgId, req.params.id, aiContent);

  // Push via WebSocket
  const { emitToBusiness } = await import('../ws/websocket.js');
  emitToBusiness(req.params.id, { event: 'message:new', role: 'assistant', content: aiContent, id: aiMsgId });

  res.json({ message: { id: aiMsgId, role: 'assistant', content: aiContent } });
}));

// GET /api/businesses/:id/deployments
router.get('/businesses/:id/deployments', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });
  res.json({ deployments: getDeployments(req.params.id, 30) });
}));

// GET /api/businesses/:id/approvals
router.get('/businesses/:id/approvals', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });
  res.json({ approvals: listApprovals(req.params.id, { status: req.query.status || null, limit: parseInt(req.query.limit || '25', 10) }) });
}));

// POST /api/businesses/:id/approvals/:approvalId/decision
router.post('/businesses/:id/approvals/:approvalId/decision', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const schema = z.object({
    decision: z.enum(['approve', 'reject']),
    note: z.string().max(500).optional()
  });
  const body = validate(schema, req.body);
  const approval = await decideApproval({
    approvalId: req.params.approvalId,
    businessId: req.params.id,
    userId: req.user.sub,
    decision: body.decision,
    note: body.note || ''
  });
  res.json({ approval });
}));

// GET /api/businesses/:id/control-center
router.get('/businesses/:id/control-center', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(req.user.sub);
  const economics = resolveBusinessEconomics(business, user.plan);
  const hydratedBusiness = {
    ...business,
    ...economics,
    infrastructure_included: economics.infrastructure_included ? 1 : 0
  };
  const recentCycles = db.prepare(`
    SELECT id, status, triggered_by, started_at, completed_at, tasks_run, summary, error, created_at
    FROM agent_cycles
    WHERE business_id = ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(req.params.id);

  const latestCycle = recentCycles[0] || null;
  const approvals = listApprovals(req.params.id, { limit: 25 });
  let deployments = getDeployments(req.params.id, 10);
  const integrations = getBusinessIntegrations(hydratedBusiness);
  const infrastructure = getInfrastructureSnapshot(hydratedBusiness, integrations);
  if (!deployments.length) {
    deployments = db.prepare(`
      SELECT id,
             business_id,
             printf('activity-%s', substr(id, 1, 8)) AS version,
             title AS description,
             0 AS files_changed,
             'live' AS status,
             created_at
      FROM activity
      WHERE business_id = ? AND type = 'deploy'
      ORDER BY created_at DESC
      LIMIT 10
    `).all(req.params.id);
  }
  const specialists = getSpecialistSummary(db, req.params.id);
  const recentActivity = getRecentActivity(req.params.id, 8);
  const usage = getUserUsage(db, req.user.sub, user.plan);

  res.json({
    business: hydratedBusiness,
    latestCycle,
    recentCycles,
    recentActivity,
    approvals,
    deployments,
    integrations,
    infrastructure,
    specialists,
    usage,
    economics,
    plan: serializePlan(user.plan)
  });
}));

// GET /api/businesses/:id/infrastructure/readiness — domain, mailbox, analytics, provider checklist
router.get('/businesses/:id/infrastructure/readiness', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const integrations = getBusinessIntegrations(business);
  res.json(getInfrastructureSnapshot(business, integrations));
}));

// PATCH /api/businesses/:id/infrastructure/domain
router.patch('/businesses/:id/infrastructure/domain', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const schema = z.object({
    customDomain: z.union([z.string().min(3).max(255), z.literal('')]).optional(),
    dnsProvider: z.string().max(120).optional(),
    notes: z.string().max(400).optional()
  });
  const body = validate(schema, req.body || {});
  const asset = updateDomainAsset(business, body);

  await logActivity(req.params.id, {
    type: 'system',
    department: 'engineering',
    title: asset?.config?.custom_domain
      ? `Founder updated custom domain to ${asset.config.custom_domain}`
      : 'Founder restored the Ventura managed domain',
    detail: {
      active_domain: asset?.config?.active_domain || null,
      custom_domain: asset?.config?.custom_domain || null
    }
  });

  res.json({ asset, infrastructure: getInfrastructureSnapshot({ ...business, web_url: asset?.config?.active_url || business.web_url }) });
}));

// POST /api/businesses/:id/infrastructure/domain/verify
router.post('/businesses/:id/infrastructure/domain/verify', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const schema = z.object({
    dnsConfirmed: z.boolean().optional()
  });
  const body = validate(schema, req.body || {});
  const asset = verifyDomainAsset(business, { dnsConfirmed: !!body.dnsConfirmed });

  await logActivity(req.params.id, {
    type: asset.status === 'connected' ? 'deploy' : 'system',
    department: 'engineering',
    title: asset.status === 'connected'
      ? `Custom domain verified: ${asset.config.active_domain}`
      : `Custom domain verification started for ${asset.config.custom_domain}`,
    detail: {
      active_domain: asset.config.active_domain,
      custom_domain: asset.config.custom_domain,
      status: asset.status
    }
  });

  res.json({ asset, infrastructure: getInfrastructureSnapshot({ ...business, web_url: asset.config.active_url }) });
}));

// PATCH /api/businesses/:id/infrastructure/mailbox
router.patch('/businesses/:id/infrastructure/mailbox', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const schema = z.object({
    forwardingAddress: z.union([z.string().email(), z.literal('')]).optional(),
    replyTo: z.union([z.string().email(), z.literal('')]).optional(),
    senderName: z.string().max(120).optional()
  });
  const body = validate(schema, req.body || {});
  const asset = updateMailboxAsset(business, body);

  await logActivity(req.params.id, {
    type: 'system',
    department: 'operations',
    title: 'Founder updated mailbox routing',
    detail: {
      forwarding_address: asset?.config?.forwarding_address || null,
      delivery_mode: asset?.config?.delivery_mode || null
    }
  });

  res.json({ asset, infrastructure: getInfrastructureSnapshot(business) });
}));

// POST /api/businesses/:id/infrastructure/mailbox/test
router.post('/businesses/:id/infrastructure/mailbox/test', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const schema = z.object({
    recipient: z.union([z.string().email(), z.literal('')]).optional()
  });
  const body = validate(schema, req.body || {});
  const founder = getUserById(req.user.sub);
  const result = await testMailboxAsset(business, {
    recipient: body.recipient || founder?.email || '',
    requesterName: founder?.name || ''
  });

  await logActivity(req.params.id, {
    type: 'email_sent',
    department: 'operations',
    title: result.preview ? 'Mailbox test ran in preview mode' : 'Mailbox test email sent',
    detail: {
      target: result.target,
      preview: result.preview,
      message_id: result.messageId
    }
  });

  res.json({
    ...result,
    infrastructure: getInfrastructureSnapshot(business)
  });
}));

// PATCH /api/businesses/:id/infrastructure/analytics
router.patch('/businesses/:id/infrastructure/analytics', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const schema = z.object({
    provider: z.enum(['internal_metrics', 'plausible', 'posthog', 'ga4']).optional(),
    site: z.string().max(255).optional(),
    dashboardUrl: z.union([z.string().url(), z.literal('')]).optional(),
    measurementId: z.string().max(255).optional(),
    publicKey: z.string().max(255).optional()
  });
  const body = validate(schema, req.body || {});
  const asset = updateAnalyticsAsset(business, body);

  await logActivity(req.params.id, {
    type: 'system',
    department: 'marketing',
    title: `Founder updated analytics destination to ${asset.config.provider}`,
    detail: {
      provider: asset.config.provider,
      site: asset.config.site
    }
  });

  res.json({ asset, infrastructure: getInfrastructureSnapshot(business) });
}));

// POST /api/businesses/:id/infrastructure/analytics/test
router.post('/businesses/:id/infrastructure/analytics/test', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const asset = testAnalyticsAsset(business);

  await logActivity(req.params.id, {
    type: 'system',
    department: 'marketing',
    title: `Analytics test event recorded via ${asset.config.provider}`,
    detail: {
      provider: asset.config.provider,
      site: asset.config.site,
      event: asset.checks.last_event_name
    }
  });

  res.json({ asset, infrastructure: getInfrastructureSnapshot(business) });
}));

// GET /api/portfolio/overview — multi-business operating snapshot for founder
router.get('/portfolio/overview', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(req.user.sub);
  res.json(getPortfolioOverview(db, req.user.sub, user.plan));
}));

// GET /api/businesses/:id/operating-system — department-by-department dashboard data
router.get('/businesses/:id/operating-system', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(req.user.sub);
  res.json(getOperatingSystemSnapshot(db, business, user.plan));
}));

// PATCH /api/businesses/:id/memory — founder edits the agent memory thread
router.patch('/businesses/:id/memory', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const schema = z.object({
    priorities: z.array(z.string().min(1).max(280)).max(12).optional(),
    learnings: z.array(z.string().min(1).max(400)).max(12).optional(),
    competitors: z.array(z.string().min(1).max(400)).max(12).optional(),
    customerInsights: z.array(z.string().min(1).max(400)).max(12).optional(),
    notes: z.array(z.string().min(1).max(400)).max(12).optional()
  });
  const body = validate(schema, req.body || {});
  const memory = normaliseMemory(business.agent_memory, business);

  if (body.priorities) memory.priorities = body.priorities;
  if (body.learnings) memory.learnings = body.learnings;
  if (body.competitors) memory.competitors = body.competitors;
  if (body.customerInsights) memory.customer_insights = body.customerInsights;
  if (body.notes) memory.notes = body.notes;
  memory.last_cycle = {
    ...(memory.last_cycle || {}),
    founder_updated_at: new Date().toISOString()
  };

  db.prepare(`
    UPDATE businesses
    SET agent_memory = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(memory), req.params.id);

  await logActivity(req.params.id, {
    type: 'system',
    department: 'strategy',
    title: 'Founder updated agent memory',
    detail: {
      priorities: memory.priorities.length,
      learnings: memory.learnings.length,
      competitors: memory.competitors.length,
      customer_insights: memory.customer_insights.length
    }
  });

  res.json({ memory });
}));

// GET /api/businesses/:id/stripe/status — retrieve current Connect state
router.get('/businesses/:id/stripe/status', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const currentIntegration = getIntegration(business.id, 'stripe');
  const currentAccountId = currentIntegration?.config?.account_id || business.stripe_account_id || null;
  const snapshot = await getConnectAccountSnapshot(currentAccountId);
  const integration = saveStripeIntegrationState({
    businessId: business.id,
    accountId: snapshot.account_id || currentAccountId,
    snapshot
  });

  res.json({ stripe: integration?.config || snapshot, status: integration?.status || snapshot.status });
}));

// POST /api/businesses/:id/stripe/onboarding — open Connect onboarding
router.post('/businesses/:id/stripe/onboarding', requireAuth, asyncHandler(async (req, res) => {
  if (!STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe Connect is not configured yet.' });
  }

  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  let stripeAccountId = business.stripe_account_id;
  if (!stripeAccountId || isMockStripeAccount(stripeAccountId)) {
    const user = getUserById(req.user.sub);
    const account = await createConnectAccount(business, user);
    stripeAccountId = account?.id || db.prepare('SELECT stripe_account_id FROM businesses WHERE id = ?').get(req.params.id)?.stripe_account_id;
  }

  if (!stripeAccountId) {
    return res.status(400).json({ error: 'Could not create a Stripe account for this business.' });
  }

  const url = await createOnboardingLink(stripeAccountId, business.id);
  const snapshot = await getConnectAccountSnapshot(stripeAccountId);
  const integration = saveStripeIntegrationState({
    businessId: business.id,
    accountId: stripeAccountId,
    snapshot
  });

  await logActivity(req.params.id, {
    type: 'system',
    department: 'finance',
    title: 'Founder opened Stripe Connect onboarding',
    detail: { stripe_account_id: stripeAccountId }
  });

  res.json({ url, stripeAccountId, stripe: integration?.config || snapshot });
}));

// POST /api/businesses/:id/stripe/dashboard — open the Stripe Express dashboard
router.post('/businesses/:id/stripe/dashboard', requireAuth, asyncHandler(async (req, res) => {
  if (!STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe Connect is not configured yet.' });
  }

  const db = getDb();
  const business = getOwnedBusiness(db, req.params.id, req.user.sub);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const currentIntegration = getIntegration(business.id, 'stripe');
  const stripeAccountId = currentIntegration?.config?.account_id || business.stripe_account_id || null;
  if (!stripeAccountId || isMockStripeAccount(stripeAccountId)) {
    return res.status(400).json({ error: 'Complete Stripe onboarding before opening the dashboard.' });
  }

  const url = await createDashboardLoginLink(stripeAccountId);
  res.json({ url, stripeAccountId });
}));

// GET /api/live — public transparency feed
router.get('/live', asyncHandler(async (req, res) => {
  const db = getDb();
  const feed = db.prepare(`
    SELECT a.id, a.type, a.department, a.title, a.created_at,
           b.name AS business_name, b.slug AS business_slug
    FROM activity a
    JOIN businesses b ON b.id = a.business_id
    ORDER BY a.created_at DESC
    LIMIT 40
  `).all();
  const businessRows = db.prepare(`
    SELECT b.id, b.name, b.slug, b.type, b.status, b.day_count, b.web_url,
           b.mrr_cents, b.total_revenue_cents, b.monthly_subscription_cents,
           b.api_budget_cents, b.revenue_share_pct, b.tasks_included_per_month,
           b.infrastructure_included, u.plan AS user_plan,
           (
             SELECT a.title
             FROM activity a
             WHERE a.business_id = b.id
             ORDER BY a.created_at DESC
             LIMIT 1
           ) AS latest_headline,
           (
             SELECT a.created_at
             FROM activity a
             WHERE a.business_id = b.id
             ORDER BY a.created_at DESC
             LIMIT 1
           ) AS latest_activity_at
    FROM businesses b
    LEFT JOIN users u ON u.id = b.user_id
    WHERE b.status IN ('active', 'paused', 'provisioning')
    ORDER BY b.mrr_cents DESC, b.total_revenue_cents DESC, b.created_at DESC
    LIMIT 12
  `).all();
  const summary = db.prepare(`
    SELECT COUNT(*) AS active_businesses,
           COALESCE(SUM(mrr_cents), 0) AS total_mrr_cents,
           COALESCE(SUM(total_revenue_cents), 0) AS total_revenue_cents
    FROM businesses
    WHERE status IN ('active', 'paused', 'provisioning')
  `).get();
  const approvalsPending = db.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'`).get().n;
  const specialistRows = db.prepare(`
    SELECT department,
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed
    FROM tasks
    WHERE datetime(created_at) >= datetime('now', '-7 days')
    GROUP BY department
    ORDER BY total DESC, department ASC
  `).all();

  const businesses = businessRows.map(row => serializePublicBusiness(row, row.user_plan || 'trial'));

  res.json({
    feed,
    businesses,
    specialists: specialistRows,
    summary: {
      ...summary,
      approvals_pending: approvalsPending,
      feed_events: feed.length
    }
  });
}));

// GET /api/live/:slug — public business drilldown
router.get('/live/:slug', asyncHandler(async (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT b.*, u.plan AS user_plan,
           (
             SELECT a.title
             FROM activity a
             WHERE a.business_id = b.id
             ORDER BY a.created_at DESC
             LIMIT 1
           ) AS latest_headline,
           (
             SELECT a.created_at
             FROM activity a
             WHERE a.business_id = b.id
             ORDER BY a.created_at DESC
             LIMIT 1
           ) AS latest_activity_at
    FROM businesses b
    LEFT JOIN users u ON u.id = b.user_id
    WHERE b.slug = ?
      AND b.status IN ('active', 'paused', 'provisioning')
  `).get(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Business not found' });

  res.json(getPublicBusinessDetail(db, row, row.user_plan || 'trial'));
}));

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE WEBHOOK (raw body needed)
// ─────────────────────────────────────────────────────────────────────────────

router.post('/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  asyncHandler(handleStripeWebhook)
);

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    ws: getStats()
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ERROR HANDLER
// ─────────────────────────────────────────────────────────────────────────────

router.use((err, req, res, next) => {
  console.error(`API Error [${req.method} ${req.path}]:`, err.message);

  if (err.message === 'EMAIL_TAKEN') return res.status(409).json({ error: 'Email already registered' });
  if (err.message === 'INVALID_CREDENTIALS') return res.status(401).json({ error: 'Invalid email or password' });
  if (err.message === 'INVALID_REFRESH_TOKEN') return res.status(401).json({ error: 'Invalid or expired refresh token' });
  if (err.message === 'INVALID_RESET_TOKEN') return res.status(400).json({ error: 'This password reset link is invalid or expired' });
  if (err.message === 'INVALID_VERIFICATION_TOKEN') return res.status(400).json({ error: 'This verification link is invalid or expired' });
  if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });

  res.status(500).json({ error: err.message || 'Internal server error' });
});

export default router;
