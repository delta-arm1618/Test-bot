'use strict';

/**
 * Tradovate Connector
 * REST API for Tradovate paper/demo trading accounts.
 * Docs: https://api.tradovate.com
 *
 * Place in: src/modules/tracking/tradovateConnector.js
 */

const axios = require('axios');
const { createLogger } = require('../../utils/logger');
const { calculateConsistency } = require('../leaderboard/scoreEngine');
const { CircuitBreaker } = require('../../middleware/circuitBreaker');

const log = createLogger('TradovateConnector');

// Use demo API by default; set TRADOVATE_ENV=live for live accounts
const TRADOVATE_BASE = process.env.TRADOVATE_ENV === 'live'
  ? 'https://live.tradovateapi.com/v1'
  : 'https://demo.tradovateapi.com/v1';

const tradovateBreaker = new CircuitBreaker('Tradovate', {
  failureThreshold: 3,
  successThreshold: 2,
  timeout: 30_000,
});

/**
 * Authenticate with Tradovate and obtain an access token.
 * Store the returned token (encrypted) in broker_accounts.credentials_enc.
 *
 * @param {string} username
 * @param {string} password
 * @param {string} [appId='TradingBot']
 * @param {string} [appVersion='1.0']
 * @returns {string} accessToken
 */
async function authenticate(username, password, appId = 'TradingBot', appVersion = '1.0') {
  const body = {
    name:       username,
    password,
    appId,
    appVersion,
    cid: parseInt(process.env.TRADOVATE_CID ?? '0', 10),
    sec: process.env.TRADOVATE_SEC ?? '',
  };

  let resp;
  try {
    resp = await axios.post(`${TRADOVATE_BASE}/auth/accesstokenrequest`, body, {
      timeout: 10_000,
    });
  } catch (err) {
    throw new Error(`Tradovate auth request failed: ${err.message}`);
  }

  if (!resp.data.accessToken) {
    throw new Error(`Tradovate auth denied: ${resp.data.errorText ?? 'unknown reason'}`);
  }

  log.info(`Tradovate authenticated for user: ${username}`);
  return resp.data.accessToken;
}

/**
 * Fetch account metrics from Tradovate and return normalized format.
 * Protected by circuit breaker.
 *
 * @param {string} accessToken
 * @param {number} accountId — Tradovate numeric account ID
 * @returns {Object} Normalized metrics
 */
async function fetchTradovateMetrics(accessToken, accountId) {
  return tradovateBreaker.execute(async () => {
    const headers = { Authorization: `Bearer ${accessToken}` };

    // Fetch account balance + order history in parallel
    const [accountResp, historyResp] = await Promise.all([
      axios.get(`${TRADOVATE_BASE}/account/item?id=${accountId}`, {
        headers, timeout: 10_000,
      }),
      axios.get(`${TRADOVATE_BASE}/order/list`, {
        headers, timeout: 10_000,
      }),
    ]);

    const account = accountResp.data;
    const orders  = historyResp.data ?? [];

    // Only filled orders = completed trades
    const filledOrders = orders.filter(o =>
      o.ordStatus === 'Filled' && o.accountId === accountId
    );
    const tradesTotal = filledOrders.length;

    // Tradovate's /order/list doesn't include per-trade P&L;
    // a full implementation needs /fill/list + position history.
    // We compute what we can from available data.
    const balance = account.cashBalance ?? 0;

    // Daily PnL — approximate from account netLiq delta if available
    const dailyPnls = account.dailyPnl
      ? Object.values(account.dailyPnl)
      : [];

    const consistency = calculateConsistency(dailyPnls);

    log.debug('Tradovate metrics fetched', {
      accountId,
      balance,
      tradesTotal,
    });

    return {
      pnlPct:       0,           // Requires /fill/list for accurate value
      winRate:      0.5,         // Requires per-trade P&L
      maxDrawdown:  0,
      consistency,
      profitFactor: 1,
      sharpeRatio:  null,
      avgRRR:       null,
      streak:       0,
      totalTrades:  tradesTotal,
      balance,
      equity:       balance,
      _note: 'Tradovate: connect via EA webhook for full metrics, or enable /fill/list polling.',
    };
  });
}

module.exports = {
  authenticate,
  fetchTradovateMetrics,
};
