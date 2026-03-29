'use strict';

/**
 * Integration Test — Full Onboarding Flow
 * Tests: register → link account → get invited → unlock → score → leaderboard
 *
 * Requires a real PostgreSQL + Redis (use docker-compose.test.yml).
 * Set TEST_DATABASE_URL and TEST_REDIS_URL environment variables.
 */

process.env.NODE_ENV = 'test';
process.env.AES_SECRET_KEY = 'test_secret_key_32_chars_exactly';
process.env.JWT_SECRET = 'test_jwt_secret_here_long_enough';
process.env.DISCORD_TOKEN = 'test_token';
process.env.DISCORD_CLIENT_ID = '123456789012345678';
process.env.GUILD_ID = '987654321098765432';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/trading_bot_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379/1';
process.env.HTTP_SECRET = 'integration_test_secret';

const { query, transaction, pool } = require('../../db/pool');
const { registerUserInvite, recordInviteUse, activatePendingInvites, getUserInviteStats } = require('../../src/modules/invites/inviteManager');
const { linkAccount, getUserAccounts } = require('../../src/modules/tracking/accountTracker');
const { calculateScore, calculateConsistency, upsertWeeklyScore, getLeaderboard, getUserRank, getCurrentWeek } = require('../../src/modules/leaderboard/scoreEngine');
const { parseEAWebhookPayload } = require('../../src/modules/tracking/metricsParser');
const { redis } = require('../../src/utils/redis');

// ── Test helpers ──────────────────────────────────────────
async function createTestUser(discordId, username, opts = {}) {
  const { rows: [user] } = await query(`
    INSERT INTO users (discord_id, username, discriminator, avatar_url, is_verified)
    VALUES ($1, $2, '0', 'https://cdn.discordapp.com/test.png', $3)
    ON CONFLICT (discord_id) DO UPDATE SET username = EXCLUDED.username
    RETURNING *
  `, [discordId, username, opts.verified ?? false]);
  return user;
}

async function cleanupTestData() {
  // Delete in FK order
  await query('DELETE FROM hp_transactions WHERE user_id IN (SELECT id FROM users WHERE discord_id LIKE $1)', ['test_%']);
  await query('DELETE FROM fund_investments WHERE user_id IN (SELECT id FROM users WHERE discord_id LIKE $1)', ['test_%']);
  await query('DELETE FROM user_boosts WHERE user_id IN (SELECT id FROM users WHERE discord_id LIKE $1)', ['test_%']);
  await query('DELETE FROM invite_uses WHERE inviter_id IN (SELECT id FROM users WHERE discord_id LIKE $1)', ['test_%']);
  await query('DELETE FROM invite_uses WHERE invitee_id IN (SELECT id FROM users WHERE discord_id LIKE $1)', ['test_%']);
  await query('DELETE FROM invite_codes WHERE user_id IN (SELECT id FROM users WHERE discord_id LIKE $1)', ['test_%']);
  await query('DELETE FROM battle_participants WHERE user_id IN (SELECT id FROM users WHERE discord_id LIKE $1)', ['test_%']);
  await query('DELETE FROM weekly_scores WHERE user_id IN (SELECT id FROM users WHERE discord_id LIKE $1)', ['test_%']);
  await query('DELETE FROM trades WHERE account_id IN (SELECT id FROM broker_accounts WHERE user_id IN (SELECT id FROM users WHERE discord_id LIKE $1))', ['test_%']);
  await query('DELETE FROM broker_accounts WHERE user_id IN (SELECT id FROM users WHERE discord_id LIKE $1)', ['test_%']);
  await query('DELETE FROM users WHERE discord_id LIKE $1', ['test_%']);
}

// ════════════════════════════════════════════════════════════
// SUITE 1 — User Registration & Invite Gate
// ════════════════════════════════════════════════════════════
describe('Integration — Invite Gate Flow', () => {
  let inviter, invitee1, invitee2;

  beforeAll(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
    await pool.end();
    redis.disconnect();
  });

  test('Step 1: Create inviter and register invite code', async () => {
    inviter = await createTestUser('test_inviter_001', 'TraderAlpha');
    expect(inviter).toBeDefined();
    expect(inviter.discord_id).toBe('test_inviter_001');
    expect(inviter.is_verified).toBe(false);

    await registerUserInvite(inviter.id, 'TEST_CODE_ALPHA');

    const { rows: [code] } = await query('SELECT * FROM invite_codes WHERE user_id = $1', [inviter.id]);
    expect(code).toBeDefined();
    expect(code.code).toBe('TEST_CODE_ALPHA');
  });

  test('Step 2: Two invitees join via inviter code', async () => {
    invitee1 = await createTestUser('test_invitee_001', 'TraderBeta');
    invitee2 = await createTestUser('test_invitee_002', 'TraderGamma');

    await recordInviteUse(invitee1.id, inviter.id, 'TEST_CODE_ALPHA');
    await recordInviteUse(invitee2.id, inviter.id, 'TEST_CODE_ALPHA');

    const { rows: uses } = await query(
      'SELECT * FROM invite_uses WHERE inviter_id = $1',
      [inviter.id]
    );
    expect(uses).toHaveLength(2);
    expect(uses.every(u => u.status === 'pending')).toBe(true);
  });

  test('Step 3: Invites not active yet (< 24h)', async () => {
    const stats = await getUserInviteStats(inviter.id);
    expect(stats.validInvites).toBe(0);
    expect(stats.pendingInvites).toBe(2);
    expect(stats.isUnlocked).toBe(false);
  });

  test('Step 4: Simulate 24h passing — backdating joined_at', async () => {
    // Backdate invite join times to simulate 24h+ activity
    await query(
      'UPDATE invite_uses SET joined_at = NOW() - INTERVAL \'25 hours\' WHERE inviter_id = $1',
      [inviter.id]
    );

    // Mock guild (no Discord in tests)
    const mockGuild = {
      members: {
        fetch: async (discordId) => {
          // Return mock member for inviter (they're still in server)
          if (discordId === inviter.discord_id) return { id: discordId };
          return null;
        },
      },
    };

    await activatePendingInvites(mockGuild);

    const stats = await getUserInviteStats(inviter.id);
    expect(stats.validInvites).toBe(2);
    expect(stats.isUnlocked).toBe(true);
  });

  test('Step 5: Inviter is now verified and received HP', async () => {
    const { rows: [user] } = await query('SELECT * FROM users WHERE id = $1', [inviter.id]);
    expect(user.is_verified).toBe(true);
    expect(user.hedge_points).toBeGreaterThanOrEqual(200); // 2 × 100 HP

    const { rows: txs } = await query(
      'SELECT * FROM hp_transactions WHERE user_id = $1 AND reason = $2',
      [inviter.id, 'invite_bonus']
    );
    expect(txs).toHaveLength(2);
    expect(txs.reduce((sum, t) => sum + t.amount, 0)).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════
// SUITE 2 — Account Linking & Score Flow
// ════════════════════════════════════════════════════════════
describe('Integration — Account Link & Score Flow', () => {
  let trader;

  beforeAll(async () => {
    await cleanupTestData();
    trader = await createTestUser('test_trader_001', 'ScoreTrader', { verified: true });
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  test('Step 1: Link a manual broker account', async () => {
    const account = await linkAccount(trader.id, {
      broker: 'manual',
      accountId: 'DEMO_ACC_12345',
      server: null,
    });

    expect(account).toBeDefined();
    expect(account.broker).toBe('manual');
    expect(account.account_id).toBe('DEMO_ACC_12345');
    expect(account.is_primary).toBe(true);
    expect(account.status).toBe('pending');
  });

  test('Step 2: Simulate EA webhook metrics', () => {
    const payload = {
      account_id: 'DEMO_ACC_12345',
      balance: 10000,
      equity: 10450,
      profit: 450,
      trades_total: 25,
      trades_won: 18,
      max_drawdown_abs: 200,
      gross_profit: 700,
      gross_loss: -250,
      daily_pnl: [60, 20, 80, -15, 45, 30, 70],
    };

    const metrics = parseEAWebhookPayload(payload);

    expect(metrics.pnlPct).toBeCloseTo(4.5, 1);
    expect(metrics.winRate).toBeCloseTo(0.72, 2);
    expect(metrics.maxDrawdown).toBeCloseTo(0.02, 2);
    expect(metrics.consistency).toBeGreaterThan(0.5);
    expect(metrics.profitFactor).toBeGreaterThan(1);
  });

  test('Step 3: Upsert weekly score and retrieve rank', async () => {
    const metrics = {
      pnlPct: 4.5,
      winRate: 0.72,
      maxDrawdown: 0.02,
      consistency: 0.80,
      profitFactor: 2.8,
      sharpeRatio: 1.5,
      avgRRR: 1.8,
      streak: 3,
      totalTrades: 25,
    };

    const ws = await upsertWeeklyScore(trader.id, metrics, {});
    expect(ws).toBeDefined();
    expect(parseFloat(ws.score)).toBeGreaterThan(0);
    expect(parseFloat(ws.score)).toBeLessThanOrEqual(1100);

    const rank = await getUserRank(trader.id);
    expect(rank).toBeDefined();
    expect(rank.score).toBeGreaterThan(0);
    expect(rank.tier).toBe('bronze');
    expect(rank.position).toBe(1); // Only trader in DB
  });

  test('Step 4: Score with multiplier boost is higher', async () => {
    const baseMetrics = {
      pnlPct: 4.5, winRate: 0.72, maxDrawdown: 0.02, consistency: 0.80,
      profitFactor: 2.8, sharpeRatio: 1.5, avgRRR: 1.8, streak: 3, totalTrades: 25,
    };

    const baseScore = calculateScore(baseMetrics, 1.0);
    const boostedScore = calculateScore(baseMetrics, 1.1);

    expect(boostedScore).toBeCloseTo(baseScore * 1.1, 0);
    expect(boostedScore).toBeGreaterThan(baseScore);
  });

  test('Step 5: Leaderboard shows the trader', async () => {
    const lb = await getLeaderboard(1, 10);
    expect(lb.total).toBeGreaterThanOrEqual(1);
    expect(lb.entries.length).toBeGreaterThanOrEqual(1);

    const entry = lb.entries.find(e => e.discord_id === trader.discord_id);
    expect(entry).toBeDefined();
    expect(parseFloat(entry.score)).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════
// SUITE 3 — Battle Flow
// ════════════════════════════════════════════════════════════
describe('Integration — Battle Creation & Join Flow', () => {
  let player1, player2, account1, account2;

  beforeAll(async () => {
    await cleanupTestData();

    player1 = await createTestUser('test_battle_p1', 'BattleAlpha', { verified: true });
    player2 = await createTestUser('test_battle_p2', 'BattleBeta', { verified: true });

    // Link accounts and mark active
    const a1 = await linkAccount(player1.id, { broker: 'manual', accountId: 'BATTLE_ACC_1' });
    const a2 = await linkAccount(player2.id, { broker: 'manual', accountId: 'BATTLE_ACC_2' });

    await query('UPDATE broker_accounts SET status = $1 WHERE id IN ($2, $3)', ['active', a1.id, a2.id]);
    account1 = a1;
    account2 = a2;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  let lobbyCode;

  test('Step 1: Player 1 creates a 1v1 battle', async () => {
    const { createBattle } = require('../../src/modules/battles/battleManager');
    const { battle, creator } = await createBattle(player1.discord_id, '1v1', '24h');

    expect(battle).toBeDefined();
    expect(battle.type).toBe('1v1');
    expect(battle.status).toBe('open');
    expect(battle.lobby_code).toHaveLength(8);
    expect(creator.discord_id).toBe(player1.discord_id);

    lobbyCode = battle.lobby_code;
  });

  test('Step 2: Player 2 joins the battle', async () => {
    const { joinBattle } = require('../../src/modules/battles/battleManager');
    const result = await joinBattle(player2.discord_id, lobbyCode);

    expect(result.isStarted).toBe(true);
    expect(result.team).toBe(2);

    const { rows: [battle] } = await query('SELECT * FROM battles WHERE lobby_code = $1', [lobbyCode]);
    expect(battle.status).toBe('active');
  });

  test('Step 3: Battle status returns both players', async () => {
    const { getBattleStatus } = require('../../src/modules/battles/battleManager');
    const status = await getBattleStatus(lobbyCode);

    expect(status.team1).toHaveLength(1);
    expect(status.team2).toHaveLength(1);
    expect(status.isActive).toBe(true);
    expect(status.isCompleted).toBe(false);
  });

  test('Step 4: Simulate battle expiry and resolution', async () => {
    // Manually expire the battle
    await query(
      'UPDATE battles SET ends_at = NOW() - INTERVAL \'1 hour\' WHERE lobby_code = $1',
      [lobbyCode]
    );

    const { resolveExpiredBattles } = require('../../src/modules/battles/battleManager');
    await resolveExpiredBattles(null);

    const { rows: [battle] } = await query('SELECT * FROM battles WHERE lobby_code = $1', [lobbyCode]);
    expect(battle.status).toBe('completed');
    expect(battle.winning_team).toBeGreaterThanOrEqual(1);
  });

  test('Step 5: Winner received HP', async () => {
    const { rows: [battle] } = await query('SELECT * FROM battles WHERE lobby_code = $1', [lobbyCode]);
    const winningTeam = battle.winning_team;

    const { rows: winnerPart } = await query(`
      SELECT u.discord_id, u.hedge_points
      FROM battle_participants bp
      JOIN users u ON u.id = bp.user_id
      WHERE bp.battle_id = $1 AND bp.team = $2
    `, [battle.id, winningTeam]);

    expect(winnerPart).toHaveLength(1);
    // Winner should have 150 HP (battle win reward)
    const { rows: [hpTx] } = await query(
      'SELECT * FROM hp_transactions WHERE user_id = (SELECT id FROM users WHERE discord_id = $1) AND reason = $2',
      [winnerPart[0].discord_id, 'battle_win']
    );
    expect(hpTx).toBeDefined();
    expect(hpTx.amount).toBe(150);
  });
});

// ════════════════════════════════════════════════════════════
// SUITE 4 — Economy: Hedge Fund & Shop
// ════════════════════════════════════════════════════════════
describe('Integration — Economy Flow', () => {
  let richTrader;

  beforeAll(async () => {
    await cleanupTestData();
    richTrader = await createTestUser('test_economy_001', 'RichTrader', { verified: true });

    // Give them HP
    await query('UPDATE users SET hedge_points = 2000 WHERE id = $1', [richTrader.id]);
    await query(
      'INSERT INTO hp_transactions (user_id, amount, balance_after, reason) VALUES ($1, 2000, 2000, $2)',
      [richTrader.id, 'admin_grant']
    );
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  test('Step 1: Shop items are seeded and retrievable', async () => {
    const { getShopItems } = require('../../src/modules/hedgefund/shopManager');
    const items = await getShopItems();

    expect(items.length).toBe(5);

    const types = items.map(i => i.boost_type);
    expect(types).toContain('max_daily_loss');
    expect(types).toContain('score_multiplier');
    expect(types).toContain('relegate_immunity');
    expect(types).toContain('reset_drawdown');
    expect(types).toContain('battle_priority');
  });

  test('Step 2: Purchase a boost successfully', async () => {
    const { purchaseBoost } = require('../../src/modules/hedgefund/shopManager');
    const result = await purchaseBoost(richTrader.discord_id, 'score_multiplier');

    expect(result.item.boost_type).toBe('score_multiplier');
    expect(result.newBalance).toBe(2000 - 800); // 1200 HP remaining
    expect(result.boost).toBeDefined();
    expect(result.boost.is_active).toBe(true);
  });

  test('Step 3: Cannot buy same active boost twice', async () => {
    const { purchaseBoost } = require('../../src/modules/hedgefund/shopManager');
    await expect(purchaseBoost(richTrader.discord_id, 'score_multiplier'))
      .rejects.toThrow('already have an active');
  });

  test('Step 4: HP balance reflects purchase', async () => {
    const { getHpSummary } = require('../../src/modules/hedgefund/shopManager');
    const summary = await getHpSummary(richTrader.discord_id);

    expect(summary.balance).toBe(1200);
    expect(summary.transactions).toBeDefined();
    expect(summary.transactions.length).toBeGreaterThanOrEqual(1);
    // Most recent should be the purchase (negative amount)
    const purchase = summary.transactions.find(t => t.reason === 'shop_purchase');
    expect(purchase).toBeDefined();
    expect(purchase.amount).toBe(-800);
  });

  test('Step 5: Score multiplier boost is applied in score calculation', async () => {
    const { getUserActiveBoosts } = require('../../src/modules/tracking/accountTracker');
    const boosts = await getUserActiveBoosts(richTrader.id);
    expect(boosts.scoreMultiplier).toBe(1.1);
  });
});

// ════════════════════════════════════════════════════════════
// SUITE 5 — Volatility Seasons
// ════════════════════════════════════════════════════════════
describe('Integration — Volatility Season Flow', () => {
  const { getCurrentWeek } = require('../../src/modules/leaderboard/scoreEngine');
  const { pickWeekOptions, SEASON_RULES } = require('../../src/modules/seasons/seasonManager');
  const { isTradeSeasonValid } = require('../../src/modules/tracking/metricsParser');

  test('Season options are deterministic', () => {
    const { week, year } = getCurrentWeek();
    const o1 = pickWeekOptions(week, year);
    const o2 = pickWeekOptions(week, year);
    expect(o1).toEqual(o2);
    expect(o1).toHaveLength(3);
  });

  test('forex_majors_only correctly filters invalid symbols', () => {
    const season = { rule_type: 'forex_majors_only' };
    const validTrades = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD'];
    const invalidTrades = ['XAUUSD', 'XAGUSD', 'SP500', 'BTCUSD', 'NASDAQ'];

    for (const symbol of validTrades) {
      expect(isTradeSeasonValid({ symbol }, season)).toBe(true);
    }
    for (const symbol of invalidTrades) {
      expect(isTradeSeasonValid({ symbol }, season)).toBe(false);
    }
  });

  test('long_only only accepts buy direction', () => {
    const season = { rule_type: 'long_only' };
    expect(isTradeSeasonValid({ direction: 'buy' }, season)).toBe(true);
    expect(isTradeSeasonValid({ direction: 'BUY' }, season)).toBe(false); // Case sensitive
    expect(isTradeSeasonValid({ direction: 'sell' }, season)).toBe(false);
  });

  test('max_leverage boundary conditions', () => {
    const season = { rule_type: 'max_leverage', rule_param: { max_leverage: 10 } };
    expect(isTradeSeasonValid({ leverage: 1 }, season)).toBe(true);
    expect(isTradeSeasonValid({ leverage: 10 }, season)).toBe(true);
    expect(isTradeSeasonValid({ leverage: 11 }, season)).toBe(false);
    expect(isTradeSeasonValid({ leverage: 100 }, season)).toBe(false);
  });

  test('no_news_trades rule always returns true (time-based check)', () => {
    const season = { rule_type: 'no_news_trades' };
    // Client-side check — server marks these during trade ingestion
    expect(isTradeSeasonValid({ symbol: 'EURUSD' }, season)).toBe(true);
  });
});
