'use strict';

/**
 * Rate Limiting Middleware
 * Sliding-window rate limiter backed by Redis.
 * Protects EA webhook and HTTP endpoints from abuse.
 */

const { redis } = require('../utils/redis');
const { createLogger } = require('../utils/logger');

const log = createLogger('RateLimit');

/**
 * Create a rate limiter Express middleware.
 *
 * @param {Object} opts
 * @param {number}   opts.windowMs    — Window in milliseconds
 * @param {number}   opts.maxRequests — Max requests allowed per window
 * @param {string}   [opts.keyPrefix] — Redis key prefix (default: 'rl')
 * @param {Function} [opts.keyFn]     — Custom key extractor fn(req) → string
 * @returns {Function} Express middleware
 */
function createRateLimiter(opts = {}) {
  const {
    windowMs    = 60_000,
    maxRequests = 60,
    keyPrefix   = 'rl',
    keyFn       = (req) => req.ip || req.socket?.remoteAddress || 'unknown',
  } = opts;

  const windowSecs = Math.ceil(windowMs / 1000);

  return async function rateLimitMiddleware(req, res, next) {
    const key = `${keyPrefix}:${keyFn(req)}`;

    try {
      const current = await redis.incr(key);

      if (current === 1) {
        // First request in this window — set TTL
        await redis.expire(key, windowSecs);
      }

      // Inform client of limits
      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - current));

      if (current > maxRequests) {
        const ttl = await redis.ttl(key);
        res.setHeader('Retry-After', ttl);
        log.warn('Rate limit exceeded', { key, current, ip: req.ip });
        return res.status(429).json({
          ok: false,
          error: 'Too many requests. Please wait before retrying.',
          retryAfterSeconds: ttl,
        });
      }

      next();
    } catch (err) {
      // Fail-open: if Redis is down, let the request through
      log.error('Rate limiter Redis error — failing open', { error: err.message });
      next();
    }
  };
}

// ── Pre-configured limiters ────────────────────────────────

/** EA Webhook — 120 req/min per account_id. The EA reports every N minutes. */
const eaWebhookLimiter = createRateLimiter({
  windowMs:    60_000,
  maxRequests: 120,
  keyPrefix:   'rl:ea',
  keyFn:       (req) => req.body?.account_id || req.ip,
});

/** Screenshot upload — 10 per hour per IP. */
const screenshotLimiter = createRateLimiter({
  windowMs:    3_600_000,
  maxRequests: 10,
  keyPrefix:   'rl:screenshot',
});

/** General API — 300 req/min per IP. */
const generalLimiter = createRateLimiter({
  windowMs:    60_000,
  maxRequests: 300,
  keyPrefix:   'rl:general',
});

module.exports = {
  createRateLimiter,
  eaWebhookLimiter,
  screenshotLimiter,
  generalLimiter,
};
