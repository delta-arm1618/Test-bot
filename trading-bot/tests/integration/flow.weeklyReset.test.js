'use strict';

/**
 * Integration Test — Weekly Reset & Tier Promotion/Relegation
 */

process.env.NODE_ENV = 'test';
process.env.AES_SECRET_KEY = 'test_secret_key_32_chars_exactly';
process.env.JWT_SECRET = 'test_jwt_secret_here_long_enough';
process.env.DISCORD_TOKEN = 'test_token';
process.env.DISCORD_CLIENT_ID = '123456789012345678';
process.env.GUILD_ID = '987654321098765432';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/trading_bot_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379/1';
process.env.HTTP_SECRET = 'test_http_secret';

const { query, transaction, pool } = require('../../db/pool');
const { calculateScore, upsertWeeklyScore, runWeeklyReset, getCurrentWeek } = require('../../src/modules/leaderboard/scoreEngine');
const { redis } = require('../../src/utils/redis');

async function cleanupTestData() {
  await query('DELETE FROM hp_transactions WHERE user_id IN (SELECT id FROM users WHERE discord_id LIKE $1)', ['wk_test_%']);
  await query('DELETE FROM fund_investments WHERE user_id IN (SELECT id FROM users WHERE discord_id LIKE $1)', ['wk_test_%']);
  await query('DELETE FROM user_boosts WHERE user_id IN (SELECT id FROM users WHERE discord_id LIKE $1)', ['wk_test_%']);
  await query('DELETE FROM weekly_scores WHERE user_id IN (SELECT id FROM users WHERE discord_id LIKE $1)', ['wk_test_%']);
  await query('DELETE FROM broker_accounts WHERE user_id IN (SELECT id FROM users WHERE discord_id LIKE $1)', ['wk_test_%']);
  await query('DELETE FROM users WHERE discord_id LIKE $1', ['wk_test_%']);
}

async function seedTrader(discordId, username, tier, score) {
  const { rows: [user] } = await query(`
    INSERT INTO users (discord_id, username, tier, is_verified, hedge_points)
    VALUES ($1, $2, $3, TRUE, 0)
    ON CONFLICT (discord_id) DO UPDATE SET username = EXCLUDED.username, tier = EXCLUDED.tier
    RETURNING *
  `, [discordId, username, tier]);

  // Insert a weekly score
  const { week, year } = getCurrentWeek();
  await query(`
    INSERT INTO weekly_scores
      (user_id, week_number, year, tier, score, pnl_pct, win_rate, max_drawdown, consistency, total_trades)
    VALUES ($1, $2, $3, $4, $5, 5.0, 0.65, 0.05, 0.80, 20)
    ON CONFLICT (user_id, week_number, year) DO UPDATE SET score = EXCLUDED.score, tier = EXCLUDED.tier
  `, [user.id, week, year, tier, score]);

  return user;
}

describe('Integration — Weekly Reset & Tier Logic', () => {
  afterAll(async () => {
    await cleanupTestData();
    await pool.end();
    redis.disconnect();
  });

  beforeAll(async () => {
    await cleanupTestData();
  });

  test('Score formula: all components correctly weighted', () => {
    // Score = PnL*0.4 + WR*0.3 + (1-DD)*0.2 + Consistency*0.1
    // Perfect score: PnL=100% → pnlNorm=1.0 → pnlComp=1.0
    const perfect = calculateScore({
      pnlPct: 100,
      winRate: 1.0,
      maxDrawdown: 0.0,
      consistency: 1.0,
    });
    expect(perfect).toBeCloseTo(1000, 0);

    // Zero score: PnL=-100% → pnlComp=0, WR=0, DD=1, Consistency=0
    const zero = calculateScore({
      pnlPct: -100,
      winRate: 0,
      maxDrawdown: 1.0,
      consistency: 0,
    });
    expect(zero).toBe(0);
  });

  test('Bronze threshold promotion: score >= 500 pts', async () => {
    // Seed bronze user with high score
    const trader = await seedTrader('wk_test_bronze_001', 'BronzeHigh', 'bronze', 550);

    await transaction(async (client) => {
      await runWeeklyReset(client);
    });

    const { rows: [updated] } = await query('SELECT tier FROM users WHERE id = $1', [trader.id]);
    expect(updated.tier).toBe('silver');
  });

  test('Bronze no-promotion: score < 500 pts', async () => {
    const trader = await seedTrader('wk_test_bronze_002', 'BronzeLow', 'bronze', 300);

    await transaction(async (client) => {
      await runWeeklyReset(client);
    });

    const { rows: [updated] } = await query('SELECT tier FROM users WHERE id = $1', [trader.id]);
    // Should stay bronze
    expect(updated.tier).toBe('bronze');
  });

  test('Weekly scores are archived after reset', async () => {
    const { week, year } = getCurrentWeek();
    const { rows } = await query(`
      SELECT COUNT(*) as cnt FROM weekly_scores
      WHERE week_number = $1 AND year = $2 AND is_archived = TRUE
    `, [week, year]);
    expect(parseInt(rows[0].cnt)).toBeGreaterThan(0);
  });
});

describe('Integration — Score Calculation Edge Cases', () => {
  test('Score is always non-negative', () => {
    const worstCase = calculateScore({
      pnlPct: -100,
      winRate: 0,
      maxDrawdown: 1.0,
      consistency: 0,
    }, 1.0);
    expect(worstCase).toBeGreaterThanOrEqual(0);
  });

  test('Score multiplier boost: 1.1x applies correctly', () => {
    const metrics = { pnlPct: 10, winRate: 0.7, maxDrawdown: 0.05, consistency: 0.85 };
    const base = calculateScore(metrics, 1.0);
    const boosted = calculateScore(metrics, 1.1);
    expect(Math.abs(boosted - base * 1.1)).toBeLessThan(1); // within 1 point rounding
  });

  test('Score is deterministic for same inputs', () => {
    const metrics = { pnlPct: 5.5, winRate: 0.6, maxDrawdown: 0.08, consistency: 0.75 };
    const s1 = calculateScore(metrics);
    const s2 = calculateScore(metrics);
    expect(s1).toBe(s2);
  });

  test('Higher performing trader always scores higher', () => {
    const weak = calculateScore({ pnlPct: 1, winRate: 0.4, maxDrawdown: 0.2, consistency: 0.4 });
    const strong = calculateScore({ pnlPct: 15, winRate: 0.8, maxDrawdown: 0.02, consistency: 0.9 });
    expect(strong).toBeGreaterThan(weak);
  });
});
