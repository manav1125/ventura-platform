import express from 'express';
import { getDb } from '../db/migrate.js';
import { getLatestArtifactByKind, getPublishedSiteFile } from '../agents/artifacts.js';
import { buildRenderableLaunchPlan, renderLaunchSite } from '../agents/launch-planner.js';

const router = express.Router();

router.get('/:slug', (req, res) => serveBusinessSite(req, res, 'index.html'));
router.get('/:slug/*', (req, res) => serveBusinessSite(req, res, req.params[0] || 'index.html'));

function serveBusinessSite(req, res, pathValue) {
  const db = getDb();
  const business = db.prepare(`
    SELECT id, name, slug, type, description, target_customer, goal_90d, web_url, email_address
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
  res.type('html');
  res.send(renderFallbackSite(business, launchPlan));
}

function guessType(pathValue = '') {
  if (pathValue.endsWith('.css')) return 'text/css';
  if (pathValue.endsWith('.js')) return 'application/javascript';
  if (pathValue.endsWith('.svg')) return 'image/svg+xml';
  if (pathValue.endsWith('.json')) return 'application/json';
  return 'text/html';
}

function renderFallbackSite(business, launchPlan) {
  const plan = buildRenderableLaunchPlan(business, launchPlan);
  return renderLaunchSite(business, plan);
}

export default router;
