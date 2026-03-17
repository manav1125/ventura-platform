// src/auth/auth.js
// JWT auth, registration, login, refresh tokens

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { JWT_SECRET, JWT_EXPIRES_IN, BCRYPT_ROUNDS } from '../config.js';
import { getDb } from '../db/migrate.js';

// ─── Token generation ────────────────────────────────────────────────────────

export function signAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

export function generateRefreshToken() {
  return uuid() + '-' + uuid();
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }
  const token = header.slice(7);
  try {
    const payload = verifyAccessToken(token);
    req.user = payload;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Optional auth — attaches user if token present, doesn't block if absent
export function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      req.user = verifyAccessToken(header.slice(7));
    } catch (_) {}
  }
  next();
}

// ─── User operations ─────────────────────────────────────────────────────────

export async function registerUser({ email, name, password }) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) throw new Error('EMAIL_TAKEN');

  const id = uuid();
  const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  db.prepare(`
    INSERT INTO users (id, email, name, password_hash, plan)
    VALUES (?, ?, ?, ?, 'trial')
  `).run(id, email.toLowerCase().trim(), name.trim(), password_hash);

  return { id, email, name };
}

export async function loginUser({ email, password }) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user) throw new Error('INVALID_CREDENTIALS');

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new Error('INVALID_CREDENTIALS');

  return user;
}

export function issueTokens(user) {
  const db = getDb();
  const accessToken = signAccessToken({ sub: user.id, email: user.email, plan: user.plan, role: user.is_admin ? 'admin' : 'user' });
  const refreshToken = generateRefreshToken();

  // Hash and store refresh token
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const tokenHash = Buffer.from(refreshToken).toString('base64');

  db.prepare(`
    INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(uuid(), user.id, tokenHash, expiresAt);

  return { accessToken, refreshToken };
}

export function rotateRefreshToken(rawToken) {
  const db = getDb();
  const tokenHash = Buffer.from(rawToken).toString('base64');
  const stored = db.prepare(`
    SELECT rt.*, u.* FROM refresh_tokens rt
    JOIN users u ON u.id = rt.user_id
    WHERE rt.token_hash = ? AND rt.expires_at > datetime('now')
  `).get(tokenHash);

  if (!stored) throw new Error('INVALID_REFRESH_TOKEN');

  // Rotate: delete old, issue new
  db.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?').run(tokenHash);
  return issueTokens({ id: stored.user_id, email: stored.email, plan: stored.plan });
}

export function getUserById(id) {
  const db = getDb();
  return db.prepare('SELECT id, email, name, plan, stripe_customer_id, created_at FROM users WHERE id = ?').get(id);
}
