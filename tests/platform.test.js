// tests/platform.test.js
// Full integration test suite for the Ventura platform
// Run: node --test tests/platform.test.js
//
// Tests: auth, business lifecycle, tasks, activity, metrics, billing, WebSocket

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';

// ─── Test server setup ────────────────────────────────────────────────────────
process.env.NODE_ENV   = 'test';
process.env.DB_PATH    = ':memory:';
process.env.JWT_SECRET = 'test-secret-xyz';
process.env.ANTHROPIC_API_KEY = 'sk-test-placeholder';

const BASE = 'http://localhost:3099';
let server;
let tokens = {};
let bizId;

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

// ─── Bootstrap ────────────────────────────────────────────────────────────────
before(async () => {
  // Dynamically import and start the server on a test port
  process.env.PORT = '3099';
  process.env.BASE_URL = BASE;

  const { default: app } = await import('../src/server.js');
  // server is started inside server.js; give it a moment
  await new Promise(r => setTimeout(r, 800));
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
    tokens = { access: body.accessToken, refresh: body.refreshToken };
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

  it('404s on other users business', async () => {
    const { status } = await GET(`/api/businesses/nonexistent-id`, tokens.access);
    assert.equal(status, 404);
  });

  it('updates business settings', async () => {
    const { status } = await PATCH(`/api/businesses/${bizId}`, {
      goal90d: 'Updated goal: reach $1k MRR',
      involvement: 'review'
    }, tokens.access);
    assert.equal(status, 200);

    const { body } = await GET(`/api/businesses/${bizId}`, tokens.access);
    assert.equal(body.business.goal_90d, 'Updated goal: reach $1k MRR');
    assert.equal(body.business.involvement, 'review');
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
    assert.equal(status, 500); // validation error
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

// ─── CHAT ─────────────────────────────────────────────────────────────────────
describe('Chat', () => {

  it('returns empty message history', async () => {
    const { status, body } = await GET(`/api/businesses/${bizId}/messages`, tokens.access);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.messages));
  });

  // Note: full chat test requires a real Anthropic API key
  // In CI with mock key, we just confirm the endpoint shape
  it('chat endpoint exists and requires auth', async () => {
    const { status } = await POST(`/api/businesses/${bizId}/messages`, { content: 'hello' });
    assert.equal(status, 401);
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

  it('connects and sends hello', (t, done) => {
    const ws = new WebSocket('ws://localhost:3099/ws');
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.event === 'hello') {
        ws.close();
        done();
      }
    });
    ws.on('error', done);
    setTimeout(() => { ws.close(); done(new Error('WS hello timeout')); }, 3000);
  });

  it('authenticates with JWT', (t, done) => {
    const ws = new WebSocket('ws://localhost:3099/ws');
    let step = 0;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.event === 'hello') {
        ws.send(JSON.stringify({ type: 'auth', token: tokens.access }));
      }
      if (msg.event === 'auth:ok') {
        assert.ok(msg.userId);
        ws.close();
        done();
        step++;
      }
      if (msg.event === 'auth:fail') {
        ws.close();
        done(new Error('WS auth failed'));
      }
    });
    ws.on('error', done);
    setTimeout(() => { if (!step) { ws.close(); done(new Error('Auth timeout')); } }, 3000);
  });

  it('subscribes to a business channel', (t, done) => {
    const ws = new WebSocket('ws://localhost:3099/ws');
    let authed = false;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.event === 'hello') {
        ws.send(JSON.stringify({ type: 'auth', token: tokens.access }));
      }
      if (msg.event === 'auth:ok') {
        authed = true;
        ws.send(JSON.stringify({ type: 'subscribe', businessId: bizId }));
      }
      if (msg.event === 'subscribed') {
        assert.equal(msg.businessId, bizId);
        ws.close();
        done();
      }
    });
    ws.on('error', done);
    setTimeout(() => { ws.close(); done(new Error('Subscribe timeout')); }, 3000);
  });

  it('rejects invalid JWT', (t, done) => {
    const ws = new WebSocket('ws://localhost:3099/ws');
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.event === 'hello') {
        ws.send(JSON.stringify({ type: 'auth', token: 'bad.jwt.token' }));
      }
      if (msg.event === 'auth:fail') {
        ws.close();
        done();
      }
    });
    ws.on('error', done);
    setTimeout(() => { ws.close(); done(new Error('Reject timeout')); }, 3000);
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
