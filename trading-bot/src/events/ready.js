'use strict';

const { Events, ActivityType } = require('discord.js');
const { createLogger } = require('../utils/logger');
const { redis } = require('../utils/redis');

const log = createLogger('Ready');

module.exports = {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    log.info(`✅ Bot online as ${client.user.tag}`);
    log.info(`📡 Serving ${client.guilds.cache.size} guild(s)`);

    // Set bot status
    client.user.setPresence({
      activities: [{
        name: '📈 Weekly Trading Competition',
        type: ActivityType.Watching,
      }],
      status: 'online',
    });

    // Pre-cache all guild invites on startup (needed for join detection)
    for (const [, guild] of client.guilds.cache) {
      try {
        const invites = await guild.invites.fetch();
        const cache = {};
        for (const [code, invite] of invites) {
          cache[code] = invite.uses;
        }
        await redis.set(`invites:${guild.id}`, JSON.stringify(cache));
        log.debug(`Cached ${invites.size} invites for guild ${guild.name}`);
      } catch (err) {
        log.warn(`Could not cache invites for guild ${guild.name}`, { error: err.message });
      }
    }
  },
};
