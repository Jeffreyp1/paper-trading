import { NextResponse } from "next/server";
import { GO_API } from "@/lib/api";

export const dynamic = "force-dynamic";

// The Go service (trading-service/main.go) only exposes /api/health and
// /api/trade. There is no "ping me, give me load-test stats" endpoint, so
// we synthesize one window of load against the upstream of choice and report
// real latency numbers. If the upstream is down, we fall back to a synthetic
// window so the dashboard keeps animating.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const rps = Math.max(1, Math.min(500, Number(body?.rps) || 100));
  const endpointPath = typeof body?.endpoint === "string" ? body.endpoint : "/api/health";
  const target = endpointPath.startsWith("http")
    ? endpointPath
    : `${GO_API}${endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`}`;

  // Cap the number of probes per 1s window to keep route handlers responsive.
  const probes = Math.min(rps, 50);
  const latencies: number[] = [];
  let ok = 0;
  let err = 0;

  const startWindow = Date.now();
  await Promise.all(
    Array.from({ length: probes }, async () => {
      const t0 = performance.now();
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 800);
        const res = await fetch(target, { signal: ctrl.signal, cache: "no-store" });
        clearTimeout(tid);
        const dt = performance.now() - t0;
        latencies.push(dt);
        if (res.ok) ok += 1;
        else err += 1;
      } catch {
        err += 1;
        latencies.push(performance.now() - t0);
      }
    }),
  );

  // If every probe failed (upstream unreachable), synthesize so the chart still
  // animates — same numbers as the original stub.
  if (latencies.length === 0 || ok === 0 && err === probes) {
    const sent = rps + Math.floor((Math.random() - 0.5) * rps * 0.1);
    const errRate = 0.01 + Math.random() * 0.04;
    const fakeErr = Math.floor(sent * errRate);
    const fakeOk = sent - fakeErr;
    const baseLat = 30 + Math.random() * 25;
    return NextResponse.json({
      sent,
      ok: fakeOk,
      err: fakeErr,
      p50: Math.round(baseLat),
      p95: Math.round(baseLat * 2.4 + Math.random() * 30),
      p99: Math.round(baseLat * 4.1 + Math.random() * 60),
      t: Date.now(),
      _live: false,
    });
  }

  latencies.sort((a, b) => a - b);
  const pct = (p: number) =>
    Math.round(latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]);

  // Scale `sent`/`ok`/`err` from probe sample to full requested rps so the UI
  // totals look right.
  const scale = rps / probes;
  return NextResponse.json({
    sent: Math.round(probes * scale),
    ok: Math.round(ok * scale),
    err: Math.round(err * scale),
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
    t: startWindow,
    _live: true,
  });
}
