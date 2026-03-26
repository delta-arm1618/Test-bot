'use strict';

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require('discord.js');
const { query } = require('../../../db/pool');
const { getCurrentWeek } = require('../../modules/leaderboard/scoreEngine');
const { getShopItems, purchaseBoost, getUserBoosts, getHpSummary } = require('../../modules/hedgefund/shopManager');
const { getActiveFunds, investInFund, getUserInvestments } = require('../../modules/hedgefund/hedgeFundManager');
const { getCurrentSeason, getUpcomingSeason, SEASON_RULES } = require('../../modules/seasons/seasonManager');
const { successEmbed, errorEmbed, COLORS, TIER_COLORS } = require('../../utils/embeds');
const config = require('../../../config');

// ── Boost type emoji map ───────────────────────────────────
const BOOST_EMOJI = {
  max_daily_loss:    '🛡️',
  score_multiplier:  '⚡',
  relegate_immunity: '🔒',
  reset_drawdown:    '🔄',
  battle_priority:   '⚔️',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('hp')
    .setDescription('Hedge Points balance and transaction history.')
    .addSubcommand(sub =>
      sub.setName('balance')
        .setDescription('View your HP balance and recent transactions.')
        .addUserOption(opt =>
          opt.setName('user')
            .setDescription('User to check (default: yourself)')
            .setRequired(false)
        )
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const targetUser = interaction.options.getUser('user') ?? interaction.user;
    const summary = await getHpSummary(targetUser.id);

    if (!summary) {
      return interaction.editReply({
        embeds: [errorEmbed('User Not Found', `${targetUser.username} has no account.`)],
      });
    }

    const { balance, transactions } = summary;

    const txLines = transactions.length > 0
      ? transactions.map(tx => {
          const sign = tx.amount >= 0 ? '+' : '';
          const emoji = tx.amount >= 0 ? '📈' : '📉';
          const ts = `<t:${Math.floor(new Date(tx.created_at).getTime() / 1000)}:d>`;
          const reason = tx.reason.replace(/_/g, ' ');
          return `${emoji} **${sign}${tx.amount} HP** _(bal: ${tx.balance_after})_ — ${reason} ${ts}`;
        }).join('\n')
      : '*No transactions yet.*';

    const embed = new EmbedBuilder()
      .setColor(COLORS.gold)
      .setTitle(`💰 ${targetUser.username} — Hedge Points`)
      .setThumbnail(targetUser.displayAvatarURL())
      .addFields(
        { name: '💰 Current Balance', value: `**${balance} HP**`, inline: false },
        { name: '📋 Last 10 Transactions', value: txLines, inline: false },
      )
      .setFooter({ text: 'Earn HP via invites, battle wins, and hedge fund returns • Trading Competition Bot' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },
};
