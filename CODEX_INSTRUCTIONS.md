# Ventura Platform — Codex Setup Instructions

## What this is
A full-stack agentic business platform. Users describe a business idea, the platform
provisions infrastructure (website, database, email, Stripe) and runs AI agents
(Claude) autonomously every night to operate the business: coding, marketing,
operations, sales, strategy.

## Repo layout (after extracting the zip)
```
ventura-backend/          ← this is what becomes the GitHub repo root
├── src/
│   ├── server.js         ← Express API entry point (port from env, default 3001)
│   ├── config.js         ← all env vars
│   ├── agents/
│   │   ├── brain.js      ← Claude tool-use agent loop (11 tools)
│   │   ├── runner.js     ← nightly cron + cycle orchestrator
│   │   ├── tasks.js      ← task queue
│   │   └── activity.js   ← real-time activity logger
│   ├── auth/auth.js      ← JWT auth, bcrypt, refresh tokens
│   ├── db/
│   │   ├── migrate.js    ← SQLite schema (10 tables), run on startup
│   │   └── seed.js       ← demo data seeder
│   ├── integrations/
│   │   ├── email.js      ← nodemailer SMTP
│   │   ├── stripe.js     ← Stripe Connect + webhooks
│   │   ├── search.js     ← Brave Search API
│   │   ├── social.js     ← Twitter/LinkedIn posting
│   │   └── deploy.js     ← Vercel API for website deploys
│   ├── provisioning/
│   │   └── provision.js  ← spins up all infra for a new business
│   ├── routes/
│   │   ├── index.js      ← main REST API (auth, businesses, tasks, chat, metrics)
│   │   ├── admin.js      ← platform admin routes
│   │   ├── billing.js    ← Stripe subscriptions + plan management
│   │   └── leads.js      ← CRM pipeline per business
│   └── ws/websocket.js   ← WebSocket server (real-time events)
├── ventura/
│   ├── index.html        ← complete frontend (single file, no build needed)
│   └── config.js         ← frontend runtime config (set API URL here)
├── tests/
│   └── platform.test.js  ← 30 integration tests (Node built-in test runner)
├── render.yaml           ← Render Blueprint (auto-creates both services)
├── package.json
├── .env.example          ← all env vars documented
└── SETUP.md              ← human-readable deploy guide
```

---

## Task: Deploy to GitHub + Render

### Step 1 — Create GitHub repository

1. Create a new **public** GitHub repository named `ventura-platform`
2. Extract the zip. The contents of `ventura-backend/` become the repo root.
   - Do NOT push the `ventura-backend/` folder itself — push its *contents*
   - After push, `render.yaml` must be at the repo root, not at `ventura-backend/render.yaml`
3. Push all files to `main` branch

Verify the repo structure looks like:
```
ventura-platform/          ← repo root on GitHub
├── render.yaml            ← must be here at root
├── package.json
├── src/
├── ventura/
├── tests/
└── ...
```

### Step 2 — Deploy via Render Blueprint

1. Go to render.com → **New +** → **Blueprint**
2. Connect GitHub, select `ventura-platform` repo
3. Render reads `render.yaml` and proposes two services:
   - `ventura-api` (Node.js web service)
   - `ventura-frontend` (Static site)
4. When prompted for secret env vars, set:
   - `ANTHROPIC_API_KEY` = (the Anthropic API key provided separately)
   - `JWT_SECRET` = click **Generate** (Render creates a secure random value)
   - `FRONTEND_URL` = leave blank for now
5. Click **Apply** — both services deploy

### Step 3 — Connect frontend to backend

Once both services show green/live status:

1. Copy the `ventura-api` service URL (e.g. `https://ventura-api.onrender.com`)
2. Edit `ventura/config.js` in the GitHub repo:
   ```javascript
   window.VENTURA_CONFIG = {
     API_URL: "https://ventura-api.onrender.com",  // ← real URL here
     WS_URL:  null
   };
   ```
3. Commit → Render auto-redeploys frontend in ~30 seconds
4. In Render → `ventura-api` → **Environment** → add:
   - `FRONTEND_URL` = `https://ventura-frontend.onrender.com`
   - Save → API redeploys

### Step 4 — Verify

Check the API health endpoint:
```
GET https://ventura-api.onrender.com/api/health
Expected: {"status":"ok","timestamp":"...","ws":{...}}
```

Check the frontend loads at the ventura-frontend URL.

---

## Environment variables reference

### Required (nothing works without these)
| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key — get from console.anthropic.com |
| `JWT_SECRET` | Random 64-char string — use Render's Generate button |

### Set after first deploy
| Variable | Description |
|---|---|
| `FRONTEND_URL` | Full URL of the ventura-frontend Render service |

### Auto-set by render.yaml (do not override)
| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `10000` |
| `DB_PATH` | `/var/data/ventura.db` (persistent disk) |
| `AGENT_MODEL` | `claude-sonnet-4-6` |
| `AGENT_CRON_SCHEDULE` | `0 2 * * *` (2am nightly) |

### Optional (add later for full functionality)
| Variable | Description |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe payments + Connect |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature verification |
| `SMTP_HOST` | Email sending (use smtp.resend.com) |
| `SMTP_USER` | SMTP username (for Resend: "resend") |
| `SMTP_PASS` | SMTP password / API key |
| `BRAVE_SEARCH_API_KEY` | Web search for agent research |
| `VERCEL_TOKEN` | Auto-deploy business websites |

---

## How the platform works (for context)

### API endpoints
```
POST /api/auth/register          register user
POST /api/auth/login             login
GET  /api/auth/me                current user
POST /api/auth/refresh           refresh JWT

GET  /api/businesses             list user's businesses
POST /api/businesses             launch new business (async provisioning)
GET  /api/businesses/:id         get business details
PATCH /api/businesses/:id        update settings

POST /api/businesses/:id/run     trigger agent cycle manually
GET  /api/businesses/:id/cycles  agent cycle history
GET  /api/businesses/:id/tasks   task queue
POST /api/businesses/:id/tasks   add a task
GET  /api/businesses/:id/activity activity feed
GET  /api/businesses/:id/metrics  metrics + revenue
GET  /api/businesses/:id/messages chat history
POST /api/businesses/:id/messages send message to agent

GET  /api/billing/plans          pricing plans
POST /api/billing/checkout       Stripe checkout session
POST /api/billing/portal         Stripe customer portal
GET  /api/billing/usage          current usage vs plan limits

GET  /api/businesses/:id/leads   CRM leads list
POST /api/businesses/:id/leads   add lead

GET  /api/health                 health check
```

### WebSocket (ws://host/ws)
After connecting, client sends:
```json
{"type": "auth", "token": "<jwt>"}
{"type": "subscribe", "businessId": "<id>"}
```
Server pushes events: `activity:new`, `task:started`, `task:complete`,
`cycle:started`, `cycle:complete`, `revenue:new`, `message:new`,
`provisioning:step`, `provisioning:complete`

### Agent cycle (runs nightly at 2am)
1. For each active business: AI generates 3-5 tasks for today
2. Each task runs through Claude with 11 tools available:
   `web_search`, `write_code`, `deploy_website`, `send_email`,
   `post_social`, `add_lead`, `create_content`, `update_memory`,
   `update_metrics`, `flag_for_review`, `task_complete`
3. Claude loops until it calls `task_complete` or hits 12 iterations
4. Results logged to activity feed, pushed via WebSocket

---

## Running locally (for testing)

```bash
cd ventura-backend
npm install
cp .env.example .env
# Edit .env: set ANTHROPIC_API_KEY and JWT_SECRET at minimum
node src/db/seed.js    # seeds demo data
npm run dev            # starts server on port 3001
```

Open `ventura/index.html` directly in a browser (it uses relative /api paths).
Or serve it: `npx serve ventura -p 3000`

Run tests:
```bash
npm test
```

---

## Known limitations / future work

1. **SQLite** — works for MVP and small scale. Swap `better-sqlite3` for `pg`
   (PostgreSQL) for production scale. All queries use standard SQL.

2. **Render free tier spin-down** — API sleeps after 15min inactivity.
   The 2am cron will miss if service is asleep. Fix: upgrade ventura-api
   to Render Starter ($7/mo), or add UptimeRobot to ping /api/health every 10min.

3. **Website deployment** — `VERCEL_TOKEN` enables actual per-business website
   deploys via Vercel API. Without it, deploys are logged but files aren't
   published externally (works fine for demo/MVP).

4. **Social media** — Twitter/LinkedIn posting is implemented but needs
   OAuth tokens per business stored in DB. Works in demo mode (logs only).

5. **Email** — without SMTP config, emails log to console in dev mode.
   Add Resend.com SMTP credentials for real sending (free 3k emails/mo).
