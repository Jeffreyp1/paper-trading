-- bench_trade_history.sql
--
-- Usage:
--   docker compose exec postgres psql -U $DB_USER -d $DB_DATABASE -f /path/to/bench_trade_history.sql
--
-- Or from the host (requires psql installed locally and .env values substituted):
--   psql "host=$DB_HOST port=$DB_PORT user=$DB_USER dbname=$DB_DATABASE password=$DB_PASSWORD" \
--       -f scripts/bench_trade_history.sql
--
-- What this script does:
--   1. Creates an isolated scratch table `trades_bench` (no FK constraints).
--   2. Seeds 1,000,000 rows; user_id=42 owns ~10,000 of them scattered through the set.
--   3. Runs EXPLAIN (ANALYZE, BUFFERS) for the hot trade-history query — BEFORE any index.
--   4. Adds the composite index  (user_id, created_at DESC).
--   5. Runs the same EXPLAIN again — AFTER the index.
--   6. ROLLBACKs everything so no scratch data is left behind.
--
-- Compare the "before" and "after" EXPLAIN ANALYZE outputs.
-- Expect 10x–100x speedup and Seq Scan → Index Scan on the post-index plan.
--
-- NOTE: The 1 M-row insert can take 20–60 s on a laptop.  Run with \timing on for wall-clock.

\timing on

BEGIN;

-- -----------------------------------------------------------------------
-- 1. Scratch table — same shape as `trades`, foreign key intentionally
--    omitted so we can seed without real users.
-- -----------------------------------------------------------------------
DROP TABLE IF EXISTS trades_bench;

CREATE TABLE trades_bench (
    id              SERIAL          PRIMARY KEY,
    user_id         INT             NOT NULL,
    symbol          VARCHAR(20)     NOT NULL,
    trade_type      VARCHAR(10)     NOT NULL DEFAULT 'BUY',
    executed_price  NUMERIC(12,2)   NOT NULL,
    quantity        INT             NOT NULL,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------------------
-- 2. Seed 1,000,000 rows.
--    Every 100th row belongs to user_id = 42  → ~10,000 rows for user 42.
--    All other rows are distributed across user_ids 1–10000.
--    created_at is spread over the past ~11.5 days (one second per row).
-- -----------------------------------------------------------------------
INSERT INTO trades_bench (user_id, symbol, trade_type, executed_price, quantity, created_at)
SELECT
    (CASE WHEN g % 100 = 0 THEN 42 ELSE (g % 10000) + 1 END),
    'AAPL',
    'BUY',
    ROUND((100 + (random() * 50))::numeric, 2),
    (random() * 100)::int + 1,
    NOW() - (g || ' seconds')::interval
FROM generate_series(1, 1000000) g;

-- -----------------------------------------------------------------------
-- 3. Refresh planner statistics on the fresh data.
-- -----------------------------------------------------------------------
ANALYZE trades_bench;

-- -----------------------------------------------------------------------
-- 4. BEFORE measurement — no index on (user_id, created_at).
--    The planner should choose a Sequential Scan.
-- -----------------------------------------------------------------------
\echo ''
\echo '===== BEFORE (no index) ====='
\echo ''

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT *
FROM   trades_bench
WHERE  user_id = 42
ORDER  BY created_at DESC
LIMIT  50;

-- -----------------------------------------------------------------------
-- 5. Create the composite index mirroring the production recommendation.
-- -----------------------------------------------------------------------
CREATE INDEX idx_trades_bench_user_created
    ON trades_bench(user_id, created_at DESC);

ANALYZE trades_bench;

-- -----------------------------------------------------------------------
-- 6. AFTER measurement — planner should now choose an Index Scan /
--    Index Only Scan and avoid touching the bulk of the heap.
-- -----------------------------------------------------------------------
\echo ''
\echo '===== AFTER (with index idx_trades_bench_user_created) ====='
\echo ''

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT *
FROM   trades_bench
WHERE  user_id = 42
ORDER  BY created_at DESC
LIMIT  50;

-- -----------------------------------------------------------------------
-- 7. Clean up — leave no trace.
-- -----------------------------------------------------------------------
ROLLBACK;

\echo ''
\echo 'Benchmark complete. Transaction rolled back; no scratch data persists.'
