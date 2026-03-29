'use strict';

/**
 * HTTP Server — Bloc 4 (rate-limited, hardened)
 * REPLACES: src/http/server.js
 *
 * Changes vs Bloc 1:
 *  - Rate limiting on all endpoints (eaWebhookLimiter, screenshotLimiter, generalLimiter)
 *  - Input validation before processing
 *  - Sentry error capture via captureException
 *  - trust proxy for real IPs behind Nginx
 *  - Enhanced /health endpoint (DB + Redis + circuit breakers)
 *  - Global error handler (multer size errors, 500s)
 */

const express = require('express');
const multer  = require('multer');
const path    = require('path');

const { handleEAWebhook }   = require('../modules/tracking/accountTracker');
const { query }             = require('../../db/pool');
const { createLogger }      = require('../utils/logger');
const { eaWebhookLimiter, screenshotLimiter, generalLimiter } = require('../middleware/rateLimiter');
const { captureException }  = require('../middleware/monitoring');
const { getAllStatuses }     = require('../middleware/circuitBreaker');
const config                = require('../../config');

const log = createLogger('HTTPServer');
const app = express();

// ── Trust proxy (real IPs behind Nginx) ───────────────────
if (config.isProd) app.set('trust proxy', 1);

// ── Body parsing ───────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Global rate limit (300 req/min per IP) ─────────────────
app.use(generalLimiter);

// ── Multer — screenshot uploads ───────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, 'uploads/'),
  filename:    (_req, file, cb) => {
    const uid = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `screenshot-${uid}${path.extname(file.originalname)}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },   // 5 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('Only PNG, JPG, JPEG, WEBP images are allowed'));
    }
  },
});

// ─────────────────────────────────────────────────────────
// POST /webhook/ea
// Called by MT4/MT5 Expert Advisor on every poll interval or trade close.
// Rate limit: 120 req/min per account_id.
// ─────────────────────────────────────────────────────────
app.post('/webhook/ea', eaWebhookLimiter, async (req, res) => {
  // Basic payload validation
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ ok: false, error: 'Invalid JSON payload' });
  }
  if (!req.body.account_id || typeof req.body.account_id !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing field: account_id (string)' });
  }
  if (typeof req.body.balance !== 'number') {
    return res.status(400).json({ ok: false, error: 'Missing field: balance (number)' });
  }

  try {
    const result = await handleEAWebhook(req.body, config.http.secret);
    res.json({ ok: true, score: result.score });
  } catch (err) {
    if (err.message.includes('Invalid webhook secret')) {
      return res.status(401).json({ ok: false, error: 'Unauthorized — invalid secret' });
    }
    if (err.message.includes('No active account found')) {
      return res.status(404).json({ ok: false, error: err.message });
    }
    captureException(err, { endpoint: '/webhook/ea', accountId: req.body?.account_id, ip: req.ip });
    log.error('EA webhook error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /submit-screenshot
// Manual fallback for brokers without API.
// Rate limit: 10 per hour per IP.
// ─────────────────────────────────────────────────────────
app.post('/submit-screenshot', screenshotLimiter, upload.single('screenshot'), async (req, res) => {
  try {
    const { discord_id, week_number, year } = req.body;

    if (!discord_id) return res.status(400).json({ error: 'discord_id is required' });

    const { rows: [user] } = await query(
      'SELECT id FROM users WHERE discord_id = $1',
      [discord_id]
    );
    if (!user) return res.status(404).json({ error: 'User not found. Link your account first.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const parsedWeek = week_number ? parseInt(week_number, 10) : null;
    const parsedYear = year        ? parseInt(year, 10)        : null;

    if (parsedWeek && (parsedWeek < 1 || parsedWeek > 53)) {
      return res.status(400).json({ error: 'Invalid week_number (must be 1–53)' });
    }

    const imageUrl = `/uploads/${req.file.filename}`;
    await query(
      'INSERT INTO manual_submissions (user_id, image_url, week_number, year) VALUES ($1, $2, $3, $4)',
      [user.id, imageUrl, parsedWeek, parsedYear]
    );

    log.info('Screenshot submitted', { discordId: discord_id, week: parsedWeek });
    res.json({ ok: true, message: 'Screenshot submitted. An admin will review it within 24h.' });
  } catch (err) {
    captureException(err, { endpoint: '/submit-screenshot' });
    log.error('Screenshot upload error', { error: err.message });
    res.status(500).json({ error: 'Upload failed. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /health
// Used by Docker HEALTHCHECK, UptimeRobot, and Nginx probes.
// Returns 200 when healthy, 503 when degraded.
// ─────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const health = {
    ok: true,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    services: {},
    circuitBreakers: [],
  };

  // Database
  try {
    await query('SELECT 1');
    health.services.db = 'ok';
  } catch (err) {
    health.services.db = 'error';
    health.ok = false;
  }

  // Redis
  try {
    const { redis } = require('../utils/redis');
    await redis.ping();
    health.services.redis = 'ok';
  } catch {
    health.services.redis = 'error';
    health.ok = false;
  }

  // Circuit breakers (informational only — OPEN breakers don't fail health)
  try {
    health.circuitBreakers = getAllStatuses().map(b => ({
      name:  b.name,
      state: b.state,
    }));
  } catch {
    // Non-critical
  }

  res.status(health.ok ? 200 : 503).json(health);
});

// ── Static: uploaded screenshots ──────────────────────────
app.use('/uploads', express.static('uploads'));

// ── 404 catch-all ─────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error handler ──────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large (max 5 MB)' });
  }
  if (err.message?.startsWith('Only')) {
    return res.status(400).json({ error: err.message });
  }
  captureException(err, { handler: 'globalErrorHandler' });
  log.error('Unhandled HTTP error', { error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────
function startHTTPServer() {
  const port = config.http.port;
  app.listen(port, () => {
    log.info(`HTTP server listening on port ${port}`);
    log.info('Endpoints: POST /webhook/ea · POST /submit-screenshot · GET /health');
  });
}

module.exports = { app, startHTTPServer };
