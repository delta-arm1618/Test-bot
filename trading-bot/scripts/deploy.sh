#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Trading Competition Bot — VPS Deploy Script
# Tested on Ubuntu 22.04 / 24.04 LTS
#
# Usage:
#   chmod +x scripts/deploy.sh
#   ./scripts/deploy.sh          → Full fresh deploy
#   ./scripts/deploy.sh update   → Pull + restart bot only
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="/var/log/trading-bot-deploy.log"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[INFO]${NC} $*" | tee -a "$LOG_FILE"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*" | tee -a "$LOG_FILE"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" | tee -a "$LOG_FILE"; exit 1; }

# ── Update-only mode ──────────────────────────────────────
if [[ "${1:-}" == "update" ]]; then
  info "Update mode: pulling latest code and restarting bot..."
  cd "$REPO_DIR"

  git pull origin main || error "git pull failed"

  docker compose -f docker/docker-compose.yml build bot
  docker compose -f docker/docker-compose.yml up -d bot

  # Run migrations
  docker compose -f docker/docker-compose.yml exec bot node db/migrate.js

  info "✅ Bot updated and restarted."
  exit 0
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# FULL DEPLOY
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

info "=== Trading Competition Bot — Full Deploy ==="
info "Deploy directory: $REPO_DIR"

# ── Step 1: Check prerequisites ───────────────────────────
info "Step 1/7: Checking prerequisites..."

command -v docker  &>/dev/null || error "Docker not installed. Run: curl -fsSL https://get.docker.com | bash"
command -v git     &>/dev/null || error "Git not installed. Run: apt install -y git"

DOCKER_VERSION=$(docker --version | grep -oP '\d+\.\d+')
info "Docker: $DOCKER_VERSION ✓"

# ── Step 2: Validate .env ─────────────────────────────────
info "Step 2/7: Validating environment variables..."

ENV_FILE="$REPO_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$REPO_DIR/.env.example" "$ENV_FILE"
  warn ".env created from template. EDIT $ENV_FILE before continuing!"
  warn "Required: DISCORD_TOKEN, DISCORD_CLIENT_ID, GUILD_ID, AES_SECRET_KEY, JWT_SECRET, HTTP_SECRET"
  exit 1
fi

# Check required vars
REQUIRED_VARS=(DISCORD_TOKEN DISCORD_CLIENT_ID GUILD_ID DATABASE_URL AES_SECRET_KEY JWT_SECRET HTTP_SECRET)
for VAR in "${REQUIRED_VARS[@]}"; do
  if ! grep -qE "^${VAR}=.+" "$ENV_FILE" 2>/dev/null; then
    error "Missing required .env variable: $VAR"
  fi
done

# Validate AES key length (must be exactly 32 chars)
AES_KEY=$(grep "^AES_SECRET_KEY=" "$ENV_FILE" | cut -d= -f2 | tr -d '"' | tr -d "'")
if [[ ${#AES_KEY} -ne 32 ]]; then
  error "AES_SECRET_KEY must be exactly 32 characters (current: ${#AES_KEY})"
fi

info "Environment variables validated ✓"

# ── Step 3: Create directories ────────────────────────────
info "Step 3/7: Creating required directories..."
mkdir -p "$REPO_DIR/uploads" "$REPO_DIR/logs"
chmod 755 "$REPO_DIR/uploads" "$REPO_DIR/logs"
info "Directories ready ✓"

# ── Step 4: Build Docker images ───────────────────────────
info "Step 4/7: Building Docker images..."
cd "$REPO_DIR"
docker compose -f docker/docker-compose.yml build --no-cache
info "Images built ✓"

# ── Step 5: Start infrastructure ─────────────────────────
info "Step 5/7: Starting PostgreSQL and Redis..."
docker compose -f docker/docker-compose.yml up -d postgres redis

info "Waiting for PostgreSQL to be ready..."
RETRIES=30
until docker compose -f docker/docker-compose.yml exec -T postgres pg_isready -U "${POSTGRES_USER:-botuser}" 2>/dev/null; do
  RETRIES=$((RETRIES - 1))
  [[ $RETRIES -eq 0 ]] && error "PostgreSQL failed to start"
  sleep 2
done
info "PostgreSQL ready ✓"

# ── Step 6: Run migrations ────────────────────────────────
info "Step 6/7: Running database migrations..."
docker compose -f docker/docker-compose.yml run --rm bot node db/migrate.js
info "Migrations complete ✓"

# ── Step 7: Start all services ────────────────────────────
info "Step 7/7: Starting all services..."
docker compose -f docker/docker-compose.yml up -d

info "Waiting for bot health check..."
sleep 10

BOT_HEALTH=$(docker compose -f docker/docker-compose.yml exec -T bot wget -q -O- http://localhost:3000/health 2>/dev/null || echo "{}")
if echo "$BOT_HEALTH" | grep -q '"ok":true'; then
  info "Bot health check passed ✓"
else
  warn "Bot health check returned: $BOT_HEALTH"
  warn "Check logs: docker compose -f docker/docker-compose.yml logs bot"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
info "✅ Deploy complete!"
echo ""
echo "  Bot logs:   docker compose -f docker/docker-compose.yml logs -f bot"
echo "  DB shell:   docker compose -f docker/docker-compose.yml exec postgres psql -U \${POSTGRES_USER} -d \${POSTGRES_DB}"
echo "  Redis CLI:  docker compose -f docker/docker-compose.yml exec redis redis-cli"
echo "  Health:     curl http://localhost:3000/health"
echo ""
echo "Next steps:"
echo "  1. Deploy slash commands: docker compose exec bot node src/deploy-commands.js"
echo "  2. Configure Discord roles in .env and restart: ./scripts/deploy.sh update"
echo "  3. (Optional) Set up SSL: certbot certonly --webroot -w /var/www/html -d yourdomain.com"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
