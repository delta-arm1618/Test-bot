'use strict';

const { Events } = require('discord.js');
const { createLogger } = require('../utils/logger');

const log = createLogger('InteractionCreate');

module.exports = {
  name: Events.InteractionCreate,

  async execute(interaction, client) {
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);

    if (!command) {
      log.warn(`No handler found for command: ${interaction.commandName}`);
      return;
    }

    try {
      log.debug(`Executing /${interaction.commandName} for ${interaction.user.username}`);
      await command.execute(interaction, client);
    } catch (err) {
      log.error(`Error executing /${interaction.commandName}`, {
        error: err.message,
        stack: err.stack,
        user: interaction.user.id,
      });

      const errorMessage = {
        content: '❌ An error occurred while executing this command. Please try again or contact an admin.',
        ephemeral: true,
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorMessage).catch(() => {});
      } else {
        await interaction.reply(errorMessage).catch(() => {});
      }
    }
  },
};
