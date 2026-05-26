# CLAUDE.md

## Overview

A simulated equities paper-trading backend. Users register, get a starting cash balance of `$10,000.00` (Postgres `users.balance` default), buy/sell from a fixed universe of ~100 large-cap symbols, and a leaderboard ranks users by net worth. There are two coexisting backend services: a Node/Express + WebSocket service at the repo root that owns auth, REST analytics, the WebSocket fan-out, and the synchronous in-process trade endpoint; and a separate Go "trading-service" (`trading-service/`) that exists as a high-throughput async trade pipeline (HTTP -> in-memory channel -> Redis Streams -> Kafka -> Postgres batch writer). The two services share the same Postgres database and the same Redis instance but do not call each other directly. The `web/` directory is a stub Next.js app and is out of scope here.

## Repo Layout

```
/Users/jeffrey/paper-trading
├── index.js                          # Node entrypoint: REST + cron-like timers + boots WS
├── db.js                             # pg.Pool factory; reads DB_* envvars
├── redis.js                          # node-redis v4 client, single shared connection
├── wsServer.js                       # ws WebSocketServer on :8080, leaderboard + price push
├── db.sql                            # Postgres schema (users, trades, positions, orders, watchlists)
├── docker-compose.yml                # app + postgres:16 + redis:7 (no Kafka here)
├── stressTest.js                     # HTTP load gen against POST /api/v1/trading/trade
├── test.js                           # DB seeder using faker (inserts users/trades/positions)
├── tests/benchmark.js                # 1k-trade batch benchmark vs /trading/new_trade
├── package.json                      # type: module; deps: express, pg, redis, ws, jsonwebtoken, bcrypt, axios
├── middleware/authMiddleware.js      # JWT bearer-token verifier
├── routes/v1/index.js                # mounts /auth, /trading, /analytics
├── routes/v1/auth/register.js        # POST /api/v1/auth/register
├── routes/v1/auth/login.js           # POST /api/v1/auth/login -> JWT
├── routes/v1/trading/trade.js        # POST /api/v1/trading/trade  (synchronous buy/sell, broken sell)
├── routes/v1/trading/new_trade.js    # POST /api/v1/trading/new_trade  (batch insert; not mounted)
├── routes/v1/trading/trade_history.js# GET  /api/v1/trading/trade_history
├── routes/v1/analytics/leaderboard.js# GET  /api/v1/analytics/leaderboard
├── routes/v1/analytics/holdings.js   # GET  /api/v1/analytics/holdings
├── routes/v1/analytics/portfolio.js  # GET  /api/v1/analytics/portfolio
├── services/stockService.js          # FMP API fetch -> redis HSET stockPrices
├── services/getStockPrice.js         # redis.get(symbol) (note: wrong key shape, see below)
├── services/balancePositions.js      # warms user_balance hash + positions:<uid> hashes from PG
└── trading-service/                  # Go service, separate process
    ├── main.go                       # boots all subsystems + runs an internal load test
    ├── trade_service.go              # legacy single-package handleTrade + executeBuy (orphaned)
    ├── go.mod                        # chi, go-redis v9, lib/pq, confluent-kafka-go v2, godotenv
    ├── docker-compose.yml            # zookeeper + kafka (no app/db here)
    ├── server/server.go              # chi router with POST /api/trade -> TradeJobQueue (unused by main)
    ├── services/trade/trade_service.go   # ExecuteBuy: HSET user_balance + XADD buy_stream
    ├── services/workers/worker.go         # in-process TradeWorker pool, drains TradeJobQueue
    ├── services/workers/kafkaConsumer.go  # processRedisStream: XReadGroup buy_stream -> Kafka produce
    ├── services/workers/kafkaToSql.go     # processKafka: Kafka consume -> batch INSERT/UPSERT Postgres
    ├── services/workers/redisToSql.go     # OLD path: XReadGroup -> direct SQL (StartSQLWorkerPool, not called)
    ├── pkg/redisClient/redisClient.go     # go-redis v9 client (PoolSize 75)
    ├── redis/redisStorage.go              # in-process float64 cache of stock prices, lazy-loads from Redis
    └── db/db.go                           # database/sql Postgres conn (lib/pq)
```

## How to Run

Required envvars (root `.env` for both services; Go service does `godotenv.Load("../.env")` from `trading-service/`):

- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE` (also `DB_NAME` referenced by docker-compose)
- `REDIS_HOST`, `REDIS_PORT` (only read by docker-compose env block; the Node `redis.js:3` calls `createClient()` with no args, so it always connects to `localhost:6379`. The Go `pkg/redisClient/redisClient.go:17` is also hardcoded to `localhost:6379`.)
- `JWT_SECRET` (read by `routes/v1/auth/login.js:9` and `middleware/authMiddleware.js:4`)
- `STOCK_API_KEY` (Financial Modeling Prep, used by `services/stockService.js:6`)

Bring up infra:

```
# Postgres + Redis (root)
docker compose -f /Users/jeffrey/paper-trading/docker-compose.yml up -d postgres redis

# Kafka + Zookeeper (separate compose file in trading-service)
docker compose -f /Users/jeffrey/paper-trading/trading-service/docker-compose.yml up -d
```

Run services:

```
# Node service (port 3000 HTTP, port 8080 WebSocket)
cd /Users/jeffrey/paper-trading && npm start          # node index.js
# or: npm run dev (nodemon)

# Go service (port 8081 HTTP); also auto-starts an internal HTTP load test against itself
cd /Users/jeffrey/paper-trading/trading-service && go run .
```

Ports: Node REST `:3000`, Node WebSocket `:8080`, Go REST `:8081`, Postgres `:5432`, Redis `:6379`, Kafka `:9092`.

`docker-compose.yml` interpretation: the root compose builds an `app` container from a Dockerfile (no Dockerfile exists in the repo, so `docker compose up app` will fail — only `postgres` and `redis` services are usable). It mounts `./db.sql` into the Postgres init dir so the schema is created on first boot, and mounts `./dump.rdb` into Redis (a 27 MB pre-seeded snapshot is committed). The `trading-service/docker-compose.yml` only stands up Kafka+Zookeeper and does not bring up the app, DB, or Redis; you must run it alongside the root compose. There is no Dockerfile for the Go service.

## Data Model

### Postgres (`db.sql`)

Enums: `order_type_enum` ∈ {MARKET, LIMIT, STOP_LOSS, STOP_LIMIT}; `order_status_enum` ∈ {OPEN, PARTIALLY_FILLED, FILLED, CANCELED}; `trade_type_enum` ∈ {BUY, SELL}.

- `users` (`db.sql:11`): `id SERIAL PK`, `username TEXT UNIQUE`, `email VARCHAR(255) UNIQUE`, `password_hash`, `role` (USER/ADMIN), `balance NUMERIC(12,2) DEFAULT 10000.00`, `created_at`, `updated_at`.
- `trades` (`db.sql:25`): `id SERIAL PK`, `user_id FK->users(id) ON DELETE CASCADE`, `symbol VARCHAR(20)`, `trade_type` enum, `executed_price NUMERIC(12,2)`, `quantity INT`, timestamps. **No index on `user_id` or `(user_id, created_at)`** — `trade_history` does a full filter by user.
- `positions` (`db.sql:44`): `id SERIAL PK`, `user_id FK`, `symbol`, `quantity INT DEFAULT 0`, `average_price NUMERIC(12,2) DEFAULT 0`, `UNIQUE(user_id, symbol)` (used by `ON CONFLICT` upserts).
- `orders` (`db.sql:60`): full advanced-order schema (LIMIT/STOP), but **no code path inserts or reads from this table**. Not implemented.
- `watchlists`, `watchlist_items` (`db.sql:81`, `db.sql:94`): schema only; no routes touch them.

`positions.quantity` is `INT`, but `trading-service/services/trade/trade_service.go` and the Go workers carry `Quantity float64`. In Go, the cast happens implicitly via parameter-position in INSERT — fractional quantities will be rounded by Postgres or rejected.

### Redis (single instance, shared)

| Key                              | Type         | Shape / value                                        | Written by                               | Read by                                                | TTL                |
|----------------------------------|--------------|------------------------------------------------------|------------------------------------------|--------------------------------------------------------|--------------------|
| `stockPrices`                    | hash         | field=symbol, value=`"<price>"` string               | `services/stockService.js:31`            | `routes/v1/trading/trade.js:85`, `routes/v1/analytics/portfolio.js:31`, `wsServer.js:9`, Go `redisStorage.GetStockPrice` (`trading-service/redis/redisStorage.go:60`) | none |
| `user_balance`                   | hash         | field=`<userId>` (string), value=balance string      | `services/balancePositions.js:52`, Go `trade_service.ExecuteBuy` (`trading-service/services/trade/trade_service.go:36`), Go `services/workers/worker.go` reads it | `routes/v1/analytics/portfolio.js:24`, Go workers | none |
| `positions:<userId>`             | hash         | field=symbol, value=`"<qty>,<avgPrice>"` CSV string  | `services/balancePositions.js:75`, `trading-service/trade_service.go:72` | `routes/v1/analytics/holdings.js:22`, `routes/v1/analytics/portfolio.js:28` | none |
| `leaderboard`                    | sorted set   | score=net_worth, member=`JSON.stringify({username, holdings})` | `index.js:60`                            | `routes/v1/analytics/leaderboard.js:11`, `wsServer.js:16`, `wsServer.js:34` | rebuilt every 6 min, `DEL`+rebuild |
| `buy_stream`                     | stream       | fields: `user_id, action, balance, stocks(JSON)`     | Go `ExecuteBuy` (`trade_service.go:37`)  | Go `processRedisStream` consumer group `kafka_workers` | XACK + XDel/XTrim per message |
| `rollback:balance:<uid>`         | hash         | `{balance: <prevBalance>}`                           | Go `trade_service.go:30`                 | Go `trade_service.go:81`                               | none (leaks)       |
| `rollback:position:<uid>`        | hash         | field=symbol, value=`"<qty>,<avg>"`                  | Go `trade_service.go:47`                 | Go `trade_service.go:87`                               | none (leaks)       |
| `stock:<SYMBOL>`                 | string       | float price (only checked, never written by current code) | -                                  | Go `redisStorage.InitRedis` scans `stock:*` keys (`trading-service/redis/redisStorage.go:23`) | n/a — empty by default |

Consumer groups on `buy_stream`: `kafka_workers` (created in `EnsureRedisStream`, used by Kafka producer worker), and `sql_workers` (used by the orphaned `redisToSql.go::processTrade`, never created in current main).

## Trade Lifecycle

There are **three** distinct trade execution paths in this repo. They are not unified.

### Path A: Node synchronous BUY (`POST /api/v1/trading/trade`) — primary client path

Files: `routes/v1/trading/trade.js`, `services/balancePositions.js`, `redis.js`, `db.js`.

1. Client POSTs `{ userId, action: "buy"|"sell", stock: [{symbol, quantity}, ...] }` to `:3000/api/v1/trading/trade`. Note: `authenticateToken` is imported but **not applied** — endpoint is unauthenticated and trusts `userId` from the body (`routes/v1/trading/trade.js:63-66`).
2. `trade.js:73` checkout pg client.
3. `trade.js:80` `SELECT balance FROM users WHERE id = $1` (read live, not Redis).
4. `trade.js:85` `HMGET stockPrices <syms...>` from Redis to price the basket.
5. `trade.js:87` compute `total = Σ qty * stockPrices[symbol]`. Bug: line 85 returns an array indexed by position, but line 88 indexes by `prices[s.symbol]` (string key on an array) -> always `undefined` -> `total = 0` -> always passes the `total < balance` check.
6. `trade.js:92` `BEGIN`; `executeBuy(client, prices, userId, stock, total)`:
   - `trade.js:9` `UPDATE users SET balance = balance - $1 WHERE id = $2`. Subtracts `0` because of bug above.
   - `trade.js:14` builds `INSERT INTO trades` via string concatenation of values (SQL-injectable on `stock.symbol` if user controlled). `prices[index]` here is also wrong — `prices` is a hash array indexed by position, but `prices[index]` from `HMGET` is the price string in correct order, so this part actually does write the right price into trades; `executed_price` ends up correct only because `HMGET` is positional.
   - `trade.js:33` `INSERT INTO positions ... ON CONFLICT(user_id,symbol) DO UPDATE SET quantity = positions.quantity + EXCLUDED.quantity, average_price = ((q1*p1)+(q2*p2))/(q1+q2)` — weighted-average upsert.
7. `trade.js:94` `COMMIT`; respond 200.
8. Redis `user_balance` and `positions:<uid>` hashes are **not updated** by this path. They are only synced once every 10 minutes by `index.js:81`/`83` calling `storeBalanceToRedis` / `storePositionsToRedis`. So the GET `/portfolio` and `/holdings` endpoints (which read Redis only) lag behind reality by up to 10 minutes after a trade.

### Path A (sell sub-branch): broken

`routes/v1/trading/trade.js:46` `executeSell` is unfinished:
- Template literal is malformed (`SQL...` immediately followed by `[quantity, userId, symbol]` instead of `query, params`) — line 52 ends the SQL template right after `RETURNING *;` then has `[quantity, userId, symbol]` as a separate expression.
- References `res` and `totalCost` and `symbol`/`quantity` that aren't in scope (`trade.js:55, 57`).
- Caller `trade.js:98` invokes `executeSell(client, userId, symbol, quantity, stockPrice)` where none of `symbol`, `quantity`, `stockPrice` are defined in the route handler.
- Sells will always throw and rollback.

### Path B: Node batch (`POST /api/v1/trading/new_trade`)

Routed but **commented out** in `routes/v1/index.js:17`. File `routes/v1/trading/new_trade.js` does a single batched `INSERT INTO trades` with prices fetched via `redis.get(trade.symbol)` (`new_trade.js:29`) — but `getStockPrice.js` and `redis.get(symbol)` look for a top-level key called `<symbol>`, which is never written; `stockPrices` is a hash. So prices are always `0` here too. Does not touch `positions` or `users.balance`.

### Path C: Go async pipeline (`POST :8081/api/trade`)

Used by the Go service's own internal load tester (`main.go:110`) and by `server/server.go`. Lifecycle:

1. HTTP handler `main.go:73 tradeHandler` decodes JSON `TradeRequest`, non-blocking sends `TradeJob{Trade: req}` onto buffered channel `workers.TradeJobQueue` (cap 10000, `services/workers/worker.go:19`). Returns 202 or 503 if full.
2. `StartWorkerPool(30, TradeJobQueue)` (`main.go:182`) spawns 30 goroutines running `TradeWorker` (`services/workers/worker.go:21`). Each worker:
   - `HGET user_balance <uid>` for cash.
   - For each stock, `redisStorage.GetStockPrice(symbol)` reads the in-process `cache map[string]float64` (`redis/redisStorage.go:50`); on miss falls through to `HGET stockPrices symbol`. **Note**: `InitRedis` only scans keys matching `stock:*` (line 23), which don't exist, so the cache starts empty and every first call falls through to Redis.
   - If `totalCost <= balance`, calls `trade_service.ExecuteBuy`.
3. `ExecuteBuy` (`services/trade/trade_service.go:29`): TxPipeline — `HSET user_balance <uid> <balance-totalCost>` and `XADD buy_stream * user_id ... action ... balance ... stocks <json>`. Pipeline `Exec`. **No SQL write here.** Critical bug: on `XAdd` error it calls `log.Fatalf` (line 47) which kills the process; same on Exec failure (line 53).
4. Kafka producer pool `StartKafkaProducer(2)` (`main.go:176`) runs 2 goroutines of `processRedisStream` (`services/workers/kafkaConsumer.go:37`). Each `XReadGroup` from `buy_stream` group `kafka_workers` (Count=10, no Block timeout — defaults to non-blocking, will hot-loop and log `no messages` warnings (line 55) when empty). For each msg, marshals to JSON `Trade` and calls `producer.Produce(topic="trade_events")`. Then `XAck` + `XDel` regardless of produce error (errors only logged).
5. Kafka consumer pool `StartKafkaConsumer(15, db.DB)` (`main.go:177`) runs 15 goroutines of `processKafka` (`services/workers/kafkaToSql.go:33`). Each is its own consumer in group `postgres-writer` reading topic `trade_events`. Buffers up to `batchSize=2000` or `batchTimeout=50ms`. On flush, `upsertBalancePositionsAndTradeHistory` (`kafkaToSql.go:122`) runs in a single tx:
   - Bulk `INSERT INTO trades`,
   - Bulk `INSERT INTO positions ... ON CONFLICT DO UPDATE` (same weighted-average formula as Path A),
   - Bulk `UPDATE users SET balance = CASE WHEN id=… THEN … END WHERE id IN (…)` — sets balance to the *snapshot* value the producer computed in step 3, not relative arithmetic.
6. Per-batch dedup: `seenUsers map[int]bool` skips a user if already present in the current batch (`kafkaToSql.go:51, 61`). This *drops* trades for a user in the same batch — not just dedups, the dropped trade is silently lost (Kafka offset auto-committed via `enable.auto.commit:true`).

### Sell path in Go: not implemented. `handleTrade` in `trading-service/trade_service.go` only handles `"buy"` (line 129) and is no longer wired into any router.

## Inter-service Communication

- **Node ⇄ Go**: there is no direct communication. They share Postgres (same `users`/`trades`/`positions` rows) and Redis (same `user_balance`, `positions:<uid>`, `stockPrices`, `buy_stream`). No HTTP, no shared queue between them.
- **Internal Go pipeline**:
  - In-process channel `workers.TradeJobQueue` (`worker.go:19`) — capacity 10000, dropped on full.
  - Redis Stream `buy_stream` — producers: `trade_service.ExecuteBuy`; consumer group `kafka_workers` -> `processRedisStream` -> Kafka. Second consumer group `sql_workers` exists for the legacy direct path (`redisToSql.go`) but `StartSQLWorkerPool` is not invoked from `main.go`.
  - Kafka topic `trade_events` (hardcoded in `kafkaConsumer.go:90` and `kafkaToSql.go:30`). Bootstrap servers `localhost:9092`. Producer config raises `queue.buffering.max.messages` to 8M and `queue.buffering.max.kbytes` to ~8GB (`kafkaConsumer.go:31`). Consumer group `postgres-writer`, `auto.offset.reset=earliest`, `enable.auto.commit=true`.

Message shape on `buy_stream` (Redis):
```
user_id: "<int as string>"
action:  "BUY"
balance: "<float64 string>"   // already-decremented balance
stocks:  "<json array of {symbol, quantity, price}>"
```

Message shape on `trade_events` (Kafka, JSON):
```
{ "user_id": int, "action": string, "balance": float64,
  "stocks": [{"symbol": string, "quantity": float64, "price": float64}] }
```

## Pricing & Positions

### Prices

- Source: Financial Modeling Prep `https://financialmodelingprep.com/api/v3/quote/<csv-symbols>?apikey=<STOCK_API_KEY>` (`services/stockService.js:22`).
- ~100 symbols hardcoded in `stockService.js:7-18`.
- Refresh: `index.js:85` `setInterval(fetchStockPrices, 360000)` = every 6 minutes (the `360000` looks like it was intended to be ms = 6 min, not 6 s).
- Storage: pipelined `HSET stockPrices <symbol> <price>` (`stockService.js:31`).
- After write, `pushStockPrices()` (`wsServer.js:52`) broadcasts the entire hash to all WS clients.
- Reads: Node trade route uses `HMGET stockPrices ...` (`trade.js:85`); analytics/portfolio uses the same (`portfolio.js:31`); Go workers use `redisStorage.GetStockPrice` which prefers in-process map cache.
- `services/getStockPrice.js` is dead code: it does `redis.get(symbol)` against a flat key that is never written.

### Balances

- Source of truth: `users.balance` in Postgres.
- Mirror: Redis hash `user_balance` (field=userId, value=balance string).
- Mirror is rebuilt wholesale every 10 min: `storeBalanceToRedis` `DEL user_balance` then `HSET ...all balances` (`balancePositions.js:33-66`).
- Path A trades update Postgres only — Redis balance is stale until next 10 min sweep.
- Path C (Go) trades update Redis `user_balance` synchronously in `ExecuteBuy` and update Postgres `users.balance` later (eventually, via Kafka batch). The Go path overwrites Redis balance with `balance - totalCost` computed from the previously-read Redis value — concurrent trades for the same user race here (read-modify-write without WATCH/Lua/INCRBYFLOAT).

### Positions

- Source of truth: `positions` table in Postgres.
- Mirror: Redis hash `positions:<userId>` with field=symbol, value=`"<qty>,<avgPrice>"` CSV string.
- `storePositionsToRedis` (`balancePositions.js:68`) only writes to Redis if there are zero `positions:*` keys; **on subsequent reboots it is a no-op** (line 80 prints "Positions have already been stored"). This means new users who register after the first warm-up never get a `positions:` hash created, and `/holdings`/`/portfolio` will return empty for them until something else writes.
- Path A only writes positions to Postgres.
- Path C writes positions to Redis (full per-user hash overwrite of the mutated symbol) in `trading-service/trade_service.go:72` — note `executeBuy` here writes `stock.Quantity` instead of `updated_quantity` for the field value (line 72): `HSET positions:<uid> <symbol> "<stock.Quantity>,<updated_avg>"`. This drops accumulated quantity on every BUY.

## WebSocket Layer

`wsServer.js:3` `WebSocketServer({port: 8080})`. No auth on connection; no subscription protocol; broadcasts to all connected clients.

On connect (`wsServer.js:5`):
1. `ws.send({message: "Connected to live updates"})`.
2. Pulls `HGETALL stockPrices` and broadcasts `{type: "stocks", data: <hash>}` to **every** client (not just the new one — `wss.clients.forEach`, `wsServer.js:10`).
3. Pulls `ZRANGE leaderboard -10 -1 WITHSCORES`, sends only to the new socket as `{type: "ledaerboard", data: [...]}` (typo intentional in code, `wsServer.js:28`).

Periodic pushes:
- `pushStockPrices()` after every price refresh (`stockService.js:36`).
- `pushLeaderboard()` after every leaderboard rebuild (`index.js:67`), every 6 minutes per `setInterval` at `index.js:87`.

Payloads:
- `{ type: "stocks", data: { AAPL: "215.34", MSFT: "423.10", ... } }` — values are strings.
- `{ type: "leaderboard", data: [{ username, net_worth, holdings: [{symbol, quantity, currentPrice, totalValue}] }, ...] }` (typo `ledaerboard` only on initial connect).

There is no per-user channel and no portfolio/trade-execution event broadcast.

## Hot Paths & Known Bottlenecks

The critical trading path the next agent should focus on is **Path A (`routes/v1/trading/trade.js`)** for the Node side and **Path C (Go HTTP -> channel -> Redis Stream -> Kafka -> Postgres batch)** for the Go side.

Concrete issues found:

1. **`trade.js` price lookup bug** (`routes/v1/trading/trade.js:85, 88`): `HMGET` returns a positional array, but the reduce uses `prices[s.symbol]` (string key). `total` is always `0`, so the balance check is a no-op and the user pays `$0` per share. The subsequent `executed_price` written to `trades` happens to be correct only because the position-indexed `prices[index]` is used in `executeBuy`. Fix: switch `HMGET` to a sym->price map, or index by position consistently.
2. **`trade.js` SQL is built by string concatenation** (`trade.js:20, 31`) — `INSERT INTO trades ... VALUES (${userId},'${stock.symbol}', ${stock.quantity}, ${prices[index]}, 'BUY')`. SQL-injectable via `symbol`. Use parameterized queries.
3. **`trade.js` sell path does not work at all** (see Trade Lifecycle, Path A sell).
4. **Auth is not enforced on `/trading/trade`** (`trade.js:63`). The `authenticateToken` import at line 4 is unused. `userId` is taken from request body and trusted. Anyone can move anyone's money.
5. **No row-level locking and no `SELECT ... FOR UPDATE` on user balance** (`trade.js:80`). Concurrent trades for the same user race; `UPDATE users SET balance = balance - $1` (line 9) is atomic per-statement but the read-decide-write is not. Two simultaneous trades both read full balance and may overdraft.
6. **Postgres lacks an index on `trades(user_id)`** (`db.sql:25`). `trade_history` and analytics scan the whole table per user.
7. **Redis caches stale by up to 10 min** (`index.js:81-83`). `/portfolio`, `/holdings`, leaderboard all read Redis; Path A only writes Postgres. Either dual-write on trade or shorten the interval.
8. **`storePositionsToRedis` short-circuits on any existing key** (`balancePositions.js:71`). New users post-bootstrap never get warmed up.
9. **`updateLeaderboard` is O(N×P)** (`index.js:19-62`). It joins `users` and `positions` for *all* users every 6 minutes, builds a Map, and ZADDs every user. With N users + P positions/user this is fine at small scale but unbounded. The `await Promise.all(users.rows.map(async ...))` is wrapping non-async work; awaiting on synchronous map ops just queues microtasks. Iterate synchronously.
10. **`updateLeaderboard` only ZADDs users with at least one row from the INNER JOIN** — users with zero positions are excluded entirely (`index.js:22` is an INNER JOIN). New users never appear on the leaderboard.
11. **Go `ExecuteBuy` calls `log.Fatalf` on Redis errors** (`trading-service/services/trade/trade_service.go:32, 47, 53`) — kills the whole service on a single XAdd failure. Use error returns.
12. **Go `executeBuy` (in `trading-service/trade_service.go:72`) writes `stock.Quantity` instead of `updated_quantity`** in the position field. Every BUY *replaces* total quantity with the current trade's quantity. Holdings will be wrong on the second buy of a symbol.
13. **Go `processKafka` `seenUsers` dedup silently drops trades** (`kafkaToSql.go:61`). If the same user appears twice in a 2000-msg batch, only the first is persisted; offset is auto-committed regardless.
14. **`enable.auto.commit=true` in Kafka consumer** (`kafkaToSql.go:38`) — commits before the Postgres tx commits. Crash between Kafka commit and PG commit loses messages permanently.
15. **`processRedisStream` uses no `Block`** (`kafkaConsumer.go:43`) — the worker hot-loops when the stream is empty and prints `"⚠️ Worker %d found no messages"` continuously (line 55). Set `Block: 5*time.Second`.
16. **`processKafka` ticker logic is wrong** (`kafkaToSql.go:53-86`). It only checks the ticker after a successful read, so under sustained low traffic the batch is flushed at the wrong cadence (and never flushed if no read returns).
17. **No idempotency keys** — Path A and Path C have no client-supplied trade ID. Retries re-execute. Redis stream IDs aren't carried into Kafka, so cross-step dedup is impossible.
18. **Go in-process stock cache is never refreshed** (`redis/redisStorage.go:14`). It populates lazily on first miss and never expires. Stays at startup price for the life of the process.
19. **`buy_stream` rollback keys leak** (`trade_service.go:29, 41`): `rollback:balance:<uid>` and `rollback:position:<uid>` are written every trade, never deleted on success, no TTL.
20. **No backpressure into Kafka** — `processRedisStream` Acks+Dels the Redis message immediately after `producer.Produce` (which is async-buffered). On producer crash the message is lost (already removed from Redis).
21. **`updateLeaderboard` and analytics N+1-ish JOINs**: small, but `users INNER JOIN positions` returns one row per (user, position), and the JS rebuilds the user map. A single SQL aggregation could compute per-user `SUM(quantity * price)` directly if prices were materialized.
22. **Money is `NUMERIC(12,2)` in Postgres but `float64` everywhere in Go and JS**, including the path that *writes* `users.balance = balance - totalCost`. Float drift can cause off-by-cent errors. See Glossary.

## Testing & Stress Testing

- `tests/benchmark.js`: hits the (unmounted) `POST /api/v1/trading/new_trade` with a single batch of 1000 random `{userId, symbol, quantity, action}` objects and prints round-trip time. Hardcodes a JWT bearer token. Because `new_trade` is not mounted, this currently 404s. No assertions.
- `stressTest.js`: 200-concurrent batches of `POST /api/v1/trading/trade` for 1000ms (configurable: `TEST_DURATION_MS=1000`, `BATCH_SIZE=200`, `MAX_USERS=10000`). Prints sent / success / fail / TPS / avg latency. No documented baseline number is committed.
- `test.js`: not a test — a DB seeder. `testDatabase(9000)` inserts 9000 fake users, each with 5 random trades, then upserts positions, then triggers `pushLeaderboard()`. Uses `faker`.
- `trading-service/main.go` is itself a stress test: on `go run .` it boots the Go API on `:8081` and spawns a goroutine that POSTs random BUYs for every user it finds in the DB for `5 minutes` (`testDuration` `main.go:31`). After the test it prints `Actual Trades Stored in DB` minus `Before`. This is the main quoted TPS metric used during recent commits.
- No unit tests, no integration tests, no contract tests. No tests for auth, position math, leaderboard correctness, or sell path. No CI config.

Coverage gaps the next agent should know about: there is **no test that asserts a trade actually decremented balance, inserted a row, and updated positions**. There is no reproducer for the price-lookup bug or the position-overwrite bug.

## Glossary / Conventions

- **Money**: stored `NUMERIC(12,2)` in Postgres (max ~9.99 billion), serialized as JS `parseFloat` in Node and `float64` in Go. There is no cents/integer representation. Comparisons like `if (total < balance)` are float comparisons.
- **Quantities**: `INT` in Postgres, but `float64` in Go message types. Mismatch — fractional shares would be silently truncated by the driver or rejected.
- **Price field name**: Postgres uses `executed_price` (NUMERIC(12,2)). Go and JS use `price`. The Redis hash is named `stockPrices` (camelCase) while the symbol-keyed cache prefix `stock:*` exists but is unused.
- **User identifier**: `users.id` is `SERIAL` (4-byte int). All caches key by stringified id (`fmt.Sprint(userId)` in Go, `userId.toString()` in JS).
- **Action / trade_type**: enum `BUY`/`SELL` uppercase in Postgres; Node accepts lowercase in body and uppercases via `.toLowerCase()` for branching but inserts the literal `'BUY'`/`'SELL'` strings (`trade.js:20, 60`).
- **Timestamps**: `TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP` — server local time, no `TIME ZONE`. There is no application-side time-zone normalization.
- **JWT**: HS256, `{ id, email }` claim, `expiresIn: 24h` (`auth/login.js:30`). Header form `Authorization: Bearer <jwt>` (middleware splits on space).
- **Routes**: REST under `/api/v1/<group>/<action>`. Groups: `auth`, `trading`, `analytics`. WebSocket has no path prefix, only port `:8080`.
- **Two compose files**: root one for Postgres+Redis (broken `app` build), `trading-service/docker-compose.yml` for Kafka+Zookeeper. Neither stands up the full stack.
- **Emojis in logs**: extensive emoji usage in log statements (`✅`, `❌`, `🚨`, `🌐`). Treat as informational only.
- **"Leaderboard"**: top 10 by net worth. `net_worth = balance + Σ (quantity * current_price)` computed in `index.js:42-49` from the Postgres-side quantity and Redis-side current price. There is no historical net-worth time series.
- **"buy_stream" vs "trade_events"**: Redis Stream is the durable in-process queue between trade workers and the Kafka producer; Kafka topic is the durable cross-process queue between the producer and the SQL writer. Both carry the same payload shape (modulo serialization).
