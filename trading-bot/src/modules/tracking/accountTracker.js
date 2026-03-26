'use strict';

const { query, transaction } = require('../../../db/pool');
const { upsertWeeklyScore, getCurrentWeek } = require('../leaderboard/scoreEngine');
const { parseMetaApiMetrics, parseEAWebhookPayload, isTradeSeasonValid } = require('./metricsParser');
const { encrypt, decrypt } = require('../../utils/crypto');
const { createLogger } = require('../../utils/logger');
const config = require('../../../config');
const dayjs = require('dayjs');

const log = createLogger('AccountTracker');

/**
 * Register a new broker account for a user.
 */
async function linkAccount(userId, { broker, accountId, metaapiId, credentialsPlain, server }) {
  // Check if user already has a linked account
  const { rows: existing } = await query(
    'SELECT id FROM broker_accounts WHERE user_id = $1 AND status != $2',
    [userId, 'suspended']
  );

  const isPrimary = existing.length === 0;
  const credentialsEnc = credentialsPlain ? encrypt(credentialsPlain) : null;

  const { rows } = await query(`
    INSERT INTO broker_accounts
      (user_id, broker, account_id, metaapi_id, credentials_enc, server, status, is_primary)
    VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
    ON CONFLICT (user_id, account_id, broker) DO UPDATE SET
      credentials_enc = EXCLUDED.credentials_enc,
      status = 'pending',
      updated_at = NOW()
    RETURNING *
  `, [userId, broker, accountId, metaapiId ?? null, credentialsEnc, server ?? null, isPrimary]);

  log.info(`Account linked: ${broker} account ${accountId} for user ${userId}`);
  return rows[0];
}

/**
 * Poll all active MetaApi accounts.
 * Called by cron every N minutes.
 */
async function pollAllMetaApiAccounts() {
  if (!config.metaapi.token) {
    log.debug('MetaApi token not configured, skipping poll');
    return;
  }

  const { rows: accounts } = await query(`
    SELECT ba.*, u.id as uid
    FROM broker_accounts ba
    JOIN users u ON u.id = ba.user_id
    WHERE ba.status = 'active'
      AND ba.broker IN ('mt4', 'mt5')
      AND ba.metaapi_id IS NOT NULL
      AND (ba.last_polled_at IS NULL OR ba.last_polled_at < NOW() - INTERVAL '${config.metaapi.pollIntervalMinutes} minutes')
    LIMIT 50
  `);

  log.debug(`Polling ${accounts.length} MetaApi accounts`);

  for (const account of accounts) {
    try {
      await pollSingleMetaApiAccount(account);
    } catch (err) {
      log.error(`Failed to poll account ${account.account_id}`, { error: err.message });
      await query(`
        UPDATE broker_accounts
        SET error_count = error_count + 1,
            last_error = $1,
            status = CASE WHEN error_count >= 5 THEN 'disconnected' ELSE status END
        WHERE id = $2
      `, [err.message, account.id]);
    }
  }
}

/**
 * Poll a single MetaApi account.
 */
async function pollSingleMetaApiAccount(account) {
  // Lazy-load MetaApi SDK to avoid startup crash if not installed
  let MetaApi;
  try {
    MetaApi = require('metaapi.cloud-sdk').default;
  } catch {
    log.warn('metaapi.cloud-sdk not installed — install with: npm install metaapi.cloud-sdk');
    return;
  }

  const api = new MetaApi(config.metaapi.token);
  const maAccount = await api.metatraderAccountApi.getAccount(account.metaapi_id);

  if (maAccount.state !== 'DEPLOYED') {
    await maAccount.deploy();
    await maAccount.waitDeployed();
  }

  const conn = maAccount.getRPCConnection();
  await conn.connect();
  await conn.waitSynchronized();

  const metrics = await conn.getMetrics();
  const parsedMetrics = parseMetaApiMetrics(metrics);

  // Get active boosts for this user
  const boosts = await getUserActiveBoosts(account.user_id);

  await upsertWeeklyScore(account.user_id, parsedMetrics, boosts);

  await query(`
    UPDATE broker_accounts
    SET last_polled_at = NOW(), error_count = 0, last_error = NULL, status = 'active'
    WHERE id = $1
  `, [account.id]);

  log.debug(`Polled MetaApi account ${account.account_id}: PnL=${parsedMetrics.pnlPct}%`);
}

/**
 * Handle incoming EA webhook POST.
 * This is the 100% FREE MT4/MT5 integration via custom Expert Advisor.
 */
async function handleEAWebhook(payload, secret) {
  // Validate shared secret
  if (payload.secret !== secret && secret !== payload.secret) {
    throw new Error('Invalid webhook secret');
  }

  const { rows: [account] } = await query(`
    SELECT ba.*, u.id as uid
    FROM broker_accounts ba
    JOIN users u ON u.id = ba.user_id
    WHERE ba.account_id = $1 AND ba.status = 'active'
  `, [payload.account_id]);

  if (!account) {
    throw new Error(`No active account found for ID: ${payload.account_id}`);
  }

  const parsedMetrics = parseEAWebhookPayload(payload);
  const boosts = await getUserActiveBoosts(account.user_id);

  // Get current season for trade validation
  const { week, year } = getCurrentWeek();
  const { rows: [season] } = await query(
    'SELECT * FROM seasons WHERE week_number = $1 AND year = $2 AND is_active = TRUE',
    [week, year]
  );

  // Save closed trades to DB with season validation
  if (payload.closed_trades?.length > 0) {
    for (const trade of payload.closed_trades) {
      const isValid = isTradeSeasonValid(trade, season);
      await query(`
        INSERT INTO trades
          (account_id, broker_trade_id, symbol, direction, open_time, close_time,
           open_price, close_price, volume, profit, profit_pct, leverage,
           is_open, is_season_valid, season_rule, week_number, year)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, FALSE, $13, $14, $15, $16)
        ON CONFLICT (account_id, broker_trade_id) DO NOTHING
      `, [
        account.id, trade.ticket, trade.symbol, trade.direction,
        trade.open_time, trade.close_time,
        trade.open_price, trade.close_price, trade.lots,
        trade.profit, trade.profit_pct ?? 0, trade.leverage ?? null,
        isValid, season?.rule_type ?? null, week, year,
      ]);
    }
  }

  await upsertWeeklyScore(account.user_id, parsedMetrics, boosts);

  await query(`
    UPDATE broker_accounts
    SET last_polled_at = NOW(), error_count = 0, status = 'active'
    WHERE id = $1
  `, [account.id]);

  log.info(`EA webhook processed for account ${payload.account_id}`);
  return { ok: true, score: parsedMetrics };
}

/**
 * Get a user's active boosts for score calculation.
 */
async function getUserActiveBoosts(userId) {
  const { rows } = await query(`
    SELECT boost_type, expires_at
    FROM user_boosts
    WHERE user_id = $1 AND is_active = TRUE
      AND (expires_at IS NULL OR expires_at > NOW())
      AND (used_at IS NULL)
  `, [userId]);

  return {
    scoreMultiplier: rows.some(b => b.boost_type === 'score_multiplier') ? 1.1 : 1.0,
    relegateImmune: rows.some(b => b.boost_type === 'relegate_immunity'),
    resetDrawdown: rows.some(b => b.boost_type === 'reset_drawdown'),
  };
}

/**
 * Get all linked accounts for a user.
 */
async function getUserAccounts(userId) {
  const { rows } = await query(`
    SELECT id, broker, account_id, server, status, last_polled_at, error_count, is_primary
    FROM broker_accounts
    WHERE user_id = $1
    ORDER BY is_primary DESC, created_at DESC
  `, [userId]);
  return rows;
}

module.exports = {
  linkAccount,
  pollAllMetaApiAccounts,
  handleEAWebhook,
  getUserActiveBoosts,
  getUserAccounts,
};
