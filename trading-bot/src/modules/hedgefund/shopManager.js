'use strict';

const { query, transaction } = require('../../../db/pool');
const { getCurrentWeek } = require('../leaderboard/scoreEngine');
const { createLogger } = require('../../utils/logger');
const { invalidatePattern, CacheKeys } = require('../../utils/redis');

const log = createLogger('ShopManager');

/**
 * Get all active shop items.
 */
async function getShopItems() {
  const { rows } = await query(
    'SELECT * FROM shop_items WHERE is_active = TRUE ORDER BY cost_hp ASC'
  );
  return rows;
}

/**
 * Purchase a boost from the shop.
 *
 * @param {string} userDiscordId
 * @param {string} boostType - must match a valid boost_type enum value
 * @returns {Object} purchase result
 */
async function purchaseBoost(userDiscordId, boostType) {
  const { rows: [user] } = await query(
    'SELECT * FROM users WHERE discord_id = $1',
    [userDiscordId]
  );
  if (!user) throw new Error('User not found.');
  if (!user.is_verified) throw new Error('You need to complete the Invite Gate first.');

  const { rows: [item] } = await query(
    'SELECT * FROM shop_items WHERE boost_type = $1 AND is_active = TRUE',
    [boostType]
  );
  if (!item) throw new Error('Item not found or unavailable.');

  if (user.hedge_points < item.cost_hp) {
    throw new Error(`Not enough HP. You have **${user.hedge_points} HP**, need **${item.cost_hp} HP**.`);
  }

  const { week, year } = getCurrentWeek();

  // Check if user already has this boost active this week
  const { rows: existing } = await query(`
    SELECT * FROM user_boosts
    WHERE user_id = $1
      AND boost_type = $2
      AND is_active = TRUE
      AND (expires_at IS NULL OR expires_at > NOW())
      AND used_at IS NULL
  `, [user.id, boostType]);

  if (existing.length > 0) {
    throw new Error(`You already have an active **${item.name}** boost. Wait for it to expire before purchasing again.`);
  }

  let expiresAt = null;
  if (item.duration_hours) {
    expiresAt = new Date(Date.now() + item.duration_hours * 3600 * 1000);
  }

  const result = await transaction(async (client) => {
    // Deduct HP
    const { rows: [updated] } = await client.query(
      'UPDATE users SET hedge_points = hedge_points - $1 WHERE id = $2 RETURNING hedge_points',
      [item.cost_hp, user.id]
    );

    // Create boost
    const { rows: [boost] } = await client.query(`
      INSERT INTO user_boosts (user_id, boost_type, week_number, year, expires_at, is_active)
      VALUES ($1, $2, $3, $4, $5, TRUE)
      RETURNING *
    `, [user.id, boostType, week, year, expiresAt]);

    // Log HP transaction
    await client.query(
      'INSERT INTO hp_transactions (user_id, amount, balance_after, reason, reference_id) VALUES ($1, $2, $3, $4, $5)',
      [user.id, -item.cost_hp, updated.hedge_points, 'shop_purchase', boost.id]
    );

    return { boost, newBalance: updated.hedge_points };
  });

  // Invalidate score cache so boost takes effect immediately
  await invalidatePattern(`rank:${user.id}`);
  await invalidatePattern('lb:page:*');

  log.info(`${user.username} purchased boost: ${boostType} for ${item.cost_hp} HP`);
  return {
    item,
    boost: result.boost,
    newBalance: result.newBalance,
  };
}

/**
 * Get all active boosts for a user (formatted for display).
 */
async function getUserBoosts(userDiscordId) {
  const { rows: [user] } = await query('SELECT id FROM users WHERE discord_id = $1', [userDiscordId]);
  if (!user) return [];

  const { rows } = await query(`
    SELECT ub.*, si.name AS item_name, si.description, si.cost_hp
    FROM user_boosts ub
    JOIN shop_items si ON si.boost_type = ub.boost_type
    WHERE ub.user_id = $1
      AND ub.is_active = TRUE
      AND (ub.expires_at IS NULL OR ub.expires_at > NOW())
    ORDER BY ub.created_at DESC
  `, [user.id]);
  return rows;
}

/**
 * Get a user's HP balance and last 10 transactions.
 */
async function getHpSummary(userDiscordId) {
  const { rows: [user] } = await query(
    'SELECT id, hedge_points FROM users WHERE discord_id = $1',
    [userDiscordId]
  );
  if (!user) return null;

  const { rows: transactions } = await query(`
    SELECT amount, balance_after, reason, created_at
    FROM hp_transactions
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 10
  `, [user.id]);

  return {
    balance: user.hedge_points,
    transactions,
  };
}

module.exports = {
  getShopItems,
  purchaseBoost,
  getUserBoosts,
  getHpSummary,
};
