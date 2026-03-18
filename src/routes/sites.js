import express from 'express';
import { getDb } from '../db/migrate.js';
import { getLatestArtifactByKind, getPublishedSiteFile } from '../agents/artifacts.js';

const router = express.Router();

router.get('/:slug', (req, res) => serveBusinessSite(req, res, 'index.html'));
router.get('/:slug/*', (req, res) => serveBusinessSite(req, res, req.params[0] || 'index.html'));

function serveBusinessSite(req, res, pathValue) {
  const db = getDb();
  const business = db.prepare(`
    SELECT id, name, slug, description, target_customer, goal_90d, web_url
    FROM businesses
    WHERE slug = ?
  `).get(req.params.slug);

  if (!business) {
    return res.status(404).send('Business site not found');
  }

  const file = getPublishedSiteFile(business.id, pathValue);
  if (file?.content) {
    res.type(file.content_type || guessType(pathValue));
    return res.send(file.content);
  }

  if ((pathValue || 'index.html') !== 'index.html') {
    return res.status(404).send('Asset not found');
  }

  const launchPlan = getLatestArtifactByKind(business.id, 'launch_plan');
  const landingCopy = getLatestArtifactByKind(business.id, 'content');
  res.type('html');
  res.send(renderFallbackSite(business, launchPlan, landingCopy));
}

function guessType(pathValue = '') {
  if (pathValue.endsWith('.css')) return 'text/css';
  if (pathValue.endsWith('.js')) return 'application/javascript';
  if (pathValue.endsWith('.svg')) return 'image/svg+xml';
  if (pathValue.endsWith('.json')) return 'application/json';
  return 'text/html';
}

function renderFallbackSite(business, launchPlan, landingCopy) {
  const title = escapeHtml(business.name);
  const description = escapeHtml(business.description || '');
  const audience = escapeHtml(business.target_customer || '');
  const goal = escapeHtml(business.goal_90d || '');
  const planSummary = escapeHtml(launchPlan?.summary || 'Ventura is actively building this business. This public page will update as new site files are published.');
  const copyBlock = landingCopy?.content
    ? `<section><h2>Latest Ventura Draft</h2><pre>${escapeHtml(landingCopy.content)}</pre></section>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <style>
    body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#0f0f10;color:#f5f2eb}
    main{max-width:960px;margin:0 auto;padding:64px 24px}
    .eyebrow{display:inline-block;padding:6px 10px;border:1px solid rgba(255,255,255,.12);font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#28ca41}
    h1{font-size:clamp(40px,7vw,76px);line-height:.95;margin:24px 0 18px}
    p{font-size:18px;line-height:1.65;color:rgba(245,242,235,.78)}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin:36px 0}
    .card{padding:18px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);border-radius:8px}
    .label{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:rgba(245,242,235,.45);margin-bottom:10px}
    pre{white-space:pre-wrap;background:rgba(255,255,255,.03);padding:18px;border-radius:8px;border:1px solid rgba(255,255,255,.08);color:#f5f2eb}
    a{color:#ff5d22}
  </style>
</head>
<body>
  <main>
    <span class="eyebrow">Ventura launch site</span>
    <h1>${title}</h1>
    <p>${description}</p>
    <div class="grid">
      <div class="card"><div class="label">Target customer</div><div>${audience || 'Not set yet'}</div></div>
      <div class="card"><div class="label">90 day goal</div><div>${goal || 'Not set yet'}</div></div>
      <div class="card"><div class="label">Current status</div><div>Ventura is publishing this company from live artifacts.</div></div>
    </div>
    <section>
      <h2>What Ventura Is Doing</h2>
      <p>${planSummary}</p>
    </section>
    ${copyBlock}
  </main>
</body>
</html>`;
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default router;
