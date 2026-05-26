"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Bell,
  Settings,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  ReferenceLine,
  Line,
} from "recharts";
import { findSymbol } from "@/lib/symbols";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdNoSym = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

type Range = "1D" | "5D" | "1M" | "YTD" | "6M" | "1Y" | "5Y" | "MAX";
const RANGES: Range[] = ["1D", "5D", "1M", "YTD", "6M", "1Y", "5Y", "MAX"];

function rangeToDays(r: Range): number {
  switch (r) {
    case "1D": return 2; // small window so chart isn't empty
    case "5D": return 7;
    case "1M": return 31;
    case "YTD": {
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      return Math.max(1, Math.ceil((now.getTime() - start.getTime()) / 86400000));
    }
    case "6M": return 183;
    case "1Y": return 365;
    case "5Y": return 365 * 5;
    case "MAX": return 365 * 10;
  }
}

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

type Point = { i: number; date: string; v: number; ma?: number };

export default function StockDetailPage() {
  const params = useParams<{ ticker: string }>();
  const tickerParam = (params?.ticker ?? "").toString().toUpperCase();
  const meta = findSymbol(tickerParam) ?? { ticker: tickerParam, name: tickerParam, category: "Trending" as const };

  const [range, setRange] = useState<Range>("6M");
  const [closes, setCloses] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const days = rangeToDays(range);
    const from = isoDaysAgo(days);
    const to = isoDaysAgo(0);
    fetch(`/api/history?symbols=${encodeURIComponent(tickerParam)}&from=${from}&to=${to}`, {
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => {
        if (cancelled) return;
        const m = (j && j[tickerParam]) ?? {};
        setCloses(m);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [tickerParam, range]);

  const points: Point[] = useMemo(() => {
    const dates = Object.keys(closes).sort();
    const arr: Point[] = dates.map((d, i) => ({ i, date: d, v: closes[d] }));
    // Compute simple 50-day MA when meaningful
    if (range === "5Y" || range === "MAX") {
      for (let i = 0; i < arr.length; i++) {
        const start = Math.max(0, i - 49);
        let sum = 0;
        let count = 0;
        for (let j = start; j <= i; j++) {
          sum += arr[j].v;
          count++;
        }
        arr[i].ma = sum / count;
      }
    }
    return arr;
  }, [closes, range]);

  const last = points[points.length - 1]?.v;
  const first = points[0]?.v ?? last;
  const prev = points[points.length - 2]?.v ?? first;
  const dayChange = last != null && prev != null ? last - prev : 0;
  const dayPct = last != null && prev ? (dayChange / prev) * 100 : 0;
  const red = dayChange < 0;

  const high = points.length ? Math.max(...points.map((p) => p.v)) : 0;
  const low = points.length ? Math.min(...points.map((p) => p.v)) : 0;
  const open = points[0]?.v ?? 0;
  const avg = points.length ? points.reduce((a, p) => a + p.v, 0) / points.length : 0;

  // 52w high/low — fetch a full year window once for the stat strip
  const [yearCloses, setYearCloses] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/history?symbols=${encodeURIComponent(tickerParam)}&from=${isoDaysAgo(365)}&to=${isoDaysAgo(0)}`, {
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => {
        if (cancelled) return;
        setYearCloses((j && j[tickerParam]) ?? {});
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [tickerParam]);
  const yearVals = Object.values(yearCloses);
  const high52 = yearVals.length ? Math.max(...yearVals) : high;
  const low52 = yearVals.length ? Math.min(...yearVals) : low;

  // Synthetic but stable volume from ticker hash
  const volSeed = useMemo(() => {
    let h = 2166136261;
    for (let i = 0; i < tickerParam.length; i++) {
      h ^= tickerParam.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
  }, [tickerParam]);
  const todayVol = 5_000_000 + (volSeed % 60_000_000);
  const avgVol = Math.round(todayVol * 0.92);

  return (
    <div className="min-h-screen px-8 py-6 max-w-[1700px] mx-auto">
      <TopBar />

      {/* Breadcrumb */}
      <div className="flex items-center text-xs text-muted gap-1 mb-5">
        <Link href="/" className="hover:text-white">HOME</Link>
        <ChevronRight className="w-3 h-3 text-brand" />
        <Link href="/stocks" className="hover:text-white">STOCKS</Link>
        <ChevronRight className="w-3 h-3 text-brand" />
        <span className="text-white">{meta.ticker}</span>
      </div>

      {/* Hero */}
      <div className="bg-panel border border-border rounded-xl p-6 mb-6">
        <div className="flex items-start justify-between mb-5 gap-6 flex-wrap">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <span className="text-white text-2xl font-semibold">{meta.name}</span>
              <span className="bg-bg border border-border rounded-md px-2 py-0.5 text-muted text-xs font-medium font-mono">
                {meta.ticker}
              </span>
            </div>
            <div className="text-white text-6xl font-semibold tabular-nums tracking-tight">
              {last != null ? usd.format(last) : "—"}
            </div>
            <div className={`text-sm mt-2 tabular-nums flex items-center gap-1 ${red ? "text-danger" : "text-brand"}`}>
              {red ? <ArrowDownRight className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
              {`${red ? "" : "+"}${dayChange.toFixed(2)} (${red ? "" : "+"}${dayPct.toFixed(2)}%)`}
            </div>
            <div className="text-muted text-xs mt-2">
              as of {points[points.length - 1]?.date ?? "—"} ET
            </div>
          </div>
          <div className="flex items-center gap-1 text-xs flex-wrap">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-1.5 rounded-lg ${
                  range === r ? "bg-brand/10 text-brand" : "text-muted hover:text-white"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        <Chart points={points} loading={loading} range={range} />
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
        <Stat label="Open" value={open ? usd.format(open) : "—"} />
        <Stat label="High" value={high ? usd.format(high) : "—"} />
        <Stat label="Low"  value={low ? usd.format(low) : "—"} />
        <Stat label="Avg"  value={avg ? usd.format(avg) : "—"} />
        <Stat label="Volume" value={compact.format(todayVol)} />
        <Stat label="52w high" value={high52 ? usd.format(high52) : "—"} />
        <Stat label="52w low"  value={low52 ? usd.format(low52) : "—"} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-panel border border-border rounded-xl p-4">
      <div className="text-muted text-[10px] uppercase tracking-wider mb-1">{label}</div>
      <div className="text-white text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Chart({ points, loading, range }: { points: Point[]; loading: boolean; range: Range }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ x: number; idx: number } | null>(null);

  const showMA = range === "5Y" || range === "MAX";

  const ticksX = useMemo(() => {
    if (points.length < 2) return [] as number[];
    const n = 5;
    const step = (points.length - 1) / (n - 1);
    return Array.from({ length: n }, (_, i) => Math.round(i * step));
  }, [points]);

  function fmtTickX(idx: number): string {
    const d = points[idx]?.date;
    if (!d) return "";
    const [y, m, day] = d.split("-");
    if (range === "1D" || range === "5D" || range === "1M") return `${m}/${day}`;
    if (range === "5Y" || range === "MAX") return `${y}`;
    return `${m}/${day}`;
  }

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    const el = containerRef.current;
    if (!el || points.length < 2) return;
    const rect = el.getBoundingClientRect();
    const padL = 12;
    const padR = 12;
    const usable = rect.width - padL - padR;
    const x = Math.max(padL, Math.min(rect.width - padR, e.clientX - rect.left));
    const t = (x - padL) / usable;
    const idx = Math.max(0, Math.min(points.length - 1, Math.round(t * (points.length - 1))));
    setHover({ x, idx });
  }

  const hoverPoint = hover ? points[hover.idx] : null;
  const hoverPrev = hover && hover.idx > 0 ? points[hover.idx - 1] : null;
  const hoverChange =
    hoverPoint && hoverPrev ? hoverPoint.v - hoverPrev.v : 0;
  const hoverPct =
    hoverPoint && hoverPrev && hoverPrev.v !== 0 ? (hoverChange / hoverPrev.v) * 100 : 0;
  const hoverRed = hoverChange < 0;

  return (
    <div
      ref={containerRef}
      className="h-[420px] relative"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-muted text-sm">Loading…</div>
      )}
      {!loading && points.length < 2 && (
        <div className="absolute inset-0 flex items-center justify-center text-muted text-sm">No data.</div>
      )}
      {points.length >= 2 && (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 20, right: 12, bottom: 10, left: 12 }}>
            <defs>
              <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#26E5A1" stopOpacity={0.30} />
                <stop offset="100%" stopColor="#26E5A1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 6" stroke="#1E2530" vertical={false} />
            <XAxis
              dataKey="i"
              ticks={ticksX}
              tickFormatter={(v) => fmtTickX(Number(v))}
              tick={{ fill: "#6B7383", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={(v) => usdNoSym.format(Number(v))}
              tick={{ fill: "#6B7383", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              domain={["auto", "auto"]}
              width={70}
            />
            {hover && (
              <ReferenceLine x={points[hover.idx]?.i} stroke="#6B7383" strokeDasharray="2 3" strokeWidth={1} />
            )}
            <Area
              type="monotone"
              dataKey="v"
              stroke="#26E5A1"
              strokeWidth={2.2}
              fill="url(#priceFill)"
              isAnimationActive={false}
            />
            {showMA && (
              <Line
                type="monotone"
                dataKey="ma"
                stroke="#F4B740"
                strokeWidth={1.6}
                dot={false}
                isAnimationActive={false}
                strokeOpacity={0.85}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      )}

      {hover && hoverPoint && (
        <div
          className="absolute pointer-events-none bg-[#1E2530] border border-border rounded-lg px-3 py-2 text-xs shadow-lg"
          style={{
            left: Math.max(12, Math.min(hover.x - 70, (containerRef.current?.clientWidth ?? 0) - 152)),
            top: 4,
            width: 140,
          }}
        >
          <div className="text-muted text-[10px] mb-1">{hoverPoint.date}</div>
          <div className="text-white tabular-nums font-semibold">{usd.format(hoverPoint.v)}</div>
          {hoverPrev && (
            <div className={`text-[11px] tabular-nums mt-1 ${hoverRed ? "text-danger" : "text-brand"}`}>
              {`${hoverRed ? "" : "+"}${hoverChange.toFixed(2)} (${hoverRed ? "" : "+"}${hoverPct.toFixed(2)}%)`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TopBar() {
  return (
    <header className="flex items-center justify-between mb-6">
      <div className="flex items-center gap-3">
        <Link href="/" className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-brand flex items-center justify-center">
            <div className="w-3 h-3 bg-bg rounded-sm" />
          </div>
          <span className="text-white font-semibold text-lg">Stocky</span>
        </Link>
      </div>
      <nav className="flex items-center gap-8 text-sm font-medium">
        <a href="/" className="text-white hover:text-brand">Us</a>
        <a href="/stocks" className="text-brand">Stocks</a>
        <a href="#" className="text-white hover:text-brand">Europe</a>
        <a href="#" className="text-white hover:text-brand">Asia</a>
        <a href="#" className="text-white hover:text-brand">Currencies</a>
        <a href="#" className="text-white hover:text-brand">Crypto</a>
        <a href="#" className="text-white hover:text-brand">Futures</a>
      </nav>
      <div className="flex items-center gap-5">
        <Settings className="w-5 h-5 text-muted" strokeWidth={1.7} />
        <div className="relative">
          <Bell className="w-5 h-5 text-muted" strokeWidth={1.7} />
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-brand" />
        </div>
        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-orange-300 to-rose-400" />
        <div className="leading-tight">
          <div className="text-white text-sm font-semibold">Mijan Rahaman</div>
          <div className="text-muted text-xs">Project Holder</div>
        </div>
        <div className="flex flex-col text-muted">
          <ChevronUp className="w-3 h-3" />
          <ChevronDown className="w-3 h-3" />
        </div>
      </div>
    </header>
  );
}

