// src/provisioning/provision.js
// Orchestrates everything needed to launch a new business:
// subdomain assignment, DB namespace, email address, Stripe Connect account,
// initial website scaffold, and first agent seed task.

import { v4 as uuid } from 'uuid';
import { getDb } from '../db/migrate.js';
import { FRONTEND_URL, PLATFORM_DOMAIN, STRIPE_SECRET_KEY } from '../config.js';
import { emitToUser } from '../ws/websocket.js';
import { logActivity } from '../agents/activity.js';
import { queueTask } from '../agents/tasks.js';
import { sendEmail } from '../integrations/email.js';
import { createVercelProject } from '../integrations/deploy.js';
import { saveStripeIntegrationState, seedDefaultIntegrations, upsertIntegration } from '../integrations/registry.js';
import { createConnectAccount, getConnectAccountSnapshot } from '../integrations/stripe.js';
import { getPlanEconomics } from '../billing/plans.js';
import { syncInfrastructureAssets } from '../infrastructure/assets.js';

// ─── Slug generator ───────────────────────────────────────────────────────────

function toSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .slice(0, 40);
}

async function uniqueSlug(name) {
  const db = getDb();
  let base = toSlug(name);
  let slug = base;
  let i = 1;
  while (db.prepare('SELECT id FROM businesses WHERE slug = ?').get(slug)) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

// ─── Main provisioner ─────────────────────────────────────────────────────────

export async function provisionBusiness({ userId, name, type, description, targetCustomer, goal90d, involvement }) {
  const db = getDb();
  const businessId = uuid();
  const slug = await uniqueSlug(name);
  const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(userId);
  const economics = getPlanEconomics(user?.plan || 'trial');

  const webUrl       = `https://${slug}.${PLATFORM_DOMAIN}`;
  const emailAddress = `${slug}@${PLATFORM_DOMAIN}`;
  const dbName       = `biz_${slug.replace(/-/g, '_')}`;

  // ── 1. Create business record ──────────────────────────────────────────────
  db.prepare(`
    INSERT INTO businesses (
      id, user_id, name, slug, type, description,
      target_customer, goal_90d, involvement, status,
      web_url, db_name, email_address,
      monthly_subscription_cents, api_budget_cents, revenue_share_pct,
      tasks_included_per_month, infrastructure_included
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    businessId, userId, name, slug, type, description,
    targetCustomer, goal90d, involvement,
    webUrl, dbName, emailAddress,
    economics.monthly_subscription_cents,
    economics.api_budget_cents,
    economics.revenue_share_pct,
    economics.tasks_included_per_month,
    economics.infrastructure_included ? 1 : 0
  );

  // ── 2. Notify user via websocket ───────────────────────────────────────────
  emitToUser(userId, {
    event: 'provisioning:started',
    businessId,
    steps: ['database', 'email', 'website', 'agent']
  });

  // ── 3. Run provisioning steps in sequence ──────────────────────────────────
  try {
    await stepProvisionDB(businessId, dbName, userId);
    await stepProvisionEmail(businessId, emailAddress, userId);
    await stepScaffoldWebsite(businessId, slug, name, type, description, userId);
    const stripeAccountId = await stepSetupStripe(businessId, userId);
    seedDefaultIntegrations({ businessId, slug, emailAddress, webUrl, stripeAccountId });
    syncInfrastructureAssets({
      id: businessId,
      slug,
      name,
      web_url: webUrl,
      email_address: emailAddress
    });
    await stepActivate(businessId, userId);
    await stepSeedAgentMemory(businessId, { name, type, description, targetCustomer, goal90d, involvement, webUrl, emailAddress });
    await stepQueueInitialTasks(businessId, type);
    await stepSendWelcomeEmail(userId, name, webUrl, emailAddress, slug);

    return { businessId, slug, webUrl, emailAddress };

  } catch (err) {
    db.prepare(`UPDATE businesses SET status='failed' WHERE id=?`).run(businessId);
    emitToUser(userId, { event: 'provisioning:failed', businessId, error: err.message });
    throw err;
  }
}

// ─── Provisioning Steps ───────────────────────────────────────────────────────

async function stepProvisionDB(businessId, dbName, userId) {
  // In production: CREATE DATABASE or schema on your PG instance.
  // In dev (SQLite): business data already namespaced by business_id FK.
  await sleep(300);
  emitToUser(userId, { event: 'provisioning:step', step: 'database', status: 'complete', businessId });
  await logActivity(businessId, {
    type: 'system',
    department: 'engineering',
    title: 'Database provisioned',
    detail: { dbName }
  });
  upsertIntegration({
    businessId,
    kind: 'database',
    provider: 'sqlite',
    status: 'connected',
    config: { namespace: dbName }
  });
}

async function stepProvisionEmail(businessId, emailAddress, userId) {
  // In production: create mailbox via Resend, Postmark, or custom SMTP.
  // Sets up forwarding rules and an "agent sends from this address" credential.
  await sleep(400);
  emitToUser(userId, { event: 'provisioning:step', step: 'email', status: 'complete', businessId });
  await logActivity(businessId, {
    type: 'system',
    department: 'operations',
    title: `Email address provisioned: ${emailAddress}`,
    detail: { emailAddress }
  });
  upsertIntegration({
    businessId,
    kind: 'email',
    provider: 'ventura-mailbox',
    status: 'connected',
    config: { address: emailAddress }
  });
}

async function stepScaffoldWebsite(businessId, slug, name, type, description, userId) {
  await sleep(600);
  const db = getDb();
  const project = await createVercelProject(businessId, slug);
  db.prepare(`UPDATE businesses SET web_url=? WHERE id=?`)
    .run(project.url, businessId);

  emitToUser(userId, { event: 'provisioning:step', step: 'website', status: 'complete', businessId });
  await logActivity(businessId, {
    type: 'deploy',
    department: 'engineering',
    title: `Website scaffolded at ${slug}.${PLATFORM_DOMAIN}`,
    detail: { slug, type, provider: project.projectId }
  });
  upsertIntegration({
    businessId,
    kind: 'website',
    provider: project.projectId.startsWith('local_') ? 'ventura-static' : 'vercel',
    status: 'connected',
    config: { url: project.url, projectId: project.projectId }
  });
}

async function stepSetupStripe(businessId, userId) {
  await sleep(300);
  const db = getDb();
  let stripeAccountId = null;
  let snapshot = null;

  if (STRIPE_SECRET_KEY) {
    try {
      const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
      const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(userId);
      const account = await createConnectAccount(business, user);
      stripeAccountId = account?.id || db.prepare('SELECT stripe_account_id FROM businesses WHERE id = ?').get(businessId)?.stripe_account_id;
      snapshot = await getConnectAccountSnapshot(stripeAccountId);
      await logActivity(businessId, {
        type: 'system',
        department: 'finance',
        title: 'Stripe Connect account created',
        detail: { stripeAccountId, mode: 'live' }
      });
    } catch (error) {
      console.error(`[Stripe] Live Connect provisioning failed for ${businessId}: ${error.message}`);
      await logActivity(businessId, {
        type: 'alert',
        department: 'finance',
        title: 'Stripe Connect fell back to preview mode',
        detail: { error: error.message }
      });
    }
  }

  if (!stripeAccountId) {
    stripeAccountId = `acct_mock_${uuid().slice(0, 16)}`;
    db.prepare(`UPDATE businesses SET stripe_account_id=? WHERE id=?`).run(stripeAccountId, businessId);
    await logActivity(businessId, {
      type: 'system',
      department: 'finance',
      title: 'Stripe Connect provisioned in preview mode',
      detail: { stripeAccountId, mode: 'mocked' }
    });
  }

  emitToUser(userId, { event: 'provisioning:step', step: 'stripe', status: 'complete', businessId });
  saveStripeIntegrationState({ businessId, accountId: stripeAccountId, snapshot });
  return stripeAccountId;
}

async function stepActivate(businessId, userId) {
  const db = getDb();
  db.prepare(`UPDATE businesses SET status='active', day_count=1 WHERE id=?`).run(businessId);
  emitToUser(userId, { event: 'provisioning:complete', businessId });
}

async function stepSeedAgentMemory(businessId, context) {
  const db = getDb();
  const memory = {
    business: context,
    history: [],
    last_cycle: null,
    learnings: [],
    priorities: [],
    leads: [],
  };
  db.prepare(`UPDATE businesses SET agent_memory=? WHERE id=?`)
    .run(JSON.stringify(memory), businessId);
}

async function stepQueueInitialTasks(businessId, type) {
  // Queue a set of bootstrapping tasks based on business type
  const db = getDb();
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  const initialTasks = getBootstrapTasks(type);
  for (const task of initialTasks) {
    await queueTask({
      businessId,
      business,
      ...task,
      triggeredBy: 'system',
      priority: 1
    });
  }
}

async function stepSendWelcomeEmail(userId, businessName, webUrl, emailAddress, slug) {
  const db = getDb();
  const user = db.prepare('SELECT email, name FROM users WHERE id = ?').get(userId);
  if (!user) return;

  await sendEmail({
    to: user.email,
    subject: `🚀 ${businessName} is live — your agent starts tonight`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;color:#0a0a0a">
        <h1 style="font-size:28px;margin-bottom:8px">Welcome to Ventura, ${user.name}.</h1>
        <p style="color:#6b6459;font-size:16px;line-height:1.6;margin-bottom:24px">
          <strong>${businessName}</strong> is now live and your AI agent is ready to start working.
          The first autonomous cycle runs tonight at 2am.
        </p>
        <div style="background:#f5f2eb;border-radius:4px;padding:24px;margin-bottom:24px">
          <div style="margin-bottom:12px"><strong>Your website:</strong> <a href="${webUrl}">${webUrl}</a></div>
          <div style="margin-bottom:12px"><strong>Your email:</strong> ${emailAddress}</div>
          <div><strong>Dashboard:</strong> <a href="${FRONTEND_URL}">${FRONTEND_URL}</a></div>
        </div>
        <a href="${FRONTEND_URL}" style="background:#e8440a;color:white;padding:14px 28px;text-decoration:none;border-radius:2px;font-weight:500;display:inline-block">
          Open Dashboard →
        </a>
        <p style="margin-top:32px;font-size:13px;color:#aaa">
          Questions? Reply to this email or chat with your agent directly in the dashboard.
        </p>
      </div>
    `
  });
}

// ─── Bootstrap task library ───────────────────────────────────────────────────

function getBootstrapTasks(type) {
  const common = [
    {
      title: 'Write full business plan and 90-day roadmap',
      department: 'strategy',
      description: 'Analyse the business description and goals, produce a detailed action plan for the first 90 days including weekly milestones, key metrics to track, and prioritised initiatives.'
    },
    {
      title: 'Build and deploy complete landing page',
      department: 'engineering',
      description: 'Design and code a high-converting landing page with hero, features/benefits, social proof section, pricing, and CTA. Deploy to the business subdomain.'
    },
    {
      title: 'Set up email outreach: identify 50 target prospects',
      department: 'marketing',
      description: 'Research and compile a list of 50 ideal first customers based on the target customer profile. Prepare personalised cold email sequence (3 emails: intro, follow-up, breakup).'
    },
    {
      title: 'Configure business email and inbox management rules',
      department: 'operations',
      description: 'Set up the business email address, configure auto-responder for enquiries, and establish triage rules for the agent to handle incoming messages.'
    },
  ];

  const typeSpecific = {
    saas: [
      { title: 'Define MVP feature set and technical architecture', department: 'engineering', description: 'Based on the business description and target customer, define the minimum viable product feature set. Design the technical architecture and create a development roadmap.' },
      { title: 'Build core MVP — authentication and main feature', department: 'engineering', description: 'Implement user authentication (signup/login) and the primary value-delivering feature of the SaaS product. Deploy to the business subdomain.' },
    ],
    agency: [
      { title: 'Create service packages and proposal template', department: 'sales', description: 'Define 3 service tiers with clear deliverables, timelines, and pricing. Build a professional proposal template in HTML.' },
      { title: 'Build portfolio/case study page', department: 'engineering', description: 'Add a portfolio section to the website showcasing the agency\'s approach, methodology, and example work.' },
    ],
    ecommerce: [
      { title: 'Set up product catalogue and checkout flow', department: 'engineering', description: 'Build the product listing pages, individual product pages, cart, and Stripe checkout integration.' },
      { title: 'Write product descriptions and SEO metadata', department: 'marketing', description: 'Write compelling, SEO-optimised product descriptions, titles, and meta tags for all products.' },
    ],
    content: [
      { title: 'Launch newsletter and set up subscription flow', department: 'engineering', description: 'Build the subscription landing page, integrate email list management, and set up the welcome sequence.' },
      { title: 'Write and publish first 3 cornerstone content pieces', department: 'marketing', description: 'Research, write, and publish the first 3 high-quality content pieces targeting the defined audience.' },
    ],
  };

  return [...common, ...(typeSpecific[type] || [])];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  const duration = process.env.NODE_ENV === 'test' ? Math.min(ms, 10) : ms;
  return new Promise(r => setTimeout(r, duration));
}
