# CLAUDE.md

Orientation for Claude Code sessions working in this repo. Skim before editing.

## Overview

Paper-trading (simulated stock trading) platform. Node.js + Express REST API
backed by PostgreSQL, with Redis as a hot cache and a `ws` WebSocket server
pushing live stock prices and a leaderboard. A separate, experimental Go
microservice lives in `trading-service/` but is **not** wired into the request
path yet — Express handles trades end-to-end today.

## Run it

- `npm install`
- `npm run dev` (nodemon) or `npm start` — Express on `:3000`, WS on `:8080`
- `docker-compose up` — brings up Postgres 16, Redis 7, and the app together
- Schema lives in `db.sql` (auto-applied via the Postgres init mount in
  `docker-compose.yml`; apply manually for a non-Docker DB)
- Go service (optional): `cd trading-service && go run ./main.go`

### Required env vars

`DB_USER`, `DB_HOST`, `DB_DATABASE`, `DB_PASSWORD`, `DB_PORT`, `JWT_SECRET`,
`STOCK_API_KEY` (Financial Modeling Prep). `dotenv/config` is loaded by
`db.js` and route files.

## Architecture map

- `index.js` — Express bootstrap, mounts `/api/v1`, starts the WS server, and
  schedules periodic jobs:
  - stock prices refresh every 6 min (`stockService.updateAllStocks`)
  - leaderboard recompute every 6 min (writes Redis sorted set, then
    `pushLeaderboard()`)
  - balance + positions warm into Redis on startup, balances re-sync every
    10 min
- `wsServer.js` — `ws` server on `:8080`. Exports `pushLeaderboard()` and
  `pushStockPrices()`; on connect, sends current `stockPrices` and top-10
  leaderboard.
- `db.js` — shared `pg.Pool`.
- `redis.js` — shared Redis client (auto-connects on import).
- `middleware/authMiddleware.js` — `authenticateToken`: verifies Bearer JWT,
  attaches `req.user = { id, email }`.
- `routes/v1/index.js` — aggregates all routers under `/api/v1`.
  - `auth/login.js`, `auth/register.js`
  - `trading/trade.js` (single trade), `trading/trade_history.js`
  - `trading/new_trade.js` — **intentionally not mounted** (commented out in
    the aggregator)
  - `analytics/leaderboard.js`, `analytics/portfolio.js`,
    `analytics/holdings.js`
- `services/`
  - `stockService.js` — fetches ~100 symbols from FMP, pipelines into Redis
    hash `stockPrices`
  - `getStockPrice.js` — single-symbol Redis lookup
  - `balancePositions.js` — `storeBalanceToRedis()` / `storePositionsToRedis()`,
    PG → Redis warmers/refreshers

## Data model (Postgres, see `db.sql`)

- `users` — `id`, `username`, `email`, `password_hash` (bcrypt, 10 rounds),
  `role` (`USER`/`ADMIN`), `balance` `NUMERIC(12,2)` defaulting to **$10,000**
- `trades` — executed transactions: `user_id`, `symbol`, `trade_type`
  (`BUY`/`SELL`), `executed_price`, `quantity`
- `positions` — current holdings: `user_id`, `symbol`, `quantity`,
  `average_price`. Unique on `(user_id, symbol)`.
- `orders` — open/limit/stop orders (schema present, lightly used)
- `watchlists`, `watchlist_items`
- Enums: `trade_type_enum`, `order_type_enum`, `order_status_enum`. All FKs
  cascade from `users`.

## Redis keys (canonical — keep these names consistent)

- `stockPrices` — hash, `symbol → price`
- `user_balance` — hash, `userId → balance` (string)
- `positions:{userId}` — hash, `symbol → "quantity,average_price"`
  (comma-separated string, **not** JSON — see
  `services/balancePositions.js:75`)
- `leaderboard` — sorted set, `username → net_worth`

## Conventions

- ESM throughout (`"type": "module"`). Use `import`/`export`.
- Hand-written SQL via `pg` — no ORM. Prefer parameterized queries (`$1, $2`)
  and explicit `BEGIN` / `COMMIT` / `ROLLBACK` for multi-step writes; see
  `routes/v1/trading/trade.js` for the pattern.
- Reads on hot data go through Redis; writes update both Postgres and the
  Redis cache so the WS broadcast and analytics endpoints stay consistent.
- No linter, formatter, or test framework is configured.

## Testing / load

- `node test.js` — seeds fake users + trades using `faker`
- `node stressTest.js` — load test against `/api/v1/trading/trade`
- `node tests/benchmark.js` — batch trade benchmark (note: hits the
  currently-unmounted `/new_trade` endpoint and contains a hard-coded JWT)
- **No assertion-based tests exist.** Don't claim "tests pass" after a
  change — manually exercise the affected route or background job instead.

## Gotchas

- **Env var name mismatch**: `db.js` reads `DB_DATABASE`, but
  `docker-compose.yml` only exports `DB_NAME`. Outside Docker you need
  `DB_DATABASE` set; under Docker the app currently has no DB name unless
  `.env` also defines `DB_DATABASE`.
- **SQL injection in trade route**: `routes/v1/trading/trade.js` interpolates
  `stock.symbol` into a string-template SQL insert. Anything that touches
  that path should switch to parameterized queries rather than extending the
  template.
- **WS message typo on connect**: `wsServer.js` emits `type: "ledaerboard"`
  on the initial connect message (other broadcasts use `"leaderboard"`).
  Clients may rely on the typo — change carefully.
- **`new_trade` is intentionally unmounted** in `routes/v1/index.js:17`.
  Don't re-enable without confirming with the user.
- **`dump.rdb` (~27 MB) is committed.** It seeds the Redis container via the
  bind mount in `docker-compose.yml`. Don't regenerate or delete casually.
- **Background jobs run from `index.js`**: importing it for a side script will
  start the periodic API calls and DB queries. Use the helpers in
  `services/` directly instead.

## Don't do without asking

- Introduce a new framework, ORM, test runner, or build tool.
- Rename any Redis key above without sweeping every reader and writer.
- Wire the Go `trading-service` into the Express request path.
- Push to `main` from this session — the working branch is
  `claude/analyze-and-document-lHBvu`.
