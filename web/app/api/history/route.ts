import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// GET /api/history?symbols=AAPL,MSFT&from=YYYY-MM-DD&to=YYYY-MM-DD
// Response: { [symbol]: { [date]: close } }
//
// Strategy:
//   1. Try Financial Modeling Prep historical-price-full per symbol (2s timeout).
//   2. On any failure or missing STOCK_API_KEY, generate a deterministic
//      synthetic price series seeded by symbol+date so the UI always renders.
//
// In-memory cache lives for the lifetime of this Node process (dev server).
// Keyed by `${symbol}:${from}:${to}` with 1h TTL. Paper trading scale.

type SeriesMap = Record<string, number>;
type CacheEntry = { ts: number; data: SeriesMap };
const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function syntheticSeries(symbol: string, from: string, to: string): SeriesMap {
  // seed from symbol
  let h = 2166136261;
  for (let i = 0; i < symbol.length; i++) {
    h ^= symbol.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const base = 50 + (Math.abs(h) % 350); // base price 50..400
  const out: SeriesMap = {};
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  let i = 0;
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const t = i;
    // smooth wave + small jitter, deterministic on (symbol, date)
    let dh = h ^ Math.imul(d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(), 2654435761);
    dh = Math.imul(dh ^ (dh >>> 15), 2246822507);
    const jitter = ((dh >>> 0) % 1000) / 1000 - 0.5;
    const v =
      base *
      (1 + 0.06 * Math.sin(t / 9 + (h % 7)) + 0.04 * Math.cos(t / 21) + 0.02 * jitter);
    out[iso] = Math.round(v * 100) / 100;
    i++;
  }
  return out;
}

async function fetchFmp(symbol: string, from: string, to: string): Promise<SeriesMap | null> {
  const key = process.env.STOCK_API_KEY;
  if (!key) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2000);
  try {
    const url = `https://financialmodelingprep.com/api/v3/historical-price-full/${encodeURIComponent(
      symbol,
    )}?from=${from}&to=${to}&apikey=${key}`;
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as { historical?: Array<{ date: string; close: number }> };
    if (!j?.historical?.length) return null;
    const map: SeriesMap = {};
    for (const row of j.historical) {
      if (typeof row?.date === "string" && Number.isFinite(row?.close)) {
        map[row.date] = row.close;
      }
    }
    return Object.keys(map).length ? map : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbols = (url.searchParams.get("symbols") ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!symbols.length || !from || !to) {
    return NextResponse.json({}, { status: 200 });
  }

  const out: Record<string, SeriesMap> = {};
  await Promise.all(
    symbols.map(async (sym) => {
      const k = `${sym}:${from}:${to}`;
      const hit = cache.get(k);
      if (hit && Date.now() - hit.ts < TTL_MS) {
        out[sym] = hit.data;
        return;
      }
      const real = await fetchFmp(sym, from, to);
      const data = real ?? syntheticSeries(sym, from, to);
      cache.set(k, { ts: Date.now(), data });
      out[sym] = data;
    }),
  );
  return NextResponse.json(out);
}
