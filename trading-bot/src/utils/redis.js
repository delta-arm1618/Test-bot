'use strict';

const Redis = require('ioredis');
const config = require('../../config');
const { createLogger } = require('./logger');

const log = createLogger('Redis');

const redis = new Redis(config.redis.url, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 10) return null;
    return Math.min(times * 200, 3000);
  },
});

redis.on('connect', () => log.info('Redis connected'));
redis.on('error', (err) => log.error('Redis error', { error: err.message }));
redis.on('reconnecting', () => log.warn('Redis reconnecting...'));

/**
 * Get a cached value. Returns parsed JSON or null.
 */
async function getCache(key) {
  const val = await redis.get(key);
  if (!val) return null;
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
}

/**
 * Set a cached value with optional TTL in seconds.
 */
async function setCache(key, value, ttlSeconds = null) {
  const serialized = JSON.stringify(value);
  if (ttlSeconds) {
    await redis.setex(key, ttlSeconds, serialized);
  } else {
    await redis.set(key, serialized);
  }
}

/**
 * Delete a cache key (or pattern-matched keys).
 */
async function delCache(...keys) {
  if (keys.length === 0) return;
  await redis.del(...keys);
}

/**
 * Invalidate all keys matching a pattern.
 */
async function invalidatePattern(pattern) {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
    log.debug(`Invalidated ${keys.length} cache keys matching ${pattern}`);
  }
}

async function testConnection() {
  await redis.connect();
  await redis.ping();
  log.info('Redis ping successful');
}

// ── Cache Key Factories ───────────────────────────────────
const CacheKeys = {
  leaderboard: (page) => `lb:page:${page}`,
  userRank: (userId) => `rank:${userId}`,
  weeklyScore: (userId, week, year) => `score:${userId}:${week}:${year}`,
  tierCount: (tier) => `tier:count:${tier}`,
  activeBoosts: (userId) => `boosts:${userId}`,
  season: (week, year) => `season:${week}:${year}`,
};

module.exports = { redis, getCache, setCache, delCache, invalidatePattern, testConnection, CacheKeys };
