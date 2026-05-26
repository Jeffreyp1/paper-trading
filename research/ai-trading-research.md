# AI Trading & Automation: Research Brief for Paper-Trading App v1

> Build spec for the next agent. Existing stack: Node 18+ Express API (`index.js`, `routes/v1/*`), Go `trading-service` (chi router, Postgres `lib/pq`, Redis Streams via `go-redis`, Confluent Kafka producer/consumer), Postgres 16 (`db.sql`), Redis 7. Trades flow `Node API -> Redis Stream buy_stream -> Kafka topic trade_events -> Postgres trades` with a worker pool. Symbols are FMP (Financial Modeling Prep) end-of-bar quotes refreshed every 6 minutes (`services/stockService.js`).
>
> **Note on sources**: Live web access (`WebSearch`, `WebFetch`) was unavailable in this research session. Citations below point to canonical project pages and seminal papers known to the author at training cutoff (January 2026). The build agent should re-verify versions, licenses, and pricing before committing to any external dependency.

---

## Problem framing

"AI trading" is overloaded. For a paper-trading app it can mean any of:

| Capability | Description | Build cost | User value |
|---|---|---|---|
| (a) Signal generation | Model produces buy/sell scores per symbol | Medium | High — drives every other feature |
| (b) Automated execution / agentic order placement | Agent places orders without per-trade approval | Medium-high (mostly guardrails) | Medium — flashy but risky |
| (c) Portfolio optimization | Allocate capital across signals (Markowitz, risk-parity, Kelly) | Low-medium | Medium |
| (d) Backtesting / simulation | Replay strategy on historical bars with costs | Medium | High — required to trust (a) and (b) |
| (e) Risk monitoring | Drawdown, exposure, VaR alerts | Low | High — also a regulatory hygiene concern |
| (f) NL assistant over portfolio | "Why am I down today?", "Summarize news on AAPL" | Low (LLM API) | High — visibly differentiated |

**v1 scope**: ship (a) + (d) + (e) + (f). Defer (b) to a manual-approval flow ("Approve" button that posts the same `TradeRequest` already supported by `trade_service.go`). Defer (c) to v2 — a single-symbol naive sizing rule (fixed % of equity) is enough for v1 and avoids the rabbit hole of covariance estimation on weak signals.

**Rationale**: a paper-trading app's edge is *learning, not alpha*. Users gain more from understanding *why* a trade is suggested (LLM rationale + backtest receipts) than from a marginally better point estimate. (a)+(d)+(f) form a tight loop: signal → simulated equity curve → human-readable explanation. (b) without (d) is malpractice even in paper mode; once (d) exists, gating (b) behind a toggle is trivial.

---

## Strategy families

Four credible families. None dominates; each has a regime where it wins.

| Family | Data needs | Train cost | Inference latency | Interpretability | Fit for paper-trading v1 |
|---|---|---|---|---|---|
| Classical ML (LightGBM/XGBoost on TA features) | OHLCV + engineered features (RSI, MACD, returns) | Minutes on CPU | <5 ms | High (SHAP, feature importance) | **Best baseline** |
| Deep learning (LSTM/Transformer on price+L2) | Tick or L2 orderbook, GB+ history | Hours on GPU | 10–100 ms | Low | Overkill; data we don't have |
| Reinforcement learning (PPO for execution) | Simulator with realistic costs/slippage | Days; reward hacking common | 5–50 ms | Very low | No — research problem, not v1 |
| LLM-as-strategist | Compact structured context (recent bars, news, fundamentals) | Zero training; prompt engineering | 1–5 s per call (cacheable) | High (asks model to cite reasoning) | **Best for explanation layer** |

Notes & evidence:

- The literature on TA-feature gradient-boosted models for daily/weekly equity prediction is mature; LightGBM tends to beat scikit-learn's `GradientBoostingClassifier` on both speed and AUC for tabular finance data (source: [LightGBM docs](https://lightgbm.readthedocs.io/)).
- LSTM/Transformer price models routinely overfit; the FinRL benchmark and follow-ups have shown that without orderbook microstructure data, deep nets rarely beat simple momentum baselines after costs (source: [FinRL repo / papers](https://github.com/AI4Finance-Foundation/FinRL)).
- LLM trading agents have moved from research toy to production assistant in 2024–2025. Frameworks like FinGPT and TradingAgents show the pattern of *LLM-as-coordinator over deterministic tools*, not LLM-as-price-oracle (source: [FinGPT](https://github.com/AI4Finance-Foundation/FinGPT), [TradingAgents (Yu et al., 2024)](https://arxiv.org/abs/2412.20138)).
- Audit/regulatory: even paper apps that influence real-money decisions in the US fall under FINRA's "communication with the public" guidance if marketed as advice. Keeping the LLM as an *explainer* of a deterministic signal (not the signal itself) is materially safer than letting it freely place orders.

**Recommendation**: a hybrid — LightGBM as the signal engine, LLM (Claude) as the *explainer + assistant*. LLM never directly emits orders; it cites the LightGBM scores and recent bars.

---

## Data

What we need vs what we have:

| Tier | Data | Source | Status | Notes |
|---|---|---|---|---|
| Must-have v1 | Daily OHLCV for ~100 large-cap US equities | FMP (already integrated) | ✅ | We currently store only the latest tick in Redis `stockPrices`. We need a history. |
| Must-have v1 | Per-symbol fundamentals (P/E, market cap, sector) | FMP free tier | partial | Used as features and as LLM context |
| Should-have v1 | News headlines + dates per symbol | FMP `/stock_news`, or Finnhub free | not integrated | Drives LLM Q&A |
| Nice-to-have | L1 quotes (bid/ask) | Polygon, Alpaca | no | Only matters for execution-quality study |
| Out of scope v1 | L2 orderbook, tick data, alt-data | Databento, Polygon paid | no | $$$, no payoff in paper mode |

Free vs paid: FMP free tier (which we use) caps at ~250 req/day. Daily OHLCV for 100 symbols batched is ~1 call/day. Adding daily news fetch keeps us inside the free tier. Polygon's free tier gives 5 req/min, decent for backfill but useless for live. Alpaca offers free IEX-only quotes; fine for paper.

**Storage decision — the most important design question**:

| Option | Pros | Cons |
|---|---|---|
| Add `bars` table to existing Postgres | Zero ops; works | Slow on multi-year scans without partitioning |
| TimescaleDB extension on existing Postgres | Hypertables, compression, time bucketing; SQL unchanged | Needs Docker image swap (`timescale/timescaledb`); minor learning curve |
| ClickHouse / DuckDB Parquet lake | Fastest analytics | New service, new ops, overkill for v1 |

**Pick TimescaleDB**. We already run Postgres 16; the swap is `image: timescale/timescaledb-ha:pg16` plus a `CREATE EXTENSION` and `SELECT create_hypertable('bars','ts')`. We get `time_bucket()`, columnar compression, and continuous aggregates — all of which the backtester will want. (Source: [TimescaleDB docs](https://docs.timescale.com/).)

**Leak prevention**:
- Every feature row must be timestamped with the `bar_close_ts` it came from. Training/eval splits must be *time-based*, never random K-fold.
- No forward-fill of fundamentals across the cutoff. Use point-in-time fundamental snapshots (FMP exposes `as-of` data on paid; on free tier we'll snapshot weekly into a `fundamentals_snapshot` table and join by `as_of <= bar_ts`).
- Use walk-forward CV: train on `[t-N, t-1]`, predict `t`, slide forward.

---

## Tech stack candidates

Three end-to-end options, scored against our existing Node+Go reality.

### Stack A — Python-heavy (separate `ai-service`)

- Training & inference: `pandas`, `lightgbm`, `numpy`, `pyarrow`.
- Serving: FastAPI + `uvicorn`; load model with `joblib`.
- Experiment tracking: MLflow (file backend → Postgres backend later).
- Deploy: new Docker service `ai-service` on port 8082; consumes from Kafka topic `feature_events`, writes to topic `signals` and table `signals`.

### Stack B — Node/Go in-process (no Python)

- Training: still Python offline (LightGBM has no good JS port). Export to ONNX.
- Serving: `onnxruntime-node` inside Express, or `onnxruntime-go` inside `trading-service`.
- TF.js considered and rejected — slower, smaller library ecosystem for tabular models.

### Stack C — Hybrid: LLM-via-API for reasoning + tiny Go/Node executor

- LightGBM model still exists (Stack A or B), but the *user-facing* AI surface is the Anthropic Claude API.
- Claude is called from Node with structured context (signals, positions, recent bars, news headlines) and produces explanations + suggested trades, returning a strict JSON schema.
- Execution: existing Go `trade_service.go` path — Claude never speaks to Kafka or Postgres directly.

### Scoring

| Criterion | A: Python service | B: ONNX in-process | C: Hybrid (LLM + small executor) |
|---|---|---|---|
| Integration with existing code | Medium (new service, Kafka glue) | High (no new service) | High (Node calls Claude; Go unchanged) |
| Inference latency | 20–80 ms HTTP | <5 ms in-process | 1–5 s (acceptable for non-HFT) |
| Throughput | Thousands rps with replicas | Tens of thousands rps | Bounded by API quota; fine for ~100 users |
| Training velocity | High (real Python ecosystem) | Same training, extra export step | Same |
| Cost (monthly) | ~$0 self-hosted | ~$0 | Claude API: ~$20–200/mo at v1 scale |
| Operability | One more service, but standard | Single service, but ML drift hidden inside Node | Best — most logic stays in stable services |
| Observability | MLflow + service logs | Hardest (no MLflow inline) | Good — log every prompt/response |

**Recommendation**: **C, with A as the *training* pipeline.** Train LightGBM offline in Python with MLflow, export to ONNX, serve in-process via `onnxruntime-node` (the B serving path). Use Claude (Stack C) for the explanation/Q&A layer. This gives us cheap, fast, in-process scoring and a clear, auditable LLM surface. We avoid running a third long-lived service in v1.

---

## Backtesting & evaluation

A credible backtest does six things or it lies:

1. **Walk-forward**, not a single train/test split. Refit at least monthly; report out-of-sample performance only.
2. **Transaction costs** modeled per fill: commissions (zero for retail US equities post-2019), SEC/TAF fees, *and* a half-spread proxy (10 bps for liquid large-caps, 30+ bps for small).
3. **Slippage**: assume executions at next-bar open, not signal-bar close. Add a market-impact term proportional to `order_size / avg_volume`.
4. **Regime stratification**: report metrics separately for bull/bear/choppy windows (e.g., split by SPY 200d trend or VIX quartile).
5. **Baselines**: buy-and-hold SPY, equal-weight portfolio, random long-only with same turnover, and previous strategy version. If we don't beat all four after costs, ship a smaller scope.
6. **Statistical significance**: deflated Sharpe ratio (Bailey & López de Prado) or White's reality check, not raw Sharpe (source: [López de Prado, *Advances in Financial Machine Learning*](https://www.wiley.com/en-us/Advances+in+Financial+Machine+Learning-p-9781119482086)).

### Library comparison

| Tool | License | Strengths | Weaknesses |
|---|---|---|---|
| `backtrader` | GPL | Pythonic, well-documented, broad indicator library | Loop-based → slow; original author no longer active |
| `vectorbt` (open) / `vectorbt PRO` | Apache / commercial | 100–1000× faster via pandas/Numba vectorization; excellent parameter sweeps | Open version is feature-frozen; PRO is paid |
| `nautilus-trader` | LGPL | Event-driven, low-latency, same code path for backtest and live; Rust core | Heavier learning curve; more than v1 needs |
| Custom (pandas + numpy) | n/a | Fits exactly to our schema; no surprises | We rebuild what others perfected |

**Recommendation**: `vectorbt` open-source for v1. We are doing daily-bar, single-asset-at-a-time strategies; vectorbt's vectorized API will let the build agent sweep 1000 parameter combos in seconds. Move to `nautilus-trader` only if we ever go to event-driven intraday (v2+). Avoid `backtrader` — slow and the project is in maintenance mode. (Sources: [vectorbt](https://github.com/polakowo/vectorbt), [nautilus_trader](https://github.com/nautechsystems/nautilus_trader), [backtrader](https://www.backtrader.com/).)

---

## Risk & guardrails

Even in paper mode, these controls go in. They're cheap to add now and *nightmare* to retrofit if we ever hook up a real broker.

- **Position sizing**: hard cap per position at 10 % of paper equity; per-symbol exposure cap.
- **Daily loss limit**: if equity drops > 5 % intraday vs prior close, AI suggestions are paused for the user.
- **Max drawdown stop**: if rolling 30-day drawdown > 15 %, auto-disable auto-execute (when we add it in v2).
- **Per-strategy circuit breaker**: if a strategy's last 5 suggestions all lose money, mark it `DEGRADED` and require user re-enable.
- **Idempotent order placement**: every AI-generated trade carries a `client_order_id = sha256(strategy_id, symbol, signal_ts)`. Add a `UNIQUE (client_order_id)` index on `orders`. Resubmits become no-ops.
- **Kill switch**: a single Postgres row `ai_config(enabled boolean)` plus a Redis key `ai:kill` checked on every decision. Either being false halts new suggestions in <1 s.
- **Audit log**: a new table `ai_decisions` records every signal + LLM rationale + user action + market context snapshot. Append-only. No deletes; corrections are new rows referencing the original.

Together these mean the worst case for v1 is a bad suggestion the user sees and ignores — never a runaway loop.

---

## Architecture for our app

```
+-----------+      +-------------------+      +-----------------+
| Web (UI)  | ---> | Node Express API  | ---> | Postgres        |
+-----------+      | (existing)        |      | + Timescale ext |
                   |                   |      |  - bars         |
                   |  + /api/v1/ai/*   |      |  - signals      |
                   |    (NEW routes)   |      |  - ai_decisions |
                   +---------+---------+      +-----------------+
                             |
                  +----------+----------+
                  |                     |
                  v                     v
           +-------------+        +-------------------+
           | onnxruntime |        | Anthropic Claude  |
           | -node       |        | API (explainer)   |
           | (LightGBM   |        +-------------------+
           |  -> ONNX)   |
           +------+------+
                  |
                  v
           +------+------+         +------------------+
           | Kafka topic | <------ | Cron worker      |
           | "signals"   |         | (Node, every 5m) |
           +------+------+         +------------------+
                  |
                  v
           +-------------+
           | Go trading- |
           | service     |
           | (existing,  |
           |  unchanged) |
           +-------------+
```

Decisions:

- **Inference site**: in-process inside Node (`onnxruntime-node`). Zero new long-running services in v1. Latency budget for the score path: <50 ms p99.
- **Cadence**: a cron-style worker inside Node (`setInterval` like the existing `updateLeaderboard`) wakes every 5 minutes during market hours, scores all watchlist symbols, writes to `signals` table, publishes to Kafka topic `signals`.
- **Recommendation landing**:
  - Authoritative store: Postgres `signals` table.
  - Real-time fanout: Kafka `signals` topic for any future consumers; WebSocket push (`wsServer.js` already exists) for the UI.
  - Hot cache: Redis hash `aiSignals:{user_id}` mirrors the latest N signals.
- **User flow**:
  1. User opts in per-strategy via `/api/v1/ai/strategies/:id/subscribe`.
  2. UI shows signals with the LLM rationale and a one-click "Place trade" button.
  3. "Auto-execute" toggle (v2) bypasses the click but still respects all guardrails.
- **Sync vs async**: scoring is async (cron worker → Kafka). User-initiated *explanation* requests ("why this signal?") are sync HTTP to Node, which calls Claude with cached context.

---

## LLM-assisted features

Concrete usages of Claude:

| Feature | Trigger | Prompt shape | Output | Cache |
|---|---|---|---|---|
| Signal explanation | User clicks "Why?" on a signal | System: role + guardrails. User: structured JSON {symbol, signal_score, top_3_features_with_shap, last_10_bars, recent_news_titles}. | 2-paragraph rationale + cited features | Cache by `(strategy_id, signal_id)`; valid until next score |
| Portfolio Q&A | Chat box on dashboard | System: portfolio JSON snapshot + recent trades. User: free text. | Markdown answer; tool-use for `get_quote`, `get_position`. | LRU per-user, 5 min |
| News summarization | Daily 9:00 ET cron | List of headlines per held symbol | 1-line per symbol "what changed" | Daily, persistent |
| Anomaly explanation | Risk module triggers (e.g., 3-sigma move) | Move + recent news + sector context | Plain-English alert text | Per-event |

Prompt-design notes:

- Always instruct the model: *"Do not invent prices, fundamentals, or news. If a value is not in the JSON I gave you, say 'not provided'."* This single line cuts hallucinations dramatically.
- Use **Anthropic prompt caching** on the system prompt + role definition + tool schemas. The signal-explanation system prompt will be ~2 KB; cached, marginal cost is negligible.
- Force structured output with a JSON schema for any LLM call whose output drives state changes; free text only for human-facing explanations.
- Never let the LLM emit `BUY/SELL` as its primary verb; it suggests, the deterministic engine *decides*. Reduces both hallucination risk and audit ambiguity.

Hallucination mitigations:

- The LLM only sees data we hand it; never give it raw web access in v1.
- Every numeric in the rationale must match a value in the input JSON — enforce with a post-call regex/numeric reconciliation step (`assertNumbersInResponseAreInContext()`).
- Show the user the raw signal score and SHAP features alongside the rationale, so they can sanity-check the prose.

---

## Best practices & pitfalls

- **Look-ahead bias**: easy to leak when joining fundamentals or news. Always `as_of <= bar_ts`. Test by deliberately shifting fundamentals 30 days into the future and checking that walk-forward Sharpe collapses — if it doesn't, you have leakage somewhere else.
- **Survivorship bias**: training only on today's S&P 500 inflates returns. Use a point-in-time index membership table or accept the bias and document it.
- **p-hacking on backtests**: every parameter you sweep is a multiple-comparison hit. Apply deflated Sharpe; budget yourself ≤ 20 hyperparam evaluations per strategy version; lock the test window before sweeping.
- **Overfitting**: prefer ≤ 30 features, depth-capped trees (`max_depth=4–6`), and L2 regularization. Watch the train/val gap, not raw val score.
- **Model drift**: market regime changes break stationary assumptions. Schedule monthly retrains and a weekly population-stability index check on top features; alert if PSI > 0.25.
- **Data poisoning**: less relevant with curated FMP data, but if news ingestion expands, sanitize: drop sources with low historical reliability; never let user-provided text reach training data.
- **Latency spikes during volatility**: FMP free tier rate-limits, and Claude latency rises when its servers are loaded. The architecture isolates this — scoring is async; UI degrades to "rationale unavailable" rather than blocking trades.
- **Backtest vs live divergence**: log live-vs-backtest-prediction deltas weekly. A divergence > 2σ is the canary for plumbing bugs.

---

## Recommendation

**v1 design — concrete and prescriptive.**

### Scope

- **In**: signal generation (LightGBM, daily bars, ~100 large-cap US equities), backtesting (vectorbt walk-forward), risk monitoring (drawdown + per-symbol caps + kill switch), LLM explanations and portfolio Q&A (Claude API).
- **Out**: auto-execution, RL, intraday, options, crypto, multi-asset portfolio optimization beyond fixed-fraction sizing.

### Stack

- **Storage**: swap Postgres image to `timescale/timescaledb-ha:pg16` in `docker-compose.yml`; create extension; convert/create `bars` as a hypertable.
- **Training (offline, Python repo `ai-train/`)**: `pandas`, `lightgbm==4.x`, `scikit-learn`, `numpy`, `pyarrow`, `mlflow`, `vectorbt`, `optuna` (capped at 20 trials/version).
- **Model export**: `onnxmltools.convert_lightgbm` → `.onnx` artifact checked into a git-LFS-tracked `models/` folder; semver naming `lgbm-daily-momentum-v1.0.0.onnx`.
- **Online inference (Node)**: `onnxruntime-node` loaded at boot in a new module `services/aiSignalEngine.js`. Loads the latest model, exposes `score({symbol, features}) -> {score, shap_top3}`.
- **LLM**: `@anthropic-ai/sdk` (Claude). Use prompt caching for the system prompt. Model: Claude Sonnet by default; Haiku for high-volume news summarization.
- **Backtest service**: Python CLI in `ai-train/`, results saved to MLflow; a small Node admin endpoint reads MLflow's REST API to surface latest backtest stats in the UI.

### Deployment shape

- One new Node module, one Python training repo run on the dev's machine or a GitHub Actions cron. **No new long-running container in v1.**
- Existing `app`, `postgres`, `redis`, `kafka`, `trading-service` containers unchanged in topology; only `postgres` swaps image.

### New tables / topics / API

```sql
-- Bars: hypertable on Timescale
CREATE TABLE bars (
  symbol VARCHAR(20) NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  open NUMERIC(12,4), high NUMERIC(12,4), low NUMERIC(12,4),
  close NUMERIC(12,4), volume BIGINT,
  PRIMARY KEY (symbol, ts)
);
SELECT create_hypertable('bars','ts');

CREATE TABLE signals (
  id BIGSERIAL PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  score NUMERIC(6,4) NOT NULL,           -- in [-1, 1]
  direction trade_type_enum NOT NULL,    -- reuse existing enum
  features_json JSONB NOT NULL,
  shap_top JSONB NOT NULL,
  UNIQUE (strategy_id, model_version, symbol, ts)
);

CREATE TABLE ai_decisions (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  signal_id BIGINT REFERENCES signals(id),
  llm_prompt_hash TEXT NOT NULL,
  llm_response JSONB NOT NULL,
  user_action TEXT,                      -- 'IGNORED' | 'APPROVED' | 'REJECTED'
  client_order_id TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE ai_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);
-- Seed: ('enabled', 'true'), ('max_position_pct', '0.10'), ('daily_loss_pct', '0.05')
```

Kafka topics (additions):
- `signals` — every signal emitted by the scorer.
- `ai_audit` — every LLM call (prompt hash + response + tokens), for offline review.

API surface (Node, mounted at `/api/v1/ai`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/signals?symbol=&since=` | List recent signals |
| GET | `/signals/:id/explain` | LLM-generated rationale (cached) |
| POST | `/signals/:id/approve` | User accepts → emits TradeRequest into `buy_stream` (existing Go path) |
| POST | `/chat` | Portfolio Q&A; streams Claude response |
| GET | `/strategies` | List strategies and their backtest stats |
| POST | `/strategies/:id/subscribe` | Per-user opt-in |
| POST | `/admin/kill` | Set `ai_config.enabled=false` (admin role only) |

### Evaluation plan

- Pre-launch: walk-forward backtest on 2018–2024, must beat buy-and-hold SPY *after costs* on a 2-of-3 of {Sharpe, Calmar, max drawdown}. Deflated Sharpe ≥ 0.5.
- Shadow mode (2 weeks): emit signals to `signals` table, do not surface in UI. Compare predicted next-day return vs realized; track hit-rate and calibration.
- Beta launch: enabled for ≤ 20 opt-in users. Daily review of `ai_decisions` for 2 weeks.
- General release: gated on no kill-switch trips, hit-rate within 20 % of backtest.

### Success metrics (v1)

- Coverage: signals produced for ≥ 95 % of watchlist symbols on ≥ 95 % of trading days.
- Latency: signal end-to-end < 1 s; explanation < 3 s p95.
- Quality: paper-PnL of opted-in users beats their pre-AI baseline by ≥ 1 % over 8 weeks (this is honest-but-modest; bigger claims require real A/B).
- Trust: ≥ 50 % of surfaced signals receive an explanation click; < 1 % flagged as hallucinated by users.

### v2 sketch (after v1 ships and is stable)

- Auto-execute with hard caps (a single new toggle, all guardrails already in place).
- A second strategy family (mean-reversion on Bollinger), so we have a portfolio of strategies and can test ensembling.
- Intraday bars (5-min) → still vectorbt, but now FMP intraday or Alpaca.
- Move LightGBM serving from `onnxruntime-node` to a dedicated Python `ai-service` only if we hit > 50 RPS sustained — we won't in v2.
- Tool-using Claude agent that can run our own backtester ("backtest a 50/200 SMA crossover on AAPL since 2020") — useful learning feature, low risk because the agent operates on historical data.

---

## Open questions

The build agent should get answers from the user before starting:

1. **Data budget**: are we OK paying ~$20/month for FMP Starter to get news + intraday? Or strictly free tier?
2. **LLM budget**: cap monthly Claude spend at $50, $200, or higher? Determines whether we use Sonnet broadly or default to Haiku.
3. **Risk tolerance**: are the proposed guardrails (10 % max position, 5 % daily loss limit, 15 % drawdown stop) acceptable as defaults, or should they be more conservative?
4. **Live broker plans**: is there *any* roadmap toward real-money execution? If yes, the audit log + idempotency design need to be tightened now (e.g., enforce SOC2-style retention).
5. **Symbol universe**: stay on the current ~100 large-caps, expand to S&P 500, or add ETFs? Affects training cost and data fetch volume.
6. **User scale**: how many concurrent users do we expect at v1 launch? Drives whether `onnxruntime-node` in-process is fine (≤ a few hundred) or we need to break it out.
7. **Regulatory framing**: will marketing copy describe AI output as "ideas", "recommendations", or "advice"? Word choice has FINRA implications even for paper apps.
8. **Strategy ownership**: do we ship one canonical strategy, or let advanced users define their own via a config DSL? The latter is much more product but doubles engineering scope.
