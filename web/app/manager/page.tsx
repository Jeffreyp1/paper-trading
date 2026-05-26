"use client";
import { useEffect, useRef, useState } from "react";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { Play, Square } from "lucide-react";

type Sample = {
  t: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  sent: number;
  ok: number;
  err: number;
};

export default function ManagerPage() {
  const [vu, setVu] = useState(50);
  const [rps, setRps] = useState(100);
  const [duration, setDuration] = useState(30);
  const [endpoint, setEndpoint] = useState("/api/health");
  const [running, setRunning] = useState(false);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [totals, setTotals] = useState({ sent: 0, ok: 0, err: 0, p50: 0, p95: 0, p99: 0 });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function start() {
    setRunning(true);
    setSamples([]);
    setTotals({ sent: 0, ok: 0, err: 0, p50: 0, p95: 0, p99: 0 });
    const startedAt = Date.now();

    timerRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/stress", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vu, rps, endpoint }),
        });
        const s: Sample = await res.json();
        setSamples((prev) => [...prev.slice(-59), { ...s, t: Date.now() - startedAt }]);
        setTotals((prev) => ({
          sent: prev.sent + s.sent,
          ok: prev.ok + s.ok,
          err: prev.err + s.err,
          p50: s.p50,
          p95: s.p95,
          p99: s.p99,
        }));
      } catch {
        // ignore
      }

      if (Date.now() - startedAt >= duration * 1000) {
        stop();
      }
    }, 1000);
  }

  function stop() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setRunning(false);
  }

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  return (
    <div className="min-h-screen px-8 py-6 max-w-[1400px] mx-auto">
      <header className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-brand flex items-center justify-center">
            <div className="w-3 h-3 bg-bg rounded-sm" />
          </div>
          <span className="text-white font-semibold text-lg">Stocky</span>
          <span className="text-muted text-sm ml-3">/ Stress Test Manager</span>
        </div>
        <nav className="flex items-center gap-8 text-sm font-medium">
          <a href="/" className="text-white hover:text-brand">Dashboard</a>
          <a href="/stocks" className="text-white hover:text-brand">Stocks</a>
          <a href="/manager" className="text-brand">Stress Test</a>
          <a href="/ai" className="text-white hover:text-brand">AI Trading</a>
        </nav>
      </header>

      <div className="grid grid-cols-[380px_1fr] gap-6">
        {/* Form */}
        <div className="bg-panel border border-border rounded-xl p-6">
          <h2 className="text-white font-semibold text-lg mb-1">Configuration</h2>
          <p className="text-muted text-xs mb-5">configure the load test</p>

          <div className="space-y-4">
            <Field label="Virtual Users" value={vu} onChange={setVu} type="number" disabled={running} />
            <Field label="RPS Target" value={rps} onChange={setRps} type="number" disabled={running} />
            <Field label="Duration (seconds)" value={duration} onChange={setDuration} type="number" disabled={running} />
            <div>
              <label className="text-muted text-xs uppercase tracking-wider">Target Endpoint</label>
              <input
                type="text"
                className="w-full mt-1 bg-panel2 border border-border rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-brand"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                disabled={running}
              />
            </div>
          </div>

          <div className="flex gap-3 mt-6">
            <button
              onClick={start}
              disabled={running}
              className="flex-1 flex items-center justify-center gap-2 bg-brand text-bg font-semibold py-2.5 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Play className="w-4 h-4" /> Start
            </button>
            <button
              onClick={stop}
              disabled={!running}
              className="flex-1 flex items-center justify-center gap-2 bg-danger/20 text-danger border border-danger/40 font-semibold py-2.5 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Square className="w-4 h-4" /> Stop
            </button>
          </div>
        </div>

        {/* Results */}
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-4">
            <Stat label="Requests Sent" value={totals.sent.toLocaleString()} />
            <Stat label="Success" value={totals.ok.toLocaleString()} color="text-brand" />
            <Stat label="Errors" value={totals.err.toLocaleString()} color="text-danger" />
            <Stat label="p50 latency" value={`${totals.p50} ms`} />
            <Stat label="p95 latency" value={`${totals.p95} ms`} />
            <Stat label="p99 latency" value={`${totals.p99} ms`} />
          </div>

          <div className="bg-panel border border-border rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-semibold">Live latency</h3>
              <span className={`text-xs ${running ? "text-brand" : "text-muted"}`}>
                {running ? "● running" : "○ idle"}
              </span>
            </div>
            <div className="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={samples}>
                  <CartesianGrid strokeDasharray="3 6" stroke="#1E2530" vertical={false} />
                  <XAxis
                    dataKey="t"
                    tickFormatter={(v) => `${Math.floor(v / 1000)}s`}
                    tick={{ fill: "#6B7383", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis tick={{ fill: "#6B7383", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{
                      background: "#1E2530",
                      border: "1px solid #2A3340",
                      borderRadius: 8,
                      color: "#fff",
                    }}
                  />
                  <Line type="monotone" dataKey="p50" stroke="#26E5A1" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="p95" stroke="#F4B740" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="p99" stroke="#FF5A5F" strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="flex gap-5 mt-3 text-xs">
              <span className="text-brand">● p50</span>
              <span className="text-warm">● p95</span>
              <span className="text-danger">● p99</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="text-muted text-xs uppercase tracking-wider">{label}</label>
      <input
        type={type}
        className="w-full mt-1 bg-panel2 border border-border rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-brand"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
      />
    </div>
  );
}

function Stat({ label, value, color = "text-white" }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-panel border border-border rounded-xl p-4">
      <div className="text-muted text-xs uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
