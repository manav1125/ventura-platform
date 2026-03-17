// src/db/seed.js
// Seeds the database with a demo user and business for development/testing
// Run: node src/db/seed.js

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { runMigrations, getDb } from './migrate.js';
import { seedDefaultIntegrations } from '../integrations/registry.js';

async function seed() {
  console.log('🌱 Seeding database...\n');
  runMigrations();
  const db = getDb();

  // ── Demo user ──────────────────────────────────────────────────────────────
  const userId = uuid();
  const passwordHash = await bcrypt.hash('password123', 10);

  db.prepare(`
    INSERT OR IGNORE INTO users (id, email, name, password_hash, plan)
    VALUES (?, 'demo@ventura.ai', 'Demo Founder', ?, 'builder')
  `).run(userId, passwordHash);

  const user = db.prepare("SELECT * FROM users WHERE email='demo@ventura.ai'").get();
  console.log(`✅ User: ${user.email} / password123`);

  // ── Demo business ──────────────────────────────────────────────────────────
  const bizId = uuid();
  const agentMemory = JSON.stringify({
    business: {
      name: 'Nova Analytics',
      type: 'saas',
      description: 'A lightweight analytics dashboard for indie hackers and solo founders who want Mixpanel-level insights without the Mixpanel price tag.',
      targetCustomer: 'Indie hackers and bootstrapped SaaS founders',
      goal90d: 'Reach $5k MRR within 90 days',
      involvement: 'autopilot'
    },
    priorities: ['Get first 10 paying customers', 'Improve landing page conversion', 'Build email list to 500'],
    learnings: [
      'HN audience responds well to "simple pricing" messaging',
      'Founders care about setup time — mention "5 minute setup" prominently',
      'Competitor Plausible charges $9/mo — we should be $7/mo to undercut'
    ],
    competitors: [
      { name: 'Plausible', pricing: '$9/mo', weakness: 'No user-level tracking' },
      { name: 'Fathom', pricing: '$14/mo', weakness: 'No custom events' },
      { name: 'Umami', pricing: 'Free self-hosted', weakness: 'Requires tech setup' }
    ],
    customer_insights: [
      'Pain point: Google Analytics 4 is too complex for solo founders',
      'They want: simple install, one-page dashboard, no cookie banners needed'
    ],
    last_cycle: null
  });

  db.prepare(`
    INSERT OR IGNORE INTO businesses (
      id, user_id, name, slug, type, description, target_customer,
      goal_90d, involvement, status, day_count,
      web_url, db_name, email_address, mrr_cents, total_revenue_cents,
      agent_memory
    ) VALUES (
      ?, ?, 'Nova Analytics', 'nova-analytics', 'saas',
      'A lightweight analytics dashboard for indie hackers and solo founders.',
      'Indie hackers and bootstrapped SaaS founders',
      'Reach $5k MRR within 90 days', 'autopilot', 'active', 23,
      'https://nova-analytics.ventura.ai', 'biz_nova_analytics',
      'nova-analytics@ventura.ai', 284000, 620000,
      ?
    )
  `).run(bizId, user.id, agentMemory);

  const biz = db.prepare("SELECT * FROM businesses WHERE slug='nova-analytics'").get();
  console.log(`✅ Business: ${biz.name} (${biz.id})`);

  // ── Seed agent cycles ──────────────────────────────────────────────────────
  const cycles = [
    { id: uuid(), status: 'complete', triggered_by: 'cron', tasks_run: 7, summary: 'Deployed new landing page with social proof section, sent 40 cold emails to indie hacker segment (3 replies), fixed mobile checkout bug.', days_ago: 0 },
    { id: uuid(), status: 'complete', triggered_by: 'cron', tasks_run: 6, summary: 'Wrote and published blog post about GA4 alternatives, added 12 new leads from HN thread, updated pricing page.', days_ago: 1 },
    { id: uuid(), status: 'complete', triggered_by: 'cron', tasks_run: 8, summary: 'A/B tested headline copy (variant B winning +22% CTR), sent follow-up sequence to 15 trial users, researched 5 competitors.', days_ago: 2 },
  ];

  for (const c of cycles) {
    const date = new Date(Date.now() - c.days_ago * 86400000).toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO agent_cycles (id, business_id, status, triggered_by, tasks_run, summary, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(c.id, biz.id, c.status, c.triggered_by, c.tasks_run, c.summary, date, date);
  }
  console.log(`✅ ${cycles.length} agent cycles`);

  // ── Seed tasks ─────────────────────────────────────────────────────────────
  const tasks = [
    { title: 'Deploy landing page v4 — new hero + social proof', department: 'engineering', status: 'complete' },
    { title: 'Send cold email batch: 40 indie hackers on HN', department: 'marketing', status: 'complete' },
    { title: 'Fix mobile Safari checkout flow bug', department: 'engineering', status: 'complete' },
    { title: 'Write blog: "Why GA4 is killing small businesses"', department: 'marketing', status: 'complete' },
    { title: 'Reply to 3 investor enquiry emails', department: 'operations', status: 'complete' },
    { title: 'Run SEO audit and fix top issues', department: 'marketing', status: 'running' },
    { title: 'Write follow-up email sequence (3 emails)', department: 'marketing', status: 'queued' },
    { title: 'Build CSV export feature', department: 'engineering', status: 'queued' },
    { title: 'Research and add 20 new prospects to pipeline', department: 'sales', status: 'queued' },
  ];

  for (const t of tasks) {
    const date = new Date(Date.now() - Math.random() * 3 * 86400000).toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO tasks (id, business_id, title, department, status, triggered_by, created_at)
      VALUES (?, ?, ?, ?, ?, 'agent', ?)
    `).run(uuid(), biz.id, t.title, t.department, t.status, date);
  }
  console.log(`✅ ${tasks.length} tasks`);

  // ── Seed activity feed ─────────────────────────────────────────────────────
  const activities = [
    { type: 'deploy', department: 'engineering', title: 'Deployed v0.9.4: mobile nav, pricing page, hero redesign', hours_ago: 2 },
    { type: 'email_sent', department: 'marketing', title: 'Cold email batch — 40 sent to SaaS founders segment', hours_ago: 4 },
    { type: 'lead', department: 'sales', title: 'New lead: sarah@acmecorp.com (cold_email)', hours_ago: 5 },
    { type: 'content', department: 'marketing', title: 'Blog post: "Why GA4 is overkill for small teams"', hours_ago: 28 },
    { type: 'code', department: 'engineering', title: 'Fixed: Safari checkout crash on iOS 17', hours_ago: 30 },
    { type: 'alert', department: null, title: '⚑ Review: VC term sheet from Horizon Ventures', hours_ago: 35 },
    { type: 'email_sent', department: 'operations', title: 'Replied to 2 investor enquiries', hours_ago: 36 },
    { type: 'lead', department: 'sales', title: 'New lead: mike@devtools.io (organic)', hours_ago: 48 },
    { type: 'deploy', department: 'engineering', title: 'Deployed v0.9.3: annual pricing toggle, new onboarding flow', hours_ago: 52 },
    { type: 'content', department: 'marketing', title: 'Twitter thread: "Lessons from 23 days of AI-run SaaS"', hours_ago: 54 },
    { type: 'research', department: 'strategy', title: 'Competitor research: Plausible, Fathom, Umami', hours_ago: 55 },
    { type: 'metrics', department: 'finance', title: 'MRR updated: $2,840/mo (+$340 this week)', hours_ago: 56 },
  ];

  for (const a of activities) {
    const date = new Date(Date.now() - a.hours_ago * 3600000).toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO activity (id, business_id, type, department, title, detail, created_at)
      VALUES (?, ?, ?, ?, ?, '{}', ?)
    `).run(uuid(), biz.id, a.type, a.department||null, a.title, date);
  }
  console.log(`✅ ${activities.length} activity items`);

  const deployments = [
    { version: 'v0.9.4', description: 'mobile nav, pricing page, hero redesign', files_changed: 3, hours_ago: 2 },
    { version: 'v0.9.3', description: 'annual pricing toggle, new onboarding flow', files_changed: 5, hours_ago: 52 },
  ];

  for (const d of deployments) {
    const date = new Date(Date.now() - d.hours_ago * 3600000).toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO deployments (id, business_id, version, description, files_changed, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'live', ?)
    `).run(uuid(), biz.id, d.version, d.description, d.files_changed, date);
  }
  console.log(`✅ ${deployments.length} deployment records`);

  // ── Seed metrics (30 days of daily data) ──────────────────────────────────
  for (let i = 29; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
    const progress = (29 - i) / 29;
    const mrr = Math.floor(800 + progress * 2040);
    const users = Math.floor(40 + progress * 144);
    db.prepare(`
      INSERT OR IGNORE INTO metrics (id, business_id, date, mrr_cents, active_users, new_users, tasks_done, leads, emails_sent, deployments, revenue_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuid(), biz.id, date,
      mrr * 100, users,
      Math.floor(Math.random() * 8),
      Math.floor(3 + Math.random() * 8),
      Math.floor(Math.random() * 5),
      Math.floor(Math.random() * 30),
      Math.floor(Math.random() * 2),
      Math.floor(Math.random() * 20000)
    );
  }
  console.log('✅ 30 days of metrics');

  // ── Seed leads ─────────────────────────────────────────────────────────────
  const leads = [
    { name: 'Sarah Chen', email: 'sarah@acmecorp.com', company: 'Acme Corp', status: 'replied', source: 'cold_email' },
    { name: 'Mike Peters', email: 'mike@devtools.io', company: 'DevTools.io', status: 'qualified', source: 'organic' },
    { name: 'Lisa Wang', email: 'lisa@startupco.com', company: 'StartupCo', status: 'contacted', source: 'cold_email' },
    { name: 'Tom Bradley', email: 'tom@saasfounder.com', company: null, status: 'new', source: 'social' },
    { name: 'Anna Kim', email: 'anna@growthco.io', company: 'GrowthCo', status: 'new', source: 'referral' },
  ];

  for (const l of leads) {
    db.prepare(`
      INSERT OR IGNORE INTO leads (id, business_id, name, email, company, status, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuid(), biz.id, l.name, l.email, l.company||null, l.status, l.source);
  }
  console.log(`✅ ${leads.length} leads`);

  // ── Seed chat messages ─────────────────────────────────────────────────────
  const messages = [
    { role: 'assistant', content: 'Hey! I\'m your Ventura agent for Nova Analytics. I\'ve been running your business for 23 days. Today I deployed the new landing page, sent 40 cold emails (3 replies so far), and I\'m currently mid-way through an SEO audit.\n\nCurrent MRR is $2,840 — up $340 this week. What would you like to focus on next?' },
    { role: 'user', content: 'How are the cold emails performing? Any good leads?' },
    { role: 'assistant', content: 'The cold email campaign is performing well — 7.5% reply rate on the latest batch (3/40), which is above the 5-6% industry average for cold SaaS outreach.\n\nBest lead so far is Sarah Chen at Acme Corp — she asked about bulk pricing for her 8-person team. I\'ve flagged her for a follow-up call. I\'d recommend you reply personally to that one.\n\nI\'m also tracking 5 qualified leads in total. Want me to draft a follow-up sequence for the non-responders?' },
  ];

  for (const m of messages) {
    db.prepare('INSERT OR IGNORE INTO messages (id, business_id, role, content) VALUES (?, ?, ?, ?)').run(uuid(), biz.id, m.role, m.content);
  }
  console.log('✅ Chat messages');

  seedDefaultIntegrations({
    businessId: biz.id,
    slug: biz.slug,
    emailAddress: biz.email_address,
    webUrl: biz.web_url,
    stripeAccountId: biz.stripe_account_id
  });
  console.log('✅ Integration registry');

  console.log(`\n🎉 Seed complete!\n`);
  console.log(`   Login: demo@ventura.ai / password123`);
  console.log(`   Business: Nova Analytics (${biz.id})\n`);
}

seed().then(() => process.exit(0)).catch(err => { console.error('Seed failed:', err); process.exit(1); });
