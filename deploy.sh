#!/bin/bash
# deploy.sh — One-command production deploy to Railway
# 
# Prerequisites:
#   - Railway CLI installed: npm install -g @railway/cli
#   - railway login completed
#   - .env file configured with all keys
#
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh [staging|production]

set -euo pipefail

ENV=${1:-staging}
echo ""
echo "🚀 Deploying Ventura to $ENV..."
echo ""

# ── Pre-flight checks ─────────────────────────────────────────────────────────

if [ ! -f ".env" ]; then
  echo "❌ .env file not found. Copy .env.example and fill in your values."
  exit 1
fi

if ! grep -q "ANTHROPIC_API_KEY=sk-" .env 2>/dev/null; then
  echo "⚠️  ANTHROPIC_API_KEY doesn't look right in .env"
fi

if ! grep -q "JWT_SECRET=" .env 2>/dev/null; then
  echo "❌ JWT_SECRET not set in .env"
  exit 1
fi

echo "✅ Pre-flight checks passed"
echo ""

# ── Option 1: Railway deploy ──────────────────────────────────────────────────
deploy_railway() {
  echo "📦 Deploying via Railway..."
  
  if ! command -v railway &> /dev/null; then
    echo "Installing Railway CLI..."
    npm install -g @railway/cli
  fi

  # Set all env vars from .env
  echo "Setting environment variables..."
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^#.*$ ]] && continue
    [[ -z "$key" ]] && continue
    railway variables set "$key=$value" --quiet 2>/dev/null || true
  done < .env

  railway up --detach
  
  echo ""
  echo "✅ Railway deploy initiated"
  echo "📊 Monitor at: https://railway.app/dashboard"
}

# ── Option 2: Docker Compose (VPS/dedicated) ──────────────────────────────────
deploy_docker() {
  echo "🐳 Deploying via Docker Compose..."
  
  docker-compose pull || true
  docker-compose build --no-cache
  docker-compose up -d
  
  echo ""
  echo "✅ Docker Compose deploy complete"
  echo "📊 Check status: docker-compose ps"
  echo "📋 View logs:    docker-compose logs -f api"
}

# ── Option 3: Bare Node.js (pm2) ──────────────────────────────────────────────
deploy_pm2() {
  echo "⚙️  Deploying via pm2..."
  
  npm ci --omit=dev
  node src/db/seed.js 2>/dev/null || true  # seed if DB empty

  if ! command -v pm2 &> /dev/null; then
    npm install -g pm2
  fi

  pm2 delete ventura 2>/dev/null || true
  pm2 start src/server.js \
    --name ventura \
    --instances 1 \
    --max-memory-restart 512M \
    --restart-delay 3000 \
    --env production
  pm2 save

  echo ""
  echo "✅ pm2 deploy complete"
  echo "📊 Status: pm2 status"
  echo "📋 Logs:   pm2 logs ventura"
}

# ── Run the deploy ─────────────────────────────────────────────────────────────
case "$ENV" in
  railway)   deploy_railway ;;
  docker)    deploy_docker  ;;
  pm2)       deploy_pm2     ;;
  staging)   deploy_railway ;;
  production)
    read -p "⚠️  Deploy to PRODUCTION? (yes/no): " confirm
    if [ "$confirm" = "yes" ]; then
      deploy_railway
    else
      echo "Deploy cancelled."
      exit 0
    fi
    ;;
  *)
    echo "Usage: ./deploy.sh [staging|production|railway|docker|pm2]"
    exit 1
    ;;
esac

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Ventura deployed to $ENV"
echo "  API:       \$BASE_URL/api/health"
echo "  WebSocket: ws://\$BASE_URL/ws"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
