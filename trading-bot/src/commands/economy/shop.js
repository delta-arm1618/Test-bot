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
const { getShopItems, purchaseBoost, getUserBoosts } = require('../../modules/hedgefund/shopManager');
const { successEmbed, errorEmbed, warningEmbed, COLORS } = require('../../utils/embeds');

const BOOST_EMOJI = {
  max_daily_loss:    '🛡️',
  score_multiplier:  '⚡',
  relegate_immunity: '🔒',
  reset_drawdown:    '🔄',
  battle_priority:   '⚔️',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Browse and buy Hedge Point boosts.')
    .addSubcommand(sub =>
      sub.setName('browse')
        .setDescription('See all available boosts and their prices.')
    )
    .addSubcommand(sub =>
      sub.setName('buy')
        .setDescription('Purchase a boost with your Hedge Points.')
        .addStringOption(opt =>
          opt.setName('boost')
            .setDescription('Which boost to buy')
            .setRequired(true)
            .addChoices(
              { name: '🛡️ +1% Max Daily Loss (500 HP)', value: 'max_daily_loss' },
              { name: '⚡ Score Multiplier x1.1 (800 HP)', value: 'score_multiplier' },
              { name: '🔒 Relegation Immunity (1200 HP)', value: 'relegate_immunity' },
              { name: '🔄 Reset Drawdown Counter (600 HP)', value: 'reset_drawdown' },
              { name: '⚔️ Battle Priority Slot (300 HP)', value: 'battle_priority' },
            )
        )
    )
    .addSubcommand(sub =>
      sub.setName('my-boosts')
        .setDescription('View your currently active boosts.')
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: interaction.options.getSubcommand() !== 'browse' });

    const sub = interaction.options.getSubcommand();

    // ── /shop browse ─────────────────────────────────────
    if (sub === 'browse') {
      const items = await getShopItems();

      // Get user's current HP for context
      const { rows: [dbUser] } = await query(
        'SELECT hedge_points FROM users WHERE discord_id = $1',
        [interaction.user.id]
      );
      const userHp = dbUser?.hedge_points ?? 0;

      const itemLines = items.map(item => {
        const emoji = BOOST_EMOJI[item.boost_type] ?? '•';
        const canAfford = userHp >= item.cost_hp ? '' : ' _(insufficient HP)_';
        const duration = item.duration_hours
          ? item.duration_hours >= 168 ? '1 week' : `${item.duration_hours}h`
          : 'One-time use';
        return `${emoji} **${item.name}** — \`${item.cost_hp} HP\` · ${duration}${canAfford}\n  ↳ ${item.description}`;
      });

      const embed = new EmbedBuilder()
        .setColor(COLORS.gold)
        .setTitle('🏪 Boost Shop')
        .setDescription(itemLines.join('\n\n'))
        .addFields({ name: '💰 Your Balance', value: `**${userHp} HP**`, inline: true })
        .setFooter({ text: 'Use /shop buy to purchase • Boosts never affect real trades' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── /shop buy ─────────────────────────────────────────
    if (sub === 'buy') {
      const boostType = interaction.options.getString('boost');

      try {
        const result = await purchaseBoost(interaction.user.id, boostType);

        const emoji = BOOST_EMOJI[boostType] ?? '•';
        const expiresStr = result.boost.expires_at
          ? `<t:${Math.floor(new Date(result.boost.expires_at).getTime() / 1000)}:R>`
          : 'Until used';

        const embed = successEmbed(
          'Boost Purchased!',
          [
            `${emoji} **${result.item.name}** is now active!`,
            '',
            `⏰ Expires: ${expiresStr}`,
            `💰 Remaining HP: **${result.newBalance} HP**`,
            '',
            result.item.description,
          ].join('\n')
        );

        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed('Purchase Failed', err.message)] });
      }
    }

    // ── /shop my-boosts ───────────────────────────────────
    if (sub === 'my-boosts') {
      const boosts = await getUserBoosts(interaction.user.id);

      if (boosts.length === 0) {
        return interaction.editReply({
          embeds: [warningEmbed('No Active Boosts', 'You have no active boosts. Use `/shop browse` to see what\'s available.')],
        });
      }

      const lines = boosts.map(b => {
        const emoji = BOOST_EMOJI[b.boost_type] ?? '•';
        const expiresStr = b.expires_at
          ? `expires <t:${Math.floor(new Date(b.expires_at).getTime() / 1000)}:R>`
          : 'one-time use (unused)';
        return `${emoji} **${b.item_name}** — ${expiresStr}\n  ↳ ${b.description}`;
      });

      const embed = new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle('✨ Your Active Boosts')
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Trading Competition Bot' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }
  },
};
