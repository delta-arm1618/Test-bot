'use strict';

const { Events } = require('discord.js');
const { query, transaction } = require('../../db/pool');
const { registerUserInvite, recordInviteUse } = require('../modules/invites/inviteManager');
const { createLogger } = require('../utils/logger');
const config = require('../../config');

const log = createLogger('GuildMemberAdd');

module.exports = {
  name: Events.GuildMemberAdd,

  async execute(member, client) {
    const { guild, user } = member;

    log.info(`New member joined: ${user.username} (${user.id})`);

    try {
      // 1. Create/upsert user in DB
      await transaction(async (dbClient) => {
        await dbClient.query(`
          INSERT INTO users (discord_id, username, discriminator, avatar_url)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (discord_id) DO UPDATE SET
            username = EXCLUDED.username,
            avatar_url = EXCLUDED.avatar_url,
            last_active_at = NOW()
        `, [
          user.id,
          user.username,
          user.discriminator ?? '0',
          user.displayAvatarURL(),
        ]);
      });

      // 2. Detect which invite was used by comparing invite counts before/after
      let usedCode = null;
      let inviterId = null;

      try {
        // Fetch current guild invites snapshot
        const currentInvites = await guild.invites.fetch();

        // Compare with cached invite counts stored in Redis
        const { redis } = require('../utils/redis');
        const cachedRaw = await redis.get(`invites:${guild.id}`);
        const cachedInvites = cachedRaw ? JSON.parse(cachedRaw) : {};

        for (const [code, invite] of currentInvites) {
          const prevUses = cachedInvites[code] ?? 0;
          if (invite.uses > prevUses) {
            usedCode = code;
            if (invite.inviter) {
              // Find inviter in DB
              const { rows } = await query(
                'SELECT id FROM users WHERE discord_id = $1',
                [invite.inviter.id]
              );
              inviterId = rows[0]?.id ?? null;
            }
            break;
          }
        }

        // Update invite cache
        const newCache = {};
        for (const [code, invite] of currentInvites) {
          newCache[code] = invite.uses;
        }
        await redis.set(`invites:${guild.id}`, JSON.stringify(newCache));
      } catch (inviteErr) {
        log.warn('Could not detect invite code', { error: inviteErr.message });
      }

      // 3. Get the new user's DB ID
      const { rows: [dbUser] } = await query(
        'SELECT id FROM users WHERE discord_id = $1',
        [user.id]
      );

      // 4. Create the new user's own invite link for future referrals
      try {
        const newInvite = await guild.invites.create(
          guild.systemChannel ?? guild.channels.cache.first(),
          { maxAge: 0, maxUses: 0, reason: `Referral link for ${user.username}` }
        );
        await registerUserInvite(dbUser.id, newInvite.code);
      } catch (err) {
        log.warn(`Could not create invite for ${user.username}`, { error: err.message });
      }

      // 5. Record who invited them
      if (inviterId && usedCode) {
        await recordInviteUse(dbUser.id, inviterId, usedCode);
      }

      // 6. Send welcome DM
      try {
        const { rows: [inviteCode] } = await query(
          'SELECT code FROM invite_codes WHERE user_id = $1',
          [dbUser.id]
        );

        const inviteLink = inviteCode?.code
          ? `https://discord.gg/${inviteCode.code}`
          : 'Not yet assigned';

        await user.send({
          embeds: [{
            color: 0x5865F2,
            title: '👋 Welcome to the Trading Competition!',
            description: [
              `Welcome **${user.username}**! To unlock access to competitions, you need to invite **${config.invite.requiredCount} active traders**.`,
              '',
              `**Your personal invite link:**`,
              `\`${inviteLink}\``,
              '',
              'Each invite who stays active for 24h earns you **100 Hedge Points** 💰',
              '',
              '**Getting started:**',
              '• `/account link` — Link your demo broker account',
              '• `/invite status` — Check your invite progress',
              '• `/rank` — View your ranking once active',
            ].join('\n'),
            footer: { text: 'Trading Competition Bot' },
            timestamp: new Date().toISOString(),
          }],
        });
      } catch (dmErr) {
        log.debug(`Could not DM welcome to ${user.username}`);
      }

      log.info(`User ${user.username} onboarded successfully`);
    } catch (err) {
      log.error(`Failed to process new member ${user.username}`, { error: err.message });
    }
  },
};
