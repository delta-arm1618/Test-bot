'use strict';

const {
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');
const { query } = require('../../../db/pool');
const { getCurrentWeek } = require('../../modules/leaderboard/scoreEngine');
const { getActiveFunds, investInFund, getUserInvestments } = require('../../modules/hedgefund/hedgeFundManager');
const { successEmbed, errorEmbed, warningEmbed, COLORS } = require('../../utils/embeds');
const config = require('../../../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('fund')
    .setDescription('Invest Hedge Points in the weekly virtual hedge funds.')
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('View the active hedge funds and their current performance.')
    )
    .addSubcommand(sub =>
      sub.setName('invest')
        .setDescription('Invest HP into a hedge fund.')
        .addStringOption(opt =>
          opt.setName('fund')
            .setDescription('Fund number to invest in (1, 2, or 3)')
            .setRequired(true)
            .addChoices(
              { name: 'Fund #1 — Top Trader', value: '1' },
              { name: 'Fund #2 — 2nd Place', value: '2' },
              { name: 'Fund #3 — 3rd Place', value: '3' },
            )
        )
        .addIntegerOption(opt =>
          opt.setName('amount')
            .setDescription('How many HP to invest (min: 10)')
            .setMinValue(10)
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('history')
        .setDescription('View your past fund investments and returns.')
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const sub = interaction.options.getSubcommand();
    const { week, year } = getCurrentWeek();

    // ── /fund list ────────────────────────────────────────
    if (sub === 'list') {
      const funds = await getActiveFunds(week, year);

      if (funds.length === 0) {
        return interaction.editReply({
          embeds: [warningEmbed(
            'No Active Funds',
            'No hedge funds are active yet this week. Funds are created after the Monday reset using the previous week\'s top 3 traders.'
          )],
        });
      }

      const embed = new EmbedBuilder()
        .setColor(COLORS.gold)
        .setTitle(`💼 Active Hedge Funds — Week ${week}`)
        .setDescription('Invest your HP in the top traders\' virtual funds. Returns are distributed on Monday after the weekly reset.')
        .setFooter({ text: '🚀 Top fund: 1.5x return · 📊 Middle: 1.0x · 📉 Bottom: 0.5x' })
        .setTimestamp();

      funds.forEach((fund, i) => {
        const tierConf1 = fund.trader_1_tier ? config.tiers[fund.trader_1_tier] : null;
        const tierConf2 = fund.trader_2_tier ? config.tiers[fund.trader_2_tier] : null;
        const tierConf3 = fund.trader_3_tier ? config.tiers[fund.trader_3_tier] : null;

        const traderLines = [
          fund.trader_1_name ? `${tierConf1?.emoji ?? '•'} **${fund.trader_1_name}** — ${parseFloat(fund.trader_1_score ?? 0).toFixed(1)} pts` : null,
          fund.trader_2_name ? `${tierConf2?.emoji ?? '•'} **${fund.trader_2_name}** — ${parseFloat(fund.trader_2_score ?? 0).toFixed(1)} pts` : null,
          fund.trader_3_name ? `${tierConf3?.emoji ?? '•'} **${fund.trader_3_name}** — ${parseFloat(fund.trader_3_score ?? 0).toFixed(1)} pts` : null,
        ].filter(Boolean).join('\n');

        embed.addFields({
          name: `Fund #${i + 1} · 💰 ${parseInt(fund.total_invested)} HP invested`,
          value: traderLines || '*No traders assigned yet*',
          inline: false,
        });
      });

      return interaction.editReply({ embeds: [embed] });
    }

    // ── /fund invest ──────────────────────────────────────
    if (sub === 'invest') {
      const fundIndex = parseInt(interaction.options.getString('fund')) - 1;
      const amount = interaction.options.getInteger('amount');

      const funds = await getActiveFunds(week, year);

      if (funds.length === 0) {
        return interaction.editReply({
          embeds: [errorEmbed('No Funds Available', 'No hedge funds are active this week yet.')],
        });
      }

      if (fundIndex >= funds.length) {
        return interaction.editReply({
          embeds: [errorEmbed('Invalid Fund', `Only ${funds.length} fund(s) are available this week.`)],
        });
      }

      const fund = funds[fundIndex];

      try {
        const result = await investInFund(interaction.user.id, fund.id, amount);

        const embed = successEmbed(
          'Investment Confirmed!',
          [
            `You invested **${amount} HP** in **Fund #${fundIndex + 1}**.`,
            '',
            `💰 Remaining balance: **${result.newBalance} HP**`,
            '',
            '📊 Returns are distributed every Monday after the weekly reset.',
            '🚀 Top performing fund: **1.5x return**',
            '📊 Average fund: **1.0x return**',
            '📉 Poor performing fund: **0.5x return**',
          ].join('\n')
        );

        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed('Investment Failed', err.message)] });
      }
    }

    // ── /fund history ─────────────────────────────────────
    if (sub === 'history') {
      const investments = await getUserInvestments(interaction.user.id, week, year);

      if (investments.length === 0) {
        return interaction.editReply({
          embeds: [warningEmbed('No Investments', 'You haven\'t invested in any hedge funds yet. Use `/fund list` to see available funds.')],
        });
      }

      const lines = investments.map(inv => {
        const traders = [inv.trader_1_name, inv.trader_2_name, inv.trader_3_name]
          .filter(Boolean).join(', ');

        const status = inv.is_active ? '⏳ Active' : '✅ Resolved';
        const invested = inv.amount_hp;
        const returned = inv.return_hp;
        const profit = returned !== null ? returned - invested : null;
        const profitStr = profit !== null
          ? ` → **${returned} HP** (${profit >= 0 ? '+' : ''}${profit} HP)`
          : ' → *pending*';

        return `${status} **W${inv.week_number}/${inv.year}** · ${traders}\n  Invested: **${invested} HP**${profitStr}`;
      });

      const embed = new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle('💼 Your Fund Investment History')
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Trading Competition Bot' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }
  },
};
