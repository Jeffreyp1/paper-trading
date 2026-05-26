import { NextResponse } from "next/server";
import { NODE_API, tryJson } from "@/lib/api";

export const dynamic = "force-dynamic";

// The Node service exposes prices only via Redis HSET + WebSocket broadcast
// (services/stockService.js, wsServer.js). There is no HTTP GET for prices.
// We try a couple of plausible endpoints; if absent the caller gets {}.
// Known upstream gap documented in web/README.md.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbolsParam = url.searchParams.get("symbols");
  const wanted = symbolsParam
    ? symbolsParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : null;

  const candidates = [
    `${NODE_API}/api/v1/prices`,
    `${NODE_API}/api/prices`,
    `${NODE_API}/prices`,
  ];
  let prices: Record<string, number> = {};
  for (const u of candidates) {
    const data = await tryJson<unknown>(u, { timeoutMs: 800 });
    if (data && typeof data === "object") {
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
        if (Number.isFinite(n)) prices[k.toUpperCase()] = n;
      }
      if (Object.keys(prices).length) break;
    }
  }

  if (wanted) {
    const filtered: Record<string, number> = {};
    for (const s of wanted) if (s in prices) filtered[s] = prices[s];
    prices = filtered;
  }

  return NextResponse.json(prices);
}
