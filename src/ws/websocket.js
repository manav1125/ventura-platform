// src/ws/websocket.js
// WebSocket server:
//   - Clients subscribe to a business or to their user account
//   - The server pushes activity, task updates, cycle events in real-time
//   - Heartbeat keeps connections alive

import { WebSocketServer, WebSocket } from 'ws';
import { verifyAccessToken } from '../auth/auth.js';
import { WS_HEARTBEAT_INTERVAL } from '../config.js';

// Active connections indexed two ways:
//   byUser:     userId -> Set<WebSocket>
//   byBusiness: businessId -> Set<WebSocket>
const byUser     = new Map();
const byBusiness = new Map();

let wss;
let heartbeat;

// ─── Initialise the WS server (attach to an HTTP server) ─────────────────────

export function initWebSocket(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleClientMessage(ws, msg);
      } catch (err) {
        ws.send(JSON.stringify({ event: 'error', message: 'Invalid JSON' }));
      }
    });

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('close', () => { cleanupConnection(ws); });
    ws.on('error', () => { cleanupConnection(ws); });

    // Ask client to authenticate immediately
    ws.send(JSON.stringify({ event: 'hello', message: 'Send auth message to subscribe' }));
  });

  // Heartbeat: ping all connections every WS_HEARTBEAT_INTERVAL ms
  heartbeat = setInterval(() => {
    if (!wss) { clearInterval(heartbeat); return; }
    wss.clients.forEach(ws => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
    });
  }, WS_HEARTBEAT_INTERVAL);

  console.log('🔌 WebSocket server initialised at /ws');
  return wss;
}

// ─── Handle incoming client messages ─────────────────────────────────────────

function handleClientMessage(ws, msg) {
  switch (msg.type) {

    case 'auth': {
      // Client sends: { type: 'auth', token: '<jwt>' }
      try {
        const payload = verifyAccessToken(msg.token);
        ws.userId = payload.sub;
        subscribe(ws, 'user', payload.sub);
        ws.send(JSON.stringify({ event: 'auth:ok', userId: payload.sub }));
      } catch {
        ws.send(JSON.stringify({ event: 'auth:fail', message: 'Invalid token' }));
      }
      break;
    }

    case 'subscribe': {
      // Client sends: { type: 'subscribe', businessId: '...' }
      if (!ws.userId) {
        ws.send(JSON.stringify({ event: 'error', message: 'Authenticate first' }));
        return;
      }
      // TODO: verify userId owns this businessId (add DB check in production)
      subscribe(ws, 'business', msg.businessId);
      ws.send(JSON.stringify({ event: 'subscribed', businessId: msg.businessId }));
      break;
    }

    case 'unsubscribe': {
      if (msg.businessId) unsubscribe(ws, 'business', msg.businessId);
      break;
    }

    case 'ping': {
      ws.send(JSON.stringify({ event: 'pong' }));
      break;
    }
  }
}

// ─── Subscribe / unsubscribe ──────────────────────────────────────────────────

function subscribe(ws, type, id) {
  const map = type === 'user' ? byUser : byBusiness;
  if (!map.has(id)) map.set(id, new Set());
  map.get(id).add(ws);

  // Track on the ws object for cleanup
  if (!ws._subs) ws._subs = [];
  ws._subs.push({ type, id });
}

function unsubscribe(ws, type, id) {
  const map = type === 'user' ? byUser : byBusiness;
  map.get(id)?.delete(ws);
}

function cleanupConnection(ws) {
  if (ws._subs) {
    for (const { type, id } of ws._subs) {
      const map = type === 'user' ? byUser : byBusiness;
      map.get(id)?.delete(ws);
    }
  }
}

// ─── Emit helpers (used throughout the backend) ───────────────────────────────

export function emitToBusiness(businessId, payload) {
  const clients = byBusiness.get(businessId);
  if (!clients?.size) return;
  const msg = JSON.stringify(payload);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

export function emitToUser(userId, payload) {
  const clients = byUser.get(userId);
  if (!clients?.size) return;
  const msg = JSON.stringify(payload);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

export function broadcast(payload) {
  if (!wss) return;
  const msg = JSON.stringify(payload);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

export function getStats() {
  return {
    totalConnections: wss?.clients?.size || 0,
    userChannels: byUser.size,
    businessChannels: byBusiness.size
  };
}

export function closeWebSocket() {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  if (wss) {
    wss.clients.forEach(ws => ws.terminate());
    wss.close();
    wss = null;
  }
  byUser.clear();
  byBusiness.clear();
}
