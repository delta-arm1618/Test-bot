'use strict';

const cron = require('node-cron');
const { transaction } = require('../db/pool');
const { runWeeklyReset } = require('./modules/leaderboard/scoreEngine');
const { activatePendingInvites } = require('./modules/invites/inviteManager');
const { pollAllMetaApiAccounts } = require('./modules/tracking/accountTracker');
const { invalidatePattern } = require('./utils/redis');
const { createLogger } = require('./utils/logger');
const config = require('../config');

const log = createLogger('Scheduler');

/**
 * Register all cron jobs.
 * @param {import('discord.js').Client} client - Discord client for guild access
 */
function registerSchedulers(client) {

  // ── Weekly Reset — Every Monday 00:00 UTC ────────────────
  cron.schedule('0 0 * * 1', async () => {
    log.info('🔄 Running weekly reset...');
    try {
      const result = await transaction(async (dbClient) => {
        return runWeeklyReset(dbClient);
      });

      await invalidatePattern('lb:page:*');
      await invalidatePattern('rank:*');
      await invalidatePattern('score:*');

      // Announce in #announcements channel
      const channel = client.channels.cache.get(config.discord.channels.announcements);
      if (channel) {
        await channel.send({
          embeds: [{
            color: 0xFFD700,
            title: '🏆 Weekly Reset Complete!',
            description: [
              'A new trading week has begun! Scores have been archived, promotions and relegations applied.',
              '',
              `🌟 **Top 3 traders** have formed this week's **Hedge Fund** — invest your HP with \`/fund list\`!`,
              '',
              '🎯 Use \`/rank\` to see your new tier.',
              '📊 Use \`/leaderboard\` to see the fresh rankings.',
            ].join('\n'),
            footer: { text: 'Good luck this week! • Trading Competition Bot' },
            timestamp: new Date().toISOString(),
          }],
        });
      }

      log.info(`Weekly reset done. Top 3: ${result.top3.join(', ')}`);
    } catch (err) {
      log.error('Weekly reset failed', { error: err.message, stack: err.stack });
    }
  }, { timezone: 'UTC' });

  // ── Invite Activation — Every 30 minutes ─────────────────
  cron.schedule('*/30 * * * *', async () => {
    log.debug('Checking pending invites...');
    try {
      const guild = client.guilds.cache.get(config.discord.guildId);
      if (!guild) return;
      const count = await activatePendingInvites(guild);
      if (count > 0) log.info(`Activated ${count} pending invites`);
    } catch (err) {
      log.error('Invite activation failed', { error: err.message });
    }
  });

  // ── MetaApi Polling — Configurable interval ───────────────
  const pollMinutes = config.metaapi.pollIntervalMinutes;
  cron.schedule(`*/${pollMinutes} * * * *`, async () => {
    log.debug('Polling MetaApi accounts...');
    try {
      await pollAllMetaApiAccounts();
    } catch (err) {
      log.error('MetaApi poll failed', { error: err.message });
    }
  });

  // ── Season Vote — Every Friday 18:00 UTC ─────────────────
  cron.schedule('0 18 * * 5', async () => {
    log.info('📊 Posting weekly season vote...');
    try {
      const { postSeasonVote } = require('./modules/seasons/seasonManager');
      const guild = client.guilds.cache.get(config.discord.guildId);
      if (guild) await postSeasonVote(guild, client);
    } catch (err) {
      log.error('Season vote post failed', { error: err.message });
    }
  }, { timezone: 'UTC' });

  // ── Season Vote Close + Announce — Every Sunday 23:00 UTC ─
  cron.schedule('0 23 * * 0', async () => {
    log.info('🗳️ Closing season vote and announcing rule...');
    try {
      const { resolveSeasonVote } = require('./modules/seasons/seasonManager');
      const guild = client.guilds.cache.get(config.discord.guildId);
      if (guild) await resolveSeasonVote(guild, client);
    } catch (err) {
      log.error('Season vote resolution failed', { error: err.message });
    }
  }, { timezone: 'UTC' });

  // ── Battle Expiry Check — Every 5 minutes ────────────────
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { resolveExpiredBattles } = require('./modules/battles/battleManager');
      await resolveExpiredBattles(client);
    } catch (err) {
      log.error('Battle expiry check failed', { error: err.message });
    }
  });

  // ── Hedge Fund Distribution — Every Monday 00:10 UTC ─────
  // (10 min after weekly reset to ensure scores are archived)
  cron.schedule('10 0 * * 1', async () => {
    log.info('💰 Processing Hedge Fund distributions...');
    try {
      const { distributeHedgeFundReturns } = require('./modules/hedgefund/hedgeFundManager');
      const guild = client.guilds.cache.get(config.discord.guildId);
      await distributeHedgeFundReturns(client, guild);
    } catch (err) {
      log.error('Hedge fund distribution failed', { error: err.message });
    }
  }, { timezone: 'UTC' });

  log.info('✅ All schedulers registered');
}

module.exports = { registerSchedulers };
