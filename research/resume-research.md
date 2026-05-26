# Resume Research: Presenting a Multi-Service Trading App on a SWE Resume

> Sourcing note: live web search/fetch were unavailable when this was written, so citations point to
> well-known, stable sources from memory rather than freshly-fetched pages. Treat URLs as pointers to
> verify. The substance reflects current (2024-2026) hiring practice; re-check exact wording before
> quoting any post verbatim.

## What hiring managers and recruiters actually weight

The resume's only job is to get a phone screen. Recruiters skim ~6-10 seconds on the first pass.

| Tier | Top-of-resume signal | How a project section is treated | Skimmed/ignored |
|---|---|---|---|
| FAANG / big-tech | Brand internships/employers; scope language (built X used by N teams/users). New-grad: GPA + flagship project. | Read only if <2 strong work experiences, or the project exceeds the work in scope. One tight block. | Long stack lists, "passionate about clean code," tutorial clones. |
| Well-funded startup (B-D) | Shipping velocity, end-to-end ownership, "built and ran X in prod," comfort with ambiguity. | Read carefully — startups love builders. Real running system + demo link is strong. | GPA, coursework, "only did the assigned ticket" vibes. |
| Mid-size / public non-FAANG | Relevant tech overlap, can-you-do-the-job evidence, stability. | Tiebreaker + interview conversation fuel. | Buzzword soup, unverifiable scale claims. |
| Early startup (seed-A) | "Can this person build the whole thing." Breadth, pragmatism, judgment about what NOT to build. | Often the most important section if you're junior. | Anything academic; anything that took 2 years and isn't shipped. |

Cross-tier truths: recency and depth beat breadth (HN "Who's Hiring", r/cscareerquestions, Gergely
Orosz / The Pragmatic Engineer — pragmaticengineer.com); a working link is a force multiplier (the
demo link is often what the interviewer opens — "resume that got me into $BIGTECH" posts on
Medium/dev.to); project sections matter less the more real work experience you have; interviewers
pattern-match for tutorial clones (originality of the *engineering problem*, not the product idea, is
what counts); ATS keyword matching is real but secondary — match the JD's nouns to clear the filter,
but don't keyword-stuff.

A project section gets read when: (1) you're junior or switching; (2) the JD lists tech your project
uses and your work doesn't; (3) the one-liner makes the scope sound bigger than a weekend toy.

## Anatomy of a strong project bullet

Formula: [strong action verb] + [the actual technical thing you designed/built, named precisely] +
[quantified outcome] + [scale / constraint / failure mode it survives].

Patterns: capability + metric; problem→mechanism→result; decision + tradeoff. Avoid "Worked on…",
"Helped with…", "Responsible for…", "Utilized…", and adjectives doing the work of facts ("robust",
"scalable", "performant"). No number ⇒ no claim.

| Weak | Strong |
|---|---|
| Built a trading API with Node.js and Express. | Designed a transactional-outbox pipeline (Postgres→Kafka, effectively-once into the SQL writer) sustaining ~2,000 trades/sec at p99 < 75 ms with zero lost trades across 50 broker-kill chaos runs. |
| Used Kafka for async processing. | Decoupled trade ingestion from persistence via Kafka (consumer group, 2k-msg batched writes, idempotent upserts keyed by trade UUID); ingestion stayed available and lossless while the DB writer was restarted under load. |
| Implemented a leaderboard feature. | Replaced an O(N·P) per-cycle leaderboard recompute with one SQL aggregation + a Redis sorted set, dropping rebuild from ~3.4 s to ~120 ms at 10k users. |
| Made the database faster. | Cut trade_history p95 from 480 ms to 6 ms by adding a (user_id, created_at DESC) index — verified with EXPLAIN ANALYZE (Seq Scan on 1.2M rows → Index Scan). |
| Handled concurrent trades. | Fixed an over-draft race by moving the balance check inside the transaction with SELECT … FOR UPDATE; a 200-concurrent same-user stress test went from ~3% negative balances to 0. |
| Built a real-time dashboard. | Streamed live prices + portfolio deltas to a Next.js dashboard over a WebSocket fan-out (single broadcaster, ~500 concurrent clients in load test); FCP < 1.2 s, JS bundle 180 KB gzipped. |
| Added an AI feature for trade signals. | Built a walk-forward backtesting harness (2015-2024, costs + slippage modeled) for a momentum strategy; out-of-sample Sharpe ~0.7, max drawdown 22% — with a position-size cap and a kill-switch, not a "GPT picks stocks" gimmick. |
| Wrote tests for the trading service. | Added integration tests asserting balance/positions/trade-row invariants per execution path; caught a position-quantity-overwrite bug where every repeat buy replaced total quantity instead of accumulating. |
| Used Redis for caching. | Introduced a write-through cache for balances/positions so analytics endpoints read fresh data; previously they lagged the source of truth by up to 10 min because trades wrote Postgres only. |
| Made the system reliable. | Defined an SLO (99.9% of trades persisted within 2 s) + an error budget; added chaos tests (kill Kafka, kill the SQL writer, partition Redis) the pipeline must pass in CI. |
| Handled money correctly. | Switched all money math from float64/parseFloat to fixed-point (NUMERIC(12,2) in PG, integer-cents in app code), eliminating off-by-a-cent drift surfaced by a property-based test. |
| Optimized Go service throughput. | Profiled the Go ingestion path with pprof; replaced a per-trade Redis round-trip with pipelined writes + a bounded worker pool, lifting sustained throughput from ~600 to ~2,400 trades/sec on a single node. |

Pick 3 bullets max: hardest distributed-systems thing / most impressive number / breadth-or-AI.

## What numbers to chase

Numbers must be measured, reproducible, and modest enough to be believable on a laptop / small cloud
box. A precise small number beats a vague big one. Round-but-not-too-round ("~2,000", "p99 ~75 ms")
reads as measured; "exactly 1,000,000 req/s" reads as made up.

| Metric | Credible range | How to measure | Red-flag version |
|---|---|---|---|
| Throughput | 500-5,000/s single node; 10k+ only if actually sharded | k6/wrk/vegeta at fixed concurrency ≥60 s; report sustained rate; state hardware. | "Handles millions of requests" with no harness. |
| Latency | Always p50/p95/p99, never "average" | Same load tool; capture the histogram; note where the timer starts/stops. | "Sub-millisecond" everything. |
| Data-loss | "0 lost trades across N chaos runs" + the script | Inject a trade UUID; after kill+restart, assert every accepted UUID is in PG exactly once. | "100% reliable" with no test. |
| Query speedup | 10x-100x from an index is normal | EXPLAIN (ANALYZE, BUFFERS) before/after; paste both plans. | "Optimized queries for performance." |
| Test coverage | 60-85% on core logic; whole-repo coverage matters less | c8/nyc, go test -cover; report the package. | "100% coverage." |
| Concurrency-correctness | "0 negative balances under 200 concurrent same-user buys (was ~3%)" | Repeatable stress test on one user; count invariant violations before/after. | "Thread-safe" with no evidence. |
| Uptime | Don't claim uptime for a project nobody ran; claim an SLO you tested against. | Define SLO; show the chaos suite validating it. | "99.99% uptime." |
| Cost | Only if deployed: "$5/mo VPS / ~$12/mo Fly.io" | Actual bill / instance sizing. | "cost-optimized" with no number. |
| Data scale | 100k-10M rows is plenty for index/query work | Seed with faker; state row counts. | "petabyte-scale." |

"Enough without lying": ~2k trades/sec sustained, p99 tens-to-low-hundreds ms, 0 data loss under
chaos, a 10-100x query speedup with EXPLAIN proof, a documented SLO — on a laptop/small VM.

## Distributed-systems / backend signals that wow

| Concept | Why it lands | Worth building? |
|---|---|---|
| Transactional outbox (trade + outbox row in one PG tx; relay to Kafka) | Textbook fix for dual-write — you know you can't atomically write a DB and a queue. | Yes, highest leverage. Replaces the fragile XADD-then-Kafka hop. |
| Idempotency keys (client trade UUID, dedup at ingest and at the writer) | Separates "read about queues" from "operated one." Makes retries safe; effectively-once on at-least-once transport. | Yes. Cheap; huge credibility; makes chaos tests assertable. |
| At-least-once vs exactly-once, stated honestly | "Kafka gives at-least-once; I get effectively-once via idempotent UUID-keyed upserts" is exactly the nuance they probe. | Yes — a framing, not work. |
| Consumer-group rebalancing / commit-after-write | enable.auto.commit vs commit-after-PG-tx. Current code commits before the tx — fixing it is a bullet. | Yes — fix it, then claim it. |
| Row-level locking vs optimistic concurrency | Trading = money; "what if two trades hit the same balance?" will be asked. | Yes — there's a real over-draft race. |
| Backpressure (bounded queues, 503 on full, blocking reads with timeouts not hot-loops) | You think about overload, not just happy path. | Yes — Go service drops on full channel, hot-loops on empty stream. |
| Chaos testing (kill broker/writer, partition Redis; assert invariants) | Almost no personal projects do this — massive differentiator; makes reliability numbers believable. | Yes — top 3 leverage. |
| SLOs / error budgets | Speaking "99.9% persisted within 2 s, here's the budget" signals you've thought past "works on my machine." | Yes — mostly docs + one test. |
| Decimal money handling | Float money is an instant credibility ding for a trading app. | Yes — arguably mandatory for the domain. |
| CDC (Debezium / logical decoding) | The outbox alternative — mention, don't build. | Mention. |
| Saga / compensating transactions | The buy path gestures at rollback keys; the reasoning matters more than the code. | Optional. |
| Read replicas / CQRS for analytics | Plausible given "analytics reads lag the source." | Optional — write-through cache is cheaper. |
| Kafka idempotent producer / transactions | Mention you know enable.idempotence exists and why you didn't need it. | Mention. |

Rule of thumb: build outbox + idempotency keys + chaos suite + locking fix + decimal money. Each
unlocks a strong bullet *and* a deep interview thread. Everything else: discuss the tradeoff.

## AI/ML on a resume in 2026

By 2026 "AI" is heavily discounted by default. Make it credible by showing engineering rigor around
the ML, not ML-researcher chops.

Green flags: a real backtest with walk-forward / out-of-sample validation, costs + slippage modeled,
honest numbers (Sharpe, drawdown, hit rate, turnover) including unflattering ones — Sharpe ~0.5-1.0
is believable, Sharpe 3 screams overfit/look-ahead bias; an eval harness with a labeled set and a
regression check if an LLM is in the loop; guardrails (position caps, drawdown kill-switch, paper-only
execution); reproducibility (pinned data snapshot, seeded runs); honest scoping ("research toy, not
alpha").

Red flags: "used GPT-4 to pick stocks" with no backtest; reporting in-sample returns as out-of-sample;
a Sharpe/return number with no methodology; "machine learning" for one sklearn LinearRegression on 200
rows; listing "TensorFlow, PyTorch, LangChain, RAG, fine-tuning, RLHF" when the repo is one API call.

Defensible bullets: "Built a walk-forward backtesting harness (point-in-time data, modeled
costs/slippage); surfaced and corrected a look-ahead bias inflating returns ~3x." / "Wrapped an LLM
news-sentiment signal behind an eval suite (F1 gate in CI) and a rate-limited, cost-capped client;
feeds a paper portfolio only, behind a drawdown kill-switch." / "Designed the feature store + backfill
jobs (Postgres + Redis) feeding the model; ML logic stayed a thin, swappable layer behind a versioned
interface." The "I built the systems around the ML" framing is the most honest for a SWE applicant.

## Frontend / full-stack signals

Helps when: the role is full-stack/frontend-leaning; it's your live demo (a real-time trading
dashboard is impressive to click through); it shows a skill your work history lacks. Noise when the
role is pure backend/infra, you're senior, and CSS bullets bury the Kafka pipeline.

| Signal | Why | How to back it |
|---|---|---|
| Real-time data over WebSocket fan-out | Push, not just request/response; single-broadcaster + N clients is a real concern. | Load test with N simulated WS clients; report concurrent-client count + update latency. |
| Performance budget | TTI/FCP/bundle size are concrete and checkable. | Lighthouse / web-vitals; report FCP, TTI, bundle KB gzipped; state the route. |
| Accessibility | Cheap, rare in side projects, signals craft. | axe / Lighthouse a11y score; keyboard-nav the critical flow. |
| Design-system discipline | "Built on a small token-based component set" >> "made it look nice." | Point at the components/tokens. |
| Optimistic UI / reconciliation | Client/server state divergence — apt for trading. | The code + a note on the reject case. |

Backend-leaning role: one line ("Next.js dashboard with a WebSocket price/portfolio feed, Lighthouse
95+, 180 KB bundle") — then move on. The frontend earns its keep mostly as the demo link.

## Anti-patterns

1. Tutorial-clone vibes — detected by topology + generic README + no non-trivial engineering problem.
   Fix: lead with the distributed-systems substance no tutorial covers.
2. Unverifiable/inflated numbers — detected by "what hardware? what load tool? show me the histogram."
   One imploded number poisons the whole resume. Fix: only claim what your harness prints.
3. "Scalable"/"robust"/"production-grade" with no evidence — adjectives where facts should be. Fix:
   delete the adjective, add a number or a mechanism.
4. Listing 20 technologies — reads as padding. Fix: list only what's load-bearing; let bullets name
   tech in context.
5. No link to running code or demo — treated as unverified at best, fictional at worst. Fix: GitHub
   link on every project; live demo if you can keep it up.
6. Claiming things the code doesn't do — "exactly-once", "zero downtime", "fully tested" when the repo
   shows auto-commit before the DB write, no tests, a broken sell path. Detected the moment the
   interviewer opens the repo; it's a dishonesty flag, not a weak bullet. Fix: the resume must be a
   strict subset of what main does.
7. Stale/dead code presented as features — commented-out routes, orphaned services, a web/ stub.
   Detected on git log / file tree. Fix: clean the repo or scope the README to "live vs experimental."
8. Burying the project when it's bigger than your work. Fix: if it's your strongest evidence, put it
   near the top.

## How to structure the project on the resume

- Format: a one-line header + 3 bullets. Header = project name, a phrase of what it is, the stack, the
  GitHub link, and (if live) the demo URL. Senior with strong work history: one line, zero bullets, in
  a "Selected Projects" footer. New grad / switcher: the 3-bullet block, above internships if stronger.
- GitHub link in the project header, not a separate "links" pile. Make sure the default branch is the
  good one (current default is `main`; this work is on the `frontend` branch — merge or re-point it or
  the reviewer sees a stale tree).
- Live demo: worth it if you can keep it up cheaply (Fly.io/Railway/$5 VPS) and it won't embarrass you.
  A dead demo link is worse than none. Can't keep it up? A 30-60 s screen recording in the README.
- README must contain: (1) one-paragraph "what it is" + an architecture diagram (one Mermaid/PNG);
  (2) "how to run it" that actually works; (3) a "Design decisions & tradeoffs" section (why outbox
  over dual-write, why FOR UPDATE over optimistic, why at-least-once + idempotent upserts instead of
  claiming exactly-once) — this turns the README into interview prep that works in your favor;
  (4) a "Benchmarks" section (load-test command, hardware, throughput, p50/p95/p99, EXPLAIN ANALYZE
  before/after); (5) a "Reliability / chaos tests" section; (6) "Known limitations / not done yet" —
  honesty here is a positive signal.
- One architecture diagram in the README; a demo video if no live demo; don't put a diagram on the
  resume itself.

## Prioritized recommendations

1. Make the trade path correct, atomic, idempotent — fix the price-lookup/SQL-injection bugs, balance
   check inside the tx with SELECT … FOR UPDATE, client trade-UUID with dedup. → "Rebuilt the buy path
   as an atomic, idempotent transaction (FOR UPDATE + dedup on trade UUID); a 200-concurrent same-user
   stress test went from ~3% over-drafts to 0, with retries provably safe."
2. Transactional outbox (PG→Kafka) + idempotent upserts at the writer; commit Kafka offsets after the
   PG tx. → "Designed a transactional-outbox pipeline (PG→Kafka, effectively-once via idempotent
   UUID-keyed upserts); ingestion stays lossless and available while the DB writer is restarted under
   load."
3. Chaos test suite + an SLO. → "Defined an SLO and a chaos suite (broker kill, writer restart, Redis
   partition); the pipeline holds zero data loss across 50 runs."
4. Real benchmark harness. → "Sustains ~2,000 trades/sec at p99 < 75 ms on a single node (M2 / 2-vCPU
   VM)."
5. Fix the leaderboard + add CREATE INDEX ON trades (user_id, created_at DESC); record EXPLAIN
   before/after. → "Cut leaderboard rebuild from ~3.4 s to ~120 ms (10k users) and trade_history p95
   from ~480 ms to ~6 ms (Seq Scan → Index Scan)."
6. Fixed-point money everywhere + a property-based test. → "Eliminated off-by-a-cent float drift by
   moving all money math to fixed-point; a property-based test now guards the invariant."
7. Integration tests for core invariants per path. → "Integration tests assert balance/positions/
   trade-row invariants per path; caught a position-quantity-overwrite bug."
8. Honest, rigorous AI service (walk-forward backtest, modeled costs, kill-switch, eval harness). →
   "Built a walk-forward backtesting + eval harness (point-in-time data, modeled costs); corrected a
   look-ahead bias inflating returns ~3x; strategy runs paper-only behind a drawdown kill-switch."
9. Polish demo + README + diagram; set the GitHub default branch to the good one. → unlocks the project
   header (link + demo) and turns the README into interview ammunition.
10. Trim frontend claims to one line for backend-leaning roles. → "Next.js dashboard with a WebSocket
    price/portfolio feed (~500 concurrent clients in load test; Lighthouse 95+, 180 KB gzip)."

Do 1-5 first: highest-credibility, most-asked-about, and they make every number survive interview
scrutiny. 6-8 are domain-specific differentiators. 9-10 are packaging — after there's something to
package.
```
