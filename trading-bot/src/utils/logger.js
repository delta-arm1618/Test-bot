'use strict';

const winston = require('winston');
const config = require('../../config');

const { combine, timestamp, printf, colorize, json, errors } = winston.format;

// ── Pretty format for development ─────────────────────────
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, module, ...meta }) => {
    const mod = module ? `[${module}] ` : '';
    const extras = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level} ${mod}${message}${extras}`;
  })
);

// ── JSON format for production (Sentry-friendly) ──────────
const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

const logger = winston.createLogger({
  level: config.logging.level,
  format: config.isProd ? prodFormat : devFormat,
  transports: [
    new winston.transports.Console(),
    ...(config.isProd ? [
      new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
      new winston.transports.File({ filename: 'logs/combined.log' }),
    ] : []),
  ],
});

/**
 * Create a child logger with a module context tag.
 * Usage: const log = createLogger('LeaderboardEngine');
 */
function createLogger(moduleName) {
  return logger.child({ module: moduleName });
}

module.exports = { logger, createLogger };
