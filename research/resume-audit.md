# Resume Audit — paper-trading

> Honest, code-verified audit of what in this project is worth putting on a software-engineer resume.
> Maturity tags: production-ish / working-demo / scaffolded / broken. Bullet confidence: [SOLID] / [THIN] / [ASPIRATIONAL].

## Inventory

| Component | Stack | What it actually does | Maturity | ~LOC |
|---|---|---|---|---|
| Node REST + cron service (`index.js`, `routes/`, `services/`) | Node 20, Express, `pg`, `node-redis` v4 | JWT auth (register/login), synchronous `POST /trade`, analytics reads, 6-min FMP price poll, 6-min leaderboard rebuild, 10-min Redis warm-up | Working-demo with serious bugs (broken sell, price-lookup bug zeroes cost, no auth on `/trade`, string-concat SQL) | ~600 |
| WebSocket server (`wsServer.js`) | `ws` | One global broadcast channel `:8080`: full `stockPrices` hash + top-10 leaderboard on connect & after refresh | Working-demo (no auth, no subscriptions, typo `ledaerboard`) | 61 |
| Postgres schema (`db.sql`) | PG 16 | `users/trades/positions` used; `orders/watchlists` schema-only | Working-demo; no `trades(user_id)` index; money `NUMERIC(12,2)` vs float code | 104 |
| Go trading-service | Go, chi, go-redis v9, lib/pq, confluent-kafka-go v2 | Async BUY: HTTP `:8081` → chan(10k) → 30 workers → Redis Stream `buy_stream` → 2 Kafka producers → topic `trade_events` → 15 consumers → batched PG upsert (weighted-avg cost basis); `main()` self-load-tests for 5 min on boot | Working-demo/partly broken: `log.Fatalf` on Redis err, auto-commit-before-PG loss, `seenUsers` drops trades, position write uses per-trade qty, no sell, no idempotency; `server/`+`trade_service.go` orphaned | ~900 active (+~1100 commented-out in `main.go`) |
| AI service (`ai-service/`) | Python 3.11, FastAPI, psycopg3, optional lightgbm/sklearn, optional confluent-kafka | Strategy registry + guardrails + orchestrator: `/strategies/{id}/run` scores a symbol (LightGBM if artifact present else deterministic momentum on **fabricated** prices), inserts `signals`+`recommendations`, emits Kafka signal, in `auto` mode runs server-side guardrails (position/notional/drawdown/cooldown/kill-switch) then POSTs to Node `/trade`; append-only `ai_audit`; auto-applies idempotent migrations | Working-demo, internally consistent, 4 passing pytest integration tests (sqlite shim); prices synthetic, no real model artifact, LLM "explainer" from research doc not built | ~1000 |
| Next.js frontend (`web/`) | Next 14 app router, TS, Tailwind, recharts | Dashboard, stock pages, AI panel (talks to real ai-service), `/manager` load-test viz, `app/api/*` BFF route handlers with timeouts + graceful fallback to canned data; Puppeteer snapshot scripts; design-iteration folder | Working-demo; much renders synthetic data by design; `/manager` "load test" is ≤50 `/api/health` probes scaled up | ~3000 |
| Stress tooling (`stressTest.js`, `tests/benchmark.js`, `test.js`) | Node + axios + faker | `stressTest.js`: 200-concurrent `POST /trade` for 1s, prints TPS/avg-latency, no assertions; `benchmark.js`: hits unmounted `new_trade` (404s); `test.js`: faker seeder (9000 users) | Scaffolded; no assertions, no committed numbers, one dead | ~360 |
| Docker/compose | 4 Dockerfiles + `docker-compose.yml` | Single-network: postgres+redis+zookeeper+kafka+app+trading-service+ai-service+web; PG mounts `db.sql`; Redis mounts committed 27 MB `dump.rdb` | Working-demo, recently added, not proven end-to-end in repo history | ~160 |
| Research docs | Markdown | `trading-optimization.md`: full transactional-outbox redesign + SLOs + chaos plan; `ai-trading-research.md`; `ai-component-constraints.md` | Design-only (well-written, mostly aspirational) | ~1050 |

## Genuinely impressive bits

1. **Working multi-hop async write pipeline in Go** (HTTP → channel → Redis Streams w/ consumer groups → Kafka → size+timeout-batched single-tx bulk upsert with weighted-average cost-basis SQL, `kafkaToSql.go:122-198`). Evidence: wired into `main()`, prints before/after DB trade counts. Caveat: loses data on crash, drops same-batch trades, crashes on transient Redis errors.
2. **The ai-service is the cleanest code in the repo** — coherent strategy/guardrail/orchestrator split, server-side guardrail enforcement, append-only audit, sha256 `client_order_id` idempotency, auto-applied idempotent migrations, 4 passing integration tests on a hand-written sqlite-emulates-psycopg shim (`ai-service/app/*`, `tests/test_orchestrator.py`).
3. **A 600-line architecture review (`research/trading-optimization.md`)** that correctly diagnoses 12 real correctness/data-loss bugs and specs the textbook fix (transactional outbox, PG source of truth, idempotency keys, decimal money, `SELECT FOR UPDATE SKIP LOCKED` executor, manual-commit-after-side-effect). Doc, not code.
4. **Polyglot system that talks to itself end-to-end in one place** — Python ai-service → Node `/trade` HTTP, stubbed in tests (`executor.py`, `test_auto_execute_success...`). Three languages, shared PG+Redis+Kafka.
5. **BFF layer in Next.js that gracefully degrades** — `web/app/api/*` wrap upstreams in timeouts, fall back to canned data, document upstream gaps; `portfolio/history/route.ts` reconstructs portfolio value by replaying trade history.
6. **Kafka producer tuning + Redis Streams consumer-group plumbing works** — `kafkaConsumer.go` (8M buffer), `XReadGroup`/`XAck`/`XDel`, idempotent `EnsureRedisStream`.

## Resume-bullet candidates (current state)

1. [THIN] "Built a high-throughput Go trade-ingestion pipeline (HTTP→channel→Redis Streams→Kafka→batched Postgres) at ~N trades/sec." — needs measurement: run the `main()` self-load-test on a real DB; also report sent-vs-stored (it loses trades today).
2. [THIN] "Designed/shipped a Python FastAPI AI strategy service with server-side risk guardrails (position/notional/drawdown caps, per-symbol cooldown, kill switch), idempotent order IDs, append-only audit; integration-tested." — defensible as a service; don't say "ML model" (scores fabricated prices, no artifact).
3. [SOLID] "Authored a 600-line architecture review identifying 12 correctness/data-loss bugs in a trade pipeline and specced the transactional-outbox redesign." — true; frame as design/review.
4. [THIN] "Implemented JWT auth (bcrypt, HS256) for an Express trading API." — true but `/trade` doesn't use it. Fix first.
5. [THIN] "Built a real-time WebSocket layer broadcasting prices + leaderboard." — true; one global firehose, no auth/subscriptions.
6. [SOLID] "Built a polyglot system — Node REST/WS, Go async worker service, Python ML service, Next.js frontend — sharing Postgres/Redis/Kafka, orchestrated with docker-compose." — true today.
7. [THIN] "Implemented batched bulk upserts with weighted-average cost-basis accounting (`ON CONFLICT DO UPDATE`)." — SQL is correct; surrounding pipeline buggy.
8. [ASPIRATIONAL] "2,000+ TPS sustained, zero acknowledged-trade loss under broker-kill chaos." — SLO target only; not built.
9. [THIN] "Created a load-testing harness reporting TPS + latency percentiles." — `stressTest.js` has avg-latency only, no percentiles, no assertions; `/manager` is not real load testing.
10. [SOLID] "Designed an idempotent migration system + guardrail audit log for an automated-trading service; verified kill-switch and limit-breach rejection with tests." — true.
11. [THIN] "Built a Next.js BFF aggregating multiple backends with timeouts/graceful degradation; reconstructs historical portfolio value from trade replay." — true; much of dashboard is synthetic by design.
12. [ASPIRATIONAL] "Reduced trade-path p50 latency to ≤8 ms via transactional outbox." — not built.

## What's missing to make the impressive bits defensible

- **B1**: clean self-load-test run on fresh Postgres + sent-vs-stored reconciliation, committed to `research/benchmarks/`; ideally fix `enable.auto.commit=false`+manual commit and remove `seenUsers` first, then show "0 lost".
- **B2**: train+commit a real LightGBM artifact (`strategy.train_and_save_model` exists), wire scoring to read `stockPrices` from Redis, add a `bars` table with real FMP daily history; also stop relying on the broken Node `/trade`.
- **B4**: apply `authenticateToken` to `POST /trade`, take `userId` from `req.user`. ~1h.
- **B7**: add a test asserting N buys → `positions.quantity == ΣN` and `users.balance == start - Σcost` (no such test exists).
- **B8/B12**: implement the outbox path from the research doc (`trade_intents`+`outbox` tables, Go executor with `SELECT FOR UPDATE SKIP LOCKED`, relay with `acks=all`) + chaos harness (k6 + `kill -9` broker) + commit the reconciliation-SQL results.
- **B9**: add p50/p95/p99 + pass/fail assertions to `stressTest.js`, commit a baseline. ~2-3h.

## Highest-ROI next moves (impact ÷ effort)

1. **Fix the 8 critical bugs** in `trade.js` + Go `ExecuteBuy` (price-lookup, parameterize SQL, enforce auth, add `SELECT FOR UPDATE`, remove `log.Fatalf`, fix position-qty overwrite, kill `seenUsers`, `enable.auto.commit=false`+manual commit). ~1-2 days. Unlocks B1/B4/B7 → [SOLID]. Impressive: correctness under concurrency+failure.
2. **Run the Go pipeline self-load-test on real Postgres w/ sent-vs-stored reconciliation, commit numbers.** 2-4h. Unlocks B1 with a real number.
3. **Add a trade-path correctness + hot-user concurrency test suite (Node).** 0.5-1 day. Unlocks "wrote tests proving trade atomicity; caught the balance-race + position-overwrite bugs."
4. **Train+commit the LightGBM artifact and wire ai-service to real Redis prices.** 0.5-1 day. Unlocks B2 → "ML signal service."
5. **Upgrade `stressTest.js` to p50/p95/p99 + assertions + baseline.** 2-3h. Unlocks B9 [SOLID].
6. **Implement the transactional-outbox hot path** (`trade_intents`+`outbox`, Go executor w/ `SKIP LOCKED`, relay w/ `acks=all`, idempotency key) + chaos test. 3-5 days. Unlocks B8/B12 [SOLID]; most senior-looking thing buildable here.
7. **Real per-user WebSocket channel** (subscribe protocol + portfolio/trade-execution events on commit). 1-2 days. Unlocks B5 → [SOLID].

## Quantification opportunities

- Go pipeline throughput: run `main()` self-load-test (5 min) on fresh PG; `actualTrades-oldTrades`÷300. Expect 1k–5k accepted/s into the channel; persisted rate is the honest number.
- Trade data-loss rate: 202s sent vs `trades` rows after drain, before/after the auto-commit fix. Before: nonzero. After: 0.
- Trade ack latency p50/p95/p99 (Node sync): add percentile math to `stressTest.js`, 200-concurrent 30s. Single-digit-ms p50 (one PG round-trip + a no-op reduce).
- Go `/api/trade` enqueue latency: ~1-3 ms p50 (channel send) — label it as enqueue, not commit.
- Batched-upsert throughput: time `insertBatchToPostgres` for 2k-row batches. Tens of ms.
- ai-service coverage: `pytest --cov=app` — likely 50-70%.
- Leaderboard rebuild time: `index.js` already logs it; capture at 9k users — tens-to-hundreds of ms.
- Migration idempotency: run `apply_migrations` twice, assert no error/dup rows.
- Chaos (post-outbox): k6 ramp + `kill -9` kafka, run research-doc reconciliation SQL → 0 lost = the headline.
- FMP price freshness: add `as_of` timestamp on write, measure write→read; ≤ refresh interval.

## Honest risks

- **Sell path is broken** (`trade.js:46-62`: malformed template literal, out-of-scope `res`/`totalCost`/`symbol`/`quantity`; caller passes undefined args at `:98`). Go has no sell path. "Buy/sell trading" gets caught immediately.
- **Buy path charges $0/share** (`trade.js:88` indexes a positional array by string key → `undefined` → `total=0` → balance check is a no-op → `balance - 0`). Balances never move on the Node path.
- **`POST /trade` is unauthenticated** — `authenticateToken` imported & unused; `userId` from request body, trusted. Anyone can trade as anyone.
- **String-concat SQL in `trade.js`** (lines 20, 31, 34) — injectable via `stock.symbol`.
- **Go service `log.Fatalf`s on any Redis hiccup** (`trade_service.go:32,47,53`) — one transient error kills the process. Not "resilient".
- **Go pipeline silently drops trades** — `seenUsers` per-batch dedup (`kafkaToSql.go:61`) + `enable.auto.commit=true` commits offsets before the PG tx. "Zero data loss" is false today.
- **AI service trades on fabricated prices** — `strategy.score` invents a series from `hash(symbol)`; `_notional_price_hint` is `50 + hash%1000*0.37`. And it executes through the broken Node `/trade`, so "auto-executed" trades are $0-cost.
- **No real model artifact committed** — LightGBM path falls back to a 2-term linear rule. "Trained an ML model" is aspirational.
- **`/manager` + `/api/stress` "load test" is theatre** — ≤50 `/api/health` GETs, numbers multiplied up; on upstream-down it returns `30 + random()*25` ms.
- **Money is `NUMERIC(12,2)` but float/`parseFloat` in code**, including write paths — off-by-cent drift.
- **`orders`/`watchlists`/`watchlist_items` are schema-only** — no code touches them. "Advanced/limit/stop orders" would be a fabrication.
- **`trading-service/main.go` is ~85% commented-out dead code** (multiple abandoned `main()` variants) — a reviewer browsing will notice.

## Bottom line

The **most impressive system** already built is the Go async trade pipeline (HTTP → channel → Redis Streams consumer groups → Kafka → batched single-tx Postgres upsert), and it self-load-tests. The **cleanest code** is `ai-service/`. But the **resume-blocking risks** are: trading doesn't actually work end-to-end (broken sell, $0 buys), `/trade` is unauthenticated + SQL-injectable, the AI executes on fabricated prices, and "zero data loss" is currently false. Fix the critical bugs first; then the throughput/correctness/chaos numbers become claimable.
