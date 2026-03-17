// src/integrations/social.js
// Social media integration for agent-driven posting
// Supports: Twitter/X, LinkedIn
// In production: use actual OAuth tokens stored per-business in DB

import { getDb } from '../db/migrate.js';
import { logActivity } from '../agents/activity.js';

// ─── Twitter/X ────────────────────────────────────────────────────────────────

export async function postTweet(businessId, text) {
  const db = getDb();
  const biz = db.prepare('SELECT * FROM businesses WHERE id=?').get(businessId);
  if (!biz) throw new Error('Business not found');

  // Production: use OAuth2 bearer token stored per-business
  // const token = db.prepare('SELECT value FROM integrations WHERE business_id=? AND type=?').get(businessId, 'twitter');
  // const res = await fetch('https://api.twitter.com/2/tweets', {
  //   method: 'POST',
  //   headers: { 'Authorization': `Bearer ${token.value}`, 'Content-Type': 'application/json' },
  //   body: JSON.stringify({ text })
  // });

  // Mock for dev
  const tweetId = `tweet_${Date.now()}`;
  console.log(`[Twitter] Would post for ${biz.name}: "${text.slice(0, 80)}..."`);

  await logActivity(businessId, {
    type: 'social',
    department: 'marketing',
    title: `Tweet posted: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`,
    detail: { platform: 'twitter', tweetId, chars: text.length }
  });

  return { tweetId, url: `https://twitter.com/i/status/${tweetId}` };
}

// ─── LinkedIn ─────────────────────────────────────────────────────────────────

export async function postLinkedIn(businessId, { text, imageUrl } = {}) {
  const db = getDb();
  const biz = db.prepare('SELECT * FROM businesses WHERE id=?').get(businessId);
  if (!biz) throw new Error('Business not found');

  // Production: LinkedIn API v2
  // POST https://api.linkedin.com/v2/ugcPosts with OAuth2 token
  const postId = `li_${Date.now()}`;
  console.log(`[LinkedIn] Would post for ${biz.name}: "${text?.slice(0, 80)}..."`);

  await logActivity(businessId, {
    type: 'social',
    department: 'marketing',
    title: `LinkedIn post published`,
    detail: { platform: 'linkedin', postId, hasImage: !!imageUrl }
  });

  return { postId };
}

// ─── Schedule a thread (multiple tweets) ─────────────────────────────────────

export async function postThread(businessId, tweets) {
  const results = [];
  for (const tweet of tweets) {
    const result = await postTweet(businessId, tweet);
    results.push(result);
    await new Promise(r => setTimeout(r, 500)); // small delay between tweets
  }
  return results;
}

// ─── Social analytics (stub — wire to real APIs) ─────────────────────────────

export async function getSocialStats(businessId) {
  // Production: fetch follower counts, post impressions, engagement rates
  // from Twitter API v2 + LinkedIn Analytics API
  return {
    twitter: { followers: 0, posts_30d: 0, impressions_30d: 0, engagements_30d: 0 },
    linkedin: { followers: 0, posts_30d: 0, impressions_30d: 0 }
  };
}
