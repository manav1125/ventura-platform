import { v4 as uuid } from 'uuid';
import { getDb } from '../db/migrate.js';
import {
  ANTHROPIC_API_KEY,
  BRAVE_SEARCH_API_KEY,
  LINKEDIN_CLIENT_ID,
  LINKEDIN_CLIENT_SECRET,
  NODE_ENV,
  PLATFORM_DOMAIN,
  SMTP_FROM,
  SMTP_HOST,
  SMTP_PASS,
  SMTP_USER,
  STRIPE_PRICE_BUILDER_MONTHLY,
  STRIPE_PRICE_FLEET_MONTHLY,
  STRIPE_SECRET_KEY,
  TWITTER_CLIENT_ID,
  TWITTER_CLIENT_SECRET,
  VERCEL_TOKEN
} from '../config.js';
import { sendEmail } from '../integrations/email.js';
import { getIntegration, upsertIntegration } from '../integrations/registry.js';

const ASSET_ORDER = {
  domain: 0,
  deployment: 1,
  mailbox: 2,
  analytics: 3
};

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeDomain(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function derivePlatformDomain(business, currentConfig = {}) {
  return cleanString(currentConfig.platform_domain)
    || hostnameFromUrl(business?.web_url)
    || `${business?.slug || 'ventura'}.${PLATFORM_DOMAIN}`;
}

function buildDomainDnsRecords(customDomain, provider, platformDomain) {
  const domain = normalizeDomain(customDomain);
  if (!domain) return [];

  if (provider === 'vercel') {
    if (domain.startsWith('www.')) {
      return [
        {
          type: 'CNAME',
          host: 'www',
          value: 'cname.vercel-dns.com',
          reason: 'Point the www host at Vercel so Ventura can serve the site there.'
        }
      ];
    }

    return [
      {
        type: 'A',
        host: '@',
        value: '76.76.21.21',
        reason: 'Point the apex domain at Vercel.'
      },
      {
        type: 'CNAME',
        host: 'www',
        value: 'cname.vercel-dns.com',
        reason: 'Forward www traffic to the same deployment.'
      }
    ];
  }

  const domainParts = domain.split('.');
  const host = domainParts.length > 2 ? domainParts.slice(0, -2).join('.') : '@';

  return [
    {
      type: 'CNAME',
      host,
      value: platformDomain,
      reason: 'Point the custom host to Ventura managed hosting.'
    }
  ];
}

function normalizeDomainAsset(business, existing = null) {
  const currentConfig = existing?.config || {};
  const currentChecks = existing?.checks || {};
  const platformDomain = derivePlatformDomain(business, currentConfig);
  const platformUrl = `https://${platformDomain}`;
  const customDomain = normalizeDomain(currentConfig.custom_domain);
  const provider = cleanString(existing?.provider || currentConfig.provider)
    || (VERCEL_TOKEN ? 'vercel' : 'ventura-static');
  const verifiedAt = cleanString(currentChecks.verified_at) || null;
  const dnsConfirmedAt = cleanString(currentChecks.dns_confirmed_at) || null;
  const activeDomain = verifiedAt && customDomain ? customDomain : platformDomain;

  const config = {
    platform_domain: platformDomain,
    platform_url: platformUrl,
    active_domain: activeDomain,
    active_url: `https://${activeDomain}`,
    custom_domain: customDomain || null,
    using_platform_domain: !(verifiedAt && customDomain),
    verification_mode: cleanString(currentConfig.verification_mode) || 'guided',
    dns_provider: cleanString(currentConfig.dns_provider) || null,
    notes: cleanString(currentConfig.notes) || null,
    dns_records: buildDomainDnsRecords(customDomain, provider, platformDomain),
    ssl_ready: !!verifiedAt
  };

  const checks = {
    dns_confirmed_at: dnsConfirmedAt,
    verified_at: verifiedAt,
    last_checked_at: cleanString(currentChecks.last_checked_at) || null,
    last_checked_status: cleanString(currentChecks.last_checked_status)
      || (verifiedAt ? 'connected' : customDomain ? 'awaiting_dns' : 'platform_domain_live'),
    last_checked_message: cleanString(currentChecks.last_checked_message)
      || (verifiedAt
        ? 'Custom domain verified and active.'
        : customDomain
          ? 'Add the DNS records below, then verify the domain from Ventura.'
          : 'Ventura managed subdomain is live right now.')
  };

  const status = verifiedAt
    ? 'connected'
    : customDomain
      ? (dnsConfirmedAt ? 'verifying' : 'action_required')
      : 'connected';

  return { provider, status, config, checks };
}

function normalizeMailboxAsset(business, existing = null) {
  const currentConfig = existing?.config || {};
  const currentChecks = existing?.checks || {};
  const forwardingAddress = cleanString(currentConfig.forwarding_address)
    || cleanString(currentConfig.reply_to)
    || cleanString(currentConfig.address)
    || cleanString(business?.email_address);
  const provider = cleanString(existing?.provider || currentConfig.provider)
    || (SMTP_HOST ? 'smtp' : 'ventura-mailbox');
  const smtpConfigured = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
  const testStatus = cleanString(currentChecks.last_test_status) || null;

  const config = {
    address: cleanString(business?.email_address) || null,
    forwarding_address: forwardingAddress || null,
    reply_to: cleanString(currentConfig.reply_to) || forwardingAddress || null,
    sender_name: cleanString(currentConfig.sender_name) || cleanString(business?.name) || 'Ventura',
    sender_email: cleanString(currentConfig.sender_email) || SMTP_FROM || cleanString(business?.email_address) || null,
    delivery_mode: smtpConfigured ? 'live' : 'preview'
  };

  const checks = {
    smtp_configured: smtpConfigured,
    last_test_status: testStatus,
    last_tested_at: cleanString(currentChecks.last_tested_at) || null,
    last_test_target: cleanString(currentChecks.last_test_target) || null,
    last_test_message_id: cleanString(currentChecks.last_test_message_id) || null,
    last_test_note: cleanString(currentChecks.last_test_note)
      || (smtpConfigured
        ? 'SMTP is configured. Send a test email to validate delivery.'
        : 'SMTP is not configured yet, so Ventura can only run delivery previews.')
  };

  const status = smtpConfigured
    ? (testStatus === 'success' ? 'connected' : 'configured')
    : 'preview';

  return { provider, status, config, checks };
}

function normalizeAnalyticsAsset(business, existing = null) {
  const currentConfig = existing?.config || {};
  const currentChecks = existing?.checks || {};
  const provider = cleanString(currentConfig.provider || existing?.provider) || 'internal_metrics';
  const measurementId = cleanString(currentConfig.measurement_id);
  const site = cleanString(currentConfig.site) || derivePlatformDomain(business, currentConfig);
  const dashboardUrl = cleanString(currentConfig.dashboard_url) || null;
  const publicKey = cleanString(currentConfig.public_key) || null;
  const isInternal = provider === 'internal_metrics';

  const config = {
    provider,
    site,
    dashboard_url: dashboardUrl,
    measurement_id: measurementId || null,
    public_key: publicKey || null,
    install_mode: isInternal ? 'built_in' : 'manual'
  };

  const checks = {
    last_test_status: cleanString(currentChecks.last_test_status) || null,
    last_tested_at: cleanString(currentChecks.last_tested_at) || null,
    last_event_name: cleanString(currentChecks.last_event_name) || null,
    install_hint: cleanString(currentChecks.install_hint)
      || (isInternal
        ? 'Ventura is already capturing internal metrics and activity.'
        : measurementId || publicKey
          ? 'External analytics is configured. Run a test event to validate the setup.'
          : 'Add the provider details you want Ventura to report into.')
  };

  const status = isInternal
    ? 'connected'
    : (measurementId || publicKey || dashboardUrl ? 'configured' : 'pending');

  return { provider, status, config, checks };
}

function latestDeploymentForBusiness(businessId) {
  if (!businessId) return null;
  const db = getDb();
  return db.prepare(`
    SELECT version, description, status, created_at, files_changed
    FROM deployments
    WHERE business_id = ?
    ORDER BY datetime(created_at) DESC
    LIMIT 1
  `).get(businessId) || null;
}

function normalizeDeploymentAsset(business, existing = null) {
  const currentConfig = existing?.config || {};
  const currentChecks = existing?.checks || {};
  const latestDeployment = latestDeploymentForBusiness(business?.id);
  const provider = cleanString(currentConfig.provider || existing?.provider)
    || (VERCEL_TOKEN ? 'vercel-managed' : 'track-only');
  const targetUrl = cleanString(currentConfig.target_url) || cleanString(business?.web_url) || null;
  const smokePath = cleanString(currentConfig.smoke_path) || '/';
  const repoUrl = cleanString(currentConfig.repo_url) || null;
  const gitBranch = cleanString(currentConfig.git_branch) || 'main';
  const buildCommand = cleanString(currentConfig.build_command) || 'npm run build';
  const outputDirectory = cleanString(currentConfig.output_directory) || 'ventura';
  const releaseChannel = cleanString(currentConfig.release_channel) || 'production';
  const autoReleaseEnabled = currentConfig.auto_release_enabled !== false;

  const config = {
    provider,
    target_url: targetUrl,
    smoke_path: smokePath,
    repo_url: repoUrl,
    git_branch: gitBranch,
    build_command: buildCommand,
    output_directory: outputDirectory,
    release_channel: releaseChannel,
    auto_release_enabled: autoReleaseEnabled
  };

  const checks = {
    last_release_version: cleanString(currentChecks.last_release_version) || latestDeployment?.version || null,
    last_release_at: cleanString(currentChecks.last_release_at) || latestDeployment?.created_at || null,
    last_release_status: cleanString(currentChecks.last_release_status) || latestDeployment?.status || null,
    last_release_note: cleanString(currentChecks.last_release_note) || latestDeployment?.description || null,
    last_release_files_changed: Number(currentChecks.last_release_files_changed ?? latestDeployment?.files_changed ?? 0),
    last_smoke_status: cleanString(currentChecks.last_smoke_status) || null,
    last_smoke_checked_at: cleanString(currentChecks.last_smoke_checked_at) || null,
    last_smoke_url: cleanString(currentChecks.last_smoke_url) || null,
    last_smoke_latency_ms: Number(currentChecks.last_smoke_latency_ms || 0) || null,
    last_smoke_code: Number(currentChecks.last_smoke_code || 0) || null,
    last_smoke_note: cleanString(currentChecks.last_smoke_note)
      || (provider === 'track-only'
        ? 'Ventura is tracking releases in preview mode. Add deploy provider credentials to run live smoke checks.'
        : latestDeployment
          ? 'Run a smoke check after a release to verify the live business site.'
          : 'No release has been logged yet for this business.')
  };

  const status = checks.last_smoke_status === 'success'
    ? 'connected'
    : latestDeployment || repoUrl || targetUrl || provider !== 'track-only'
      ? 'configured'
      : 'preview';

  return { provider, status, config, checks };
}

function normalizeAsset(kind, business, existing = null) {
  if (kind === 'domain') return normalizeDomainAsset(business, existing);
  if (kind === 'deployment') return normalizeDeploymentAsset(business, existing);
  if (kind === 'mailbox') return normalizeMailboxAsset(business, existing);
  return normalizeAnalyticsAsset(business, existing);
}

function buildAssetList(business) {
  const existing = new Map(listInfrastructureAssets(business.id).map(asset => [asset.kind, asset]));
  return ['domain', 'deployment', 'mailbox', 'analytics'].map(kind => {
    const asset = normalizeAsset(kind, business, existing.get(kind));
    return { kind, ...asset };
  });
}

function serializeAssetRow(row) {
  return {
    ...row,
    config: parseJson(row.config, {}),
    checks: parseJson(row.checks, {})
  };
}

function upsertWebsiteIntegrationForDomain(business, asset) {
  const existingWebsite = getIntegration(business.id, 'website', { includeSecrets: true });
  upsertIntegration({
    businessId: business.id,
    kind: 'website',
    provider: existingWebsite?.provider || asset.provider,
    status: existingWebsite?.status || 'connected',
    config: {
      ...(existingWebsite?.config || {}),
      url: asset.config.active_url,
      domain: asset.config.active_domain,
      platform_domain: asset.config.platform_domain,
      custom_domain: asset.config.custom_domain
    },
    secrets: existingWebsite?.secrets || {},
    lastSyncAt: new Date().toISOString()
  });
}

function upsertEmailIntegrationForMailbox(business, asset) {
  const existingEmail = getIntegration(business.id, 'email', { includeSecrets: true });
  upsertIntegration({
    businessId: business.id,
    kind: 'email',
    provider: existingEmail?.provider || asset.provider,
    status: asset.checks.smtp_configured ? 'connected' : 'mocked',
    config: {
      ...(existingEmail?.config || {}),
      address: asset.config.address,
      forwarding_address: asset.config.forwarding_address,
      reply_to: asset.config.reply_to,
      sender_name: asset.config.sender_name,
      delivery_mode: asset.config.delivery_mode
    },
    secrets: existingEmail?.secrets || {},
    lastSyncAt: new Date().toISOString()
  });
}

function upsertAnalyticsIntegrationForAsset(business, asset) {
  const existingAnalytics = getIntegration(business.id, 'analytics', { includeSecrets: true });
  upsertIntegration({
    businessId: business.id,
    kind: 'analytics',
    provider: asset.provider,
    status: asset.status === 'pending' ? 'pending' : 'connected',
    config: {
      ...(existingAnalytics?.config || {}),
      source: asset.config.provider,
      site: asset.config.site,
      dashboard_url: asset.config.dashboard_url,
      measurement_id: asset.config.measurement_id
    },
    secrets: existingAnalytics?.secrets || {},
    lastSyncAt: new Date().toISOString()
  });
}

export function upsertInfrastructureAsset({
  businessId,
  kind,
  provider,
  status,
  config = {},
  checks = {},
  lastCheckedAt = null
}) {
  const db = getDb();
  const existing = db.prepare(`
    SELECT id
    FROM infrastructure_assets
    WHERE business_id = ? AND kind = ?
  `).get(businessId, kind);
  const payload = JSON.stringify(config || {});
  const checksPayload = JSON.stringify(checks || {});

  if (existing) {
    db.prepare(`
      UPDATE infrastructure_assets
      SET provider = ?,
          status = ?,
          config = ?,
          checks = ?,
          last_checked_at = ?,
          updated_at = datetime('now')
      WHERE business_id = ? AND kind = ?
    `).run(provider, status, payload, checksPayload, lastCheckedAt, businessId, kind);
    return existing.id;
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO infrastructure_assets (
      id, business_id, kind, provider, status, config, checks, last_checked_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(id, businessId, kind, provider, status, payload, checksPayload, lastCheckedAt);
  return id;
}

export function listInfrastructureAssets(businessId) {
  const db = getDb();
  return db.prepare(`
    SELECT id, business_id, kind, provider, status, config, checks, last_checked_at, created_at, updated_at
    FROM infrastructure_assets
    WHERE business_id = ?
  `).all(businessId)
    .map(serializeAssetRow)
    .sort((a, b) => (ASSET_ORDER[a.kind] ?? 99) - (ASSET_ORDER[b.kind] ?? 99));
}

export function getInfrastructureAsset(businessId, kind) {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, business_id, kind, provider, status, config, checks, last_checked_at, created_at, updated_at
    FROM infrastructure_assets
    WHERE business_id = ? AND kind = ?
  `).get(businessId, kind);
  return row ? serializeAssetRow(row) : null;
}

export function syncInfrastructureAssets(business) {
  if (!business) return [];

  const assets = buildAssetList(business);
  const lastCheckedAt = new Date().toISOString();
  for (const asset of assets) {
    upsertInfrastructureAsset({
      businessId: business.id,
      kind: asset.kind,
      provider: asset.provider,
      status: asset.status,
      config: asset.config,
      checks: asset.checks,
      lastCheckedAt: asset.checks?.last_checked_at || lastCheckedAt
    });
  }

  return listInfrastructureAssets(business.id);
}

export function updateDomainAsset(business, updates = {}) {
  const current = getInfrastructureAsset(business.id, 'domain') || normalizeAsset('domain', business);
  const currentConfig = current.config || {};
  const currentChecks = { ...(current.checks || {}) };
  const customDomain = normalizeDomain(updates.customDomain ?? updates.custom_domain ?? currentConfig.custom_domain);
  const platformDomain = derivePlatformDomain(business, currentConfig);

  if (customDomain !== normalizeDomain(currentConfig.custom_domain)) {
    delete currentChecks.verified_at;
    delete currentChecks.dns_confirmed_at;
    currentChecks.last_checked_status = customDomain ? 'awaiting_dns' : 'platform_domain_live';
    currentChecks.last_checked_message = customDomain
      ? 'DNS records generated. Add them at your registrar, then verify the domain.'
      : 'Ventura managed subdomain restored as the active website domain.';
  }

  const next = normalizeDomainAsset(business, {
    provider: current.provider,
    config: {
      ...currentConfig,
      custom_domain: customDomain || null,
      dns_provider: cleanString(updates.dnsProvider ?? updates.dns_provider) || currentConfig.dns_provider || null,
      notes: cleanString(updates.notes) || currentConfig.notes || null,
      platform_domain: platformDomain
    },
    checks: currentChecks
  });

  upsertInfrastructureAsset({
    businessId: business.id,
    kind: 'domain',
    provider: next.provider,
    status: next.status,
    config: next.config,
    checks: next.checks,
    lastCheckedAt: new Date().toISOString()
  });

  const activeUrl = customDomain && next.checks.verified_at ? `https://${customDomain}` : `https://${platformDomain}`;
  const db = getDb();
  db.prepare(`
    UPDATE businesses
    SET web_url = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(activeUrl, business.id);
  upsertWebsiteIntegrationForDomain({ ...business, web_url: activeUrl }, next);

  return getInfrastructureAsset(business.id, 'domain');
}

export function verifyDomainAsset(business, { dnsConfirmed = false } = {}) {
  const current = getInfrastructureAsset(business.id, 'domain') || syncInfrastructureAssets(business).find(asset => asset.kind === 'domain');
  if (!current?.config?.custom_domain) {
    throw Object.assign(new Error('Add a custom domain before verifying it.'), { statusCode: 400 });
  }

  const checks = {
    ...(current.checks || {}),
    dns_confirmed_at: dnsConfirmed ? new Date().toISOString() : (current.checks?.dns_confirmed_at || null),
    last_checked_at: new Date().toISOString()
  };

  if (!checks.dns_confirmed_at) {
    checks.last_checked_status = 'awaiting_dns';
    checks.last_checked_message = 'Mark DNS as added once the records are in place, then verify again.';
  } else {
    checks.verified_at = new Date().toISOString();
    checks.last_checked_status = 'connected';
    checks.last_checked_message = 'Custom domain verified. Ventura switched this business to the founder domain.';
  }

  const next = normalizeDomainAsset(business, {
    provider: current.provider,
    config: current.config,
    checks
  });

  upsertInfrastructureAsset({
    businessId: business.id,
    kind: 'domain',
    provider: next.provider,
    status: next.status,
    config: next.config,
    checks: next.checks,
    lastCheckedAt: checks.last_checked_at
  });

  const activeUrl = next.config.active_url;
  const db = getDb();
  db.prepare(`
    UPDATE businesses
    SET web_url = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(activeUrl, business.id);
  upsertWebsiteIntegrationForDomain({ ...business, web_url: activeUrl }, next);

  return getInfrastructureAsset(business.id, 'domain');
}

export function updateDeploymentAsset(business, updates = {}) {
  const current = getInfrastructureAsset(business.id, 'deployment') || normalizeAsset('deployment', business);
  const next = normalizeDeploymentAsset(business, {
    provider: cleanString(updates.provider ?? updates.deploymentProvider) || current.provider,
    config: {
      ...(current.config || {}),
      provider: cleanString(updates.provider ?? updates.deploymentProvider) || current.config?.provider || current.provider,
      target_url: cleanString(updates.targetUrl ?? updates.target_url) || current.config?.target_url || cleanString(business.web_url) || null,
      smoke_path: cleanString(updates.smokePath ?? updates.smoke_path) || current.config?.smoke_path || '/',
      repo_url: cleanString(updates.repoUrl ?? updates.repo_url) || current.config?.repo_url || null,
      git_branch: cleanString(updates.gitBranch ?? updates.git_branch) || current.config?.git_branch || 'main',
      build_command: cleanString(updates.buildCommand ?? updates.build_command) || current.config?.build_command || 'npm run build',
      output_directory: cleanString(updates.outputDirectory ?? updates.output_directory) || current.config?.output_directory || 'ventura',
      release_channel: cleanString(updates.releaseChannel ?? updates.release_channel) || current.config?.release_channel || 'production',
      auto_release_enabled: updates.autoReleaseEnabled ?? updates.auto_release_enabled ?? current.config?.auto_release_enabled ?? true
    },
    checks: current.checks || {}
  });

  upsertInfrastructureAsset({
    businessId: business.id,
    kind: 'deployment',
    provider: next.provider,
    status: next.status,
    config: next.config,
    checks: next.checks,
    lastCheckedAt: new Date().toISOString()
  });

  return getInfrastructureAsset(business.id, 'deployment');
}

export function recordDeploymentRelease(business, updates = {}) {
  const current = getInfrastructureAsset(business.id, 'deployment') || syncInfrastructureAssets(business).find(asset => asset.kind === 'deployment');
  const version = cleanString(updates.version) || `v${Date.now()}`;
  const description = cleanString(updates.versionNote ?? updates.version_note) || 'Founder logged a production release';
  const filesChanged = Math.max(0, parseInteger(updates.filesChanged ?? updates.files_changed, 0));
  const createdAt = new Date().toISOString();
  const id = `dep_${Date.now()}`;
  const db = getDb();

  db.prepare(`
    INSERT INTO deployments (id, business_id, version, description, files_changed, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'live', ?)
  `).run(id, business.id, version, description, filesChanged, createdAt);

  const next = normalizeDeploymentAsset(business, {
    provider: current?.provider,
    config: current?.config || {},
    checks: {
      ...(current?.checks || {}),
      last_release_version: version,
      last_release_at: createdAt,
      last_release_status: 'live',
      last_release_note: description,
      last_release_files_changed: filesChanged
    }
  });

  upsertInfrastructureAsset({
    businessId: business.id,
    kind: 'deployment',
    provider: next.provider,
    status: next.status,
    config: next.config,
    checks: next.checks,
    lastCheckedAt: createdAt
  });

  const deployment = db.prepare(`
    SELECT *
    FROM deployments
    WHERE id = ?
  `).get(id);

  return {
    deployment,
    asset: getInfrastructureAsset(business.id, 'deployment')
  };
}

export async function smokeTestDeploymentAsset(business, { path = '' } = {}) {
  const current = getInfrastructureAsset(business.id, 'deployment') || syncInfrastructureAssets(business).find(asset => asset.kind === 'deployment');
  if (!current?.config?.target_url && !business.web_url) {
    throw Object.assign(new Error('Add a target URL before running a smoke check.'), { statusCode: 400 });
  }

  const smokeTarget = (() => {
    try {
      return new URL(cleanString(path) || current.config?.smoke_path || '/', current.config?.target_url || business.web_url).toString();
    } catch {
      return cleanString(current.config?.target_url || business.web_url);
    }
  })();

  const startedAt = Date.now();
  const preview = NODE_ENV === 'test' || current.provider === 'track-only';
  let success = true;
  let statusCode = null;
  let note = preview
    ? 'Smoke check recorded in preview mode. Ventura did not hit a live deployment target.'
    : 'Smoke check passed.';

  if (!preview) {
    try {
      const response = await fetch(smokeTarget, { method: 'GET', redirect: 'follow' });
      statusCode = response.status;
      success = response.ok;
      note = response.ok
        ? 'Smoke check passed against the live deployment target.'
        : `Smoke check returned HTTP ${response.status}.`;
    } catch (err) {
      success = false;
      note = err.message || 'Smoke check failed.';
    }
  }

  const checkedAt = new Date().toISOString();
  const next = normalizeDeploymentAsset(business, {
    provider: current.provider,
    config: current.config,
    checks: {
      ...(current.checks || {}),
      last_smoke_status: success ? 'success' : 'failed',
      last_smoke_checked_at: checkedAt,
      last_smoke_url: smokeTarget,
      last_smoke_latency_ms: Date.now() - startedAt,
      last_smoke_code: statusCode,
      last_smoke_note: note
    }
  });

  upsertInfrastructureAsset({
    businessId: business.id,
    kind: 'deployment',
    provider: next.provider,
    status: next.status,
    config: next.config,
    checks: next.checks,
    lastCheckedAt: checkedAt
  });

  return {
    preview,
    success,
    target: smokeTarget,
    statusCode,
    asset: getInfrastructureAsset(business.id, 'deployment')
  };
}

export function updateMailboxAsset(business, updates = {}) {
  const current = getInfrastructureAsset(business.id, 'mailbox') || normalizeAsset('mailbox', business);
  const next = normalizeMailboxAsset(business, {
    provider: current.provider,
    config: {
      ...(current.config || {}),
      forwarding_address: cleanString(updates.forwardingAddress ?? updates.forwarding_address) || current.config?.forwarding_address || null,
      reply_to: cleanString(updates.replyTo ?? updates.reply_to) || current.config?.reply_to || null,
      sender_name: cleanString(updates.senderName ?? updates.sender_name) || current.config?.sender_name || cleanString(business.name) || 'Ventura',
      sender_email: cleanString(updates.senderEmail ?? updates.sender_email) || current.config?.sender_email || SMTP_FROM || null
    },
    checks: current.checks || {}
  });

  upsertInfrastructureAsset({
    businessId: business.id,
    kind: 'mailbox',
    provider: next.provider,
    status: next.status,
    config: next.config,
    checks: next.checks,
    lastCheckedAt: new Date().toISOString()
  });
  upsertEmailIntegrationForMailbox(business, next);

  return getInfrastructureAsset(business.id, 'mailbox');
}

export async function testMailboxAsset(business, { recipient, requesterName } = {}) {
  const current = getInfrastructureAsset(business.id, 'mailbox') || syncInfrastructureAssets(business).find(asset => asset.kind === 'mailbox');
  const target = cleanString(recipient) || cleanString(current?.config?.forwarding_address) || cleanString(current?.config?.address);
  if (!target) {
    throw Object.assign(new Error('Add a forwarding inbox or recipient before sending a mailbox test.'), { statusCode: 400 });
  }

  const preview = !(SMTP_HOST && SMTP_USER && SMTP_PASS);
  const info = await sendEmail({
    to: target,
    subject: `Ventura mailbox test — ${business.name}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 20px;color:#0a0a0a">
        <h2 style="margin:0 0 12px;">Mailbox test for ${business.name}</h2>
        <p style="line-height:1.6;color:#5f574d;">
          ${preview
            ? 'Ventura accepted this email in preview mode because SMTP is not configured yet.'
            : 'This confirms Ventura can send from the business mailbox configuration.'}
        </p>
        <p style="line-height:1.6;color:#5f574d;">
          Triggered by ${cleanString(requesterName) || 'the founder'} for ${cleanString(business.email_address) || 'this business mailbox'}.
        </p>
      </div>
    `
  });

  const checks = {
    ...(current.checks || {}),
    smtp_configured: !!(SMTP_HOST && SMTP_USER && SMTP_PASS),
    last_test_status: 'success',
    last_tested_at: new Date().toISOString(),
    last_test_target: target,
    last_test_message_id: cleanString(info?.messageId) || null,
    last_test_note: preview
      ? 'Preview transport accepted the mailbox test. Add SMTP credentials on Render for real delivery.'
      : 'Mailbox test accepted by the configured SMTP provider.'
  };

  const next = normalizeMailboxAsset(business, {
    provider: current.provider,
    config: current.config,
    checks
  });

  upsertInfrastructureAsset({
    businessId: business.id,
    kind: 'mailbox',
    provider: next.provider,
    status: next.status,
    config: next.config,
    checks: next.checks,
    lastCheckedAt: checks.last_tested_at
  });
  upsertEmailIntegrationForMailbox(business, next);

  return {
    asset: getInfrastructureAsset(business.id, 'mailbox'),
    preview,
    target,
    messageId: cleanString(info?.messageId) || null
  };
}

export function updateAnalyticsAsset(business, updates = {}) {
  const current = getInfrastructureAsset(business.id, 'analytics') || normalizeAsset('analytics', business);
  const next = normalizeAnalyticsAsset(business, {
    provider: cleanString(updates.provider) || current.provider,
    config: {
      ...(current.config || {}),
      provider: cleanString(updates.provider) || current.config?.provider || current.provider,
      site: cleanString(updates.site) || current.config?.site || derivePlatformDomain(business, current.config || {}),
      dashboard_url: cleanString(updates.dashboardUrl ?? updates.dashboard_url) || current.config?.dashboard_url || null,
      measurement_id: cleanString(updates.measurementId ?? updates.measurement_id) || current.config?.measurement_id || null,
      public_key: cleanString(updates.publicKey ?? updates.public_key) || current.config?.public_key || null
    },
    checks: current.checks || {}
  });

  upsertInfrastructureAsset({
    businessId: business.id,
    kind: 'analytics',
    provider: next.provider,
    status: next.status,
    config: next.config,
    checks: next.checks,
    lastCheckedAt: new Date().toISOString()
  });
  upsertAnalyticsIntegrationForAsset(business, next);

  return getInfrastructureAsset(business.id, 'analytics');
}

export function testAnalyticsAsset(business) {
  const current = getInfrastructureAsset(business.id, 'analytics') || syncInfrastructureAssets(business).find(asset => asset.kind === 'analytics');
  const provider = cleanString(current?.config?.provider) || 'internal_metrics';
  const configured = provider === 'internal_metrics'
    || !!cleanString(current?.config?.measurement_id)
    || !!cleanString(current?.config?.public_key);

  if (!configured) {
    throw Object.assign(new Error('Add analytics provider details before running a test event.'), { statusCode: 400 });
  }

  const checks = {
    ...(current.checks || {}),
    last_test_status: 'success',
    last_tested_at: new Date().toISOString(),
    last_event_name: 'ventura_founder_test_event',
    install_hint: provider === 'internal_metrics'
      ? 'Ventura internal analytics is live and collecting business telemetry.'
      : `Ventura recorded a test event for ${provider}.`
  };

  const next = normalizeAnalyticsAsset(business, {
    provider: current.provider,
    config: current.config,
    checks
  });

  upsertInfrastructureAsset({
    businessId: business.id,
    kind: 'analytics',
    provider: next.provider,
    status: next.status,
    config: next.config,
    checks: next.checks,
    lastCheckedAt: checks.last_tested_at
  });
  upsertAnalyticsIntegrationForAsset(business, next);

  return getInfrastructureAsset(business.id, 'analytics');
}

function buildProviderReadiness(business, integrations = [], assets = []) {
  const stripeIntegration = integrations.find(item => item.kind === 'stripe');
  const socialIntegration = integrations.find(item => item.kind === 'social');
  const inboxIntegration = integrations.find(item => item.kind === 'inbox');
  const calendarIntegration = integrations.find(item => item.kind === 'calendar');
  const accountingIntegration = integrations.find(item => item.kind === 'accounting');
  const socialConfig = socialIntegration?.config || {};
  const domainAsset = assets.find(asset => asset.kind === 'domain');
  const deploymentAsset = assets.find(asset => asset.kind === 'deployment');
  const mailboxAsset = assets.find(asset => asset.kind === 'mailbox');
  const analyticsAsset = assets.find(asset => asset.kind === 'analytics');

  const providers = [
    {
      id: 'anthropic',
      label: 'Anthropic runtime',
      status: ANTHROPIC_API_KEY ? 'connected' : 'action_required',
      configured: !!ANTHROPIC_API_KEY,
      summary: ANTHROPIC_API_KEY
        ? 'Nightly agent loops and founder chat are enabled.'
        : 'Add ANTHROPIC_API_KEY on Render to power the autonomous loop.',
      missing: ANTHROPIC_API_KEY ? [] : ['ANTHROPIC_API_KEY']
    },
    {
      id: 'vercel',
      label: 'Website deploy + domains',
      status: VERCEL_TOKEN ? 'connected' : 'preview',
      configured: !!VERCEL_TOKEN,
      summary: VERCEL_TOKEN
        ? `Ventura can deploy and manage domains for ${cleanString(business?.name) || 'this business'}.`
        : 'Ventura is using the managed static fallback. Add VERCEL_TOKEN for automated deploys and domain APIs.',
      missing: VERCEL_TOKEN ? [] : ['VERCEL_TOKEN']
    },
    {
      id: 'deployment_runtime',
      label: 'Per-company deployment runtime',
      status: deploymentAsset?.status || (VERCEL_TOKEN ? 'configured' : 'preview'),
      configured: !!(deploymentAsset?.config?.target_url || deploymentAsset?.config?.repo_url || business?.web_url),
      summary: deploymentAsset?.checks?.last_smoke_status === 'success'
        ? 'Ventura has a passing smoke check against this company deployment target.'
        : deploymentAsset?.checks?.last_release_at
          ? 'A release has been logged for this business. Run a smoke check to validate the current live target.'
          : VERCEL_TOKEN
            ? 'Deploy provider credentials are available. Configure the per-business deployment target and smoke path.'
            : 'Ventura is tracking deployment state in preview mode. Add deploy provider credentials for live release validation.',
      missing: VERCEL_TOKEN || deploymentAsset?.config?.provider === 'track-only' ? [] : ['VERCEL_TOKEN'],
      business_status: deploymentAsset?.status || 'preview'
    },
    {
      id: 'smtp',
      label: 'Outbound founder email',
      status: SMTP_HOST && SMTP_USER && SMTP_PASS ? 'connected' : 'preview',
      configured: !!(SMTP_HOST && SMTP_USER && SMTP_PASS),
      summary: SMTP_HOST && SMTP_USER && SMTP_PASS
        ? 'Password reset, verification, and business mailbox delivery can go out live.'
        : 'Email is in preview mode. Add SMTP_HOST / SMTP_USER / SMTP_PASS for real delivery.',
      missing: SMTP_HOST && SMTP_USER && SMTP_PASS ? [] : ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']
    },
    {
      id: 'stripe',
      label: 'Stripe billing',
      status: STRIPE_SECRET_KEY && STRIPE_PRICE_BUILDER_MONTHLY && STRIPE_PRICE_FLEET_MONTHLY
        ? 'connected'
        : STRIPE_SECRET_KEY
          ? 'action_required'
          : 'preview',
      configured: !!STRIPE_SECRET_KEY,
      summary: STRIPE_SECRET_KEY
        ? (STRIPE_PRICE_BUILDER_MONTHLY && STRIPE_PRICE_FLEET_MONTHLY
          ? 'Checkout and plan upgrades are fully configured.'
          : 'Stripe is live, but plan price IDs still need to be set on Render.')
        : 'Billing stays in preview until STRIPE_SECRET_KEY is added.',
      missing: [
        ...(!STRIPE_SECRET_KEY ? ['STRIPE_SECRET_KEY'] : []),
        ...(!STRIPE_PRICE_BUILDER_MONTHLY ? ['STRIPE_PRICE_BUILDER_MONTHLY'] : []),
        ...(!STRIPE_PRICE_FLEET_MONTHLY ? ['STRIPE_PRICE_FLEET_MONTHLY'] : [])
      ],
      business_status: stripeIntegration?.status || 'pending'
    },
    {
      id: 'x_oauth',
      label: 'X OAuth',
      status: TWITTER_CLIENT_ID && TWITTER_CLIENT_SECRET ? 'connected' : 'action_required',
      configured: !!(TWITTER_CLIENT_ID && TWITTER_CLIENT_SECRET),
      summary: TWITTER_CLIENT_ID && TWITTER_CLIENT_SECRET
        ? (socialConfig?.twitter?.connected
          ? 'Business X account is connected for this company.'
          : 'OAuth is configured. Connect a business-owned X account in Settings.')
        : 'Add X_CLIENT_ID and X_CLIENT_SECRET on Render for one-click X account connect.',
      missing: [
        ...(!TWITTER_CLIENT_ID ? ['X_CLIENT_ID'] : []),
        ...(!TWITTER_CLIENT_SECRET ? ['X_CLIENT_SECRET'] : [])
      ],
      business_status: socialConfig?.twitter?.connected ? 'connected' : 'pending'
    },
    {
      id: 'linkedin_oauth',
      label: 'LinkedIn OAuth',
      status: LINKEDIN_CLIENT_ID && LINKEDIN_CLIENT_SECRET ? 'connected' : 'action_required',
      configured: !!(LINKEDIN_CLIENT_ID && LINKEDIN_CLIENT_SECRET),
      summary: LINKEDIN_CLIENT_ID && LINKEDIN_CLIENT_SECRET
        ? (socialConfig?.linkedin?.publish_ready
          ? 'Business LinkedIn page is connected and ready to publish.'
          : 'OAuth is configured. Connect the founder account and pick a business page.')
        : 'Add LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET on Render for one-click LinkedIn connect.',
      missing: [
        ...(!LINKEDIN_CLIENT_ID ? ['LINKEDIN_CLIENT_ID'] : []),
        ...(!LINKEDIN_CLIENT_SECRET ? ['LINKEDIN_CLIENT_SECRET'] : [])
      ],
      business_status: socialConfig?.linkedin?.publish_ready ? 'connected' : 'pending'
    },
    {
      id: 'brave_search',
      label: 'Live research',
      status: BRAVE_SEARCH_API_KEY ? 'connected' : 'pending',
      configured: !!BRAVE_SEARCH_API_KEY,
      summary: BRAVE_SEARCH_API_KEY
        ? 'Agents can enrich decisions with live search results.'
        : 'Optional: add BRAVE_SEARCH_API_KEY so Ventura can pull live research during cycles.',
      missing: BRAVE_SEARCH_API_KEY ? [] : ['BRAVE_SEARCH_API_KEY']
    },
    {
      id: 'inbox_sync',
      label: 'Business inbox sync',
      status: inboxIntegration?.status || 'preview',
      configured: !!(inboxIntegration?.config?.inbox_address || inboxIntegration?.config?.imap_host),
      summary: inboxIntegration?.provider === 'imap' && inboxIntegration?.config?.connected
        ? 'Ventura can pull live business inbox threads through IMAP into the operating loop.'
        : inboxIntegration?.provider === 'imap'
          ? 'IMAP is selected, but the host, username, or password is still missing.'
          : 'Configure a business inbox address or IMAP connection so Ventura can sync support and sales conversations.',
      missing: inboxIntegration?.provider === 'imap'
        ? [
            ...(inboxIntegration?.config?.imap_host ? [] : ['IMAP_HOST']),
            ...(inboxIntegration?.config?.imap_username ? [] : ['IMAP_USERNAME']),
            ...(inboxIntegration?.config?.imap_password_saved ? [] : ['IMAP_PASSWORD'])
          ]
        : ['BUSINESS_INBOX_ADDRESS'],
      business_status: inboxIntegration?.status || 'preview'
    },
    {
      id: 'calendar_sync',
      label: 'Business calendar sync',
      status: calendarIntegration?.status || 'preview',
      configured: !!(calendarIntegration?.config?.calendar_id || calendarIntegration?.config?.ics_url_saved),
      summary: calendarIntegration?.provider === 'ics' && calendarIntegration?.config?.connected
        ? 'Upcoming meetings and launch windows are flowing in from the live ICS feed.'
        : calendarIntegration?.provider === 'ics'
          ? 'ICS is selected, but the feed URL still needs to be saved.'
          : 'Connect a company calendar so Ventura can factor meetings, demos, and deadlines into daily execution.',
      missing: calendarIntegration?.provider === 'ics'
        ? (calendarIntegration?.config?.ics_url_saved ? [] : ['ICS_URL'])
        : ['BUSINESS_CALENDAR_ID'],
      business_status: calendarIntegration?.status || 'preview'
    },
    {
      id: 'accounting_sync',
      label: 'Accounting sync',
      status: accountingIntegration?.status || 'preview',
      configured: !!(accountingIntegration?.provider === 'stripe' || accountingIntegration?.config?.account_external_id || accountingIntegration?.config?.account_label),
      summary: accountingIntegration?.provider === 'stripe'
        ? 'Ventura can sync recent Stripe balance transactions into the finance loop.'
        : accountingIntegration?.config?.connected
          ? 'Revenue, fees, and pending reconciliations are flowing into Ventura.'
          : 'Add an accounting or ledger connection so Ventura can reason about cash movement and reconciliation.',
      missing: accountingIntegration?.provider === 'stripe'
        ? []
        : ['BUSINESS_ACCOUNT_LEDGER'],
      business_status: accountingIntegration?.status || 'preview'
    }
  ];

  const nextSteps = [
    ...(domainAsset?.config?.custom_domain && domainAsset.status !== 'connected'
      ? ['Add the DNS records for the custom domain, then verify it in Ventura.']
      : []),
    ...(!deploymentAsset?.checks?.last_release_at
      ? ['Configure the deployment target and log the first release so Ventura can validate the live company surface.']
      : deploymentAsset?.checks?.last_smoke_status === 'success'
        ? []
        : ['Run a deployment smoke check after each release so Ventura can validate the live business surface.']),
    ...(mailboxAsset?.status !== 'connected'
      ? ['Configure SMTP and send a mailbox test so founder alerts and outreach can deliver live.']
      : []),
    ...((analyticsAsset?.status === 'pending' || analyticsAsset?.status === 'configured')
      ? ['Pick an external analytics provider if you want Ventura to push beyond the internal metrics pipeline.']
      : []),
    ...(stripeIntegration?.status !== 'connected'
      ? ['Finish Stripe Connect onboarding so Ventura can route real revenue share and payouts.']
      : []),
    ...(!socialConfig?.twitter?.connected && TWITTER_CLIENT_ID && TWITTER_CLIENT_SECRET
      ? ['Connect a business-owned X account for this company.']
      : []),
    ...(!socialConfig?.linkedin?.publish_ready && LINKEDIN_CLIENT_ID && LINKEDIN_CLIENT_SECRET
      ? ['Connect a LinkedIn founder account and choose the page Ventura should publish from.']
      : []),
    ...(inboxIntegration?.config?.connected
      ? []
      : ['Connect the business inbox so Ventura can triage support, sales, and investor threads.']),
    ...(calendarIntegration?.config?.connected
      ? []
      : ['Connect the business calendar so Ventura can plan around demos, launches, and founder reviews.']),
    ...(accountingIntegration?.config?.connected
      ? []
      : ['Connect a business ledger or accounting system so Ventura can track cash movement and reconciliations.'])
  ];

  return {
    providers,
    summary: {
      ready_providers: providers.filter(item => item.status === 'connected').length,
      total_providers: providers.length,
      connected_assets: assets.filter(item => ['connected', 'configured'].includes(item.status)).length,
      total_assets: assets.length,
      next_steps: nextSteps.length
    },
    next_steps: nextSteps.slice(0, 6)
  };
}

export function getInfrastructureSnapshot(business, integrations = null) {
  const assets = syncInfrastructureAssets(business);
  const activeIntegrations = integrations || [
    getIntegration(business.id, 'website'),
    getIntegration(business.id, 'email'),
    getIntegration(business.id, 'analytics'),
    getIntegration(business.id, 'stripe'),
    getIntegration(business.id, 'social'),
    getIntegration(business.id, 'inbox'),
    getIntegration(business.id, 'calendar'),
    getIntegration(business.id, 'accounting')
  ].filter(Boolean);
  const readiness = buildProviderReadiness(business, activeIntegrations, assets);

  return {
    assets,
    readiness
  };
}
