import { v4 as uuid } from 'uuid';
import { getDb } from '../db/migrate.js';
import {
  DB_PATH,
  BRAVE_SEARCH_API_KEY,
  LINKEDIN_CLIENT_ID,
  LINKEDIN_CLIENT_SECRET,
  PLATFORM_DOMAIN,
  SMTP_HOST,
  STRIPE_SECRET_KEY,
  TWITTER_CLIENT_ID,
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
  inbox: 7,
  calendar: 8,
  accounting: 9
};

function parseJson(config, fallback = {}) {
  if (!config) return fallback;
  try {
    return JSON.parse(config);
  } catch {
    return fallback;
  }
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toStringArray(value) {
  return Array.isArray(value)
    ? value.map(item => cleanString(item)).filter(Boolean)
    : [];
}

function normaliseLinkedInOrganizations(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => ({
      organization: cleanString(item?.organization || item?.name),
      organization_urn: cleanString(item?.organization_urn || item?.organizationUrn || item?.urn),
      author_urn: cleanString(item?.author_urn || item?.authorUrn || item?.organization_urn || item?.organizationUrn || item?.urn),
      page_url: cleanString(item?.page_url || item?.pageUrl) || null
    }))
    .filter(item => item.organization_urn);
}

function maskToken(token) {
  const clean = cleanString(token);
  return clean ? clean.slice(-4) : null;
}

export function isMockStripeAccountId(accountId) {
  return !!accountId && String(accountId).startsWith('acct_mock_');
}

function deriveStripeStatus(config = {}) {
  if (config.mocked) return 'mocked';
  if (config.connected || config.onboarding_complete) return 'connected';
  if (config.account_id) return 'pending';
  return STRIPE_SECRET_KEY ? 'pending' : 'mocked';
}

function normaliseStripeConfig(config = {}, stripeAccountId = null) {
  const accountId = cleanString(config.account_id || stripeAccountId || '');
  const requirements = toStringArray(config.requirements || config.requirements_currently_due);
  const mocked = isMockStripeAccountId(accountId);
  const chargesEnabled = !!config.charges_enabled;
  const payoutsEnabled = !!config.payouts_enabled;
  const detailsSubmitted = !!config.details_submitted;
  const onboardingComplete = !!(config.onboarding_complete || (accountId && !mocked && chargesEnabled && payoutsEnabled && detailsSubmitted));
  const publicConfig = {
    account_id: accountId || null,
    connected: onboardingComplete,
    mocked,
    onboarding_complete: onboardingComplete,
    charges_enabled: chargesEnabled,
    payouts_enabled: payoutsEnabled,
    details_submitted: detailsSubmitted,
    requirements_due: Number(config.requirements_due ?? requirements.length ?? 0),
    requirements,
    dashboard_ready: !!(accountId && !mocked),
    country: cleanString(config.country) || null,
    default_currency: cleanString(config.default_currency || config.currency) || null,
    type: cleanString(config.type) || 'express'
  };

  return {
    config: publicConfig,
    status: deriveStripeStatus(publicConfig)
  };
}

function normaliseTwitterConfig(config = {}, secrets = {}) {
  const accessToken = cleanString(secrets.access_token || secrets.accessToken);
  const refreshToken = cleanString(secrets.refresh_token || secrets.refreshToken);
  const scopes = toStringArray(config.scopes);

  return {
    config: {
      connected: !!(config.connected || accessToken || config === true),
      publish_ready: !!accessToken,
      handle: cleanString(config.handle),
      profile_url: cleanString(config.profile_url || config.profileUrl) || null,
      account_label: cleanString(config.account_label || config.accountLabel) || null,
      account_id: cleanString(config.account_id || config.accountId) || null,
      profile_image_url: cleanString(config.profile_image_url || config.profileImageUrl) || null,
      username: cleanString(config.username) || null,
      connected_via: cleanString(config.connected_via || config.connectedVia) || (accessToken ? 'manual' : null),
      scopes,
      oauth_available: !!TWITTER_CLIENT_ID,
      token_last4: maskToken(accessToken),
      last_validated_at: cleanString(config.last_validated_at || config.lastValidatedAt) || null
    },
    secrets: {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: cleanString(secrets.expires_at || secrets.expiresAt) || null
    }
  };
}

function normaliseLinkedInConfig(config = {}, secrets = {}) {
  const accessToken = cleanString(secrets.access_token || secrets.accessToken);
  const refreshToken = cleanString(secrets.refresh_token || secrets.refreshToken);
  const organizations = normaliseLinkedInOrganizations(config.organizations);
  const organizationUrn = cleanString(config.organization_urn || config.organizationUrn) || null;

  return {
    config: {
      connected: !!(config.connected || accessToken || config === true),
      publish_ready: !!(accessToken && organizationUrn),
      organization: cleanString(config.organization || config.companyName) || null,
      organization_urn: organizationUrn,
      author_urn: cleanString(config.author_urn || config.authorUrn) || null,
      page_url: cleanString(config.page_url || config.pageUrl) || null,
      member_name: cleanString(config.member_name || config.memberName) || null,
      member_email: cleanString(config.member_email || config.memberEmail) || null,
      member_urn: cleanString(config.member_urn || config.memberUrn) || null,
      connected_via: cleanString(config.connected_via || config.connectedVia) || (accessToken ? 'manual' : null),
      scopes: toStringArray(config.scopes),
      organizations,
      oauth_available: !!(LINKEDIN_CLIENT_ID && LINKEDIN_CLIENT_SECRET),
      token_last4: maskToken(accessToken),
      last_validated_at: cleanString(config.last_validated_at || config.lastValidatedAt) || null
    },
    secrets: {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: cleanString(secrets.expires_at || secrets.expiresAt) || null
    }
  };
}

function normaliseSocialState(config = {}, secrets = {}) {
  const twitter = normaliseTwitterConfig(config.twitter || {}, secrets.twitter || {});
  const linkedin = normaliseLinkedInConfig(config.linkedin || {}, secrets.linkedin || {});
  const connectedProviders = ['twitter', 'linkedin'].filter(provider => (
    provider === 'twitter' ? twitter.config.connected : linkedin.config.connected
  ));

  return {
    config: {
      mode: 'per-business',
      default_platform: cleanString(config.default_platform || config.defaultPlatform) || 'both',
      connected_providers: connectedProviders,
      twitter: twitter.config,
      linkedin: linkedin.config
    },
    secrets: {
      twitter: twitter.secrets,
      linkedin: linkedin.secrets
    },
    status: connectedProviders.length ? 'connected' : 'pending'
  };
}

function buildIntegrationSpecs({ slug, emailAddress, webUrl, stripeAccountId = null }) {
  const stripe = normaliseStripeConfig({ account_id: stripeAccountId }, stripeAccountId);
  const social = normaliseSocialState();

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
      status: stripe.status,
      config: stripe.config,
      secrets: {}
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
      status: social.status,
      config: social.config,
      secrets: social.secrets
    },
    {
      kind: 'inbox',
      provider: 'preview-inbox',
      status: 'preview',
      config: {
        connected: false,
        inbox_address: emailAddress,
        support_aliases: [emailAddress].filter(Boolean),
        sync_mode: 'hourly',
        sync_interval_hours: 4,
        automation_enabled: true,
        preview: true
      }
    },
    {
      kind: 'calendar',
      provider: 'preview-calendar',
      status: 'preview',
      config: {
        connected: false,
        calendar_label: `${slug} founder calendar`,
        timezone: 'UTC',
        sync_mode: 'daily',
        sync_interval_hours: 12,
        automation_enabled: true,
        preview: true
      }
    },
    {
      kind: 'accounting',
      provider: 'preview-ledger',
      status: 'preview',
      config: {
        connected: false,
        account_label: `${slug} operating ledger`,
        currency: 'usd',
        sync_mode: 'derived',
        sync_interval_hours: 24,
        automation_enabled: true,
        preview: true
      }
    }
  ];
}

function mergeIntegrationSpec(spec, existing) {
  if (!existing) return spec;

  if (spec.kind === 'social') {
    const social = normaliseSocialState(existing.config, existing.secrets);
    return {
      ...spec,
      provider: existing.provider || spec.provider,
      status: social.status,
      config: social.config,
      secrets: social.secrets
    };
  }

  if (spec.kind === 'stripe') {
    const stripe = normaliseStripeConfig(
      {
        ...(existing.config || {}),
        ...(spec.config || {}),
        account_id: spec.config?.account_id || existing.config?.account_id || null
      },
      spec.config?.account_id || existing.config?.account_id || null
    );

    return {
      ...spec,
      provider: existing.provider || spec.provider,
      status: stripe.status,
      config: stripe.config,
      secrets: existing.secrets || {}
    };
  }

  return {
    ...spec,
    provider: spec.provider,
    status: spec.status,
    config: {
      ...(existing.config || {}),
      ...(spec.config || {})
    },
    secrets: existing.secrets || {}
  };
}

export function upsertIntegration({
  businessId,
  kind,
  provider,
  status,
  config = {},
  secrets = undefined,
  lastSyncAt = null
}) {
  const db = getDb();
  const existing = db.prepare(`
    SELECT id, secrets
    FROM integrations
    WHERE business_id = ? AND kind = ?
  `).get(businessId, kind);
  const payload = JSON.stringify(config || {});
  const secretsPayload = JSON.stringify(
    secrets === undefined ? parseJson(existing?.secrets, {}) : (secrets || {})
  );

  if (existing) {
    db.prepare(`
      UPDATE integrations
      SET provider = ?,
          status = ?,
          config = ?,
          secrets = ?,
          last_sync_at = ?,
          updated_at = datetime('now')
      WHERE business_id = ? AND kind = ?
    `).run(provider, status, payload, secretsPayload, lastSyncAt, businessId, kind);
    return existing.id;
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO integrations (id, business_id, kind, provider, status, config, secrets, last_sync_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(id, businessId, kind, provider, status, payload, secretsPayload, lastSyncAt);
  return id;
}

export function listIntegrations(businessId, { includeSecrets = false } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT id, kind, provider, status, config, secrets, last_sync_at, created_at, updated_at
    FROM integrations
    WHERE business_id = ?
  `).all(businessId)
    .map(row => {
      const parsed = {
        ...row,
        config: parseJson(row.config, {}),
        secrets: parseJson(row.secrets, {})
      };
      if (!includeSecrets) delete parsed.secrets;
      return parsed;
    })
    .sort((a, b) => (SORT_ORDER[a.kind] ?? 99) - (SORT_ORDER[b.kind] ?? 99));
}

export function getIntegration(businessId, kind, { includeSecrets = false } = {}) {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, kind, provider, status, config, secrets, last_sync_at, created_at, updated_at
    FROM integrations
    WHERE business_id = ? AND kind = ?
  `).get(businessId, kind);
  if (!row) return null;
  const parsed = {
    ...row,
    config: parseJson(row.config, {}),
    secrets: parseJson(row.secrets, {})
  };
  if (!includeSecrets) delete parsed.secrets;
  return parsed;
}

export function seedDefaultIntegrations({ businessId, slug, emailAddress, webUrl, stripeAccountId = null }) {
  const lastSyncAt = new Date().toISOString();
  const existingByKind = new Map(listIntegrations(businessId, { includeSecrets: true }).map(item => [item.kind, item]));

  for (const spec of buildIntegrationSpecs({ slug, emailAddress, webUrl, stripeAccountId })) {
    const merged = mergeIntegrationSpec(spec, existingByKind.get(spec.kind));
    upsertIntegration({ businessId, ...merged, lastSyncAt });
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

export function saveStripeIntegrationState({
  businessId,
  accountId = null,
  snapshot = null,
  provider = 'stripe',
  lastSyncAt = new Date().toISOString()
}) {
  const existing = getIntegration(businessId, 'stripe', { includeSecrets: true });
  const stripe = normaliseStripeConfig(
    {
      ...(existing?.config || {}),
      ...(snapshot || {}),
      account_id: accountId || existing?.config?.account_id || null
    },
    accountId || existing?.config?.account_id || null
  );

  upsertIntegration({
    businessId,
    kind: 'stripe',
    provider: existing?.provider || provider,
    status: snapshot?.status || stripe.status,
    config: stripe.config,
    secrets: existing?.secrets || {},
    lastSyncAt
  });

  return getIntegration(businessId, 'stripe');
}

export function getSocialProviderConnection(businessId, provider, { includeSecrets = false } = {}) {
  const integration = getIntegration(businessId, 'social', { includeSecrets: true });
  const social = normaliseSocialState(integration?.config || {}, integration?.secrets || {});
  const response = {
    provider,
    status: social.status,
    config: provider === 'twitter' ? social.config.twitter : social.config.linkedin
  };
  if (includeSecrets) {
    response.secrets = provider === 'twitter' ? social.secrets.twitter : social.secrets.linkedin;
  }
  return response;
}

export function saveSocialProviderConnection({ businessId, provider, updates = {} }) {
  const existing = getIntegration(businessId, 'social', { includeSecrets: true });
  const social = normaliseSocialState(existing?.config || {}, existing?.secrets || {});

  if (provider === 'twitter') {
    social.config.twitter = {
      ...social.config.twitter,
      handle: cleanString(updates.handle) || social.config.twitter.handle || null,
      profile_url: cleanString(updates.profileUrl || updates.profile_url) || social.config.twitter.profile_url || null,
      account_label: cleanString(updates.accountLabel || updates.account_label) || social.config.twitter.account_label || null,
      account_id: cleanString(updates.accountId || updates.account_id) || social.config.twitter.account_id || null,
      profile_image_url: cleanString(updates.profileImageUrl || updates.profile_image_url) || social.config.twitter.profile_image_url || null,
      username: cleanString(updates.username) || social.config.twitter.username || null,
      connected_via: cleanString(updates.connectedVia || updates.connected_via) || social.config.twitter.connected_via || null,
      scopes: toStringArray(updates.scopes).length ? toStringArray(updates.scopes) : social.config.twitter.scopes,
      oauth_available: !!TWITTER_CLIENT_ID,
      last_validated_at: new Date().toISOString()
    };
    social.secrets.twitter = {
      ...social.secrets.twitter,
      access_token: cleanString(updates.accessToken || updates.access_token) || social.secrets.twitter.access_token || '',
      refresh_token: cleanString(updates.refreshToken || updates.refresh_token) || social.secrets.twitter.refresh_token || '',
      expires_at: cleanString(updates.expiresAt || updates.expires_at) || social.secrets.twitter.expires_at || null
    };
    social.config.twitter.token_last4 = maskToken(social.secrets.twitter.access_token);
    social.config.twitter.connected = !!social.secrets.twitter.access_token;
    social.config.twitter.publish_ready = !!social.secrets.twitter.access_token;
  } else if (provider === 'linkedin') {
    const organizations = normaliseLinkedInOrganizations(updates.organizations);
    social.config.linkedin = {
      ...social.config.linkedin,
      organization: cleanString(updates.organization) || social.config.linkedin.organization || null,
      organization_urn: cleanString(updates.organizationUrn || updates.organization_urn) || social.config.linkedin.organization_urn || null,
      author_urn: cleanString(updates.authorUrn || updates.author_urn) || social.config.linkedin.author_urn || null,
      page_url: cleanString(updates.pageUrl || updates.page_url) || social.config.linkedin.page_url || null,
      member_name: cleanString(updates.memberName || updates.member_name) || social.config.linkedin.member_name || null,
      member_email: cleanString(updates.memberEmail || updates.member_email) || social.config.linkedin.member_email || null,
      member_urn: cleanString(updates.memberUrn || updates.member_urn) || social.config.linkedin.member_urn || null,
      connected_via: cleanString(updates.connectedVia || updates.connected_via) || social.config.linkedin.connected_via || null,
      scopes: toStringArray(updates.scopes).length ? toStringArray(updates.scopes) : social.config.linkedin.scopes,
      organizations: organizations.length ? organizations : social.config.linkedin.organizations,
      oauth_available: !!(LINKEDIN_CLIENT_ID && LINKEDIN_CLIENT_SECRET),
      last_validated_at: new Date().toISOString()
    };
    social.secrets.linkedin = {
      ...social.secrets.linkedin,
      access_token: cleanString(updates.accessToken || updates.access_token) || social.secrets.linkedin.access_token || '',
      refresh_token: cleanString(updates.refreshToken || updates.refresh_token) || social.secrets.linkedin.refresh_token || '',
      expires_at: cleanString(updates.expiresAt || updates.expires_at) || social.secrets.linkedin.expires_at || null
    };
    social.config.linkedin.token_last4 = maskToken(social.secrets.linkedin.access_token);
    social.config.linkedin.connected = !!social.secrets.linkedin.access_token;
    social.config.linkedin.publish_ready = !!(social.secrets.linkedin.access_token && social.config.linkedin.organization_urn);
  }

  social.config.connected_providers = ['twitter', 'linkedin'].filter(key => social.config[key].connected);
  social.status = social.config.connected_providers.length ? 'connected' : 'pending';

  upsertIntegration({
    businessId,
    kind: 'social',
    provider: existing?.provider || 'x-linkedin',
    status: social.status,
    config: social.config,
    secrets: social.secrets,
    lastSyncAt: new Date().toISOString()
  });

  return getIntegration(businessId, 'social');
}

export function disconnectSocialProviderConnection({ businessId, provider }) {
  const existing = getIntegration(businessId, 'social', { includeSecrets: true });
  const social = normaliseSocialState(existing?.config || {}, existing?.secrets || {});

  if (provider === 'twitter') {
    social.config.twitter = {
      connected: false,
      publish_ready: false,
      handle: null,
      profile_url: null,
      account_label: null,
      account_id: null,
      profile_image_url: null,
      username: null,
      connected_via: null,
      scopes: [],
      oauth_available: !!TWITTER_CLIENT_ID,
      token_last4: null,
      last_validated_at: new Date().toISOString()
    };
    social.secrets.twitter = {
      access_token: '',
      refresh_token: '',
      expires_at: null
    };
  } else if (provider === 'linkedin') {
    social.config.linkedin = {
      connected: false,
      publish_ready: false,
      organization: null,
      organization_urn: null,
      author_urn: null,
      page_url: null,
      member_name: null,
      member_email: null,
      member_urn: null,
      connected_via: null,
      scopes: [],
      organizations: [],
      oauth_available: !!(LINKEDIN_CLIENT_ID && LINKEDIN_CLIENT_SECRET),
      token_last4: null,
      last_validated_at: new Date().toISOString()
    };
    social.secrets.linkedin = {
      access_token: '',
      refresh_token: '',
      expires_at: null
    };
  }

  social.config.connected_providers = ['twitter', 'linkedin'].filter(key => social.config[key].connected);
  social.status = social.config.connected_providers.length ? 'connected' : 'pending';

  upsertIntegration({
    businessId,
    kind: 'social',
    provider: existing?.provider || 'x-linkedin',
    status: social.status,
    config: social.config,
    secrets: social.secrets,
    lastSyncAt: new Date().toISOString()
  });

  return getIntegration(businessId, 'social');
}
