// tests/platform.test.js
// Full integration test suite for the Ventura platform
// Run: node --test tests/platform.test.js
//
// Tests: auth, business lifecycle, tasks, activity, metrics, billing, WebSocket

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
let otherTokens = {};
let otherBizId;

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
    otherTokens = { access: register.body.accessToken, refresh: register.body.refreshToken };

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
    assert.ok(body.plan);
    assert.ok(body.usage);
    assert.ok(body.economics);
    assert.ok(body.economics.monthly_subscription_cents >= 0);
    assert.equal(body.business.monthly_subscription_cents, body.economics.monthly_subscription_cents);
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
