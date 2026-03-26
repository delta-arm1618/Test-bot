'use strict';

require('dotenv').config();

/**
 * Central configuration module.
 * All env vars are validated here at startup — fail fast with clear errors.
 */

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optionalEnv(name, defaultValue) {
  return process.env[name] || defaultValue;
}

const config = {
  env: optionalEnv('NODE_ENV', 'development'),
  isProd: process.env.NODE_ENV === 'production',

  discord: {
    token: requireEnv('DISCORD_TOKEN'),
    clientId: requireEnv('DISCORD_CLIENT_ID'),
    guildId: requireEnv('GUILD_ID'),
    roles: {
      verifiedTrader: optionalEnv('ROLE_VERIFIED_TRADER', null),
      bronze: optionalEnv('ROLE_BRONZE', null),
      silver: optionalEnv('ROLE_SILVER', null),
      gold: optionalEnv('ROLE_GOLD', null),
      platinum: optionalEnv('ROLE_PLATINUM', null),
      diamond: optionalEnv('ROLE_DIAMOND', null),
      apex: optionalEnv('ROLE_APEX', null),
      admin: optionalEnv('ROLE_ADMIN', null),
    },
    channels: {
      announcements: optionalEnv('CHANNEL_ANNOUNCEMENTS', null),
      leaderboard: optionalEnv('CHANNEL_LEADERBOARD', null),
      battles: optionalEnv('CHANNEL_BATTLES', null),
    },
  },

  db: {
    url: requireEnv('DATABASE_URL'),
    poolMin: parseInt(optionalEnv('DB_POOL_MIN', '2')),
    poolMax: parseInt(optionalEnv('DB_POOL_MAX', '10')),
  },

  redis: {
    url: optionalEnv('REDIS_URL', 'redis://localhost:6379'),
    ttl: {
      leaderboard: parseInt(optionalEnv('REDIS_TTL_LEADERBOARD', '300')),
      session: parseInt(optionalEnv('REDIS_TTL_SESSION', '3600')),
    },
  },

  security: {
    aesKey: requireEnv('AES_SECRET_KEY'),
    jwtSecret: requireEnv('JWT_SECRET'),
  },

  metaapi: {
    token: optionalEnv('METAAPI_TOKEN', null),
    pollIntervalMinutes: parseInt(optionalEnv('METAAPI_POLL_INTERVAL_MINUTES', '15')),
  },

  http: {
    port: parseInt(optionalEnv('HTTP_PORT', '3000')),
    secret: requireEnv('HTTP_SECRET'),
  },

  scoring: {
    weights: {
      pnl: parseFloat(optionalEnv('WEIGHT_PNL', '0.4')),
      winRate: parseFloat(optionalEnv('WEIGHT_WINRATE', '0.3')),
      drawdown: parseFloat(optionalEnv('WEIGHT_DRAWDOWN', '0.2')),
      consistency: parseFloat(optionalEnv('WEIGHT_CONSISTENCY', '0.1')),
    },
  },

  tiers: {
    bronze: { name: 'Bronze', emoji: '🥉', minScore: 0, type: 'threshold', promoteScore: 500, relegateScore: null },
    silver: { name: 'Silver', emoji: '🥈', minScore: 500, type: 'threshold', promoteScore: 1200, relegateScore: 200 },
    gold: { name: 'Gold', emoji: '🥇', minScore: null, type: 'competitive', promoPct: parseInt(optionalEnv('GOLD_PROMO_PCT', '20')), relegPct: 10 },
    platinum: { name: 'Platinum', emoji: '💎', minScore: null, type: 'competitive', promoPct: parseInt(optionalEnv('PLAT_PROMO_PCT', '15')), relegPct: 10 },
    diamond: { name: 'Diamond', emoji: '💠', minScore: null, type: 'competitive', promoPct: parseInt(optionalEnv('DIAMOND_PROMO_PCT', '10')), relegPct: 8 },
    apex: { name: 'Apex Trader', emoji: '👑', minScore: null, type: 'competitive', promoPct: null, relegPct: 5 },
  },

  tierOrder: ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'apex'],

  invite: {
    requiredCount: parseInt(optionalEnv('INVITE_REQUIRED_COUNT', '2')),
    activeHours: parseInt(optionalEnv('INVITE_ACTIVE_HOURS', '24')),
  },

  logging: {
    level: optionalEnv('LOG_LEVEL', 'info'),
    sentryDsn: optionalEnv('SENTRY_DSN', null),
  },
};

// Validate scoring weights sum to ~1.0
const weightSum = Object.values(config.scoring.weights).reduce((a, b) => a + b, 0);
if (Math.abs(weightSum - 1.0) > 0.001) {
  throw new Error(`Scoring weights must sum to 1.0, got ${weightSum.toFixed(3)}`);
}

module.exports = config;
