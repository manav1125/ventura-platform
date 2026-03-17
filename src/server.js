// src/server.js
// Ventura Backend — Main entry point
// Starts Express, WebSocket, cron scheduler, and DB migrations

import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { PORT, NODE_ENV, BASE_URL, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX } from './config.js';
import { closeDb, runMigrations } from './db/migrate.js';
import { closeWebSocket, initWebSocket } from './ws/websocket.js';
import { startAgentScheduler, stopAgentScheduler } from './agents/runner.js';
import routes from './routes/index.js';
import adminRoutes from './routes/admin.js';
import billingRoutes from './routes/billing.js';
import leadsRoutes from './routes/leads.js';

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();
const httpServer = http.createServer(app);
let started = false;

// ─── Middleware ───────────────────────────────────────────────────────────────

const allowedOrigins = NODE_ENV === 'production'
  ? [process.env.FRONTEND_URL, 'https://ventura.ai', 'https://www.ventura.ai'].filter(Boolean)
  : ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000'];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, true); // permissive in dev; tighten by removing this line in prod
  },
  credentials: true
}));

// Raw body for Stripe webhooks (must come before json parser)
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Simple in-memory rate limiter (replace with Redis in production)
const rateLimitMap = new Map();
app.use((req, res, next) => {
  const key = req.ip;
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  const timestamps = (rateLimitMap.get(key) || []).filter(t => t > windowStart);
  timestamps.push(now);
  rateLimitMap.set(key, timestamps);

  if (timestamps.length > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests. Slow down.' });
  }
  next();
});

// Request logger (dev only)
if (NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api', routes);
app.use('/api/admin', adminRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/businesses/:bizId/leads', leadsRoutes);

// Root
app.get('/', (req, res) => {
  res.json({
    name: 'Ventura API',
    version: '1.0.0',
    status: 'running',
    docs: `${BASE_URL}/api/health`
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function start() {
  if (started || httpServer.listening) return httpServer;
  started = true;

  console.log('\n🚀 Starting Ventura Backend...\n');

  // 1. Run DB migrations
  runMigrations();

  // 2. Init WebSocket on the same HTTP server
  initWebSocket(httpServer);

  // 3. Start cron-based agent scheduler
  startAgentScheduler();

  // 4. Start HTTP server
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(PORT, () => {
      httpServer.off('error', reject);
      console.log(`\n✅ Ventura Backend running`);
      console.log(`   HTTP:      ${BASE_URL}`);
      console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
      console.log(`   Env:       ${NODE_ENV}\n`);
      resolve();
    });
  });

  return httpServer;
}

const serverReady = start();

serverReady.catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

export default app;
export { httpServer, serverReady, start };

export async function shutdown() {
  stopAgentScheduler();
  closeWebSocket();
  if (httpServer.listening) {
    await new Promise((resolve, reject) => {
      httpServer.close(err => (err ? reject(err) : resolve()));
    });
  }
  closeDb();
  started = false;
}
