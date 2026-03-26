'use strict';

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { query, transaction } = require('../../../db/pool');
const { successEmbed, errorEmbed, COLORS } = require('../../utils/embeds');
const { runWeeklyReset, getCurrentWeek, upsertWeeklyScore } = require('../../modules/leaderboard/scoreEngine');
const { invalidatePattern } = require('../../utils/redis');
const config = require('../../../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin-only bot management commands.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommandGroup(group =>
      group.setName('tracking')
        .setDescription('Manage broker tracking settings.')
        .addSubcommand(sub =>
          sub.setName('status')
            .setDescription('View active broker connection statuses.')
        )
        .addSubcommand(sub =>
          sub.setName('verify')
            .setDescription('Manually verify a user\'s account.')
            .addUserOption(opt => opt.setName('user').setDescription('User to verify').setRequired(true))
        )
        .addSubcommand(sub =>
          sub.setName('set-interval')
            .setDescription('Set the MetaApi poll interval.')
            .addIntegerOption(opt =>
              opt.setName('minutes')
                .setDescription('Poll interval in minutes (5-60)')
                .setMinValue(5).setMaxValue(60).setRequired(true)
            )
        )
    )
    .addSubcommandGroup(group =>
      group.setName('metrics')
        .setDescription('Adjust scoring formula weights.')
        .addSubcommand(sub =>
          sub.setName('weights')
            .setDescription('View current scoring weights.')
        )
    )
    .addSubcommand(sub =>
      sub.setName('snapshot')
        .setDescription('Force a weekly snapshot/reset (USE WITH CAUTION).')
    )
    .addSubcommand(sub =>
      sub.setName('verify-user')
        .setDescription('Manually mark a user as verified (bypass invite gate).')
        .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('give-hp')
        .setDescription('Give Hedge Points to a user.')
        .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true))
        .addIntegerOption(opt => opt.setName('amount').setDescription('HP amount').setMinValue(1).setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('Reason').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('submissions')
        .setDescription('View pending manual screenshot submissions.')
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    // Double-check admin role
    const member = interaction.member;
    const hasAdminRole = config.discord.roles.admin
      ? member.roles.cache.has(config.discord.roles.admin)
      : member.permissions.has(PermissionFlagsBits.Administrator);

    if (!hasAdminRole) {
      return interaction.editReply({
        embeds: [errorEmbed('Access Denied', 'This command requires administrator permissions.')],
      });
    }

    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    // ── tracking status ───────────────────────────────────
    if (group === 'tracking' && sub === 'status') {
      const { rows } = await query(`
        SELECT ba.broker, ba.account_id, ba.status, ba.last_polled_at, ba.error_count,
               u.username
        FROM broker_accounts ba
        JOIN users u ON u.id = ba.user_id
        ORDER BY ba.status, ba.last_polled_at DESC
        LIMIT 25
      `);

      const statusIcon = (s) => ({ active: '🟢', pending: '🟡', disconnected: '🔴', suspended: '⛔' }[s] ?? '⚪');
      const lines = rows.map(r =>
        `${statusIcon(r.status)} **${r.username}** — ${r.broker.toUpperCase()} \`${r.account_id}\` | Errors: ${r.error_count}`
      );

      const embed = new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle('📡 Broker Tracking Status')
        .setDescription(lines.length > 0 ? lines.join('\n') : 'No accounts linked.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── tracking verify ───────────────────────────────────
    if (group === 'tracking' && sub === 'verify') {
      const targetUser = interaction.options.getUser('user');
      await query(`
        UPDATE broker_accounts SET status = 'active', error_count = 0
        WHERE user_id = (SELECT id FROM users WHERE discord_id = $1)
      `, [targetUser.id]);

      return interaction.editReply({
        embeds: [successEmbed('Account Verified', `${targetUser.username}'s broker account has been manually verified.`)],
      });
    }

    // ── metrics weights ───────────────────────────────────
    if (group === 'metrics' && sub === 'weights') {
      const { weights } = config.scoring;
      const embed = new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle('⚖️ Current Scoring Weights')
        .addFields(
          { name: 'PnL %', value: `${(weights.pnl * 100).toFixed(0)}%`, inline: true },
          { name: 'Win Rate', value: `${(weights.winRate * 100).toFixed(0)}%`, inline: true },
          { name: 'Max Drawdown', value: `${(weights.drawdown * 100).toFixed(0)}%`, inline: true },
          { name: 'Consistency', value: `${(weights.consistency * 100).toFixed(0)}%`, inline: true },
        )
        .setDescription('To change weights, update `.env` and restart the bot.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── snapshot (force reset) ────────────────────────────
    if (sub === 'snapshot') {
      try {
        const { week, year } = getCurrentWeek();
        await transaction(async (client) => {
          await runWeeklyReset(client);
        });
        await invalidatePattern('lb:page:*');
        await invalidatePattern('rank:*');

        return interaction.editReply({
          embeds: [successEmbed('Snapshot Complete', `Week ${week}/${year} has been archived and promotions/relegations applied.`)],
        });
      } catch (err) {
        return interaction.editReply({
          embeds: [errorEmbed('Snapshot Failed', err.message)],
        });
      }
    }

    // ── verify-user (bypass invite gate) ─────────────────
    if (sub === 'verify-user') {
      const targetUser = interaction.options.getUser('user');
      await query(
        'UPDATE users SET is_verified = TRUE WHERE discord_id = $1',
        [targetUser.id]
      );

      // Assign role
      if (config.discord.roles.verifiedTrader) {
        try {
          const member = await interaction.guild.members.fetch(targetUser.id);
          await member.roles.add(config.discord.roles.verifiedTrader);
        } catch {}
      }

      return interaction.editReply({
        embeds: [successEmbed('User Verified', `${targetUser.username} has been manually verified and granted access to competitions.`)],
      });
    }

    // ── give-hp ───────────────────────────────────────────
    if (sub === 'give-hp') {
      const targetUser = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      const reason = interaction.options.getString('reason') ?? 'admin_grant';

      await transaction(async (client) => {
        const { rows: [user] } = await client.query(
          'UPDATE users SET hedge_points = hedge_points + $1 WHERE discord_id = $2 RETURNING hedge_points, id',
          [amount, targetUser.id]
        );
        await client.query(
          'INSERT INTO hp_transactions (user_id, amount, balance_after, reason) VALUES ($1, $2, $3, $4)',
          [user.id, amount, user.hedge_points, reason]
        );
      });

      return interaction.editReply({
        embeds: [successEmbed('HP Granted', `Gave **${amount} HP** to ${targetUser.username}.\nReason: ${reason}`)],
      });
    }

    // ── submissions ───────────────────────────────────────
    if (sub === 'submissions') {
      const { rows } = await query(`
        SELECT ms.*, u.username, u.discord_id
        FROM manual_submissions ms
        JOIN users u ON u.id = ms.user_id
        WHERE ms.approved IS NULL
        ORDER BY ms.submitted_at ASC
        LIMIT 10
      `);

      if (rows.length === 0) {
        return interaction.editReply({
          embeds: [successEmbed('No Pending Submissions', 'All manual submissions have been reviewed.')],
        });
      }

      const lines = rows.map(r =>
        `**${r.username}** — <t:${Math.floor(new Date(r.submitted_at).getTime() / 1000)}:R>\n[View Screenshot](${r.image_url})\nID: \`${r.id}\``
      );

      const embed = new EmbedBuilder()
        .setColor(COLORS.warning)
        .setTitle(`📸 Pending Submissions (${rows.length})`)
        .setDescription(lines.join('\n\n'))
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }
  },
};
