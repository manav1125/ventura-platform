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
  const primaryHref = buildPrimaryHref(business, primaryCta);
  const ctaMicrocopy = plan.cta_microcopy || 'Clear next step. No heavy setup. Fast path to the first conversation.';
  const heroBadge = plan.hero_badge || `${titleCase(business.type || 'business')} launch`;
  const brandLabel = deriveSiteBrand(business.name, heroBadge);
  const audienceLabel = clean(business.target_customer) || 'Founders';
  const goalLabel = clean(business.goal_90d) || 'Reach the next stage of growth';
  const heroSummary = narrativeSections[0]?.body || plan.launch_summary || plan.positioning || '';
  const storyline = narrativeSections.map((section, index) => `
    <article class="story-step ${index === 1 ? 'story-step-featured' : ''}">
      <div class="story-index">0${index + 1}</div>
      <div class="story-content">
        ${section.kicker ? `<div class="story-kicker">${escapeHtml(section.kicker)}</div>` : ''}
        <h3>${escapeHtml(section.title)}</h3>
        <p>${escapeHtml(section.body)}</p>
      </div>
    </article>
  `).join('');
  const proofMarkup = proof.map((item, index) => `
    <article class="value-card ${index === 1 ? 'value-card-accent' : ''}">
      <div class="value-index">0${index + 1}</div>
      <h3>${escapeHtml(item)}</h3>
      <p>${escapeHtml(index === 0 ? plan.positioning : heroSummary)}</p>
    </article>
  `).join('');
  const socialProofMarkup = socialProofItems.map(item => `<span class="trust-chip">${escapeHtml(item)}</span>`).join('');
  const faqMarkup = faqItems.map(item => `
    <article class="faq-item">
      <h3>${escapeHtml(item.question)}</h3>
      <p>${escapeHtml(item.answer)}</p>
    </article>
  `).join('');
  const testimonial = plan.testimonial || {};
  const focusCards = buildHeroFocusCards(business, plan);
  const focusMarkup = focusCards.map(card => `
    <div class="focus-card">
      <div class="focus-card-top">
        <span>${escapeHtml(card.label)}</span>
        <strong>${escapeHtml(card.badge)}</strong>
      </div>
      <div class="focus-card-title">${escapeHtml(card.title)}</div>
      <div class="focus-card-copy">${escapeHtml(card.copy)}</div>
    </div>
  `).join('');
  const signalPills = buildSignalPills(business, plan).map(item => `<span class="signal-pill">${escapeHtml(item)}</span>`).join('');
  const footerCopy = business.email_address
    ? `${plan.subheadline} Reach the team at ${business.email_address}.`
    : `${plan.subheadline} Reply to the primary CTA and Ventura will route the next conversation.`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(business.name)}</title>
  <meta name="description" content="${escapeHtml(plan.positioning || business.description)}">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Space+Grotesk:wght@400;500;700&display=swap');
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin:0;
      font-family:"Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 12% 8%, rgba(255,118,66,.22), transparent 28%),
        radial-gradient(circle at 88% 10%, rgba(17,91,74,.16), transparent 24%),
        radial-gradient(circle at 70% 78%, rgba(65,126,255,.12), transparent 26%),
        linear-gradient(180deg, #fbf2e5 0%, #f5eee4 48%, #efe7db 100%);
      color:#171312;
      min-height:100vh;
      position:relative;
      overflow-x:hidden;
    }
    body::before {
      content:"";
      position:fixed;
      inset:0;
      background:
        linear-gradient(rgba(23,19,18,.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(23,19,18,.03) 1px, transparent 1px);
      background-size:72px 72px;
      mask-image:linear-gradient(180deg, rgba(0,0,0,.55), transparent 86%);
      pointer-events:none;
    }
    .ambient-orb,
    .ambient-orb::after {
      position:absolute;
      border-radius:999px;
      filter:blur(12px);
      pointer-events:none;
    }
    .ambient-orb {
      width:240px;
      height:240px;
      top:74px;
      right:10%;
      background:rgba(255,100,53,.18);
    }
    .ambient-orb::after {
      content:"";
      width:180px;
      height:180px;
      right:-44px;
      bottom:-22px;
      background:rgba(25,97,79,.16);
    }
    .shell { max-width:1220px; margin:0 auto; padding:26px 22px 88px; position:relative; z-index:1; }
    .nav {
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:16px;
      padding:6px 0 26px;
    }
    .brand-lockup { display:flex; align-items:center; gap:14px; }
    .brand-mark {
      width:46px;
      height:46px;
      border-radius:16px;
      display:grid;
      place-items:center;
      background:linear-gradient(135deg, #ff6e3b, #ff9f56);
      color:#fff6ef;
      font-weight:700;
      box-shadow:0 18px 40px rgba(255,110,59,.24);
    }
    .brand-copy { display:grid; gap:2px; }
    .brand-name {
      font-size:14px;
      letter-spacing:.18em;
      text-transform:uppercase;
      color:#1b1613;
      font-weight:700;
    }
    .brand-note { font-size:13px; color:rgba(23,19,18,.56); }
    .nav-actions { display:flex; align-items:center; gap:12px; }
    .nav-pill {
      padding:10px 14px;
      border-radius:999px;
      background:rgba(255,255,255,.5);
      border:1px solid rgba(23,19,18,.08);
      color:rgba(23,19,18,.7);
      font-size:12px;
      letter-spacing:.12em;
      text-transform:uppercase;
    }
    .hero {
      display:grid;
      grid-template-columns:minmax(0, 1.04fr) minmax(320px, .96fr);
      gap:26px;
      align-items:center;
      padding:24px 0 42px;
    }
    .hero-copy {
      padding:20px 0;
      position:relative;
      overflow:hidden;
    }
    .hero-copy::after {
      content:"";
      position:absolute;
      inset:auto auto 20px -28px;
      width:120px;
      height:120px;
      background:radial-gradient(circle, rgba(255,110,59,.18), transparent 70%);
      pointer-events:none;
    }
    .hero-visual {
      position:relative;
      min-height:620px;
      padding:18px;
      display:grid;
      align-items:end;
    }
    .eyebrow {
      display:inline-flex;
      gap:8px;
      align-items:center;
      padding:9px 14px;
      border:1px solid rgba(23,19,18,.08);
      border-radius:999px;
      font-size:12px;
      letter-spacing:.14em;
      text-transform:uppercase;
      color:#11574a;
      background:rgba(255,255,255,.52);
      width:max-content;
      box-shadow:0 14px 32px rgba(23,19,18,.06);
    }
    h1 {
      margin:20px 0 18px;
      font-size:clamp(56px, 8vw, 104px);
      line-height:.92;
      letter-spacing:-.05em;
      max-width:820px;
      color:#191412;
    }
    .headline-emphasis {
      font-family:"Instrument Serif", Georgia, serif;
      font-weight:400;
      font-style:italic;
      color:#11574a;
    }
    .lede {
      font-size:20px;
      line-height:1.72;
      color:rgba(23,19,18,.7);
      max-width:680px;
    }
    .cta-row { display:flex; flex-wrap:wrap; gap:12px; margin-top:30px; }
    .btn {
      display:inline-flex;
      align-items:center;
      justify-content:center;
      padding:16px 22px;
      border-radius:999px;
      text-decoration:none;
      font-weight:700;
      min-width:184px;
      transition:transform .2s ease, box-shadow .2s ease;
    }
    .btn:hover {
      transform:translateY(-1px);
    }
    .btn-primary {
      background:linear-gradient(135deg, #ff6e3b, #ff9d56);
      color:#1a130f;
      box-shadow:0 18px 38px rgba(255,110,59,.22);
    }
    .btn-secondary {
      border:1px solid rgba(23,19,18,.12);
      color:#1a130f;
      background:rgba(255,255,255,.46);
      backdrop-filter:blur(18px);
    }
    .microcopy {
      margin-top:14px;
      font-size:13px;
      color:rgba(23,19,18,.52);
      line-height:1.6;
      max-width:560px;
    }
    .trust-row {
      display:flex;
      flex-wrap:wrap;
      gap:10px;
      margin-top:22px;
    }
    .trust-chip,
    .signal-pill {
      display:inline-flex;
      align-items:center;
      gap:8px;
      padding:10px 14px;
      border-radius:999px;
      border:1px solid rgba(23,19,18,.08);
      background:rgba(255,255,255,.5);
      color:#1a1512;
      font-size:12px;
      box-shadow:0 12px 28px rgba(23,19,18,.05);
    }
    .trust-chip::before,
    .signal-pill::before {
      content:"";
      width:7px;
      height:7px;
      border-radius:999px;
      background:#ff6e3b;
    }
    .hero-note {
      display:flex;
      align-items:center;
      gap:12px;
      margin-top:22px;
      color:rgba(23,19,18,.56);
      font-size:14px;
    }
    .hero-note strong { color:#191412; }
    .visual-shell {
      position:relative;
      min-height:540px;
      border-radius:34px;
      background:
        linear-gradient(160deg, rgba(255,255,255,.74), rgba(255,255,255,.38)),
        linear-gradient(145deg, rgba(255,110,59,.1), rgba(17,87,74,.08));
      border:1px solid rgba(23,19,18,.08);
      box-shadow:0 28px 90px rgba(83,56,29,.12);
      overflow:hidden;
      backdrop-filter:blur(18px);
      padding:24px;
    }
    .visual-shell::before {
      content:"";
      position:absolute;
      width:420px;
      height:420px;
      inset:-120px auto auto -120px;
      background:radial-gradient(circle, rgba(255,110,59,.22), transparent 70%);
    }
    .visual-shell::after {
      content:"";
      position:absolute;
      width:360px;
      height:360px;
      right:-110px;
      bottom:-120px;
      background:radial-gradient(circle, rgba(65,126,255,.18), transparent 68%);
    }
    .floating-card,
    .hero-dashboard,
    .cta-card,
    .value-card,
    .story-step,
    .quote-panel,
    .faq-item,
    .footer-card {
      background:rgba(255,255,255,.66);
      border:1px solid rgba(23,19,18,.08);
      box-shadow:0 20px 60px rgba(71,47,25,.08);
      backdrop-filter:blur(16px);
    }
    .floating-card {
      position:absolute;
      top:18px;
      right:18px;
      width:min(240px, 46%);
      padding:16px;
      border-radius:22px;
      z-index:2;
    }
    .floating-label {
      font-size:11px;
      letter-spacing:.14em;
      text-transform:uppercase;
      color:rgba(23,19,18,.46);
    }
    .floating-title {
      margin-top:10px;
      font-size:18px;
      line-height:1.25;
      letter-spacing:-.03em;
      color:#171312;
    }
    .floating-copy {
      margin-top:8px;
      color:rgba(23,19,18,.62);
      line-height:1.55;
      font-size:13px;
    }
    .signal-pill-row {
      display:flex;
      flex-wrap:wrap;
      gap:8px;
      margin-top:14px;
    }
    .hero-dashboard {
      position:relative;
      z-index:1;
      border-radius:30px;
      min-height:432px;
      padding:22px;
      display:grid;
      gap:16px;
      align-content:start;
      margin-top:96px;
    }
    .dashboard-top {
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:12px;
    }
    .dashboard-grid {
      display:grid;
      grid-template-columns:repeat(2, minmax(0, 1fr));
      gap:14px;
    }
    .metric-card {
      padding:16px;
      border-radius:20px;
      background:rgba(249,245,238,.72);
      border:1px solid rgba(23,19,18,.07);
    }
    .metric-value {
      margin-top:8px;
      font-size:28px;
      line-height:1;
      letter-spacing:-.04em;
      color:#191412;
    }
    .metric-copy {
      margin-top:8px;
      color:rgba(23,19,18,.58);
      line-height:1.55;
      font-size:13px;
    }
    .focus-stack {
      display:grid;
      gap:12px;
    }
    .focus-card {
      padding:16px;
      border-radius:20px;
      background:rgba(247,241,231,.82);
      border:1px solid rgba(23,19,18,.07);
    }
    .focus-card-top {
      display:flex;
      justify-content:space-between;
      gap:12px;
      color:rgba(23,19,18,.46);
      font-size:11px;
      letter-spacing:.12em;
      text-transform:uppercase;
    }
    .focus-card-title {
      margin-top:12px;
      font-size:19px;
      letter-spacing:-.03em;
      color:#171312;
    }
    .focus-card-copy {
      margin-top:8px;
      color:rgba(23,19,18,.6);
      line-height:1.65;
      font-size:13px;
    }
    .section-shell {
      margin-top:24px;
      padding:28px;
      border-radius:32px;
      background:rgba(255,255,255,.52);
      border:1px solid rgba(23,19,18,.08);
      box-shadow:0 20px 72px rgba(83,56,29,.08);
      backdrop-filter:blur(18px);
    }
    .section-head {
      display:flex;
      justify-content:space-between;
      gap:18px;
      align-items:end;
      flex-wrap:wrap;
      margin-bottom:20px;
    }
    .section-kicker,
    .story-kicker {
      font-size:11px;
      letter-spacing:.16em;
      text-transform:uppercase;
      color:rgba(23,19,18,.46);
    }
    .section-shell h2 {
      margin:8px 0 0;
      font-size:clamp(30px, 4vw, 54px);
      letter-spacing:-.04em;
      line-height:1;
      color:#171312;
      max-width:740px;
    }
    .section-intro {
      max-width:540px;
      color:rgba(23,19,18,.64);
      line-height:1.7;
      margin:0;
    }
    .value-grid,
    .storyline,
    .faq-grid {
      display:grid;
      grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));
      gap:14px;
    }
    .value-card,
    .story-step,
    .faq-item {
      padding:22px;
      border-radius:26px;
    }
    .value-card-accent {
      background:linear-gradient(180deg, rgba(255,110,59,.14), rgba(255,255,255,.7));
    }
    .value-index,
    .story-index {
      display:inline-flex;
      align-items:center;
      justify-content:center;
      width:42px;
      height:42px;
      border-radius:14px;
      background:#fff3ea;
      color:#ff6e3b;
      font-size:13px;
      font-weight:700;
      box-shadow:inset 0 0 0 1px rgba(255,110,59,.14);
    }
    .value-card h3,
    .story-step h3,
    .faq-item h3 {
      margin:16px 0 12px;
      font-size:23px;
      letter-spacing:-.03em;
      line-height:1.1;
      color:#171312;
    }
    .value-card p,
    .story-step p,
    .faq-item p {
      margin:0;
      color:rgba(23,19,18,.62);
      line-height:1.7;
    }
    .storyline {
      grid-template-columns:1.1fr .95fr .95fr;
    }
    .story-step-featured {
      background:linear-gradient(180deg, rgba(255,255,255,.84), rgba(255,110,59,.1));
    }
    .story-content { margin-top:18px; }
    .quote-panel {
      margin-top:24px;
      padding:28px;
      border-radius:34px;
      background:
        radial-gradient(circle at top right, rgba(255,110,59,.14), transparent 28%),
        rgba(255,255,255,.68);
    }
    .quote-text {
      margin-top:12px;
      font-size:clamp(28px, 4vw, 50px);
      line-height:1.08;
      letter-spacing:-.04em;
      max-width:940px;
      color:#171312;
    }
    .quote-text span {
      font-family:"Instrument Serif", Georgia, serif;
      font-style:italic;
      color:#11574a;
      font-weight:400;
    }
    .quote-meta {
      margin-top:18px;
      color:rgba(23,19,18,.58);
      font-size:14px;
    }
    .footer-card {
      margin-top:24px;
      padding:28px;
      border-radius:32px;
      display:flex;
      justify-content:space-between;
      gap:18px;
      align-items:center;
      flex-wrap:wrap;
    }
    .footer-card p {
      margin:8px 0 0;
      color:rgba(23,19,18,.62);
      line-height:1.68;
      max-width:760px;
    }
    @media (max-width: 860px) {
      .hero { grid-template-columns:1fr; }
      .shell { padding:24px 18px 60px; }
      .hero-visual { min-height:unset; padding:0; }
      .visual-shell { min-height:unset; }
      .floating-card {
        position:relative;
        inset:auto;
        width:100%;
        margin-bottom:14px;
      }
      .hero-dashboard { margin-top:0; }
      .dashboard-grid,
      .storyline { grid-template-columns:1fr; }
      .footer-card { flex-direction:column; align-items:flex-start; }
    }
  </style>
</head>
<body>
  <div class="ambient-orb"></div>
  <main class="shell">
    <div class="nav">
      <div class="brand-lockup">
        <div class="brand-mark">${escapeHtml((brandLabel || 'V').slice(0, 1).toUpperCase())}</div>
        <div class="brand-copy">
          <div class="brand-name">${escapeHtml(brandLabel)}</div>
          <div class="brand-note">${escapeHtml(plan.positioning)}</div>
        </div>
      </div>
      <div class="nav-actions">
        <div class="nav-pill">${escapeHtml(audienceLabel)}</div>
        <a class="btn btn-secondary" href="${escapeHtml(primaryHref)}">${escapeHtml(primaryCta)}</a>
      </div>
    </div>
    <section class="hero">
      <div class="hero-copy">
        <div class="eyebrow">${escapeHtml(heroBadge)}</div>
        <h1>${renderHeadlineMarkup(plan.headline)}</h1>
        <p class="lede">${escapeHtml(plan.subheadline)}</p>
        <div class="cta-row">
          <a class="btn btn-primary" href="${escapeHtml(primaryHref)}">${escapeHtml(primaryCta)}</a>
          <a class="btn btn-secondary" href="#momentum">See the flow</a>
        </div>
        <div class="microcopy">${escapeHtml(ctaMicrocopy)}</div>
        <div class="hero-note">
          <strong>${escapeHtml(plan.offer)}</strong>
          <span>${escapeHtml(goalLabel)}</span>
        </div>
        ${socialProofItems.length ? `<div class="trust-row">${socialProofMarkup}</div>` : ''}
      </div>
      <aside class="hero-visual">
        <div class="visual-shell">
          <div class="floating-card">
            <div class="floating-label">First impression</div>
            <div class="floating-title">${escapeHtml(plan.launch_summary)}</div>
            <div class="floating-copy">${escapeHtml(heroSummary)}</div>
            <div class="signal-pill-row">
              ${signalPills}
            </div>
          </div>
          <div class="hero-dashboard">
            <div class="dashboard-top">
              <div>
                <div class="floating-label">Investor-fit preview</div>
                <div class="floating-title">${escapeHtml(plan.offer)}</div>
              </div>
              <div class="nav-pill">Live narrative</div>
            </div>
            <div class="dashboard-grid">
              <div class="metric-card">
                <div class="floating-label">Audience</div>
                <div class="metric-value">${escapeHtml(audienceLabel)}</div>
                <div class="metric-copy">Everything on the page is tuned to the exact buyer this business needs first.</div>
              </div>
              <div class="metric-card">
                <div class="floating-label">Goal</div>
                <div class="metric-value">${escapeHtml(goalLabel)}</div>
                <div class="metric-copy">The page keeps the story, CTA, and proof tightly aligned to the next business milestone.</div>
              </div>
            </div>
            <div class="focus-stack">
              ${focusMarkup}
            </div>
          </div>
        </div>
      </aside>
    </section>

    <section id="momentum" class="section-shell">
      <div class="section-head">
        <div>
          <div class="section-kicker">What makes the page convert</div>
          <h2>A cleaner promise, a tighter story, and proof that earns the click.</h2>
        </div>
        <p class="section-intro">${escapeHtml(plan.launch_summary)}</p>
      </div>
      <div class="value-grid">
        ${proofMarkup}
      </div>
    </section>

    <section class="section-shell">
      <div class="section-head">
        <div>
          <div class="section-kicker">From first glance to booked conversation</div>
          <h2>The page now moves like a product story, not a checklist.</h2>
        </div>
        <p class="section-intro">${escapeHtml(plan.positioning)}</p>
      </div>
      <div class="storyline">
        ${storyline}
      </div>
    </section>

    ${testimonial.quote ? `
      <section class="quote-panel">
        <div class="section-kicker">How it should feel</div>
        <div class="quote-text">“${renderQuoteMarkup(testimonial.quote)}”</div>
        <div class="quote-meta">${escapeHtml(testimonial.name || 'Founder')} · ${escapeHtml(testimonial.role || business.target_customer || 'Customer')}</div>
      </section>
    ` : ''}

    ${faqItems.length ? `
      <section class="section-shell">
        <div class="section-head">
          <div>
            <div class="section-kicker">Objections handled quietly</div>
            <h2>The practical questions that usually stop the signup.</h2>
          </div>
          <p class="section-intro">Ventura uses these answers across the landing page, outreach, and operator workflow so the story stays consistent everywhere.</p>
        </div>
        <div class="faq-grid">
          ${faqMarkup}
        </div>
      </section>
    ` : ''}

    <section class="footer-card">
      <div>
        <div class="section-kicker">Ready for the first conversation</div>
        <p>${escapeHtml(footerCopy)}</p>
      </div>
      <a class="btn btn-primary" href="${escapeHtml(primaryHref)}">${escapeHtml(primaryCta)}</a>
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
    launch_summary: inferred.launch_summary || `A tighter launch story, a cleaner CTA, and the first public-facing version of ${context.name}.`,
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
      heading: 'The promise',
      body: inferred.offer
    },
    {
      heading: 'The audience',
      body: `Built for ${context.targetCustomer}. ${inferred.positioning}`
    },
    {
      heading: 'The reason to believe',
      body: inferred.proof_points[0]
    },
    {
      heading: 'The next move',
      body: `This launch is designed to move toward ${context.goal90d.toLowerCase()} with a clear offer, trust-building proof, and a stronger first conversion moment.`
    }
  ];
}

function fallbackNarrativeSections(context) {
  const inferred = inferLaunchAngles(context);
  return [
    {
      kicker: 'The old way',
      title: 'Most first touches feel generic before the conversation even starts',
      body: inferred.positioning
    },
    {
      kicker: 'The shift',
      title: 'A sharper story and tighter targeting creates a much stronger first yes',
      body: inferred.offer
    },
    {
      kicker: 'The outcome',
      title: `Built to move toward ${clean(context.goal90d || 'real traction').toLowerCase()}`,
      body: `The page, CTA, and proof are aligned around one next action so the experience feels crisp, credible, and worth responding to.`
    }
  ];
}

function fallbackFaq(context) {
  const inferred = inferLaunchAngles(context);
  return [
    {
      question: 'Why would someone trust this instead of another noisy workflow?',
      answer: inferred.proof_points[0] || inferred.positioning
    },
    {
      question: 'What happens after the first click?',
      answer: `The CTA routes the visitor into a direct response path built to move toward ${clean(context.goal90d || 'the next milestone').toLowerCase()} without sending them through a bloated funnel.`
    },
    {
      question: 'What makes the promise feel credible?',
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
      quote: 'Instead of another generic fundraising page, we finally had a front door that felt premium, specific, and worth replying to.',
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
      headline: 'Meet investors who already make sense for your company',
      subheadline: `Skip the bloated spreadsheet and land on a cleaner fundraising path with qualified matches, sharper narrative positioning, and a first impression that actually earns the intro.`,
      cta: 'Apply for a match',
      cta_microcopy: 'Built for pre-seed and seed founders. One clear next step, without the usual cold-outreach sprawl.',
      positioning: 'A founder-first fundraising experience that filters for investor fit, sharpens the story, and turns curiosity into real conversations.',
      offer: 'Qualified investor matches, a sharper fundraising narrative, and a front door that feels premium from the first click.',
      proof_points: [
        'Stage-aware investor fit replaces generic lists and wasted outreach.',
        'The landing experience is built to earn trust before the first intro ever gets sent.',
        `Everything is tuned to move founders toward ${goal.toLowerCase()} with a cleaner narrative and better conversations.`
      ],
      social_proof_items: [
        'Founder-first fundraising narrative',
        'Investor-fit over bulk lists',
        'Designed for pre-seed and seed teams',
        'Premium first impression',
        'Clear CTA, lower hesitation'
      ],
      launch_summary: 'A fundraising landing page that feels high-signal, polished, and built to convert the right founders.'
    };
  }

  return {
    hero_badge: `${titleCase(clean(context.type) || 'business')} launch`,
    headline: `${name} made clearer, sharper, and easier to say yes to`,
    subheadline: `A focused launch experience for ${audience} with stronger positioning, cleaner messaging, and a tighter path toward ${goal.toLowerCase()}.`,
    cta: `Talk to ${name}`,
    cta_microcopy: 'A clear next step, less friction, and a sharper first impression.',
    positioning: `A cleaner, more persuasive front door for ${audience} to move toward ${goal.toLowerCase()}.`,
    offer: `A focused ${clean(context.type) || 'business'} offer designed to feel premium and easy to act on.`,
    proof_points: [
      `Built around the needs of ${audience.toLowerCase()}.`,
      `Focused on the next real business outcome: ${goal.toLowerCase()}.`,
      'Structured as a conversion-first launch experience instead of an internal project brief.'
    ],
    social_proof_items: [
      `Built around ${audience}.`,
      `Focused on ${goal.toLowerCase()}.`,
      'Clear value proposition and CTA.',
      'Lower-friction launch experience.'
    ],
    launch_summary: 'A polished first-touch page designed to feel focused, trustworthy, and ready for real customer conversations.'
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

function buildPrimaryHref(business, cta) {
  if (clean(business.email_address)) {
    return `mailto:${clean(business.email_address)}?subject=${encodeURIComponent(clean(cta) || `Talk to ${clean(business.name)}`)}`;
  }
  return '#momentum';
}

function deriveSiteBrand(name, heroBadge) {
  const cleanedName = clean(name);
  if (!cleanedName) return clean(heroBadge) || 'Launch';
  const words = cleanedName.split(/\s+/);
  if (cleanedName.length > 34 || words.length > 5) {
    return clean(heroBadge) || words.slice(0, 3).join(' ');
  }
  return cleanedName;
}

function buildHeroFocusCards(business, plan) {
  const founderInvestor = clean(business.name).toLowerCase().includes('founder')
    && clean(business.name).toLowerCase().includes('investor');

  if (founderInvestor) {
    return [
      {
        label: 'Match quality',
        badge: 'Stage-fit',
        title: 'Pre-seed and seed investor targeting',
        copy: 'The message is tuned for the exact companies and investor profile that should care first.'
      },
      {
        label: 'Story polish',
        badge: 'Narrative',
        title: 'A sharper explanation of why this company matters',
        copy: 'Instead of a cold, generic ask, the site frames the startup in a way that feels thoughtful and high-signal.'
      },
      {
        label: 'Next step',
        badge: 'Conversion',
        title: 'One CTA that feels direct, premium, and easy to act on',
        copy: 'The experience is designed to turn interest into the first real conversation without extra friction.'
      }
    ];
  }

  return (plan.proof_points || []).slice(0, 3).map((item, index) => ({
    label: ['Audience fit', 'Offer clarity', 'Next move'][index] || 'Focus',
    badge: ['Fit', 'Message', 'CTA'][index] || 'Launch',
    title: item,
    copy: index === 0 ? plan.positioning : plan.launch_summary
  }));
}

function buildSignalPills(business, plan) {
  const founderInvestor = clean(business.name).toLowerCase().includes('founder')
    && clean(business.name).toLowerCase().includes('investor');
  if (founderInvestor) {
    return ['Pre-seed ready', 'Seed-stage fit', 'Warm intro energy'];
  }

  return [
    clean(business.target_customer) || 'Audience aligned',
    clean(plan.cta) || 'Clear CTA',
    clean(business.goal_90d) || 'Outcome focused'
  ].filter(Boolean).slice(0, 3);
}

function renderHeadlineMarkup(headline) {
  const words = clean(headline).split(/\s+/).filter(Boolean);
  if (words.length < 6) return escapeHtml(headline);
  const accentCount = Math.min(4, Math.max(2, Math.round(words.length / 3)));
  const prefix = words.slice(0, -accentCount).join(' ');
  const suffix = words.slice(-accentCount).join(' ');
  return `${escapeHtml(prefix)} <span class="headline-emphasis">${escapeHtml(suffix)}</span>`;
}

function renderQuoteMarkup(quote) {
  const words = clean(quote).split(/\s+/).filter(Boolean);
  if (words.length < 8) return escapeHtml(quote);
  const accentCount = Math.min(6, Math.max(3, Math.floor(words.length / 4)));
  const prefix = words.slice(0, -accentCount).join(' ');
  const suffix = words.slice(-accentCount).join(' ');
  return `${escapeHtml(prefix)} <span>${escapeHtml(suffix)}</span>`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
