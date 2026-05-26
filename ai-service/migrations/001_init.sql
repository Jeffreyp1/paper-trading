-- ai-service migration 001: initial AI tables.
-- Idempotent. Does NOT modify any pre-existing tables.

BEGIN;

-- Strategy registry. Each row is a strategy + its configured guardrails and mode.
CREATE TABLE IF NOT EXISTS ai_strategies (
    id              TEXT            PRIMARY KEY,
    name            TEXT            NOT NULL,
    description     TEXT,
    mode            TEXT            NOT NULL DEFAULT 'suggest'
                                    CHECK (mode IN ('suggest','auto')),
    -- Guardrails (server-side only)
    max_position_qty            INT             NOT NULL DEFAULT 100,
    max_daily_notional          NUMERIC(14,2)   NOT NULL DEFAULT 5000.00,
    max_drawdown_pct            NUMERIC(6,4)    NOT NULL DEFAULT 0.15,
    cooldown_seconds            INT             NOT NULL DEFAULT 300,
    -- Operational state
    enabled         BOOLEAN         NOT NULL DEFAULT TRUE,
    drawdown_tripped BOOLEAN        NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Raw signal scores produced by a strategy run (one row per (strategy, symbol, ts)).
CREATE TABLE IF NOT EXISTS signals (
    id              BIGSERIAL       PRIMARY KEY,
    strategy_id     TEXT            NOT NULL REFERENCES ai_strategies(id) ON DELETE CASCADE,
    model_version   TEXT            NOT NULL,
    symbol          VARCHAR(20)     NOT NULL,
    score           NUMERIC(8,6)    NOT NULL,
    direction       TEXT            NOT NULL CHECK (direction IN ('BUY','SELL','HOLD')),
    features_json   JSONB           NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_signals_strategy_created ON signals(strategy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_symbol_created   ON signals(symbol, created_at DESC);

-- Recommendations: a sized, actionable instruction derived from a signal.
CREATE TABLE IF NOT EXISTS recommendations (
    id              BIGSERIAL       PRIMARY KEY,
    strategy_id     TEXT            NOT NULL REFERENCES ai_strategies(id) ON DELETE CASCADE,
    signal_id       BIGINT          REFERENCES signals(id) ON DELETE SET NULL,
    user_id         INT,
    symbol          VARCHAR(20)     NOT NULL,
    action          TEXT            NOT NULL CHECK (action IN ('BUY','SELL','HOLD')),
    quantity        INT             NOT NULL,
    price_hint      NUMERIC(12,4),
    rationale       TEXT,
    client_order_id TEXT            UNIQUE,
    -- Lifecycle
    status          TEXT            NOT NULL DEFAULT 'PENDING'
                                    CHECK (status IN ('PENDING','SUGGESTED','EXECUTED','REJECTED','FAILED','SKIPPED')),
    rejection_reason TEXT,
    executed_at     TIMESTAMP,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_recs_strategy_created ON recommendations(strategy_id, created_at DESC);

-- Run history of a strategy (one row per /run invocation or scheduled tick).
CREATE TABLE IF NOT EXISTS ai_runs (
    id              BIGSERIAL       PRIMARY KEY,
    strategy_id     TEXT            NOT NULL REFERENCES ai_strategies(id) ON DELETE CASCADE,
    started_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at     TIMESTAMP,
    status          TEXT            NOT NULL DEFAULT 'RUNNING'
                                    CHECK (status IN ('RUNNING','OK','ERROR')),
    signals_emitted INT             NOT NULL DEFAULT 0,
    recs_emitted    INT             NOT NULL DEFAULT 0,
    notes           TEXT
);

-- Append-only audit. Every guardrail decision (accept/reject/killswitch/breach) lands here.
CREATE TABLE IF NOT EXISTS ai_audit (
    id              BIGSERIAL       PRIMARY KEY,
    strategy_id     TEXT,
    recommendation_id BIGINT,
    event_type      TEXT            NOT NULL,
    payload         JSONB           NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_strategy_created ON ai_audit(strategy_id, created_at DESC);

-- Global KV (kill switch lives here under key 'killswitch').
CREATE TABLE IF NOT EXISTS ai_global_state (
    key             TEXT            PRIMARY KEY,
    value           JSONB           NOT NULL,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO ai_global_state(key, value) VALUES
    ('killswitch', '{"engaged": false}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Default baseline strategy.
INSERT INTO ai_strategies(id, name, description, mode)
VALUES ('momentum_v1',
        'Momentum v1 (LightGBM baseline)',
        'Daily momentum signal: LightGBM trained on synthetic OHLCV; produces BUY/SELL/HOLD scores per symbol.',
        'suggest')
ON CONFLICT (id) DO NOTHING;

COMMIT;
