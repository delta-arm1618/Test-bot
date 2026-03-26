-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- Trading Competition Bot — Initial Schema
-- Migration 001 — Foundation
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

BEGIN;

-- ── Extensions ────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Enum Types ────────────────────────────────────────────
CREATE TYPE tier_name AS ENUM ('bronze', 'silver', 'gold', 'platinum', 'diamond', 'apex');
CREATE TYPE broker_type AS ENUM ('mt4', 'mt5', 'ctrader', 'tradovate', 'manual');
CREATE TYPE account_status AS ENUM ('pending', 'active', 'disconnected', 'suspended');
CREATE TYPE battle_type AS ENUM ('1v1', '3v3');
CREATE TYPE battle_status AS ENUM ('open', 'active', 'completed', 'cancelled', 'expired');
CREATE TYPE invite_status AS ENUM ('pending', 'active', 'expired');
CREATE TYPE boost_type AS ENUM ('max_daily_loss', 'score_multiplier', 'relegate_immunity', 'reset_drawdown', 'battle_priority');
CREATE TYPE season_rule_type AS ENUM ('forex_majors_only', 'max_trades_per_day', 'no_news_trades', 'long_only', 'max_leverage');

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- CORE TABLES
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- ── Users ─────────────────────────────────────────────────
CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  discord_id       VARCHAR(20) UNIQUE NOT NULL,
  username         VARCHAR(100) NOT NULL,
  discriminator    VARCHAR(10),
  avatar_url       TEXT,
  tier             tier_name NOT NULL DEFAULT 'bronze',
  is_verified      BOOLEAN NOT NULL DEFAULT FALSE,        -- passed invite gate
  is_admin         BOOLEAN NOT NULL DEFAULT FALSE,
  hedge_points     INTEGER NOT NULL DEFAULT 0 CHECK (hedge_points >= 0),
  best_rank_ever   INTEGER,
  total_battles    INTEGER NOT NULL DEFAULT 0,
  battles_won      INTEGER NOT NULL DEFAULT 0,
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_discord_id ON users(discord_id);
CREATE INDEX idx_users_tier ON users(tier);
CREATE INDEX idx_users_is_verified ON users(is_verified);

-- ── Broker Accounts ───────────────────────────────────────
CREATE TABLE broker_accounts (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker            broker_type NOT NULL,
  account_id        VARCHAR(100) NOT NULL,               -- broker's account ID
  metaapi_id        VARCHAR(100),                        -- MetaApi account ID if MT4/MT5
  credentials_enc   TEXT,                                -- AES-256 encrypted token/password
  server            VARCHAR(100),                        -- MT4/MT5 server name
  status            account_status NOT NULL DEFAULT 'pending',
  last_polled_at    TIMESTAMPTZ,
  last_error        TEXT,
  error_count       INTEGER NOT NULL DEFAULT 0,
  is_primary        BOOLEAN NOT NULL DEFAULT FALSE,       -- main account used for scoring
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, account_id, broker)
);

CREATE INDEX idx_broker_accounts_user_id ON broker_accounts(user_id);
CREATE INDEX idx_broker_accounts_status ON broker_accounts(status);

-- ── Weekly Score Snapshots ────────────────────────────────
-- One row per user per week — updated throughout the week, archived on reset
CREATE TABLE weekly_scores (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_number      INTEGER NOT NULL,                     -- ISO week number
  year             INTEGER NOT NULL,
  tier             tier_name NOT NULL,
  score            NUMERIC(10,4) NOT NULL DEFAULT 0,
  -- Raw metrics
  pnl_pct          NUMERIC(10,4) NOT NULL DEFAULT 0,     -- PnL as percent (e.g. 5.3 = 5.3%)
  win_rate         NUMERIC(5,4) NOT NULL DEFAULT 0,       -- 0.0 to 1.0
  max_drawdown     NUMERIC(5,4) NOT NULL DEFAULT 0,       -- 0.0 to 1.0
  consistency      NUMERIC(5,4) NOT NULL DEFAULT 0,       -- 0.0 to 1.0
  profit_factor    NUMERIC(8,4),
  sharpe_ratio     NUMERIC(8,4),
  avg_rrr          NUMERIC(8,4),
  streak           INTEGER NOT NULL DEFAULT 0,
  total_trades     INTEGER NOT NULL DEFAULT 0,
  -- Applied boosts
  score_multiplier NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  relegate_immune  BOOLEAN NOT NULL DEFAULT FALSE,
  -- Computed timestamps
  is_archived      BOOLEAN NOT NULL DEFAULT FALSE,       -- TRUE after weekly reset
  promoted         BOOLEAN,                              -- TRUE/FALSE set on reset
  relegated        BOOLEAN,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, week_number, year)
);

CREATE INDEX idx_weekly_scores_week ON weekly_scores(week_number, year);
CREATE INDEX idx_weekly_scores_user ON weekly_scores(user_id);
CREATE INDEX idx_weekly_scores_score ON weekly_scores(score DESC);

-- ── Trade History ─────────────────────────────────────────
-- Individual trades pulled from broker API
CREATE TABLE trades (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id        UUID NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
  broker_trade_id   VARCHAR(100) NOT NULL,               -- Broker's own trade ID
  symbol            VARCHAR(20) NOT NULL,
  direction         VARCHAR(10),                         -- 'buy' or 'sell'
  open_time         TIMESTAMPTZ NOT NULL,
  close_time        TIMESTAMPTZ,
  open_price        NUMERIC(12,5),
  close_price       NUMERIC(12,5),
  volume            NUMERIC(12,5),
  profit            NUMERIC(12,5),                       -- in account currency
  profit_pct        NUMERIC(10,4),                       -- as percent of balance
  swap              NUMERIC(12,5),
  commission        NUMERIC(12,5),
  leverage          NUMERIC(10,2),
  is_open           BOOLEAN NOT NULL DEFAULT FALSE,
  is_season_valid   BOOLEAN NOT NULL DEFAULT TRUE,       -- passes current season rule
  season_rule       VARCHAR(50),                         -- which rule was active
  week_number       INTEGER,
  year              INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, broker_trade_id)
);

CREATE INDEX idx_trades_account_id ON trades(account_id);
CREATE INDEX idx_trades_week ON trades(week_number, year);
CREATE INDEX idx_trades_open_time ON trades(open_time DESC);

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- INVITE GATE TABLES
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CREATE TABLE invite_codes (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code             VARCHAR(20) UNIQUE NOT NULL,          -- Discord invite code
  discord_url      TEXT,                                 -- Full invite URL
  uses_count       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ                           -- NULL = no expiry
);

CREATE INDEX idx_invite_codes_user_id ON invite_codes(user_id);
CREATE INDEX idx_invite_codes_code ON invite_codes(code);

CREATE TABLE invite_uses (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  inviter_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code             VARCHAR(20) NOT NULL,
  status           invite_status NOT NULL DEFAULT 'pending',
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at     TIMESTAMPTZ,                          -- when 24h elapsed
  hp_awarded       INTEGER NOT NULL DEFAULT 0,
  UNIQUE(invitee_id)                                     -- each user was invited by one person
);

CREATE INDEX idx_invite_uses_inviter ON invite_uses(inviter_id);
CREATE INDEX idx_invite_uses_status ON invite_uses(status);

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- BATTLES TABLES
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CREATE TABLE battles (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type             battle_type NOT NULL,
  lobby_code       VARCHAR(8) UNIQUE NOT NULL,           -- Short shareable code
  status           battle_status NOT NULL DEFAULT 'open',
  creator_id       UUID NOT NULL REFERENCES users(id),
  started_at       TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ NOT NULL,
  duration_hours   INTEGER NOT NULL,
  winning_team     INTEGER,                              -- 1 or 2 for 3v3, NULL for ongoing
  winner_id        UUID REFERENCES users(id),            -- for 1v1
  hp_pool          INTEGER NOT NULL DEFAULT 0,           -- HP wagered on this battle
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_battles_status ON battles(status);
CREATE INDEX idx_battles_ends_at ON battles(ends_at);

CREATE TABLE battle_participants (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  battle_id        UUID NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id),
  team             INTEGER NOT NULL CHECK (team IN (1, 2)),  -- team 1 or 2
  is_captain       BOOLEAN NOT NULL DEFAULT FALSE,
  score_at_start   NUMERIC(10,4) NOT NULL DEFAULT 0,     -- snapshot of score at battle start
  score_at_end     NUMERIC(10,4),
  score_delta      NUMERIC(10,4),                        -- performance during battle
  rank_at_join     tier_name NOT NULL,                   -- tier when they joined (affects 3v3 weight)
  hp_bet           INTEGER NOT NULL DEFAULT 0,
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(battle_id, user_id)
);

CREATE INDEX idx_battle_participants_battle ON battle_participants(battle_id);
CREATE INDEX idx_battle_participants_user ON battle_participants(user_id);

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- HEDGE FUND & ECONOMY TABLES
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CREATE TABLE hp_transactions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount           INTEGER NOT NULL,                     -- positive = gain, negative = spend
  balance_after    INTEGER NOT NULL,
  reason           VARCHAR(100) NOT NULL,                -- 'invite_bonus', 'battle_win', 'shop_purchase', etc.
  reference_id     UUID,                                 -- e.g. battle_id, invite_use_id
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_hp_transactions_user ON hp_transactions(user_id);
CREATE INDEX idx_hp_transactions_created ON hp_transactions(created_at DESC);

CREATE TABLE hedge_funds (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  week_number      INTEGER NOT NULL,
  year             INTEGER NOT NULL,
  trader_1_id      UUID REFERENCES users(id),
  trader_2_id      UUID REFERENCES users(id),
  trader_3_id      UUID REFERENCES users(id),
  total_invested   INTEGER NOT NULL DEFAULT 0,           -- total HP invested by community
  performance_pct  NUMERIC(8,4),                        -- fund's perf at end of week
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ,
  UNIQUE(week_number, year)
);

CREATE TABLE fund_investments (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fund_id          UUID NOT NULL REFERENCES hedge_funds(id),
  user_id          UUID NOT NULL REFERENCES users(id),
  amount_hp        INTEGER NOT NULL CHECK (amount_hp > 0),
  return_hp        INTEGER,                              -- filled after fund resolves
  invested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(fund_id, user_id)
);

CREATE TABLE shop_items (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  boost_type       boost_type UNIQUE NOT NULL,
  name             VARCHAR(100) NOT NULL,
  description      TEXT NOT NULL,
  cost_hp          INTEGER NOT NULL CHECK (cost_hp > 0),
  duration_hours   INTEGER,                             -- NULL = one-time use
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE user_boosts (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  boost_type       boost_type NOT NULL,
  week_number      INTEGER,                              -- NULL = not week-bound
  year             INTEGER,
  expires_at       TIMESTAMPTZ,
  used_at          TIMESTAMPTZ,                          -- for one-time boosts
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_boosts_user ON user_boosts(user_id, is_active);

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- VOLATILITY SEASONS TABLE
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CREATE TABLE seasons (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  week_number      INTEGER NOT NULL,
  year             INTEGER NOT NULL,
  rule_type        season_rule_type NOT NULL,
  rule_description TEXT NOT NULL,
  rule_param       JSONB,                               -- e.g. {"max_trades": 2}
  vote_option_a    TEXT,
  vote_option_b    TEXT,
  vote_option_c    TEXT,
  votes_a          INTEGER NOT NULL DEFAULT 0,
  votes_b          INTEGER NOT NULL DEFAULT 0,
  votes_c          INTEGER NOT NULL DEFAULT 0,
  vote_message_id  VARCHAR(20),                         -- Discord message ID for vote
  is_active        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at     TIMESTAMPTZ,
  UNIQUE(week_number, year)
);

-- ── Manual Screenshot Submissions ────────────────────────
CREATE TABLE manual_submissions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES users(id),
  image_url        TEXT NOT NULL,
  submitted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at      TIMESTAMPTZ,
  reviewer_id      UUID REFERENCES users(id),
  approved         BOOLEAN,
  rejection_reason TEXT,
  week_number      INTEGER,
  year             INTEGER
);

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- SEEDED DATA
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- Shop items (canonical, matches config)
INSERT INTO shop_items (boost_type, name, description, cost_hp, duration_hours) VALUES
  ('max_daily_loss',    '+1% Max Daily Loss',      'Extends your daily loss limit by 1% for one week.',           500,  168),
  ('score_multiplier',  'Score Multiplier x1.1',   'Multiplies your composite score by 1.1 for one day.',         800,  24),
  ('relegate_immunity', 'Relegation Immunity',      'Protects you from tier relegation for one week.',            1200, 168),
  ('reset_drawdown',    'Drawdown Reset',           'Resets your max drawdown counter (one-time use).',           600,  NULL),
  ('battle_priority',   'Battle Priority Slot',     'Gives you priority matchmaking in the next battle.',         300,  NULL);

-- ── Triggers: updated_at auto-update ─────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at         BEFORE UPDATE ON users          FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_broker_updated_at        BEFORE UPDATE ON broker_accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_weekly_scores_updated_at BEFORE UPDATE ON weekly_scores   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_battles_updated_at       BEFORE UPDATE ON battles         FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMIT;
