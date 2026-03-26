'use strict';

const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require('discord.js');
const { getLeaderboard } = require('../../modules/leaderboard/scoreEngine');
const { leaderboardEmbed, errorEmbed } = require('../../utils/embeds');

const PER_PAGE = 10;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View the weekly trading leaderboard.')
    .addIntegerOption(opt =>
      opt.setName('page')
        .setDescription('Page number (default: 1)')
        .setMinValue(1)
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    let page = interaction.options.getInteger('page') ?? 1;
    const data = await getLeaderboard(page, PER_PAGE);

    if (data.total === 0) {
      return interaction.editReply({
        embeds: [errorEmbed('No Data', 'No traders on the leaderboard yet this week!')],
      });
    }

    // Clamp page
    page = Math.min(page, data.totalPages);
    const embed = leaderboardEmbed(data.entries, page, data.totalPages, data.week);

    // Build navigation buttons
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('lb_prev')
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 1),
      new ButtonBuilder()
        .setCustomId('lb_next')
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= data.totalPages),
    );

    const msg = await interaction.editReply({
      embeds: [embed],
      components: data.totalPages > 1 ? [row] : [],
    });

    if (data.totalPages <= 1) return;

    // Collect button presses for 60 seconds
    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 60_000,
      filter: (i) => i.user.id === interaction.user.id,
    });

    let currentPage = page;

    collector.on('collect', async (btn) => {
      await btn.deferUpdate();

      if (btn.customId === 'lb_prev') currentPage = Math.max(1, currentPage - 1);
      if (btn.customId === 'lb_next') currentPage = Math.min(data.totalPages, currentPage + 1);

      const newData = await getLeaderboard(currentPage, PER_PAGE);
      const newEmbed = leaderboardEmbed(newData.entries, currentPage, newData.totalPages, newData.week);

      const newRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('lb_prev')
          .setLabel('◀ Prev')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage <= 1),
        new ButtonBuilder()
          .setCustomId('lb_next')
          .setLabel('Next ▶')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage >= newData.totalPages),
      );

      await interaction.editReply({ embeds: [newEmbed], components: [newRow] });
    });

    collector.on('end', () => {
      interaction.editReply({ components: [] }).catch(() => {});
    });
  },
};
