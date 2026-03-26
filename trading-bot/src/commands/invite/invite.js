'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getUserInviteStats, getInviteLeaderboard } = require('../../modules/invites/inviteManager');
const { inviteStatusEmbed, errorEmbed, COLORS } = require('../../utils/embeds');
const { query } = require('../../../db/pool');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('invite')
    .setDescription('Manage your invite link and track your referrals.')
    .addSubcommand(sub =>
      sub.setName('link')
        .setDescription('Get your personal invite link and referral status.')
    )
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('See how many invites you\'ve validated.')
    )
    .addSubcommand(sub =>
      sub.setName('leaderboard')
        .setDescription('Top inviters on the server.')
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();
    const { rows: [dbUser] } = await query(
      'SELECT * FROM users WHERE discord_id = $1',
      [interaction.user.id]
    );

    if (!dbUser) {
      return interaction.editReply({
        embeds: [errorEmbed('Not Registered', 'Your account was not found. Please rejoin the server or contact an admin.')],
      });
    }

    if (sub === 'link' || sub === 'status') {
      const stats = await getUserInviteStats(dbUser.id);

      if (!stats.code) {
        return interaction.editReply({
          embeds: [errorEmbed('No Invite Code', 'You don\'t have an invite code yet. This is assigned automatically when you join. Contact an admin.')],
        });
      }

      const embed = inviteStatusEmbed(interaction.user, stats);

      // Show list of current invites
      if (stats.invites.length > 0) {
        const inviteLines = stats.invites.slice(0, 10).map(inv => {
          const status = inv.status === 'active' ? '✅' : inv.status === 'pending' ? '⏳' : '❌';
          return `${status} **${inv.invitee_username}** — ${inv.status}`;
        });
        embed.addFields({ name: '👥 Your Invites', value: inviteLines.join('\n') });
      }

      return interaction.editReply({ embeds: [embed] });
    }

    if (sub === 'leaderboard') {
      const top = await getInviteLeaderboard(10);

      const lines = top.map((row, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`#${i + 1}\``;
        return `${medal} **${row.username}** — ${row.valid_invites} validated invites | ${row.hp_earned ?? 0} HP earned`;
      });

      const embed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle('🏆 Top Inviters')
        .setDescription(lines.length > 0 ? lines.join('\n') : 'No invites yet — be the first!')
        .setFooter({ text: 'Earn 100 HP per validated invite • Trading Competition Bot' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }
  },
};
