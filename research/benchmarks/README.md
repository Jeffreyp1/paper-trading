# End-to-End Functional + Performance Report

Date: 2026-05-16 (run start; some files may be timestamped 2026-05-17 due to TZ)
Hardware: macOS 15 (Darwin 24.3) / Apple M4 x10 / 17 GB RAM

## Resume-safe claims

| Claim | Evidence | Caveat |
|---|---|---|
| Go async pipeline persisted ~4,267 trades/sec | `s-tier-results.md`, final sharded run | Single-laptop benchmark, not a hosted SLO |
| 100k queue messages had 0 missing Postgres rows | Fresh reconciliation run: `enqueued=100000`, `persisted_trades=100000`, `lost=0` | Restart test found duplicate replay risk; do not claim exactly-once |
| Position totals reconciled exactly | Fresh reconciliation run: `position_quantity_sum=100000` for 100k one-share messages | Quantity-only check; money still uses float in app paths |
| Kafka sharding removed Postgres deadlocks | `s-tier-results.md`, sharded-by-user run shows 0 PG errors | Requires Kafka key to remain `user_id` |
| Node buy path prevents concurrent overspend | `tests/trade_concurrency.test.js` verifies parallel buy invariants | SELL path remains broken/not implemented |
| Node sync buy path sustained ~1,010 TPS | `node-sync.txt` 30s hot-row benchmark, 0 errors, p99 ~451 ms | Single-user hot row; multi-user load differs |
| Leaderboard rebuild measured ~161 ms | `leaderboard.txt` / report over ~10k users and ~50k positions | Uses current dataset size, not 50M trades |

## Stack as tested

All services in `docker-compose.yml`, on a single `paper` bridge network.
Host ports rebound to avoid clash with host-side Postgres/Redis the user runs:

| service    | image                          | container port | host port |
|------------|--------------------------------|----------------|-----------|
| postgres   | postgres:16                    | 5432           | **5433**  |
| redis      | redis:7                        | 6379           | **6380**  |
| zookeeper  | confluentinc/cp-zookeeper:7.6.1| 2181           | —         |
| kafka      | confluentinc/cp-kafka:7.6.1    | 29092 internal / 9092 host | 9092 |
| node app   | local (Node 20)                | 3000           | 3000      |
| go service | local (Go 1.24)                | 8081           | 8081      |

Code patches required during this run, beyond the Phase-1 fixes that were already in the working tree:
- `redis.js`: added `import "dotenv/config"` and `createClient({url:redis://${host}:${port}})` (was hardcoded `localhost:6379`).
- `trading-service/pkg/redisClient/redisClient.go`: read `REDIS_HOST`/`REDIS_PORT` from env (was hardcoded `localhost:6379`).
- `trading-service/trade_service.go`: deleted. Was orphaned dead code in `package main` (duplicate type + functions never wired); broke `go build .`.
- `docker-compose.yml`: published ports rebound to 5433/6380 to avoid host clash.
- `.env`: added `DB_HOST=localhost DB_PORT=5433 DB_DATABASE=papertrade REDIS_HOST=localhost REDIS_PORT=6380`.

## Functional results — what works end-to-end

### Node sync trade path (`POST /api/v1/trading/trade`)

| Case | Status | Evidence |
|---|---|---|
| Register → JWT | ✅ | `auth/register` 201 in 42 ms; `auth/login` 200 with token |
| BUY (auth + price + balance) | ✅ | HTTP 200; balance 10000.00 → 9650.00 = exactly 2 × $175 |
| 2nd BUY same symbol | ✅ | Position quantity 2 → 5 (correctly accumulated via ON CONFLICT) |
| BUY new symbol | ✅ | MSFT position 1 @ $410 inserted |
| Insufficient funds | ✅ | HTTP 400 "Insufficient funds" |
| Invalid action | ✅ | HTTP 400 "Action must be to buy or sell" |
| Missing auth | ✅ | HTTP 401 "Access Denied. No Token" |
| **SELL** | ❌ **broken** | HTTP 500 "Client was passed a null or undefined query" — `executeSell` in `trade.js` is intentionally untouched per the in-code comment; tracked separately. |

Phase 1 fixes confirmed live in the route:
- `authenticateToken` mounted on `POST /trade` (line 88)
- `userId` taken from `req.user`, not body
- `priceMap[s.symbol]` lookup (no positional array bug)
- Multi-row parameterized INSERT (no string-concat SQL)
- All math executes inside a single PG transaction

### Go async pipeline (`POST :8081/api/trade`)

| Component | Status |
|---|---|
| HTTP server on :8081 | ✅ Up |
| In-memory bounded channel (cap 10000) | ✅ 30 workers draining |
| Redis Streams `buy_stream` + consumer group `kafka_workers` | ✅ Pipeline flowing |
| Kafka producer pool (2) → topic `trade_events` | ✅ Producing |
| Kafka consumer pool (15, group `postgres-writer`) | ✅ Consuming; end-of-test lag 55 msgs |
| Batched Postgres upserts (2000 rows / 50 ms) | ✅ Persisting |
| Position quantity accumulation | ✅ Sample positions match `SUM(trade.quantity)` exactly (delta = 0) |

### Leaderboard rebuild (`updateLeaderboard()` in `index.js`)

✅ Working. JOIN users+positions → in-memory aggregation → pipelined ZADD.

## Performance results

### Node sync trade — see [node-sync.txt](./node-sync.txt)

- **30,600 trades / 30s = 1,010 TPS sustained**
- p50 **96 ms**, p95 **240 ms**, p99 **450 ms**, p99.9 **750 ms**
- 0 errors, 100% success rate
- Single-user hot-row scenario (one user, one balance row, FOR UPDATE contention)

### Go async pipeline — see [go-pipeline.txt](./go-pipeline.txt)

- HTTP ingest TPS: **13,109 / sec** (3,932,836 requests / 300 s)
- **Persisted TPS: 2,285 / sec** (685,562 trades end-to-end through HTTP → channel → Redis Streams → Kafka → batched PG)
- Persist/Send ratio: 17.4% — rest are correct "Insufficient funds" rejections from random users hitting random trade sizes >$10k starting balance
- Kafka consumer group lag at end of test: 55 messages (negligible)

### Leaderboard rebuild — see [leaderboard.txt](./leaderboard.txt)

- **161 ms total** over 10,003 users / 49,996 positions / 99 prices
  - JOIN + HGETALL: 74 ms
  - in-memory aggregation: 9 ms
  - pipelined ZADD: 78 ms

## What's broken or missing

| Area | Status | Notes |
|---|---|---|
| SELL on Node | ❌ broken | Intentional per in-code TODO. HTTP 500. |
| SELL on Go | ❌ not implemented | No SELL action handler in the Go pipeline. |
| `STOCK_API_KEY` (live FMP poll) | ⚠️ not set | Service starts; prices manually seeded into Redis for the bench. Real price flow not exercised. |
| Go in-process stock cache | ⚠️ never populated | "Loaded 0 stock prices from Redis into memory" — Go reads `stock:*` keys; Node writes the `stockPrices` hash. Cache miss path used (HGET still works). |
| Per-user WS subscriptions | ⚠️ not built | Single global broadcast in `wsServer.js`. |
| Money representation | ⚠️ float in code, NUMERIC(12,2) in PG | Drift risk under high churn; not exercised at scale yet. |
| Chaos / zero-loss verification | ⚠️ not run | Outbox + chaos suite (Phases 3-4 of action plan) not yet implemented. |

## Reproduction

From repo root with `.env` configured per `.env.example` and ports per the table above:

```sh
# 1. Bring up infra
docker compose up -d postgres redis zookeeper kafka

# 2. Seed users (10k via psql)
PGPASSWORD=papertrade psql -h localhost -p 5433 -U papertrade -d papertrade -c \
  "INSERT INTO users (username, email, password_hash) SELECT 'u'||i, 'u'||i||'@x.io', 'x' FROM generate_series(1, 10000) AS s(i);"

# 3. Seed Redis stock prices (FMP-equivalent; one line per symbol)
redis-cli -p 6380 hset stockPrices AAPL 175 MSFT 410 ... [99 symbols]

# 4. Start Node service
PATH=/opt/homebrew/opt/node@20/bin:$PATH node index.js

# 5. Node sync bench (separate shell)
PATH=/opt/homebrew/opt/node@20/bin:$PATH TEST_DURATION_MS=30000 BATCH_SIZE=200 BENCH_USER=bench3 node stressTest.js

# 6. Go pipeline self-load-test
cd trading-service && go run .  # runs for ~5 min, prints final TPS + DB delta

# 7. Leaderboard timing (after data exists)
node /tmp/lb-test.mjs            # the throwaway script committed in this run produces 161ms total
```

## Bottom line

End-to-end the system is functional for the BUY path, end-to-end. Persisted throughput on the async pipeline is **2,285 TPS** verified against PG row counts (not just HTTP enqueue). Node sync handles **1,010 TPS** under hot-user contention with FOR UPDATE locking. Position integrity verified by reconciling `positions.quantity` against `SUM(trades.quantity)` — no overwrites. The SELL path and the chaos/zero-loss verification are the remaining gaps before the resume bullets in `resume-action-plan.md` Phase 4 are claimable.
