import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import {
  FRONTEND_URL,
  LINKEDIN_CLIENT_ID,
  LINKEDIN_CLIENT_SECRET,
  LINKEDIN_REDIRECT_URI,
  TWITTER_CLIENT_ID,
  TWITTER_CLIENT_SECRET,
  TWITTER_REDIRECT_URI
} from '../config.js';
import { logActivity } from '../agents/activity.js';
import { getDb } from '../db/migrate.js';
import { saveSocialProviderConnection } from './registry.js';

const OAUTH_TTL_MINUTES = 15;
const PROVIDERS = {
  twitter: {
    label: 'X',
    clientId: TWITTER_CLIENT_ID,
    clientSecret: TWITTER_CLIENT_SECRET,
    redirectUri: TWITTER_REDIRECT_URI,
    authorizeUrl: 'https://x.com/i/oauth2/authorize',
    tokenUrl: 'https://api.x.com/2/oauth2/token',
    scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access']
  },
  linkedin: {
    label: 'LinkedIn',
    clientId: LINKEDIN_CLIENT_ID,
    clientSecret: LINKEDIN_CLIENT_SECRET,
    redirectUri: LINKEDIN_REDIRECT_URI,
    authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    scopes: ['openid', 'profile', 'email', 'r_organization_admin', 'w_organization_social']
  }
};

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toStringArray(value) {
  if (Array.isArray(value)) {
    return value.map(item => cleanString(item)).filter(Boolean);
  }
  return cleanString(value).split(/\s+/).filter(Boolean);
}

function hashValue(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomBase64Url(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function createPkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function getProviderConfig(provider) {
  const config = PROVIDERS[provider];
  if (!config) {
    throw Object.assign(new Error('Unsupported social provider'), { statusCode: 400 });
  }
  return config;
}

function cleanupOauthStates(db = getDb()) {
  db.prepare(`
    DELETE FROM oauth_states
    WHERE consumed_at IS NOT NULL OR datetime(expires_at) <= datetime('now')
  `).run();
}

function buildFrontendRedirect({ businessId = '', provider, status, message = '' }) {
  const params = new URLSearchParams({
    page: 'settings',
    provider,
    oauth: status
  });
  if (businessId) params.set('business', businessId);
  if (message) params.set('message', message);
  return `${FRONTEND_URL}#dashboard?${params.toString()}`;
}

function createOauthState({ provider, businessId, userId, metadata = {}, codeVerifier = null }) {
  const db = getDb();
  cleanupOauthStates(db);

  const rawState = randomBase64Url(24);
  const expiresAt = new Date(Date.now() + OAUTH_TTL_MINUTES * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO oauth_states (id, provider, business_id, user_id, state_hash, code_verifier, metadata, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuid(),
    provider,
    businessId,
    userId,
    hashValue(rawState),
    codeVerifier || null,
    JSON.stringify(metadata || {}),
    expiresAt
  );

  return { rawState, expiresAt };
}

function getOauthState(provider, rawState) {
  const db = getDb();
  cleanupOauthStates(db);

  return db.prepare(`
    SELECT *
    FROM oauth_states
    WHERE provider = ?
      AND state_hash = ?
      AND consumed_at IS NULL
      AND datetime(expires_at) > datetime('now')
  `).get(provider, hashValue(rawState));
}

function consumeOauthState(id) {
  const db = getDb();
  db.prepare(`
    UPDATE oauth_states
    SET consumed_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

async function parseJsonResponse(res, fallback = null) {
  try {
    return await res.json();
  } catch {
    return fallback;
  }
}

async function extractErrorMessage(res, fallback) {
  const data = await parseJsonResponse(res, null);
  if (data && typeof data === 'object') {
    const message = cleanString(
      data.error_description ||
      data.error?.message ||
      data.error ||
      data.detail ||
      data.title
    );
    if (message) return message;
  }

  const text = await res.text().catch(() => '');
  return cleanString(text).slice(0, 220) || fallback;
}

async function fetchTwitterProfile(accessToken) {
  const res = await fetch('https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url,url', {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!res.ok) {
    throw Object.assign(
      new Error(`X profile lookup failed: ${await extractErrorMessage(res, res.statusText)}`),
      { statusCode: 502 }
    );
  }

  const payload = await parseJsonResponse(res, {});
  return payload.data || {};
}

async function exchangeTwitterCode(code, codeVerifier) {
  const provider = getProviderConfig('twitter');
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  if (provider.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString('base64')}`;
  }

  const body = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    client_id: provider.clientId,
    redirect_uri: provider.redirectUri,
    code_verifier: codeVerifier
  });

  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers,
    body
  });

  if (!res.ok) {
    throw Object.assign(
      new Error(`X token exchange failed: ${await extractErrorMessage(res, res.statusText)}`),
      { statusCode: 502 }
    );
  }

  return parseJsonResponse(res, {});
}

async function fetchLinkedInProfile(accessToken) {
  const commonHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'X-Restli-Protocol-Version': '2.0.0'
  };

  const userInfoRes = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: commonHeaders
  });

  if (userInfoRes.ok) {
    const payload = await parseJsonResponse(userInfoRes, {});
    return {
      memberName: cleanString(payload.name) || [payload.given_name, payload.family_name].filter(Boolean).join(' ').trim(),
      memberEmail: cleanString(payload.email),
      memberUrn: cleanString(payload.sub) ? `urn:li:person:${payload.sub}` : null
    };
  }

  const profileRes = await fetch('https://api.linkedin.com/v2/me', {
    headers: commonHeaders
  });

  if (!profileRes.ok) {
    throw Object.assign(
      new Error(`LinkedIn profile lookup failed: ${await extractErrorMessage(profileRes, profileRes.statusText)}`),
      { statusCode: 502 }
    );
  }

  const profile = await parseJsonResponse(profileRes, {});
  const fullName = [
    cleanString(profile.localizedFirstName),
    cleanString(profile.localizedLastName)
  ].filter(Boolean).join(' ').trim();

  return {
    memberName: fullName || cleanString(profile.name),
    memberEmail: null,
    memberUrn: cleanString(profile.id) ? `urn:li:person:${profile.id}` : null
  };
}

async function fetchLinkedInOrganizations(accessToken) {
  const res = await fetch('https://api.linkedin.com/v2/organizationalEntityAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&projection=(elements*(organizationalTarget,organizationalTarget~(id,localizedName,vanityName)))', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Restli-Protocol-Version': '2.0.0'
    }
  });

  if (!res.ok) {
    return [];
  }

  const payload = await parseJsonResponse(res, {});
  const rows = Array.isArray(payload.elements) ? payload.elements : [];

  return rows
    .map(row => {
      const expanded = row['organizationalTarget~'] || {};
      const rawUrn = cleanString(row.organizationalTarget || '');
      const id = cleanString(expanded.id || rawUrn.split(':').pop());
      const urn = rawUrn || (id ? `urn:li:organization:${id}` : '');
      const name = cleanString(expanded.localizedName || expanded.name);
      const vanityName = cleanString(expanded.vanityName);

      if (!urn) return null;

      return {
        organization: name || urn,
        organization_urn: urn,
        author_urn: urn,
        page_url: vanityName ? `https://www.linkedin.com/company/${vanityName}` : null
      };
    })
    .filter(Boolean);
}

async function exchangeLinkedInCode(code) {
  const provider = getProviderConfig('linkedin');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    redirect_uri: provider.redirectUri
  });

  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  if (!res.ok) {
    throw Object.assign(
      new Error(`LinkedIn token exchange failed: ${await extractErrorMessage(res, res.statusText)}`),
      { statusCode: 502 }
    );
  }

  return parseJsonResponse(res, {});
}

function buildTwitterAuthorizationUrl(rawState, codeVerifier) {
  const provider = getProviderConfig('twitter');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: provider.clientId,
    redirect_uri: provider.redirectUri,
    scope: provider.scopes.join(' '),
    state: rawState,
    code_challenge: createPkceChallenge(codeVerifier),
    code_challenge_method: 'S256'
  });
  return `${provider.authorizeUrl}?${params.toString()}`;
}

function buildLinkedInAuthorizationUrl(rawState) {
  const provider = getProviderConfig('linkedin');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: provider.clientId,
    redirect_uri: provider.redirectUri,
    scope: provider.scopes.join(' '),
    state: rawState
  });
  return `${provider.authorizeUrl}?${params.toString()}`;
}

export function getSocialOauthCapabilities() {
  return {
    twitter: {
      configured: !!TWITTER_CLIENT_ID,
      label: PROVIDERS.twitter.label,
      redirect_uri: PROVIDERS.twitter.redirectUri,
      scopes: [...PROVIDERS.twitter.scopes]
    },
    linkedin: {
      configured: !!(LINKEDIN_CLIENT_ID && LINKEDIN_CLIENT_SECRET),
      label: PROVIDERS.linkedin.label,
      redirect_uri: PROVIDERS.linkedin.redirectUri,
      scopes: [...PROVIDERS.linkedin.scopes]
    }
  };
}

export async function createSocialOauthSession({ provider, businessId, userId }) {
  const config = getProviderConfig(provider);
  const configured = provider === 'twitter'
    ? !!config.clientId
    : !!(config.clientId && config.clientSecret);

  if (!configured) {
    throw Object.assign(new Error(`${config.label} OAuth is not configured yet.`), { statusCode: 503 });
  }

  if (provider === 'twitter') {
    const codeVerifier = randomBase64Url(48);
    const { rawState, expiresAt } = createOauthState({
      provider,
      businessId,
      userId,
      metadata: { return_page: 'settings' },
      codeVerifier
    });
    return {
      provider,
      expiresAt,
      url: buildTwitterAuthorizationUrl(rawState, codeVerifier)
    };
  }

  const { rawState, expiresAt } = createOauthState({
    provider,
    businessId,
    userId,
    metadata: { return_page: 'settings' }
  });

  return {
    provider,
    expiresAt,
    url: buildLinkedInAuthorizationUrl(rawState)
  };
}

export function resolveSocialOauthFailure({ provider, state = '', businessId = '', error = '', fallbackMessage = '' }) {
  const oauthState = cleanString(state) ? getOauthState(provider, cleanString(state)) : null;
  const resolvedBusinessId = businessId || oauthState?.business_id || '';

  if (oauthState) {
    consumeOauthState(oauthState.id);
  }

  return buildFrontendRedirect({
    businessId: resolvedBusinessId,
    provider,
    status: 'error',
    message: cleanString(error) || fallbackMessage || `${PROVIDERS[provider]?.label || provider} connection failed`
  });
}

export async function completeSocialOauthCallback({ provider, code, state }) {
  const oauthState = getOauthState(provider, cleanString(state));
  if (!oauthState) {
    throw Object.assign(new Error('This connection link is invalid or expired'), { statusCode: 400 });
  }

  try {
    if (provider === 'twitter') {
      const tokens = await exchangeTwitterCode(cleanString(code), cleanString(oauthState.code_verifier));
      const profile = await fetchTwitterProfile(tokens.access_token);
      const scopeList = toStringArray(tokens.scope);

      saveSocialProviderConnection({
        businessId: oauthState.business_id,
        provider: 'twitter',
        updates: {
          handle: profile.username ? `@${profile.username}` : '',
          profileUrl: profile.username ? `https://x.com/${profile.username}` : cleanString(profile.url),
          accountLabel: cleanString(profile.name) || cleanString(profile.username),
          accountId: cleanString(profile.id),
          accessToken: cleanString(tokens.access_token),
          refreshToken: cleanString(tokens.refresh_token),
          expiresAt: Number(tokens.expires_in) ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString() : null,
          scopes: scopeList,
          connectedVia: 'oauth',
          profileImageUrl: cleanString(profile.profile_image_url)
        }
      });

      await logActivity(oauthState.business_id, {
        type: 'system',
        department: 'marketing',
        title: 'Founder connected an X account',
        detail: {
          provider: 'twitter',
          handle: profile.username ? `@${profile.username}` : null,
          via: 'oauth'
        }
      });

      return buildFrontendRedirect({
        businessId: oauthState.business_id,
        provider,
        status: 'connected',
        message: 'X account connected'
      });
    }

    const tokens = await exchangeLinkedInCode(cleanString(code));
    const [profile, organizations] = await Promise.all([
      fetchLinkedInProfile(tokens.access_token),
      fetchLinkedInOrganizations(tokens.access_token)
    ]);
    const selectedOrg = organizations[0] || null;

    saveSocialProviderConnection({
      businessId: oauthState.business_id,
      provider: 'linkedin',
      updates: {
        organization: selectedOrg?.organization || '',
        organizationUrn: selectedOrg?.organization_urn || '',
        authorUrn: selectedOrg?.author_urn || '',
        pageUrl: selectedOrg?.page_url || '',
        accessToken: cleanString(tokens.access_token),
        refreshToken: cleanString(tokens.refresh_token),
        expiresAt: Number(tokens.expires_in) ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString() : null,
        scopes: toStringArray(tokens.scope),
        connectedVia: 'oauth',
        memberName: profile.memberName || '',
        memberEmail: profile.memberEmail || '',
        memberUrn: profile.memberUrn || '',
        organizations
      }
    });

    await logActivity(oauthState.business_id, {
      type: 'system',
      department: 'marketing',
      title: 'Founder connected a LinkedIn account',
      detail: {
        provider: 'linkedin',
        organization: selectedOrg?.organization || null,
        organizations: organizations.length,
        via: 'oauth'
      }
    });

    return buildFrontendRedirect({
      businessId: oauthState.business_id,
      provider,
      status: 'connected',
      message: selectedOrg
        ? 'LinkedIn page connected'
        : 'LinkedIn connected. Select a page to publish from.'
    });
  } catch (err) {
    throw Object.assign(err, { businessId: oauthState.business_id });
  } finally {
    consumeOauthState(oauthState.id);
  }
}

export function getSocialOauthMetadata(provider, businessId) {
  const capabilities = getSocialOauthCapabilities();
  const capability = capabilities[provider] || { configured: false, label: provider, redirect_uri: '', scopes: [] };
  return {
    ...capability,
    start_path: businessId ? `/businesses/${businessId}/integrations/social/${provider}/oauth/start` : null
  };
}
