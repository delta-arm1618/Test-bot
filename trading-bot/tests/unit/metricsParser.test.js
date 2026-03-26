'use strict';

const { parseEAWebhookPayload, isTradeSeasonValid } = require('../../src/modules/tracking/metricsParser');

describe('MetricsParser — parseEAWebhookPayload', () => {
  const validPayload = {
    account_id: 'acc_123',
    balance: 10000,
    equity: 10250,
    profit: 250,
    trades_total: 40,
    trades_won: 28,
    max_drawdown_abs: 400,
    gross_profit: 800,
    gross_loss: -300,
    daily_pnl: [50, -10, 30, 20, 15, -5, 40],
  };

  test('calculates PnL % correctly', () => {
    const result = parseEAWebhookPayload(validPayload);
    expect(result.pnlPct).toBeCloseTo(2.5, 1); // 250/10000 * 100
  });

  test('calculates win rate correctly', () => {
    const result = parseEAWebhookPayload(validPayload);
    expect(result.winRate).toBeCloseTo(0.7, 2); // 28/40
  });

  test('calculates drawdown as fraction of balance', () => {
    const result = parseEAWebhookPayload(validPayload);
    expect(result.maxDrawdown).toBeCloseTo(0.04, 2); // 400/10000
  });

  test('calculates profit factor', () => {
    const result = parseEAWebhookPayload(validPayload);
    expect(result.profitFactor).toBeCloseTo(800 / 300, 1);
  });

  test('all fields are within valid range', () => {
    const result = parseEAWebhookPayload(validPayload);
    expect(result.winRate).toBeGreaterThanOrEqual(0);
    expect(result.winRate).toBeLessThanOrEqual(1);
    expect(result.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(result.maxDrawdown).toBeLessThanOrEqual(1);
    expect(result.consistency).toBeGreaterThanOrEqual(0);
    expect(result.consistency).toBeLessThanOrEqual(1);
  });

  test('handles zero balance gracefully', () => {
    const result = parseEAWebhookPayload({ ...validPayload, balance: 0 });
    expect(isNaN(result.pnlPct)).toBe(false);
    expect(isFinite(result.pnlPct)).toBe(true);
  });
});

describe('MetricsParser — isTradeSeasonValid', () => {
  test('returns true when no season active', () => {
    expect(isTradeSeasonValid({ symbol: 'XAUUSD' }, null)).toBe(true);
    expect(isTradeSeasonValid({ symbol: 'EURUSD' }, undefined)).toBe(true);
  });

  test('forex_majors_only rejects gold', () => {
    const season = { rule_type: 'forex_majors_only' };
    expect(isTradeSeasonValid({ symbol: 'XAUUSD' }, season)).toBe(false);
  });

  test('forex_majors_only accepts EURUSD', () => {
    const season = { rule_type: 'forex_majors_only' };
    expect(isTradeSeasonValid({ symbol: 'EURUSD' }, season)).toBe(true);
  });

  test('long_only rejects sell trades', () => {
    const season = { rule_type: 'long_only' };
    expect(isTradeSeasonValid({ direction: 'sell' }, season)).toBe(false);
    expect(isTradeSeasonValid({ direction: 'buy' }, season)).toBe(true);
  });

  test('max_leverage rejects trades above limit', () => {
    const season = { rule_type: 'max_leverage', rule_param: { max_leverage: 10 } };
    expect(isTradeSeasonValid({ leverage: 100 }, season)).toBe(false);
    expect(isTradeSeasonValid({ leverage: 5 }, season)).toBe(true);
    expect(isTradeSeasonValid({ leverage: 10 }, season)).toBe(true);
  });
});
