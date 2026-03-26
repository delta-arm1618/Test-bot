'use strict';

const { calculateScore, calculateConsistency } = require('../../src/modules/leaderboard/scoreEngine');

describe('ScoreEngine — calculateScore', () => {
  const defaultMetrics = {
    pnlPct: 5,       // +5%
    winRate: 0.60,
    maxDrawdown: 0.05,
    consistency: 0.80,
  };

  test('returns a number between 0 and 1100', () => {
    const score = calculateScore(defaultMetrics);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1100);
  });

  test('higher PnL produces higher score', () => {
    const low  = calculateScore({ ...defaultMetrics, pnlPct: 1 });
    const high = calculateScore({ ...defaultMetrics, pnlPct: 20 });
    expect(high).toBeGreaterThan(low);
  });

  test('higher winRate produces higher score', () => {
    const low  = calculateScore({ ...defaultMetrics, winRate: 0.30 });
    const high = calculateScore({ ...defaultMetrics, winRate: 0.80 });
    expect(high).toBeGreaterThan(low);
  });

  test('lower drawdown produces higher score', () => {
    const bad  = calculateScore({ ...defaultMetrics, maxDrawdown: 0.40 });
    const good = calculateScore({ ...defaultMetrics, maxDrawdown: 0.02 });
    expect(good).toBeGreaterThan(bad);
  });

  test('score with multiplier is proportionally higher', () => {
    const base      = calculateScore(defaultMetrics, 1.0);
    const boosted   = calculateScore(defaultMetrics, 1.1);
    expect(boosted).toBeCloseTo(base * 1.1, 0);
  });

  test('negative PnL still produces valid score (no crash)', () => {
    const score = calculateScore({ ...defaultMetrics, pnlPct: -25 });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(typeof score).toBe('number');
  });

  test('extreme values do not produce NaN or Infinity', () => {
    const score = calculateScore({
      pnlPct: 9999,
      winRate: 2.0,      // clamped to 1
      maxDrawdown: -0.5, // clamped to 0
      consistency: 1.5,  // clamped to 1
    });
    expect(isNaN(score)).toBe(false);
    expect(isFinite(score)).toBe(true);
  });
});

describe('ScoreEngine — calculateConsistency', () => {
  test('perfectly stable trader returns 1.0', () => {
    const c = calculateConsistency([5, 5, 5, 5, 5]);
    expect(c).toBe(1.0);
  });

  test('highly volatile trader returns low score', () => {
    const c = calculateConsistency([20, -15, 18, -14, 17, -13]);
    expect(c).toBeLessThan(0.5);
  });

  test('empty array returns neutral 0.5', () => {
    expect(calculateConsistency([])).toBe(0.5);
    expect(calculateConsistency(null)).toBe(0.5);
  });

  test('single-day returns neutral 0.5', () => {
    expect(calculateConsistency([5])).toBe(0.5);
  });

  test('output is always between 0 and 1', () => {
    const cases = [
      [1, 2, 3, 100, -100],
      [0.1, 0.2, 0.15],
      [-50, -50, -50],
    ];
    for (const dailyPnls of cases) {
      const c = calculateConsistency(dailyPnls);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });
});
