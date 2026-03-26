'use strict';

const { query, transaction } = require('../../../db/pool');
const { getCurrentWeek } = require('../leaderboard/scoreEngine');
const { createLogger } = require('../../utils/logger');
const config = require('../../../config');

const log = createLogger('SeasonManager');

// All possible season rules with descriptions and example params
const SEASON_RULES = {
  forex_majors_only: {
    label: '💱 Forex Majors Only',
    description: 'Only trades on EUR/USD, GBP/USD, USD/JPY, USD/CHF, AUD/USD, USD/CAD, NZD/USD count.',
  },
  max_trades_per_day: {
    label: '🔢 Max 2 Trades Per Day',
    description: 'A maximum of 2 trades per day are counted toward your score.',
    param: { max_trades: 2 },
  },
  no_news_trades: {
    label: '📰 No News Trades',
    description: 'Trades opened 30 minutes before or after major news events are excluded.',
  },
  long_only: {
    label: '📈 Long Only',
    description: 'Only BUY positions count toward your score this week.',
  },
  max_leverage: {
    label: '⚖️ Max Leverage 1:10',
    description: 'Only trades with leverage of 1:10 or less are counted.',
    param: { max_leverage: 10 },
  },
};

// The 3 options rotate each week — picked semi-randomly from SEASON_RULES
const RULE_POOL = Object.keys(SEASON_RULES);

/**
 * Pick 3 random season options for the current week's vote.
 * Deterministic per week so the same options always show for same week.
 */
function pickWeekOptions(week, year) {
  // Seeded shuffle using week+year
  const seed = week * 100 + year;
  const shuffled = [...RULE_POOL].sort((a, b) => {
    const ha = (seed * a.charCodeAt(0) * 31) % 100;
    const hb = (seed * b.charCodeAt(0) * 31) % 100;
    return ha - hb;
  });
  return shuffled.slice(0, 3);
}

/**
 * Post the weekly vote embed in the announcements channel.
 * Called every Friday 18:00 UTC by the scheduler.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').Client} client
 */
async function postSeasonVote(guild, client) {
  const { week, year } = getCurrentWeek();

  // Check if vote already posted this week
  const { rows: [existing] } = await query(
    'SELECT * FROM seasons WHERE week_number = $1 AND year = $2',
    [week, year]
  );
  if (existing) {
    log.info(`Season vote already posted for week ${week}/${year}`);
    return;
  }

  const optionKeys = pickWeekOptions(week, year);
  const options = optionKeys.map(k => SEASON_RULES[k]);

  const channelId = config.discord.channels.announcements;
  if (!channelId) {
    log.warn('CHANNEL_ANNOUNCEMENTS not configured — cannot post season vote');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    log.warn(`Announcements channel ${channelId} not found`);
    return;
  }

  const embed = {
    color: 0x5865F2,
    title: `🌪️ Volatility Season — Week ${week + 1} Vote`,
    description: [
      'Vote for next week\'s special rule! React with the matching emoji to cast your vote.',
      'Voting closes **Sunday at 23:00 UTC**.',
      '',
      `🇦 **${options[0].label}**\n${options[0].description}`,
      '',
      `🇧 **${options[1].label}**\n${options[1].description}`,
      '',
      `🇨 **${options[2].label}**\n${options[2].description}`,
    ].join('\n'),
    footer: { text: 'Trading Competition Bot • Rule activates Monday 00:00 UTC' },
    timestamp: new Date().toISOString(),
  };

  const msg = await channel.send({ embeds: [embed] });

  // Add vote reactions
  await msg.react('🇦');
  await msg.react('🇧');
  await msg.react('🇨');

  // Store vote in DB
  const nextWeek = week === 52 ? 1 : week + 1;
  const nextYear = week === 52 ? year + 1 : year;

  await query(`
    INSERT INTO seasons (week_number, year, rule_type, rule_description, rule_param,
                         vote_option_a, vote_option_b, vote_option_c, vote_message_id, is_active)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE)
    ON CONFLICT (week_number, year) DO NOTHING
  `, [
    nextWeek, nextYear,
    optionKeys[0],
    options[0].description,
    SEASON_RULES[optionKeys[0]].param ? JSON.stringify(SEASON_RULES[optionKeys[0]].param) : null,
    options[0].label,
    options[1].label,
    options[2].label,
    msg.id,
  ]);

  log.info(`Season vote posted for week ${nextWeek}/${nextYear} (message: ${msg.id})`);
}

/**
 * Tally votes and activate the winning rule.
 * Called every Sunday 23:00 UTC.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').Client} client
 */
async function resolveSeasonVote(guild, client) {
  const { week, year } = getCurrentWeek();
  const nextWeek = week === 52 ? 1 : week + 1;
  const nextYear = week === 52 ? year + 1 : year;

  const { rows: [season] } = await query(
    'SELECT * FROM seasons WHERE week_number = $1 AND year = $2 AND is_active = FALSE',
    [nextWeek, nextYear]
  );

  if (!season) {
    log.info('No pending season vote to resolve');
    return;
  }

  const channelId = config.discord.channels.announcements;
  const channel = channelId ? client.channels.cache.get(channelId) : null;

  // Tally reactions if we have the message ID
  let votesA = 0, votesB = 0, votesC = 0;
  if (season.vote_message_id && channel) {
    try {
      const msg = await channel.messages.fetch(season.vote_message_id);
      votesA = (msg.reactions.cache.get('🇦')?.count ?? 1) - 1; // subtract bot's own reaction
      votesB = (msg.reactions.cache.get('🇧')?.count ?? 1) - 1;
      votesC = (msg.reactions.cache.get('🇨')?.count ?? 1) - 1;
    } catch (err) {
      log.warn('Could not fetch vote message', { error: err.message });
    }
  }

  // Determine winner
  const optionKeys = pickWeekOptions(week, year); // same keys as when posted
  let winnerIdx = 0;
  if (votesB > votesA && votesB >= votesC) winnerIdx = 1;
  if (votesC > votesA && votesC > votesB) winnerIdx = 2;

  const winnerKey = optionKeys[winnerIdx];
  const winnerRule = SEASON_RULES[winnerKey];

  // Activate the season rule
  await query(`
    UPDATE seasons
    SET rule_type = $1,
        rule_description = $2,
        rule_param = $3,
        votes_a = $4,
        votes_b = $5,
        votes_c = $6,
        is_active = TRUE,
        activated_at = NOW()
    WHERE id = $7
  `, [
    winnerKey,
    winnerRule.description,
    winnerRule.param ? JSON.stringify(winnerRule.param) : null,
    votesA,
    votesB,
    votesC,
    season.id,
  ]);

  log.info(`Season rule for week ${nextWeek}/${nextYear}: ${winnerKey} (votes: A=${votesA}, B=${votesB}, C=${votesC})`);

  // Announce the winning rule
  if (channel) {
    const labels = ['🇦', '🇧', '🇨'];
    await channel.send({
      embeds: [{
        color: 0xFFD700,
        title: '🌪️ Volatility Season — Next Week\'s Rule Announced!',
        description: [
          `The community has voted! Next week's special rule is:`,
          '',
          `**${labels[winnerIdx]} ${winnerRule.label}**`,
          `${winnerRule.description}`,
          '',
          `📊 Votes: 🇦 ${votesA} · 🇧 ${votesB} · 🇨 ${votesC}`,
          '',
          'Trades that violate this rule will **not count** toward your weekly score.',
          'The rule activates Monday 00:00 UTC with the weekly reset.',
        ].join('\n'),
        footer: { text: 'Trading Competition Bot • Check the rule with /season current' },
        timestamp: new Date().toISOString(),
      }],
    }).catch(() => {});
  }

  return { winnerKey, winnerRule, votesA, votesB, votesC };
}

/**
 * Get the currently active season rule.
 */
async function getCurrentSeason() {
  const { week, year } = getCurrentWeek();
  const { rows: [season] } = await query(
    'SELECT * FROM seasons WHERE week_number = $1 AND year = $2 AND is_active = TRUE',
    [week, year]
  );
  return season ?? null;
}

/**
 * Get the upcoming (voted but not yet active) season rule.
 */
async function getUpcomingSeason() {
  const { week, year } = getCurrentWeek();
  const nextWeek = week === 52 ? 1 : week + 1;
  const nextYear = week === 52 ? year + 1 : year;

  const { rows: [season] } = await query(
    'SELECT * FROM seasons WHERE week_number = $1 AND year = $2',
    [nextWeek, nextYear]
  );
  return season ?? null;
}

module.exports = {
  SEASON_RULES,
  pickWeekOptions,
  postSeasonVote,
  resolveSeasonVote,
  getCurrentSeason,
  getUpcomingSeason,
};
