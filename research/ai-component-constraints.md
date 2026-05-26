# AI Trading Component — User-Specified Constraints

These constraints were set by the user on 2026-05-06 and override any conflicting recommendation in `ai-trading-research.md`. The build agent must follow them.

## Module location: New Python service

- Add a new top-level directory `ai-service/`.
- FastAPI for HTTP, uvicorn for serving.
- Python 3.11+, managed via `pyproject.toml` (uv or poetry — pick whichever is simpler).
- ML libs as recommended by the research doc (lightgbm/sklearn baseline; allow torch later).
- Containerize with a `Dockerfile`; add the service to the existing `docker-compose.yml`.
- Communicates with the rest of the system via:
  - HTTP for synchronous reads (Node API → ai-service for "give me a suggestion for X").
  - Kafka for async streams (price ticks in, recommendations out) — reuse the existing topic conventions documented in `CLAUDE.md`.
- Persists artifacts (models, backtest reports) to a mounted volume; metadata to Postgres.

## Autonomy: Both modes, user-toggleable

- Default mode: **Suggestions only** — AI writes recommendations to a `recommendations` table/topic; user must explicitly accept to place a paper trade.
- Opt-in mode: **Auto-execute with limits** — per-strategy toggle. When on, the executor places paper orders within these guardrails (all configurable per-user/per-strategy):
  - Max position size per symbol.
  - Max daily notional traded.
  - Max drawdown stop (kills the strategy until reset).
  - Per-symbol cooldown between trades.
  - Global kill switch.
- All auto-executions are tagged in the trades table with `source = 'ai:<strategy_id>'` for audit.
- UI: a settings panel per strategy with a clear "Suggest" / "Auto-execute" toggle and the limit fields above.

## Definition of done for the build agent

- `ai-service/` runs locally via docker compose alongside Node + Go.
- Health check endpoint, one baseline strategy end-to-end (suggestions table populated, opt-in auto-execute path proven on paper trades), guardrails enforced server-side, kill switch verified.
- Tests: at least one integration test that exercises suggestion path and one that exercises auto-execute with limit breach (must reject).
