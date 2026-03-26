'use strict';

const { query, transaction } = require('../../../db/pool');
const { getCurrentWeek } = require('../leaderboard/scoreEngine');
const { createLogger } = require('../../utils/logger');
const config = require('../../../config');

const log = createLogger('HedgeFundManager');

// HP reward multiplier: if fund performs well, investors get % back
const HP_RETURN_MULTIPLIER = 1.5; // 150% of invested HP if fund is top performer
const HP_BASE_RETURN = 1.0;       // 100% return = break even
const HP_LOSS_FACTOR = 0.5;       // Lose 50% of invested HP if fund underperforms

/**
 * Get the current active hedge fund for this week.
 */
async function getActiveFund(week, year) {
  const { rows: [fund] } = await query(
    'SELECT * FROM hedge_funds WHERE week_number = $1 AND year = $2 AND is_active = TRUE',
    [week, year]
  );
  return fund ?? null;
}

/**
 * Get all active hedge funds with trader info.
 */
async function getActiveFunds(week, year) {
  const { rows } = await query(`
    SELECT
      hf.*,
      u1.username AS trader_1_name, u1.tier AS trader_1_tier,
      u2.username AS trader_2_name, u2.tier AS trader_2_tier,
      u3.username AS trader_3_name, u3.tier AS trader_3_tier,
      ws1.score AS trader_1_score,
      ws2.score AS trader_2_score,
      ws3.score AS trader_3_score,
      COALESCE(SUM(fi.amount_hp), 0) AS total_invested
    FROM hedge_funds hf
    LEFT JOIN users u1 ON u1.id = hf.trader_1_id
    LEFT JOIN users u2 ON u2.id = hf.trader_2_id
    LEFT JOIN users u3 ON u3.id = hf.trader_3_id
    LEFT JOIN weekly_scores ws1 ON ws1.user_id = hf.trader_1_id
      AND ws1.week_number = hf.week_number AND ws1.year = hf.year AND ws1.is_archived = FALSE
    LEFT JOIN weekly_scores ws2 ON ws2.user_id = hf.trader_2_id
      AND ws2.week_number = hf.week_number AND ws2.year = hf.year AND ws2.is_archived = FALSE
    LEFT JOIN weekly_scores ws3 ON ws3.user_id = hf.trader_3_id
      AND ws3.week_number = hf.week_number AND ws3.year = hf.year AND ws3.is_archived = FALSE
    LEFT JOIN fund_investments fi ON fi.fund_id = hf.id
    WHERE hf.week_number = $1 AND hf.year = $2
    GROUP BY hf.id, u1.username, u1.tier, u2.username, u2.tier, u3.username, u3.tier,
             ws1.score, ws2.score, ws3.score
    ORDER BY hf.created_at ASC
  `, [week, year]);
  return rows;
}

/**
 * Invest HP into a hedge fund.
 *
 * @param {string} userDiscordId
 * @param {string} fundId
 * @param {number} amountHp
 */
async function investInFund(userDiscordId, fundId, amountHp) {
  if (!Number.isInteger(amountHp) || amountHp <= 0) {
    throw new Error('Amount must be a positive integer.');
  }

  const { rows: [user] } = await query(
    'SELECT * FROM users WHERE discord_id = $1',
    [userDiscordId]
  );
  if (!user) throw new Error('User not found.');
  if (!user.is_verified) throw new Error('You need to complete the Invite Gate first.');
  if (user.hedge_points < amountHp) {
    throw new Error(`Insufficient HP. You have **${user.hedge_points} HP**, need **${amountHp} HP**.`);
  }

  const { rows: [fund] } = await query(
    'SELECT * FROM hedge_funds WHERE id = $1 AND is_active = TRUE',
    [fundId]
  );
  if (!fund) throw new Error('Fund not found or is no longer active.');

  // Check week is current
  const { week, year } = getCurrentWeek();
  if (fund.week_number !== week || fund.year !== year) {
    throw new Error('This fund is from a past week and is no longer accepting investments.');
  }

  // Check if already invested
  const { rows: existing } = await query(
    'SELECT * FROM fund_investments WHERE fund_id = $1 AND user_id = $2',
    [fundId, user.id]
  );

  await transaction(async (client) => {
    if (existing.length > 0) {
      // Add to existing investment
      await client.query(
        'UPDATE fund_investments SET amount_hp = amount_hp + $1 WHERE fund_id = $2 AND user_id = $3',
        [amountHp, fundId, user.id]
      );
    } else {
      await client.query(
        'INSERT INTO fund_investments (fund_id, user_id, amount_hp) VALUES ($1, $2, $3)',
        [fundId, user.id, amountHp]
      );
    }

    // Deduct HP from user
    const { rows: [updated] } = await client.query(
      'UPDATE users SET hedge_points = hedge_points - $1 WHERE id = $2 RETURNING hedge_points',
      [amountHp, user.id]
    );

    // Log HP transaction
    await client.query(
      'INSERT INTO hp_transactions (user_id, amount, balance_after, reason, reference_id) VALUES ($1, $2, $3, $4, $5)',
      [user.id, -amountHp, updated.hedge_points, 'fund_investment', fundId]
    );

    // Update fund total
    await client.query(
      'UPDATE hedge_funds SET total_invested = total_invested + $1 WHERE id = $2',
      [amountHp, fundId]
    );
  });

  log.info(`${user.username} invested ${amountHp} HP in fund ${fundId}`);
  return { amountHp, newBalance: user.hedge_points - amountHp };
}

/**
 * Distribute returns for all resolved hedge funds.
 * Called by cron on Monday 00:10 UTC (after weekly reset).
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild} guild
 */
async function distributeHedgeFundReturns(client, guild) {
  const { week, year } = getCurrentWeek();
  // Distribute for PREVIOUS week (which just got archived)
  const prevWeek = week === 1 ? 52 : week - 1;
  const prevYear = week === 1 ? year - 1 : year;

  const { rows: funds } = await query(
    'SELECT * FROM hedge_funds WHERE week_number = $1 AND year = $2 AND is_active = TRUE',
    [prevWeek, prevYear]
  );

  if (funds.length === 0) {
    log.info('No active funds to resolve for previous week');
    return;
  }

  // Get all traders' scores for prev week (archived)
  const { rows: scores } = await query(`
    SELECT user_id, score FROM weekly_scores
    WHERE week_number = $1 AND year = $2 AND is_archived = TRUE
    ORDER BY score DESC
  `, [prevWeek, prevYear]);

  const maxScore = scores.length > 0 ? parseFloat(scores[0].score) : 1;

  for (const fund of funds) {
    try {
      await resolveSingleFund(fund, scores, maxScore, client, guild);
    } catch (err) {
      log.error(`Failed to resolve fund ${fund.id}`, { error: err.message });
    }
  }
}

/**
 * Resolve a single fund and distribute HP.
 */
async function resolveSingleFund(fund, scores, maxScore, client, guild) {
  // Compute fund performance: average score of its 3 traders
  const traderIds = [fund.trader_1_id, fund.trader_2_id, fund.trader_3_id].filter(Boolean);
  const traderScores = scores.filter(s => traderIds.includes(s.user_id));
  const avgScore = traderScores.length > 0
    ? traderScores.reduce((sum, s) => sum + parseFloat(s.score), 0) / traderScores.length
    : 0;

  const performancePct = maxScore > 0 ? avgScore / maxScore : 0;

  // Determine multiplier based on performance
  // Top 33%: 1.5x | Middle 33%: 1.0x | Bottom 33%: 0.5x
  let multiplier;
  if (performancePct >= 0.66) multiplier = HP_RETURN_MULTIPLIER;
  else if (performancePct >= 0.33) multiplier = HP_BASE_RETURN;
  else multiplier = HP_LOSS_FACTOR;

  // Get all investments for this fund
  const { rows: investments } = await query(
    'SELECT * FROM fund_investments WHERE fund_id = $1 AND return_hp IS NULL',
    [fund.id]
  );

  for (const inv of investments) {
    const returnHp = Math.floor(inv.amount_hp * multiplier);
    const profit = returnHp - inv.amount_hp;

    await transaction(async (dbClient) => {
      // Update investment record
      await dbClient.query(
        'UPDATE fund_investments SET return_hp = $1 WHERE id = $2',
        [returnHp, inv.id]
      );

      // Credit HP to investor
      const { rows: [updated] } = await dbClient.query(
        'UPDATE users SET hedge_points = hedge_points + $1 WHERE id = $2 RETURNING hedge_points',
        [returnHp, inv.user_id]
      );

      // Log HP transaction
      const reason = profit > 0 ? 'fund_return_profit' : profit < 0 ? 'fund_return_loss' : 'fund_return_neutral';
      await dbClient.query(
        'INSERT INTO hp_transactions (user_id, amount, balance_after, reason, reference_id) VALUES ($1, $2, $3, $4, $5)',
        [inv.user_id, returnHp, updated.hedge_points, reason, fund.id]
      );
    });
  }

  // Mark fund as resolved
  await query(
    'UPDATE hedge_funds SET is_active = FALSE, performance_pct = $1, resolved_at = NOW() WHERE id = $2',
    [performancePct * 100, fund.id]
  );

  log.info(`Resolved fund ${fund.id}: perf=${(performancePct * 100).toFixed(1)}%, multiplier=${multiplier}x, investors=${investments.length}`);

  // Announce in channel
  if (client && config.discord.channels.announcements) {
    const channel = client.channels.cache.get(config.discord.channels.announcements);
    if (channel) {
      await channel.send({
        embeds: [buildFundResultEmbed(fund, performancePct, multiplier, investments.length)],
      }).catch(() => {});
    }
  }
}

/**
 * Get a user's investment history.
 */
async function getUserInvestments(userDiscordId, week, year) {
  const { rows: [user] } = await query('SELECT id FROM users WHERE discord_id = $1', [userDiscordId]);
  if (!user) return [];

  const { rows } = await query(`
    SELECT fi.*, hf.week_number, hf.year, hf.performance_pct, hf.is_active,
           u1.username AS trader_1_name, u2.username AS trader_2_name, u3.username AS trader_3_name
    FROM fund_investments fi
    JOIN hedge_funds hf ON hf.id = fi.fund_id
    LEFT JOIN users u1 ON u1.id = hf.trader_1_id
    LEFT JOIN users u2 ON u2.id = hf.trader_2_id
    LEFT JOIN users u3 ON u3.id = hf.trader_3_id
    WHERE fi.user_id = $1
    ORDER BY fi.invested_at DESC
    LIMIT 10
  `, [user.id]);
  return rows;
}

/**
 * Build embed for resolved fund result.
 */
function buildFundResultEmbed(fund, performancePct, multiplier, investorCount) {
  const perfLabel = multiplier >= HP_RETURN_MULTIPLIER ? '🚀 Excellent' : multiplier >= HP_BASE_RETURN ? '📊 Neutral' : '📉 Poor';
  const color = multiplier >= HP_RETURN_MULTIPLIER ? 0xFFD700 : multiplier >= HP_BASE_RETURN ? 0x5865F2 : 0xED4245;

  return {
    color,
    title: '💼 Hedge Fund — Weekly Results',
    fields: [
      { name: '📊 Fund Performance', value: `${(performancePct * 100).toFixed(1)}% of max possible`, inline: true },
      { name: '💰 Return Multiplier', value: `${multiplier}x`, inline: true },
      { name: '👥 Total Investors', value: `${investorCount}`, inline: true },
      { name: '📈 Result', value: perfLabel, inline: true },
    ],
    description: multiplier >= HP_BASE_RETURN
      ? `Investors have been refunded with a **${((multiplier - 1) * 100).toFixed(0)}% profit**!`
      : `Investors received back **${(multiplier * 100).toFixed(0)}%** of their investment.`,
    footer: { text: 'Trading Competition Bot • Invest next week with /fund invest' },
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  getActiveFund,
  getActiveFunds,
  investInFund,
  distributeHedgeFundReturns,
  getUserInvestments,
  buildFundResultEmbed,
  HP_RETURN_MULTIPLIER,
  HP_BASE_RETURN,
  HP_LOSS_FACTOR,
};
