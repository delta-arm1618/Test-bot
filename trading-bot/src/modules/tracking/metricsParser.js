'use strict';

const { calculateConsistency } = require('../leaderboard/scoreEngine');
const { createLogger } = require('../../utils/logger');

const log = createLogger('MetricsParser');

/**
 * Parse raw MetaApi metrics response into our standardized format.
 * MetaApi returns many fields — we extract what we need.
 *
 * @param {Object} raw - Raw MetaApi metrics object
 * @returns {Object} Normalized metrics
 */
function parseMetaApiMetrics(raw) {
  try {
    const balance = raw.balance ?? raw.initialBalance ?? 1;
    const equity = raw.equity ?? balance;
    const profit = raw.profit ?? 0;
    const pnlPct = balance > 0 ? (profit / balance) * 100 : 0;

    // Win rate from trade stats
    const winningTrades = raw.wonTrades ?? raw.shortWonTrades + raw.longWonTrades ?? 0;
    const totalClosed = raw.trades ?? raw.totalTrades ?? 0;
    const winRate = totalClosed > 0 ? winningTrades / totalClosed : 0;

    // Drawdown — MetaApi gives absolute, we need percentage
    const absoluteDD = raw.maxDrawdown ?? raw.absoluteDrawdown ?? 0;
    const maxDrawdown = balance > 0 ? Math.min(1, absoluteDD / balance) : 0;

    // Consistency from daily breakdown if available
    const dailyBreakdown = raw.dailyGrowth ?? raw.dailyStats ?? [];
    const dailyPnls = dailyBreakdown.map(d => d.profit ?? d.pnl ?? 0);
    const consistency = calculateConsistency(dailyPnls);

    // Profit factor
    const grossProfit = raw.grossProfit ?? raw.wonTrades * (raw.averageWin ?? 0) ?? 0;
    const grossLoss = Math.abs(raw.grossLoss ?? raw.lostTrades * (raw.averageLoss ?? 0) ?? 0);
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 1;

    // Sharpe ratio — some brokers provide it
    const sharpeRatio = raw.sharpeRatio ?? null;

    // Average RRR
    const avgRRR = raw.averageRiskRewardRatio ?? raw.expectancy ?? null;

    // Streak — current consecutive wins/losses
    const streak = raw.wonTrades - raw.lostTrades ?? 0; // Simplified

    // Anti-inactivity check
    const totalTrades = totalClosed;

    return {
      pnlPct: Math.round(pnlPct * 100) / 100,
      winRate: Math.min(1, Math.max(0, winRate)),
      maxDrawdown: Math.min(1, Math.max(0, maxDrawdown)),
      consistency: Math.min(1, Math.max(0, consistency)),
      profitFactor: Math.round(profitFactor * 100) / 100,
      sharpeRatio: sharpeRatio ? Math.round(sharpeRatio * 100) / 100 : null,
      avgRRR: avgRRR ? Math.round(avgRRR * 100) / 100 : null,
      streak: streak ?? 0,
      totalTrades,
      balance,
      equity,
      // Raw values for display
      rawGrossProfit: grossProfit,
      rawGrossLoss: grossLoss,
    };
  } catch (err) {
    log.error('Failed to parse MetaApi metrics', { error: err.message });
    throw new Error(`MetricsParser: ${err.message}`);
  }
}

/**
 * Parse EA webhook payload (custom MT4 Expert Advisor POST).
 * This is the free alternative to MetaApi for MT4/MT5.
 *
 * Expected payload from EA:
 * {
 *   account_id: "...",
 *   balance: 10000,
 *   equity: 10250,
 *   profit: 250,
 *   trades_total: 45,
 *   trades_won: 30,
 *   max_drawdown_abs: 300,
 *   daily_pnl: [12.5, -5.2, 8.3, ...],
 *   gross_profit: 800,
 *   gross_loss: -350,
 *   open_trades: [{symbol, direction, lots, open_price, ...}],
 *   closed_trades: [{...}, ...]
 * }
 */
function parseEAWebhookPayload(payload) {
  const balance = payload.balance ?? 1;
  const pnlPct = balance > 0 ? ((payload.profit ?? 0) / balance) * 100 : 0;
  const totalTrades = payload.trades_total ?? 0;
  const winRate = totalTrades > 0 ? (payload.trades_won ?? 0) / totalTrades : 0;
  const maxDrawdownAbs = payload.max_drawdown_abs ?? 0;
  const maxDrawdown = balance > 0 ? Math.min(1, maxDrawdownAbs / balance) : 0;

  const dailyPnls = payload.daily_pnl ?? [];
  const consistency = calculateConsistency(dailyPnls);

  const grossProfit = payload.gross_profit ?? 0;
  const grossLoss = Math.abs(payload.gross_loss ?? 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 1;

  return {
    pnlPct: Math.round(pnlPct * 100) / 100,
    winRate: Math.min(1, Math.max(0, winRate)),
    maxDrawdown: Math.min(1, Math.max(0, maxDrawdown)),
    consistency: Math.min(1, Math.max(0, consistency)),
    profitFactor: Math.round(profitFactor * 100) / 100,
    sharpeRatio: payload.sharpe_ratio ?? null,
    avgRRR: payload.avg_rrr ?? null,
    streak: payload.streak ?? 0,
    totalTrades,
    balance,
    equity: payload.equity ?? balance,
    trades: {
      open: payload.open_trades ?? [],
      closed: payload.closed_trades ?? [],
    },
  };
}

/**
 * Check if a trade respects the current Volatility Season rule.
 *
 * @param {Object} trade - Trade object
 * @param {Object} season - Current season rule
 * @returns {boolean}
 */
function isTradeSeasonValid(trade, season) {
  if (!season || !season.rule_type) return true;

  switch (season.rule_type) {
    case 'forex_majors_only': {
      const majors = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD'];
      return majors.some(m => trade.symbol?.toUpperCase().includes(m.replace('/', '')));
    }
    case 'max_trades_per_day': {
      // Handled at the session level, not per-trade here
      return true;
    }
    case 'long_only': {
      return trade.direction?.toLowerCase() === 'buy';
    }
    case 'max_leverage': {
      const maxLev = season.rule_param?.max_leverage ?? 10;
      return (trade.leverage ?? 1) <= maxLev;
    }
    default:
      return true;
  }
}

module.exports = {
  parseMetaApiMetrics,
  parseEAWebhookPayload,
  isTradeSeasonValid,
};
