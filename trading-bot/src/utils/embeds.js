'use strict';

const { EmbedBuilder } = require('discord.js');
const config = require('../../config');
const dayjs = require('dayjs');

// ── Brand colors ───────────────────────────────────────────
const COLORS = {
  primary:   0x5865F2,  // Discord blurple
  success:   0x57F287,  // Green
  warning:   0xFEE75C,  // Yellow
  danger:    0xED4245,  // Red
  info:      0x00B0F4,  // Light blue
  gold:      0xFFD700,
  platinum:  0xE5E4E2,
  diamond:   0x00BFFF,
  apex:      0xFF6B35,
};

const TIER_COLORS = {
  bronze:   0xCD7F32,
  silver:   0xC0C0C0,
  gold:     0xFFD700,
  platinum: 0xE5E4E2,
  diamond:  0x00BFFF,
  apex:     0xFF6B35,
};

/**
 * Base embed with consistent footer & timestamp.
 */
function baseEmbed(title, color = COLORS.primary) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setFooter({ text: 'Trading Competition Bot' })
    .setTimestamp();
}

/**
 * Success embed — green checkmark style.
 */
function successEmbed(title, description) {
  return baseEmbed(`✅ ${title}`, COLORS.success).setDescription(description);
}

/**
 * Error embed — red X style.
 */
function errorEmbed(title, description) {
  return baseEmbed(`❌ ${title}`, COLORS.danger).setDescription(description);
}

/**
 * Warning embed.
 */
function warningEmbed(title, description) {
  return baseEmbed(`⚠️ ${title}`, COLORS.warning).setDescription(description);
}

/**
 * Rank card embed for /rank command.
 */
function rankEmbed(user, rankData) {
  const tier = config.tiers[rankData.tier];
  const embed = new EmbedBuilder()
    .setColor(TIER_COLORS[rankData.tier] || COLORS.primary)
    .setTitle(`${tier.emoji} ${user.username} — Rank Card`)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: '🏆 Tier', value: tier.name, inline: true },
      { name: '📊 Score', value: `**${rankData.score.toFixed(1)}** pts`, inline: true },
      { name: '📍 Position', value: `#${rankData.position} in ${tier.name}`, inline: true },
      { name: '📈 PnL %', value: `${rankData.metrics.pnl >= 0 ? '+' : ''}${rankData.metrics.pnl.toFixed(2)}%`, inline: true },
      { name: '🎯 Win Rate', value: `${(rankData.metrics.winRate * 100).toFixed(1)}%`, inline: true },
      { name: '📉 Max DD', value: `${(rankData.metrics.maxDrawdown * 100).toFixed(2)}%`, inline: true },
      { name: '🔄 Consistency', value: `${(rankData.metrics.consistency * 100).toFixed(1)}%`, inline: true },
      { name: '💹 Profit Factor', value: rankData.metrics.profitFactor?.toFixed(2) ?? 'N/A', inline: true },
      { name: '📅 Trades', value: `${rankData.metrics.totalTrades ?? 0}`, inline: true },
    )
    .setFooter({ text: `Season Week ${rankData.week} • Resets every Monday 00:00 UTC` })
    .setTimestamp();

  if (rankData.nextTier) {
    const progress = rankData.promotionProgress;
    const bar = buildProgressBar(progress, 10);
    embed.addFields({
      name: `🚀 Progress to ${config.tiers[rankData.nextTier]?.name}`,
      value: `${bar} ${(progress * 100).toFixed(0)}%`,
    });
  }

  return embed;
}

/**
 * Leaderboard top-10 embed with pagination info.
 */
function leaderboardEmbed(entries, page, totalPages, week) {
  const embed = baseEmbed(`🏆 Weekly Leaderboard — Week ${week}`, COLORS.gold);
  embed.setDescription(`Page ${page}/${totalPages}`);

  if (entries.length === 0) {
    embed.addFields({ name: 'No data yet', value: 'Be the first to link your account!' });
    return embed;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = entries.map((e, i) => {
    const rank = (page - 1) * 10 + i + 1;
    const medal = rank <= 3 ? medals[rank - 1] : `\`#${rank}\``;
    const tier = config.tiers[e.tier];
    return `${medal} ${tier.emoji} **${e.username}** — ${e.score.toFixed(1)} pts _(${e.tier})_`;
  });

  embed.addFields({ name: 'Rankings', value: lines.join('\n') });
  embed.setFooter({ text: `Trading Competition Bot • Week ${week} • Resets Monday 00:00 UTC` });
  return embed;
}

/**
 * Stats embed for /stats @user.
 */
function statsEmbed(user, stats) {
  const tier = config.tiers[stats.tier];
  return new EmbedBuilder()
    .setColor(TIER_COLORS[stats.tier] || COLORS.primary)
    .setTitle(`📊 ${user.username} — Full Stats`)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: '🏆 Current Tier', value: `${tier.emoji} ${tier.name}`, inline: true },
      { name: '📊 Weekly Score', value: `${stats.score.toFixed(1)} pts`, inline: true },
      { name: '🌟 Best Rank', value: `#${stats.bestRankEver ?? 'N/A'}`, inline: true },
      { name: '📈 PnL %', value: `${stats.metrics.pnl >= 0 ? '+' : ''}${stats.metrics.pnl.toFixed(2)}%`, inline: true },
      { name: '🎯 Win Rate', value: `${(stats.metrics.winRate * 100).toFixed(1)}%`, inline: true },
      { name: '📉 Max Drawdown', value: `${(stats.metrics.maxDrawdown * 100).toFixed(2)}%`, inline: true },
      { name: '💹 Profit Factor', value: stats.metrics.profitFactor?.toFixed(2) ?? 'N/A', inline: true },
      { name: '📐 Sharpe Ratio', value: stats.metrics.sharpeRatio?.toFixed(2) ?? 'N/A', inline: true },
      { name: '⚖️ Avg RRR', value: stats.metrics.avgRRR?.toFixed(2) ?? 'N/A', inline: true },
      { name: '🔥 Current Streak', value: `${stats.metrics.streak ?? 0} trades`, inline: true },
      { name: '🔄 Total Trades', value: `${stats.metrics.totalTrades ?? 0}`, inline: true },
      { name: '💰 Hedge Points', value: `${stats.hedgePoints ?? 0} HP`, inline: true },
    )
    .setTimestamp();
}

/**
 * Invite status embed.
 */
function inviteStatusEmbed(user, inviteData) {
  const verified = inviteData.validInvites >= config.invite.requiredCount;
  const embed = new EmbedBuilder()
    .setColor(verified ? COLORS.success : COLORS.warning)
    .setTitle(verified ? '✅ Invite Gate — Unlocked' : '⏳ Invite Gate — Pending')
    .setDescription(verified
      ? 'You have full access to all competitions!'
      : `Invite **${config.invite.requiredCount - inviteData.validInvites}** more active trader(s) to unlock competitions.`
    )
    .addFields(
      { name: '🔗 Your Invite Link', value: `https://discord.gg/${inviteData.code}`, inline: false },
      { name: '✅ Valid Invites', value: `${inviteData.validInvites}/${config.invite.requiredCount}`, inline: true },
      { name: '⏳ Pending (not yet 24h)', value: `${inviteData.pendingInvites}`, inline: true },
      { name: '💰 HP Earned', value: `${inviteData.hpEarned} HP`, inline: true },
    )
    .setTimestamp();
  return embed;
}

// ── Helpers ───────────────────────────────────────────────
function buildProgressBar(progress, length = 10) {
  const filled = Math.round(progress * length);
  const empty = length - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

module.exports = {
  COLORS,
  TIER_COLORS,
  baseEmbed,
  successEmbed,
  errorEmbed,
  warningEmbed,
  rankEmbed,
  leaderboardEmbed,
  statsEmbed,
  inviteStatusEmbed,
  buildProgressBar,
};
