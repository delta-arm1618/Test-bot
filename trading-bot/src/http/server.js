'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const { handleEAWebhook } = require('../modules/tracking/accountTracker');
const { query } = require('../../db/pool');
const { createLogger } = require('../utils/logger');
const config = require('../../config');

const log = createLogger('HTTPServer');
const app = express();

// ── Middleware ─────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Screenshot upload storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    cb(null, `screenshot-${unique}${path.extname(file.originalname)}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

// ── EA Webhook Endpoint ────────────────────────────────────
// Called by the MT4/MT5 Expert Advisor on every tick or close
app.post('/webhook/ea', async (req, res) => {
  try {
    const result = await handleEAWebhook(req.body, config.http.secret);
    res.json({ ok: true, score: result.score });
  } catch (err) {
    log.error('EA webhook error', { error: err.message, ip: req.ip });
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ── Screenshot Upload Endpoint ─────────────────────────────
app.post('/submit-screenshot', upload.single('screenshot'), async (req, res) => {
  try {
    const { discord_id, week_number, year } = req.body;

    const { rows: [user] } = await query(
      'SELECT id FROM users WHERE discord_id = $1',
      [discord_id]
    );

    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const imageUrl = `/uploads/${req.file.filename}`;

    await query(`
      INSERT INTO manual_submissions (user_id, image_url, week_number, year)
      VALUES ($1, $2, $3, $4)
    `, [user.id, imageUrl, week_number ?? null, year ?? null]);

    log.info(`Screenshot submitted by ${discord_id}`);
    res.json({ ok: true, message: 'Screenshot submitted. An admin will review it shortly.' });
  } catch (err) {
    log.error('Screenshot upload error', { error: err.message });
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ── Health Check ───────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const { query: dbQuery } = require('../../db/pool');
    await dbQuery('SELECT 1');
    res.json({ ok: true, uptime: process.uptime(), timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// ── Static uploads ─────────────────────────────────────────
app.use('/uploads', express.static('uploads'));

function startHTTPServer() {
  const port = config.http.port;
  app.listen(port, () => {
    log.info(`HTTP server listening on port ${port}`);
    log.info(`EA Webhook endpoint: POST http://your-server:${port}/webhook/ea`);
  });
}

module.exports = { app, startHTTPServer };
