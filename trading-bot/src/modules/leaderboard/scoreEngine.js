'use strict';

const config = require('../../../config');
const { query, transaction } = require('../../../db/pool');
const { getCache, setCache, invalidatePattern, CacheKeys } = require('../../utils/redis');
const { createLogger } = require('../../utils/logger');
const dayjs = require('dayjs');
const isoWeek = require('dayjs/plugin/isoWeek');
const utc = require('dayjs/plugin/utc');

dayjs.extend(isoWeek);
dayjs.extend(utc);

const log = createLogger('ScoreEngine');

/**
 * Calculate composite score from raw metrics.
 * Score = (PnL%) x 0.4 + WinRate x 0.3 + (1 - MaxDrawdown%) x 0.2 + Consistency x 0.1
 * All inputs are normalized 0-1 ranges except PnL which can be negative.
 *
 * @param {Object} metrics
 * @param {number} metrics.pnlPct     - PnL as percentage e.g. 5.3 for +5.3%
 * @param {number} metrics.winRate    - 0.0 to 1.0
 * @param {number} metrics.maxDrawdown - 0.0 to 1.0 (higher is worse)
 * @param {number} metrics.consistency - 0.0 to 1.0 (higher is better)
 * @param {number} [multiplier=1.0]   - applied boost multiplier
 * @returns {number} Composite score (can be 0 minimum after multiplier)
 */
function calculateScore(metrics, multiplier = 1.0) {
  const { weights } = config.scoring;

  // Normalize PnL% into 0-1 range for the formula
  // Cap at ±100% to prevent extreme values gaming the system
  const pnlNorm = Math.max(-1, Math.min(1, metrics.pnlPct / 100));
  // Shift to 0-1: a 0% PnL gives 0.5, +100% gives 1.0, -100% gives 0.0
  const pnlComponent = (pnlNorm + 1) / 2;

  const winRateComponent = Math.max(0, Math.min(1, metrics.winRate));
  const drawdownComponent = Math.max(0, 1 - Math.min(1, metrics.maxDrawdown));
  const consistencyComponent = Math.max(0, Math.min(1, metrics.consistency));

  const rawScore = (
    pnlComponent      * weights.pnl        +
    winRateComponent   * weights.winRate    +
    drawdownComponent  * weights.drawdown   +
    consistencyComponent * weights.consistency
  ) * 1000; // Scale to 0-1000 pts range

  const finalScore = Math.max(0, rawScore * multiplier);
  return Math.round(finalScore * 10) / 10; // Round to 1 decimal
}

/**
 * Calculate consistency score from daily PnL array.
 * Inverse of variance (normalized). Stable traders score higher.
 *
 * @param {number[]} dailyPnlPcts - Array of daily PnL percentages
 * @returns {number} 0.0 to 1.0
 */
function calculateConsistency(dailyPnlPcts) {
  if (!dailyPnlPcts || dailyPnlPcts.length < 2) return 0.5; // neutral if insufficient data

  const mean = dailyPnlPcts.reduce((a, b) => a + b, 0) / dailyPnlPcts.length;
  const variance = dailyPnlPcts.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / dailyPnlPcts.length;
  const stdDev = Math.sqrt(variance);

  // Normalize: 0 stdDev = 1.0 (perfect), 10% stdDev = 0.0
  const consistency = Math.max(0, 1 - stdDev / 10);
  return Math.min(1, consistency);
}

/**
 * Get current ISO week and year.
 */
function getCurrentWeek() {
  const now = dayjs.utc();
  return { week: now.isoWeek(), year: now.year() };
}

/**
 * Upsert a user's weekly score row.
 * Called after each MetaApi poll to keep scores fresh.
 */
async function upsertWeeklyScore(userId, metrics, boosts = {}) {
  const { week, year } = getCurrentWeek();
  const multiplier = boosts.scoreMultiplier ?? 1.0;
  const score = calculateScore(metrics, multiplier);

  const sql = `
    INSERT INTO weekly_scores
      (user_id, week_number, year, tier, score, pnl_pct, win_rate, max_drawdown,
       consistency, profit_factor, sharpe_ratio, avg_rrr, streak, total_trades,
       score_multiplier, relegate_immune)
    VALUES ($1, $2, $3,
      (SELECT tier FROM users WHERE id = $1),
      $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    ON CONFLICT (user_id, week_number, year)
    DO UPDATE SET
      score = EXCLUDED.score,
      pnl_pct = EXCLUDED.pnl_pct,
      win_rate = EXCLUDED.win_rate,
      max_drawdown = EXCLUDED.max_drawdown,
      consistency = EXCLUDED.consistency,
      profit_factor = EXCLUDED.profit_factor,
      sharpe_ratio = EXCLUDED.sharpe_ratio,
      avg_rrr = EXCLUDED.avg_rrr,
      streak = EXCLUDED.streak,
      total_trades = EXCLUDED.total_trades,
      score_multiplier = EXCLUDED.score_multiplier,
      relegate_immune = EXCLUDED.relegate_immune,
      updated_at = NOW()
    RETURNING *
  `;

  const { rows } = await query(sql, [
    userId, week, year, score,
    metrics.pnlPct, metrics.winRate, metrics.maxDrawdown,
    metrics.consistency, metrics.profitFactor, metrics.sharpeRatio,
    metrics.avgRRR, metrics.streak, metrics.totalTrades,
    multiplier, boosts.relegateImmune ?? false,
  ]);

  // Invalidate caches
  await invalidatePattern(`lb:page:*`);
  await invalidatePattern(`rank:${userId}`);

  return rows[0];
}

/**
 * Get paginated leaderboard for current week.
 */
async function getLeaderboard(page = 1, perPage = 10) {
  const { week, year } = getCurrentWeek();
  const cacheKey = CacheKeys.leaderboard(page);
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const offset = (page - 1) * perPage;
  const { rows: entries } = await query(`
    SELECT
      ws.score,
      ws.pnl_pct,
      ws.win_rate,
      ws.max_drawdown,
      ws.consistency,
      ws.total_trades,
      ws.tier,
      u.discord_id,
      u.username,
      u.avatar_url,
      ROW_NUMBER() OVER (ORDER BY ws.score DESC) as position
    FROM weekly_scores ws
    JOIN users u ON u.id = ws.user_id
    WHERE ws.week_number = $1 AND ws.year = $2 AND ws.is_archived = FALSE
    ORDER BY ws.score DESC
    LIMIT $3 OFFSET $4
  `, [week, year, perPage, offset]);

  const { rows: [{ total }] } = await query(`
    SELECT COUNT(*) as total FROM weekly_scores
    WHERE week_number = $1 AND year = $2 AND is_archived = FALSE
  `, [week, year]);

  const result = {
    entries,
    page,
    perPage,
    total: parseInt(total),
    totalPages: Math.ceil(parseInt(total) / perPage),
    week,
    year,
  };

  await setCache(cacheKey, result, config.redis.ttl.leaderboard);
  return result;
}

/**
 * Get a specific user's rank data for the current week.
 */
async function getUserRank(userId) {
  const { week, year } = getCurrentWeek();
  const cacheKey = CacheKeys.userRank(userId);
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const { rows } = await query(`
    WITH ranked AS (
      SELECT
        ws.*,
        u.username,
        u.avatar_url,
        u.hedge_points,
        u.best_rank_ever,
        ROW_NUMBER() OVER (PARTITION BY ws.tier ORDER BY ws.score DESC) as tier_position,
        ROW_NUMBER() OVER (ORDER BY ws.score DESC) as global_position,
        COUNT(*) OVER (PARTITION BY ws.tier) as tier_total
      FROM weekly_scores ws
      JOIN users u ON u.id = ws.user_id
      WHERE ws.week_number = $1 AND ws.year = $2 AND ws.is_archived = FALSE
    )
    SELECT * FROM ranked WHERE user_id = $3
  `, [week, year, userId]);

  if (rows.length === 0) return null;

  const row = rows[0];
  const tierOrder = config.tierOrder;
  const currentTierIdx = tierOrder.indexOf(row.tier);
  const nextTier = currentTierIdx < tierOrder.length - 1 ? tierOrder[currentTierIdx + 1] : null;

  // Calculate promotion progress
  let promotionProgress = 0;
  const tierConf = config.tiers[row.tier];
  if (tierConf.type === 'threshold' && nextTier) {
    const nextConf = config.tiers[nextTier];
    const current = parseFloat(row.score);
    promotionProgress = Math.min(1, (current - tierConf.minScore) / (nextConf.promoteScore - tierConf.minScore));
  } else if (tierConf.type === 'competitive') {
    // How far into the top % are they?
    const positionPct = row.tier_position / Math.max(1, row.tier_total);
    const promoPct = tierConf.promoPct / 100;
    promotionProgress = Math.max(0, Math.min(1, (promoPct - positionPct + promoPct) / (2 * promoPct)));
  }

  const result = {
    userId,
    username: row.username,
    avatarUrl: row.avatar_url,
    tier: row.tier,
    score: parseFloat(row.score),
    position: parseInt(row.global_position),
    tierPosition: parseInt(row.tier_position),
    tierTotal: parseInt(row.tier_total),
    nextTier,
    promotionProgress,
    hedgePoints: row.hedge_points,
    bestRankEver: row.best_rank_ever,
    week,
    year,
    metrics: {
      pnl: parseFloat(row.pnl_pct),
      winRate: parseFloat(row.win_rate),
      maxDrawdown: parseFloat(row.max_drawdown),
      consistency: parseFloat(row.consistency),
      profitFactor: row.profit_factor ? parseFloat(row.profit_factor) : null,
      sharpeRatio: row.sharpe_ratio ? parseFloat(row.sharpe_ratio) : null,
      avgRRR: row.avg_rrr ? parseFloat(row.avg_rrr) : null,
      streak: row.streak,
      totalTrades: row.total_trades,
    },
  };

  await setCache(cacheKey, result, 120); // 2min cache for personal rank
  return result;
}

/**
 * Weekly reset job — runs every Monday 00:00 UTC.
 * 1. Archives current week's scores
 * 2. Calculates promotions and relegations
 * 3. Updates user tiers
 * 4. Snapshots top-3 for Hedge Fund
 * 5. Clears boosts
 */
async function runWeeklyReset(client) {
  const { week, year } = getCurrentWeek();
  log.info(`Starting weekly reset for Week ${week} ${year}`);

  // 1. Mark all current scores as archived
  await client.query(`
    UPDATE weekly_scores
    SET is_archived = TRUE
    WHERE week_number = $1 AND year = $2 AND is_archived = FALSE
  `, [week, year]);

  // 2. Process tier changes for each tier
  for (const tierKey of config.tierOrder) {
    const tierConf = config.tiers[tierKey];
    const tierIdx = config.tierOrder.indexOf(tierKey);
    const nextTier = tierIdx < config.tierOrder.length - 1 ? config.tierOrder[tierIdx + 1] : null;
    const prevTier = tierIdx > 0 ? config.tierOrder[tierIdx - 1] : null;

    if (tierConf.type === 'threshold') {
      // Promote everyone above threshold score
      if (nextTier && tierConf.promoteScore) {
        await client.query(`
          UPDATE users SET tier = $1
          WHERE id IN (
            SELECT user_id FROM weekly_scores
            WHERE week_number = $2 AND year = $3
              AND tier = $4 AND score >= $5
          )
        `, [nextTier, week, year, tierKey, tierConf.promoteScore]);

        await client.query(`
          UPDATE weekly_scores SET promoted = TRUE
          WHERE week_number = $1 AND year = $2 AND tier = $3 AND score >= $4
        `, [week, year, tierKey, tierConf.promoteScore]);
      }

      // Relegate everyone below relegate threshold
      if (prevTier && tierConf.relegateScore != null) {
        await client.query(`
          UPDATE users SET tier = $1
          WHERE id IN (
            SELECT user_id FROM weekly_scores
            WHERE week_number = $2 AND year = $3
              AND tier = $4 AND score < $5 AND relegate_immune = FALSE
          )
        `, [prevTier, week, year, tierKey, tierConf.relegateScore]);
      }
    } else {
      // Competitive tier — use percentage-based promotion/relegation
      const { rows: tierUsers } = await client.query(`
        SELECT user_id, score, relegate_immune
        FROM weekly_scores
        WHERE week_number = $1 AND year = $2 AND tier = $3
        ORDER BY score DESC
      `, [week, year, tierKey]);

      const total = tierUsers.length;
      if (total === 0) continue;

      // Promote top X%
      if (nextTier && tierConf.promoPct) {
        const promoteCount = Math.max(1, Math.floor(total * tierConf.promoPct / 100));
        const toPromote = tierUsers.slice(0, promoteCount).map(r => r.user_id);
        if (toPromote.length > 0) {
          await client.query(`
            UPDATE users SET tier = $1 WHERE id = ANY($2::uuid[])
          `, [nextTier, toPromote]);
        }
      }

      // Relegate bottom X% (unless immune)
      if (prevTier && tierConf.relegPct) {
        const relegateCount = Math.max(1, Math.floor(total * tierConf.relegPct / 100));
        const bottomUsers = tierUsers.slice(-relegateCount);
        const toRelegate = bottomUsers
          .filter(r => !r.relegate_immune)
          .map(r => r.user_id);

        if (toRelegate.length > 0) {
          await client.query(`
            UPDATE users SET tier = $1 WHERE id = ANY($2::uuid[])
          `, [prevTier, toRelegate]);
        }
      }
    }
  }

  // 3. Get top-3 for Hedge Fund creation
  const { rows: top3 } = await client.query(`
    SELECT user_id FROM weekly_scores
    WHERE week_number = $1 AND year = $2 AND is_archived = TRUE
    ORDER BY score DESC
    LIMIT 3
  `, [week, year]);

  if (top3.length > 0) {
    const nextWeek = week === 52 ? 1 : week + 1;
    const nextYear = week === 52 ? year + 1 : year;
    await client.query(`
      INSERT INTO hedge_funds (week_number, year, trader_1_id, trader_2_id, trader_3_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (week_number, year) DO NOTHING
    `, [
      nextWeek, nextYear,
      top3[0]?.user_id ?? null,
      top3[1]?.user_id ?? null,
      top3[2]?.user_id ?? null,
    ]);
  }

  // 4. Expire weekly boosts
  await client.query(`
    UPDATE user_boosts SET is_active = FALSE
    WHERE expires_at < NOW() OR (week_number = $1 AND year = $2)
  `, [week, year]);

  // 5. Update best rank ever
  await client.query(`
    UPDATE users u
    SET best_rank_ever = sub.global_position
    FROM (
      SELECT user_id,
        ROW_NUMBER() OVER (ORDER BY score DESC) as global_position
      FROM weekly_scores
      WHERE week_number = $1 AND year = $2
    ) sub
    WHERE u.id = sub.user_id
      AND (u.best_rank_ever IS NULL OR sub.global_position < u.best_rank_ever)
  `, [week, year]);

  log.info(`Weekly reset complete for Week ${week} ${year}`);
  return { week, year, top3: top3.map(r => r.user_id) };
}

module.exports = {
  calculateScore,
  calculateConsistency,
  getCurrentWeek,
  upsertWeeklyScore,
  getLeaderboard,
  getUserRank,
  runWeeklyReset,
};
