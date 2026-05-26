import { NextResponse } from "next/server";
import { NODE_API, tryJson } from "@/lib/api";
import {
  FALLBACK_DASHBOARD,
  FALLBACK_DJI,
  type DashboardData,
} from "@/lib/fallback";
import { listWatchlist } from "@/lib/watchlistStore";

export const dynamic = "force-dynamic";

// Map a few well-known symbols (from services/stockService.js list) onto the
// 5 hardcoded "index" cards & "commodity" rows so we can show real data in
// fields the upstream doesn't actually expose.
const INDEX_SYMBOL_MAP: Array<{ key: string; title: string }> = [
  { key: "AAPL", title: "DAX PERFORMAE" },
  { key: "MSFT", title: "S$P 500" },
  { key: "GOOGL", title: "FTSE 100 INDEX" },
  { key: "AMZN", title: "S$P/TSX Composits" },
  { key: "NVDA", title: "NIKKEI 200" },
];

const COMMODITY_SYMBOL_MAP: Array<{ key: string; name: string }> = [
  { key: "META", name: "Platinum" },
  { key: "JNJ", name: "Silver" },
  { key: "V", name: "Copper" },
  { key: "PG", name: "Palladium" },
  { key: "UNH", name: "Rhodium" },
];

const DISCOVER_SYMBOL_MAP: Array<{ key: string; name: string; ticker: string }> = [
  { key: "TSLA", name: "Tesla Inc", ticker: "TSLA" },
  { key: "HD", name: "Home Depot", ticker: "HD" },
  { key: "MA", name: "Mastercard", ticker: "MA" },
  { key: "DIS", name: "Walt Disney", ticker: "DIS" },
  { key: "BAC", name: "Bank of America", ticker: "BAC" },
  { key: "VZ", name: "Verizon", ticker: "VZ" },
  { key: "ADBE", name: "Adobe Inc", ticker: "ADBE" },
  { key: "NFLX", name: "Netflix Inc", ticker: "NFLX" },
];

function fmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// The Node service does NOT expose an HTTP "all stock prices" endpoint
// (services/stockService.js writes to Redis, broadcasts via WebSocket only).
// We probe a couple of best-guess endpoints; if neither responds we fall back.
// This is documented as a "Known upstream gap" in README.
async function fetchStockPrices(): Promise<Record<string, number> | null> {
  const candidates = [
    `${NODE_API}/api/v1/prices`,
    `${NODE_API}/api/prices`,
    `${NODE_API}/prices`,
  ];
  for (const u of candidates) {
    const data = await tryJson<unknown>(u, { timeoutMs: 800 });
    if (data && typeof data === "object") {
      const map: Record<string, number> = {};
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
        if (Number.isFinite(n)) map[k] = n;
      }
      if (Object.keys(map).length > 0) return map;
    }
  }
  return null;
}

export async function GET() {
  const prices = await fetchStockPrices();
  const data: DashboardData = {
    indices: FALLBACK_DASHBOARD.indices,
    commodities: FALLBACK_DASHBOARD.commodities,
    dji: FALLBACK_DJI,
    watchlist: listWatchlist(),
    discover: FALLBACK_DASHBOARD.discover,
  };
  let live = false;

  if (prices) {
    live = true;
    data.indices = INDEX_SYMBOL_MAP.map((m, i) => {
      const p = prices[m.key];
      const fb = FALLBACK_DASHBOARD.indices[i];
      if (!Number.isFinite(p)) return fb;
      return {
        ...fb,
        value: fmt(p),
        delta: fb.delta,
        pct: fb.pct,
        red: false,
      };
    });
    data.commodities = COMMODITY_SYMBOL_MAP.map((m, i) => {
      const p = prices[m.key];
      const fb = FALLBACK_DASHBOARD.commodities[i];
      if (!Number.isFinite(p)) return fb;
      return { ...fb, value: fmt(p), red: false };
    });
    data.discover = DISCOVER_SYMBOL_MAP.map((m, i) => {
      const p = prices[m.key];
      const fb = FALLBACK_DASHBOARD.discover[i];
      if (!Number.isFinite(p)) return fb;
      return { ...fb, name: m.name, ticker: m.ticker, price: `$${fmt(p)}` };
    });

    // Use AAPL as a stand-in for the DJI big number if we have it.
    const dji = prices.AAPL;
    if (Number.isFinite(dji)) {
      data.dji = { ...FALLBACK_DJI, value: fmt(dji) };
    }
  }

  return NextResponse.json(
    { ...data, _live: live },
    { headers: { "x-stocky-source": live ? "live" : "cached" } },
  );
}
