# Ventura — Agentic Business Platform

## Backend Stack

```
ventura-backend/
├── src/
│   ├── server.js              ← Entry point: Express + HTTP + WS + cron
│   ├── config.js              ← All env vars in one place
│   ├── auth/
│   │   └── auth.js            ← JWT auth, register, login, refresh tokens
│   ├── db/
│   │   └── migrate.js         ← SQLite schema + migration runner
│   ├── agents/
│   │   ├── brain.js           ← Claude API agent loop (tool use)
│   │   ├── runner.js          ← Cron scheduler + cycle orchestrator
│   │   ├── tasks.js           ← Task queue CRUD
│   │   └── activity.js        ← Activity logger → DB + WebSocket
│   ├── provisioning/
│   │   └── provision.js       ← Spin up DB, email, website, Stripe per business
│   ├── ws/
│   │   └── websocket.js       ← WS server, user/business subscriptions, emit helpers
│   ├── integrations/
│   │   ├── email.js           ← Nodemailer SMTP wrapper + templates
│   │   └── stripe.js          ← Stripe Connect accounts + webhooks
│   └── routes/
│       └── index.js           ← All REST API routes
├── ventura-client.js          ← Frontend SDK (fetch + WebSocket)
├── .env.example               ← All env vars documented
└── package.json
```

---

## Quick Start

Public marketplace intake lives on the API-hosted `/sites/:slug` routes, so those landing-page forms only work after the API service has redeployed the latest commit.

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your keys (see below)
```

### 3. Start the server

```bash
npm run dev
```

Server starts at `http://localhost:3001`
WebSocket at `ws://localhost:3001/ws`

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Your Anthropic API key |
| `JWT_SECRET` | ✅ | Secret for signing JWTs (make it long and random) |
| `ADMIN_EMAILS` | Optional | Comma-separated emails that should get platform-admin access in the Ventura dashboard |
| `STRIPE_SECRET_KEY` | Optional | Stripe secret key for payments |
| `STRIPE_WEBHOOK_SECRET` | Optional | Stripe webhook signing secret |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Optional | SMTP config (defaults to console in dev) |
| `DB_PATH` | Optional | SQLite file path (default: `./ventura.db`) |
| `AGENT_CRON_SCHEDULE` | Optional | When to run the agent (default: `0 2 * * *` = 2am) |

---

## API Reference

### Authentication

```
POST /api/auth/register   { email, name, password }
POST /api/auth/login      { email, password }
POST /api/auth/refresh    { refreshToken }
GET  /api/auth/me         (requires Bearer token)
```

### Businesses

```
GET    /api/businesses              List all businesses
POST   /api/businesses              Launch new business
GET    /api/businesses/:id          Get one business
PATCH  /api/businesses/:id          Update settings
POST   /api/businesses/:id/run      Trigger agent cycle manually
GET    /api/businesses/:id/cycles   List agent cycles
```

### Tasks, Activity, Metrics, Chat

```
GET  /api/businesses/:id/tasks       List tasks
POST /api/businesses/:id/tasks       Queue a task
GET  /api/businesses/:id/activity    Activity feed
GET  /api/businesses/:id/metrics     Revenue + metrics
GET  /api/businesses/:id/messages    Chat history
POST /api/businesses/:id/messages    Send message to agent
```

### Webhooks

```
POST /api/webhooks/stripe   Stripe payment events
```

---

## WebSocket Protocol

Connect to `ws://localhost:3001/ws`

### Client → Server messages

```json
{ "type": "auth",      "token": "<jwt>" }
{ "type": "subscribe", "businessId": "<id>" }
{ "type": "ping" }
```

### Server → Client events

| Event | Payload |
|---|---|
| `auth:ok` | `{ userId }` |
| `provisioning:started` | `{ businessId, steps }` |
| `provisioning:step` | `{ step, status, businessId }` |
| `provisioning:complete` | `{ businessId }` |
| `cycle:started` | `{ cycleId, businessId }` |
| `cycle:complete` | `{ cycleId, tasksRun, errors, summary }` |
| `task:queued` | `{ id, title, department }` |
| `task:started` | `{ taskId, title }` |
| `task:complete` | `{ taskId, title, result }` |
| `activity:new` | `{ activity }` |
| `revenue:new` | `{ amountCents, total }` |
| `message:new` | `{ role, content, id }` |

---

## Frontend SDK Usage

```html
<script type="module">
  import ventura from './ventura-client.js';

  // Connect WebSocket
  ventura.connectWebSocket();

  // Register + login
  const user = await ventura.register('you@example.com', 'Your Name', 'password');

  // Launch a business
  await ventura.createBusiness({
    name: 'My SaaS',
    type: 'saas',
    description: 'A tool that helps...',
    targetCustomer: 'Indie hackers and solo founders',
    goal90d: 'Reach $1k MRR',
    involvement: 'autopilot'
  });

  // Get all businesses
  const businesses = await ventura.getBusinesses();

  // Subscribe to real-time updates for a business
  ventura.subscribeToBusiness(businesses[0].id);

  // Listen for live events
  ventura.on('activity:new', ({ activity }) => {
    console.log('New activity:', activity.title);
  });

  ventura.on('cycle:complete', ({ summary, tasksRun }) => {
    console.log(`Agent done: ${tasksRun} tasks. ${summary}`);
  });

  ventura.on('task:complete', ({ title, department }) => {
    console.log(`✓ ${department}: ${title}`);
  });

  // Trigger agent manually
  await ventura.runAgent(businesses[0].id);

  // Chat with your agent
  const reply = await ventura.sendMessage(businesses[0].id, 'What should we focus on this week?');
  console.log(reply.content);
</script>
```

---

## Agent Architecture

```
Nightly cron (2am)
    │
    ▼
runAllBusinesses()
    │
    ├─ for each active business:
    │      generateCycleTasks()  ← AI decides what to work on
    │          │
    │          └─ Claude (fast call): "Given this business + memory + recent activity,
    │                                  what 3-5 tasks should run today?"
    │
    └─ for each task:
           runTask(task, business)
               │
               └─ Claude (tool use loop):
                      system prompt = business context + memory
                      tools = write_code | deploy_website | send_email |
                              add_lead | create_content | update_memory |
                              flag_for_review | task_complete
                      
                      Agent loops until it calls task_complete or hits max iterations
                      Each tool call executes a real action (DB write, file deploy, email send)
                      Memory is updated with learnings after each cycle
```

---

## Production Deployment

### Recommended stack

| Layer | Service |
|---|---|
| API server | Railway / Render / Fly.io |
| Database | Supabase (Postgres) or PlanetScale |
| File storage | Cloudflare R2 |
| Email | Resend |
| Business websites | Vercel / Cloudflare Pages (one project per business) |
| Payments | Stripe Connect |
| WebSocket | Same server (or Ably/Pusher for scale) |

### Database swap (SQLite → Postgres)

Replace `better-sqlite3` with `pg` and update `getDb()` to return a Postgres pool.
All queries use standard SQL and are compatible.

### Per-business website deployment

In `stepScaffoldWebsite()` (provision.js):
1. Clone a starter template into a new repo via GitHub API
2. Deploy to Vercel via their API (`https://api.vercel.com/v13/deployments`)
3. Assign the `{slug}.ventura.ai` domain via Vercel's domains API

### Agent scaling

Currently runs businesses sequentially. For 100+ businesses:
- Add a job queue (BullMQ + Redis)  
- Run with concurrency of 5-10
- Consider Claude Haiku for task generation (cheaper) + Opus for execution

---

## Business Plan Limits

| Plan | Businesses | Tasks/mo | Rev share |
|---|---|---|---|
| Trial | 1 | 5 | - |
| Builder ($49/mo) | 3 | 30 | 20% |
| Fleet ($199/mo) | 10 | 100 | 15% |
