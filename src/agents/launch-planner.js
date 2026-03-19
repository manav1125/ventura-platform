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
  "brand_name": "string",
  "brand_tagline": "string",
  "visual_motif": "string",
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
- If the provided business name is generic or descriptive, create a sharper public-facing brand name and tagline.
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
  const narrativeSections = (plan.narrative_sections || []).slice(0, 3);
  const socialProofItems = (plan.social_proof_items || []).slice(0, 5);
  const primaryCta = plan.cta || `Talk to ${business.name}`;
  const primaryHref = buildPrimaryHref(business, primaryCta);
  const ctaMicrocopy = plan.cta_microcopy || 'Clear next step. No heavy setup. Fast path to the first conversation.';
  const heroBadge = plan.hero_badge || `${titleCase(business.type || 'business')} launch`;
  const audienceLabel = clean(business.target_customer) || 'Founders';
  const goalLabel = clean(business.goal_90d) || 'Reach the next stage of growth';
  const brand = resolveBrandIdentity(business, plan);
  const benefitCards = buildBenefitCards(business, plan);
  const journeySteps = buildJourneySteps(business, plan, narrativeSections);
  const faqItems = buildCustomerFaq(business, plan);
  const testimonial = normalizeTestimonial(plan.testimonial, {
    name: business.name,
    targetCustomer: business.target_customer,
    goal90d: business.goal_90d
  });
  const customerSummary = buildCustomerSummary(business, plan, brand);
  const socialProofMarkup = socialProofItems.map(item => `<span class="trust-chip">${escapeHtml(item)}</span>`).join('');
  const benefitMarkup = benefitCards.map(card => `
    <article class="benefit-card">
      <div class="benefit-icon">${escapeHtml(card.icon)}</div>
      <h3>${escapeHtml(card.title)}</h3>
      <p>${escapeHtml(card.body)}</p>
    </article>
  `).join('');
  const stepsMarkup = journeySteps.map((step, index) => `
    <article class="step-card">
      <div class="step-index">0${index + 1}</div>
      <div class="step-content">
        <h3>${escapeHtml(step.title)}</h3>
        <p>${escapeHtml(step.body)}</p>
      </div>
    </article>
  `).join('');
  const faqMarkup = faqItems.map(item => `
    <article class="faq-item">
      <h3>${escapeHtml(item.question)}</h3>
      <p>${escapeHtml(item.answer)}</p>
    </article>
  `).join('');
  const footerCopy = business.email_address
    ? `Questions before you apply? Reach the ${brand.name} team at ${business.email_address}.`
    : `${brand.tagline} Reply to the primary CTA and Ventura will route the next conversation.`;
  const heroArt = renderHeroArtwork(brand, business, plan);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(brand.name)}</title>
  <meta name="description" content="${escapeHtml(brand.tagline || plan.positioning || business.description)}">
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
      width:54px;
      height:54px;
      display:grid;
      place-items:center;
      filter:drop-shadow(0 18px 30px rgba(255,110,59,.18));
    }
    .brand-copy { display:grid; gap:2px; }
    .brand-name {
      font-size:14px;
      letter-spacing:.18em;
      text-transform:uppercase;
      color:#1b1613;
      font-weight:700;
    }
    .brand-note { font-size:13px; color:rgba(23,19,18,.56); max-width:420px; }
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
    .hero-dashboard,
    .quote-panel,
    .faq-item,
    .footer-card,
    .benefit-card,
    .step-card {
      background:rgba(255,255,255,.66);
      border:1px solid rgba(23,19,18,.08);
      box-shadow:0 20px 60px rgba(71,47,25,.08);
      backdrop-filter:blur(16px);
    }
    .hero-dashboard {
      position:relative;
      z-index:1;
      border-radius:30px;
      min-height:470px;
      padding:24px;
      display:grid;
      gap:16px;
      align-content:start;
      margin-top:16px;
    }
    .dashboard-top {
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:12px;
    }
    .hero-illustration {
      position:absolute;
      inset:22px 22px 180px 22px;
      display:grid;
      place-items:center;
      overflow:hidden;
      border-radius:26px;
      background:linear-gradient(180deg, rgba(255,255,255,.65), rgba(255,255,255,.2));
      border:1px solid rgba(23,19,18,.08);
    }
    .hero-illustration svg {
      width:100%;
      height:100%;
      display:block;
    }
    .visual-badges {
      position:absolute;
      left:26px;
      right:26px;
      top:26px;
      display:flex;
      justify-content:space-between;
      gap:12px;
      z-index:2;
    }
    .visual-badge {
      padding:10px 12px;
      border-radius:999px;
      border:1px solid rgba(23,19,18,.08);
      background:rgba(255,255,255,.74);
      font-size:11px;
      letter-spacing:.12em;
      text-transform:uppercase;
      color:rgba(23,19,18,.58);
      box-shadow:0 14px 26px rgba(71,47,25,.06);
    }
    .match-strip {
      display:grid;
      grid-template-columns:repeat(3, minmax(0, 1fr));
      gap:12px;
    }
    .match-card {
      padding:16px;
      border-radius:22px;
      background:rgba(249,245,238,.84);
      border:1px solid rgba(23,19,18,.07);
    }
    .match-card strong {
      display:block;
      margin-top:10px;
      font-size:19px;
      line-height:1.1;
      letter-spacing:-.03em;
      color:#171312;
    }
    .match-card p {
      margin:8px 0 0;
      color:rgba(23,19,18,.58);
      line-height:1.6;
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
    .benefit-grid,
    .steps-grid,
    .faq-grid {
      display:grid;
      grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));
      gap:14px;
    }
    .benefit-card,
    .step-card,
    .faq-item {
      padding:22px;
      border-radius:26px;
    }
    .benefit-icon,
    .step-index {
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
    .benefit-card h3,
    .step-card h3,
    .faq-item h3 {
      margin:16px 0 12px;
      font-size:23px;
      letter-spacing:-.03em;
      line-height:1.1;
      color:#171312;
    }
    .benefit-card p,
    .step-card p,
    .faq-item p {
      margin:0;
      color:rgba(23,19,18,.62);
      line-height:1.7;
    }
    .step-content { margin-top:18px; }
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
      .hero-illustration {
        position:relative;
        inset:auto;
        min-height:260px;
        margin-bottom:14px;
      }
      .visual-badges {
        position:relative;
        inset:auto;
        margin-bottom:14px;
      }
      .hero-dashboard { margin-top:0; min-height:unset; }
      .match-strip,
      .steps-grid { grid-template-columns:1fr; }
      .footer-card { flex-direction:column; align-items:flex-start; }
    }
  </style>
</head>
<body>
  <div class="ambient-orb"></div>
  <main class="shell">
    <div class="nav">
      <div class="brand-lockup">
        <div class="brand-mark">${renderBrandLogoSvg(brand)}</div>
        <div class="brand-copy">
          <div class="brand-name">${escapeHtml(brand.name)}</div>
          <div class="brand-note">${escapeHtml(brand.tagline)}</div>
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
          <a class="btn btn-secondary" href="#how-it-works">How it works</a>
        </div>
        <div class="microcopy">${escapeHtml(ctaMicrocopy)}</div>
        <div class="hero-note">
          <strong>${escapeHtml(brand.tagline)}</strong>
          <span>${escapeHtml(goalLabel)}</span>
        </div>
        ${socialProofItems.length ? `<div class="trust-row">${socialProofMarkup}</div>` : ''}
      </div>
      <aside class="hero-visual">
        <div class="visual-shell">
          <div class="visual-badges">
            <div class="visual-badge">${escapeHtml(heroBadge)}</div>
            <div class="visual-badge">${escapeHtml(brand.visual_motif || 'Curated warm intros')}</div>
          </div>
          <div class="hero-illustration">${heroArt}</div>
          <div class="hero-dashboard">
            <div class="dashboard-top">
              <div>
                <div class="section-kicker">Why founders choose ${escapeHtml(brand.name)}</div>
                <div class="brand-note">${escapeHtml(plan.offer)}</div>
              </div>
              <div class="nav-pill">${escapeHtml(goalLabel)}</div>
            </div>
            <div class="match-strip">
              <div class="match-card">
                <div class="section-kicker">For</div>
                <strong>${escapeHtml(audienceLabel)}</strong>
                <p>Built for founders who want high-signal investor conversations without the usual spreadsheet chaos.</p>
              </div>
              <div class="match-card">
                <div class="section-kicker">Outcome</div>
                <strong>${escapeHtml(benefitCards[0]?.title || plan.offer)}</strong>
                <p>${escapeHtml(benefitCards[0]?.body || plan.positioning)}</p>
              </div>
              <div class="match-card">
                <div class="section-kicker">Next step</div>
                <strong>${escapeHtml(primaryCta)}</strong>
                <p>${escapeHtml(ctaMicrocopy)}</p>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </section>

    <section class="section-shell">
      <div class="section-head">
        <div>
          <div class="section-kicker">Why founders stay with it</div>
          <h2>Everything is designed to help the right investor conversation happen sooner.</h2>
        </div>
        <p class="section-intro">${escapeHtml(customerSummary)}</p>
      </div>
      <div class="benefit-grid">
        ${benefitMarkup}
      </div>
    </section>

    <section id="how-it-works" class="section-shell">
      <div class="section-head">
        <div>
          <div class="section-kicker">How it works</div>
          <h2>${escapeHtml(brand.name)} turns founder context into investor-ready momentum.</h2>
        </div>
        <p class="section-intro">${escapeHtml(customerSummary)}</p>
      </div>
      <div class="steps-grid">
        ${stepsMarkup}
      </div>
    </section>

    ${testimonial.quote ? `
      <section class="quote-panel">
        <div class="section-kicker">Founder perspective</div>
        <div class="quote-text">“${renderQuoteMarkup(testimonial.quote)}”</div>
        <div class="quote-meta">${escapeHtml(testimonial.name || 'Founder')} · ${escapeHtml(testimonial.role || business.target_customer || 'Customer')}</div>
      </section>
    ` : ''}

    ${faqItems.length ? `
      <section class="section-shell">
        <div class="section-head">
          <div>
            <div class="section-kicker">Questions founders ask</div>
            <h2>Everything you would want to know before applying.</h2>
          </div>
          <p class="section-intro">${escapeHtml(brand.tagline)}</p>
        </div>
        <div class="faq-grid">
          ${faqMarkup}
        </div>
      </section>
    ` : ''}

    <section class="footer-card">
      <div>
        <div class="section-kicker">${escapeHtml(brand.name)}</div>
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
    brand_name: clean(plan.brand_name) || fallbackPlan.brand_name,
    brand_tagline: clean(plan.brand_tagline) || fallbackPlan.brand_tagline,
    visual_motif: clean(plan.visual_motif) || fallbackPlan.visual_motif,
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
    brand_name: inferred.brand_name,
    brand_tagline: inferred.brand_tagline,
    visual_motif: inferred.visual_motif,
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
      brand_name: 'SignalMatch',
      brand_tagline: 'Curated investor introductions for ambitious founders.',
      visual_motif: 'Founder profile to investor match flow',
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
      launch_summary: 'A faster, founder-first path to qualified investor conversations.'
    };
  }

  return {
    brand_name: deriveGeneratedBrandName(context),
    brand_tagline: `A more compelling way for ${audience} to move toward ${goal.toLowerCase()}.`,
    visual_motif: 'Modern product storytelling',
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
    launch_summary: 'A polished first-touch experience designed to feel focused, trustworthy, and ready for real customer conversations.'
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

function resolveBrandIdentity(business, plan) {
  const context = {
    name: clean(business.name),
    targetCustomer: clean(business.target_customer),
    goal90d: clean(business.goal_90d),
    type: clean(business.type)
  };
  const inferred = inferLaunchAngles(context);
  const generic = isGenericBusinessName(context.name);
  const fallbackName = generic ? inferred.brand_name : context.name || inferred.brand_name;
  return {
    name: clean(plan.brand_name) || fallbackName,
    tagline: clean(plan.brand_tagline) || inferred.brand_tagline || clean(plan.positioning) || context.name,
    visual_motif: clean(plan.visual_motif) || inferred.visual_motif || 'Modern product storytelling'
  };
}

function deriveGeneratedBrandName(context) {
  const name = clean(context.name);
  const lower = name.toLowerCase();
  if (!name) return 'Ventura Launch';
  if (lower.includes('founder') && lower.includes('investor')) return 'SignalMatch';
  const keywords = name
    .replace(/\b(saas|company|platform|tool|that|for|and|with|the|to)\b/gi, ' ')
    .split(/[^a-zA-Z0-9]+/)
    .map(part => clean(part))
    .filter(Boolean);
  if (keywords.length >= 2) {
    return `${titleCase(keywords[0])}${titleCase(keywords[1])}`;
  }
  return titleCase(keywords[0] || name.split(/\s+/)[0] || 'Ventura');
}

function isGenericBusinessName(name) {
  const cleaned = clean(name).toLowerCase();
  if (!cleaned) return true;
  return cleaned.length > 28
    || /^saas company\b/.test(cleaned)
    || cleaned.includes('that connects')
    || cleaned.includes('platform for')
    || cleaned.includes('company that')
    || cleaned.split(/\s+/).length >= 5;
}

function renderBrandLogoSvg(brand) {
  const monogram = clean(brand.name).split(/\s+/).map(word => word[0]).join('').slice(0, 2).toUpperCase() || 'V';
  return `
    <svg width="54" height="54" viewBox="0 0 54 54" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="${escapeHtml(brand.name)} logo">
      <rect width="54" height="54" rx="18" fill="url(#g)"/>
      <circle cx="16" cy="18" r="4" fill="#FFF7F0"/>
      <circle cx="38" cy="16" r="3.5" fill="#FFF7F0" fill-opacity=".85"/>
      <circle cx="30" cy="35" r="4.5" fill="#FFF7F0" fill-opacity=".95"/>
      <path d="M16 18L30 35L38 16" stroke="#FFF7F0" stroke-width="2.2" stroke-linecap="round"/>
      <text x="27" y="47" text-anchor="middle" font-family="Space Grotesk, sans-serif" font-size="10" font-weight="700" fill="#FFF7F0">${escapeHtml(monogram)}</text>
      <defs>
        <linearGradient id="g" x1="4" y1="4" x2="50" y2="50" gradientUnits="userSpaceOnUse">
          <stop stop-color="#FF6E3B"/>
          <stop offset="1" stop-color="#11574A"/>
        </linearGradient>
      </defs>
    </svg>
  `;
}

function buildBenefitCards(business, plan) {
  const founderInvestor = clean(business.name).toLowerCase().includes('founder')
    && clean(business.name).toLowerCase().includes('investor');

  if (founderInvestor) {
    return [
      {
        icon: '01',
        title: 'Find investors that actually fit your stage and category',
        body: 'Skip the bulk database approach and focus on a tighter shortlist built around your raise, market, and momentum.'
      },
      {
        icon: '02',
        title: 'Show up with a sharper story before the intro happens',
        body: 'Your positioning, application, and first touch feel higher-signal from the moment an investor lands on the company.'
      },
      {
        icon: '03',
        title: 'Spend less time chasing and more time in real conversations',
        body: 'The experience is designed to turn curiosity into warm replies, qualified calls, and a cleaner path to the next raise.'
      }
    ];
  }

  return (plan.proof_points || []).slice(0, 3).map((item, index) => ({
    icon: `0${index + 1}`,
    title: item,
    body: index === 0 ? plan.positioning : plan.subheadline
  }));
}

function buildJourneySteps(business, plan, narrativeSections = []) {
  const founderInvestor = clean(business.name).toLowerCase().includes('founder')
    && clean(business.name).toLowerCase().includes('investor');

  if (founderInvestor) {
    return [
      {
        title: 'Tell us what you are building and where you are in the raise',
        body: 'Share the company story, traction, sector, and target round so the matching logic starts from the right signal.'
      },
      {
        title: 'Get a curated shortlist and a sharper fundraising narrative',
        body: 'Receive investor-fit guidance and a cleaner story that makes the company easier to understand in a single glance.'
      },
      {
        title: 'Walk into warmer conversations with better context',
        body: 'Use the shortlist, positioning, and intro-ready materials to spend more energy on meetings that make sense.'
      }
    ];
  }

  if (narrativeSections.length) {
    return narrativeSections.map(section => ({
      title: section.title,
      body: section.body
    }));
  }

  return [
    { title: 'Start with the right audience', body: plan.positioning },
    { title: 'Sharpen the story', body: plan.offer },
    { title: 'Move into the next conversation', body: plan.launch_summary }
  ];
}

function buildCustomerFaq(business, plan) {
  const founderInvestor = clean(business.name).toLowerCase().includes('founder')
    && clean(business.name).toLowerCase().includes('investor');

  if (founderInvestor) {
    return [
      {
        question: 'Who is this built for?',
        answer: 'Founders raising pre-seed or seed rounds who want a tighter, more qualified path to the right investor conversations.'
      },
      {
        question: 'What happens after I apply?',
        answer: 'You share the company basics, the raise context, and the traction story so the matching process can focus on stage, sector, and fit.'
      },
      {
        question: 'Why not just buy a list and send cold emails?',
        answer: 'Because fit matters more than volume. A better-matched shortlist and a sharper story usually outperform more noise.'
      }
    ];
  }

  return (plan.faq || []).slice(0, 3);
}

function buildCustomerSummary(business, plan, brand) {
  const founderInvestor = clean(business.name).toLowerCase().includes('founder')
    && clean(business.name).toLowerCase().includes('investor');

  if (founderInvestor) {
    return `${brand.name} helps founders replace cold fundraising chaos with curated investor fit, sharper positioning, and warmer conversations.`;
  }

  return clean(plan.positioning) || clean(brand.tagline) || clean(plan.subheadline);
}

function renderHeroArtwork(brand, business, plan) {
  const founderInvestor = clean(business.name).toLowerCase().includes('founder')
    && clean(business.name).toLowerCase().includes('investor');

  if (founderInvestor) {
    return `
      <svg viewBox="0 0 640 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeHtml(brand.name)} match illustration">
        <defs>
          <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#FFF7F0"/>
            <stop offset="100%" stop-color="#F5EFE5"/>
          </linearGradient>
          <linearGradient id="stroke" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#FF6E3B"/>
            <stop offset="100%" stop-color="#11574A"/>
          </linearGradient>
        </defs>
        <rect width="640" height="360" rx="28" fill="url(#panel)"/>
        <circle cx="164" cy="168" r="56" fill="#FFF0E7"/>
        <circle cx="164" cy="146" r="18" fill="#FF6E3B"/>
        <rect x="126" y="174" width="76" height="42" rx="18" fill="#FF6E3B" fill-opacity=".88"/>
        <rect x="96" y="236" width="136" height="68" rx="20" fill="#FFFFFF" stroke="#E8DCCE"/>
        <text x="116" y="262" font-family="Space Grotesk, sans-serif" font-size="12" font-weight="700" fill="#1B1613">Founder profile</text>
        <text x="116" y="284" font-family="Space Grotesk, sans-serif" font-size="11" fill="#6F655C">B2B SaaS · Seed round</text>
        <path d="M220 166C278 122 340 122 396 164" stroke="url(#stroke)" stroke-width="4" stroke-linecap="round" stroke-dasharray="6 8"/>
        <path d="M220 188C280 234 340 236 398 194" stroke="#11574A" stroke-opacity=".26" stroke-width="3" stroke-linecap="round"/>
        <g transform="translate(420 86)">
          <rect width="154" height="74" rx="20" fill="#FFFFFF" stroke="#E8DCCE"/>
          <circle cx="26" cy="26" r="10" fill="#11574A"/>
          <text x="46" y="29" font-family="Space Grotesk, sans-serif" font-size="12" font-weight="700" fill="#1B1613">Operator Fund</text>
          <text x="20" y="52" font-family="Space Grotesk, sans-serif" font-size="11" fill="#6F655C">Seed · B2B SaaS · warm fit</text>
        </g>
        <g transform="translate(402 174)">
          <rect width="170" height="74" rx="20" fill="#FFF4EC" stroke="#F4D5C1"/>
          <circle cx="26" cy="26" r="10" fill="#FF6E3B"/>
          <text x="46" y="29" font-family="Space Grotesk, sans-serif" font-size="12" font-weight="700" fill="#1B1613">Conviction Capital</text>
          <text x="20" y="52" font-family="Space Grotesk, sans-serif" font-size="11" fill="#6F655C">Pre-seed · SaaS infra · active now</text>
        </g>
        <g transform="translate(426 262)">
          <rect width="122" height="40" rx="18" fill="#FFFFFF" stroke="#E8DCCE"/>
          <text x="22" y="25" font-family="Space Grotesk, sans-serif" font-size="11" font-weight="700" fill="#1B1613">Warm intros only</text>
        </g>
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 640 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeHtml(brand.name)} brand illustration">
      <defs>
        <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#FF6E3B"/>
          <stop offset="100%" stop-color="#11574A"/>
        </linearGradient>
      </defs>
      <rect width="640" height="360" rx="28" fill="#FFF8F2"/>
      <path d="M90 250C160 160 248 126 346 136C422 144 486 188 548 252" stroke="url(#g1)" stroke-width="6" stroke-linecap="round" fill="none"/>
      <circle cx="126" cy="248" r="16" fill="#FF6E3B"/>
      <circle cx="284" cy="148" r="14" fill="#11574A"/>
      <circle cx="510" cy="236" r="16" fill="#FF9D56"/>
      <rect x="88" y="70" width="196" height="86" rx="24" fill="#FFFFFF" stroke="#E9DDD0"/>
      <text x="112" y="103" font-family="Space Grotesk, sans-serif" font-size="14" font-weight="700" fill="#1B1613">${escapeHtml(brand.name)}</text>
      <text x="112" y="129" font-family="Space Grotesk, sans-serif" font-size="12" fill="#6F655C">${escapeHtml(plan.offer)}</text>
      <rect x="360" y="186" width="188" height="92" rx="24" fill="#FFFFFF" stroke="#E9DDD0"/>
      <text x="384" y="220" font-family="Space Grotesk, sans-serif" font-size="13" font-weight="700" fill="#1B1613">${escapeHtml(clean(business.target_customer) || 'Audience')}</text>
      <text x="384" y="246" font-family="Space Grotesk, sans-serif" font-size="12" fill="#6F655C">${escapeHtml(plan.positioning)}</text>
    </svg>
  `;
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
