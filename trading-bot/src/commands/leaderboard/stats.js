'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { getUserRank } = require('../../modules/leaderboard/scoreEngine');
const { statsEmbed, errorEmbed } = require('../../utils/embeds');
const { query } = require('../../../db/pool');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('View detailed trading statistics for a user.')
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('User to look up (default: yourself)')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const targetUser = interaction.options.getUser('user') ?? interaction.user;
    const { rows: [dbUser] } = await query(
      'SELECT * FROM users WHERE discord_id = $1',
      [targetUser.id]
    );

    if (!dbUser) {
      return interaction.editReply({
        embeds: [errorEmbed('User Not Found', `${targetUser.username} hasn't set up an account yet.`)],
      });
    }

    const rankData = await getUserRank(dbUser.id);

    if (!rankData) {
      return interaction.editReply({
        embeds: [errorEmbed('No Stats', `No trading data found for ${targetUser.username} this week.`)],
      });
    }

    const statsData = {
      ...rankData,
      hedgePoints: dbUser.hedge_points,
    };

    return interaction.editReply({ embeds: [statsEmbed(targetUser, statsData)] });
  },
};
