'use strict';

/**
 * /admin-ext — Extended Admin Commands (Bloc 4)
 * Adds: battle cancel, fund force-resolve, health dashboard,
 *       circuit breaker reset, user info, HP reset.
 *
 * Place in: src/commands/admin/adminExtended.js
 * Register in: src/deploy-commands.js (auto-discovered if placed in src/commands/)
 */

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { query, transaction } = require('../../../db/pool');
const { successEmbed, errorEmbed, warningEmbed, COLORS } = require('../../utils/embeds');
const { createLogger } = require('../../utils/logger');
const { getCurrentWeek } = require('../../modules/leaderboard/scoreEngine');
const { getAllStatuses, resetBreaker } = require('../../middleware/circuitBreaker');
const config = require('../../../config');

const log = createLogger('AdminExt');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin-ext')
    .setDescription('Extended admin commands (Bloc 4 — production).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

    // ── Battle group ─────────────────────────────────────
    .addSubcommandGroup(group =>
      group.setName('battle')
        .setDescription('Manage active battles.')
        .addSubcommand(sub =>
          sub.setName('cancel')
            .setDescription('Force-cancel an active or open battle.')
            .addStringOption(opt =>
              opt.setName('code').setDescription('8-char lobby code').setRequired(true)
            )
            .addStringOption(opt =>
              opt.setName('reason').setDescription('Reason (shown in logs)').setRequired(false)
            )
        )
        .addSubcommand(sub =>
          sub.setName('list-active')
            .setDescription('List all open or active battles.')
        )
    )

    // ── Fund group ───────────────────────────────────────
    .addSubcommandGroup(group =>
      group.setName('fund')
        .setDescription('Manage hedge funds.')
        .addSubcommand(sub =>
          sub.setName('force-resolve')
            .setDescription('Force-resolve a fund and distribute HP returns.')
            .addIntegerOption(opt =>
              opt.setName('week').setDescription('Week number (1–52)').setMinValue(1).setMaxValue(52).setRequired(true)
            )
            .addIntegerOption(opt =>
              opt.setName('year').setDescription('Year (e.g. 2026)').setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub.setName('status')
            .setDescription('View current week\'s hedge fund status.')
        )
    )

    // ── Health group ─────────────────────────────────────
    .addSubcommandGroup(group =>
      group.setName('health')
        .setDescription('System health and circuit breakers.')
        .addSubcommand(sub =>
          sub.setName('dashboard')
            .setDescription('Full system health: DB, Redis, circuit breakers, stats.')
        )
        .addSubcommand(sub =>
          sub.setName('reset-breaker')
            .setDescription('Manually reset a circuit breaker to CLOSED.')
            .addStringOption(opt =>
              opt.setName('service')
                .setDescription('Which service to reset')
                .setRequired(true)
                .addChoices(
                  { name: 'MetaApi',   value: 'metaapi'   },
                  { name: 'cTrader',   value: 'ctrader'   },
                  { name: 'Tradovate', value: 'tradovate' },
                )
            )
        )
    )

    // ── User group ───────────────────────────────────────
    .addSubcommandGroup(group =>
      group.setName('user')
        .setDescription('User management tools.')
        .addSubcommand(sub =>
          sub.setName('info')
            .setDescription('Full info dump for a user.')
            .addUserOption(opt => opt.setName('user').setDescription('Target user').setRequired(true))
        )
        .addSubcommand(sub =>
          sub.setName('reset-hp')
            .setDescription('Reset a user\'s Hedge Points to zero.')
            .addUserOption(opt => opt.setName('user').setDescription('Target user').setRequired(true))
        )
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    // ── Auth check ──────────────────────────────────────
    const hasAdmin = config.discord.roles.admin
      ? interaction.member.roles.cache.has(config.discord.roles.admin)
      : interaction.member.permissions.has(PermissionFlagsBits.Administrator);

    if (!hasAdmin) {
      return interaction.editReply({
        embeds: [errorEmbed('Access Denied', 'This command requires Administrator permissions.')],
      });
    }

    const group = interaction.options.getSubcommandGroup(false);
    const sub   = interaction.options.getSubcommand();

    // ════════════ BATTLE ════════════
    if (group === 'battle' && sub === 'cancel') {
      const code   = interaction.options.getString('code').trim().toUpperCase();
      const reason = interaction.options.getString('reason') ?? 'Admin cancellation';

      const { rows: [battle] } = await query(
        'SELECT * FROM battles WHERE lobby_code = $1',
        [code]
      );
      if (!battle) {
        return interaction.editReply({ embeds: [errorEmbed('Not Found', `No battle with code \`${code}\`.`)] });
      }
      if (battle.status === 'completed') {
        return interaction.editReply({ embeds: [warningEmbed('Already Completed', 'This battle has already finished.')] });
      }
      if (battle.status === 'cancelled') {
        return interaction.editReply({ embeds: [warningEmbed('Already Cancelled', 'This battle is already cancelled.')] });
      }

      await query('UPDATE battles SET status = $1 WHERE lobby_code = $2', ['cancelled', code]);
      log.info(`Admin cancelled battle ${code} — reason: ${reason}`, { admin: interaction.user.id });

      return interaction.editReply({
        embeds: [successEmbed('Battle Cancelled', `Battle \`${code}\` has been cancelled.\n**Reason:** ${reason}`)],
      });
    }

    if (group === 'battle' && sub === 'list-active') {
      const { rows } = await query(`
        SELECT
          b.lobby_code, b.type, b.status,
          b.started_at, b.ends_at,
          COUNT(bp.id) AS players,
          u.username    AS creator
        FROM battles b
        JOIN users u ON u.id = b.creator_id
        LEFT JOIN battle_participants bp ON bp.battle_id = b.id
        WHERE b.status IN ('open', 'active')
        GROUP BY b.id, u.username
        ORDER BY b.created_at DESC
        LIMIT 15
      `);

      if (rows.length === 0) {
        return interaction.editReply({ embeds: [successEmbed('No Active Battles', 'All clear — no open or active battles.')] });
      }

      const lines = rows.map(b => {
        const endsTs = Math.floor(new Date(b.ends_at).getTime() / 1000);
        return `\`${b.lobby_code}\` **${b.type}** · ${b.status} · ${b.players} players · ends <t:${endsTs}:R> _(${b.creator})_`;
      });

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.info)
            .setTitle(`⚔️ Active Battles (${rows.length})`)
            .setDescription(lines.join('\n'))
            .setTimestamp(),
        ],
      });
    }

    // ════════════ FUND ════════════
    if (group === 'fund' && sub === 'force-resolve') {
      const week = interaction.options.getInteger('week');
      const year = interaction.options.getInteger('year');

      const { rows } = await query(
        'SELECT id FROM hedge_funds WHERE week_number = $1 AND year = $2',
        [week, year]
      );
      if (rows.length === 0) {
        return interaction.editReply({
          embeds: [errorEmbed('Not Found', `No hedge fund found for week ${week}/${year}.`)],
        });
      }

      try {
        // Re-activate fund so distributeHedgeFundReturns can process it
        await query(
          'UPDATE hedge_funds SET is_active = TRUE WHERE week_number = $1 AND year = $2',
          [week, year]
        );

        const { distributeHedgeFundReturns } = require('../../modules/hedgefund/hedgeFundManager');
        await distributeHedgeFundReturns(interaction.client, interaction.guild);

        log.info(`Admin force-resolved hedge fund W${week}/${year}`, { admin: interaction.user.id });
        return interaction.editReply({
          embeds: [successEmbed('Fund Resolved', `Hedge fund for week **${week}/${year}** resolved. HP distributed to investors.`)],
        });
      } catch (err) {
        log.error('Force-resolve failed', { error: err.message });
        return interaction.editReply({ embeds: [errorEmbed('Failed', err.message)] });
      }
    }

    if (group === 'fund' && sub === 'status') {
      const { week, year } = getCurrentWeek();
      const { rows: funds } = await query(`
        SELECT
          hf.*,
          u1.username AS t1, u2.username AS t2, u3.username AS t3,
          COUNT(fi.id)                    AS investors,
          COALESCE(SUM(fi.amount_hp), 0)  AS total_hp
        FROM hedge_funds hf
        LEFT JOIN users u1 ON u1.id = hf.trader_1_id
        LEFT JOIN users u2 ON u2.id = hf.trader_2_id
        LEFT JOIN users u3 ON u3.id = hf.trader_3_id
        LEFT JOIN fund_investments fi ON fi.fund_id = hf.id
        WHERE hf.week_number = $1 AND hf.year = $2
        GROUP BY hf.id, u1.username, u2.username, u3.username
      `, [week, year]);

      if (funds.length === 0) {
        return interaction.editReply({ embeds: [warningEmbed('No Fund', `No hedge fund for week ${week}/${year}.`)] });
      }

      const f = funds[0];
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.gold)
            .setTitle(`💼 Hedge Fund — Week ${week}/${year}`)
            .addFields(
              { name: '👥 Traders', value: [f.t1, f.t2, f.t3].filter(Boolean).join(', ') || 'None', inline: true },
              { name: '💰 Total Invested', value: `${parseInt(f.total_hp)} HP`, inline: true },
              { name: '👫 Investors', value: `${f.investors}`, inline: true },
              { name: '📊 Status', value: f.is_active ? '✅ Active' : '🔒 Resolved', inline: true },
              { name: '📈 Performance', value: f.performance_pct != null ? `${parseFloat(f.performance_pct).toFixed(1)}%` : 'Pending', inline: true },
            )
            .setTimestamp(),
        ],
      });
    }

    // ════════════ HEALTH ════════════
    if (group === 'health' && sub === 'dashboard') {
      const health = { db: '🟢 OK', redis: '🟢 OK' };

      try { await query('SELECT 1'); } catch { health.db = '🔴 Error'; }

      try {
        const { redis } = require('../../utils/redis');
        await redis.ping();
      } catch { health.redis = '🔴 Error'; }

      const breakerStatuses = getAllStatuses();
      const breakerLines = breakerStatuses.map(b => {
        const icon = b.state === 'CLOSED' ? '🟢' : b.state === 'OPEN' ? '🔴' : '🟡';
        return `${icon} **${b.name}** — ${b.state} (failures: ${b.failureCount})`;
      });

      // Quick stats
      const { rows: [stats] } = await query(`
        SELECT
          (SELECT COUNT(*)  FROM users)                                    AS total_users,
          (SELECT COUNT(*)  FROM users WHERE is_verified = TRUE)           AS verified_users,
          (SELECT COUNT(*)  FROM broker_accounts WHERE status = 'active')  AS active_accounts,
          (SELECT COUNT(*)  FROM battles WHERE status IN ('open','active'))AS active_battles,
          (SELECT COUNT(*)  FROM weekly_scores WHERE is_archived = FALSE)  AS active_scores
      `);

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.info)
            .setTitle('🏥 System Health Dashboard')
            .addFields(
              { name: '🗄️ Database',        value: health.db,    inline: true },
              { name: '⚡ Redis',            value: health.redis, inline: true },
              { name: '\u200b',              value: '\u200b',     inline: true },
              { name: '👥 Total Users',      value: `${stats.total_users}`,     inline: true },
              { name: '✅ Verified',         value: `${stats.verified_users}`,  inline: true },
              { name: '📡 Active Accounts',  value: `${stats.active_accounts}`, inline: true },
              { name: '⚔️ Active Battles',   value: `${stats.active_battles}`,  inline: true },
              { name: '📊 Active Scores',    value: `${stats.active_scores}`,   inline: true },
              { name: '\u200b',              value: '\u200b',                    inline: true },
              {
                name: '⚡ Circuit Breakers',
                value: breakerLines.length ? breakerLines.join('\n') : 'None configured',
                inline: false,
              },
            )
            .setFooter({ text: 'Trading Competition Bot • Bloc 4' })
            .setTimestamp(),
        ],
      });
    }

    if (group === 'health' && sub === 'reset-breaker') {
      const service = interaction.options.getString('service');
      try {
        resetBreaker(service);
        log.info(`Admin reset circuit breaker: ${service}`, { admin: interaction.user.id });
        return interaction.editReply({
          embeds: [successEmbed('Breaker Reset', `Circuit breaker for **${service}** reset to CLOSED. Polling will resume on the next cron tick.`)],
        });
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed('Reset Failed', err.message)] });
      }
    }

    // ════════════ USER ════════════
    if (group === 'user' && sub === 'info') {
      const targetUser = interaction.options.getUser('user');

      const { rows: [user] } = await query(`
        SELECT
          u.*,
          (SELECT COUNT(*) FROM broker_accounts  WHERE user_id = u.id)                AS account_count,
          (SELECT COUNT(*) FROM battle_participants bp
            JOIN battles b ON b.id = bp.battle_id
            WHERE bp.user_id = u.id AND b.status = 'completed')                       AS battles_completed,
          (SELECT COUNT(*) FROM invite_uses WHERE inviter_id = u.id AND status = 'active') AS valid_invites
        FROM users u
        WHERE u.discord_id = $1
      `, [targetUser.id]);

      if (!user) {
        return interaction.editReply({ embeds: [errorEmbed('Not Found', `${targetUser.username} has no account.`)] });
      }

      const joinedTs = Math.floor(new Date(user.created_at).getTime() / 1000);

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.info)
            .setTitle(`👤 User Info — ${targetUser.username}`)
            .setThumbnail(targetUser.displayAvatarURL())
            .addFields(
              { name: '🆔 Discord ID',      value: user.discord_id,                              inline: true },
              { name: '🏆 Tier',            value: user.tier,                                    inline: true },
              { name: '✅ Verified',        value: user.is_verified ? 'Yes' : 'No',              inline: true },
              { name: '💰 Hedge Points',    value: `${user.hedge_points} HP`,                    inline: true },
              { name: '📡 Linked Accounts', value: `${user.account_count}`,                      inline: true },
              { name: '⚔️ Battles Done',    value: `${user.battles_completed}`,                  inline: true },
              { name: '🔗 Valid Invites',   value: `${user.valid_invites}`,                      inline: true },
              { name: '🌟 Best Rank',       value: user.best_rank_ever ? `#${user.best_rank_ever}` : 'N/A', inline: true },
              { name: '📅 Joined',          value: `<t:${joinedTs}:R>`,                          inline: true },
              { name: '🛠️ Admin',           value: user.is_admin ? 'Yes' : 'No',                 inline: true },
            )
            .setTimestamp(),
        ],
      });
    }

    if (group === 'user' && sub === 'reset-hp') {
      const targetUser = interaction.options.getUser('user');

      let previousBalance = 0;
      await transaction(async (client) => {
        const { rows: [user] } = await client.query(
          'SELECT id, hedge_points FROM users WHERE discord_id = $1',
          [targetUser.id]
        );
        if (!user) throw new Error('User not found in database.');

        previousBalance = user.hedge_points;

        if (user.hedge_points > 0) {
          await client.query(
            'INSERT INTO hp_transactions (user_id, amount, balance_after, reason) VALUES ($1, $2, 0, $3)',
            [user.id, -user.hedge_points, 'admin_hp_reset']
          );
          await client.query('UPDATE users SET hedge_points = 0 WHERE id = $1', [user.id]);
        }
      });

      log.info(`Admin reset HP for ${targetUser.username}: ${previousBalance} → 0`, { admin: interaction.user.id });
      return interaction.editReply({
        embeds: [successEmbed('HP Reset', `**${targetUser.username}**'s Hedge Points reset from **${previousBalance} HP** to **0 HP**.\nA transaction record has been logged.`)],
      });
    }

    // Should never reach here
    return interaction.editReply({ embeds: [errorEmbed('Unknown Command', 'Subcommand not recognized.')] });
  },
};
