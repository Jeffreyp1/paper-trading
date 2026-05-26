"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  Settings,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  ArrowUpRight,
  ArrowDownRight,
  X,
} from "lucide-react";
import {
  AreaChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  ReferenceLine,
  Tooltip,
  LineChart,
} from "recharts";
import {
  FALLBACK_DASHBOARD,
  FALLBACK_DJI_POINTS,
  type DashboardData,
} from "@/lib/fallback";

type PortfolioPoint = {
  date: string;
  value: number;
  holdings: Array<{ symbol: string; qty: number; price: number }>;
  tradesCounted: number;
};

const RANGES: Record<string, number> = {
  "1D": 1,
  "5D": 5,
  "1M": 30,
  YTD: 0, // computed
  "6M": 180,
  "1Y": 365,
  "5Y": 365 * 5,
  MAX: 365 * 5,
};

const USER_ID = "1"; // demo user; backend falls back to synthetic if unreachable

function rangeBounds(label: string): { from: string; to: string } {
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  let days = RANGES[label] ?? 30;
  if (label === "YTD") {
    const jan1 = new Date(today.getUTCFullYear(), 0, 1);
    days = Math.max(1, Math.floor((today.getTime() - jan1.getTime()) / 86400000));
  }
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - days);
  return { from: from.toISOString().slice(0, 10), to };
}

function fmtCurrency(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function fmtDateLabel(d: string): string {
  const dt = new Date(d + "T00:00:00Z");
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function Sparkline({ seed = 0 }: { seed?: number }) {
  const data = Array.from({ length: 24 }, (_, i) => ({
    i,
    v:
      10 +
      4 * Math.sin(i * 0.55 + seed) +
      2 * Math.cos(i * 1.1 + 0.4 + seed) +
      Math.sin(i * 0.2 + seed),
  }));
  return (
    <div className="h-10 w-full relative">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <Line
            type="monotone"
            dataKey="v"
            stroke="#5E8A78"
            strokeWidth={1.4}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="absolute right-1 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-brand" />
    </div>
  );
}

type LiveState = "live" | "cached";

export default function Page() {
  const [data, setData] = useState<DashboardData>(FALLBACK_DASHBOARD);
  const [live, setLive] = useState<LiveState>("cached");
  const [range, setRange] = useState<string>("1M");
  const [portfolio, setPortfolio] = useState<PortfolioPoint[]>([]);
  const [benchmark, setBenchmark] = useState<Record<string, number>>({});
  const [shimmer, setShimmer] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttemptsRef = useRef(0);

  // Fetch portfolio + benchmark on range change. Fire both in parallel,
  // commit whichever arrives first; never block on either.
  useEffect(() => {
    let cancelled = false;
    setShimmer(true);
    const shimmerTimer = setTimeout(() => setShimmer(false), 400);
    const { from, to } = rangeBounds(range);

    fetch(`/api/portfolio/history?userId=${USER_ID}&from=${from}&to=${to}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .then((arr: PortfolioPoint[]) => {
        if (cancelled) return;
        setPortfolio(Array.isArray(arr) ? arr : []);
      })
      .catch(() => {});

    fetch(`/api/history?symbols=SPY&from=${from}&to=${to}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((j: Record<string, Record<string, number>>) => {
        if (cancelled) return;
        setBenchmark(j?.SPY ?? {});
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      clearTimeout(shimmerTimer);
    };
  }, [range]);

  // Build the chart series: portfolio value (green) + benchmark normalized
  // to the portfolio's first value so both are visible on the same axis.
  const chartSeries = useMemo(() => {
    if (!portfolio.length) return [] as Array<{ date: string; green: number; orange: number | null; idx: number }>;
    const firstPortfolio = portfolio.find((p) => p.value > 0)?.value ?? 1;
    const benchKeys = Object.keys(benchmark);
    const firstBench =
      benchKeys.length && benchmark[benchKeys[0]] ? benchmark[benchKeys[0]] : 1;
    const scale = firstPortfolio / (firstBench || 1);
    return portfolio.map((p, idx) => {
      const b = benchmark[p.date];
      const orange = Number.isFinite(b) ? (b as number) * scale : null;
      return { date: p.date, green: p.value, orange, idx };
    });
  }, [portfolio, benchmark]);

  const currentValue = portfolio.length ? portfolio[portfolio.length - 1].value : 0;

  // Initial fetch + on-demand re-fetch helper.
  async function refresh() {
    try {
      const res = await fetch("/api/dashboard", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as DashboardData & { _live?: boolean };
      setData({
        indices: body.indices ?? FALLBACK_DASHBOARD.indices,
        commodities: body.commodities ?? FALLBACK_DASHBOARD.commodities,
        dji: body.dji ?? FALLBACK_DASHBOARD.dji,
        watchlist: body.watchlist ?? FALLBACK_DASHBOARD.watchlist,
        discover: body.discover ?? FALLBACK_DASHBOARD.discover,
      });
      if (body._live) setLive("live");
    } catch {
      // swallow — keep current state, no console spam
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // WebSocket: per CLAUDE.md, wsServer.js broadcasts {type:"stocks",data:{...}}
  // with no required subscribe message. On disconnect/error, fall back to a 5s
  // poll of /api/dashboard. Don't reconnect-storm.
  useEffect(() => {
    let cancelled = false;
    const wsUrl =
      (process.env.NEXT_PUBLIC_WS_URL as string | undefined) ?? "ws://localhost:8080";

    function startPolling() {
      if (pollRef.current) return;
      pollRef.current = setInterval(refresh, 5000);
      setLive("cached");
    }
    function stopPolling() {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }

    function connect() {
      if (cancelled) return;
      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrl);
      } catch {
        startPolling();
        return;
      }
      wsRef.current = socket;

      socket.onopen = () => {
        reconnectAttemptsRef.current = 0;
        stopPolling();
        setLive("live");
      };
      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg && msg.type === "stocks" && msg.data && typeof msg.data === "object") {
            applyStockUpdate(msg.data as Record<string, string>);
            setLive("live");
          }
        } catch {
          // ignore malformed payloads
        }
      };
      const onClose = () => {
        wsRef.current = null;
        if (cancelled) return;
        startPolling();
        // Backoff reconnect: 2s, 4s, 8s, capped at 30s.
        const attempt = ++reconnectAttemptsRef.current;
        const delay = Math.min(30_000, 2000 * 2 ** Math.min(attempt - 1, 4));
        setTimeout(connect, delay);
      };
      socket.onerror = () => {
        try { socket.close(); } catch {}
      };
      socket.onclose = onClose;
    }

    connect();

    return () => {
      cancelled = true;
      stopPolling();
      const s = wsRef.current;
      wsRef.current = null;
      if (s) try { s.close(); } catch {}
    };
  }, []);

  function applyStockUpdate(stocks: Record<string, string>) {
    const num = (k: string) => {
      const v = parseFloat(stocks[k]);
      return Number.isFinite(v) ? v : null;
    };
    const fmt = (n: number) =>
      n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    setData((prev) => {
      const symMap = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA"];
      const indices = prev.indices.map((c, i) => {
        const v = num(symMap[i]);
        if (v == null) return c;
        return { ...c, value: fmt(v) };
      });

      const commSyms = ["META", "JNJ", "V", "PG", "UNH"];
      const commodities = prev.commodities.map((c, i) => {
        const v = num(commSyms[i]);
        if (v == null) return c;
        return { ...c, value: fmt(v) };
      });

      const watchSyms = ["AAPL", "MSFT", "GOOGL", "AMZN"];
      const watchlist = prev.watchlist.map((row, i) => {
        const v = num(watchSyms[i]);
        if (v == null) return row;
        return { ...row, value: fmt(v) };
      });

      // Append a new chart point, keep length 80.
      const last = prev.dji.points[prev.dji.points.length - 1] ?? FALLBACK_DJI_POINTS[FALLBACK_DJI_POINTS.length - 1];
      const dow = num("AAPL");
      const next = dow != null
        ? { i: last.i + 1, green: ((dow / 10) % 50), orange: last.orange }
        : last;
      const points = [...prev.dji.points.slice(1), next].map((p, i) => ({ ...p, i }));
      const dji = dow != null ? { ...prev.dji, value: fmt(dow), points } : { ...prev.dji, points };

      return { ...prev, indices, commodities, watchlist, dji };
    });
  }

  const indexCards = data.indices;
  const commodities = data.commodities;
  const watchlist = data.watchlist;
  const discover = data.discover;

  return (
    <div className="min-h-screen px-8 py-6 max-w-[1700px] mx-auto">
      {/* Top Bar */}
      <header className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-brand flex items-center justify-center">
            <div className="w-3 h-3 bg-bg rounded-sm" />
          </div>
          <span className="text-white font-semibold text-lg">Stocky</span>
          <span
            aria-label={live === "live" ? "live" : "cached"}
            title={live === "live" ? "live" : "cached / offline"}
            className={`ml-1 w-1.5 h-1.5 rounded-full ${
              live === "live" ? "bg-brand" : "bg-muted/60"
            }`}
          />
        </div>

        <nav className="flex items-center gap-8 text-sm font-medium">
          <a href="#" className="text-white hover:text-brand">Us</a>
          <a href="/stocks" className="text-white hover:text-brand">Stocks</a>
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

      {/* Row 1 - Index Cards */}
      <div className="grid grid-cols-5 gap-4 mb-4">
        {indexCards.map((c, i) => (
          <div
            key={i}
            className="bg-panel border border-border rounded-xl p-5"
          >
            <div className="text-muted text-xs tracking-wider uppercase mb-3">
              {c.title}
            </div>
            <div className="text-white text-3xl font-semibold mb-1 tabular-nums">
              {c.value}
            </div>
            <div className={`text-xs mb-4 tabular-nums ${c.red ? "text-danger" : "text-brand"}`}>
              {c.delta} {c.pct}
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted">{c.code}</span>
              <span className={`flex items-center gap-1 tabular-nums ${c.red ? "text-danger" : "text-brand"}`}>
                {c.red ? (
                  <ArrowDownRight className="w-3 h-3" />
                ) : (
                  <ArrowUpRight className="w-3 h-3" />
                )}
                {c.delta} {c.pct}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Row 2 - Commodities */}
      <div className="bg-panel border border-border rounded-xl flex items-center mb-6">
        {commodities.map((c, i) => (
          <div
            key={i}
            className={`flex-1 flex items-center gap-3 px-5 py-4 ${
              i < commodities.length - 1 ? "border-r border-border" : ""
            }`}
          >
            <div
              className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                c.red ? "bg-danger/15" : "bg-brand/15"
              }`}
            >
              {c.red ? (
                <ArrowDownRight className="w-5 h-5 text-danger" />
              ) : (
                <ArrowUpRight className="w-5 h-5 text-brand" />
              )}
            </div>
            <div className="flex-1">
              <div className="text-white text-sm font-medium">{c.name}</div>
              <div className="text-white text-lg font-semibold tabular-nums">
                {c.value}
              </div>
            </div>
            <div className={`text-xs tabular-nums text-right ${c.red ? "text-danger" : "text-brand"}`}>
              <div>{c.delta}</div>
              <div>{c.pct}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Main split */}
      <div className="grid grid-cols-[1fr_460px] gap-6">
        {/* Left column */}
        <div className="space-y-6">
          {/* Chart card */}
          <div className={`bg-panel border border-border rounded-xl p-6 relative ${shimmer && !portfolio.length ? "animate-pulse" : ""}`}>
            <div className="flex items-center text-xs text-muted gap-1 mb-4">
              <span>HOME</span>
              <ChevronRight className="w-3 h-3 text-brand" />
              <span>PORTFOLIO</span>
            </div>

            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="text-white text-5xl font-semibold tabular-nums mb-2">
                  {fmtCurrency(currentValue)}
                </div>
                <div className="text-muted text-xs">
                  {portfolio.length
                    ? `${fmtDateLabel(portfolio[0].date)} — ${fmtDateLabel(portfolio[portfolio.length - 1].date)}`
                    : "loading…"}
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs">
                {["1D", "5D", "1M", "YTD", "6M", "1Y", "5Y", "MAX"].map((p) => (
                  <button
                    key={p}
                    onClick={() => setRange(p)}
                    className={`px-3 py-1.5 rounded-lg ${
                      p === range
                        ? "bg-brand/10 text-brand"
                        : "text-muted hover:text-white"
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            <div className="h-[340px] relative">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={chartSeries}
                  margin={{ top: 20, right: 12, bottom: 10, left: 12 }}
                >
                  <defs>
                    <linearGradient id="greenFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#26E5A1" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="#26E5A1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    strokeDasharray="3 6"
                    stroke="#1E2530"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#6B7383", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    minTickGap={48}
                    tickFormatter={(v) => fmtDateLabel(String(v))}
                  />
                  <YAxis
                    tick={{ fill: "#6B7383", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
                    domain={["auto", "auto"]}
                  />
                  <Tooltip
                    cursor={{ stroke: "#6B7383", strokeDasharray: "2 3", strokeWidth: 1 }}
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const row = payload[0].payload as { date: string; green: number; idx: number };
                      const point = portfolio[row.idx];
                      if (!point) return null;
                      return (
                        <div className="bg-[#1E2530] border border-border rounded-lg px-3 py-2 text-xs shadow-lg min-w-[220px]">
                          <div className="text-muted mb-1">{fmtDateLabel(point.date)}</div>
                          <div className="text-brand font-semibold tabular-nums mb-2">
                            {fmtCurrency(point.value)}
                          </div>
                          {point.holdings.length === 0 ? (
                            <div className="text-muted">no holdings on this date</div>
                          ) : (
                            <div className="space-y-0.5">
                              {point.holdings.slice(0, 8).map((h) => (
                                <div key={h.symbol} className="flex justify-between gap-3 text-white tabular-nums">
                                  <span className="text-muted">{h.symbol} × {h.qty}</span>
                                  <span>{fmtCurrency(h.qty * h.price)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                          <div className="text-muted mt-2 pt-2 border-t border-border text-[10px]">
                            calculated from {point.tradesCounted} trade{point.tradesCounted === 1 ? "" : "s"} up to this date
                          </div>
                        </div>
                      );
                    }}
                  />
                  {chartSeries.length > 0 && (
                    <ReferenceLine
                      x={chartSeries[Math.floor(chartSeries.length * 0.6)].date}
                      stroke="#6B7383"
                      strokeDasharray="2 3"
                      strokeWidth={1}
                    />
                  )}
                  <Area
                    type="monotone"
                    dataKey="green"
                    stroke="#26E5A1"
                    strokeWidth={2.2}
                    fill="url(#greenFill)"
                    isAnimationActive={false}
                    connectNulls
                  />
                  <Area
                    type="monotone"
                    dataKey="orange"
                    stroke="#F4B740"
                    strokeWidth={2.2}
                    fill="transparent"
                    isAnimationActive={false}
                    connectNulls
                  />
                </AreaChart>
              </ResponsiveContainer>
              <div className="absolute right-2 top-1 flex items-center gap-3 text-[10px] text-muted">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-brand inline-block" />Portfolio</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-warm inline-block" />S&amp;P 500 (SPY)</span>
              </div>
            </div>
          </div>

          {/* Watchlist */}
          <div className="bg-panel border border-border rounded-xl p-6">
            <div className="space-y-1">
              {watchlist.map((row, i) => {
                const watchTickers = ["AAPL", "MSFT", "GOOGL", "AMZN"];
                const tk = watchTickers[i] ?? "AAPL";
                return (
                <div
                  key={row.id ?? i}
                  className="grid grid-cols-[24px_1.6fr_1fr_1fr_1fr_120px_24px] items-center gap-4 py-3 border-b border-border last:border-b-0"
                >
                  <div className="w-5 h-5 rounded-md border border-border" />
                  <a href={`/stocks/${tk}`} className="text-white text-sm font-medium hover:text-brand">{row.name}</a>
                  <div className="text-white text-sm tabular-nums">{row.value}</div>
                  <div className="text-muted text-sm tabular-nums">{row.change}</div>
                  <div className="text-white text-sm tabular-nums">{row.num}</div>
                  <button className="flex items-center justify-center gap-1 px-3 py-1.5 rounded-full border border-brand/40 text-brand text-xs tabular-nums hover:bg-brand/10">
                    <ArrowUpRight className="w-3 h-3" />
                    {row.num}
                  </button>
                  <button
                    aria-label="remove"
                    onClick={async () => {
                      if (!row.id) return;
                      await fetch(`/api/watchlist/${row.id}`, { method: "DELETE" }).catch(() => {});
                      setData((prev) => ({
                        ...prev,
                        watchlist: prev.watchlist.filter((r) => r.id !== row.id),
                      }));
                    }}
                  >
                    <X className="w-4 h-4 text-muted" />
                  </button>
                </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right column - Discover more */}
        <div className="bg-panel border border-border rounded-xl p-6">
          <div className="text-white font-semibold text-lg">Dicover more</div>
          <div className="text-muted text-xs mb-5">you may be interested in</div>

          <div className="grid grid-cols-2 gap-3">
            {discover.map((d, i) => (
              <a
                key={i}
                href={`/stocks/${(d.ticker || "").trim().toUpperCase()}`}
                className="bg-panel2 border border-border rounded-xl p-4 relative hover:border-brand/40 transition-colors"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="text-white text-sm font-medium leading-tight pr-2">
                    {d.name}
                  </div>
                  <div className="bg-bg border border-border rounded-md px-2 py-0.5 text-muted text-[10px] font-medium">
                    {d.ticker}
                  </div>
                </div>
                <div className="text-white text-xl font-semibold tabular-nums mb-3">
                  {d.price}
                </div>
                <div className="absolute right-3 bottom-12 bg-bg border border-border rounded-md px-1.5 py-0.5 text-brand text-[10px] tabular-nums">
                  {d.pct}
                </div>
                <Sparkline seed={i * 0.7} />
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
