import express from 'express';
import { z } from 'zod';
import { getDb } from '../db/migrate.js';
import { createArtifact, getLatestArtifactByKind, getPublishedSiteFile } from '../agents/artifacts.js';
import { buildRenderableLaunchPlan, renderLaunchSite } from '../agents/launch-planner.js';
import {
  createFounderProfile,
  createInvestorProfile,
  renderFounderBrief,
  renderInvestorBrief
} from '../business/marketplace.js';
import { enqueueMarketplaceLifecycleWork } from '../business/marketplace-lifecycle.js';
import { logActivity } from '../agents/activity.js';

const router = express.Router();

router.post('/:slug/apply/founder', async (req, res) => {
  const business = getSiteBusiness(req.params.slug);
  if (!business) return res.status(404).json({ error: 'Business site not found' });
  if (business.blueprint_key !== 'founder_investor_marketplace') {
    return res.status(400).json({ error: 'This business is not accepting founder applications here.' });
  }

  const schema = z.object({
    founderName: z.string().min(2).max(120),
    founderEmail: z.string().email(),
    companyName: z.string().min(2).max(140),
    companyUrl: z.string().url().optional().or(z.literal('')),
    stage: z.string().min(2).max(80).optional().or(z.literal('')),
    sectors: z.array(z.string().min(2).max(80)).max(8).optional(),
    geography: z.string().min(2).max(120).optional().or(z.literal('')),
    tractionSummary: z.string().max(800).optional().or(z.literal('')),
    raiseSummary: z.string().max(800).optional().or(z.literal(''))
  });

  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors.map(item => item.message).join(', ') });
  }

  const founder = createFounderProfile(getDb(), business.id, parsed.data);
  createArtifact({
    businessId: business.id,
    department: 'operations',
    kind: 'marketplace_founder_brief',
    title: `Founder brief — ${founder.company_name}`,
    summary: `${founder.company_name} entered the founder pipeline from the public site.`,
    content: renderFounderBrief(founder, business.name),
    metadata: {
      founder_profile_id: founder.id,
      source: 'public_site'
    }
  });

  await logActivity(business.id, {
    type: 'lead',
    department: 'operations',
    title: `Public founder application — ${founder.company_name}`,
    detail: {
      founder_profile_id: founder.id,
      source: 'public_site'
    }
  });

  await enqueueMarketplaceLifecycleWork({
    businessId: business.id,
    source: 'founder',
    founderId: founder.id
  });

  res.status(201).json({
    ok: true,
    message: 'Founder application received.',
    founder: {
      id: founder.id,
      company_name: founder.company_name,
      founder_name: founder.founder_name
    }
  });
});

router.post('/:slug/join/investor', async (req, res) => {
  const business = getSiteBusiness(req.params.slug);
  if (!business) return res.status(404).json({ error: 'Business site not found' });
  if (business.blueprint_key !== 'founder_investor_marketplace') {
    return res.status(400).json({ error: 'This business is not accepting investor submissions here.' });
  }

  const schema = z.object({
    name: z.string().min(2).max(120),
    email: z.string().email(),
    firm: z.string().max(140).optional().or(z.literal('')),
    title: z.string().max(120).optional().or(z.literal('')),
    stageFocus: z.array(z.string().min(2).max(80)).max(8).optional(),
    sectorFocus: z.array(z.string().min(2).max(80)).max(10).optional(),
    geographyFocus: z.array(z.string().min(2).max(80)).max(8).optional(),
    thesis: z.string().max(1200).optional().or(z.literal(''))
  });

  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors.map(item => item.message).join(', ') });
  }

  const investor = createInvestorProfile(getDb(), business.id, parsed.data);
  createArtifact({
    businessId: business.id,
    department: 'operations',
    kind: 'marketplace_investor_brief',
    title: `Investor brief — ${investor.name}`,
    summary: `${investor.name}${investor.firm ? ` from ${investor.firm}` : ''} joined from the public site.`,
    content: renderInvestorBrief(investor, business.name),
    metadata: {
      investor_profile_id: investor.id,
      source: 'public_site'
    }
  });

  await logActivity(business.id, {
    type: 'lead',
    department: 'operations',
    title: `Public investor submission — ${investor.name}`,
    detail: {
      investor_profile_id: investor.id,
      source: 'public_site'
    }
  });

  await enqueueMarketplaceLifecycleWork({
    businessId: business.id,
    source: 'investor',
    investorId: investor.id
  });

  res.status(201).json({
    ok: true,
    message: 'Investor profile received.',
    investor: {
      id: investor.id,
      name: investor.name,
      firm: investor.firm
    }
  });
});

router.get('/:slug', (req, res) => serveBusinessSite(req, res, 'index.html'));
router.get('/:slug/*', (req, res) => serveBusinessSite(req, res, req.params[0] || 'index.html'));

function serveBusinessSite(req, res, pathValue) {
  const business = getSiteBusiness(req.params.slug);

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

function getSiteBusiness(slug) {
  const db = getDb();
  return db.prepare(`
    SELECT id, name, slug, type, description, target_customer, goal_90d, web_url, email_address, blueprint_key
    FROM businesses
    WHERE slug = ?
  `).get(slug);
}

export default router;
