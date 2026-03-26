'use strict';

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require('discord.js');
const {
  createBattle,
  joinBattle,
  getBattleStatus,
  getUserBattleHistory,
  VALID_DURATIONS_HOURS,
} = require('../../modules/battles/battleManager');
const { errorEmbed, successEmbed, COLORS, TIER_COLORS } = require('../../utils/embeds');
const config = require('../../../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('battle')
    .setDescription('Create and manage 1v1 or 3v3 trading battles.')
    .addSubcommand(sub =>
      sub.setName('create')
        .setDescription('Create a new battle lobby.')
        .addStringOption(opt =>
          opt.setName('type')
            .setDescription('Battle format')
            .setRequired(true)
            .addChoices(
              { name: '1v1 — Solo duel', value: '1v1' },
              { name: '3v3 — Team battle', value: '3v3' },
            )
        )
        .addStringOption(opt =>
          opt.setName('duration')
            .setDescription('Battle duration (default: 7d)')
            .setRequired(false)
            .addChoices(
              { name: '24 hours', value: '24h' },
              { name: '3 days', value: '3d' },
              { name: '7 days', value: '7d' },
              { name: '14 days', value: '14d' },
              { name: '30 days', value: '30d' },
            )
        )
    )
    .addSubcommand(sub =>
      sub.setName('join')
        .setDescription('Join an open battle lobby.')
        .addStringOption(opt =>
          opt.setName('code')
            .setDescription('8-character lobby code (e.g. ABX3KY7Z)')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('View live scores of a battle.')
        .addStringOption(opt =>
          opt.setName('code')
            .setDescription('Lobby code (leave blank to see your active battle)')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('history')
        .setDescription('View your past battles and results.')
        .addUserOption(opt =>
          opt.setName('user')
            .setDescription('User to look up (default: yourself)')
            .setRequired(false)
        )
    ),

  async execute(interaction) {
    await interaction.deferReply();
    const sub = interaction.options.getSubcommand();

    // ── /battle create ──────────────────────────────────────
    if (sub === 'create') {
      const type = interaction.options.getString('type');
      const duration = interaction.options.getString('duration') ?? '7d';

      try {
        const { battle, creator } = await createBattle(interaction.user.id, type, duration);
        const maxPlayers = type === '1v1' ? 2 : 6;
        const endsTimestamp = Math.floor(new Date(battle.ends_at).getTime() / 1000);

        const embed = new EmbedBuilder()
          .setColor(COLORS.primary)
          .setTitle(`⚔️ Battle Lobby Created — ${type.toUpperCase()}`)
          .setDescription([
            `Your battle lobby is ready! Share the code below with your opponent(s).`,
            '',
            `> **Lobby Code:** \`${battle.lobby_code}\``,
            `> **Type:** ${type === '1v1' ? '⚔️ 1v1 Duel' : '🛡️ 3v3 Team Battle'}`,
            `> **Duration:** ${duration}`,
            `> **Ends:** <t:${endsTimestamp}:R> (<t:${endsTimestamp}:f>)`,
            `> **Slots:** 1/${maxPlayers} filled`,
            '',
            `Opponent joins with: \`/battle join code:${battle.lobby_code}\``,
          ].join('\n'))
          .addFields(
            {
              name: '🏆 Team 1 (You)',
              value: `${config.tiers[creator.tier]?.emoji ?? '•'} **${creator.username}** (${creator.tier})`,
              inline: true,
            },
            {
              name: type === '1v1' ? '⚔️ Opponent' : '🛡️ Team 2',
              value: '*Waiting for players...*',
              inline: true,
            }
          )
          .setFooter({ text: 'Battle starts automatically once all slots are filled • Trading Competition Bot' })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed('Battle Creation Failed', err.message)] });
      }
    }

    // ── /battle join ────────────────────────────────────────
    if (sub === 'join') {
      const code = interaction.options.getString('code').trim().toUpperCase();

      try {
        const { battle, user, team, isStarted } = await joinBattle(interaction.user.id, code);
        const endsTimestamp = Math.floor(new Date(battle.ends_at).getTime() / 1000);
        const teamLabel = battle.type === '1v1' ? 'Opponent' : `Team ${team}`;

        const embed = new EmbedBuilder()
          .setColor(isStarted ? COLORS.success : COLORS.warning)
          .setTitle(isStarted ? `⚔️ Battle Started! — ${battle.lobby_code}` : `✅ Joined Lobby — ${battle.lobby_code}`)
          .setDescription(isStarted
            ? `All slots filled! The battle has begun. Track progress with \`/battle status code:${code}\``
            : `You joined **${teamLabel}**. Waiting for more players to fill the lobby...`
          )
          .addFields(
            { name: '🔢 Type', value: battle.type.toUpperCase(), inline: true },
            { name: '👥 Your Team', value: `Team ${team}`, inline: true },
            { name: '⏰ Ends', value: `<t:${endsTimestamp}:R>`, inline: true },
          )
          .setFooter({ text: 'Trading Competition Bot' })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed('Could Not Join Battle', err.message)] });
      }
    }

    // ── /battle status ──────────────────────────────────────
    if (sub === 'status') {
      let code = interaction.options.getString('code');

      // If no code provided, find the user's most recent active battle
      if (!code) {
        const { rows: [activeBattle] } = await require('../../../db/pool').query(`
          SELECT b.lobby_code FROM battles b
          JOIN battle_participants bp ON bp.battle_id = b.id
          JOIN users u ON u.id = bp.user_id
          WHERE u.discord_id = $1 AND b.status IN ('open', 'active')
          ORDER BY b.created_at DESC LIMIT 1
        `, [interaction.user.id]);

        if (!activeBattle) {
          return interaction.editReply({
            embeds: [errorEmbed('No Active Battle', 'You have no active battles. Start one with `/battle create` or join with `/battle join`.')],
          });
        }
        code = activeBattle.lobby_code;
      }

      try {
        const status = await getBattleStatus(code.toUpperCase());
        const embed = buildStatusEmbed(status);
        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed('Status Error', err.message)] });
      }
    }

    // ── /battle history ─────────────────────────────────────
    if (sub === 'history') {
      const targetUser = interaction.options.getUser('user') ?? interaction.user;

      try {
        const history = await getUserBattleHistory(targetUser.id);

        if (history.length === 0) {
          return interaction.editReply({
            embeds: [errorEmbed('No History', `${targetUser.username} hasn't completed any battles yet.`)],
          });
        }

        const wins = history.filter(b => b.won).length;
        const losses = history.length - wins;
        const totalDelta = history.reduce((sum, b) => sum + parseFloat(b.score_delta ?? 0), 0);

        const lines = history.slice(0, 10).map(b => {
          const result = b.won ? '🏆' : '💔';
          const delta = parseFloat(b.score_delta ?? 0);
          const deltaStr = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pts`;
          const date = b.ends_at ? `<t:${Math.floor(new Date(b.ends_at).getTime() / 1000)}:d>` : 'N/A';
          const captain = b.is_captain && b.type === '3v3' ? ' 👑' : '';
          return `${result} \`${b.lobby_code}\` — **${b.type.toUpperCase()}**${captain} | Team ${b.team} | ${deltaStr} | ${date}`;
        });

        const embed = new EmbedBuilder()
          .setColor(wins >= losses ? COLORS.success : COLORS.danger)
          .setTitle(`⚔️ ${targetUser.username} — Battle History`)
          .setThumbnail(targetUser.displayAvatarURL())
          .addFields(
            { name: '🏆 Wins', value: `${wins}`, inline: true },
            { name: '💔 Losses', value: `${losses}`, inline: true },
            { name: '📊 Score Delta', value: `${totalDelta >= 0 ? '+' : ''}${totalDelta.toFixed(1)} pts`, inline: true },
          )
          .setDescription(lines.join('\n'))
          .setFooter({ text: 'Trading Competition Bot' })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed('History Error', err.message)] });
      }
    }
  },
};

// ── Helper: build a live status embed ──────────────────────
function buildStatusEmbed(status) {
  const { battle, team1, team2, team1Score, team2Score, leadingTeam, endsAt, isCompleted } = status;
  const endsTimestamp = Math.floor(new Date(endsAt).getTime() / 1000);

  const formatMember = (m) => {
    const tierConf = config.tiers[m.tier];
    const captain = m.is_captain ? ' 👑' : '';
    const currentScore = parseFloat(m.current_score ?? 0);
    const startScore = parseFloat(m.score_at_start ?? 0);
    const delta = currentScore - startScore;
    const deltaStr = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pts`;
    return `${tierConf?.emoji ?? '•'} **${m.username}**${captain}\n↳ ${deltaStr} | WR: ${(parseFloat(m.win_rate ?? 0) * 100).toFixed(0)}% | ${m.total_trades ?? 0} trades`;
  };

  const t1Lines = team1.length ? team1.map(formatMember).join('\n') : '*Waiting for players...*';
  const t2Lines = team2.length ? team2.map(formatMember).join('\n') : '*Waiting for players...*';

  const isLeading1 = leadingTeam === 1;
  const statusTitle = isCompleted
    ? `⚔️ Battle Complete — ${battle.lobby_code}`
    : battle.status === 'open'
    ? `⏳ Battle Lobby — ${battle.lobby_code} (Open)`
    : `📡 Live Battle — ${battle.lobby_code}`;

  const embed = new EmbedBuilder()
    .setColor(isCompleted ? COLORS.gold : COLORS.primary)
    .setTitle(statusTitle)
    .addFields(
      {
        name: `${isLeading1 && !isCompleted ? '🔥' : isCompleted && battle.winning_team === 1 ? '🏆' : '•'} Team 1 — ${team1Score.toFixed(1)} pts`,
        value: t1Lines,
        inline: true,
      },
      {
        name: `${!isLeading1 && !isCompleted ? '🔥' : isCompleted && battle.winning_team === 2 ? '🏆' : '•'} Team 2 — ${team2Score.toFixed(1)} pts`,
        value: t2Lines,
        inline: true,
      },
    );

  if (!isCompleted) {
    embed.addFields({
      name: '⏰ Ends',
      value: `<t:${endsTimestamp}:R> (<t:${endsTimestamp}:f>)`,
    });
  }

  embed.setFooter({ text: `${battle.type.toUpperCase()} Battle • Score = delta since battle start • Trading Competition Bot` });
  embed.setTimestamp();

  return embed;
}
