'use strict';

const { Pool } = require('pg');
const config = require('../config');
const { createLogger } = require('../src/utils/logger');

const log = createLogger('Database');

const pool = new Pool({
  connectionString: config.db.url,
  min: config.db.poolMin,
  max: config.db.poolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: config.isProd ? { rejectUnauthorized: false } : false,
});

pool.on('connect', () => log.debug('New DB connection established'));
pool.on('error', (err) => log.error('Unexpected DB pool error', { error: err.message }));

/**
 * Execute a single query with optional parameters.
 * Automatically acquires + releases a connection from the pool.
 */
async function query(sql, params = []) {
  const start = Date.now();
  const result = await pool.query(sql, params);
  const duration = Date.now() - start;
  if (duration > 1000) {
    log.warn('Slow query detected', { sql: sql.substring(0, 80), duration });
  }
  return result;
}

/**
 * Execute multiple queries within a single transaction.
 * Automatically rolls back on error.
 *
 * @param {Function} fn - async (client) => { ... }
 */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function testConnection() {
  const { rows } = await query('SELECT NOW() as now');
  log.info('Database connected', { serverTime: rows[0].now });
}

module.exports = { pool, query, transaction, testConnection };
