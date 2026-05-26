"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Bell, Settings, ChevronUp, ChevronDown, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import { SYMBOLS, searchSymbols, type SymbolEntry } from "@/lib/symbols";

const CATEGORIES: SymbolEntry["category"][] = ["Trending", "Popular", "Tech", "Finance"];

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

type SeriesMap = Record<string, number>;

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export default function StocksPage() {
  const [series, setSeries] = useState<Record<string, SeriesMap>>({});

  // Fetch a small recent window for sparkline + price for every catalog ticker.
  useEffect(() => {
    const symbols = SYMBOLS.map((s) => s.ticker).join(",");
    const from = isoDaysAgo(30);
    const to = isoDaysAgo(0);
    fetch(`/api/history?symbols=${encodeURIComponent(symbols)}&from=${from}&to=${to}`, {
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => setSeries(j ?? {}))
      .catch(() => setSeries({}));
  }, []);

  return (
    <div className="min-h-screen px-8 py-6 max-w-[1700px] mx-auto">
      <TopBar />

      {/* Page header */}
      <div className="mb-6">
        <div className="text-white text-4xl font-semibold tracking-tight">Stocks</div>
        <div className="text-muted text-sm mt-2">Search a ticker or browse popular names.</div>
      </div>

      <SearchBar />

      <div className="mt-10 space-y-8">
        {CATEGORIES.map((cat) => (
          <BrowseStrip
            key={cat}
            title={cat}
            symbols={SYMBOLS.filter((s) => s.category === cat)}
            series={series}
          />
        ))}
      </div>
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

function SearchBar() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 150);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const matches = useMemo(() => searchSymbols(debounced, 8), [debounced]);
  const showDropdown = open && q.trim().length > 0 && matches.length > 0;

  return (
    <div ref={wrapRef} className="relative max-w-[720px]">
      <div className="flex items-center gap-3 bg-panel border border-border rounded-xl px-4 py-3 focus-within:border-brand/60">
        <Search className="w-4 h-4 text-muted" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder="Search for a stock (AAPL, MSFT, …)"
          className="flex-1 bg-transparent outline-none text-white placeholder:text-muted text-sm"
        />
        {q && (
          <button onClick={() => setQ("")} className="text-muted text-xs hover:text-white">clear</button>
        )}
      </div>
      {showDropdown && (
        <div className="absolute z-20 left-0 right-0 mt-2 bg-panel border border-border rounded-xl overflow-hidden shadow-xl">
          {matches.map((m) => (
            <Link
              key={m.ticker}
              href={`/stocks/${m.ticker}`}
              className="flex items-center justify-between px-4 py-3 hover:bg-panel2 border-b border-border last:border-b-0"
            >
              <span className="text-white text-sm">{m.name}</span>
              <span className="bg-bg border border-border rounded-md px-2 py-0.5 text-muted text-[10px] font-medium font-mono">
                {m.ticker}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function BrowseStrip({
  title,
  symbols,
  series,
}: {
  title: string;
  symbols: SymbolEntry[];
  series: Record<string, SeriesMap>;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  function scroll(dx: number) {
    scrollerRef.current?.scrollBy({ left: dx, behavior: "smooth" });
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="text-white font-semibold text-lg">{title}</div>
        <div className="flex gap-2">
          <button
            onClick={() => scroll(-400)}
            className="w-8 h-8 rounded-lg border border-border bg-panel hover:border-brand/50 flex items-center justify-center"
            aria-label={`scroll ${title} left`}
          >
            <ChevronLeft className="w-4 h-4 text-muted" />
          </button>
          <button
            onClick={() => scroll(400)}
            className="w-8 h-8 rounded-lg border border-border bg-panel hover:border-brand/50 flex items-center justify-center"
            aria-label={`scroll ${title} right`}
          >
            <ChevronRight className="w-4 h-4 text-muted" />
          </button>
        </div>
      </div>
      <div
        ref={scrollerRef}
        className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-thin"
        style={{ scrollbarWidth: "thin" }}
      >
        {symbols.map((s) => (
          <BrowseCard key={s.ticker} entry={s} closes={series[s.ticker]} />
        ))}
      </div>
    </section>
  );
}

function BrowseCard({ entry, closes }: { entry: SymbolEntry; closes?: SeriesMap }) {
  const dates = closes ? Object.keys(closes).sort() : [];
  const points = dates.map((d, i) => ({ i, v: closes![d] }));
  const last = points[points.length - 1]?.v;
  const prev = points[points.length - 2]?.v ?? last;
  const change = last != null && prev != null ? last - prev : 0;
  const pct = last != null && prev ? (change / prev) * 100 : 0;
  const red = change < 0;

  return (
    <Link
      href={`/stocks/${entry.ticker}`}
      className="shrink-0 w-[220px] bg-panel2 border border-border rounded-xl p-4 hover:border-brand/40 transition-colors"
    >
      <div className="flex items-start justify-between mb-2">
        <div className="text-white text-sm font-medium leading-tight pr-2 truncate">{entry.name}</div>
        <div className="bg-bg border border-border rounded-md px-2 py-0.5 text-muted text-[10px] font-medium font-mono shrink-0">
          {entry.ticker}
        </div>
      </div>
      <div className="text-white text-xl font-semibold tabular-nums">
        {last != null ? usd.format(last) : "—"}
      </div>
      <div className={`text-[11px] tabular-nums mb-2 ${red ? "text-danger" : "text-brand"}`}>
        {last != null ? `${red ? "" : "+"}${change.toFixed(2)} (${red ? "" : "+"}${pct.toFixed(2)}%)` : ""}
      </div>
      <div className="h-10 w-full">
        {points.length > 1 && (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 4, right: 2, bottom: 0, left: 0 }}>
              <Line
                type="monotone"
                dataKey="v"
                stroke={red ? "#FF5A5F" : "#26E5A1"}
                strokeWidth={1.4}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </Link>
  );
}
