# Stocky web

Next.js 14 dashboard for the paper-trading backend. Runs on port `3001`.

## Environment

Copy `.env.local.example` to `.env.local`:

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_API` | `http://localhost:3000` | Node/Express service (server-side only). |
| `GO_API` | `http://localhost:8081` | Go trading service (server-side only). Used by `/api/stress`. |
| `NEXT_PUBLIC_WS_URL` | `ws://localhost:8080` | Browser-exposed WebSocket URL (`wsServer.js`). |

`NODE_API` / `GO_API` are read **only inside route handlers** — they never reach the client, so CORS is irrelevant.

## Architecture

The page (`app/page.tsx`) calls our own `/api/dashboard`, `/api/prices`, `/api/watchlist`, `/api/stress`. Each route handler proxies to the closest upstream and falls back silently to seed values from `lib/fallback.ts` when an upstream is unreachable. The visual layout is identical regardless of backend health.

A small dot next to the "Stocky" wordmark indicates connection status:

- green = WebSocket connected (live)
- gray = polling `/api/dashboard` every 5s (cached / offline)

## Known upstream gaps

The following endpoints don't exist in the current Node/Go services. Per the task contract we did not modify backend source; the route handlers below either fake the data from fallbacks or improvise.

- **No HTTP price feed.** `services/stockService.js` writes prices to Redis (`stockPrices` hash) and `wsServer.js` broadcasts them over WebSocket. There is no `GET /prices`. `app/api/prices/route.ts` and `app/api/dashboard/route.ts` probe a few plausible URLs and otherwise return fallbacks. The dashboard's primary live channel is the WebSocket.
- **No watchlist routes.** `db.sql` declares `watchlists` and `watchlist_items` but no Node/Go route reads or writes them (CLAUDE.md, "Data Model"). `app/api/watchlist/*` is backed by an in-process store (`lib/watchlistStore.ts`) seeded from the dashboard fallbacks. State persists across requests inside the dev server but resets on restart.
- **No load-test metrics endpoint.** Go's `main.go` runs an internal load test on boot and only logs results. `app/api/stress/route.ts` instead probes the upstream's `/api/health` directly (parallel HTTP requests), aggregates real `p50/p95/p99`, and returns synthetic numbers if the service is unreachable.
- **`leaderboard` requires JWT.** `routes/v1/analytics/leaderboard.js` is gated by `authenticateToken`. We do not call it from the dashboard; the WebSocket pushes leaderboard updates without auth, so we rely on that path if needed in future.

## Scripts

- `npm run dev` — Next.js dev server on `:3001`.
- `node scripts/snap.mjs <url> <out>` — Playwright screenshot helper.
