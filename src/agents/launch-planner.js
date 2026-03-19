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

export function buildRenderableLaunchPlan(business = {}, artifact = null) {
  const context = {
    name: clean(business.name) || 'Ventura business',
    type: clean(business.type) || 'business',
    description: deriveBusinessDescription({
      name: business.name,
      description: business.description,
      targetCustomer: business.target_customer,
      goal90d: business.goal_90d
    }),
    targetCustomer: clean(business.target_customer) || 'ambitious customers',
    goal90d: clean(business.goal_90d) || 'reach the next stage of growth'
  };

  if (artifact?.metadata && typeof artifact.metadata === 'object' && Object.keys(artifact.metadata).length) {
    const normalized = normalizeLaunchPlan(artifact.metadata, context);
    return isWeakPublicLaunchPlan(normalized, context)
      ? buildFallbackLaunchPlan(context)
      : normalized;
  }

  return buildFallbackLaunchPlan(context);
}

export function renderLaunchSite(business, plan) {
  const proof = (plan.proof_points || []).slice(0, 3);
  const sections = (plan.site_sections || []).slice(0, 4);
  const primaryCta = plan.cta || `Talk to ${business.name}`;
  const proofMarkup = proof.map(item => `
    <div class="proof-card">
      <div class="proof-kicker">Why it converts</div>
      <h3>${escapeHtml(item)}</h3>
      <p>${escapeHtml(plan.launch_summary)}</p>
    </div>
  `).join('');
  const sectionMarkup = sections.map((section, index) => `
    <div class="story-card">
      <div class="story-step">0${index + 1}</div>
      <h3>${escapeHtml(section.heading)}</h3>
      <p>${escapeHtml(section.body)}</p>
    </div>
  `).join('');

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
    body {
      margin:0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(255,93,34,0.18), transparent 34%),
        radial-gradient(circle at top right, rgba(40,202,65,0.12), transparent 28%),
        linear-gradient(180deg, #09090b 0%, #111114 46%, #0a0a0c 100%);
      color:#f5f2eb;
      min-height:100vh;
    }
    .shell { max-width:1180px; margin:0 auto; padding:28px 22px 92px; }
    .nav { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:8px 0 28px; }
    .brand { font-size:14px; letter-spacing:.24em; text-transform:uppercase; color:#ff6129; font-weight:700; }
    .nav-note { font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:rgba(245,242,235,.42); }
    .hero {
      display:grid;
      grid-template-columns:minmax(0, 1.15fr) minmax(320px, .85fr);
      gap:26px;
      align-items:stretch;
      padding:30px 0 46px;
    }
    .hero-copy,
    .hero-panel,
    .section-shell,
    .proof-card,
    .story-card,
    .footer-card {
      background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.025));
      border:1px solid rgba(255,255,255,.08);
      box-shadow:0 30px 120px rgba(0,0,0,.32);
      border-radius:26px;
    }
    .hero-copy { padding:28px; position:relative; overflow:hidden; }
    .hero-copy::after {
      content:"";
      position:absolute;
      inset:auto -40px -60px auto;
      width:180px;
      height:180px;
      background:radial-gradient(circle, rgba(255,93,34,.24), transparent 68%);
      pointer-events:none;
    }
    .hero-panel { padding:26px; display:grid; gap:18px; }
    .eyebrow {
      display:inline-flex;
      gap:8px;
      align-items:center;
      padding:8px 12px;
      border:1px solid rgba(255,255,255,.12);
      border-radius:999px;
      font-size:12px;
      letter-spacing:.08em;
      text-transform:uppercase;
      color:#28ca41;
      background:rgba(255,255,255,.03);
      width:max-content;
    }
    h1 {
      margin:18px 0 14px;
      font-size:clamp(48px, 8vw, 92px);
      line-height:.9;
      letter-spacing:-.05em;
      max-width:780px;
    }
    .lede { font-size:20px; line-height:1.7; color:rgba(245,242,235,.78); max-width:720px; }
    .cta-row { display:flex; flex-wrap:wrap; gap:12px; margin-top:28px; }
    .btn {
      display:inline-flex;
      align-items:center;
      justify-content:center;
      padding:15px 20px;
      border-radius:14px;
      text-decoration:none;
      font-weight:700;
      min-width:180px;
    }
    .btn-primary { background:#ff5d22; color:#111; }
    .btn-secondary { border:1px solid rgba(255,255,255,.14); color:#f5f2eb; background:rgba(255,255,255,.02); }
    .hero-meta-label,
    .section-kicker,
    .proof-kicker,
    .story-step {
      font-size:11px;
      letter-spacing:.14em;
      text-transform:uppercase;
      color:rgba(245,242,235,.42);
    }
    .hero-meta-value { font-size:16px; line-height:1.65; color:#f5f2eb; }
    .section-shell { margin-top:22px; padding:24px; }
    .section-shell h2 { margin:0 0 10px; font-size:30px; letter-spacing:-.03em; }
    .section-intro { max-width:760px; color:rgba(245,242,235,.7); line-height:1.7; margin-bottom:18px; }
    .proof-grid,
    .story-grid,
    .signal-grid {
      display:grid;
      grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));
      gap:14px;
    }
    .proof-card,
    .story-card { padding:20px; }
    .proof-card h3,
    .story-card h3 { margin:10px 0 10px; font-size:20px; letter-spacing:-.02em; }
    .proof-card p,
    .story-card p { margin:0; color:rgba(245,242,235,.68); line-height:1.65; }
    .signal-stat { padding:18px; border:1px solid rgba(255,255,255,.08); border-radius:18px; background:rgba(255,255,255,.025); }
    .signal-number { font-size:28px; color:#f5f2eb; margin-top:8px; }
    .signal-copy { margin-top:8px; color:rgba(245,242,235,.6); line-height:1.55; font-size:14px; }
    .footer-card { margin-top:22px; padding:22px; display:flex; justify-content:space-between; gap:18px; align-items:center; flex-wrap:wrap; }
    .footer-card p { margin:0; color:rgba(245,242,235,.64); line-height:1.65; max-width:720px; }
    @media (max-width: 860px) {
      .hero { grid-template-columns:1fr; }
      .shell { padding:24px 18px 60px; }
      .footer-card { flex-direction:column; align-items:flex-start; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="nav">
      <div class="brand">${escapeHtml(business.name)}</div>
      <div class="nav-note">Live launch page</div>
    </div>
    <section class="hero">
      <div class="hero-copy">
        <div class="eyebrow">${escapeHtml(titleCase(business.type || 'business'))} launch</div>
        <h1>${escapeHtml(plan.headline)}</h1>
        <p class="lede">${escapeHtml(plan.subheadline)}</p>
        <div class="cta-row">
          <a class="btn btn-primary" href="mailto:${escapeHtml(business.email_address || '')}?subject=${encodeURIComponent(primaryCta)}">${escapeHtml(primaryCta)}</a>
          <a class="btn btn-secondary" href="#how-it-works">See how it works</a>
        </div>
      </div>
      <aside class="hero-panel">
        <div>
          <div class="hero-meta-label">Positioning</div>
          <div class="hero-meta-value">${escapeHtml(plan.positioning)}</div>
        </div>
        <div>
          <div class="hero-meta-label">Offer</div>
          <div class="hero-meta-value">${escapeHtml(plan.offer)}</div>
        </div>
        <div>
          <div class="hero-meta-label">90-day goal</div>
          <div class="hero-meta-value">${escapeHtml(business.goal_90d || '')}</div>
        </div>
      </aside>
    </section>

    <section class="section-shell">
      <div class="section-kicker">Why founders use it</div>
      <h2>Built to turn fundraising chaos into qualified conversations</h2>
      <p class="section-intro">${escapeHtml(plan.launch_summary)}</p>
      <div class="proof-grid">
        ${proofMarkup}
      </div>
    </section>

    <section class="section-shell">
      <div class="section-kicker">What you get</div>
      <h2>A simpler fundraising workflow for the right stage and sector</h2>
      <div class="signal-grid">
        <div class="signal-stat">
          <div class="hero-meta-label">Target founders</div>
          <div class="signal-number">${escapeHtml(business.target_customer || 'Founders')}</div>
          <div class="signal-copy">Ventura keeps this launch page tightly aligned to the buyer the business is trying to reach first.</div>
        </div>
        <div class="signal-stat">
          <div class="hero-meta-label">Primary outcome</div>
          <div class="signal-number">${escapeHtml(plan.offer)}</div>
          <div class="signal-copy">Clear value proposition, clear CTA, and a page that can actually convert traffic instead of functioning like an internal memo.</div>
        </div>
        <div class="signal-stat">
          <div class="hero-meta-label">Next milestone</div>
          <div class="signal-number">${escapeHtml(business.goal_90d || 'Growth')}</div>
          <div class="signal-copy">Everything on the page is optimized around the next meaningful business milestone Ventura is targeting.</div>
        </div>
      </div>
    </section>

    <section id="how-it-works" class="section-shell">
      <div class="section-kicker">How it works</div>
      <h2>Designed like a real launch site, not a briefing document</h2>
      <p class="section-intro">Ventura uses the stored launch plan to keep a customer-facing homepage live, even while the deeper engineering work continues behind the scenes.</p>
      <div class="story-grid">
        ${sectionMarkup}
      </div>
    </section>

    <section class="footer-card">
      <div>
        <div class="section-kicker">Contact</div>
        <p>Ventura is actively operating ${escapeHtml(business.name)} and publishing the current launch surface from live business artifacts. Reach the team at <a href="mailto:${escapeHtml(business.email_address || '')}">${escapeHtml(business.email_address || '')}</a>.</p>
      </div>
      <a class="btn btn-primary" href="mailto:${escapeHtml(business.email_address || '')}?subject=${encodeURIComponent(primaryCta)}">${escapeHtml(primaryCta)}</a>
    </section>
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
  const inferred = inferLaunchAngles(context);
  return {
    headline: inferred.headline,
    subheadline: inferred.subheadline,
    cta: inferred.cta,
    positioning: inferred.positioning,
    offer: inferred.offer,
    proof_points: inferred.proof_points,
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
  const inferred = inferLaunchAngles(context);
  return [
    {
      heading: 'What founders get',
      body: inferred.offer
    },
    {
      heading: 'Who it is for',
      body: `Designed for ${context.targetCustomer}. ${inferred.positioning}`
    },
    {
      heading: 'Why it is different',
      body: inferred.proof_points[0]
    },
    {
      heading: 'What happens next',
      body: `Ventura is now working toward ${context.goal90d.toLowerCase()} with a launch plan, a customer-facing site, and the first execution queue.`
    }
  ];
}

function deriveBusinessDescription(context) {
  const rawDescription = clean(context.description);
  const rawName = clean(context.name);
  if (rawDescription && rawDescription.toLowerCase() !== rawName.toLowerCase()) return rawDescription;
  const inferred = inferLaunchAngles({
    name: rawName,
    targetCustomer: clean(context.targetCustomer),
    goal90d: clean(context.goal90d),
    type: clean(context.type)
  });
  return inferred.positioning;
}

function inferLaunchAngles(context) {
  const name = clean(context.name);
  const lower = name.toLowerCase();
  const audience = clean(context.targetCustomer) || 'ambitious founders';
  const goal = clean(context.goal90d) || 'reach the next stage of growth';

  if (lower.includes('founder') && lower.includes('investor')) {
    return {
      headline: 'Get matched with the right investors without spamming your network',
      subheadline: `${name} helps ${audience} surface qualified investor matches, tighten their fundraising story, and move from cold outreach to real conversations faster.`,
      cta: 'Apply for a match',
      positioning: `${name} gives founders a faster path to qualified investor introductions, clearer fundraising positioning, and a better first impression before the next raise.`,
      offer: 'Qualified investor matches, clearer fundraising positioning, and a launch workflow built for pre-seed and seed teams.',
      proof_points: [
        'Targeted around stage, sector, and investor-fit instead of generic fundraising lists.',
        'Built to reduce cold outreach overhead and help founders focus on real meetings.',
        `Structured to move founders toward ${goal.toLowerCase()} with a clear launch surface and outreach system.`
      ]
    };
  }

  return {
    headline: `${name} for ${audience}`,
    subheadline: `${name} helps ${audience} move toward ${goal.toLowerCase()} with a clearer offer, sharper positioning, and a cleaner first-touch experience.`,
    cta: `Talk to ${name}`,
    positioning: `${name} helps ${audience} move toward ${goal.toLowerCase()}.`,
    offer: `A focused ${clean(context.type) || 'business'} offer designed for ${audience}.`,
    proof_points: [
      `Built around ${audience}.`,
      `Focused on ${goal.toLowerCase()}.`,
      'Run through Ventura’s live operator loop and launch workflow.'
    ]
  };
}

function isWeakPublicLaunchPlan(plan, context) {
  const name = clean(context.name).toLowerCase();
  const headline = clean(plan?.headline).toLowerCase();
  const subheadline = clean(plan?.subheadline).toLowerCase();
  const positioning = clean(plan?.positioning).toLowerCase();
  const offer = clean(plan?.offer).toLowerCase();
  const sections = Array.isArray(plan?.site_sections) ? plan.site_sections : [];

  const genericHeadline = !headline
    || headline === name
    || headline.includes('a sharper answer for')
    || headline.includes(`${name}:`);

  const genericSubheadline = !subheadline || subheadline === name;
  const genericPositioning = !positioning
    || positioning === name
    || positioning.includes('helps')
      && positioning.includes('move toward');
  const genericOffer = !offer || offer.startsWith('a focused ');
  const genericSections = sections.length > 0
    && sections.every(section => ['why this exists', 'who it is for', 'what happens next', 'why it is different'].includes(clean(section.heading).toLowerCase()));

  return genericHeadline || genericSubheadline || genericPositioning || genericOffer || genericSections;
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
