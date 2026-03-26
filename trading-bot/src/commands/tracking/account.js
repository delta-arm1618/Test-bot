'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { linkAccount, getUserAccounts } = require('../../modules/tracking/accountTracker');
const { successEmbed, errorEmbed, warningEmbed, COLORS } = require('../../utils/embeds');
const { query } = require('../../../db/pool');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('account')
    .setDescription('Manage your linked broker accounts.')
    .addSubcommand(sub =>
      sub.setName('link')
        .setDescription('Link a new broker account.')
        .addStringOption(opt =>
          opt.setName('broker')
            .setDescription('Your broker type')
            .setRequired(true)
            .addChoices(
              { name: 'MT4 (MetaTrader 4)', value: 'mt4' },
              { name: 'MT5 (MetaTrader 5)', value: 'mt5' },
              { name: 'cTrader', value: 'ctrader' },
              { name: 'Tradovate', value: 'tradovate' },
              { name: 'Manual (Screenshot)', value: 'manual' },
            )
        )
        .addStringOption(opt =>
          opt.setName('account_id')
            .setDescription('Your demo account ID / login number')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('server')
            .setDescription('Broker server name (e.g. ICMarkets-Demo)')
            .setRequired(false)
        )
        .addStringOption(opt =>
          opt.setName('metaapi_id')
            .setDescription('MetaApi account ID (if using MetaApi cloud)')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('View your linked accounts.')
    )
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Check connection status of your accounts.')
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
        embeds: [errorEmbed('Not Registered', 'Your account was not found. Please contact an admin.')],
      });
    }

    if (sub === 'link') {
      const broker = interaction.options.getString('broker');
      const accountId = interaction.options.getString('account_id');
      const server = interaction.options.getString('server');
      const metaapiId = interaction.options.getString('metaapi_id');

      // For non-manual brokers, validate required fields
      if (broker !== 'manual' && !accountId) {
        return interaction.editReply({
          embeds: [errorEmbed('Missing Info', 'Account ID is required.')],
        });
      }

      try {
        const account = await linkAccount(dbUser.id, {
          broker,
          accountId,
          metaapiId,
          server,
        });

        let instructions = '';
        if (broker === 'mt4' || broker === 'mt5') {
          instructions = metaapiId
            ? '\n\n📡 **MetaApi**: Account will be polled automatically every 15 minutes.'
            : '\n\n📡 **EA Mode**: Download the custom Expert Advisor and install it on your MT4/MT5 terminal. Use `/ea-setup` for instructions.';
        } else if (broker === 'manual') {
          instructions = '\n\n📸 **Manual Mode**: Use `/submit-screenshot` each day to submit your account statement. An admin will validate it.';
        }

        return interaction.editReply({
          embeds: [successEmbed(
            'Account Linked',
            `**${broker.toUpperCase()}** account \`${accountId}\` has been linked successfully!${instructions}`
          )],
        });
      } catch (err) {
        return interaction.editReply({
          embeds: [errorEmbed('Link Failed', err.message)],
        });
      }
    }

    if (sub === 'list' || sub === 'status') {
      const accounts = await getUserAccounts(dbUser.id);

      if (accounts.length === 0) {
        return interaction.editReply({
          embeds: [warningEmbed('No Accounts', 'You have no linked broker accounts. Use `/account link` to add one.')],
        });
      }

      const statusIcon = (s) => ({ active: '🟢', pending: '🟡', disconnected: '🔴', suspended: '⛔' }[s] ?? '⚪');

      const lines = accounts.map(acc => {
        const primary = acc.is_primary ? ' *(primary)*' : '';
        const lastPoll = acc.last_polled_at
          ? `<t:${Math.floor(new Date(acc.last_polled_at).getTime() / 1000)}:R>`
          : 'Never';
        const errors = acc.error_count > 0 ? ` ⚠️ ${acc.error_count} errors` : '';
        return `${statusIcon(acc.status)} **${acc.broker.toUpperCase()}** \`${acc.account_id}\`${primary}\n  Status: ${acc.status} | Last polled: ${lastPoll}${errors}`;
      });

      const embed = new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle('🔗 Your Linked Accounts')
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Trading Competition Bot' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }
  },
};
