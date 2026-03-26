-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- Trading Competition Bot — Bloc 3 Migration
-- Migration 003 — Hedge Fund Mode, Boutique HP, Volatility Seasons
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

BEGIN;

-- ── Additional indexes for fund queries ───────────────────
CREATE INDEX IF NOT EXISTS idx_fund_investments_fund
  ON fund_investments(fund_id);

CREATE INDEX IF NOT EXISTS idx_fund_investments_user
  ON fund_investments(user_id);

CREATE INDEX IF NOT EXISTS idx_hedge_funds_week
  ON hedge_funds(week_number, year);

CREATE INDEX IF NOT EXISTS idx_hedge_funds_active
  ON hedge_funds(is_active);

CREATE INDEX IF NOT EXISTS idx_seasons_week
  ON seasons(week_number, year);

CREATE INDEX IF NOT EXISTS idx_seasons_active
  ON seasons(is_active);

CREATE INDEX IF NOT EXISTS idx_user_boosts_expires
  ON user_boosts(expires_at) WHERE is_active = TRUE;

-- ── Ensure fund_investments has return_hp column ──────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'fund_investments' AND column_name = 'return_hp'
  ) THEN
    ALTER TABLE fund_investments ADD COLUMN return_hp INTEGER;
  END IF;
END $$;

-- ── Add performance_pct to hedge_funds if missing ─────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'hedge_funds' AND column_name = 'performance_pct'
  ) THEN
    ALTER TABLE hedge_funds ADD COLUMN performance_pct NUMERIC(8,4);
  END IF;
END $$;

-- ── Ensure seasons has all vote columns ───────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seasons' AND column_name = 'vote_option_a'
  ) THEN
    ALTER TABLE seasons ADD COLUMN vote_option_a TEXT;
    ALTER TABLE seasons ADD COLUMN vote_option_b TEXT;
    ALTER TABLE seasons ADD COLUMN vote_option_c TEXT;
  END IF;
END $$;

-- ── View: fund performance summary ───────────────────────
CREATE OR REPLACE VIEW v_fund_performance AS
SELECT
  hf.id AS fund_id,
  hf.week_number,
  hf.year,
  hf.is_active,
  hf.performance_pct,
  hf.total_invested,
  hf.resolved_at,
  u1.username AS trader_1_name,
  u2.username AS trader_2_name,
  u3.username AS trader_3_name,
  COUNT(fi.id) AS investor_count,
  COALESCE(SUM(fi.amount_hp), 0) AS total_hp_in,
  COALESCE(SUM(fi.return_hp), 0) AS total_hp_out
FROM hedge_funds hf
LEFT JOIN users u1 ON u1.id = hf.trader_1_id
LEFT JOIN users u2 ON u2.id = hf.trader_2_id
LEFT JOIN users u3 ON u3.id = hf.trader_3_id
LEFT JOIN fund_investments fi ON fi.fund_id = hf.id
GROUP BY hf.id, u1.username, u2.username, u3.username;

-- ── View: user economy overview ───────────────────────────
CREATE OR REPLACE VIEW v_user_economy AS
SELECT
  u.id,
  u.discord_id,
  u.username,
  u.hedge_points AS current_hp,
  COALESCE(inv.total_invested, 0) AS total_invested_ever,
  COALESCE(inv.total_returned, 0) AS total_returned_ever,
  COALESCE(inv.total_returned, 0) - COALESCE(inv.total_invested, 0) AS net_fund_profit,
  COALESCE(inv_active.active_invested, 0) AS hp_currently_in_funds,
  COALESCE(boosts.active_boosts, 0) AS active_boost_count
FROM users u
LEFT JOIN (
  SELECT fi.user_id,
         SUM(fi.amount_hp) AS total_invested,
         SUM(COALESCE(fi.return_hp, 0)) AS total_returned
  FROM fund_investments fi
  GROUP BY fi.user_id
) inv ON inv.user_id = u.id
LEFT JOIN (
  SELECT fi.user_id,
         SUM(fi.amount_hp) AS active_invested
  FROM fund_investments fi
  JOIN hedge_funds hf ON hf.id = fi.fund_id
  WHERE hf.is_active = TRUE AND fi.return_hp IS NULL
  GROUP BY fi.user_id
) inv_active ON inv_active.user_id = u.id
LEFT JOIN (
  SELECT user_id,
         COUNT(*) AS active_boosts
  FROM user_boosts
  WHERE is_active = TRUE
    AND (expires_at IS NULL OR expires_at > NOW())
    AND used_at IS NULL
  GROUP BY user_id
) boosts ON boosts.user_id = u.id;

-- ── View: current season active rule ─────────────────────
CREATE OR REPLACE VIEW v_current_season AS
SELECT s.*
FROM seasons s
WHERE s.is_active = TRUE
ORDER BY s.week_number DESC, s.year DESC
LIMIT 1;

-- ── Trigger: updated_at for fund-related tables ───────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_hedge_funds_updated_at'
  ) THEN
    CREATE TRIGGER trg_hedge_funds_updated_at
      BEFORE UPDATE ON hedge_funds
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

-- ── Admin helper: get all pending manual submissions with details ─
CREATE OR REPLACE VIEW v_pending_submissions AS
SELECT
  ms.id,
  ms.image_url,
  ms.submitted_at,
  ms.week_number,
  ms.year,
  u.username,
  u.discord_id,
  u.tier
FROM manual_submissions ms
JOIN users u ON u.id = ms.user_id
WHERE ms.approved IS NULL
ORDER BY ms.submitted_at ASC;

COMMIT;
