'use strict';

/**
 * cTrader Open API Connector
 * OAuth 2.0 REST API — official, well-documented.
 * Docs: https://help.ctrader.com/open-api/
 *
 * Place in: src/modules/tracking/cTraderConnector.js
 */

const axios = require('axios');
const { createLogger } = require('../../utils/logger');
const { calculateConsistency } = require('../leaderboard/scoreEngine');
const { CircuitBreaker } = require('../../middleware/circuitBreaker');

const log = createLogger('cTraderConnector');

const CTRADER_BASE = 'https://api.ctrader.com';
const TOKEN_URL    = 'https://openapi.ctrader.com/apps/token';

// Dedicated circuit breaker for cTrader API calls
const ctraderBreaker = new CircuitBreaker('cTrader', {
  failureThreshold: 3,
  successThreshold: 2,
  timeout: 30_000,
});

/**
 * Exchange auth code for access + refresh tokens.
 * Called once during account linking from the OAuth callback.
 *
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {string} authCode
 * @returns {{ accessToken, refreshToken, expiresIn }}
 */
async function exchangeAuthCode(clientId, clientSecret, authCode) {
  const resp = await axios.post(TOKEN_URL, new URLSearchParams({
    grant_type:    'authorization_code',
    code:          authCode,
    client_id:     clientId,
    client_secret: clientSecret,
  }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10_000,
  });

  if (!resp.data.access_token) {
    throw new Error(`cTrader token exchange failed: ${JSON.stringify(resp.data)}`);
  }

  return {
    accessToken:  resp.data.access_token,
    refreshToken: resp.data.refresh_token,
    expiresIn:    resp.data.expires_in,
  };
}

/**
 * Refresh an expired access token using the stored refresh token.
 *
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {string} refreshToken
 * @returns {{ accessToken, refreshToken, expiresIn }}
 */
async function refreshAccessToken(clientId, clientSecret, refreshToken) {
  const resp = await axios.post(TOKEN_URL, new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     clientId,
    client_secret: clientSecret,
  }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10_000,
  });

  if (!resp.data.access_token) {
    throw new Error(`cTrader token refresh failed: ${JSON.stringify(resp.data)}`);
  }

  return {
    accessToken:  resp.data.access_token,
    refreshToken: resp.data.refresh_token ?? refreshToken,
    expiresIn:    resp.data.expires_in,
  };
}

/**
 * Fetch account metrics from cTrader and return normalized format.
 * Protected by circuit breaker.
 *
 * @param {string} accessToken
 * @param {string} ctidTraderAccountId
 * @returns {Object} Normalized metrics matching our scoreEngine format
 */
async function fetchCTraderMetrics(accessToken, ctidTraderAccountId) {
  return ctraderBreaker.execute(async () => {
    const headers = { Authorization: `Bearer ${accessToken}` };

    // Parallel requests — account overview + 7-day deal history
    const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const [accountResp, dealsResp] = await Promise.all([
      axios.get(`${CTRADER_BASE}/v2/tradingaccounts/${ctidTraderAccountId}`, {
        headers, timeout: 10_000,
      }),
      axios.get(`${CTRADER_BASE}/v2/tradingaccounts/${ctidTraderAccountId}/deals`, {
        headers,
        params: { from: sevenDaysAgo, to: Date.now(), limit: 500 },
        timeout: 10_000,
      }),
    ]);

    const account = accountResp.data;
    const deals   = dealsResp.data?.data ?? [];

    // Only closed positions contribute to score
    const closedDeals = deals.filter(d => d.closePositionDetail != null);
    const tradesTotal  = closedDeals.length;

    let tradesWon    = 0;
    let grossProfit  = 0;
    let grossLoss    = 0;
    let peakBalance  = account.balance / 100; // cTrader sends cents
    let maxDrawdown  = 0;
    const dailyPnl   = {};  // { 'Mon Jan 01 2026': totalPnl }

    for (const deal of closedDeals) {
      // cTrader returns monetary values in cents
      const profit = (deal.closePositionDetail?.grossProfit ?? 0) / 100;
      const date   = new Date(deal.executionTimestamp).toDateString();

      if (profit >= 0) { tradesWon++; grossProfit += profit; }
      else             { grossLoss += Math.abs(profit); }

      // Track drawdown
      peakBalance = Math.max(peakBalance, peakBalance + profit);
      const currentBalance = account.balance / 100;
      const dd = peakBalance > 0 ? (peakBalance - currentBalance) / peakBalance : 0;
      maxDrawdown = Math.max(maxDrawdown, dd);

      // Daily PnL for consistency score
      dailyPnl[date] = (dailyPnl[date] ?? 0) + profit;
    }

    const balance      = account.balance / 100;
    const unrealizedPL = (account.unrealizedGrossProfit ?? 0) / 100;
    const pnlPct       = balance > 0 ? (unrealizedPL / balance) * 100 : 0;
    const winRate      = tradesTotal > 0 ? tradesWon / tradesTotal : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 1);
    const consistency  = calculateConsistency(Object.values(dailyPnl));

    log.debug('cTrader metrics fetched', {
      accountId: ctidTraderAccountId,
      pnlPct: pnlPct.toFixed(2),
      winRate: winRate.toFixed(2),
      trades: tradesTotal,
    });

    return {
      pnlPct:       Math.round(pnlPct * 100) / 100,
      winRate:      Math.min(1, Math.max(0, winRate)),
      maxDrawdown:  Math.min(1, Math.max(0, maxDrawdown)),
      consistency:  Math.min(1, Math.max(0, consistency)),
      profitFactor: Math.round(profitFactor * 100) / 100,
      sharpeRatio:  null,   // Not provided by cTrader API directly
      avgRRR:       null,
      streak:       0,
      totalTrades:  tradesTotal,
      balance,
      equity:       balance + unrealizedPL,
    };
  });
}

module.exports = {
  exchangeAuthCode,
  refreshAccessToken,
  fetchCTraderMetrics,
};
