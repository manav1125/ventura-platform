// tests/platform.test.js
// Full integration test suite for the Ventura platform
// Run: node --test tests/platform.test.js
//
// Tests: auth, business lifecycle, tasks, activity, metrics, billing, WebSocket

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

// ─── Test server setup ────────────────────────────────────────────────────────
const BASE = 'http://localhost:3099';

process.env.NODE_ENV   = 'test';
process.env.DB_PATH    = ':memory:';
process.env.JWT_SECRET = 'test-secret-xyz';
process.env.ANTHROPIC_API_KEY = 'sk-test-placeholder';
process.env.FRONTEND_URL = BASE;
process.env.TWITTER_CLIENT_ID = 'x-client-id-test';
process.env.TWITTER_CLIENT_SECRET = 'x-client-secret-test';
process.env.TWITTER_REDIRECT_URI = `${BASE}/api/oauth/twitter/callback`;
process.env.LINKEDIN_CLIENT_ID = 'linkedin-client-id-test';
process.env.LINKEDIN_CLIENT_SECRET = 'linkedin-client-secret-test';
process.env.LINKEDIN_REDIRECT_URI = `${BASE}/api/oauth/linkedin/callback`;

let server;
let tokens = {};
let bizId;
let otherTokens = {};
let otherBizId;
let marketplaceBizId;
const nativeFetch = global.fetch;

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

const GET    = (p, t)    => req('GET',   p, null, t);
const POST   = (p, b, t) => req('POST',  p, b, t);
const PATCH  = (p, b, t) => req('PATCH', p, b, t);
const DELETE = (p, t)    => req('DELETE', p, null, t);

async function waitForNoRunningCycle(businessId, token, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, body } = await GET(`/api/businesses/${businessId}/cycles`, token);
    assert.equal(status, 200);
    const running = (body.cycles || []).find(cycle => cycle.status === 'running');
    if (!running) return;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for business ${businessId} to become idle`);
}

async function withFetchMocks(routes, fn) {
  global.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const handler = routes.find(route => (
      (typeof route.match === 'string' && url === route.match) ||
      (route.match instanceof RegExp && route.match.test(url)) ||
      (typeof route.match === 'function' && route.match(url, init))
    ));

    if (handler) {
      return handler.handle(url, init);
    }

    return nativeFetch(input, init);
  };

  try {
    return await fn();
  } finally {
    global.fetch = nativeFetch;
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
before(async () => {
  process.env.PORT = '3099';
  process.env.BASE_URL = BASE;

  const mod = await import('../src/server.js');
  server = mod.httpServer;
  await mod.serverReady;
});

after(async () => {
  const mod = await import('../src/server.js');
  await mod.shutdown();
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────
describe('Auth', () => {

  it('registers a new user', async () => {
    const { status, body } = await POST('/api/auth/register', {
      email: 'test@ventura.test',
      name: 'Test Founder',
      password: 'password123'
    });
    assert.equal(status, 201);
    assert.ok(body.accessToken, 'should return accessToken');
    assert.ok(body.refreshToken, 'should return refreshToken');
    assert.equal(body.user.email, 'test@ventura.test');
    assert.equal(body.user.email_verified, false);
    tokens = { access: body.accessToken, refresh: body.refreshToken, userId: body.user.id };
  });

  it('rejects duplicate email', async () => {
    const { status } = await POST('/api/auth/register', {
      email: 'test@ventura.test',
      name: 'Dup',
      password: 'password123'
    });
    assert.equal(status, 409);
  });

  it('logs in with valid credentials', async () => {
    const { status, body } = await POST('/api/auth/login', {
      email: 'test@ventura.test',
      password: 'password123'
    });
    assert.equal(status, 200);
    assert.ok(body.accessToken);
  });

  it('rejects bad password', async () => {
    const { status } = await POST('/api/auth/login', {
      email: 'test@ventura.test',
      password: 'wrongpassword'
    });
    assert.equal(status, 401);
  });

  it('returns current user from /me', async () => {
    const { status, body } = await GET('/api/auth/me', tokens.access);
    assert.equal(status, 200);
    assert.equal(body.user.email, 'test@ventura.test');
    assert.equal(body.user.email_verified, false);
    assert.ok(!body.user.password_hash, 'should not leak password hash');
  });

  it('refreshes tokens', async () => {
    const { status, body } = await POST('/api/auth/refresh', { refreshToken: tokens.refresh });
    assert.equal(status, 200);
    assert.ok(body.accessToken);
    tokens.access = body.accessToken;
    tokens.refresh = body.refreshToken;
  });

  it('blocks unauthenticated requests', async () => {
    const { status } = await GET('/api/businesses');
    assert.equal(status, 401);
  });

  it('blocks invalid tokens', async () => {
    const { status } = await GET('/api/businesses', 'invalid.token.here');
    assert.equal(status, 401);
  });

  it('resends a verification email for unverified founders', async () => {
    const { status, body } = await POST('/api/auth/resend-verification', {}, tokens.access);
    assert.equal(status, 200);
    assert.equal(body.success, true);

    const { getDb } = await import('../src/db/migrate.js');
    const db = getDb();
    const tokenRow = db.prepare('SELECT id FROM email_verification_tokens WHERE user_id = ?').get(tokens.userId);
    assert.ok(tokenRow);
  });

  it('verifies the founder email with a verification token', async () => {
    const { createEmailVerificationToken } = await import('../src/auth/auth.js');
    const verifyToken = createEmailVerificationToken(tokens.userId);
    const { status, body } = await POST('/api/auth/verify-email', { token: verifyToken });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.user.email_verified, true);

    const me = await GET('/api/auth/me', tokens.access);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email_verified, true);
  });

  it('returns success for forgot-password without leaking account presence', async () => {
    const existing = await POST('/api/auth/forgot-password', { email: 'test@ventura.test' });
    const missing = await POST('/api/auth/forgot-password', { email: 'nobody@ventura.test' });
    assert.equal(existing.status, 200);
    assert.equal(missing.status, 200);
    assert.equal(existing.body.success, true);
    assert.equal(missing.body.success, true);

    const { getDb } = await import('../src/db/migrate.js');
    const db = getDb();
    const tokenRow = db.prepare('SELECT id FROM password_reset_tokens WHERE user_id = ?').get(tokens.userId);
    assert.ok(tokenRow);
  });

  it('resets password with a valid reset token', async () => {
    const { createPasswordResetToken } = await import('../src/auth/auth.js');
    const resetToken = createPasswordResetToken(tokens.userId);
    const reset = await POST('/api/auth/reset-password', {
      token: resetToken,
      newPassword: 'new-password-123'
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.success, true);

    const oldLogin = await POST('/api/auth/login', {
      email: 'test@ventura.test',
      password: 'password123'
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await POST('/api/auth/login', {
      email: 'test@ventura.test',
      password: 'new-password-123'
    });
    assert.equal(newLogin.status, 200);
    tokens.access = newLogin.body.accessToken;
    tokens.refresh = newLogin.body.refreshToken;
  });

  it('rejects expired or invalid verification and reset tokens', async () => {
    const badVerify = await POST('/api/auth/verify-email', { token: 'not-a-real-token' });
    const badReset = await POST('/api/auth/reset-password', { token: 'not-a-real-token', newPassword: 'password1234' });
    assert.equal(badVerify.status, 400);
    assert.equal(badReset.status, 400);
  });
});

// ─── BUSINESSES ───────────────────────────────────────────────────────────────
describe('Businesses', () => {

  it('starts with empty list', async () => {
    const { status, body } = await GET('/api/businesses', tokens.access);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.businesses));
    assert.equal(body.businesses.length, 0);
  });

  it('creates a business (async provisioning)', async () => {
    const { status, body } = await POST('/api/businesses', {
      name: 'Test SaaS',
      type: 'saas',
      description: 'A test SaaS application for automated testing purposes',
      targetCustomer: 'QA engineers and developers',
      goal90d: 'Reach first 10 paying customers',
      involvement: 'autopilot'
    }, tokens.access);

    assert.equal(status, 202);
    assert.equal(body.status, 'provisioning');

    // Wait for provisioning to complete
    await new Promise(r => setTimeout(r, 1200));
  });

  it('lists the created business', async () => {
    const { status, body } = await GET('/api/businesses', tokens.access);
    assert.equal(status, 200);
    assert.equal(body.businesses.length, 1);
    assert.equal(body.businesses[0].name, 'Test SaaS');
    assert.equal(body.businesses[0].type, 'saas');
    bizId = body.businesses[0].id;
  });

  it('fetches a single business by id', async () => {
    const { status, body } = await GET(`/api/businesses/${bizId}`, tokens.access);
    assert.equal(status, 200);
    assert.equal(body.business.id, bizId);
    assert.ok(body.business.web_url, 'should have web_url');
    assert.ok(body.business.email_address, 'should have email_address');
  });

  it('automatically starts the first launch cycle after provisioning', async () => {
    const deadline = Date.now() + 3000;
    let cycle = null;

    while (Date.now() < deadline) {
      const { status, body } = await GET(`/api/businesses/${bizId}/cycles`, tokens.access);
      assert.equal(status, 200);
      cycle = body.cycles[0] || null;
      if (cycle?.triggered_by === 'launch') break;
      await new Promise(r => setTimeout(r, 50));
    }

    assert.ok(cycle, 'expected Ventura to create an initial launch cycle');
    assert.equal(cycle.triggered_by, 'launch');
  });

  it('404s on other users business', async () => {
    const { status } = await GET(`/api/businesses/nonexistent-id`, tokens.access);
    assert.equal(status, 404);
  });

  it('updates business settings', async () => {
    const { status } = await PATCH(`/api/businesses/${bizId}`, {
      goal90d: 'Updated goal: reach $1k MRR',
      involvement: 'review',
      description: 'Updated business description for control-center coverage',
      targetCustomer: 'Bootstrapped SaaS founders'
    }, tokens.access);
    assert.equal(status, 200);

    const { body } = await GET(`/api/businesses/${bizId}`, tokens.access);
    assert.equal(body.business.goal_90d, 'Updated goal: reach $1k MRR');
    assert.equal(body.business.involvement, 'review');
    assert.equal(body.business.target_customer, 'Bootstrapped SaaS founders');
    assert.equal(body.business.description, 'Updated business description for control-center coverage');
  });

  it('enforces trial plan business limit (1)', async () => {
    const { status, body } = await POST('/api/businesses', {
      name: 'Second Business',
      type: 'agency',
      description: 'A second business that should be blocked by plan limits',
      targetCustomer: 'Businesses',
      goal90d: 'Get clients',
      involvement: 'autopilot'
    }, tokens.access);
    assert.equal(status, 403);
    assert.match(body.error, /limit/i);
  });
});

describe('Second founder setup', () => {

  it('creates another founder and business for access-control tests', async () => {
    const register = await POST('/api/auth/register', {
      email: 'other@ventura.test',
      name: 'Other Founder',
      password: 'password123'
    });
    assert.equal(register.status, 201);
    otherTokens = { access: register.body.accessToken, refresh: register.body.refreshToken, userId: register.body.user.id };

    const create = await POST('/api/businesses', {
      name: 'Other Business',
      type: 'agency',
      description: 'An agency business used to test websocket ownership access control paths.',
      targetCustomer: 'SaaS startups',
      goal90d: 'Sign first client',
      involvement: 'autopilot'
    }, otherTokens.access);
    assert.equal(create.status, 202);

    await new Promise(r => setTimeout(r, 1200));

    const list = await GET('/api/businesses', otherTokens.access);
    assert.equal(list.status, 200);
    otherBizId = list.body.businesses[0].id;
    assert.ok(otherBizId);
  });
});

describe('Blueprints and marketplace runtime', () => {

  it('stores resolved blueprint metadata on a normal business', async () => {
    const detail = await GET(`/api/businesses/${bizId}`, tokens.access);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.business.blueprint.key, 'generic_saas');

    const blueprintRes = await GET(`/api/businesses/${bizId}/blueprint`, tokens.access);
    assert.equal(blueprintRes.status, 200);
    assert.equal(blueprintRes.body.blueprint.key, 'generic_saas');
    assert.ok(Array.isArray(blueprintRes.body.blueprint.entities));

    const trainingRes = await GET(`/api/businesses/${bizId}/training`, tokens.access);
    assert.equal(trainingRes.status, 200);
    assert.equal(trainingRes.body.training.blueprint.key, 'generic_saas');
    assert.ok(Array.isArray(trainingRes.body.training.universal_skills));
    assert.ok(trainingRes.body.training.playbooks.engineering);
  });

  it('provisions a founder-investor marketplace with the correct blueprint', async () => {
    const { provisionBusiness } = await import('../src/provisioning/provision.js');
    const result = await provisionBusiness({
      userId: otherTokens.userId,
      name: 'Founder Investor Connect',
      type: 'marketplace',
      description: 'A platform that matches early-stage founders with aligned investors based on stage, sector, geography, and thesis fit.',
      targetCustomer: 'Early-stage founders raising pre-seed and seed rounds',
      goal90d: 'Create the first 25 qualified founder-to-investor intros',
      involvement: 'review'
    });

    marketplaceBizId = result.businessId;
    await waitForNoRunningCycle(marketplaceBizId, otherTokens.access, 4000);

    const detail = await GET(`/api/businesses/${marketplaceBizId}`, otherTokens.access);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.business.blueprint.key, 'founder_investor_marketplace');

    const operating = await GET(`/api/businesses/${marketplaceBizId}/operating-system`, otherTokens.access);
    assert.equal(operating.status, 200);
    assert.equal(operating.body.blueprint.key, 'founder_investor_marketplace');
    assert.ok(operating.body.marketplace);
    assert.equal(operating.body.marketplace.counts.founders, 0);
    assert.equal(operating.body.marketplace.counts.investors, 0);
    assert.equal(operating.body.training.blueprint.key, 'founder_investor_marketplace');

    const artifactsRes = await GET(`/api/businesses/${marketplaceBizId}/artifacts`, otherTokens.access);
    assert.equal(artifactsRes.status, 200);
    assert.ok(artifactsRes.body.artifacts.some(item => item.kind === 'training_manual'));
    assert.ok(artifactsRes.body.artifacts.some(item => item.kind === 'playbook'));
  });

  it('creates founder and investor profiles and scores a marketplace match', async () => {
    const founderRes = await POST(`/api/businesses/${marketplaceBizId}/marketplace/founders`, {
      founderName: 'Maya Chen',
      founderEmail: 'maya@signalcloud.test',
      companyName: 'SignalCloud',
      stage: 'pre-seed',
      sectors: ['B2B SaaS', 'Developer tools'],
      geography: 'US',
      tractionSummary: '500 beta users and 12 design partners',
      raiseSummary: 'Raising a $1.2M pre-seed round',
      raiseTargetCents: 120000000
    }, otherTokens.access);
    assert.equal(founderRes.status, 201);

    const investorRes = await POST(`/api/businesses/${marketplaceBizId}/marketplace/investors`, {
      name: 'Jordan Park',
      email: 'jordan@northstarvc.test',
      firm: 'Northstar Ventures',
      title: 'Partner',
      stageFocus: ['pre-seed', 'seed'],
      sectorFocus: ['B2B SaaS', 'Developer tools', 'AI infrastructure'],
      geographyFocus: ['US'],
      checkSizeMinCents: 25000000,
      checkSizeMaxCents: 250000000,
      thesis: 'Backs technical founders building workflow software and infra products.'
    }, otherTokens.access);
    assert.equal(investorRes.status, 201);

    const matchRes = await POST(`/api/businesses/${marketplaceBizId}/marketplace/matches`, {
      founderProfileId: founderRes.body.founder.id,
      investorProfileId: investorRes.body.investor.id
    }, otherTokens.access);
    assert.equal(matchRes.status, 201);
    assert.ok(matchRes.body.match.score > 0.5);
    assert.match(matchRes.body.match.rationale, /Ventura scored this match/i);

    const overview = await GET(`/api/businesses/${marketplaceBizId}/marketplace/overview`, otherTokens.access);
    assert.equal(overview.status, 200);
    assert.equal(overview.body.marketplace.counts.founders, 1);
    assert.equal(overview.body.marketplace.counts.investors, 1);
    assert.equal(overview.body.marketplace.counts.matches, 1);
  });

  it('progresses marketplace review, match, and conversation state', async () => {
    const founderRes = await POST(`/api/businesses/${marketplaceBizId}/marketplace/founders`, {
      founderName: 'Morgan Lee',
      founderEmail: 'morgan@forge.test',
      companyName: 'Forge Cloud',
      stage: 'seed',
      sectors: ['Developer tools', 'B2B SaaS'],
      geography: 'Singapore'
    }, otherTokens.access);
    assert.equal(founderRes.status, 201);

    const investorRes = await POST(`/api/businesses/${marketplaceBizId}/marketplace/investors`, {
      name: 'Taylor Reed',
      email: 'taylor@horizon.test',
      firm: 'Horizon Capital',
      stageFocus: ['seed'],
      sectorFocus: ['Developer tools', 'B2B SaaS'],
      geographyFocus: ['Singapore', 'APAC'],
      thesis: 'Backs product-led SaaS teams scaling from seed to Series A.'
    }, otherTokens.access);
    assert.equal(investorRes.status, 201);

    const founderUpdate = await PATCH(`/api/businesses/${marketplaceBizId}/marketplace/founders/${founderRes.body.founder.id}`, {
      status: 'approved',
      notes: 'Founder profile cleared first review.'
    }, otherTokens.access);
    assert.equal(founderUpdate.status, 200);
    assert.equal(founderUpdate.body.founder.status, 'approved');
    assert.equal(founderUpdate.body.review.decision, 'approved');

    const investorUpdate = await PATCH(`/api/businesses/${marketplaceBizId}/marketplace/investors/${investorRes.body.investor.id}`, {
      status: 'active',
      notes: 'Investor is ready for live matching.'
    }, otherTokens.access);
    assert.equal(investorUpdate.status, 200);
    assert.equal(investorUpdate.body.investor.status, 'active');
    assert.equal(investorUpdate.body.review.decision, 'approved');

    const matchRes = await POST(`/api/businesses/${marketplaceBizId}/marketplace/matches`, {
      founderProfileId: founderRes.body.founder.id,
      investorProfileId: investorRes.body.investor.id
    }, otherTokens.access);
    assert.equal(matchRes.status, 201);

    const matchUpdate = await PATCH(`/api/businesses/${marketplaceBizId}/marketplace/matches/${matchRes.body.match.id}`, {
      status: 'queued_intro',
      introDraft: 'Intro draft ready for both sides.',
      notes: 'Queue this intro for next ops pass.'
    }, otherTokens.access);
    assert.equal(matchUpdate.status, 200);
    assert.equal(matchUpdate.body.match.status, 'queued_intro');

    const conversationRes = await POST(`/api/businesses/${marketplaceBizId}/marketplace/matches/${matchRes.body.match.id}/conversations`, {
      status: 'replied',
      channel: 'email',
      threadSubject: 'Intro: Forge Cloud × Horizon Capital',
      note: 'Investor replied and requested a call next week.'
    }, otherTokens.access);
    assert.equal(conversationRes.status, 201);
    assert.equal(conversationRes.body.conversation.status, 'replied');

    const overview = await GET(`/api/businesses/${marketplaceBizId}/marketplace/overview`, otherTokens.access);
    assert.equal(overview.status, 200);
    assert.ok(overview.body.marketplace.counts.intros_sent >= 1);
    assert.ok(overview.body.marketplace.counts.open_conversations >= 1);
    assert.ok(overview.body.marketplace.reviews.some(item => item.subject_type === 'founder_profile'));
    assert.ok(overview.body.marketplace.reviews.some(item => item.subject_type === 'investor_profile'));
    assert.ok(overview.body.marketplace.reviews.some(item => item.subject_type === 'match'));
    assert.ok(overview.body.marketplace.conversations.some(item => item.match_id === matchRes.body.match.id));
  });
});

// ─── TASKS ────────────────────────────────────────────────────────────────────
describe('Tasks', () => {

  it('queues a task', async () => {
    const { status, body } = await POST(`/api/businesses/${bizId}/tasks`, {
      title: 'Write homepage copy',
      department: 'marketing',
      priority: 2
    }, tokens.access);
    assert.equal(status, 201);
    assert.ok(body.taskId);
  });

  it('lists tasks', async () => {
    const { status, body } = await GET(`/api/businesses/${bizId}/tasks`, tokens.access);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.tasks));
    assert.ok(body.tasks.length >= 1);
  });

  it('validates department enum', async () => {
    const { status } = await POST(`/api/businesses/${bizId}/tasks`, {
      title: 'Bad task',
      department: 'invalid_dept',
      priority: 3
    }, tokens.access);
    assert.equal(status, 400);
  });

  it('validates required title', async () => {
    const { status } = await POST(`/api/businesses/${bizId}/tasks`, {
      department: 'marketing'
    }, tokens.access);
    assert.notEqual(status, 201);
  });
});

// ─── ACTIVITY ─────────────────────────────────────────────────────────────────
describe('Activity', () => {

  it('returns activity feed', async () => {
    const { status, body } = await GET(`/api/businesses/${bizId}/activity`, tokens.access);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.activity));
  });

  it('activity has seeded provisioning events', async () => {
    const { body } = await GET(`/api/businesses/${bizId}/activity?limit=20`, tokens.access);
    // Provisioning logs system events
    assert.ok(body.activity.length > 0, 'should have activity items from provisioning');
  });

  it('respects limit param', async () => {
    const { body } = await GET(`/api/businesses/${bizId}/activity?limit=2`, tokens.access);
    assert.ok(body.activity.length <= 2);
  });
});

// ─── METRICS ─────────────────────────────────────────────────────────────────
describe('Metrics', () => {

  it('returns metrics object', async () => {
    const { status, body } = await GET(`/api/businesses/${bizId}/metrics`, tokens.access);
    assert.equal(status, 200);
    assert.ok(body.business, 'should have business summary');
    assert.ok(Array.isArray(body.daily), 'should have daily array');
    assert.ok(Array.isArray(body.leads), 'should have leads breakdown');
  });
});

// ─── LEADS ────────────────────────────────────────────────────────────────────
describe('Leads', () => {

  let leadId;

  it('adds a lead', async () => {
    const { status, body } = await POST(`/api/businesses/${bizId}/leads`, {
      name: 'Alice Test',
      email: 'alice@example.com',
      company: 'TestCo',
      source: 'cold_email',
      notes: 'Responded quickly, interested in annual plan'
    }, tokens.access);
    assert.equal(status, 201);
    assert.ok(body.leadId);
    leadId = body.leadId;
  });

  it('lists leads', async () => {
    const { status, body } = await GET(`/api/businesses/${bizId}/leads`, tokens.access);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.leads));
    assert.ok(body.leads.some(l => l.email === 'alice@example.com'));
  });

  it('updates lead status', async () => {
    const { status } = await PATCH(`/api/businesses/${bizId}/leads/${leadId}`, {
      status: 'qualified',
      notes: 'Updated notes'
    }, tokens.access);
    assert.equal(status, 200);

    const { body } = await GET(`/api/businesses/${bizId}/leads`, tokens.access);
    const lead = body.leads.find(l => l.id === leadId);
    assert.equal(lead.status, 'qualified');
  });

  it('filters leads by status', async () => {
    const { body } = await GET(`/api/businesses/${bizId}/leads?status=qualified`, tokens.access);
    assert.ok(body.leads.every(l => l.status === 'qualified'));
  });

  it('requires email field', async () => {
    const { status } = await POST(`/api/businesses/${bizId}/leads`, {
      name: 'No Email',
      source: 'organic'
    }, tokens.access);
    assert.equal(status, 400);
  });
});

// ─── CONTROL LAYER ───────────────────────────────────────────────────────────
describe('Control center', () => {
  let approvalId;

  it('returns control center data', async () => {
    const { status, body } = await GET(`/api/businesses/${bizId}/control-center`, tokens.access);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.integrations));
    assert.ok(Array.isArray(body.specialists));
    assert.ok(Array.isArray(body.recoveryCases));
    assert.ok(body.recoverySummary);
    assert.ok(body.cadence);
    assert.ok(body.workspace);
    assert.ok(body.plan);
    assert.ok(body.usage);
    assert.ok(body.economics);
    assert.ok(body.economics.monthly_subscription_cents >= 0);
    assert.equal(body.business.monthly_subscription_cents, body.economics.monthly_subscription_cents);
  });

  it('regenerates the launch foundation for an existing business', async () => {
    await waitForNoRunningCycle(bizId, tokens.access);

    const { status, body } = await POST(`/api/businesses/${bizId}/regenerate-launch`, {
      replaceQueuedTasks: true,
      restartCycle: false
    }, tokens.access);

    assert.equal(status, 202);
    assert.equal(body.success, true);
    assert.ok(body.regeneration.headline);
    assert.ok(body.regeneration.queuedTasks >= 1);

    const tasksRes = await GET(`/api/businesses/${bizId}/tasks`, tokens.access);
    assert.equal(tasksRes.status, 200);
    const autonomousQueued = tasksRes.body.tasks.filter(task => task.status === 'queued' && task.triggered_by !== 'user');
    assert.ok(autonomousQueued.length >= 1);
    assert.ok(autonomousQueued.every(task => !/write full business plan|define mvp feature set|build core mvp/i.test(task.title)));

    const artifactsRes = await GET(`/api/businesses/${bizId}/artifacts`, tokens.access);
    assert.equal(artifactsRes.status, 200);
    assert.ok(artifactsRes.body.artifacts.some(item => item.kind === 'launch_refresh'));
  });

  it('lists deployment history', async () => {
    const { status, body } = await GET(`/api/businesses/${bizId}/deployments`, tokens.access);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.deployments));
  });

  it('lists and syncs integrations', async () => {
    const { status, body } = await GET(`/api/businesses/${bizId}/integrations`, tokens.access);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.integrations));
    assert.ok(body.integrations.length >= 1);

    const sync = await POST(`/api/businesses/${bizId}/integrations/sync`, {}, tokens.access);
    assert.equal(sync.status, 200);
    assert.ok(sync.body.integrations.every(i => i.last_sync_at), 'all integrations should record a sync time');
  });

  it('stores business-scoped social credentials without leaking secrets', async () => {
    const token = 'twitter-access-token-secret-7890';
    const { status, body } = await PATCH(`/api/businesses/${bizId}/integrations/social/twitter`, {
      handle: '@testsaas',
      profileUrl: 'https://x.com/testsaas',
      accountLabel: 'Test SaaS',
      accessToken: token
    }, tokens.access);

    assert.equal(status, 200);
    assert.equal(body.integration.kind, 'social');
    assert.equal(body.integration.status, 'connected');
    assert.equal(body.integration.config.twitter.handle, '@testsaas');
    assert.equal(body.integration.config.twitter.connected, true);
    assert.equal(body.integration.config.twitter.token_last4, '7890');
    assert.ok(!JSON.stringify(body).includes(token), 'response should not include raw tokens');

    const list = await GET(`/api/businesses/${bizId}/integrations`, tokens.access);
    const social = list.body.integrations.find(i => i.kind === 'social');
    assert.ok(social);
    assert.equal(social.config.twitter.handle, '@testsaas');
    assert.equal(social.config.twitter.token_last4, '7890');
    assert.ok(!Object.prototype.hasOwnProperty.call(social, 'secrets'));
  });

  it('preserves connected social integrations across syncs', async () => {
    const sync = await POST(`/api/businesses/${bizId}/integrations/sync`, {}, tokens.access);
    assert.equal(sync.status, 200);
    const social = sync.body.integrations.find(i => i.kind === 'social');
    assert.ok(social);
    assert.equal(social.config.twitter.handle, '@testsaas');
    assert.equal(social.config.twitter.connected, true);
  });

  it('starts an X OAuth session with a secure authorization URL', async () => {
    const { status, body } = await POST(`/api/businesses/${bizId}/integrations/social/twitter/oauth/start`, {}, tokens.access);
    assert.equal(status, 200);
    assert.equal(body.provider, 'twitter');
    assert.ok(body.url);

    const url = new URL(body.url);
    assert.equal(url.origin, 'https://x.com');
    assert.equal(url.searchParams.get('client_id'), process.env.TWITTER_CLIENT_ID);
    assert.equal(url.searchParams.get('redirect_uri'), process.env.TWITTER_REDIRECT_URI);
    assert.ok(url.searchParams.get('state'));
    assert.ok(url.searchParams.get('code_challenge'));
  });

  it('completes the X OAuth callback and stores business-owned credentials', async () => {
    const session = await POST(`/api/businesses/${bizId}/integrations/social/twitter/oauth/start`, {}, tokens.access);
    assert.equal(session.status, 200);
    const authUrl = new URL(session.body.url);
    const state = authUrl.searchParams.get('state');
    assert.ok(state);

    await withFetchMocks([
      {
        match: 'https://api.x.com/2/oauth2/token',
        handle: async () => new Response(JSON.stringify({
          token_type: 'bearer',
          access_token: 'x-access-token-4321',
          refresh_token: 'x-refresh-token-1234',
          expires_in: 7200,
          scope: 'tweet.read tweet.write users.read offline.access'
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      },
      {
        match: url => url.startsWith('https://api.x.com/2/users/me'),
        handle: async () => new Response(JSON.stringify({
          data: {
            id: 'x-user-1',
            name: 'Ventura Growth',
            username: 'venturagrowth'
          }
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
    ], async () => {
      const res = await nativeFetch(`${BASE}/api/oauth/twitter/callback?code=test-twitter-code&state=${encodeURIComponent(state)}`, {
        redirect: 'manual'
      });
      assert.equal(res.status, 302);
      assert.match(res.headers.get('location') || '', /provider=twitter/);
      assert.match(res.headers.get('location') || '', /oauth=connected/);
    });

    const list = await GET(`/api/businesses/${bizId}/integrations`, tokens.access);
    const social = list.body.integrations.find(i => i.kind === 'social');
    assert.ok(social);
    assert.equal(social.config.twitter.handle, '@venturagrowth');
    assert.equal(social.config.twitter.account_id, 'x-user-1');
    assert.equal(social.config.twitter.connected_via, 'oauth');
    assert.equal(social.config.twitter.token_last4, '4321');
    assert.ok(social.config.twitter.scopes.includes('tweet.write'));
  });

  it('completes the LinkedIn OAuth callback and stores detected pages', async () => {
    const session = await POST(`/api/businesses/${bizId}/integrations/social/linkedin/oauth/start`, {}, tokens.access);
    assert.equal(session.status, 200);
    const authUrl = new URL(session.body.url);
    const state = authUrl.searchParams.get('state');
    assert.ok(state);

    await withFetchMocks([
      {
        match: 'https://www.linkedin.com/oauth/v2/accessToken',
        handle: async () => new Response(JSON.stringify({
          access_token: 'linkedin-access-token-6789',
          refresh_token: 'linkedin-refresh-token-2468',
          expires_in: 3600,
          scope: 'openid profile email r_organization_admin w_organization_social'
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      },
      {
        match: 'https://api.linkedin.com/v2/userinfo',
        handle: async () => new Response(JSON.stringify({
          sub: 'founder-123',
          name: 'Test Founder',
          email: 'founder@ventura.test'
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      },
      {
        match: url => url.startsWith('https://api.linkedin.com/v2/organizationalEntityAcls'),
        handle: async () => new Response(JSON.stringify({
          elements: [
            {
              organizationalTarget: 'urn:li:organization:111',
              'organizationalTarget~': {
                id: 111,
                localizedName: 'Ventura Labs',
                vanityName: 'ventura-labs'
              }
            },
            {
              organizationalTarget: 'urn:li:organization:222',
              'organizationalTarget~': {
                id: 222,
                localizedName: 'Nova Analytics',
                vanityName: 'nova-analytics'
              }
            }
          ]
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
    ], async () => {
      const res = await nativeFetch(`${BASE}/api/oauth/linkedin/callback?code=test-linkedin-code&state=${encodeURIComponent(state)}`, {
        redirect: 'manual'
      });
      assert.equal(res.status, 302);
      assert.match(res.headers.get('location') || '', /provider=linkedin/);
      assert.match(res.headers.get('location') || '', /oauth=connected/);
    });

    const list = await GET(`/api/businesses/${bizId}/integrations`, tokens.access);
    const social = list.body.integrations.find(i => i.kind === 'social');
    assert.ok(social);
    assert.equal(social.config.linkedin.connected_via, 'oauth');
    assert.equal(social.config.linkedin.token_last4, '6789');
    assert.equal(social.config.linkedin.organization, 'Ventura Labs');
    assert.equal(social.config.linkedin.organization_urn, 'urn:li:organization:111');
    assert.equal(social.config.linkedin.publish_ready, true);
    assert.equal(social.config.linkedin.organizations.length, 2);
  });

  it('disconnects a social provider without removing the registry row', async () => {
    const { status, body } = await DELETE(`/api/businesses/${bizId}/integrations/social/twitter`, tokens.access);
    assert.equal(status, 200);
    assert.equal(body.integration.kind, 'social');
    assert.equal(body.integration.config.twitter.connected, false);

    const list = await GET(`/api/businesses/${bizId}/integrations`, tokens.access);
    const social = list.body.integrations.find(i => i.kind === 'social');
    assert.ok(social);
    assert.equal(social.config.twitter.connected, false);
  });

  it('dispatches a specialist sprint', async () => {
    const { status, body } = await POST(`/api/businesses/${bizId}/specialists/marketing/run`, {
      brief: 'Launch a founder waitlist campaign this week'
    }, tokens.access);
    assert.equal(status, 201);
    assert.equal(body.specialist, 'marketing');
    assert.ok(body.taskId);

    const tasks = await GET(`/api/businesses/${bizId}/tasks`, tokens.access);
    const created = tasks.body.tasks.find(task => task.id === body.taskId);
    assert.ok(created);
    assert.equal(created.department, 'marketing');
    assert.equal(created.workflow_key, 'marketing');
    assert.equal(created.brief.workflow_key, 'marketing');
    assert.match(created.brief.what, /Founder dispatch: growth sprint/i);
  });

  it('persists verification, workflow continuity, and extracted skills after task execution', async () => {
    const { getDb } = await import('../src/db/migrate.js');
    const {
      hydrateTask,
      persistExecutionIntelligence
    } = await import('../src/agents/execution-intelligence.js');

    const db = getDb();
    const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(bizId);
    const taskRow = db.prepare(`
      SELECT *
      FROM tasks
      WHERE business_id = ?
        AND workflow_key = 'marketing'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(bizId);
    const task = hydrateTask(taskRow);

    const intelligence = await persistExecutionIntelligence({
      business,
      task,
      result: {
        summary: 'Built a waitlist experiment for solo founders, captured the core messaging, and documented the next follow-up sequence.',
        toolResults: [
          { tool: 'web_search', result: { count: 3 } },
          { tool: 'create_content', result: { success: true } },
          { tool: 'add_lead', result: { success: true } }
        ],
        nextSteps: ['Launch a follow-up nurture email for new waitlist leads']
      }
    });

    assert.equal(intelligence.verification.status, 'passed');
    assert.equal(intelligence.workflowState.workflow_key, 'marketing');
    assert.ok(intelligence.workflowState.open_loops.includes('Launch a follow-up nurture email for new waitlist leads'));
    assert.ok(intelligence.skill);

    const snapshot = await GET(`/api/businesses/${bizId}/operating-system`, tokens.access);
    assert.equal(snapshot.status, 200);
    assert.ok(snapshot.body.planning);
    assert.ok(snapshot.body.planning.recent_verifications.some(item => item.task_id === task.id));
    assert.ok(snapshot.body.planning.workflows.some(item => item.workflow_key === 'marketing'));
    assert.ok(snapshot.body.planning.skill_library.length >= 1);
  });

  it('returns an operating-system snapshot for the business', async () => {
    const { status, body } = await GET(`/api/businesses/${bizId}/operating-system`, tokens.access);
    assert.equal(status, 200);
    assert.ok(body.business);
    assert.ok(body.planning);
    assert.ok(body.engineering);
    assert.ok(body.marketing);
    assert.ok(body.operations);
    assert.ok(body.analytics);
    assert.ok(body.memory);
    assert.ok(body.billing);
    assert.ok(body.infrastructure);
    assert.ok(body.cadence);
    assert.ok(body.workspace);
    assert.ok(body.operations.action_summary);
    assert.ok(Array.isArray(body.operations.actions));
    assert.ok(body.operations.recovery_summary);
    assert.ok(Array.isArray(body.operations.recovery_cases));
    assert.ok(body.operations.workspace);
    assert.ok(Array.isArray(body.infrastructure.assets));
    assert.ok(body.infrastructure.readiness);
    assert.ok(Array.isArray(body.analytics.trend));
    assert.ok(Array.isArray(body.planning.workflows));
    assert.ok(body.planning.verification_summary);
  });

  it('returns infrastructure readiness details for the business', async () => {
    const { status, body } = await GET(`/api/businesses/${bizId}/infrastructure/readiness`, tokens.access);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.assets));
    assert.ok(body.readiness);
    assert.ok(Array.isArray(body.readiness.providers));
    assert.ok(body.assets.find(asset => asset.kind === 'domain'));
    assert.ok(body.assets.find(asset => asset.kind === 'deployment'));
    assert.ok(body.assets.find(asset => asset.kind === 'mailbox'));
    assert.ok(body.assets.find(asset => asset.kind === 'analytics'));
  });

  it('stores workspace provider secrets without leaking them', async () => {
    const inbox = await PATCH(`/api/businesses/${bizId}/integrations/workspace/inbox`, {
      provider: 'imap',
      inboxAddress: 'support@testsaas.dev',
      imapHost: 'imap.testsaas.dev',
      imapPort: 993,
      imapSecure: true,
      imapUsername: 'support@testsaas.dev',
      imapPassword: 'app-password-123',
      imapMailbox: 'INBOX',
      syncMode: 'hourly'
    }, tokens.access);
    assert.equal(inbox.status, 200);
    assert.equal(inbox.body.integration.provider, 'imap');
    assert.equal(inbox.body.integration.config.imap_host, 'imap.testsaas.dev');
    assert.equal(inbox.body.integration.config.imap_password_saved, true);
    assert.ok(!Object.prototype.hasOwnProperty.call(inbox.body.integration, 'secrets'));

    const calendar = await PATCH(`/api/businesses/${bizId}/integrations/workspace/calendar`, {
      provider: 'ics',
      calendarLabel: 'Founder ops calendar',
      icsUrl: 'https://calendar.testsaas.dev/private.ics',
      syncMode: 'daily'
    }, tokens.access);
    assert.equal(calendar.status, 200);
    assert.equal(calendar.body.integration.provider, 'ics');
    assert.equal(calendar.body.integration.config.ics_url_saved, true);
    assert.equal(calendar.body.integration.config.ics_feed_host, 'calendar.testsaas.dev');
    assert.ok(!('ics_url' in calendar.body.integration.config));

    const workspace = await GET(`/api/businesses/${bizId}/workspace`, tokens.access);
    assert.equal(workspace.status, 200);
    const savedInbox = workspace.body.integrations.find(item => item.kind === 'inbox');
    const savedCalendar = workspace.body.integrations.find(item => item.kind === 'calendar');
    assert.equal(savedInbox.config.imap_password_saved, true);
    assert.equal(savedCalendar.config.ics_url_saved, true);
    assert.ok(!Object.prototype.hasOwnProperty.call(savedInbox, 'secrets'));
  });

  it('saves and verifies a custom domain plan', async () => {
    const saved = await PATCH(`/api/businesses/${bizId}/infrastructure/domain`, {
      customDomain: 'app.testsaas.dev',
      dnsProvider: 'Cloudflare',
      notes: 'Use orange-cloud proxy off'
    }, tokens.access);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.asset.config.custom_domain, 'app.testsaas.dev');
    assert.equal(saved.body.asset.status, 'action_required');
    assert.ok(Array.isArray(saved.body.asset.config.dns_records));
    assert.ok(saved.body.asset.config.dns_records.length >= 1);

    const verified = await POST(`/api/businesses/${bizId}/infrastructure/domain/verify`, {
      dnsConfirmed: true
    }, tokens.access);
    assert.equal(verified.status, 200);
    assert.equal(verified.body.asset.status, 'connected');
    assert.equal(verified.body.asset.config.active_domain, 'app.testsaas.dev');

    const business = await GET(`/api/businesses/${bizId}`, tokens.access);
    assert.equal(business.status, 200);
    assert.equal(business.body.business.web_url, 'https://app.testsaas.dev');
  });

  it('updates mailbox routing and sends a preview mailbox test', async () => {
    const saved = await PATCH(`/api/businesses/${bizId}/infrastructure/mailbox`, {
      forwardingAddress: 'founder@testsaas.dev',
      replyTo: 'reply@testsaas.dev',
      senderName: 'Test SaaS Ops'
    }, tokens.access);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.asset.config.forwarding_address, 'founder@testsaas.dev');
    assert.equal(saved.body.asset.status, 'preview');

    const tested = await POST(`/api/businesses/${bizId}/infrastructure/mailbox/test`, {
      recipient: 'alerts@testsaas.dev'
    }, tokens.access);
    assert.equal(tested.status, 200);
    assert.equal(tested.body.preview, true);
    assert.equal(tested.body.target, 'alerts@testsaas.dev');
    assert.equal(tested.body.asset.checks.last_test_status, 'success');
  });

  it('updates deployment controls, logs a release, and records a smoke check', async () => {
    const saved = await PATCH(`/api/businesses/${bizId}/infrastructure/deployment`, {
      provider: 'track-only',
      targetUrl: 'https://app.testsaas.dev',
      smokePath: '/health',
      repoUrl: 'https://github.com/example/testsaas',
      gitBranch: 'main',
      buildCommand: 'npm run build',
      outputDirectory: 'ventura'
    }, tokens.access);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.asset.kind, 'deployment');
    assert.equal(saved.body.asset.config.target_url, 'https://app.testsaas.dev');
    assert.equal(saved.body.asset.status, 'configured');

    const release = await POST(`/api/businesses/${bizId}/infrastructure/deployment/release`, {
      versionNote: 'Ship founder inbox improvements',
      filesChanged: 4
    }, tokens.access);
    assert.equal(release.status, 200);
    assert.ok(release.body.deployment.version);
    assert.equal(release.body.asset.checks.last_release_note, 'Ship founder inbox improvements');

    const smoke = await POST(`/api/businesses/${bizId}/infrastructure/deployment/smoke`, {
      path: '/health'
    }, tokens.access);
    assert.equal(smoke.status, 200);
    assert.equal(smoke.body.preview, true);
    assert.equal(smoke.body.asset.checks.last_smoke_status, 'success');
    assert.equal(smoke.body.asset.config.smoke_path, '/health');
  });

  it('updates analytics settings and records a test event', async () => {
    const saved = await PATCH(`/api/businesses/${bizId}/infrastructure/analytics`, {
      provider: 'plausible',
      site: 'app.testsaas.dev',
      dashboardUrl: 'https://plausible.io/app.testsaas.dev',
      measurementId: 'plausible-site-id'
    }, tokens.access);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.asset.config.provider, 'plausible');
    assert.equal(saved.body.asset.status, 'configured');

    const tested = await POST(`/api/businesses/${bizId}/infrastructure/analytics/test`, {}, tokens.access);
    assert.equal(tested.status, 200);
    assert.equal(tested.body.asset.checks.last_test_status, 'success');
    assert.equal(tested.body.asset.checks.last_event_name, 'ventura_founder_test_event');
  });

  it('lets the founder update agent memory', async () => {
    const { status, body } = await PATCH(`/api/businesses/${bizId}/memory`, {
      priorities: ['Ship onboarding improvements', 'Close first 10 paying users'],
      learnings: ['Founder demo converts best when pricing is shown early'],
      competitors: ['Plausible — strong simplicity positioning'],
      customerInsights: ['Solo founders want setup under 10 minutes'],
      notes: ['Bias toward experiments that improve activation']
    }, tokens.access);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.memory.priorities));
    assert.equal(body.memory.priorities[0], 'Ship onboarding improvements');

    const snapshot = await GET(`/api/businesses/${bizId}/operating-system`, tokens.access);
    assert.equal(snapshot.status, 200);
    assert.ok(snapshot.body.memory.priorities.includes('Close first 10 paying users'));
    assert.ok(snapshot.body.memory.customer_insights.includes('Solo founders want setup under 10 minutes'));
  });

  it('updates recurring cadence controls and surfaces them in the operating system', async () => {
    const updated = await PATCH(`/api/businesses/${bizId}/cadence`, {
      mode: 'hourly',
      intervalHours: 6,
      preferredHourUtc: 4
    }, tokens.access);
    assert.equal(updated.status, 200);
    assert.equal(updated.body.cadence.mode, 'hourly');
    assert.equal(updated.body.cadence.interval_hours, 6);

    const snapshot = await GET(`/api/businesses/${bizId}/operating-system`, tokens.access);
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.cadence.mode, 'hourly');
    assert.equal(snapshot.body.cadence.interval_hours, 6);
    assert.ok(snapshot.body.cadence.next_run_at);
  });

  it('stores workspace sync settings and syncs inbox, calendar, and accounting context', async () => {
    const inbox = await PATCH(`/api/businesses/${bizId}/integrations/workspace/inbox`, {
      provider: 'preview-inbox',
      inboxAddress: 'support@testsaas.dev',
      supportAliases: ['sales@testsaas.dev', 'success@testsaas.dev'],
      syncMode: 'hourly',
      syncIntervalHours: 6,
      automationEnabled: true
    }, tokens.access);
    assert.equal(inbox.status, 200);
    assert.equal(inbox.body.integration.kind, 'inbox');
    assert.equal(inbox.body.integration.config.inbox_address, 'support@testsaas.dev');
    assert.equal(inbox.body.integration.config.sync_mode, 'hourly');
    assert.equal(inbox.body.integration.config.sync_interval_hours, 6);

    const calendar = await PATCH(`/api/businesses/${bizId}/integrations/workspace/calendar`, {
      provider: 'preview-calendar',
      calendarLabel: 'Founder ops calendar',
      calendarId: 'primary',
      syncMode: 'daily',
      syncIntervalHours: 12,
      automationEnabled: true
    }, tokens.access);
    assert.equal(calendar.status, 200);
    assert.equal(calendar.body.integration.kind, 'calendar');
    assert.equal(calendar.body.integration.config.calendar_id, 'primary');
    assert.equal(calendar.body.integration.config.sync_mode, 'daily');

    const accounting = await PATCH(`/api/businesses/${bizId}/integrations/workspace/accounting`, {
      provider: 'preview-ledger',
      accountLabel: 'Main operating ledger',
      accountExternalId: 'ledger-001',
      syncMode: 'derived',
      syncIntervalHours: 24,
      automationEnabled: true
    }, tokens.access);
    assert.equal(accounting.status, 200);
    assert.equal(accounting.body.integration.kind, 'accounting');
    assert.equal(accounting.body.integration.config.account_external_id, 'ledger-001');
    assert.equal(accounting.body.integration.config.sync_mode, 'derived');

    const sync = await POST(`/api/businesses/${bizId}/workspace/sync`, {
      kinds: ['inbox', 'calendar', 'accounting']
    }, tokens.access);
    assert.equal(sync.status, 200);
    assert.equal(sync.body.results.length, 3);
    assert.ok(sync.body.snapshot.summary.last_sync_at);
    assert.ok(sync.body.snapshot.inbox.length >= 1);
    assert.ok(sync.body.snapshot.calendar.length >= 1);
    assert.ok(sync.body.snapshot.accounting.length >= 1);
    assert.ok(Array.isArray(sync.body.syncPlan));
    assert.ok(sync.body.syncPlan.some(item => item.kind === 'inbox'));

    const workspace = await GET(`/api/businesses/${bizId}/workspace`, tokens.access);
    assert.equal(workspace.status, 200);
    assert.ok(Array.isArray(workspace.body.workspace.inbox));
    assert.ok(Array.isArray(workspace.body.workspace.calendar));
    assert.ok(Array.isArray(workspace.body.workspace.accounting));
    assert.ok(Array.isArray(workspace.body.syncPlan));
    assert.ok(workspace.body.automation.summary);
    assert.ok(workspace.body.integrations.some(item => item.kind === 'inbox'));

    const operating = await GET(`/api/businesses/${bizId}/operating-system`, tokens.access);
    assert.equal(operating.status, 200);
    assert.ok(operating.body.operations.workspace.summary.inbox_attention >= 0);
    assert.ok(operating.body.workspace.summary.upcoming_events >= 1);
  });

  it('turns synced workspace signals into deduped operating tasks', async () => {
    const first = await POST(`/api/businesses/${bizId}/workspace/automation/run`, {}, tokens.access);
    assert.equal(first.status, 200);
    assert.ok(first.body.automation.summary.open_actions >= 1);
    const automationTaskIds = first.body.automation.actions
      .map(item => item.task_id)
      .filter(Boolean);
    assert.ok(automationTaskIds.length >= 1);

    const tasksBefore = await GET(`/api/businesses/${bizId}/tasks`, tokens.access);
    assert.equal(tasksBefore.status, 200);
    assert.ok(automationTaskIds.every(taskId => tasksBefore.body.tasks.some(task => task.id === taskId)));

    const second = await POST(`/api/businesses/${bizId}/workspace/automation/run`, {}, tokens.access);
    assert.equal(second.status, 200);
    const secondTaskIds = second.body.automation.actions
      .map(item => item.task_id)
      .filter(Boolean);

    const tasksAfter = await GET(`/api/businesses/${bizId}/tasks`, tokens.access);
    assert.equal(secondTaskIds.length, automationTaskIds.length);
    assert.ok(secondTaskIds.every(taskId => tasksAfter.body.tasks.some(task => task.id === taskId)));

    const operating = await GET(`/api/businesses/${bizId}/operating-system`, tokens.access);
    assert.equal(operating.status, 200);
    assert.ok(operating.body.workspace_automation.summary.open_actions >= 1);
    assert.ok(Array.isArray(operating.body.operations.workspace_automation.actions));
  });

  it('can approve a pending founder action', async () => {
    const { createApproval } = await import('../src/agents/approvals.js');
    const approval = await createApproval({
      businessId: bizId,
      actionType: 'send_email',
      title: 'Email a lead',
      summary: 'Approve a follow-up email',
      payload: {
        to: 'alice@example.com',
        subject: 'Checking in',
        body: '<p>Hello from Ventura</p>'
      }
    });
    approvalId = approval.id;

    const { status, body } = await POST(`/api/businesses/${bizId}/approvals/${approvalId}/decision`, {
      decision: 'approve'
    }, tokens.access);
    assert.equal(status, 200);
    assert.equal(body.approval.status, 'executed');
  });

  it('journals idempotent operations and exposes them in the control center', async () => {
    const {
      runGuardedOperation,
      listActionOperations,
      getActionOperationSummary
    } = await import('../src/agents/action-operations.js');

    let calls = 0;
    const first = await runGuardedOperation({
      businessId: bizId,
      actionType: 'send_email',
      summary: 'Idempotent founder follow-up',
      payload: {
        to: 'repeat@example.com',
        subject: 'Checking in again',
        body: '<p>Hello from Ventura</p>'
      },
      execute: async () => {
        calls += 1;
        return { provider: 'test-smtp', accepted: ['repeat@example.com'] };
      }
    });

    const second = await runGuardedOperation({
      businessId: bizId,
      actionType: 'send_email',
      summary: 'Idempotent founder follow-up',
      payload: {
        to: 'repeat@example.com',
        subject: 'Checking in again',
        body: '<p>Hello from Ventura</p>'
      },
      execute: async () => {
        calls += 1;
        return { provider: 'should-not-run' };
      }
    });

    assert.equal(calls, 1);
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);

    const operations = listActionOperations(bizId, 10);
    const journaled = operations.find(item => item.summary === 'Idempotent founder follow-up');
    assert.ok(journaled);
    assert.equal(journaled.status, 'succeeded');
    assert.equal(journaled.replay_count, 1);

    const summary = getActionOperationSummary(bizId);
    assert.ok(summary.total >= 1);
    assert.ok(summary.replayed >= 1);

    const control = await GET(`/api/businesses/${bizId}/control-center`, tokens.access);
    assert.equal(control.status, 200);
    assert.ok(Array.isArray(control.body.operations));
    assert.ok(control.body.operationSummary);
    assert.ok(control.body.operations.some(item => item.summary === 'Idempotent founder follow-up'));
  });

  it('records task recovery cases and lets the founder requeue them', async () => {
    const { getDb } = await import('../src/db/migrate.js');
    const { openRecoveryCase } = await import('../src/agents/recovery.js');

    const db = getDb();
    const failedTaskId = 'failed-task-retry-1';
    db.prepare(`
      INSERT INTO tasks (
        id, business_id, title, description, department, status, triggered_by, priority, error
      ) VALUES (?, ?, ?, ?, ?, 'failed', 'agent', 5, ?)
    `).run(
      failedTaskId,
      bizId,
      'Retry founder inbox follow-up',
      'Recover from a transient provider issue',
      'operations',
      'SMTP timeout'
    );

    const recoveryCase = openRecoveryCase({
      businessId: bizId,
      sourceType: 'task',
      sourceId: failedTaskId,
      severity: 'attention',
      title: 'Task failed: Retry founder inbox follow-up',
      summary: 'SMTP timeout',
      detail: { taskId: failedTaskId, error: 'SMTP timeout' },
      retryAction: {
        type: 'task',
        taskId: failedTaskId
      }
    });

    const recovery = await GET(`/api/businesses/${bizId}/recovery?status=all`, tokens.access);
    assert.equal(recovery.status, 200);
    assert.ok(recovery.body.summary);
    assert.ok(recovery.body.cases.some(item => item.id === recoveryCase.id));

    const snapshot = await GET(`/api/businesses/${bizId}/operating-system`, tokens.access);
    assert.equal(snapshot.status, 200);
    assert.ok(snapshot.body.operations.recovery_cases.some(item => item.id === recoveryCase.id));

    const retry = await POST(`/api/businesses/${bizId}/recovery/${recoveryCase.id}/retry`, {}, tokens.access);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.kind, 'task');
    assert.equal(retry.body.status, 'queued');

    const retriedTask = db.prepare('SELECT status, error FROM tasks WHERE id = ?').get(failedTaskId);
    assert.equal(retriedTask.status, 'queued');
    assert.equal(retriedTask.error, null);
  });

  it('records failed actions as recovery cases and resolves them after a retry', async () => {
    const {
      runGuardedOperation
    } = await import('../src/agents/action-operations.js');
    const {
      getRecoveryCaseById,
      listRecoveryCases
    } = await import('../src/agents/recovery.js');

    try {
      await runGuardedOperation({
        businessId: bizId,
        actionType: 'send_email',
        summary: 'Recovery candidate email',
        payload: {
          from: 'ops@testsaas.dev',
          to: 'recover@example.com',
          subject: 'Recovery candidate',
          body: '<p>Testing recovery flow</p>'
        },
        execute: async () => {
          throw new Error('SMTP outage');
        }
      });
      assert.fail('Expected guarded operation to fail');
    } catch (err) {
      assert.match(err.message, /SMTP outage/);
    }

    const recoveryCase = listRecoveryCases(bizId, { limit: 20 })
      .find(item => item.title.includes('Recovery candidate email'));
    assert.ok(recoveryCase);
    assert.equal(recoveryCase.retryable, true);

    const retry = await POST(`/api/businesses/${bizId}/recovery/${recoveryCase.id}/retry`, {}, tokens.access);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.kind, 'operation');
    assert.equal(retry.body.operation.status, 'succeeded');

    const resolved = getRecoveryCaseById(recoveryCase.id);
    assert.equal(resolved.status, 'resolved');
  });

  it('blocks Stripe onboarding when Stripe is not configured', async () => {
    const { status, body } = await POST(`/api/businesses/${bizId}/stripe/onboarding`, {}, tokens.access);
    assert.equal(status, 503);
    assert.match(body.error, /stripe/i);
  });

  it('returns a safe Stripe status snapshot even without live Stripe config', async () => {
    const { status, body } = await GET(`/api/businesses/${bizId}/stripe/status`, tokens.access);
    assert.equal(status, 200);
    assert.ok(body.stripe);
    assert.equal(body.status, 'mocked');
    assert.equal(body.stripe.mocked, true);
  });

  it('blocks Stripe dashboard login when Connect is not configured', async () => {
    const { status, body } = await POST(`/api/businesses/${bizId}/stripe/dashboard`, {}, tokens.access);
    assert.equal(status, 503);
    assert.match(body.error, /stripe/i);
  });
});

describe('Portfolio overview', () => {
  it('returns multi-business summary data for the founder', async () => {
    const { status, body } = await GET('/api/portfolio/overview', tokens.access);
    assert.equal(status, 200);
    assert.ok(body.summary);
    assert.ok(Array.isArray(body.businesses));
    assert.ok(body.plan);
    assert.ok(body.usage);
    assert.equal(body.summary.businesses, 1);
  });
});

// ─── PUBLIC LIVE BOARD ───────────────────────────────────────────────────────
describe('Public live board', () => {

  it('returns public feed, business snapshots, and summary stats', async () => {
    const { status, body } = await GET('/api/live');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.feed));
    assert.ok(Array.isArray(body.businesses));
    assert.ok(Array.isArray(body.specialists));
    assert.ok(body.summary);
    assert.ok(body.summary.active_businesses >= 1);
  });

  it('returns public detail for a live business slug', async () => {
    const { status, body } = await GET('/api/live/test-saas');
    assert.equal(status, 200);
    assert.ok(body.business);
    assert.equal(body.business.slug, 'test-saas');
    assert.ok(body.infrastructure);
    assert.ok(Array.isArray(body.infrastructure.assets));
    assert.ok(Array.isArray(body.recentActivity));
    assert.ok(Array.isArray(body.integrations));
    assert.ok(Array.isArray(body.recentApprovals));
    assert.ok(body.approvalSummary);
    assert.ok(body.stats);
  });
});

// ─── CHAT ─────────────────────────────────────────────────────────────────────
describe('Chat', () => {

  it('returns empty message history', async () => {
    const { status, body } = await GET(`/api/businesses/${bizId}/messages`, tokens.access);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.messages));
  });

  it('exposes persisted artifacts and task events for the founder runtime', async () => {
    const artifactsRes = await GET(`/api/businesses/${bizId}/artifacts`, tokens.access);
    assert.equal(artifactsRes.status, 200);
    assert.ok(Array.isArray(artifactsRes.body.artifacts));
    assert.ok(artifactsRes.body.artifacts.some(item => item.kind === 'launch_plan'));

    const eventsRes = await GET(`/api/businesses/${bizId}/task-events`, tokens.access);
    assert.equal(eventsRes.status, 200);
    assert.ok(Array.isArray(eventsRes.body.taskEvents));
    assert.ok(eventsRes.body.taskEvents.some(item => item.phase === 'queued'));
  });

  it('turns actionable founder chat into a queued Ventura task', async () => {
    const { status, body } = await POST(
      `/api/businesses/${bizId}/messages`,
      { content: 'Build a sharper landing page hero focused on investor matching and queue it now.' },
      tokens.access
    );
    assert.equal(status, 200);
    assert.equal(body.message.role, 'assistant');
    assert.ok(body.meta.queuedTaskId);

    const tasksRes = await GET(`/api/businesses/${bizId}/tasks`, tokens.access);
    assert.equal(tasksRes.status, 200);
    assert.ok(tasksRes.body.tasks.some(task => task.id === body.meta.queuedTaskId));
  });

  // Note: full chat test requires a real Anthropic API key
  // In CI with mock key, we just confirm the endpoint shape
  it('chat endpoint exists and requires auth', async () => {
    const { status } = await POST(`/api/businesses/${bizId}/messages`, { content: 'hello' });
    assert.equal(status, 401);
  });
});

describe('Agent runtime', () => {

  it('handles multi-step Anthropic tool loops without dropping tool results', async () => {
    const { getDb } = await import('../src/db/migrate.js');
    const { queueTask, getAllTasks } = await import('../src/agents/tasks.js');
    const { listArtifacts } = await import('../src/agents/artifacts.js');
    const { listTaskEvents } = await import('../src/agents/task-events.js');
    const { runTask, __setAgentClientForTests, __resetAgentClientForTests } = await import('../src/agents/brain.js');

    const db = getDb();
    const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(bizId);
    const taskId = await queueTask({
      businessId: bizId,
      business,
      title: 'Build launch narrative from live research',
      description: 'Research the market and turn it into a launch brief.',
      department: 'strategy',
      triggeredBy: 'agent'
    });
    const task = getAllTasks(bizId, 200).find(item => item.id === taskId);
    assert.ok(task);

    const calls = [];
    __setAgentClientForTests({
      messages: {
        create: async (payload) => {
          calls.push(JSON.parse(JSON.stringify(payload)));

          if (calls.length === 1) {
            return {
              stop_reason: 'tool_use',
              content: [
                { type: 'text', text: 'I am starting with live research.' },
                {
                  type: 'tool_use',
                  id: 'toolu_search',
                  name: 'web_search',
                  input: {
                    query: 'best landing page conversion tactics for B2B SaaS fundraising products',
                    purpose: 'market_research'
                  }
                }
              ]
            };
          }

          if (calls.length === 2) {
            return {
              stop_reason: 'tool_use',
              content: [
                { type: 'text', text: 'Research collected. I am turning it into an artifact and wrapping the task.' },
                {
                  type: 'tool_use',
                  id: 'toolu_content',
                  name: 'create_content',
                  input: {
                    type: 'report',
                    title: 'Launch brief',
                    content: 'Signal Match Studio should lead with warm investor introductions and faster fundraising outcomes.'
                  }
                },
                {
                  type: 'tool_use',
                  id: 'toolu_complete',
                  name: 'task_complete',
                  input: {
                    summary: 'Launch brief written from live research.',
                    next_steps: ['Stage landing page copy', 'Create founder outreach list']
                  }
                }
              ]
            };
          }

          throw new Error(`Unexpected Anthropic mock call ${calls.length}`);
        }
      }
    });

    try {
      const result = await runTask(task, business, null);
      assert.equal(result.summary, 'Launch brief written from live research.');
      assert.deepEqual(result.nextSteps, ['Stage landing page copy', 'Create founder outreach list']);
    } finally {
      __resetAgentClientForTests();
    }

    assert.equal(calls.length, 2);
    const secondCallMessages = calls[1].messages;
    const previousAssistant = secondCallMessages[secondCallMessages.length - 2];
    const toolResultMessage = secondCallMessages[secondCallMessages.length - 1];

    assert.equal(previousAssistant.role, 'assistant');
    assert.ok(previousAssistant.content.some(block => block.type === 'tool_use' && block.id === 'toolu_search'));
    assert.equal(toolResultMessage.role, 'user');
    assert.ok(Array.isArray(toolResultMessage.content));
    assert.equal(toolResultMessage.content[0].type, 'tool_result');
    assert.equal(toolResultMessage.content[0].tool_use_id, 'toolu_search');
    assert.ok(Array.isArray(toolResultMessage.content[0].content));
    assert.equal(toolResultMessage.content[0].content[0].type, 'text');

    const artifacts = listArtifacts(bizId, { taskId, limit: 10 });
    assert.ok(artifacts.some(item => item.kind === 'research'));
    assert.ok(artifacts.some(item => item.kind === 'content'));
    assert.ok(artifacts.some(item => item.kind === 'task_summary'));

    const events = listTaskEvents(bizId, { taskId, limit: 20 });
    assert.ok(events.some(item => item.phase === 'tool_started' && item.title.includes('web_search')));
    assert.ok(events.some(item => item.phase === 'tool_succeeded' && item.title.includes('create_content')));
    assert.ok(events.some(item => item.phase === 'tool_succeeded' && item.title.includes('task_complete')));
  });
});

describe('Published sites', () => {

  it('rejects placeholder website deploys', async () => {
    const { deployFiles } = await import('../src/integrations/deploy.js');

    await assert.rejects(
      () => deployFiles(bizId, [{ path: 'index.html', content: '<!-- see staged file -->' }], 'Broken placeholder deploy'),
      /Website deploy rejected/
    );
  });

  it('falls back to a generated public site when the latest published file is placeholder content', async () => {
    const { publishSiteFiles } = await import('../src/agents/artifacts.js');

    publishSiteFiles({
      businessId: bizId,
      files: [{ path: 'index.html', content: '<!-- see staged file -->' }],
      summary: 'Injected invalid placeholder file'
    });

    const res = await fetch(`${BASE}/sites/test-saas`);
    const body = await res.text();

    assert.equal(res.status, 200);
    assert.ok(!body.includes('<!-- see staged file -->'));
    assert.ok(
      body.includes('What makes the page convert')
      || body.includes('The page now moves like a product story')
      || body.includes('What makes the promise feel credible?')
    );
  });
});

// ─── BILLING ─────────────────────────────────────────────────────────────────
describe('Billing', () => {

  it('returns plans list', async () => {
    const { status, body } = await GET('/api/billing/plans', tokens.access);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.plans));
    assert.equal(body.plans.length, 3);
    assert.equal(body.current, 'trial');
    const builder = body.plans.find(plan => plan.id === 'builder');
    assert.equal(builder.stripe_price_id, null);
  });

  it('returns usage stats', async () => {
    const { status, body } = await GET('/api/billing/usage', tokens.access);
    assert.equal(status, 200);
    assert.ok(body.tasks);
    assert.ok(body.businesses);
    assert.equal(body.plan, 'trial');
  });

  it('blocks checkout without Stripe config', async () => {
    const { status } = await POST('/api/billing/checkout', { plan: 'builder' }, tokens.access);
    assert.equal(status, 503);
  });
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
describe('Health', () => {

  it('health endpoint returns ok', async () => {
    const { status, body } = await GET('/api/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.ok(body.ws, 'should include websocket stats');
  });
});

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
describe('WebSocket', () => {

  it('connects and sends hello', async () => {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://localhost:3099/ws');
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('WS hello timeout'));
      }, 3000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.event === 'hello') {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  });

  it('authenticates with JWT', async () => {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://localhost:3099/ws');
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Auth timeout'));
      }, 3000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.event === 'hello') {
          ws.send(JSON.stringify({ type: 'auth', token: tokens.access }));
        }
        if (msg.event === 'auth:ok') {
          assert.ok(msg.userId);
          clearTimeout(timer);
          ws.close();
          resolve();
        }
        if (msg.event === 'auth:fail') {
          clearTimeout(timer);
          ws.close();
          reject(new Error('WS auth failed'));
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  });

  it('subscribes to a business channel', async () => {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://localhost:3099/ws');
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Subscribe timeout'));
      }, 3000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.event === 'hello') {
          ws.send(JSON.stringify({ type: 'auth', token: tokens.access }));
        }
        if (msg.event === 'auth:ok') {
          ws.send(JSON.stringify({ type: 'subscribe', businessId: bizId }));
        }
        if (msg.event === 'subscribed') {
          assert.equal(msg.businessId, bizId);
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  });

  it('rejects subscribing to another users business', async () => {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://localhost:3099/ws');
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Ownership reject timeout'));
      }, 3000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.event === 'hello') {
          ws.send(JSON.stringify({ type: 'auth', token: tokens.access }));
        }
        if (msg.event === 'auth:ok') {
          ws.send(JSON.stringify({ type: 'subscribe', businessId: otherBizId }));
        }
        if (msg.event === 'error' && /not accessible/i.test(msg.message)) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  });

  it('rejects invalid JWT', async () => {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://localhost:3099/ws');
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Reject timeout'));
      }, 3000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.event === 'hello') {
          ws.send(JSON.stringify({ type: 'auth', token: 'bad.jwt.token' }));
        }
        if (msg.event === 'auth:fail') {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  });
});

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
describe('Rate limiting', () => {
  it('health endpoint is reachable (rate limiter not too aggressive)', async () => {
    // Fire 5 requests quickly — should all succeed
    const results = await Promise.all(
      Array(5).fill(null).map(() => GET('/api/health'))
    );
    assert.ok(results.every(r => r.status === 200));
  });
});
