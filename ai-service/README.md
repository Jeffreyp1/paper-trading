# ai-service

Python AI trading service for the paper-trading app. Provides:

- One LightGBM-backed baseline strategy (`momentum_v1`) end-to-end.
- Two modes per `ai-component-constraints.md`:
  - `suggest` (default): writes a row to `recommendations` and emits the signal on Kafka. **No** trade is placed.
  - `auto` (opt-in per strategy): places a paper trade against the Node API at `POST /api/v1/trading/trade`, but only if every server-side guardrail passes.
- Server-side guardrails: `max_position_qty`, `max_daily_notional`, `max_drawdown_pct`, `cooldown_seconds`, per-strategy enabled flag, `drawdown_tripped` lockout, and a global kill switch.
- Idempotency: every auto-executed trade carries `client_order_id = ai-<strategy>-sha256(strategy|symbol|ts)[:24]`. Re-runs with the same id do not duplicate the recommendation row (UNIQUE constraint).

## Run with Docker Compose

The root `docker-compose.yml` now defines an `ai-service` service. To bring up the full stack (Postgres, Redis, Kafka, the AI service):

```
docker compose -f /Users/jeffrey/paper-trading/docker-compose.yml -f /Users/jeffrey/paper-trading/trading-service/docker-compose.yml up -d postgres redis ai-service
docker compose -f /Users/jeffrey/paper-trading/trading-service/docker-compose.yml up -d kafka zookeeper
```

(The Kafka broker still lives in `trading-service/docker-compose.yml`. The AI service tolerates Kafka being absent — produces become no-ops.)

## API

| Method | Path                                  | Purpose                                                                |
|--------|----------------------------------------|-------------------------------------------------------------------------|
| GET    | `/health`                              | liveness + DB + killswitch state + strategy count                       |
| GET    | `/strategies`                          | list all strategies with mode + guardrails                              |
| POST   | `/strategies/{id}/mode`                | switch a strategy between `suggest` and `auto`                          |
| POST   | `/strategies/{id}/limits`              | update one or more guardrail values                                     |
| POST   | `/strategies/{id}/run`                 | generate a recommendation now; auto-executes if mode is `auto`          |
| GET    | `/recommendations?strategy_id=&limit=` | list recommendations (newest first)                                     |
| POST   | `/killswitch`                          | engage the global kill switch (rejects every auto-execute attempt)      |
| POST   | `/killswitch/clear`                    | clear the kill switch                                                   |

## Kafka topics

- **Produces** `ai_signals` — one message per signal scored. Payload: `{strategy_id, signal_id, symbol, score, direction, model_version, features, ts}`.
- **Produces** `ai_audit` — currently audit events also go to Postgres (`ai_audit` table); this topic is reserved for future fan-out.
- **Consumes** `trade_events` (Kafka) — present for future ingestion of price/tick events. v1 does not yet drive scoring from this topic; signals are produced on demand via `/strategies/{id}/run`. The topic name matches `trading-service/services/workers/kafkaConsumer.go:90`.

The `signals` and `ai_audit` topic names did not previously exist in the repo; they are introduced here. They are auto-created on first produce by Kafka's default `auto.create.topics.enable=true`.

## Storage

Postgres tables added by `migrations/001_init.sql`:

- `ai_strategies` — registry; one row per strategy with mode + guardrails.
- `signals` — every score the model emits.
- `recommendations` — sized, actionable instruction with lifecycle (`SUGGESTED`/`EXECUTED`/`REJECTED`/`FAILED`).
- `ai_runs` — one row per `/run` invocation.
- `ai_audit` — append-only event log (mode changes, limit changes, killswitch toggles, breaches).
- `ai_global_state` — KV (currently holds the killswitch).

Existing tables (`users`, `trades`, `positions`, `orders`, etc.) are untouched.

## Strategy v1 — `momentum_v1`

LightGBM classifier on 5 deterministic TA features (`ret_1`, `ret_5`, `vol_5`, `sma_ratio_5_20`, `rsi_14`). Trained on synthetic AR(1)-momentum OHLCV at first-load if no artifact is present, persisted to `models_artifacts/momentum_v1.0.0.joblib`. If LightGBM is unavailable, falls back to `sklearn.ensemble.GradientBoostingClassifier`. If the model fails to load, falls back to a deterministic linear scorer over the same features. The recommendation `quantity` is `clip(round(|score| * max_position_qty), 1, max_position_qty)`; `direction` is BUY (>0.15), SELL (<-0.15), HOLD otherwise.

## Tests

`pytest -q` runs four integration tests against an in-process FastAPI client and a sqlite shim of Postgres:

1. Suggestion path — a `suggest`-mode `/run` writes a row to `recommendations` and produces on Kafka.
2. Auto-execute success — guardrails pass, paper trade posted to a stubbed Node endpoint, status flips to `EXECUTED`.
3. Auto-execute breach — quantity exceeds `max_position_qty`; status is `REJECTED` and an `ai_audit` row is written.
4. Kill switch — engaging the kill switch causes the next auto-run to reject and audit.

The test harness monkey-patches `app.db.get_conn` onto a sqlite connection so the suite is hermetic.

## Known upstream issues (worked around, not fixed)

- `routes/v1/trading/trade.js` is unauthenticated and trusts `userId` from the body. The auto-execute path posts directly with the configured `default_user_id`. **Do not** point this service at a production deployment until the route enforces JWT auth.
- That same route has a price-lookup bug (`prices[s.symbol]` against an HMGET array) that makes the balance check a no-op (CLAUDE.md §"trade.js price lookup bug"). The AI service does not depend on this; we send our own `quantity` and let Node decide.
- The Node trade route does not honour `client_order_id`. Idempotency is therefore enforced **inside the AI service** via a `UNIQUE` constraint on `recommendations.client_order_id`; if a recommendation insert collides, we treat it as a retry and skip the executor call.
- The Go trading-service has the position-overwrite bug noted in CLAUDE.md §"Path C". The AI service does not call the Go endpoint; auto-execute targets the Node Path A.
