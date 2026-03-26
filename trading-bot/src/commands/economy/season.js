'use strict';

const {
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');
const { getCurrentSeason, getUpcomingSeason, SEASON_RULES } = require('../../modules/seasons/seasonManager');
const { getCurrentWeek } = require('../../modules/leaderboard/scoreEngine');
const { warningEmbed, COLORS } = require('../../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('season')
    .setDescription('View the current Volatility Season rule.')
    .addSubcommand(sub =>
      sub.setName('current')
        .setDescription('View the active rule for this week.')
    )
    .addSubcommand(sub =>
      sub.setName('upcoming')
        .setDescription('View the upcoming rule for next week (if voted).')
    )
    .addSubcommand(sub =>
      sub.setName('rules')
        .setDescription('Browse all possible Volatility Season rules.')
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const sub = interaction.options.getSubcommand();
    const { week, year } = getCurrentWeek();

    // ── /season current ───────────────────────────────────
    if (sub === 'current') {
      const season = await getCurrentSeason();

      if (!season) {
        return interaction.editReply({
          embeds: [warningEmbed(
            'No Active Rule',
            [
              'No special rule is active this week.',
              '',
              '🗳️ Vote for next week\'s rule every **Friday at 18:00 UTC** in the announcements channel.',
              '📅 Rules activate every **Monday at 00:00 UTC** with the weekly reset.',
            ].join('\n')
          )],
        });
      }

      const ruleConf = SEASON_RULES[season.rule_type];
      const daysLeft = Math.ceil(
        (new Date(Date.now()).setHours(0, 0, 0, 0) < Date.now() ? 7 - new Date().getDay() : 0) || 7 - new Date().getDay()
      );

      const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle(`🌪️ Volatility Season — Week ${week} Rule`)
        .addFields(
          { name: '⚡ Active Rule', value: `**${ruleConf?.label ?? season.rule_type}**`, inline: false },
          { name: '📋 Description', value: season.rule_description, inline: false },
          { name: '🗓️ Week', value: `Week ${season.week_number} · ${season.year}`, inline: true },
        )
        .setDescription(
          '> Trades that **violate** this rule are excluded from your weekly score automatically.\n> Only valid trades count toward your leaderboard position.'
        )
        .setFooter({ text: 'Rule resets every Monday 00:00 UTC • Trading Competition Bot' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── /season upcoming ──────────────────────────────────
    if (sub === 'upcoming') {
      const season = await getUpcomingSeason();

      if (!season) {
        return interaction.editReply({
          embeds: [warningEmbed(
            'No Upcoming Rule Yet',
            '🗳️ The vote hasn\'t been posted yet. Check back **Friday at 18:00 UTC** when the community vote opens.'
          )],
        });
      }

      const nextWeek = week === 52 ? 1 : week + 1;
      const nextYear = week === 52 ? year + 1 : year;

      const isResolved = season.is_active;
      const ruleConf = isResolved ? SEASON_RULES[season.rule_type] : null;

      const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle(`🌪️ Volatility Season — Week ${nextWeek} (Upcoming)`);

      if (isResolved && ruleConf) {
        embed.addFields(
          { name: '✅ Winning Rule', value: `**${ruleConf.label}**`, inline: false },
          { name: '📋 What it means', value: season.rule_description, inline: false },
          { name: '📊 Votes', value: `🇦 ${season.votes_a} · 🇧 ${season.votes_b} · 🇨 ${season.votes_c}`, inline: false },
        )
        .setDescription('The community has voted! This rule activates **Monday 00:00 UTC**.');
      } else {
        embed.addFields(
          { name: '🗳️ Options', value: `🇦 ${season.vote_option_a}\n🇧 ${season.vote_option_b}\n🇨 ${season.vote_option_c}`, inline: false },
        )
        .setDescription('Voting is still open! React in the announcements channel to cast your vote. Closes **Sunday 23:00 UTC**.');
      }

      embed
        .setFooter({ text: 'Trading Competition Bot' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── /season rules ─────────────────────────────────────
    if (sub === 'rules') {
      const ruleLines = Object.values(SEASON_RULES).map(r =>
        `**${r.label}**\n  ↳ ${r.description}`
      );

      const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle('🌪️ All Possible Volatility Season Rules')
        .setDescription(ruleLines.join('\n\n'))
        .setFooter({ text: 'One rule activates each week based on community vote • Trading Competition Bot' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }
  },
};
