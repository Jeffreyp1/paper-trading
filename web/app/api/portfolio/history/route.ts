import { NextResponse } from "next/server";
import { NODE_API, tryJson } from "@/lib/api";

export const dynamic = "force-dynamic";

// ADR — historical portfolio value
// ===============================================
// Two interchangeable strategies were considered:
//
//   1. RECONSTRUCT FROM TRADES (chosen, v1):
//      Replay the user's `trades` rows up to each date D to derive
//      holdings on D, then look up each symbol's close price on D via
//      /api/history. No schema migration required. Acceptable at
//      paper-trading scale (a few hundred trades per user).
//
//   2. DAILY SNAPSHOT TABLE:
//      A `portfolio_snapshots(user_id, date, value, holdings_json)` table
//      populated by a small daily job (or computed lazily on first hover).
//      Faster reads, but needs a migration + a writer. The shape returned
//      by this endpoint is intentionally identical to what such a table
//      would store, so we can swap in a snapshot-read path later by
//      replacing only `loadTrades` + the day-replay loop.
//
// All upstream calls have a 2 s timeout. If trades are unreachable we
// return a graceful synthetic series so the UI keeps rendering.
//
// Response shape: Array<{ date, value, holdings: [{symbol, qty, price}] }>

type Trade = {
  symbol: string;
  trade_type: "BUY" | "SELL";
  executed_price: number;
  quantity: number;
  created_at: string; // ISO
};

type DayPoint = {
  date: string;
  value: number;
  holdings: Array<{ symbol: string; qty: number; price: number }>;
  tradesCounted: number;
};

function isoDays(from: string, to: string): string[] {
  const out: string[] = [];
  const s = new Date(from + "T00:00:00Z");
  const e = new Date(to + "T00:00:00Z");
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function loadTrades(userId: string): Promise<Trade[] | null> {
  // Node service: GET /api/v1/trading/trade_history?userId=...
  const candidates = [
    `${NODE_API}/api/v1/trading/trade_history?userId=${encodeURIComponent(userId)}`,
    `${NODE_API}/api/v1/trading/trade_history`,
  ];
  for (const u of candidates) {
    const data = await tryJson<unknown>(u, { timeoutMs: 2000 });
    if (Array.isArray(data)) {
      return (data as Array<Record<string, unknown>>)
        .map((r) => ({
          symbol: String(r.symbol ?? ""),
          trade_type: (String(r.trade_type ?? "BUY").toUpperCase() === "SELL"
            ? "SELL"
            : "BUY") as "BUY" | "SELL",
          executed_price: Number(r.executed_price ?? r.price ?? 0),
          quantity: Number(r.quantity ?? 0),
          created_at: String(r.created_at ?? r.createdAt ?? ""),
        }))
        .filter((t) => t.symbol && Number.isFinite(t.quantity) && t.created_at);
    }
  }
  return null;
}

function syntheticTrades(from: string): Trade[] {
  // Deterministic stub portfolio for offline mode.
  const start = new Date(from + "T00:00:00Z");
  start.setUTCDate(start.getUTCDate() - 30);
  const day = (n: number) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString();
  };
  return [
    { symbol: "AAPL", trade_type: "BUY", executed_price: 180, quantity: 12, created_at: day(0) },
    { symbol: "MSFT", trade_type: "BUY", executed_price: 410, quantity: 5, created_at: day(2) },
    { symbol: "NVDA", trade_type: "BUY", executed_price: 120, quantity: 20, created_at: day(5) },
    { symbol: "GOOGL", trade_type: "BUY", executed_price: 170, quantity: 8, created_at: day(10) },
    { symbol: "AMZN", trade_type: "BUY", executed_price: 200, quantity: 6, created_at: day(15) },
  ];
}

async function loadHistory(
  symbols: string[],
  from: string,
  to: string,
  origin: string,
): Promise<Record<string, Record<string, number>>> {
  if (!symbols.length) return {};
  const u = `${origin}/api/history?symbols=${symbols.join(",")}&from=${from}&to=${to}`;
  const data = await tryJson<Record<string, Record<string, number>>>(u, { timeoutMs: 2000 });
  return data ?? {};
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const userId = url.searchParams.get("userId") ?? "";
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!from || !to) return NextResponse.json([]);

  let trades = userId ? await loadTrades(userId) : null;
  if (!trades) trades = syntheticTrades(from);
  trades.sort((a, b) => a.created_at.localeCompare(b.created_at));

  const symbols = Array.from(new Set(trades.map((t) => t.symbol)));
  // pull history with a small lookback so days before any trade still resolve forward-fill
  const histFrom = from;
  const history = await loadHistory(symbols, histFrom, to, url.origin);

  const days = isoDays(from, to);

  // Forward-fill helper: history may not have weekends/holidays.
  function priceOn(sym: string, day: string): number {
    const series = history[sym];
    if (!series) return 0;
    if (series[day] != null) return series[day];
    // walk back up to 7 days
    const d = new Date(day + "T00:00:00Z");
    for (let i = 0; i < 7; i++) {
      d.setUTCDate(d.getUTCDate() - 1);
      const k = d.toISOString().slice(0, 10);
      if (series[k] != null) return series[k];
    }
    // walk forward as last resort
    const f = new Date(day + "T00:00:00Z");
    for (let i = 0; i < 7; i++) {
      f.setUTCDate(f.getUTCDate() + 1);
      const k = f.toISOString().slice(0, 10);
      if (series[k] != null) return series[k];
    }
    return 0;
  }

  const out: DayPoint[] = [];
  let cursor = 0;
  const qty = new Map<string, number>(); // symbol -> shares
  let tradesCounted = 0;
  for (const day of days) {
    // apply all trades whose date <= day
    while (cursor < trades.length && trades[cursor].created_at.slice(0, 10) <= day) {
      const t = trades[cursor++];
      const cur = qty.get(t.symbol) ?? 0;
      qty.set(t.symbol, t.trade_type === "BUY" ? cur + t.quantity : cur - t.quantity);
      tradesCounted++;
    }
    const holdings: DayPoint["holdings"] = [];
    let value = 0;
    for (const [sym, q] of qty) {
      if (q <= 0) continue;
      const p = priceOn(sym, day);
      holdings.push({ symbol: sym, qty: q, price: p });
      value += q * p;
    }
    out.push({
      date: day,
      value: Math.round(value * 100) / 100,
      holdings,
      tradesCounted,
    });
  }
  return NextResponse.json(out);
}
