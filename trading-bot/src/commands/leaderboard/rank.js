'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { getUserRank } = require('../../modules/leaderboard/scoreEngine');
const { rankEmbed, errorEmbed } = require('../../utils/embeds');
const { query } = require('../../../db/pool');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rank')
    .setDescription('View your current rank, tier, and weekly stats.')
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('View another user\'s rank (leave blank for your own)')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const targetUser = interaction.options.getUser('user') ?? interaction.user;

    // Get user from DB
    const { rows: [dbUser] } = await query(
      'SELECT * FROM users WHERE discord_id = $1',
      [targetUser.id]
    );

    if (!dbUser) {
      return interaction.editReply({
        embeds: [errorEmbed('User Not Found', `${targetUser.username} hasn't registered yet. They need to link a broker account first.`)],
      });
    }

    const rankData = await getUserRank(dbUser.id);

    if (!rankData) {
      return interaction.editReply({
        embeds: [errorEmbed('No Data Yet', `${targetUser.username} has no score data for this week. Make sure a broker account is linked and active.`)],
      });
    }

    const embed = rankEmbed(targetUser, rankData);
    return interaction.editReply({ embeds: [embed] });
  },
};
