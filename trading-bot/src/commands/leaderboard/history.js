'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { query } = require('../../../db/pool');
const { TIER_COLORS, errorEmbed } = require('../../utils/embeds');
const config = require('../../../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('history')
    .setDescription('View weekly performance history.')
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('User to look up (default: yourself)')
        .setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('weeks')
        .setDescription('How many past weeks to show (default: 8, max: 20)')
        .setMinValue(1)
        .setMaxValue(20)
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const targetUser = interaction.options.getUser('user') ?? interaction.user;
    const weeks = interaction.options.getInteger('weeks') ?? 8;

    const { rows: [dbUser] } = await query(
      'SELECT * FROM users WHERE discord_id = $1',
      [targetUser.id]
    );

    if (!dbUser) {
      return interaction.editReply({
        embeds: [errorEmbed('User Not Found', `${targetUser.username} has no account.`)],
      });
    }

    const { rows: history } = await query(`
      SELECT week_number, year, tier, score, pnl_pct, win_rate,
             max_drawdown, total_trades, promoted, relegated
      FROM weekly_scores
      WHERE user_id = $1 AND is_archived = TRUE
      ORDER BY year DESC, week_number DESC
      LIMIT $2
    `, [dbUser.id, weeks]);

    if (history.length === 0) {
      return interaction.editReply({
        embeds: [errorEmbed('No History', `No archived weeks found for ${targetUser.username}.`)],
      });
    }

    const lines = history.map(row => {
      const tier = config.tiers[row.tier];
      const badge = row.promoted ? ' 🔺' : row.relegated ? ' 🔻' : '';
      const pnl = parseFloat(row.pnl_pct);
      const pnlStr = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`;
      return `**W${row.week_number}/${row.year}** ${tier.emoji} ${tier.name}${badge} — \`${parseFloat(row.score).toFixed(1)} pts\` | PnL: ${pnlStr} | WR: ${(parseFloat(row.win_rate) * 100).toFixed(0)}% | Trades: ${row.total_trades}`;
    });

    const embed = new EmbedBuilder()
      .setColor(TIER_COLORS[dbUser.tier] ?? 0x5865F2)
      .setTitle(`📅 ${targetUser.username} — Weekly History`)
      .setThumbnail(targetUser.displayAvatarURL())
      .setDescription(lines.join('\n'))
      .setFooter({ text: '🔺 = Promoted  🔻 = Relegated  • Trading Competition Bot' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },
};
