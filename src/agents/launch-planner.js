import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, AGENT_MODEL } from '../config.js';

export async function generateLaunchPlan({
  name,
  type,
  description,
  targetCustomer,
  goal90d,
  involvement,
  webUrl,
  emailAddress
}) {
  if (ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
      const response = await client.messages.create({
        model: AGENT_MODEL,
        max_tokens: 1800,
        messages: [{
          role: 'user',
          content: `You are Ventura's launch planner. Create a founder-ready launch plan for this business.

Business name: ${name}
Type: ${type}
Description: ${description}
Target customer: ${targetCustomer}
Goal in 90 days: ${goal90d}
Founder involvement mode: ${involvement}
Launch URL: ${webUrl}
Business email: ${emailAddress}

Return ONLY valid JSON with this shape:
{
  "headline": "string",
  "subheadline": "string",
  "cta": "string",
  "positioning": "string",
  "offer": "string",
  "proof_points": ["string", "string", "string"],
  "launch_summary": "string",
  "site_sections": [
    {"heading":"string","body":"string"}
  ],
  "tasks": [
    {"title":"string","department":"engineering|marketing|operations|strategy|sales|finance","description":"string","priority":1-10}
  ]
}

Rules:
- Make the plan specific to this business idea.
- Do not say the founder should hire a developer or use a no-code builder.
- The first tasks must be executable by Ventura using its existing tools, integrations, and artifact system.
- Include 5 to 7 tasks.
- Site copy should feel launch-ready, not generic.
- Avoid placeholder/meta tasks like "write a full business plan", "define the MVP", or "build the complete app".
- Prefer Ventura-native outputs like positioning briefs, live homepage copy, FAQ/proof assets, prospect lists, outreach sequences, inbox rules, deploys, and research reports.
- Every task description must name the concrete deliverable that will exist when the task is done.`
        }]
      });

      const text = response.content?.[0]?.text?.trim() || '';
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed.tasks) && parsed.tasks.length) {
        return normalizeLaunchPlan(parsed, {
          name,
          type,
          description,
          targetCustomer,
          goal90d
        });
      }
    } catch (error) {
      console.error(`[LaunchPlanner] Falling back to deterministic plan: ${error.message}`);
    }
  }

  return buildFallbackLaunchPlan({ name, type, description, targetCustomer, goal90d });
}

export function renderLaunchSite(business, plan) {
  const proof = (plan.proof_points || []).slice(0, 3);
  const sections = (plan.site_sections || []).slice(0, 4);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(business.name)}</title>
  <meta name="description" content="${escapeHtml(plan.positioning || business.description)}">
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0d0d0e; color:#f5f2eb; }
    .shell { max-width:1120px; margin:0 auto; padding:32px 22px 80px; }
    .nav { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:8px 0 26px; }
    .brand { font-size:14px; letter-spacing:.2em; text-transform:uppercase; color:#ff6129; }
    .hero { display:grid; grid-template-columns:1.2fr .8fr; gap:28px; align-items:start; padding:34px 0 40px; }
    .eyebrow { display:inline-flex; gap:8px; align-items:center; padding:8px 12px; border:1px solid rgba(255,255,255,.12); border-radius:999px; font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:#28ca41; }
    h1 { margin:18px 0 16px; font-size:clamp(42px,8vw,84px); line-height:.92; letter-spacing:-.04em; }
    .lede { font-size:20px; line-height:1.65; color:rgba(245,242,235,.78); max-width:700px; }
    .cta-row { display:flex; flex-wrap:wrap; gap:12px; margin-top:28px; }
    .btn { display:inline-flex; align-items:center; justify-content:center; padding:14px 18px; border-radius:10px; text-decoration:none; font-weight:600; }
    .btn-primary { background:#ff5d22; color:#111; }
    .btn-secondary { border:1px solid rgba(255,255,255,.14); color:#f5f2eb; }
    .panel { background:linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.02)); border:1px solid rgba(255,255,255,.08); border-radius:18px; padding:22px; }
    .meta { display:grid; gap:14px; }
    .meta-label { font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:rgba(245,242,235,.42); margin-bottom:8px; }
    .meta-copy { font-size:15px; line-height:1.6; color:rgba(245,242,235,.76); }
    .proof, .sections { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:14px; margin-top:26px; }
    .section-card { padding:18px; border:1px solid rgba(255,255,255,.07); border-radius:16px; background:rgba(255,255,255,.025); }
    .section-card h3 { margin:0 0 10px; font-size:18px; }
    .section-card p { margin:0; color:rgba(245,242,235,.68); line-height:1.6; }
    footer { margin-top:40px; color:rgba(245,242,235,.45); font-size:13px; }
    @media (max-width: 860px) {
      .hero { grid-template-columns:1fr; }
      .shell { padding:24px 18px 60px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="nav">
      <div class="brand">${escapeHtml(business.name)}</div>
      <div class="eyebrow">Ventura launched</div>
    </div>
    <section class="hero">
      <div>
        <div class="eyebrow">${escapeHtml(titleCase(business.type || 'business'))} launch</div>
        <h1>${escapeHtml(plan.headline)}</h1>
        <p class="lede">${escapeHtml(plan.subheadline)}</p>
        <div class="cta-row">
          <a class="btn btn-primary" href="mailto:${escapeHtml(business.email_address || '')}?subject=${encodeURIComponent(plan.cta || `Interested in ${business.name}`)}">${escapeHtml(plan.cta || 'Get in touch')}</a>
          <a class="btn btn-secondary" href="#plan">See how it works</a>
        </div>
      </div>
      <aside class="panel meta">
        <div>
          <div class="meta-label">Positioning</div>
          <div class="meta-copy">${escapeHtml(plan.positioning)}</div>
        </div>
        <div>
          <div class="meta-label">Offer</div>
          <div class="meta-copy">${escapeHtml(plan.offer)}</div>
        </div>
        <div>
          <div class="meta-label">90-day goal</div>
          <div class="meta-copy">${escapeHtml(business.goal_90d || '')}</div>
        </div>
      </aside>
    </section>
    <section class="proof">
      ${proof.map(item => `<div class="section-card"><h3>${escapeHtml(item)}</h3><p>${escapeHtml(plan.launch_summary)}</p></div>`).join('')}
    </section>
    <section id="plan" class="sections">
      ${sections.map(section => `<div class="section-card"><h3>${escapeHtml(section.heading)}</h3><p>${escapeHtml(section.body)}</p></div>`).join('')}
    </section>
    <footer>
      Ventura is actively operating ${escapeHtml(business.name)} from this live site. Contact <a href="mailto:${escapeHtml(business.email_address || '')}">${escapeHtml(business.email_address || '')}</a>.
    </footer>
  </main>
</body>
</html>`;
}

function normalizeLaunchPlan(plan, context) {
  const fallbackPlan = buildFallbackLaunchPlan(context);
  const candidateTasks = Array.isArray(plan.tasks) && plan.tasks.length
    ? plan.tasks.map(task => ({
        title: clean(task.title),
        department: normalizeDepartment(task.department),
        description: clean(task.description),
        priority: clampPriority(task.priority)
      })).filter(task => task.title && task.description && !isWeakLaunchTask(task))
    : [];

  return {
    headline: clean(plan.headline) || `${context.name} for ${context.targetCustomer}`,
    subheadline: clean(plan.subheadline) || context.description,
    cta: clean(plan.cta) || 'Request a launch walkthrough',
    positioning: clean(plan.positioning) || context.description,
    offer: clean(plan.offer) || `A focused ${context.type} offer for ${context.targetCustomer}`,
    proof_points: Array.isArray(plan.proof_points) && plan.proof_points.length
      ? plan.proof_points.map(clean).filter(Boolean).slice(0, 3)
      : [`Built for ${context.targetCustomer}`, `Focused on ${context.goal90d}`, 'Ventura-owned execution loop'],
    launch_summary: clean(plan.launch_summary) || `Ventura launched ${context.name} with a focused positioning and a concrete first execution plan.`,
    site_sections: Array.isArray(plan.site_sections) && plan.site_sections.length
      ? plan.site_sections.map(item => ({ heading: clean(item.heading), body: clean(item.body) })).filter(item => item.heading && item.body).slice(0, 4)
      : fallbackSections(context),
    tasks: candidateTasks.length ? candidateTasks : fallbackPlan.tasks
  };
}

function buildFallbackLaunchPlan(context) {
  const audience = context.targetCustomer;
  return {
    headline: `${context.name}: a sharper answer for ${audience}`,
    subheadline: context.description,
    cta: `Talk to ${context.name}`,
    positioning: `${context.name} helps ${audience} move toward ${context.goal90d.toLowerCase()}.`,
    offer: `A focused ${context.type} offer designed for ${audience}.`,
    proof_points: [
      `Built around ${audience}`,
      `Optimized for ${context.goal90d}`,
      'Run through Ventura’s daily operator loop'
    ],
    launch_summary: `Ventura created a launch foundation for ${context.name} with positioning, a live landing page, and the first execution queue.`,
    site_sections: fallbackSections(context),
    tasks: [
      {
        title: `Sharpen ${context.name} positioning for ${audience}`,
        department: 'strategy',
        description: `Create a founder-ready positioning brief with the offer, pricing angle, objections, and a 30-day operating focus for ${audience}.`,
        priority: 1
      },
      {
        title: `Publish a conversion-focused homepage for ${context.name}`,
        department: 'engineering',
        description: `Ship updated homepage copy and structure for ${audience}, then deploy the live site with a clear CTA and proof section.`,
        priority: 1
      },
      {
        title: `Research the first 20 likely buyers for ${context.name}`,
        department: 'marketing',
        description: `Produce a prospect list with names, companies, hooks, and channel notes Ventura can use for first outreach toward ${context.goal90d}.`,
        priority: 2
      },
      {
        title: `Draft the first outbound sequence for ${context.name}`,
        department: 'marketing',
        description: `Write the first outbound email or message sequence, including CTA, follow-up angle, and objection handling for ${audience}.`,
        priority: 2
      },
      {
        title: `Set inbox and response rules for ${context.name}`,
        department: 'operations',
        description: `Create inbox triage rules, response templates, and operating notes so Ventura can handle inbound interest cleanly.`,
        priority: 3
      },
      {
        title: `Create proof assets and FAQ copy for ${context.name}`,
        department: 'strategy',
        description: `Produce proof points, trust-building FAQ copy, and customer-facing answers Ventura can reuse across the site and outbound motion.`,
        priority: 3
      }
    ]
  };
}

function fallbackSections(context) {
  return [
    {
      heading: 'Why this exists',
      body: context.description
    },
    {
      heading: 'Who it is for',
      body: `Designed for ${context.targetCustomer}.`
    },
    {
      heading: 'What happens next',
      body: `Ventura is now working toward ${context.goal90d.toLowerCase()} with a launch plan, live site, and execution queue.`
    }
  ];
}

function clean(value) {
  return String(value || '').trim();
}

function isWeakLaunchTask(task) {
  const title = clean(task?.title).toLowerCase();
  if (!title) return true;
  return [
    'write full business plan',
    '90-day roadmap',
    'define mvp feature set',
    'build core mvp',
    'build and deploy complete landing page',
    'technical architecture',
    'cornerstone content pieces'
  ].some(fragment => title.includes(fragment));
}

function normalizeDepartment(value) {
  const normalized = clean(value).toLowerCase();
  return ['engineering', 'marketing', 'operations', 'strategy', 'sales', 'finance'].includes(normalized)
    ? normalized
    : 'strategy';
}

function clampPriority(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(10, Math.round(n)));
}

function titleCase(value) {
  return clean(value).replace(/\b\w/g, ch => ch.toUpperCase());
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
