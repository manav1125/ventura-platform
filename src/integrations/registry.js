import { v4 as uuid } from 'uuid';
import { getDb } from '../db/migrate.js';
import {
  DB_PATH,
  BRAVE_SEARCH_API_KEY,
  LINKEDIN_ACCESS_TOKEN,
  PLATFORM_DOMAIN,
  SMTP_HOST,
  STRIPE_SECRET_KEY,
  TWITTER_BEARER_TOKEN,
  VERCEL_TOKEN
} from '../config.js';

const SORT_ORDER = {
  database: 0,
  website: 1,
  email: 2,
  stripe: 3,
  analytics: 4,
  search: 5,
  social: 6,
  calendar: 7
};

function parseConfig(config) {
  if (!config) return {};
  try {
    return JSON.parse(config);
  } catch {
    return {};
  }
}

function buildIntegrationSpecs({ slug, emailAddress, webUrl, stripeAccountId = null }) {
  return [
    {
      kind: 'database',
      provider: 'sqlite',
      status: 'connected',
      config: { path: DB_PATH, namespace: `biz_${slug.replace(/-/g, '_')}` }
    },
    {
      kind: 'website',
      provider: VERCEL_TOKEN ? 'vercel' : 'ventura-static',
      status: 'connected',
      config: { url: webUrl, domain: `${slug}.${PLATFORM_DOMAIN}` }
    },
    {
      kind: 'email',
      provider: SMTP_HOST || 'ventura-mailbox',
      status: SMTP_HOST ? 'connected' : 'mocked',
      config: { address: emailAddress }
    },
    {
      kind: 'stripe',
      provider: 'stripe',
      status: STRIPE_SECRET_KEY ? (stripeAccountId ? 'connected' : 'pending') : 'mocked',
      config: stripeAccountId ? { account_id: stripeAccountId } : {}
    },
    {
      kind: 'analytics',
      provider: 'ventura-metrics',
      status: 'connected',
      config: { source: 'internal_metrics_pipeline' }
    },
    {
      kind: 'search',
      provider: 'brave',
      status: BRAVE_SEARCH_API_KEY ? 'connected' : 'pending',
      config: { live_research: !!BRAVE_SEARCH_API_KEY }
    },
    {
      kind: 'social',
      provider: 'x-linkedin',
      status: (TWITTER_BEARER_TOKEN || LINKEDIN_ACCESS_TOKEN) ? 'connected' : 'pending',
      config: {
        twitter: !!TWITTER_BEARER_TOKEN,
        linkedin: !!LINKEDIN_ACCESS_TOKEN
      }
    },
    {
      kind: 'calendar',
      provider: 'pending',
      status: 'pending',
      config: { note: 'Calendar MCP not wired yet' }
    }
  ];
}

export function upsertIntegration({ businessId, kind, provider, status, config = {}, lastSyncAt = null }) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM integrations WHERE business_id = ? AND kind = ?').get(businessId, kind);
  const payload = JSON.stringify(config);

  if (existing) {
    db.prepare(`
      UPDATE integrations
      SET provider = ?, status = ?, config = ?, last_sync_at = ?, created_at = created_at
      WHERE business_id = ? AND kind = ?
    `).run(provider, status, payload, lastSyncAt, businessId, kind);
    return existing.id;
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO integrations (id, business_id, kind, provider, status, config, last_sync_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, businessId, kind, provider, status, payload, lastSyncAt);
  return id;
}

export function listIntegrations(businessId) {
  const db = getDb();
  return db.prepare(`
    SELECT id, kind, provider, status, config, last_sync_at, created_at
    FROM integrations
    WHERE business_id = ?
  `).all(businessId)
    .map(row => ({ ...row, config: parseConfig(row.config) }))
    .sort((a, b) => (SORT_ORDER[a.kind] ?? 99) - (SORT_ORDER[b.kind] ?? 99));
}

export function seedDefaultIntegrations({ businessId, slug, emailAddress, webUrl, stripeAccountId = null }) {
  const lastSyncAt = new Date().toISOString();
  for (const spec of buildIntegrationSpecs({ slug, emailAddress, webUrl, stripeAccountId })) {
    upsertIntegration({ businessId, ...spec, lastSyncAt });
  }
}

export function syncBusinessIntegrations(business) {
  if (!business) return [];

  seedDefaultIntegrations({
    businessId: business.id,
    slug: business.slug,
    emailAddress: business.email_address,
    webUrl: business.web_url,
    stripeAccountId: business.stripe_account_id
  });

  return listIntegrations(business.id);
}
