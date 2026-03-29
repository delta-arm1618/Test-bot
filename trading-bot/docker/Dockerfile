# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Trading Competition Bot — Dockerfile
# Multi-stage build for lean production image
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# ── Stage 1: Builder ──────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json ./

# Install ALL deps (including devDeps needed for build)
RUN npm ci --include=dev

# Copy source
COPY . .

# ── Stage 2: Production ───────────────────────────────────
FROM node:20-alpine AS production

# Install security updates + dumb-init for proper PID 1 handling
RUN apk update && apk upgrade && apk add --no-cache dumb-init && rm -rf /var/cache/apk/*

# Create non-root user for security
RUN addgroup -S botgroup && adduser -S botuser -G botgroup

WORKDIR /app

# Copy only production deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application code from builder
COPY --from=builder /app/src ./src
COPY --from=builder /app/db ./db
COPY --from=builder /app/config ./config
COPY --from=builder /app/ea_mt4 ./ea_mt4

# Create uploads directory with correct permissions
RUN mkdir -p /app/uploads /app/logs && chown -R botuser:botgroup /app

# Switch to non-root user
USER botuser

# Expose HTTP port for EA webhook
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -q -O- http://localhost:3000/health | grep -q '"ok":true' || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
