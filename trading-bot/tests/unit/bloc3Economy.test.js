'use strict';

// ── Env setup (required by config) ────────────────────────
process.env.AES_SECRET_KEY = 'test_secret_key_32_chars_exactly';
process.env.JWT_SECRET = 'test_jwt_secret';
process.env.DISCORD_TOKEN = 'test_token';
process.env.DISCORD_CLIENT_ID = 'test_client_id';
process.env.GUILD_ID = 'test_guild_id';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
process.env.HTTP_SECRET = 'test_http_secret';

const {
  HP_RETURN_MULTIPLIER,
  HP_BASE_RETURN,
  HP_LOSS_FACTOR,
} = require('../../src/modules/hedgefund/hedgeFundManager');

const {
  SEASON_RULES,
  pickWeekOptions,
} = require('../../src/modules/seasons/seasonManager');

// ════════════════════════════════════════════════════════════
// HEDGE FUND — Return Multiplier Logic
// ════════════════════════════════════════════════════════════
describe('HedgeFundManager — HP Return Multipliers', () => {
  test('HP_RETURN_MULTIPLIER is 1.5 (profit tier)', () => {
    expect(HP_RETURN_MULTIPLIER).toBe(1.5);
  });

  test('HP_BASE_RETURN is 1.0 (break-even tier)', () => {
    expect(HP_BASE_RETURN).toBe(1.0);
  });

  test('HP_LOSS_FACTOR is 0.5 (loss tier)', () => {
    expect(HP_LOSS_FACTOR).toBe(0.5);
  });

  test('return multipliers are in descending order', () => {
    expect(HP_RETURN_MULTIPLIER).toBeGreaterThan(HP_BASE_RETURN);
    expect(HP_BASE_RETURN).toBeGreaterThan(HP_LOSS_FACTOR);
  });

  // Replicate the fund resolution logic for pure unit testing
  function getFundMultiplier(performancePct) {
    if (performancePct >= 0.66) return HP_RETURN_MULTIPLIER;
    if (performancePct >= 0.33) return HP_BASE_RETURN;
    return HP_LOSS_FACTOR;
  }

  test('top fund (>= 66% of max score) gets 1.5x', () => {
    expect(getFundMultiplier(1.0)).toBe(HP_RETURN_MULTIPLIER);
    expect(getFundMultiplier(0.66)).toBe(HP_RETURN_MULTIPLIER);
    expect(getFundMultiplier(0.8)).toBe(HP_RETURN_MULTIPLIER);
  });

  test('middle fund (33-65%) gets 1.0x', () => {
    expect(getFundMultiplier(0.5)).toBe(HP_BASE_RETURN);
    expect(getFundMultiplier(0.33)).toBe(HP_BASE_RETURN);
    expect(getFundMultiplier(0.65)).toBe(HP_BASE_RETURN);
  });

  test('bottom fund (< 33%) gets 0.5x', () => {
    expect(getFundMultiplier(0.0)).toBe(HP_LOSS_FACTOR);
    expect(getFundMultiplier(0.32)).toBe(HP_LOSS_FACTOR);
  });

  test('investor return calculation is correct', () => {
    const invested = 500;
    expect(Math.floor(invested * HP_RETURN_MULTIPLIER)).toBe(750);
    expect(Math.floor(invested * HP_BASE_RETURN)).toBe(500);
    expect(Math.floor(invested * HP_LOSS_FACTOR)).toBe(250);
  });

  test('profit/loss calculation from return', () => {
    const invested = 400;
    const returnProfit = Math.floor(invested * HP_RETURN_MULTIPLIER) - invested;
    const returnNeutral = Math.floor(invested * HP_BASE_RETURN) - invested;
    const returnLoss = Math.floor(invested * HP_LOSS_FACTOR) - invested;

    expect(returnProfit).toBeGreaterThan(0);
    expect(returnNeutral).toBe(0);
    expect(returnLoss).toBeLessThan(0);
  });
});

// ════════════════════════════════════════════════════════════
// HEDGE FUND — HP Validation
// ════════════════════════════════════════════════════════════
describe('HedgeFundManager — HP Validation', () => {
  function validateInvestment(userHp, amount) {
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false, error: 'Amount must be positive integer' };
    if (userHp < amount) return { ok: false, error: 'Insufficient HP' };
    return { ok: true };
  }

  test('valid investment passes', () => {
    expect(validateInvestment(1000, 500).ok).toBe(true);
  });

  test('exact balance investment passes', () => {
    expect(validateInvestment(500, 500).ok).toBe(true);
  });

  test('insufficient HP fails', () => {
    const result = validateInvestment(100, 500);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Insufficient HP');
  });

  test('zero amount fails', () => {
    const result = validateInvestment(1000, 0);
    expect(result.ok).toBe(false);
  });

  test('negative amount fails', () => {
    const result = validateInvestment(1000, -100);
    expect(result.ok).toBe(false);
  });

  test('non-integer amount fails', () => {
    const result = validateInvestment(1000, 50.5);
    expect(result.ok).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
// VOLATILITY SEASONS — Rule Pool
// ════════════════════════════════════════════════════════════
describe('SeasonManager — SEASON_RULES', () => {
  test('exactly 5 season rules are defined', () => {
    expect(Object.keys(SEASON_RULES)).toHaveLength(5);
  });

  test('all rules have label and description', () => {
    for (const [key, rule] of Object.entries(SEASON_RULES)) {
      expect(rule.label).toBeDefined();
      expect(typeof rule.label).toBe('string');
      expect(rule.label.length).toBeGreaterThan(0);
      expect(rule.description).toBeDefined();
      expect(typeof rule.description).toBe('string');
      expect(rule.description.length).toBeGreaterThan(0);
    }
  });

  test('all expected rule types exist', () => {
    const expected = [
      'forex_majors_only',
      'max_trades_per_day',
      'no_news_trades',
      'long_only',
      'max_leverage',
    ];
    for (const key of expected) {
      expect(SEASON_RULES[key]).toBeDefined();
    }
  });

  test('max_trades_per_day has numeric param', () => {
    const rule = SEASON_RULES['max_trades_per_day'];
    expect(rule.param).toBeDefined();
    expect(typeof rule.param.max_trades).toBe('number');
    expect(rule.param.max_trades).toBeGreaterThan(0);
  });

  test('max_leverage has numeric param', () => {
    const rule = SEASON_RULES['max_leverage'];
    expect(rule.param).toBeDefined();
    expect(typeof rule.param.max_leverage).toBe('number');
    expect(rule.param.max_leverage).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════
// VOLATILITY SEASONS — pickWeekOptions
// ════════════════════════════════════════════════════════════
describe('SeasonManager — pickWeekOptions', () => {
  test('always returns exactly 3 options', () => {
    expect(pickWeekOptions(1, 2026)).toHaveLength(3);
    expect(pickWeekOptions(26, 2026)).toHaveLength(3);
    expect(pickWeekOptions(52, 2025)).toHaveLength(3);
  });

  test('all returned options are valid rule keys', () => {
    const validKeys = Object.keys(SEASON_RULES);
    const options = pickWeekOptions(12, 2026);
    for (const key of options) {
      expect(validKeys).toContain(key);
    }
  });

  test('no duplicate options in the same week', () => {
    const options = pickWeekOptions(8, 2026);
    const unique = new Set(options);
    expect(unique.size).toBe(3);
  });

  test('same week always returns same options (deterministic)', () => {
    const run1 = pickWeekOptions(20, 2026);
    const run2 = pickWeekOptions(20, 2026);
    expect(run1).toEqual(run2);
  });

  test('different weeks produce different option sets', () => {
    const w1 = pickWeekOptions(1, 2026);
    const w2 = pickWeekOptions(25, 2026);
    // May occasionally be same by chance — test at least one differs over multiple weeks
    let allSame = true;
    for (let w = 1; w <= 10; w++) {
      const options = pickWeekOptions(w, 2026);
      if (JSON.stringify(options) !== JSON.stringify(w1)) {
        allSame = false;
        break;
      }
    }
    expect(allSame).toBe(false);
  });

  test('works for edge cases (week 52, week 1)', () => {
    expect(() => pickWeekOptions(52, 2025)).not.toThrow();
    expect(() => pickWeekOptions(1, 2026)).not.toThrow();
    expect(pickWeekOptions(52, 2025)).toHaveLength(3);
    expect(pickWeekOptions(1, 2026)).toHaveLength(3);
  });
});

// ════════════════════════════════════════════════════════════
// SHOP — Boost Type Validation
// ════════════════════════════════════════════════════════════
describe('ShopManager — Boost Logic', () => {
  const VALID_BOOST_TYPES = [
    'max_daily_loss',
    'score_multiplier',
    'relegate_immunity',
    'reset_drawdown',
    'battle_priority',
  ];

  const SHOP_ITEMS = {
    max_daily_loss:    { cost_hp: 500,  duration_hours: 168 },
    score_multiplier:  { cost_hp: 800,  duration_hours: 24  },
    relegate_immunity: { cost_hp: 1200, duration_hours: 168 },
    reset_drawdown:    { cost_hp: 600,  duration_hours: null },
    battle_priority:   { cost_hp: 300,  duration_hours: null },
  };

  test('all 5 boost types are defined in shop', () => {
    expect(Object.keys(SHOP_ITEMS)).toHaveLength(5);
    for (const t of VALID_BOOST_TYPES) {
      expect(SHOP_ITEMS[t]).toBeDefined();
    }
  });

  test('all boosts have positive cost_hp', () => {
    for (const item of Object.values(SHOP_ITEMS)) {
      expect(item.cost_hp).toBeGreaterThan(0);
    }
  });

  test('timed boosts have positive duration_hours', () => {
    for (const [key, item] of Object.entries(SHOP_ITEMS)) {
      if (item.duration_hours !== null) {
        expect(item.duration_hours).toBeGreaterThan(0);
      }
    }
  });

  test('score_multiplier lasts 24h (one day)', () => {
    expect(SHOP_ITEMS['score_multiplier'].duration_hours).toBe(24);
  });

  test('relegate_immunity lasts a week (168h)', () => {
    expect(SHOP_ITEMS['relegate_immunity'].duration_hours).toBe(168);
  });

  test('one-time boosts have null duration', () => {
    expect(SHOP_ITEMS['reset_drawdown'].duration_hours).toBeNull();
    expect(SHOP_ITEMS['battle_priority'].duration_hours).toBeNull();
  });

  test('user has enough HP — affordability check', () => {
    function canAfford(userHp, itemCost) {
      return userHp >= itemCost;
    }
    expect(canAfford(1000, 800)).toBe(true);
    expect(canAfford(799, 800)).toBe(false);
    expect(canAfford(800, 800)).toBe(true);
    expect(canAfford(0, 300)).toBe(false);
  });

  test('HP deducted correctly on purchase', () => {
    const userHp = 1000;
    const cost = SHOP_ITEMS['score_multiplier'].cost_hp;
    const remaining = userHp - cost;
    expect(remaining).toBe(200);
    expect(remaining).toBeGreaterThanOrEqual(0);
  });

  test('boost expires_at is set correctly for timed boosts', () => {
    const now = Date.now();
    const durationHours = SHOP_ITEMS['score_multiplier'].duration_hours;
    const expiresAt = new Date(now + durationHours * 3600 * 1000);
    const diffHours = (expiresAt.getTime() - now) / (1000 * 3600);
    expect(diffHours).toBeCloseTo(24, 0);
  });
});

// ════════════════════════════════════════════════════════════
// FUND — Performance Thresholds
// ════════════════════════════════════════════════════════════
describe('HedgeFundManager — Performance Thresholds', () => {
  // Test the boundary conditions for fund tiers
  const thresholds = [
    { pct: 1.00, expected: 1.5, label: '100% of max → profit tier' },
    { pct: 0.66, expected: 1.5, label: '66% of max → profit tier (boundary)' },
    { pct: 0.65, expected: 1.0, label: '65% of max → neutral tier' },
    { pct: 0.33, expected: 1.0, label: '33% of max → neutral tier (boundary)' },
    { pct: 0.32, expected: 0.5, label: '32% of max → loss tier' },
    { pct: 0.00, expected: 0.5, label: '0% of max → loss tier' },
  ];

  function getMultiplier(pct) {
    if (pct >= 0.66) return HP_RETURN_MULTIPLIER;
    if (pct >= 0.33) return HP_BASE_RETURN;
    return HP_LOSS_FACTOR;
  }

  for (const { pct, expected, label } of thresholds) {
    test(label, () => {
      expect(getMultiplier(pct)).toBe(expected);
    });
  }
});
