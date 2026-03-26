'use strict';

const { query, transaction } = require('../../../db/pool');
const config = require('../../../config');
const { createLogger } = require('../../utils/logger');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');

dayjs.extend(utc);

const log = createLogger('InviteManager');

// HP awarded per validated invite
const HP_PER_INVITE = 100;

/**
 * Register or retrieve the invite code for a user.
 * Called when a user first joins the server.
 */
async function registerUserInvite(userId, discordInviteCode) {
  const existing = await query(
    'SELECT * FROM invite_codes WHERE user_id = $1',
    [userId]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const { rows } = await query(`
    INSERT INTO invite_codes (user_id, code, discord_url)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id) DO UPDATE SET code = EXCLUDED.code
    RETURNING *
  `, [userId, discordInviteCode, `https://discord.gg/${discordInviteCode}`]);

  log.info(`Registered invite code for user ${userId}: ${discordInviteCode}`);
  return rows[0];
}

/**
 * Record that a new user joined via an inviter's code.
 * Called in the guildMemberAdd event.
 *
 * @param {string} inviteeUserId  - The new member's user ID
 * @param {string} inviterUserId  - The inviter's user ID
 * @param {string} code           - The invite code used
 */
async function recordInviteUse(inviteeUserId, inviterUserId, code) {
  if (inviteeUserId === inviterUserId) return; // Can't invite yourself

  try {
    await transaction(async (client) => {
      await client.query(`
        INSERT INTO invite_uses (inviter_id, invitee_id, code, status)
        VALUES ($1, $2, $3, 'pending')
        ON CONFLICT (invitee_id) DO NOTHING
      `, [inviterUserId, inviteeUserId, code]);

      await client.query(`
        UPDATE invite_codes SET uses_count = uses_count + 1
        WHERE user_id = $1
      `, [inviterUserId]);
    });

    log.info(`Invite use recorded: ${inviteeUserId} joined via ${inviterUserId} (code: ${code})`);
  } catch (err) {
    log.error('Failed to record invite use', { error: err.message });
  }
}

/**
 * Check and activate pending invites that have been active for 24h.
 * Called by cron every 30 minutes.
 */
async function activatePendingInvites(guild) {
  const cutoff = dayjs.utc().subtract(config.invite.activeHours, 'hour').toISOString();

  const { rows: pending } = await query(`
    SELECT iu.*, u_inviter.discord_id as inviter_discord_id
    FROM invite_uses iu
    JOIN users u_invitee ON u_invitee.id = iu.invitee_id
    JOIN users u_inviter ON u_inviter.id = iu.inviter_id
    WHERE iu.status = 'pending' AND iu.joined_at <= $1
  `, [cutoff]);

  let activated = 0;
  for (const invite of pending) {
    // Verify the invitee is still on the server
    try {
      const member = await guild.members.fetch(invite.inviter_discord_id).catch(() => null);
      if (!member) {
        // Invitee left — mark expired
        await query('UPDATE invite_uses SET status = $1 WHERE id = $2', ['expired', invite.id]);
        continue;
      }
    } catch {
      continue;
    }

    await transaction(async (client) => {
      // Activate the invite
      await client.query(`
        UPDATE invite_uses SET status = 'active', activated_at = NOW(), hp_awarded = $1
        WHERE id = $2
      `, [HP_PER_INVITE, invite.id]);

      // Award HP to inviter
      const { rows: [inviter] } = await client.query(
        'UPDATE users SET hedge_points = hedge_points + $1 WHERE id = $2 RETURNING hedge_points',
        [HP_PER_INVITE, invite.inviter_id]
      );

      // Log HP transaction
      await client.query(`
        INSERT INTO hp_transactions (user_id, amount, balance_after, reason, reference_id)
        VALUES ($1, $2, $3, 'invite_bonus', $4)
      `, [invite.inviter_id, HP_PER_INVITE, inviter.hedge_points, invite.id]);

      // Check if inviter has enough valid invites to unlock
      await checkAndUnlockTrader(client, invite.inviter_id, guild);
    });

    activated++;
    log.info(`Activated invite from ${invite.inviter_id} for ${invite.invitee_id}`);
  }

  if (activated > 0) log.info(`Activated ${activated} pending invites`);
  return activated;
}

/**
 * Check if user has enough valid invites to be verified.
 * Assigns @Verified Trader role if so.
 */
async function checkAndUnlockTrader(client, userId, guild) {
  const { rows: [{ count }] } = await client.query(`
    SELECT COUNT(*) FROM invite_uses
    WHERE inviter_id = $1 AND status = 'active'
  `, [userId]);

  const validCount = parseInt(count);
  if (validCount < config.invite.requiredCount) return false;

  const { rows: [user] } = await client.query(
    'SELECT * FROM users WHERE id = $1',
    [userId]
  );

  if (user.is_verified) return true; // Already verified

  await client.query(
    'UPDATE users SET is_verified = TRUE WHERE id = $1',
    [userId]
  );

  // Assign Discord role
  if (guild && config.discord.roles.verifiedTrader) {
    try {
      const member = await guild.members.fetch(user.discord_id);
      await member.roles.add(config.discord.roles.verifiedTrader);
      log.info(`Assigned @Verified Trader to ${user.username}`);
    } catch (err) {
      log.warn(`Could not assign role to ${user.discord_id}`, { error: err.message });
    }
  }

  return true;
}

/**
 * Get invite stats for a user.
 */
async function getUserInviteStats(userId) {
  const { rows: [code] } = await query(
    'SELECT * FROM invite_codes WHERE user_id = $1',
    [userId]
  );

  const { rows: invites } = await query(`
    SELECT iu.*, u.username as invitee_username
    FROM invite_uses iu
    JOIN users u ON u.id = iu.invitee_id
    WHERE iu.inviter_id = $1
    ORDER BY iu.joined_at DESC
  `, [userId]);

  const validInvites = invites.filter(i => i.status === 'active').length;
  const pendingInvites = invites.filter(i => i.status === 'pending').length;
  const hpEarned = invites.reduce((sum, i) => sum + (i.hp_awarded || 0), 0);

  return {
    code: code?.code ?? null,
    invites,
    validInvites,
    pendingInvites,
    hpEarned,
    isUnlocked: validInvites >= config.invite.requiredCount,
  };
}

/**
 * Get top inviters leaderboard.
 */
async function getInviteLeaderboard(limit = 10) {
  const { rows } = await query(`
    SELECT
      u.username,
      u.discord_id,
      COUNT(*) FILTER (WHERE iu.status = 'active') as valid_invites,
      COUNT(*) as total_invites,
      SUM(iu.hp_awarded) as hp_earned
    FROM users u
    LEFT JOIN invite_uses iu ON iu.inviter_id = u.id
    GROUP BY u.id, u.username, u.discord_id
    ORDER BY valid_invites DESC, hp_earned DESC
    LIMIT $1
  `, [limit]);

  return rows;
}

module.exports = {
  registerUserInvite,
  recordInviteUse,
  activatePendingInvites,
  checkAndUnlockTrader,
  getUserInviteStats,
  getInviteLeaderboard,
  HP_PER_INVITE,
};
