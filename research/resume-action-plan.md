# Resume Action Plan — Paper-Trading Project

> Synthesis of `research/resume-audit.md` (what's true in the code today) and
> `research/resume-research.md` (what hiring managers actually weight in 2026).
> Goal: highest resume impact per hour spent.

## TL;DR — sequence of moves

The two analyses converge on the same answer. Stop adding features. The project already has the
**most impressive system that's buildable here** (the Go async pipeline). What's missing is the
**evidence that it's correct, fast, and lossless** — exactly the evidence a hiring manager opens the
README to find. The plan below produces that evidence in five phases. Do them in order; each one is
shippable on its own and each unlocks at least one [SOLID] bullet.

| Phase | Effort | Unlocks | Bullet count |
|---|---|---|---|
| 1. Bug-fix sprint (correctness floor) | 1–2 days | makes every other claim defensible; removes the "broken sell / $0 buys / unauth /trade" embarrassments | unblocks 4 bullets |
| 2. Real benchmark harness + percentile metrics | 0.5 day | the throughput / latency numbers | 1 [SOLID] bullet |
| 3. Transactional outbox + idempotency keys | 3–5 days | the headline distributed-systems bullet | 2 [SOLID] bullets |
| 4. Chaos suite + SLO | 1–2 days | "zero data loss under broker-kill chaos" | 1 [SOLID] bullet (the killer one) |
| 5. README polish + architecture diagram + branch fix | 0.5 day | the project actually gets read | converts everything above |

Stretch (after 1–5): real ML artifact + walk-forward backtest, then per-user WS channel. Skip the
stock-detail page polish unless applying to frontend roles.

---

## Why this sequence (the synthesis logic)

The audit ([`resume-audit.md`](resume-audit.md)) found the most impressive thing in the repo is the
Go async pipeline (HTTP → channel → Redis Streams → Kafka → batched PG upsert), but flagged that
right now: trades silently drop, the consumer auto-commits before the DB tx, the Node `/trade`
endpoint charges $0/share, the sell path is broken, `/trade` is unauthenticated and SQL-injectable,
the AI service trades on fabricated prices, and the load tester reports averages with no
percentiles.

The research ([`resume-research.md`](resume-research.md)) found that the bullets that wow backend
interviewers are exactly: **transactional outbox, idempotency keys, FOR UPDATE locking, chaos
testing under broker-kill, decimal money, real percentile latency numbers** — and the worst
anti-patterns are claiming exactly that kind of thing without the code/numbers backing it.

Same project. Same five things. The plan is just to do those five things in dependency order so each
phase's work makes the next phase's claim defensible.

---

## Phase 1 — Correctness floor (1–2 days)

These are the bugs that turn every other bullet into a lie. Until they're fixed, an interviewer who
opens the repo (and they will) sees a broken trade path, an unauth'd money endpoint, and SQL
injection. Nothing else matters.

Concrete fixes (all documented in [`CLAUDE.md`](../CLAUDE.md) and [`resume-audit.md`](resume-audit.md)):

- [ ] [routes/v1/trading/trade.js:85](../routes/v1/trading/trade.js#L85) — switch `HMGET` result to a `{symbol → price}` map, fix the `prices[s.symbol]` lookup. Buys actually charge real money.
- [ ] [routes/v1/trading/trade.js:14](../routes/v1/trading/trade.js#L14) — parameterize the SQL. No string-concat with `stock.symbol`.
- [ ] [routes/v1/trading/trade.js:63](../routes/v1/trading/trade.js#L63) — apply `authenticateToken`; `userId` from `req.user`, not body.
- [ ] [routes/v1/trading/trade.js:80](../routes/v1/trading/trade.js#L80) — `SELECT balance FROM users WHERE id=$1 FOR UPDATE` inside the tx. Closes the over-draft race.
- [ ] [routes/v1/trading/trade.js:46](../routes/v1/trading/trade.js#L46) — finish or delete the broken sell path. If keeping, use the same atomic, locked, parameterized pattern.
- [ ] [trading-service/services/trade/trade_service.go:32](../trading-service/services/trade/trade_service.go#L32) — replace `log.Fatalf` with `return err`. One transient Redis blip should not kill the process.
- [ ] [trading-service/trade_service.go:72](../trading-service/trade_service.go#L72) — write `updated_quantity` not `stock.Quantity` to the position field.
- [ ] [trading-service/services/workers/kafkaToSql.go:38](../trading-service/services/workers/kafkaToSql.go#L38) — `enable.auto.commit=false`; commit after the PG tx commits. Remove the `seenUsers` per-batch dedup at line 61.
- [ ] [db.sql:25](../db.sql#L25) — `CREATE INDEX ON trades (user_id, created_at DESC)`.
- [ ] Delete the ~85% commented-out dead code in [`trading-service/main.go`](../trading-service/main.go). Reviewers notice.

**Bullets unlocked (all become [SOLID]):**
- "Rebuilt the buy path as an atomic, idempotent transaction (`SELECT … FOR UPDATE` + parameterized SQL); a 200-concurrent same-user stress test went from ~3% over-drafts to 0."
- "Closed an unauthenticated money-movement endpoint and a SQL-injection vector via symbol concatenation."
- "Fixed a Go consumer bug that committed Kafka offsets before the Postgres tx and a per-batch dedup that silently dropped same-user trades — the pipeline went from non-zero loss to zero."
- "Added the missing `(user_id, created_at DESC)` index on `trades`; verified `trade_history` p95 dropped from N ms to N ms via `EXPLAIN ANALYZE`."

## Phase 2 — Real benchmark harness + percentile metrics (~0.5 day)

`stressTest.js` reports averages. `/manager` is theatre. Rewrite both.

- [ ] Upgrade [`stressTest.js`](../stressTest.js) to record p50/p95/p99 (use `hdr-histogram-js`), report sustained TPS over a fixed 60-second window, print hardware in the output, and fail the run if p99 > a configured budget. Commit a baseline result file under `research/benchmarks/node-trade-baseline.txt`.
- [ ] Run the Go service's `main()` self-load-test on a fresh Postgres for 5 minutes; compute sent-to-channel vs persisted-to-PG; commit `research/benchmarks/go-pipeline-baseline.txt`. With Phase 1 done, the persisted number should equal sent.
- [ ] Replace the `/api/stress` stub with one that actually drives `stressTest.js` (or invokes a real k6 binary) and surfaces the histogram in the [`/manager`](../web/app/manager/page.tsx) UI.

**Bullet unlocked:**
- "Sustains ~N trades/sec at p99 < N ms on a single node (M2 / 2-vCPU VM); load harness reports HDR histogram and fails CI on regression." (Fill in N from your machine.)

## Phase 3 — Transactional outbox + idempotency keys (3–5 days)

This is the headline distributed-systems work. The design is already speced in [`research/trading-optimization.md`](trading-optimization.md). Implement it.

- [ ] Migration: add `trade_intents(id, user_id, symbol, side, qty, idempotency_key UNIQUE, status, created_at)` and `outbox(id, topic, key, payload, created_at)`.
- [ ] Node `/trade` becomes thin: `INSERT INTO trade_intents` returning 202; honors `Idempotency-Key` header for client retries.
- [ ] Go executor: `SELECT … FOR UPDATE SKIP LOCKED FROM trade_intents WHERE status='pending' LIMIT 50`; in one PG tx update balance, insert positions, insert into outbox, mark intent done.
- [ ] Outbox relay (Go goroutine or new tiny service): `acks=all`, `enable.idempotence=true`; deletes outbox row only after broker ack.
- [ ] Kafka consumers commit offsets only after their PG side-effect tx commits.

**Bullets unlocked:**
- "Designed a transactional-outbox pipeline (Postgres → Kafka, effectively-once via idempotent UUID-keyed upserts); the dual-write to DB + queue is replaced by one local PG transaction + an at-least-once relay."
- "Made the trade ingest path idempotent via client-supplied `Idempotency-Key` (header) and a UNIQUE-constrained intents table; client retries are provably safe."

## Phase 4 — Chaos suite + SLO (1–2 days)

This is the bullet that separates "I built a queue project" from "I operated a queue project." It is
also the bullet that makes every number from Phase 2/3 believable.

- [ ] Define SLOs in `research/slo.md`: e.g. 99.9% of accepted trades persisted within 2s, p99 trade ack < 75ms, RPO=0.
- [ ] `tests/chaos/` shell scripts: while a 60-second load run is in flight, do (a) `docker kill kafka`, (b) `docker kill <go-executor>`, (c) `docker network disconnect ... redis`, then restart after 5–15s.
- [ ] Reconciliation SQL after each run: count distinct accepted UUIDs vs persisted; assert equal. Print the result.
- [ ] Commit a `research/chaos-results.md` table: scenario, runs, lost trades, max recovery time. Target: 0 lost across all scenarios.

**Bullet unlocked (the killer one):**
- "Defined an SLO (99.9% persistence within 2s, RPO=0) and a chaos suite that kills the broker, the writer, and partitions Redis under load; pipeline holds zero data loss across 50 runs."

## Phase 5 — README polish + diagram + branch hygiene (~0.5 day)

The most leveraged half-day in the whole plan. The README is what the recruiter actually opens.

- [ ] Top-level `README.md` with: one-paragraph "what it is", architecture diagram (one Mermaid diagram is enough — services, queues, DB, the flow of a trade), quickstart (`docker compose up -d --build`), screenshot of `/`.
- [ ] "Design decisions & tradeoffs" section: outbox vs CDC, at-least-once + idempotent vs Kafka transactions, FOR UPDATE vs optimistic, decimal vs float money. Each one paragraph. This section *is* your interview prep — when they ask "why did you do X?", the answer is already here.
- [ ] "Benchmarks" section pasted from Phase 2 outputs: harness command, hardware, throughput, p50/p95/p99, EXPLAIN ANALYZE for the index work.
- [ ] "Reliability & chaos" section pasted from Phase 4.
- [ ] "Known limitations" section: be honest. "Money is float in older code paths; migration tracked in #N." Honesty here reads as a positive signal.
- [ ] Merge `frontend` → `main`, or set `frontend` as the GitHub default branch. The reviewer will see whatever the default is.
- [ ] If you can keep it up cheaply: deploy to Fly.io / Railway, put the URL in the README header. If not, record a 60-second screen capture of the `/` dashboard with live data flowing and link it in the README.
- [ ] Optional but high-leverage: a 90-second YouTube/Loom walkthrough — "here's a buy hitting the Node API, here's the intent in PG, here's it landing in Kafka, here's the writer batching it back to PG, here's the chaos test killing Kafka mid-run with zero loss."

---

## Stretch goals (only after 1–5 are committed)

### S1. Real ML artifact + walk-forward backtest (1 day)
The audit flagged the AI service is the cleanest *code* but trades on fabricated prices. Train and
commit the LightGBM model that [`ai-service/app/strategy.py`](../ai-service/app/strategy.py) already
knows how to train; add a `bars(symbol, date, ohlcv)` table populated from FMP daily history; wire
`strategy.score` to read real bars; add a `backtests/` script that does walk-forward eval with
modeled costs and prints honest Sharpe/drawdown.

**Bullet:** "Built a walk-forward backtesting harness for an AI signal service (LightGBM on
engineered momentum features, point-in-time bars, modeled transaction costs); out-of-sample Sharpe
~N, max drawdown N% — strategy runs paper-only behind a drawdown kill-switch and per-symbol
guardrails enforced server-side."

### S2. Per-user WebSocket channel (1–2 days)
Replace the global broadcast in [`wsServer.js`](../wsServer.js) with a subscribe protocol; emit
portfolio/trade events on commit (drive it from the outbox).

**Bullet:** "Added a per-user WebSocket subscription protocol; portfolio + trade-execution events
fan out from the transactional outbox so client state stays consistent with PG without a separate
push path."

### S3. Skip
Don't polish the stock-detail page or the discover-more grid further. Visual polish doesn't move
backend bullets, and the dashboard already screenshots well.

---

## What good looks like in the final resume entry

```
Paper-trading platform — github.com/<you>/paper-trading · demo: stocky.fly.dev
Distributed paper-trading backend (Node/Express, Go, Python/FastAPI, Next.js, Postgres, Redis, Kafka).
• Designed a transactional-outbox pipeline (PG → Kafka, effectively-once via idempotent UUID-keyed
  upserts) sustaining ~N trades/sec at p99 < N ms; chaos suite that kills the broker, writer, and
  partitions Redis under load holds zero data loss across 50 runs.
• Hardened the trade path: parameterized SQL, JWT-enforced money endpoint, atomic balance check via
  SELECT … FOR UPDATE inside the tx; a 200-concurrent same-user stress test went from ~3% over-drafts
  to 0. Added (user_id, created_at) index, dropping trade_history p95 from N ms to N ms (EXPLAIN proof).
• Built an AI signal service (FastAPI + LightGBM) with server-side risk guardrails (position/notional/
  drawdown caps, kill-switch) and a walk-forward backtest harness (point-in-time bars, modeled costs);
  strategy runs paper-only behind a drawdown kill-switch.
```

Three bullets. Each one names the technical mechanism, the number, and the failure mode it survives.
Each one survives a follow-up question because the README has the diagram, the benchmark, the chaos
results, and the design tradeoffs already written down.

That's the goal. The five phases above are the path.
