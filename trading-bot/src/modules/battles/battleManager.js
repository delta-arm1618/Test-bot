'use strict';

const { query, transaction } = require('../../../db/pool');
const { getCurrentWeek } = require('../leaderboard/scoreEngine');
const { createLogger } = require('../../utils/logger');
const { getCache, setCache, delCache, CacheKeys } = require('../../utils/redis');
const config = require('../../../config');

const log = createLogger('BattleManager');

// ── Valid durations ────────────────────────────────────────
const VALID_DURATIONS_HOURS = {
  '24h': 24,
  '3d': 72,
  '7d': 168,
  '14d': 336,
  '30d': 720,
};

// ── Team weight by tier ────────────────────────────────────
const TIER_WEIGHTS = {
  apex:     0.40,
  diamond:  0.40,
  platinum: 0.35,
  gold:     0.35,
  silver:   0.25,
  bronze:   0.25,
};

/**
 * Generate a unique 8-char lobby code.
 */
async function generateLobbyCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  let attempts = 0;
  do {
    code = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const { rows } = await query('SELECT id FROM battles WHERE lobby_code = $1', [code]);
    if (rows.length === 0) break;
    attempts++;
  } while (attempts < 10);
  return code;
}

/**
 * Create a new battle lobby.
 *
 * @param {string} creatorDiscordId
 * @param {'1v1'|'3v3'} type
 * @param {string} durationKey - '24h' | '3d' | '7d' | '14d' | '30d'
 * @returns {Object} battle row
 */
async function createBattle(creatorDiscordId, type, durationKey = '7d') {
  const durationHours = VALID_DURATIONS_HOURS[durationKey];
  if (!durationHours) throw new Error(`Invalid duration. Valid options: ${Object.keys(VALID_DURATIONS_HOURS).join(', ')}`);

  const { rows: [creator] } = await query(
    'SELECT * FROM users WHERE discord_id = $1',
    [creatorDiscordId]
  );
  if (!creator) throw new Error('You need to register first. Use `/account link`.');
  if (!creator.is_verified) throw new Error('You need to complete the Invite Gate first. Use `/invite status` to check.');

  // Ensure creator has a linked active account
  const { rows: accounts } = await query(
    'SELECT id FROM broker_accounts WHERE user_id = $1 AND status = $2',
    [creator.id, 'active']
  );
  if (accounts.length === 0) throw new Error('You need an active broker account linked. Use `/account link`.');

  const lobbyCode = await generateLobbyCode();
  const endsAt = new Date(Date.now() + durationHours * 3600 * 1000);

  const battle = await transaction(async (client) => {
    const { rows: [newBattle] } = await client.query(`
      INSERT INTO battles (type, lobby_code, status, creator_id, ends_at, duration_hours)
      VALUES ($1, $2, 'open', $3, $4, $5)
      RETURNING *
    `, [type, lobbyCode, creator.id, endsAt, durationHours]);

    // Get creator's current score
    const { week, year } = getCurrentWeek();
    const { rows: [ws] } = await client.query(
      'SELECT score FROM weekly_scores WHERE user_id = $1 AND week_number = $2 AND year = $3 AND is_archived = FALSE',
      [creator.id, week, year]
    );

    // Creator joins team 1 automatically
    await client.query(`
      INSERT INTO battle_participants (battle_id, user_id, team, is_captain, score_at_start, rank_at_join)
      VALUES ($1, $2, 1, TRUE, $3, $4)
    `, [newBattle.id, creator.id, ws?.score ?? 0, creator.tier]);

    return newBattle;
  });

  log.info(`Battle ${battle.lobby_code} (${type}) created by ${creator.username}`);
  return { battle, creator };
}

/**
 * Join an existing battle lobby.
 *
 * @param {string} joinerDiscordId
 * @param {string} lobbyCode
 * @param {number} [preferredTeam] - 1 or 2 (for 3v3, optional)
 */
async function joinBattle(joinerDiscordId, lobbyCode) {
  const { rows: [user] } = await query(
    'SELECT * FROM users WHERE discord_id = $1',
    [joinerDiscordId]
  );
  if (!user) throw new Error('You need to register first.');
  if (!user.is_verified) throw new Error('You need to complete the Invite Gate first.');

  const { rows: [battle] } = await query(
    'SELECT * FROM battles WHERE lobby_code = $1',
    [lobbyCode.toUpperCase()]
  );
  if (!battle) throw new Error(`No battle found with code \`${lobbyCode}\`. Check the code and try again.`);
  if (battle.status !== 'open') throw new Error(`This battle is no longer open (status: ${battle.status}).`);
  if (new Date(battle.ends_at) < new Date()) throw new Error('This battle has already expired.');

  // Check if already participating
  const { rows: existing } = await query(
    'SELECT id FROM battle_participants WHERE battle_id = $1 AND user_id = $2',
    [battle.id, user.id]
  );
  if (existing.length > 0) throw new Error('You are already in this battle.');

  // Check active account
  const { rows: accounts } = await query(
    'SELECT id FROM broker_accounts WHERE user_id = $1 AND status = $2',
    [user.id, 'active']
  );
  if (accounts.length === 0) throw new Error('You need an active broker account. Use `/account link`.');

  // Get current participants to determine team assignment
  const { rows: participants } = await query(
    'SELECT team, COUNT(*) as count FROM battle_participants WHERE battle_id = $1 GROUP BY team',
    [battle.id]
  );

  const teamCounts = { 1: 0, 2: 0 };
  for (const p of participants) teamCounts[p.team] = parseInt(p.count);

  const maxPerTeam = battle.type === '1v1' ? 1 : 3;
  const totalSlots = battle.type === '1v1' ? 2 : 6;
  const totalPlayers = teamCounts[1] + teamCounts[2];

  if (totalPlayers >= totalSlots) throw new Error('This battle lobby is already full.');

  // Assign to team 2 if team 1 is full, otherwise balance teams
  let assignedTeam = 2;
  if (teamCounts[1] <= teamCounts[2] && teamCounts[1] < maxPerTeam) {
    assignedTeam = 1;
  }
  // For 1v1, joiner is always team 2
  if (battle.type === '1v1') assignedTeam = 2;

  const { week, year } = getCurrentWeek();
  const { rows: [ws] } = await query(
    'SELECT score FROM weekly_scores WHERE user_id = $1 AND week_number = $2 AND year = $3 AND is_archived = FALSE',
    [user.id, week, year]
  );

  await transaction(async (client) => {
    await client.query(`
      INSERT INTO battle_participants (battle_id, user_id, team, is_captain, score_at_start, rank_at_join)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [battle.id, user.id, assignedTeam, false, ws?.score ?? 0, user.tier]);

    // Check if battle should auto-start (all slots filled)
    const newTotal = totalPlayers + 1;
    if (newTotal >= totalSlots) {
      await client.query(`
        UPDATE battles SET status = 'active', started_at = NOW() WHERE id = $1
      `, [battle.id]);
    }
  });

  // Refresh participant count
  const { rows: updatedParticipants } = await query(
    'SELECT COUNT(*) as count FROM battle_participants WHERE battle_id = $1',
    [battle.id]
  );
  const newCount = parseInt(updatedParticipants[0].count);
  const isStarted = newCount >= totalSlots;

  log.info(`${user.username} joined battle ${battle.lobby_code} (team ${assignedTeam})`);
  return { battle, user, team: assignedTeam, isStarted };
}

/**
 * Get live status of a battle with current scores.
 *
 * @param {string} lobbyCode
 * @returns {Object} battle details + live participant scores
 */
async function getBattleStatus(lobbyCode) {
  const { rows: [battle] } = await query(
    'SELECT * FROM battles WHERE lobby_code = $1',
    [lobbyCode.toUpperCase()]
  );
  if (!battle) throw new Error(`No battle found with code \`${lobbyCode}\`.`);

  const { week, year } = getCurrentWeek();

  const { rows: participants } = await query(`
    SELECT
      bp.*,
      u.username,
      u.discord_id,
      u.tier,
      ws.score as current_score,
      ws.pnl_pct,
      ws.win_rate,
      ws.max_drawdown,
      ws.total_trades
    FROM battle_participants bp
    JOIN users u ON u.id = bp.user_id
    LEFT JOIN weekly_scores ws ON ws.user_id = bp.user_id
      AND ws.week_number = $2 AND ws.year = $3 AND ws.is_archived = FALSE
    WHERE bp.battle_id = $1
    ORDER BY bp.team, bp.is_captain DESC
  `, [battle.id, week, year]);

  // Compute team scores
  const team1 = participants.filter(p => p.team === 1);
  const team2 = participants.filter(p => p.team === 2);

  const computeTeamScore = (members) => {
    if (members.length === 0) return 0;
    if (battle.type === '1v1') return parseFloat(members[0].current_score ?? 0);

    // 3v3: weighted average by tier
    let totalWeight = 0;
    let weightedScore = 0;
    for (const m of members) {
      const weight = TIER_WEIGHTS[m.tier] ?? 0.25;
      weightedScore += (parseFloat(m.current_score ?? 0) - parseFloat(m.score_at_start ?? 0)) * weight;
      totalWeight += weight;
    }
    return totalWeight > 0 ? weightedScore / totalWeight : 0;
  };

  const team1Score = computeTeamScore(team1);
  const team2Score = computeTeamScore(team2);

  return {
    battle,
    participants,
    team1,
    team2,
    team1Score,
    team2Score,
    leadingTeam: team1Score >= team2Score ? 1 : 2,
    endsAt: battle.ends_at,
    isActive: battle.status === 'active',
    isCompleted: battle.status === 'completed',
  };
}

/**
 * Resolve a completed battle: determine winner, distribute HP, update stats.
 *
 * @param {string} battleId
 * @param {import('discord.js').Client} [client] - for announcements
 */
async function resolveBattle(battleId, client = null) {
  const { rows: [battle] } = await query('SELECT * FROM battles WHERE id = $1', [battleId]);
  if (!battle) throw new Error('Battle not found.');
  if (battle.status === 'completed') return battle; // Already resolved
  if (battle.status === 'cancelled') return battle;

  const { week, year } = getCurrentWeek();

  const { rows: participants } = await query(`
    SELECT bp.*, u.username, u.discord_id, u.tier,
           ws.score as current_score
    FROM battle_participants bp
    JOIN users u ON u.id = bp.user_id
    LEFT JOIN weekly_scores ws ON ws.user_id = bp.user_id
      AND ws.week_number = $2 AND ws.year = $3 AND ws.is_archived = FALSE
    WHERE bp.battle_id = $1
  `, [battleId, week, year]);

  if (participants.length < 2) {
    // Not enough players — cancel
    await query('UPDATE battles SET status = $1 WHERE id = $2', ['cancelled', battleId]);
    log.info(`Battle ${battle.lobby_code} cancelled (not enough players)`);
    return { ...battle, status: 'cancelled' };
  }

  const team1 = participants.filter(p => p.team === 1);
  const team2 = participants.filter(p => p.team === 2);

  // Compute score deltas during battle
  const computeTeamScore = (members) => {
    if (members.length === 0) return 0;
    if (battle.type === '1v1') {
      const m = members[0];
      return parseFloat(m.current_score ?? 0) - parseFloat(m.score_at_start ?? 0);
    }
    let totalWeight = 0;
    let weightedScore = 0;
    for (const m of members) {
      const weight = TIER_WEIGHTS[m.tier] ?? 0.25;
      const delta = parseFloat(m.current_score ?? 0) - parseFloat(m.score_at_start ?? 0);
      weightedScore += delta * weight;
      totalWeight += weight;
    }
    return totalWeight > 0 ? weightedScore / totalWeight : 0;
  };

  const team1Score = computeTeamScore(team1);
  const team2Score = computeTeamScore(team2);
  const winningTeam = team1Score >= team2Score ? 1 : 2;
  const losingTeam = winningTeam === 1 ? 2 : 1;

  const winners = participants.filter(p => p.team === winningTeam);
  const losers = participants.filter(p => p.team === losingTeam);

  // HP reward — base 150 HP for winner, +50 if captain in 3v3
  const BASE_HP_WIN = 150;
  const CAPTAIN_BONUS = 50;

  await transaction(async (client) => {
    // Update battle record
    await client.query(`
      UPDATE battles
      SET status = 'completed',
          winning_team = $1,
          winner_id = $2
      WHERE id = $3
    `, [
      winningTeam,
      battle.type === '1v1' ? winners[0].user_id : null,
      battleId,
    ]);

    // Update participant score_at_end and score_delta
    for (const p of participants) {
      const delta = parseFloat(p.current_score ?? 0) - parseFloat(p.score_at_start ?? 0);
      await client.query(
        'UPDATE battle_participants SET score_at_end = $1, score_delta = $2 WHERE id = $3',
        [p.current_score ?? 0, delta, p.id]
      );
    }

    // Award HP to winners
    for (const winner of winners) {
      const hpGain = BASE_HP_WIN + (winner.is_captain ? CAPTAIN_BONUS : 0);
      const { rows: [updatedUser] } = await client.query(
        'UPDATE users SET hedge_points = hedge_points + $1, battles_won = battles_won + 1 WHERE id = $2 RETURNING hedge_points',
        [hpGain, winner.user_id]
      );
      await client.query(
        'INSERT INTO hp_transactions (user_id, amount, balance_after, reason, reference_id) VALUES ($1, $2, $3, $4, $5)',
        [winner.user_id, hpGain, updatedUser.hedge_points, 'battle_win', battleId]
      );
    }

    // Increment total_battles for all participants
    const allIds = participants.map(p => p.user_id);
    await client.query(
      'UPDATE users SET total_battles = total_battles + 1 WHERE id = ANY($1::uuid[])',
      [allIds]
    );
  });

  log.info(`Battle ${battle.lobby_code} resolved. Team ${winningTeam} wins. Score: ${team1Score.toFixed(1)} vs ${team2Score.toFixed(1)}`);

  return {
    battle,
    winningTeam,
    team1,
    team2,
    team1Score,
    team2Score,
    winners,
    losers,
    resolved: true,
  };
}

/**
 * Cron: check for expired battles and resolve them.
 * Called every 5 minutes by scheduler.
 */
async function resolveExpiredBattles(client = null) {
  const { rows: expired } = await query(`
    SELECT id, lobby_code FROM battles
    WHERE status = 'active' AND ends_at < NOW()
    LIMIT 20
  `);

  if (expired.length === 0) return;

  log.info(`Resolving ${expired.length} expired battles...`);

  for (const battle of expired) {
    try {
      const result = await resolveBattle(battle.id, client);

      // Post result to battles channel if Discord client available
      if (client && result.resolved && config.discord.channels.battles) {
        const channel = client.channels.cache.get(config.discord.channels.battles);
        if (channel) {
          await channel.send({
            embeds: [buildResultEmbed(result)],
          }).catch(() => {});
        }
      }
    } catch (err) {
      log.error(`Failed to resolve battle ${battle.lobby_code}`, { error: err.message });
    }
  }
}

/**
 * Get user's past battles.
 */
async function getUserBattleHistory(discordId, limit = 10) {
  const { rows: [user] } = await query('SELECT id FROM users WHERE discord_id = $1', [discordId]);
  if (!user) return [];

  const { rows } = await query(`
    SELECT
      b.lobby_code,
      b.type,
      b.status,
      b.started_at,
      b.ends_at,
      b.winning_team,
      bp.team,
      bp.score_at_start,
      bp.score_at_end,
      bp.score_delta,
      bp.is_captain,
      CASE WHEN b.winning_team = bp.team THEN TRUE ELSE FALSE END as won
    FROM battle_participants bp
    JOIN battles b ON b.id = bp.battle_id
    WHERE bp.user_id = $1 AND b.status = 'completed'
    ORDER BY b.ends_at DESC
    LIMIT $2
  `, [user.id, limit]);

  return rows;
}

/**
 * Build a Discord embed for a resolved battle.
 */
function buildResultEmbed(result) {
  const { battle, winningTeam, team1, team2, team1Score, team2Score, winners } = result;

  const formatTeam = (members, score) => {
    if (!members.length) return '*No players*';
    return members.map(m => {
      const tierConf = config.tiers[m.tier];
      const captain = m.is_captain ? ' 👑' : '';
      const delta = parseFloat(m.score_delta ?? 0);
      const deltaStr = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pts`;
      return `${tierConf?.emoji ?? '•'} **${m.username}**${captain} (${deltaStr})`;
    }).join('\n');
  };

  const trophy = winningTeam === 1 ? '🏆 Team 1' : '🏆 Team 2';
  const losingLabel = winningTeam === 1 ? 'Team 2' : 'Team 1';
  const losingScore = winningTeam === 1 ? team2Score : team1Score;
  const winningScore = winningTeam === 1 ? team1Score : team2Score;

  return {
    color: 0xFFD700,
    title: `⚔️ Battle ${battle.lobby_code} — Result`,
    description: `${trophy} wins!\n**${winningScore.toFixed(1)} pts** vs ${losingScore.toFixed(1)} pts`,
    fields: [
      {
        name: `${winningTeam === 1 ? '🏆' : '•'} Team 1 — ${team1Score.toFixed(1)} pts`,
        value: formatTeam(team1, team1Score),
        inline: true,
      },
      {
        name: `${winningTeam === 2 ? '🏆' : '•'} Team 2 — ${team2Score.toFixed(1)} pts`,
        value: formatTeam(team2, team2Score),
        inline: true,
      },
      {
        name: '💰 HP Awarded',
        value: `Winners received **150 HP** each${battle.type === '3v3' ? ' (captain: +50 HP)' : ''}`,
      },
    ],
    footer: { text: `Battle Type: ${battle.type.toUpperCase()} • Duration: ${battle.duration_hours}h • Trading Competition Bot` },
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  createBattle,
  joinBattle,
  getBattleStatus,
  resolveBattle,
  resolveExpiredBattles,
  getUserBattleHistory,
  buildResultEmbed,
  VALID_DURATIONS_HOURS,
  TIER_WEIGHTS,
};
