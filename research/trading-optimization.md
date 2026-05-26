# Trading Path Optimization — Research & Recommendation

> Note on sources: WebSearch and WebFetch were denied in this environment, so the citations below point to the canonical, stable references for each pattern. Anything cited as `(source: ...)` is a well-known primary source that the implementation agent should re-read before building. Where I am drawing on operational practice rather than a specific page, I say so explicitly.

---

## Today's risks (summary)

Distilled from `/Users/jeffrey/paper-trading/CLAUDE.md` ("Hot Paths & Known Bottlenecks"). Each item: **what / impact**.

### Critical (correctness or data-loss; must fix before any throughput work)

| # | What | Impact |
|---|---|---|
| C1 | `enable.auto.commit=true` in `kafkaToSql.go:38`; offsets commit before Postgres commit | A crash between Kafka commit and PG commit silently loses accepted trades forever. Direct violation of zero-data-loss. |
| C2 | `processKafka` `seenUsers` per-batch dedup drops same-user trades in the same 2000-msg batch (`kafkaToSql.go:61`) | Trades are silently lost; offset is auto-committed regardless. |
| C3 | `routes/v1/trading/trade.js:85,88` price lookup bug — `prices[s.symbol]` on a positional array → `total = 0` | Users pay $0 per share; balance check is a no-op; balance never decremented. |
| C4 | Auth not enforced on `/trading/trade` (`trade.js:63`); `userId` trusted from body | Anyone can move anyone's money. |
| C5 | Sell path in Path A is broken (`trade.js:46-58`); not implemented in Go | Sells always 500/rollback. |
| C6 | `executeBuy` in Go writes `stock.Quantity` into `positions:<uid>` instead of `updated_quantity` (`trading-service/trade_service.go:72`) | Every BUY of an existing symbol overwrites accumulated quantity. Holdings corrupt. |
| C7 | Money is float64 in Go and JS, NUMERIC(12,2) in PG (CLAUDE.md item 22) | Off-by-cent drift; non-deterministic balance arithmetic. |
| C8 | `ExecuteBuy` calls `log.Fatalf` on any Redis error (`trade_service.go:32,47,53`) | One transient Redis blip kills the entire Go service. |
| C9 | `processRedisStream` Acks+Dels Redis msg immediately after async `producer.Produce` (CLAUDE.md item 20) | If the Kafka producer crashes before flush, the trade is gone from Redis. |
| C10 | `trade.js` builds INSERT via string concat (line 20, 31) | SQL injection through `symbol`. |
| C11 | No row lock or `SELECT ... FOR UPDATE` on `users.balance` in Path A | Concurrent trades for one user race; can overdraft. |
| C12 | No idempotency keys on either path | Client retries double-execute. |

### High (throughput, recovery, observability)

| # | What | Impact |
|---|---|---|
| H1 | Redis caches stale up to 10 min; Path A doesn't dual-write (CLAUDE.md item 7) | `/portfolio` and `/holdings` lie for up to 10 minutes after a trade. |
| H2 | `processRedisStream` no `Block` (`kafkaConsumer.go:43`) | Hot-loop and log spam; wastes CPU. |
| H3 | `processKafka` ticker only checked after a successful read (`kafkaToSql.go:53-86`) | Low-traffic batches never flush at the intended cadence. |
| H4 | `rollback:balance:<uid>` and `rollback:position:<uid>` keys leak forever (no TTL, never deleted) | Redis memory growth proportional to trade count. |
| H5 | No index on `trades(user_id)` or `(user_id, created_at)` (`db.sql:25`) | `trade_history` does a full scan per request. |
| H6 | `storePositionsToRedis` short-circuits if any positions key exists (`balancePositions.js:71`) | New users post-bootstrap never get warmed up. |
| H7 | `redisStorage.InitRedis` scans `stock:*` (never written), so cache always cold | Every Go worker first call falls through to Redis HGET. |
| H8 | No metrics, no traces; only emoji logs | SLO claims are unverifiable. |
| H9 | `TradeJobQueue` is a 10000-cap in-memory channel; `Default` returns 503 when full but trades silently fall behind on a process restart | Restarting Go service mid-load drops in-flight work. |
| H10 | FMP poll every 6 minutes; no staleness guard at order time | A stale price means a trade executes against a 6-minute-old quote. |

### Medium

| # | What | Impact |
|---|---|---|
| M1 | `updateLeaderboard` uses INNER JOIN; users with zero positions excluded (CLAUDE.md item 10) | New users never appear on the leaderboard. |
| M2 | `updateLeaderboard` `Promise.all` over sync work; O(N×P) every 6 min | Wasted event-loop cycles; will not scale past tens of thousands of users. |
| M3 | `services/getStockPrice.js` is dead code (wrong key shape) | Confusing for new contributors. |
| M4 | Two `docker-compose.yml`s; no `Dockerfile` for either service | Cannot stand up the full stack from one command. |
| M5 | Position quantity is `INT` in PG but `float64` in Go message types | Fractional shares silently truncated/rejected by driver. |

---

## Goals & SLOs

Targets are calibrated to a single-host dev box (the current state) with a clear path to a small managed cluster. Numbers are *targets the redesign must hit*, not what today's code does.

| Metric | Target |
|---|---|
| **Sustained accepted trades / sec** (single basket = one HTTP call, ≤5 symbols) | ≥ 2,000 TPS sustained, ≥ 5,000 TPS burst (1 min) on the recommended Go path |
| **Trade ack latency p50** (client request → 202 with idempotency key, durable) | ≤ 8 ms |
| **Trade ack latency p95** | ≤ 25 ms |
| **Trade ack latency p99** | ≤ 75 ms |
| **End-to-end commit lag** (ack → `users.balance` and `positions` reflect the trade in Postgres) | p95 ≤ 250 ms, p99 ≤ 1 s |
| **WebSocket portfolio broadcast lag** (commit → user's WS sees new balance/position) | p95 ≤ 500 ms |
| **Price freshness** (FMP fetch → reads return new price) | p95 ≤ 60 s during market hours |
| **Stale-price guardrail** | Reject any order priced against a quote older than 90 s |
| **Durability** | A 202 response *must* mean: (1) trade is in a Postgres-backed durable queue (outbox row, fsynced), (2) survives kill -9 of any service, broker, or DB; (3) replay produces the exact same `users.balance` and `positions` rows |
| **Idempotency window** | 24 h: a duplicate `trade_id` returns the original result and never re-executes |
| **Recovery RTO** | After a single-node Postgres restart, full trade pipeline catches up within 60 s |
| **Recovery RPO** | 0 — no acknowledged trade may be lost |

The 8 ms p50 is achievable because the *acknowledged* unit of work in the recommended design is a single durable INSERT into a `trade_intents` outbox plus a Redis SET for idempotency — not a balance/position write. The expensive work happens asynchronously but durably.

---

## Correctness model

The hard constraint is: an acknowledged trade is durable AND deterministic AND idempotent AND atomic with respect to balance + positions. Three candidate models:

### Option 1 — Postgres as source of truth, single writer per user, outbox to Kafka

- Submit path writes `trade_intents(idempotency_key UNIQUE, user_id, payload, status='PENDING')` and commits.
- A "trade executor" worker pool picks up PENDING intents, takes a row lock on `users` (`SELECT ... FOR UPDATE`), validates balance, applies the trade in the same Postgres transaction (UPDATE users, UPSERT positions, INSERT trades, UPDATE trade_intents.status='COMMITTED'), and inserts an `outbox` row in the same tx.
- A separate "outbox relay" tails the `outbox` table (logical replication / `pg_notify` / polling-with-skip-locked) and produces to Kafka with `acks=all` and the idempotent producer. After Kafka ack, it deletes the outbox row.
- Postgres is the unambiguous source of truth. Kafka is purely for downstream fan-out (WebSocket broadcasts, analytics).

### Option 2 — Redis Lua as the hot-path source of truth, Kafka as the durable log, Postgres as the projection

- A Lua script atomically checks balance and positions in Redis, decrements balance, updates position, writes to a Redis Stream — all atomic.
- A consumer relays the Redis Stream to Kafka.
- A second consumer projects Kafka into Postgres.
- Pro: extremely fast in-memory math. Con: Redis is now the source of truth and Redis is not as durable as Postgres (AOF every-second is the realistic default; AOF always is too slow). On a Redis crash you can lose accepted state.

### Option 3 — Event-sourced, Kafka log of record

- Submit writes a command to Kafka (`acks=all`, idempotent producer).
- A single partitioned consumer per `user_id` (key=user_id) materializes balance and positions into Postgres and Redis.
- Pro: deterministic replay, true exactly-once if you use Kafka transactions + Kafka Streams or a similar framework. Con: massive complexity; Kafka becomes a hard dependency for client ack; latency dominated by `acks=all` round-trip; rebuilds from scratch take a long time.

### Recommendation: **Option 1 — Postgres outbox, Postgres source of truth, Kafka for fan-out**

Justification:
- Postgres already holds the money and positions. Moving the source-of-truth elsewhere is unjustified given the team's stack and skills.
- The transactional outbox pattern guarantees atomicity between the business write and the message publication without 2PC (source: [microservices.io — Transactional Outbox](https://microservices.io/patterns/data/transactional-outbox.html); see also [Confluent — Outbox Pattern](https://www.confluent.io/learn/outbox-pattern/)).
- The submit endpoint can ack in <10 ms because the durable unit of work is a single tiny insert.
- Kafka stays in its lane: cross-service fan-out and replayable history. No exactly-once-Kafka headaches.

### Idempotency keys

- Client supplies `Idempotency-Key` header (UUIDv4) on every POST.
- Server stores it in `trade_intents.idempotency_key UNIQUE`. Duplicate submission → `INSERT ... ON CONFLICT DO NOTHING RETURNING id`; if no row returned, look up the existing one and return its current state.
- Window: keep `trade_intents` rows for 24h; older rows can be archived.

### Exact write ordering for one trade execution

Inside a single Postgres tx (BEGIN ... COMMIT):

1. `SELECT id, balance FROM users WHERE id = $1 FOR UPDATE`
2. `SELECT symbol, quantity, average_price FROM positions WHERE user_id = $1 AND symbol = ANY($2) FOR UPDATE` (sells need this to validate)
3. Validate basket against current balance/positions (decimal math).
4. `UPDATE users SET balance = balance - $cost WHERE id = $1` (or `+ $proceeds` for sell)
5. `INSERT INTO trades (...)` — bulk insert per leg
6. `INSERT INTO positions (...) ON CONFLICT (user_id, symbol) DO UPDATE SET quantity = positions.quantity + EXCLUDED.quantity, average_price = ...` for buys; `UPDATE positions SET quantity = quantity - $q` for sells (delete row if `quantity = 0`)
7. `UPDATE trade_intents SET status = 'COMMITTED', committed_at = NOW() WHERE id = $intent_id`
8. `INSERT INTO outbox (aggregate_id, event_type, payload, created_at) VALUES (...)`
9. `COMMIT`

Step 9 is the one durability boundary that matters. Everything before it is atomic; after it, all downstream effects (Redis cache update, WS broadcast, analytics) are *projections*, recoverable from Postgres + Kafka.

### Repair after partial failure

- If the executor crashes between step 1 and step 9: tx rollback. Intent stays `PENDING`; another executor picks it up. No corruption.
- If the executor crashes between step 9 and "delete the trade_intents.processing_lease": lease times out; another executor sees status=COMMITTED and skips the body, just refreshes the projection.
- If the outbox relay crashes after Kafka ack but before deleting the outbox row: at-least-once redelivery. Downstream consumers must be idempotent on `(event_id)`.
- If a downstream projection (Redis cache, WS broadcast) lags or fails: it is rebuilt from Postgres on demand. **No business state is in Redis.**

---

## Money representation

The current state — `NUMERIC(12,2)` in PG, `float64` in Go, JS `parseFloat` — is unsafe. `0.1 + 0.2 !== 0.3`. This will eventually corrupt balances.

### Recommendation

| Layer | Representation |
|---|---|
| Postgres | `NUMERIC(20, 4)` for monetary columns (balance, executed_price, average_price, totals). 4 decimal places to absorb intermediate fractional cents from weighted-average math without rounding loss. Final user-facing values can be quantized to 2 dp on read. |
| Postgres | `BIGINT` for `quantity` (was `INT`) — supports fractional-share-in-micro-units later if you choose; for now keep whole shares but `BIGINT` is free. |
| Go | [`github.com/shopspring/decimal`](https://github.com/shopspring/decimal) v1.4+ everywhere money is touched. Never `float64` for money. |
| Node | [`decimal.js`](https://github.com/MikeMcl/decimal.js/) v10+ everywhere money is touched. (Alternatives: `big.js` is smaller; `bignumber.js` is a sibling library; `decimal.js` is the right fit for currency.) |
| JSON wire | Money serialized as **strings** with fixed scale, e.g. `"123.4500"`. Never as JSON numbers — JSON parsers in JS coerce to IEEE 754 double. Quantity also serialized as string for consistency. |
| Validation | At every API boundary: parse string → Decimal; reject if scale > 4 or value < 0; never accept JSON-number money. |

### Migration plan (floats → decimal)

1. **Add wide columns alongside existing ones** (no rewrite):
   ```sql
   ALTER TABLE users ADD COLUMN balance_v2 NUMERIC(20,4);
   UPDATE users SET balance_v2 = balance::NUMERIC(20,4);
   ALTER TABLE trades ADD COLUMN executed_price_v2 NUMERIC(20,4);
   UPDATE trades SET executed_price_v2 = executed_price::NUMERIC(20,4);
   ALTER TABLE positions ADD COLUMN average_price_v2 NUMERIC(20,4);
   UPDATE positions SET average_price_v2 = average_price::NUMERIC(20,4);
   ```
2. **Dual-write window**: code writes both columns, reads `_v2`. Run for at least one full price-refresh cycle plus 24h.
3. **Switch reads** to `_v2` columns; keep dual-write.
4. **Drop the old columns** and rename:
   ```sql
   ALTER TABLE users DROP COLUMN balance;
   ALTER TABLE users RENAME COLUMN balance_v2 TO balance;
   ```
5. **Replace all float math** in code with `decimal.Decimal` (Go) and `Decimal` (Node). Add a CI lint that fails the build if `float64` or `parseFloat` appears in any file under `routes/v1/trading/`, `trading-service/services/trade/`, or `trading-service/services/workers/`.
6. **JSON wire**: change request/response schemas to require string-encoded amounts. Bump API to `/api/v2/trading/...` to avoid breaking existing clients.

(Source: [Postgres NUMERIC docs](https://www.postgresql.org/docs/current/datatype-numeric.html); [shopspring/decimal](https://github.com/shopspring/decimal); [decimal.js](https://github.com/MikeMcl/decimal.js/).)

---

## Throughput approaches

Four candidate architectures, evaluated against the SLOs and constraints.

| | (a) Optimize sync Node path | (b) All writes via Go + transactional outbox to Kafka | (c) Redis Streams as queue, Postgres batch writer | (d) Full event-sourced (Kafka log of record) |
|---|---|---|---|---|
| **Hot-path latency p50** | 5–15 ms (single PG round-trip) | 6–10 ms (PG insert into outbox) | 1–3 ms (XADD only), but ack semantics weak | 15–40 ms (acks=all to Kafka) |
| **Sustained TPS ceiling** | ~500–1500 (PG row-lock contention dominates) | 3,000–10,000 (sharded by user_id) | 10,000+ for ingest, but writer is the bottleneck | 5,000–20,000 with proper partitioning |
| **Complexity** | Lowest. One process, one DB. | Medium. Adds outbox table + relay. | High. Two pipelines, dedup needed. | Highest. Kafka Streams, partition rebalancing. |
| **Failure modes** | PG down → no trades; that's fine. | PG down → no trades; outbox absorbs Kafka outages. | Redis down → loss unless AOF=always (slow). | Kafka down → no trades; rebuild from log is slow. |
| **Recovery** | Trivial — one DB. | Trivial — one DB; outbox replays automatically. | Hard — Redis state may be lost on restart. | Hard — long catch-up replays. |
| **Zero-data-loss?** | Yes, if you fix Path A and add idempotency. | **Yes, by design.** | Conditional — depends on AOF settings. | Yes, but requires correct config. |
| **Fit for current team** | Easiest to ship. | Good — most patterns are well documented. | Tricky — Redis durability is subtle. | Overkill — operational burden too high. |
| **Reuses existing stack** | Node only — Go service becomes vestigial. | Go for hot path, Node for REST/WS, PG outbox, Kafka for fan-out. **Best fit.** | Yes, but Kafka becomes optional/redundant. | Yes, but Postgres becomes a projection. |

(a) is fine for correctness but caps the SLO at ~1k TPS; the row-lock-per-user model under sync HTTP is the limit.

(b) hits all SLOs, makes Postgres the unambiguous source of truth, and uses each piece of the existing stack for what it's best at. Kafka stops being on the durability-critical path and becomes the fan-out bus it should have been from day one.

(c) trades safety for speed. Redis Streams with AOF=everysec can lose up to 1s of data on crash (source: [Redis persistence docs](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)). For paper trading this *might* be acceptable but it violates the user-stated zero-loss constraint.

(d) is the right answer at 50,000+ TPS and a 5+ engineer team. It is the wrong answer here. Exactly-once across Kafka + external systems requires Kafka transactions (`transactional.id`, read-committed isolation) plus an idempotent sink — see [Confluent — Exactly-Once Semantics](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/). The number of footguns is high.

**Choose (b).**

---

## Hot path redesign

The recommended design for **buy** and **sell**, naming each component and transactional boundary.

### Components

- `gateway` (Node/Express, port 3000): auth, REST, WS, *and* the trade submit endpoint. Submits to PG.
- `executor` (Go, replaces today's trading-service): pulls PENDING trade_intents from PG, validates, commits, writes outbox row.
- `outbox-relay` (Go, separate goroutine pool inside trading-service): tails `outbox` table, produces to Kafka.
- `cache-projector` (Go consumer of Kafka topic `trades.committed.v1`): updates Redis `user_balance` and `positions:<uid>`.
- `ws-fanout` (Node consumer of Kafka): pushes per-user updates to WS.
- `pricing` (Node, today's `services/stockService.js`): writes `stockPrices` hash + `price_quotes` table.

### Buy sequence

```
Client                Gateway(Node)        Postgres            Executor(Go)        Kafka         Cache/WS
  │  POST /v2/trade     │                     │                    │                 │              │
  │  Idempotency-Key:U  │                     │                    │                 │              │
  │ ──────────────────▶ │                     │                    │                 │              │
  │                     │ INSERT trade_intents│                    │                 │              │
  │                     │  (idem_key UNIQUE,  │                    │                 │              │
  │                     │   status=PENDING)   │                    │                 │              │
  │                     │ ─────────────────▶  │                    │                 │              │
  │                     │ ◀─── intent_id ───  │                    │                 │              │
  │ ◀── 202 {intent_id} ┤                     │                    │                 │              │
  │                     │       ▲   pg_notify │                    │                 │              │
  │                     │       └─────────────┼──── NOTIFY ───────▶│                 │              │
  │                     │                     │                    │ BEGIN           │              │
  │                     │                     │ ◀ SELECT FOR UPDATE│ users + posns   │              │
  │                     │                     │                    │ validate        │              │
  │                     │                     │ ◀── UPDATE users ──┤                 │              │
  │                     │                     │ ◀── INSERT trades ─┤                 │              │
  │                     │                     │ ◀── UPSERT posns ──┤                 │              │
  │                     │                     │ ◀── UPDATE intent ─┤                 │              │
  │                     │                     │ ◀── INSERT outbox ─┤                 │              │
  │                     │                     │ ◀────── COMMIT ────┤                 │              │
  │                     │                     │                    │                 │              │
  │  GET /v2/trade/:id  │                     │                    │ outbox-relay    │              │
  │ ──────────────────▶ │ SELECT trade_intents│                    │ FOR UPDATE      │              │
  │ ◀── COMMITTED ──────┤                     │                    │ SKIP LOCKED     │              │
  │                     │                     │                    │ produce(acks=all)──▶            │
  │                     │                     │                    │ DELETE outbox  ◀ack            │
  │                     │                     │                    │                 │ HSET balance │
  │                     │                     │                    │                 │ HSET posn    │
  │                     │                     │                    │                 │ ws.send(uid) │
```

### Sell sequence

Identical except step inside the executor tx: `SELECT ... FOR UPDATE` on `positions(user_id, symbol)` for every leg, validate `quantity >= sell_qty`, `UPDATE positions SET quantity = quantity - $sell_qty WHERE user_id = $u AND symbol = $s`, `UPDATE users SET balance = balance + $proceeds`. If `quantity = 0` post-update, `DELETE FROM positions`. Insert `trades` row with `trade_type = 'SELL'`.

### Transactional boundary

The only durability boundary the client cares about is the **first** PG commit (the `trade_intents` insert). The 202 response is sent only after that commit returns. Everything else is recoverable.

### Why `pg_notify` and not polling?

`pg_notify` wakes executors immediately (sub-millisecond) instead of polling-loop latency. Fall back to a 1s `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 100` poll for safety in case a NOTIFY is missed during a connection bounce.

---

## Idempotency & deduplication

### Client contract

- Every `POST /api/v2/trading/trade` MUST include header `Idempotency-Key: <uuidv4>`.
- Server returns `400` if missing.
- Same key + same body within 24h → returns the original response. Same key + different body → `409 Conflict`. (Pattern from Stripe; see [Stripe — Idempotency](https://stripe.com/docs/api/idempotent_requests).)

### Server-side dedup

- `trade_intents.idempotency_key` is `UNIQUE`.
- Insert with `ON CONFLICT (idempotency_key) DO UPDATE SET retry_count = trade_intents.retry_count + 1 RETURNING id, status, retry_count`.
- If `retry_count > 1`, return the existing row's status without enqueuing.
- Hash the request body and store as `idempotency_body_hash`; reject mismatched hashes with 409.

### Kafka and downstream dedup

- Each outbox row has `event_id UUID` (also the Kafka message key, alongside `user_id` for partitioning).
- Cache-projector and WS-fanout maintain a small Redis set `seen_events` (TTL 1h) keyed on `event_id`. SETNX before processing; skip if already seen.
- All projections must be idempotent: `HSET` (not `HINCRBY`) for balance, full-symbol overwrite for positions.

### Retry semantics

- Client retries on 5xx and on network error using the same `Idempotency-Key`.
- Server retries are bounded: outbox-relay exponentially backs off Kafka producer errors (100ms → 5s, capped). After 10 failures, move event to `outbox_dead` and alert.

### Replay safety

- Kafka topic `trades.committed.v1` retention 14 days, compacted by `event_id`. Re-running a projection from offset 0 is safe.
- Postgres tables can be rebuilt from outbox + Kafka by replaying into a fresh DB; the executor is the only writer.

---

## Concurrency & locking

Three viable models:

| Model | How | Pros | Cons |
|---|---|---|---|
| **Per-user `SELECT FOR UPDATE`** | Lock the `users` row; positions rows for the affected symbols. | Simple, deterministic, correct. Postgres is the arbiter. | Hot user becomes a serial point. |
| **Postgres advisory locks** keyed on `user_id` | `SELECT pg_advisory_xact_lock($user_id)` | Faster than row lock for very contended users; lock held for the tx. | Not visible in `pg_locks` the same way; can be confusing operationally. |
| **Optimistic concurrency** with version column | `UPDATE users SET balance = ..., version = version+1 WHERE id = $1 AND version = $v`; retry on 0-row-count. | No lock held; great for low contention. | Retry storms under high contention; harder for multi-row trades. |

### Recommendation: **Per-user `SELECT FOR UPDATE` + per-symbol `SELECT FOR UPDATE` on positions**, partitioned by user across executor workers.

A single user's trades are serial, but different users run in parallel. The executor pool consumes `trade_intents` with `SELECT FOR UPDATE SKIP LOCKED LIMIT 1` and uses `user_id % N` partitioning so the same user's intents are usually picked up by the same worker (cache locality, not correctness). Correctness comes from the row locks.

### Concrete SQL — buy executor

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;

-- 1) Acquire next pending intent for any user (skip-locked = lock-free contention)
WITH next_intent AS (
  SELECT id, user_id, payload
  FROM trade_intents
  WHERE status = 'PENDING'
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
SELECT id, user_id, payload FROM next_intent;
-- (returned to app; app decodes payload to get symbols + quantities)

-- 2) Lock the user row
SELECT id, balance FROM users WHERE id = $user_id FOR UPDATE;

-- 3) Lock affected position rows (creates none if absent; that's fine — UPSERT below)
SELECT symbol, quantity, average_price
FROM positions
WHERE user_id = $user_id AND symbol = ANY($symbols)
FOR UPDATE;

-- 4) Validate in app code (decimal math). If insufficient balance:
--    UPDATE trade_intents SET status='REJECTED', reason='INSUFFICIENT_FUNDS' WHERE id=$intent_id;
--    COMMIT and return.

-- 5) Apply
UPDATE users SET balance = balance - $total_cost, updated_at = NOW() WHERE id = $user_id;

INSERT INTO trades (user_id, symbol, trade_type, executed_price, quantity, idempotency_event_id, created_at)
VALUES /* one row per leg */;

INSERT INTO positions (user_id, symbol, quantity, average_price)
VALUES /* per leg */
ON CONFLICT (user_id, symbol) DO UPDATE SET
  quantity = positions.quantity + EXCLUDED.quantity,
  average_price = (
    (positions.quantity * positions.average_price + EXCLUDED.quantity * EXCLUDED.average_price)
    / NULLIF(positions.quantity + EXCLUDED.quantity, 0)
  ),
  updated_at = NOW();

UPDATE trade_intents SET status='COMMITTED', committed_at=NOW() WHERE id = $intent_id;

INSERT INTO outbox (event_id, aggregate_id, event_type, payload, created_at)
VALUES (gen_random_uuid(), $user_id, 'TRADE_COMMITTED', $json, NOW());

COMMIT;
```

(Source: [PG SELECT FOR UPDATE / SKIP LOCKED docs](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE).)

### Indexes required

```sql
CREATE INDEX trades_user_id_created_at_idx ON trades (user_id, created_at DESC);
CREATE INDEX trade_intents_status_created_at_idx ON trade_intents (status, created_at) WHERE status = 'PENDING';
CREATE INDEX outbox_created_at_idx ON outbox (created_at);
CREATE INDEX positions_user_id_idx ON positions (user_id);  -- (user_id, symbol) UNIQUE already exists
```

---

## Kafka durability

Today's config (CLAUDE.md): `enable.auto.commit=true`, no `acks` setting given (defaults to `acks=1` for Confluent's Go client), no idempotent producer. The "auto-commit before Postgres commit" bug is the textbook cause of message loss.

### Producer config (outbox-relay)

```ini
acks=all
enable.idempotence=true
max.in.flight.requests.per.connection=5     # required ≤5 with idempotence
retries=2147483647
delivery.timeout.ms=120000
compression.type=zstd
linger.ms=5
batch.size=131072
transactional.id=outbox-relay-<host>-<shard>   # only if you want EoS to Kafka
```

`enable.idempotence=true` ensures producer-side dedup within a session (source: [Confluent — Idempotent Producer](https://docs.confluent.io/platform/current/installation/configuration/producer-configs.html#producer-configs-enable-idempotence)). With `acks=all` and a min ISR of 2 on a 3-broker cluster, you survive a single broker loss without data loss.

### Consumer config (cache-projector, ws-fanout)

```ini
enable.auto.commit=false
isolation.level=read_committed              # if producer uses transactions
auto.offset.reset=earliest
session.timeout.ms=30000
max.poll.interval.ms=300000
fetch.min.bytes=1024
```

### Commit ordering — the critical fix for CLAUDE.md item C1

Replace today's auto-commit with **manual commit AFTER the side-effect**:

```go
for {
    msgs := consumer.Poll(100)
    for _, m := range msgs {
        if err := projectToRedis(m); err != nil {
            // do NOT commit; backoff; the broker will redeliver
            time.Sleep(retry)
            continue
        }
    }
    // commit only after every projection succeeded
    consumer.CommitOffsets(...)
}
```

For the **outbox relay**, the analog is: produce → wait for delivery report (with `acks=all`) → only then `DELETE FROM outbox WHERE event_id = $1`.

### Exactly-once semantics tradeoff

- True EoS across Kafka + Postgres requires either Kafka transactions with a transactional sink (Kafka Connect with the JDBC sink in EoS mode), or the outbox pattern.
- We get **effectively-once** with the outbox: at-least-once Kafka delivery + idempotent consumers + dedup on `event_id`. This is simpler and cheaper than Kafka transactions and meets every SLO above. (See [Confluent — EoS deep dive](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/).)

### Dead-letter topic

- `trades.committed.v1.dlq` — same partitioning, retention 30 days.
- Consumer routes to DLQ after 5 failed projection attempts with non-transient error.
- Manual replay tool: `dlq-replay --since=<ts>`.

### Replay strategy

- Cache-projector can be reset to offset 0 to rebuild Redis from scratch (full HSET overwrite is safe because we use absolute values, not deltas — see Hot path redesign).
- WS-fanout reset to "latest" only; replaying old broadcasts to live users is wrong.

---

## Pricing pipeline

### Today's problem

`fetchStockPrices()` runs every 6 minutes (`index.js:85`), `pushStockPrices()` broadcasts to every WS client, and trade routes use the resulting hash directly with no staleness check.

### Recommendation

| Concern | Fix |
|---|---|
| Refresh cadence | Move to **2 tiers**: a 1s "hot" tier for the top-50 most-traded symbols (FMP supports per-symbol streams or batched quote calls; verify rate limit), and a 60s tier for the rest. Run inside `pricing` service. |
| Rate limit | Coalesce into batched `?symbol=AAPL,MSFT,...` calls. Cap requests/min at FMP's documented limit minus 20%. Implement token bucket with [`bottleneck`](https://github.com/SGrondin/bottleneck) (Node) or [`x/time/rate`](https://pkg.go.dev/golang.org/x/time/rate) (Go). |
| Storage | Continue `HSET stockPrices`, but **also** insert into `price_quotes (symbol, price NUMERIC(20,4), source, fetched_at TIMESTAMPTZ)` so we have an auditable history (and so the executor can validate against a row, not a Redis value). Keep last 24h, partition daily. |
| Staleness guard | Every quote in Redis carries an `as_of` timestamp: `HSET stockPrices AAPL "215.34|2026-05-06T19:23:01.234Z"`. Trade executor reads timestamp; if `now - as_of > 90s`, reject the intent with `STALE_PRICE`. |
| WS push vs trade-path pull | **Pull** on the trade path (read from Redis directly; staleness check). **Push** to WS clients for chart updates. Never let WS push drive the trade path's price source — too easy to race. |
| Cache invalidation | None needed; `HSET` overwrites, atomic per field. WS broadcast fans the new value out to clients. |

### Why not subscribe FMP → Kafka?

FMP doesn't offer a free push API at the rate we need. The poll-and-fan-out model is correct here. (If you upgrade to a streaming feed later, replace `pricing` with a Kafka producer; nothing else changes.)

---

## Observability

The minimum bar to *believe* the SLOs.

### Metrics (OpenTelemetry → Prometheus)

| Metric | Type | Labels |
|---|---|---|
| `trade_submit_total` | counter | result={accepted, rejected, duplicate} |
| `trade_submit_latency_seconds` | histogram | (50/95/99 buckets) |
| `trade_intents_pending` | gauge | (PG count of `status='PENDING'`) |
| `trade_executor_duration_seconds` | histogram | result={committed, rejected, error} |
| `trade_executor_lock_wait_seconds` | histogram | resource={users_row, positions_row} |
| `outbox_lag_rows` | gauge | (count of unrelayed outbox rows) |
| `outbox_oldest_age_seconds` | gauge | |
| `kafka_producer_inflight` | gauge | topic |
| `kafka_consumer_lag` | gauge | topic, partition |
| `projection_duration_seconds` | histogram | projection={cache, ws_fanout} |
| `pg_pool_in_use` / `pg_pool_idle` | gauge | service |
| `redis_pool_in_use` | gauge | service |
| `price_freshness_seconds` | histogram | symbol_tier={hot, warm} |
| `stale_price_rejections_total` | counter | symbol |

### Traces (OpenTelemetry → Tempo or Jaeger)

- One trace per submitted trade: `gateway.submit` → `executor.process` → `outbox.relay` → `projector.apply` → `ws.broadcast`.
- Use `Idempotency-Key` as the trace's correlation ID.
- Use [`opentelemetry-instrumentation-pg`](https://www.npmjs.com/package/@opentelemetry/instrumentation-pg) for Node and [`go.opentelemetry.io/contrib/instrumentation/database/sql/otelsql`](https://pkg.go.dev/github.com/XSAM/otelsql) for Go.

### Structured logs

- JSON only. Fields: `ts`, `level`, `service`, `trace_id`, `span_id`, `user_id`, `intent_id`, `event_id`, `outcome`, `duration_ms`. No more emoji-as-status (CLAUDE.md item: "extensive emoji usage").
- Use [`pino`](https://github.com/pinojs/pino) (Node) and [`zerolog`](https://github.com/rs/zerolog) or `slog` (Go).

### Dashboards

- Trade SLO board: p50/p95/p99 latency, accept rate, rejection rate, outbox lag, Kafka lag.
- Money-safety board: deltas between PG balance and Redis balance per user (alert > $0.01); decimal-vs-float drift counter (should be 0).
- Failure-injection board: error rates by component during chaos runs.

### Alerts

- p95 trade ack > 50 ms for 5 min.
- outbox_oldest_age_seconds > 30s.
- kafka_consumer_lag > 1000 messages on `trades.committed.v1`.
- stale_price_rejections_total rate > 1/s.
- any `panic` / `Fatal` log line.

---

## Stress-testing plan

`stressTest.js` today is a fire-and-forget HTTP load gen with no assertions and no chaos. It needs to become a correctness + throughput suite.

### Scenarios

1. **Steady-state TPS ramp.** 100 → 5000 TPS over 10 min, hold each step 2 min. Pass: p99 ≤ 75 ms; 0 rejections that aren't `INSUFFICIENT_FUNDS`/`STALE_PRICE`.
2. **Hot-user contention.** 1 user, 500 concurrent buy/sell of $1 amounts for 60s. Pass: balance is exactly `start - sum(buys) + sum(sells)` to the cent. Number of trades committed equals number accepted.
3. **Idempotent retry.** 1000 trades, each retried 3× with the same `Idempotency-Key`. Pass: each `Idempotency-Key` produces exactly one trade row.
4. **Decimal precision.** 10,000 trades of $0.10 each. Pass: balance decremented by exactly $1000.0000.
5. **Sell against insufficient quantity.** Pass: rejected, no row inserted, no balance change.

### Failure injection

| Inject | Expected behavior | Pass criterion |
|---|---|---|
| `kill -9` Kafka broker mid-test (1 of 3) | Producer retries; consumers rebalance | 0 lost trades; latency p95 spike ≤ 5 s |
| `kill -9` executor mid-trade | Lease expires; another executor picks up | 0 lost or duplicated trades |
| `kill -9` cache-projector | Redis goes stale; PG correct | After restart, projector catches up; no inconsistency |
| `pg_ctl stop` Postgres | Submit returns 503 | After restart, all in-flight intents either commit or rollback cleanly |
| Network partition Redis ↔ Go | Executor does not depend on Redis (PG is SoT) | No effect on trade commits |
| Saturate Kafka producer queue | Outbox grows; submit still succeeds | Outbox eventually drains; no loss |

### Leak / corruption checks (run after every test)

```sql
-- Balance drift: sum of trades vs balance change
SELECT u.id,
  (SELECT COALESCE(SUM(CASE trade_type WHEN 'BUY' THEN -executed_price*quantity ELSE executed_price*quantity END), 0) FROM trades WHERE user_id = u.id) AS expected_delta,
  u.balance - 10000 AS actual_delta
FROM users u
WHERE u.balance - 10000 != (SELECT COALESCE(SUM(...), 0) FROM trades WHERE user_id=u.id);
-- Expected: 0 rows.

-- Position drift: sum of trade quantities vs position quantity
SELECT p.user_id, p.symbol, p.quantity,
  (SELECT COALESCE(SUM(CASE trade_type WHEN 'BUY' THEN quantity ELSE -quantity END),0)
   FROM trades WHERE user_id = p.user_id AND symbol = p.symbol) AS sum_trades
FROM positions p
WHERE p.quantity != (SELECT ...);
-- Expected: 0 rows.

-- Outbox should drain
SELECT COUNT(*) FROM outbox; -- Expected: 0 within 10s of test end.

-- Idempotency check
SELECT idempotency_key, COUNT(*) FROM trade_intents GROUP BY 1 HAVING COUNT(*) > 1;
-- Expected: 0 rows.
```

### Pass/fail criteria

- All five scenarios pass their assertions.
- Every failure-injection scenario passes its criterion.
- Every leak/corruption SQL returns 0 rows.
- Throughput: ≥ 2000 TPS sustained.

### Tooling

- [`k6`](https://k6.io/) for HTTP load (better than ad-hoc Node script — gives proper percentile histograms).
- [`toxiproxy`](https://github.com/Shopify/toxiproxy) for network-partition injection between services.
- A small Go binary `chaos.go` that picks random pods and `kill -9`s them on a schedule.

---

## Migration plan

Each step is independently shippable. Each is reversible until the one after it.

| # | Step | Risk to live data | Rollback |
|---|---|---|---|
| 1 | **Critical bug fixes** in current code (no architecture change): fix `prices[s.symbol]` (C3), enforce auth on `/trade` (C4), parameterize SQL (C10), add `SELECT FOR UPDATE` to Path A (C11), remove `log.Fatalf` from Go (C8), fix `executeBuy` quantity overwrite (C6), kill `seenUsers` dedup (C2), set `enable.auto.commit=false` + manual commit after PG (C1). | Low. Behavior-preserving. | Revert. |
| 2 | **Add idempotency**: new `Idempotency-Key` header, `trade_intents` table, dedup on insert. Make it optional first, log misses, then make required. | Low. New table, no data change. | Drop table, remove header check. |
| 3 | **Money migration** (see "Money representation" section): add `_v2` columns, dual-write, swap reads, drop old. Switch all trading code to `decimal.js` / `shopspring/decimal`. | Medium. Touches every monetary read/write. | Keep old columns for one release; revert reads. |
| 4 | **Add indexes**: `trades(user_id, created_at)`, `trade_intents(status, created_at) WHERE status='PENDING'`, `outbox(created_at)`, `positions(user_id)`. | None. `CREATE INDEX CONCURRENTLY`. | `DROP INDEX`. |
| 5 | **Build the executor + outbox**: ship Go executor as a new binary. Have it consume PENDING intents and apply via PG tx with the SQL above. Insert outbox row but no relay yet. Run alongside the existing Path A. Compare behavior with shadow mode (executor does dry-run, logs deltas) for 24h. | Low. Shadow only. | Disable executor. |
| 6 | **Switch gateway to enqueue-only**: gateway endpoint inserts into `trade_intents` and returns 202; executor does the work. Remove direct PG writes from `trade.js`. | Medium. Behavioral change for clients (now async). Keep the old `/v1/trade` synchronous endpoint as compatibility shim that polls intent state for 2s before timing out. | Re-enable Path A. |
| 7 | **Build outbox-relay**: produce to Kafka with `acks=all` + idempotent producer; delete outbox row on ack. | Low. Add-only. | Stop relay; outbox grows; flush manually later. |
| 8 | **Build cache-projector**: Kafka → Redis updates. Replace 10-min `storeBalanceToRedis` sweep with continuous projection. Keep the sweep as a nightly reconcile job. | Low. Redis is a cache. | Re-enable old sweep. |
| 9 | **Build ws-fanout**: per-user portfolio events on commit. Add WS subscription protocol. | Low. New WS message types. | Disable. |
| 10 | **Pricing fixes**: 2-tier refresh, `as_of` timestamp, staleness guard at executor. | Low. | Revert. |
| 11 | **Observability**: instrument with OTel; build Grafana dashboards; configure alerts. | None. | n/a. |
| 12 | **Decommission Path A**: remove the synchronous compatibility shim once metrics show 100% client adoption of `/v2`. | Low. | Re-enable. |

### DB migrations called out

- `db.sql` is currently a single bootstrap file. Adopt a migrator: [`golang-migrate`](https://github.com/golang-migrate/migrate) (Go) or [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate) (Node). Pick one, version the existing schema as migration `0001_init.sql`, and put every step above behind a numbered migration. Migrations 0002–00xx correspond to the steps above.
- `trade_intents`, `outbox` tables created in step 2 and 5.
- Money columns in step 3 require `CREATE INDEX CONCURRENTLY` for the unique idempotency_key to avoid blocking writes. Use `CHECK` constraints (`balance >= 0`) only after the C3 bug is verified fixed in production.

---

## Recommendation

**Build option (b): Postgres-as-source-of-truth with a transactional outbox to Kafka, a Go executor for the hot path, and Node retained for REST/WS/auth.** This is the only design that satisfies the zero-data-loss constraint without 2PC, hits the 2000+ TPS SLO, and uses each piece of the existing stack for its strength: Postgres for ACID money, Kafka for cross-service fan-out, Redis for the read cache, Node for the user-facing edge, Go for the high-throughput durable writer.

The hot path is: client → Node gateway inserts a `trade_intents` row with a unique `Idempotency-Key` and returns 202 within ~8 ms; Go executor pool picks up `PENDING` intents via `SELECT FOR UPDATE SKIP LOCKED`, takes a row lock on the affected `users` row plus the affected `positions` rows, performs the entire balance/trades/positions/intent/outbox write in a single Postgres transaction, and commits. An outbox relay produces the event to Kafka with `acks=all` and an idempotent producer config, then deletes the outbox row only after Kafka delivery is acknowledged. Cache-projector and ws-fanout consume Kafka with `enable.auto.commit=false`, manual commit *after* the side-effect succeeds. Replace every `float64`/`parseFloat` in the trading paths with `shopspring/decimal` and `decimal.js`; widen money columns to `NUMERIC(20,4)`; require string-encoded amounts on the JSON wire.

This design pays its complexity bill once: one new table (`trade_intents`), one new table (`outbox`), one new service (executor; the existing `trading-service` is the right home for it), and a swap of three Kafka config flags. Everything else — Redis cache, WS broadcast, leaderboard — becomes a *projection* of Postgres, recoverable on demand. The result is a system where "ack" means "durable", retries are safe by construction, sells work the same way as buys, money math is exact, and a `kill -9` of any component does not lose a single accepted trade.

---

## Citations

Primary sources the next implementation agent should re-read before building. (Web access was restricted in this research environment — these are the canonical entry points.)

- (source: [microservices.io — Transactional Outbox](https://microservices.io/patterns/data/transactional-outbox.html))
- (source: [Confluent — The Outbox Pattern](https://www.confluent.io/learn/outbox-pattern/))
- (source: [Confluent — Exactly-Once Semantics in Apache Kafka](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/))
- (source: [Confluent — Producer configurations: enable.idempotence, acks, transactional.id](https://docs.confluent.io/platform/current/installation/configuration/producer-configs.html))
- (source: [Postgres — SELECT FOR UPDATE / SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE))
- (source: [Postgres — NUMERIC and DECIMAL types](https://www.postgresql.org/docs/current/datatype-numeric.html))
- (source: [Redis — Streams (XADD / XREADGROUP / XACK)](https://redis.io/docs/latest/develop/data-types/streams/))
- (source: [Redis — Persistence (AOF, RDB)](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/))
- (source: [shopspring/decimal](https://github.com/shopspring/decimal))
- (source: [decimal.js](https://github.com/MikeMcl/decimal.js/))
- (source: [Stripe — Idempotent Requests](https://stripe.com/docs/api/idempotent_requests))
- (source: [OpenTelemetry — Collector and SDKs](https://opentelemetry.io/docs/))
