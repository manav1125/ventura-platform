// src/config.js
import 'dotenv/config';

function required(key) {
  const val = process.env[key];
  if (!val && process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required env var: ${key}`);
  }
  return val || '';
}

export const PORT              = process.env.PORT || 3001;
export const NODE_ENV          = process.env.NODE_ENV || 'development';
export const BASE_URL          = process.env.BASE_URL || `http://localhost:${PORT}`;

export const JWT_SECRET        = process.env.JWT_SECRET || 'dev-secret-change-me';
export const JWT_EXPIRES_IN    = process.env.JWT_EXPIRES_IN || '7d';
export const BCRYPT_ROUNDS     = parseInt(process.env.BCRYPT_ROUNDS || '10');

export const DB_PATH           = process.env.DB_PATH || './ventura.db';

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
export const AGENT_MODEL       = process.env.AGENT_MODEL || 'claude-opus-4-6';
export const AGENT_MAX_TOKENS  = parseInt(process.env.AGENT_MAX_TOKENS || '8192');

export const STRIPE_SECRET_KEY        = process.env.STRIPE_SECRET_KEY || '';
export const STRIPE_WEBHOOK_SECRET    = process.env.STRIPE_WEBHOOK_SECRET || '';
export const STRIPE_PLATFORM_FEE_PCT  = parseInt(process.env.STRIPE_PLATFORM_FEE_PERCENT || '20');

export const SMTP_HOST  = process.env.SMTP_HOST || '';
export const SMTP_PORT  = parseInt(process.env.SMTP_PORT || '587');
export const SMTP_USER  = process.env.SMTP_USER || '';
export const SMTP_PASS  = process.env.SMTP_PASS || '';
export const SMTP_FROM  = process.env.SMTP_FROM || 'noreply@ventura.ai';

export const PLATFORM_DOMAIN         = process.env.PLATFORM_DOMAIN || 'ventura.ai';
export const AGENT_CRON_SCHEDULE     = process.env.AGENT_CRON_SCHEDULE || '0 2 * * *';
export const WS_HEARTBEAT_INTERVAL   = parseInt(process.env.WS_HEARTBEAT_INTERVAL || '30000');

export const RATE_LIMIT_WINDOW_MS    = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000');
export const RATE_LIMIT_MAX          = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100');

// Deployment
export const VERCEL_TOKEN            = process.env.VERCEL_TOKEN || '';
export const VERCEL_TEAM_ID          = process.env.VERCEL_TEAM_ID || '';

// Search
export const BRAVE_SEARCH_API_KEY    = process.env.BRAVE_SEARCH_API_KEY || '';

// Social
export const TWITTER_BEARER_TOKEN    = process.env.TWITTER_BEARER_TOKEN || '';
export const LINKEDIN_ACCESS_TOKEN   = process.env.LINKEDIN_ACCESS_TOKEN || '';
