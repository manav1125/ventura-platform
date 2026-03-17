// src/integrations/social.js
// Business-scoped social posting for Ventura specialist agents.

import { LINKEDIN_ACCESS_TOKEN, NODE_ENV, TWITTER_BEARER_TOKEN } from '../config.js';
import { getDb } from '../db/migrate.js';
import { logActivity } from '../agents/activity.js';
import { getSocialProviderConnection } from './registry.js';

function requireBusiness(businessId) {
  const db = getDb();
  const biz = db.prepare('SELECT * FROM businesses WHERE id=?').get(businessId);
  if (!biz) throw new Error('Business not found');
  return biz;
}

function buildTwitterUrl(tweetId, handle = null) {
  return handle
    ? `https://twitter.com/${handle.replace(/^@/, '')}/status/${tweetId}`
    : `https://twitter.com/i/status/${tweetId}`;
}

function parseErrorText(text, fallback) {
  return text?.trim()?.slice(0, 240) || fallback;
}

function getProviderCredential(businessId, provider) {
  const connection = getSocialProviderConnection(businessId, provider, { includeSecrets: true });
  const sharedToken = provider === 'twitter' ? TWITTER_BEARER_TOKEN : LINKEDIN_ACCESS_TOKEN;
  const accessToken = connection?.secrets?.access_token || sharedToken || '';
  return {
    connection,
    accessToken,
    source: connection?.secrets?.access_token ? 'business' : (sharedToken ? 'shared' : 'missing')
  };
}

// ─── Twitter/X ────────────────────────────────────────────────────────────────

export async function postTweet(businessId, text) {
  const biz = requireBusiness(businessId);
  const { connection, accessToken, source } = getProviderCredential(businessId, 'twitter');
  const handle = connection?.config?.handle || null;

  if (accessToken && NODE_ENV !== 'test') {
    const res = await fetch('https://api.twitter.com/2/tweets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text })
    });

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      throw new Error(`Twitter/X post failed: ${parseErrorText(raw, res.statusText)}`);
    }

    const payload = await res.json().catch(() => ({}));
    const tweetId = payload.data?.id || `tweet_${Date.now()}`;

    await logActivity(businessId, {
      type: 'social',
      department: 'marketing',
      title: `Tweet posted: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`,
      detail: {
        platform: 'twitter',
        tweetId,
        chars: text.length,
        credential_source: source,
        live: true
      }
    });

    return { tweetId, url: buildTwitterUrl(tweetId, handle), live: true };
  }

  if (!accessToken && NODE_ENV !== 'test') {
    throw new Error('Connect an X account for this business before publishing social posts.');
  }

  const tweetId = `tweet_${Date.now()}`;
  console.log(`[Twitter] Preview post for ${biz.name}: "${text.slice(0, 80)}..."`);

  await logActivity(businessId, {
    type: 'social',
    department: 'marketing',
    title: `Tweet posted: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`,
    detail: {
      platform: 'twitter',
      tweetId,
      chars: text.length,
      credential_source: source,
      live: false
    }
  });

  return { tweetId, url: buildTwitterUrl(tweetId, handle), live: false };
}

// ─── LinkedIn ─────────────────────────────────────────────────────────────────

export async function postLinkedIn(businessId, { text, imageUrl } = {}) {
  const biz = requireBusiness(businessId);
  const { connection, accessToken, source } = getProviderCredential(businessId, 'linkedin');
  const authorUrn = connection?.config?.author_urn || connection?.config?.organization_urn || null;

  if (accessToken && authorUrn && NODE_ENV !== 'test') {
    const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0'
      },
      body: JSON.stringify({
        author: authorUrn,
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: { text },
            shareMediaCategory: imageUrl ? 'IMAGE' : 'NONE',
            media: imageUrl ? [{ status: 'READY', originalUrl: imageUrl }] : []
          }
        },
        visibility: {
          'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
        }
      })
    });

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      throw new Error(`LinkedIn post failed: ${parseErrorText(raw, res.statusText)}`);
    }

    const postId = res.headers.get('x-restli-id') || `li_${Date.now()}`;

    await logActivity(businessId, {
      type: 'social',
      department: 'marketing',
      title: 'LinkedIn post published',
      detail: {
        platform: 'linkedin',
        postId,
        hasImage: !!imageUrl,
        credential_source: source,
        live: true
      }
    });

    return { postId, live: true };
  }

  if (!accessToken && NODE_ENV !== 'test') {
    throw new Error('Connect a LinkedIn page for this business before publishing social posts.');
  }

  if (!authorUrn && NODE_ENV !== 'test') {
    throw new Error('LinkedIn requires an organization/page URN before Ventura can publish.');
  }

  const postId = `li_${Date.now()}`;
  console.log(`[LinkedIn] Preview post for ${biz.name}: "${text?.slice(0, 80)}..."`);

  await logActivity(businessId, {
    type: 'social',
    department: 'marketing',
    title: 'LinkedIn post published',
    detail: {
      platform: 'linkedin',
      postId,
      hasImage: !!imageUrl,
      credential_source: source,
      live: false
    }
  });

  return { postId, live: false };
}

// ─── Schedule a thread (multiple tweets) ─────────────────────────────────────

export async function postThread(businessId, tweets) {
  const results = [];
  for (const tweet of tweets) {
    const result = await postTweet(businessId, tweet);
    results.push(result);
    await new Promise(resolve => setTimeout(resolve, NODE_ENV === 'test' ? 0 : 500));
  }
  return results;
}

// ─── Social analytics snapshot ────────────────────────────────────────────────

export async function getSocialStats(businessId) {
  const twitter = getSocialProviderConnection(businessId, 'twitter');
  const linkedin = getSocialProviderConnection(businessId, 'linkedin');

  return {
    twitter: {
      connected: !!twitter?.config?.connected,
      handle: twitter?.config?.handle || null,
      posts_30d: 0,
      impressions_30d: 0,
      engagements_30d: 0
    },
    linkedin: {
      connected: !!linkedin?.config?.connected,
      organization: linkedin?.config?.organization || null,
      posts_30d: 0,
      impressions_30d: 0
    }
  };
}
