-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- Trading Competition Bot — Bloc 2 Migration
-- Migration 002 — Battle Engine Enhancements
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

BEGIN;

-- ── Add 'expired' status for auto-cancelled battles ───────
ALTER TYPE battle_status ADD VALUE IF NOT EXISTS 'expired';

-- ── Additional indexes for battle queries ─────────────────
CREATE INDEX IF NOT EXISTS idx_battles_lobby_code
  ON battles(lobby_code);

CREATE INDEX IF NOT EXISTS idx_battles_creator
  ON battles(creator_id);

CREATE INDEX IF NOT EXISTS idx_battle_participants_team
  ON battle_participants(battle_id, team);

-- ── Add score_delta column if missing ─────────────────────
-- (already in schema but ensure exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='battle_participants' AND column_name='score_delta'
  ) THEN
    ALTER TABLE battle_participants ADD COLUMN score_delta NUMERIC(10,4);
  END IF;
END $$;

-- ── View: active battle summary (useful for admin) ─────────
CREATE OR REPLACE VIEW v_active_battles AS
SELECT
  b.id,
  b.lobby_code,
  b.type,
  b.status,
  b.started_at,
  b.ends_at,
  b.duration_hours,
  b.winning_team,
  COUNT(bp.id) AS participant_count,
  u.username AS creator_name
FROM battles b
JOIN users u ON u.id = b.creator_id
LEFT JOIN battle_participants bp ON bp.battle_id = b.id
WHERE b.status IN ('open', 'active')
GROUP BY b.id, u.username
ORDER BY b.created_at DESC;

-- ── View: user battle stats ────────────────────────────────
CREATE OR REPLACE VIEW v_user_battle_stats AS
SELECT
  u.id AS user_id,
  u.username,
  u.total_battles,
  u.battles_won,
  CASE WHEN u.total_battles > 0
       THEN ROUND(u.battles_won::numeric / u.total_battles * 100, 1)
       ELSE 0
  END AS win_rate_pct,
  COALESCE(SUM(hp.amount) FILTER (WHERE hp.reason = 'battle_win'), 0) AS total_hp_from_battles
FROM users u
LEFT JOIN hp_transactions hp ON hp.user_id = u.id
GROUP BY u.id, u.username, u.total_battles, u.battles_won;

COMMIT;
