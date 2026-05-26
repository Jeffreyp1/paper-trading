import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// GET /api/portfolio/at?userId=&date=YYYY-MM-DD
// Convenience single-day endpoint. Internally calls /api/portfolio/history
// with from=to=date so the same reconstruct logic is reused.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const userId = url.searchParams.get("userId") ?? "";
  const date = url.searchParams.get("date") ?? "";
  if (!date) return NextResponse.json({ date: "", value: 0, holdings: [] });

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2000);
  try {
    const r = await fetch(
      `${url.origin}/api/portfolio/history?userId=${encodeURIComponent(userId)}&from=${date}&to=${date}`,
      { signal: ctrl.signal, cache: "no-store" },
    );
    if (!r.ok) return NextResponse.json({ date, value: 0, holdings: [] });
    const arr = (await r.json()) as Array<{ date: string; value: number; holdings: unknown }>;
    return NextResponse.json(arr[0] ?? { date, value: 0, holdings: [] });
  } catch {
    return NextResponse.json({ date, value: 0, holdings: [] });
  } finally {
    clearTimeout(t);
  }
}
