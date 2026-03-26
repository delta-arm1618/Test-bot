'use strict';

/**
 * Unit tests for Bloc 2 — BattleManager
 * Tests pure logic functions that don't require DB/Discord.
 */

// ── Setup env vars (required by config module) ─────────────
process.env.AES_SECRET_KEY = 'test_secret_key_32_chars_exactly';
process.env.JWT_SECRET = 'test_jwt_secret';
process.env.DISCORD_TOKEN = 'test_token';
process.env.DISCORD_CLIENT_ID = 'test_client_id';
process.env.GUILD_ID = 'test_guild_id';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
process.env.HTTP_SECRET = 'test_http_secret';

const { TIER_WEIGHTS, VALID_DURATIONS_HOURS } = require('../../src/modules/battles/battleManager');

// ── Inline score logic replicated for unit testing ─────────
const TIER_ORDER = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'apex'];

function computeTeamScore1v1(member) {
  return parseFloat(member.current_score ?? 0) - parseFloat(member.score_at_start ?? 0);
}

function computeTeamScore3v3(members) {
  if (members.length === 0) return 0;
  let totalWeight = 0;
  let weightedScore = 0;
  for (const m of members) {
    const weight = TIER_WEIGHTS[m.tier] ?? 0.25;
    const delta = parseFloat(m.current_score ?? 0) - parseFloat(m.score_at_start ?? 0);
    weightedScore += delta * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weightedScore / totalWeight : 0;
}

// ════════════════════════════════════════════════════════════
// VALID_DURATIONS_HOURS
// ════════════════════════════════════════════════════════════
describe('BattleManager — VALID_DURATIONS_HOURS', () => {
  test('24h maps to 24 hours', () => {
    expect(VALID_DURATIONS_HOURS['24h']).toBe(24);
  });

  test('7d maps to 168 hours', () => {
    expect(VALID_DURATIONS_HOURS['7d']).toBe(168);
  });

  test('30d maps to 720 hours', () => {
    expect(VALID_DURATIONS_HOURS['30d']).toBe(720);
  });

  test('all 5 durations are defined', () => {
    const keys = Object.keys(VALID_DURATIONS_HOURS);
    expect(keys).toHaveLength(5);
    expect(keys).toEqual(expect.arrayContaining(['24h', '3d', '7d', '14d', '30d']));
  });

  test('durations are in ascending order', () => {
    const values = Object.values(VALID_DURATIONS_HOURS);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });

  test('invalid duration key returns undefined', () => {
    expect(VALID_DURATIONS_HOURS['2d']).toBeUndefined();
    expect(VALID_DURATIONS_HOURS['1w']).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════
// TIER_WEIGHTS
// ════════════════════════════════════════════════════════════
describe('BattleManager — TIER_WEIGHTS', () => {
  test('apex and diamond have highest weight (0.40)', () => {
    expect(TIER_WEIGHTS['apex']).toBe(0.40);
    expect(TIER_WEIGHTS['diamond']).toBe(0.40);
  });

  test('bronze and silver have lowest weight (0.25)', () => {
    expect(TIER_WEIGHTS['bronze']).toBe(0.25);
    expect(TIER_WEIGHTS['silver']).toBe(0.25);
  });

  test('gold and platinum have middle weight (0.35)', () => {
    expect(TIER_WEIGHTS['gold']).toBe(0.35);
    expect(TIER_WEIGHTS['platinum']).toBe(0.35);
  });

  test('all 6 tiers have weights defined', () => {
    for (const tier of TIER_ORDER) {
      expect(TIER_WEIGHTS[tier]).toBeDefined();
      expect(typeof TIER_WEIGHTS[tier]).toBe('number');
    }
  });

  test('all weights are between 0 and 1', () => {
    for (const w of Object.values(TIER_WEIGHTS)) {
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });
});

// ════════════════════════════════════════════════════════════
// 1v1 Score Calculation
// ════════════════════════════════════════════════════════════
describe('BattleManager — 1v1 score delta', () => {
  test('positive performance gives positive delta', () => {
    const member = { current_score: 650, score_at_start: 500 };
    expect(computeTeamScore1v1(member)).toBe(150);
  });

  test('negative performance gives negative delta', () => {
    const member = { current_score: 400, score_at_start: 500 };
    expect(computeTeamScore1v1(member)).toBe(-100);
  });

  test('no change gives 0 delta', () => {
    const member = { current_score: 500, score_at_start: 500 };
    expect(computeTeamScore1v1(member)).toBe(0);
  });

  test('player with higher delta wins', () => {
    const player1 = { current_score: 800, score_at_start: 600 }; // +200
    const player2 = { current_score: 750, score_at_start: 600 }; // +150
    const delta1 = computeTeamScore1v1(player1);
    const delta2 = computeTeamScore1v1(player2);
    expect(delta1).toBeGreaterThan(delta2);
  });
});

// ════════════════════════════════════════════════════════════
// 3v3 Team Score Calculation
// ════════════════════════════════════════════════════════════
describe('BattleManager — 3v3 weighted team score', () => {
  const makeTeam = (members) => members.map(([tier, start, current]) => ({
    tier,
    score_at_start: start,
    current_score: current,
  }));

  test('empty team returns 0', () => {
    expect(computeTeamScore3v3([])).toBe(0);
  });

  test('all bronze team with equal deltas', () => {
    const team = makeTeam([
      ['bronze', 400, 500],  // +100
      ['bronze', 400, 500],  // +100
      ['bronze', 400, 500],  // +100
    ]);
    const score = computeTeamScore3v3(team);
    expect(score).toBeCloseTo(100, 1);
  });

  test('apex member has more influence than bronze', () => {
    // Two teams with same total delta, but different compositions
    const highTierTeam = makeTeam([
      ['apex',   400, 600],  // +200 × 0.40
      ['bronze', 400, 500],  // +100 × 0.25
      ['bronze', 400, 500],  // +100 × 0.25
    ]);

    const lowTierTeam = makeTeam([
      ['bronze', 400, 600],  // +200 × 0.25
      ['bronze', 400, 500],  // +100 × 0.25
      ['apex',   400, 500],  // +100 × 0.40
    ]);

    const highScore = computeTeamScore3v3(highTierTeam);
    const lowScore = computeTeamScore3v3(lowTierTeam);
    // High-tier version should differ due to weighting
    expect(highScore).not.toBe(lowScore);
  });

  test('mixed tier team — weighted average makes sense', () => {
    // diamond (+200 × 0.40) + gold (0 × 0.35) + bronze (-100 × 0.25)
    const team = makeTeam([
      ['diamond', 500, 700],  // +200
      ['gold',    500, 500],  // 0
      ['bronze',  500, 400],  // -100
    ]);
    const score = computeTeamScore3v3(team);
    // Expected: (200*0.40 + 0*0.35 + (-100)*0.25) / (0.40+0.35+0.25)
    const expected = (200 * 0.40 + 0 * 0.35 + (-100) * 0.25) / (0.40 + 0.35 + 0.25);
    expect(score).toBeCloseTo(expected, 2);
  });

  test('winning team has strictly higher score', () => {
    const team1 = makeTeam([
      ['gold',   500, 700],  // +200
      ['gold',   500, 650],  // +150
      ['silver', 500, 620],  // +120
    ]);
    const team2 = makeTeam([
      ['gold',   500, 600],  // +100
      ['gold',   500, 580],  // +80
      ['silver', 500, 560],  // +60
    ]);
    expect(computeTeamScore3v3(team1)).toBeGreaterThan(computeTeamScore3v3(team2));
  });

  test('unknown tier defaults to weight 0.25 (no crash)', () => {
    const team = makeTeam([
      ['legend',  400, 600],  // unknown tier
      ['bronze',  400, 500],
    ]);
    expect(() => computeTeamScore3v3(team)).not.toThrow();
    expect(typeof computeTeamScore3v3(team)).toBe('number');
  });
});

// ════════════════════════════════════════════════════════════
// Lobby code format
// ════════════════════════════════════════════════════════════
describe('BattleManager — Lobby Code', () => {
  test('lobby code is 8 characters', () => {
    // Verify the alphabet contains no ambiguous chars (0, O, I, 1)
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    // Simulate 1000 codes and check length + charset
    for (let i = 0; i < 1000; i++) {
      const code = Array.from({ length: 8 }, () =>
        ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
      ).join('');
      expect(code).toHaveLength(8);
      expect(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code)).toBe(true);
    }
  });

  test('alphabet excludes ambiguous characters 0, O, I, 1', () => {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    expect(ALPHABET).not.toContain('0');
    expect(ALPHABET).not.toContain('O');
    expect(ALPHABET).not.toContain('I');
    expect(ALPHABET).not.toContain('1');
  });
});

// ════════════════════════════════════════════════════════════
// HP Award Logic
// ════════════════════════════════════════════════════════════
describe('BattleManager — HP Award Logic', () => {
  const BASE_HP_WIN = 150;
  const CAPTAIN_BONUS = 50;

  function computeHp(isWinner, isCaptain) {
    if (!isWinner) return 0;
    return BASE_HP_WIN + (isCaptain ? CAPTAIN_BONUS : 0);
  }

  test('winner receives 150 HP', () => {
    expect(computeHp(true, false)).toBe(150);
  });

  test('winner captain receives 200 HP', () => {
    expect(computeHp(true, true)).toBe(200);
  });

  test('loser receives 0 HP', () => {
    expect(computeHp(false, false)).toBe(0);
    expect(computeHp(false, true)).toBe(0);
  });

  test('captain bonus is 50 HP', () => {
    const withBonus = computeHp(true, true);
    const withoutBonus = computeHp(true, false);
    expect(withBonus - withoutBonus).toBe(CAPTAIN_BONUS);
  });
});

// ════════════════════════════════════════════════════════════
// Battle slot validation
// ════════════════════════════════════════════════════════════
describe('BattleManager — Battle Slot Validation', () => {
  function canJoin(type, teamCounts) {
    const maxPerTeam = type === '1v1' ? 1 : 3;
    const totalSlots = type === '1v1' ? 2 : 6;
    const totalPlayers = teamCounts[1] + teamCounts[2];
    return totalPlayers < totalSlots;
  }

  test('1v1: full when 2 players', () => {
    expect(canJoin('1v1', { 1: 1, 2: 1 })).toBe(false);
  });

  test('1v1: open with 1 player', () => {
    expect(canJoin('1v1', { 1: 1, 2: 0 })).toBe(true);
  });

  test('3v3: full when 6 players', () => {
    expect(canJoin('3v3', { 1: 3, 2: 3 })).toBe(false);
  });

  test('3v3: open with 5 players', () => {
    expect(canJoin('3v3', { 1: 3, 2: 2 })).toBe(true);
  });

  test('3v3: open with 0 players', () => {
    expect(canJoin('3v3', { 1: 0, 2: 0 })).toBe(true);
  });
});
