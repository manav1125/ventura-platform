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
  "hero_badge": "string",
  "headline": "string",
  "subheadline": "string",
  "cta": "string",
  "cta_microcopy": "string",
  "positioning": "string",
  "offer": "string",
  "proof_points": ["string", "string", "string"],
  "social_proof_items": ["string", "string", "string"],
  "launch_summary": "string",
  "narrative_sections": [
    {"kicker":"string","title":"string","body":"string"}
  ],
  "faq": [
    {"question":"string","answer":"string"}
  ],
  "testimonial": {
    "quote": "string",
    "name": "string",
    "role": "string"
  },
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
- Site copy should feel like a modern customer-facing SaaS landing page, not an internal plan.
- Create a sharp narrative around the biggest customer pain point.
- Use a single primary CTA and supporting microcopy that reduces hesitation.
- Weave in specific, credible social proof or trust cues throughout the page.
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
  const narrativeSections = (plan.narrative_sections || []).slice(0, 3);
  const faqItems = (plan.faq || []).slice(0, 3);
  const socialProofItems = (plan.social_proof_items || []).slice(0, 5);
  const primaryCta = plan.cta || `Talk to ${business.name}`;
  const ctaMicrocopy = plan.cta_microcopy || 'Clear next step. No heavy setup. Fast path to the first conversation.';
  const heroBadge = plan.hero_badge || `${titleCase(business.type || 'business')} launch`;
  const testimonial = plan.testimonial || {};
  const proofMarkup = proof.map(item => `
    <div class="proof-card">
      <h3>${escapeHtml(item)}</h3>
      <p>${escapeHtml(plan.launch_summary)}</p>
    </div>
  `).join('');
  const sectionMarkup = narrativeSections.map((section, index) => `
    <div class="story-card">
      ${section.kicker ? `<div class="story-kicker">${escapeHtml(section.kicker)}</div>` : ''}
      <h3>${escapeHtml(section.title)}</h3>
      <p>${escapeHtml(section.body)}</p>
    </div>
  `).join('');
  const socialProofMarkup = socialProofItems.map(item => `<span class="proof-chip">${escapeHtml(item)}</span>`).join('');
  const faqMarkup = faqItems.map(item => `
    <div class="faq-item">
      <h3>${escapeHtml(item.question)}</h3>
      <p>${escapeHtml(item.answer)}</p>
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
    .section-kicker,
    .story-kicker {
      font-size:11px;
      letter-spacing:.14em;
      text-transform:uppercase;
      color:rgba(245,242,235,.42);
    }
    .hero-panel-title { font-size:28px; line-height:1.1; letter-spacing:-.03em; }
    .hero-panel-copy { font-size:15px; line-height:1.7; color:rgba(245,242,235,.74); }
    .proof-chip-row { display:flex; flex-wrap:wrap; gap:10px; margin-top:18px; }
    .proof-chip {
      display:inline-flex;
      padding:10px 14px;
      border-radius:999px;
      border:1px solid rgba(255,255,255,.08);
      background:rgba(255,255,255,.03);
      font-size:12px;
      color:#f5f2eb;
    }
    .microcopy { margin-top:12px; font-size:13px; color:rgba(245,242,235,.52); line-height:1.6; }
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
    .testimonial-card {
      padding:26px;
      border-radius:24px;
      border:1px solid rgba(255,255,255,.08);
      background:linear-gradient(180deg, rgba(255,93,34,.12), rgba(255,255,255,.03));
      margin-top:22px;
    }
    .testimonial-quote {
      font-size:28px;
      line-height:1.35;
      letter-spacing:-.03em;
      max-width:880px;
    }
    .testimonial-meta { margin-top:14px; color:rgba(245,242,235,.6); font-size:14px; }
    .faq-grid {
      display:grid;
      grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));
      gap:14px;
      margin-top:18px;
    }
    .faq-item {
      padding:18px;
      border:1px solid rgba(255,255,255,.08);
      border-radius:18px;
      background:rgba(255,255,255,.025);
    }
    .faq-item h3 {
      margin:0 0 10px;
      font-size:18px;
      letter-spacing:-.02em;
    }
    .faq-item p {
      margin:0;
      color:rgba(245,242,235,.66);
      line-height:1.65;
    }
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
        <div class="eyebrow">${escapeHtml(heroBadge)}</div>
        <h1>${escapeHtml(plan.headline)}</h1>
        <p class="lede">${escapeHtml(plan.subheadline)}</p>
        <div class="cta-row">
          <a class="btn btn-primary" href="mailto:${escapeHtml(business.email_address || '')}?subject=${encodeURIComponent(primaryCta)}">${escapeHtml(primaryCta)}</a>
          <a class="btn btn-secondary" href="#story">How it works</a>
        </div>
        <div class="microcopy">${escapeHtml(ctaMicrocopy)}</div>
        ${socialProofItems.length ? `<div class="proof-chip-row">${socialProofMarkup}</div>` : ''}
      </div>
      <aside class="hero-panel">
        <div>
          <div class="hero-panel-title">${escapeHtml(plan.offer)}</div>
          <div class="hero-panel-copy">${escapeHtml(plan.positioning)}</div>
        </div>
        <div>
          <div class="proof-chip-row">
            ${proof.slice(0, 3).map(item => `<span class="proof-chip">${escapeHtml(item)}</span>`).join('')}
          </div>
        </div>
      </aside>
    </section>

    <section class="section-shell">
      <div class="section-kicker">Why it lands</div>
      <h2>Built to turn fundraising chaos into qualified conversations</h2>
      <p class="section-intro">${escapeHtml(plan.launch_summary)}</p>
      <div class="proof-grid">
        ${proofMarkup}
      </div>
    </section>

    <section class="section-shell">
      <div class="section-kicker">Why it matters</div>
      <h2>A sharper path from scattered outreach to the right investor conversations</h2>
      <div class="signal-grid">
        <div class="signal-stat">
          <div class="section-kicker">For</div>
          <div class="signal-number">${escapeHtml(business.target_customer || 'Founders')}</div>
          <div class="signal-copy">Ventura keeps this launch page tightly aligned to the buyer the business is trying to reach first.</div>
        </div>
        <div class="signal-stat">
          <div class="section-kicker">Outcome</div>
          <div class="signal-number">${escapeHtml(plan.offer)}</div>
          <div class="signal-copy">Clear value proposition, clear CTA, and a page that can actually convert traffic instead of functioning like an internal memo.</div>
        </div>
        <div class="signal-stat">
          <div class="section-kicker">Goal</div>
          <div class="signal-number">${escapeHtml(business.goal_90d || 'Growth')}</div>
          <div class="signal-copy">Everything on the page is optimized around the next meaningful business milestone Ventura is targeting.</div>
        </div>
      </div>
    </section>

    <section id="story" class="section-shell">
      <div class="section-kicker">Story</div>
      <h2>Designed to read like a compelling launch page, not a planning doc</h2>
      <p class="section-intro">Ventura uses the launch narrative, proof, and objections to keep the public site persuasive while the deeper execution engine keeps shipping behind the scenes.</p>
      <div class="story-grid">
        ${sectionMarkup}
      </div>
    </section>

    ${testimonial.quote ? `
      <section class="testimonial-card">
        <div class="section-kicker">Founder voice</div>
        <div class="testimonial-quote">“${escapeHtml(testimonial.quote)}”</div>
        <div class="testimonial-meta">${escapeHtml(testimonial.name || 'Founder')} · ${escapeHtml(testimonial.role || business.target_customer || 'Customer')}</div>
      </section>
    ` : ''}

    ${faqItems.length ? `
      <section class="section-shell">
        <div class="section-kicker">Questions</div>
        <h2>The final objections handled before the click</h2>
        <div class="faq-grid">
          ${faqMarkup}
        </div>
      </section>
    ` : ''}

    <section class="footer-card">
      <div>
        <div class="section-kicker">Ready</div>
        <p>${escapeHtml(plan.subheadline)} Reach the team at <a href="mailto:${escapeHtml(business.email_address || '')}">${escapeHtml(business.email_address || '')}</a>.</p>
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
    hero_badge: clean(plan.hero_badge) || `${titleCase(context.type || 'business')} launch`,
    headline: clean(plan.headline) || `${context.name} for ${context.targetCustomer}`,
    subheadline: clean(plan.subheadline) || context.description,
    cta: clean(plan.cta) || 'Request a launch walkthrough',
    cta_microcopy: clean(plan.cta_microcopy) || 'No credit-card maze, no bloated setup, just a clear next step.',
    positioning: clean(plan.positioning) || context.description,
    offer: clean(plan.offer) || `A focused ${context.type} offer for ${context.targetCustomer}`,
    proof_points: Array.isArray(plan.proof_points) && plan.proof_points.length
      ? plan.proof_points.map(clean).filter(Boolean).slice(0, 3)
      : [`Built for ${context.targetCustomer}`, `Focused on ${context.goal90d}`, 'Ventura-owned execution loop'],
    social_proof_items: Array.isArray(plan.social_proof_items) && plan.social_proof_items.length
      ? plan.social_proof_items.map(clean).filter(Boolean).slice(0, 5)
      : fallbackSocialProof(context),
    launch_summary: clean(plan.launch_summary) || `Ventura launched ${context.name} with a focused positioning and a concrete first execution plan.`,
    narrative_sections: Array.isArray(plan.narrative_sections) && plan.narrative_sections.length
      ? plan.narrative_sections.map(item => ({
          kicker: clean(item.kicker),
          title: clean(item.title),
          body: clean(item.body)
        })).filter(item => item.title && item.body).slice(0, 3)
      : fallbackNarrativeSections(context),
    faq: Array.isArray(plan.faq) && plan.faq.length
      ? plan.faq.map(item => ({
          question: clean(item.question),
          answer: clean(item.answer)
        })).filter(item => item.question && item.answer).slice(0, 3)
      : fallbackFaq(context),
    testimonial: normalizeTestimonial(plan.testimonial, context),
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
    hero_badge: inferred.hero_badge,
    headline: inferred.headline,
    subheadline: inferred.subheadline,
    cta: inferred.cta,
    cta_microcopy: inferred.cta_microcopy,
    positioning: inferred.positioning,
    offer: inferred.offer,
    proof_points: inferred.proof_points,
    social_proof_items: inferred.social_proof_items,
    launch_summary: `Ventura created a launch foundation for ${context.name} with positioning, a live landing page, and the first execution queue.`,
    narrative_sections: fallbackNarrativeSections(context),
    faq: fallbackFaq(context),
    testimonial: fallbackTestimonial(context),
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

function fallbackNarrativeSections(context) {
  const inferred = inferLaunchAngles(context);
  return [
    {
      kicker: 'The problem',
      title: 'Most fundraising starts with noise, not fit',
      body: inferred.positioning
    },
    {
      kicker: 'The shift',
      title: 'A cleaner story and tighter targeting creates better conversations',
      body: inferred.offer
    },
    {
      kicker: 'The result',
      title: `Built to move toward ${clean(context.goal90d || 'real traction').toLowerCase()}`,
      body: `Ventura keeps the page, messaging, and first customer journey aligned around a single high-value next step instead of scattered asks.`
    }
  ];
}

function fallbackFaq(context) {
  const inferred = inferLaunchAngles(context);
  return [
    {
      question: 'Why would a founder trust this over cold outreach?',
      answer: inferred.proof_points[0] || inferred.positioning
    },
    {
      question: 'What happens after the first click?',
      answer: `The CTA routes the visitor into a direct response path so Ventura can continue the conversation toward ${clean(context.goal90d || 'the next milestone').toLowerCase()}.`
    },
    {
      question: 'What makes this feel credible?',
      answer: inferred.proof_points[1] || inferred.offer
    }
  ];
}

function fallbackSocialProof(context) {
  const inferred = inferLaunchAngles(context);
  return [
    inferred.proof_points[0],
    inferred.proof_points[1],
    inferred.proof_points[2]
  ].filter(Boolean);
}

function normalizeTestimonial(testimonial, context) {
  const fallback = fallbackTestimonial(context);
  if (!testimonial || typeof testimonial !== 'object') return fallback;
  const normalized = {
    quote: clean(testimonial.quote),
    name: clean(testimonial.name),
    role: clean(testimonial.role)
  };
  return normalized.quote ? {
    quote: normalized.quote,
    name: normalized.name || fallback.name,
    role: normalized.role || fallback.role
  } : fallback;
}

function fallbackTestimonial(context) {
  if (clean(context.name).toLowerCase().includes('founder') && clean(context.name).toLowerCase().includes('investor')) {
    return {
      quote: 'We stopped sending unfocused investor outreach and finally had a page that explained why our startup mattered before the first call.',
      name: 'Early-stage founder',
      role: 'Pre-seed SaaS'
    };
  }
  return {
    quote: `${clean(context.name)} makes the first customer conversation feel clearer, sharper, and easier to act on.`,
    name: 'Launch customer',
    role: clean(context.targetCustomer) || 'Customer'
  };
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
      hero_badge: 'Founder fundraising match',
      headline: 'Get matched with the right investors without spamming your network',
      subheadline: `${name} helps ${audience} surface qualified investor matches, tighten their fundraising story, and move from cold outreach to real conversations faster.`,
      cta: 'Apply for a match',
      cta_microcopy: 'Built for pre-seed and seed founders. Clear next step, no messy cold outreach workflow.',
      positioning: `${name} gives founders a faster path to qualified investor introductions, clearer fundraising positioning, and a better first impression before the next raise.`,
      offer: 'Qualified investor matches, clearer fundraising positioning, and a launch workflow built for pre-seed and seed teams.',
      proof_points: [
        'Targeted around stage, sector, and investor-fit instead of generic fundraising lists.',
        'Built to reduce cold outreach overhead and help founders focus on real meetings.',
        `Structured to move founders toward ${goal.toLowerCase()} with a clear launch surface and outreach system.`
      ],
      social_proof_items: [
        'Founder-first fundraising narrative',
        'Investor-fit over bulk lists',
        'Designed for pre-seed and seed teams',
        'Clear CTA with lower hesitation',
        'Better first impression before the intro'
      ]
    };
  }

  return {
    hero_badge: `${titleCase(clean(context.type) || 'business')} launch`,
    headline: `${name} for ${audience}`,
    subheadline: `${name} helps ${audience} move toward ${goal.toLowerCase()} with a clearer offer, sharper positioning, and a cleaner first-touch experience.`,
    cta: `Talk to ${name}`,
    cta_microcopy: 'A clear next step, less friction, and a sharper first impression.',
    positioning: `${name} helps ${audience} move toward ${goal.toLowerCase()}.`,
    offer: `A focused ${clean(context.type) || 'business'} offer designed for ${audience}.`,
    proof_points: [
      `Built around ${audience}.`,
      `Focused on ${goal.toLowerCase()}.`,
      'Run through Ventura’s live operator loop and launch workflow.'
    ],
    social_proof_items: [
      `Built around ${audience}.`,
      `Focused on ${goal.toLowerCase()}.`,
      'Clear value proposition and CTA.',
      'Lower-friction launch experience.'
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
