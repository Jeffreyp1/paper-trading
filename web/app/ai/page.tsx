"use client";
import { useEffect, useState } from "react";
import { Power, RefreshCw, AlertCircle, ArrowUpRight, ArrowDownRight } from "lucide-react";

const AI_API = process.env.NEXT_PUBLIC_AI_API ?? "http://localhost:8090";

type Mode = "suggest" | "auto";

type Strategy = {
  id: string;
  name: string;
  description: string | null;
  mode: Mode;
  enabled: boolean;
  drawdown_tripped: boolean;
  max_position_qty: number;
  max_daily_notional: number;
  max_drawdown_pct: number;
  cooldown_seconds: number;
};

type Recommendation = {
  id: number;
  strategy_id: string;
  symbol: string;
  action: "BUY" | "SELL" | "HOLD";
  quantity: number;
  price_hint: number | null;
  status: string;
  rejection_reason: string | null;
  created_at: string;
};

type Health = { status: string; db: boolean; killswitch: boolean; strategies_loaded: number };

const numFmt = new Intl.NumberFormat("en-US");
const moneyFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const pctFmt = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 2 });

function timeFmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export default function AiPage() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [feed, setFeed] = useState<Recommendation[]>([]);
  const [recsByStrategy, setRecsByStrategy] = useState<Record<string, Recommendation[]>>({});
  const [limitDrafts, setLimitDrafts] = useState<Record<string, Partial<Strategy>>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [reachable, setReachable] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(true);

  async function refreshAll() {
    try {
      const [hRes, sRes, fRes] = await Promise.all([
        fetch(`${AI_API}/health`),
        fetch(`${AI_API}/strategies`),
        fetch(`${AI_API}/recommendations?limit=20`),
      ]);
      if (!hRes.ok || !sRes.ok || !fRes.ok) throw new Error("not_ok");
      setHealth(await hRes.json());
      const ss: Strategy[] = await sRes.json();
      setStrategies(ss);
      setFeed(await fRes.json());
      const perStrat = await Promise.all(
        ss.map((s) =>
          fetch(`${AI_API}/recommendations?strategy_id=${encodeURIComponent(s.id)}&limit=5`)
            .then((r) => (r.ok ? r.json() : []))
            .then((rows: Recommendation[]) => [s.id, rows] as const)
        )
      );
      setRecsByStrategy(Object.fromEntries(perStrat));
      setReachable(true);
    } catch {
      setReachable(false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshAll();
  }, []);

  useEffect(() => {
    if (!reachable) return;
    const t = setInterval(async () => {
      try {
        const [hRes, fRes] = await Promise.all([
          fetch(`${AI_API}/health`),
          fetch(`${AI_API}/recommendations?limit=20`),
        ]);
        if (hRes.ok) setHealth(await hRes.json());
        if (fRes.ok) setFeed(await fRes.json());
      } catch {
        setReachable(false);
      }
    }, 5000);
    return () => clearInterval(t);
  }, [reachable]);

  async function setMode(s: Strategy, mode: Mode) {
    if (health?.killswitch) return;
    try {
      const res = await fetch(`${AI_API}/strategies/${s.id}/mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (res.ok) {
        const updated: Strategy = await res.json();
        setStrategies((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      }
    } catch {
      setReachable(false);
    }
  }

  async function saveLimits(s: Strategy) {
    const draft = limitDrafts[s.id] ?? {};
    const body: Record<string, number> = {};
    (["max_position_qty", "max_daily_notional", "max_drawdown_pct", "cooldown_seconds"] as const).forEach((k) => {
      const v = draft[k];
      if (v !== undefined && v !== null && !Number.isNaN(Number(v))) body[k] = Number(v);
    });
    if (Object.keys(body).length === 0) return;
    try {
      const res = await fetch(`${AI_API}/strategies/${s.id}/limits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const updated: Strategy = await res.json();
        setStrategies((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
        setLimitDrafts((prev) => ({ ...prev, [s.id]: {} }));
      }
    } catch {
      setReachable(false);
    }
  }

  async function runNow(s: Strategy) {
    setRunning((prev) => ({ ...prev, [s.id]: true }));
    try {
      await fetch(`${AI_API}/strategies/${s.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const [rRes, fRes] = await Promise.all([
        fetch(`${AI_API}/recommendations?strategy_id=${encodeURIComponent(s.id)}&limit=5`),
        fetch(`${AI_API}/recommendations?limit=20`),
      ]);
      if (rRes.ok) {
        const rows: Recommendation[] = await rRes.json();
        setRecsByStrategy((prev) => ({ ...prev, [s.id]: rows }));
      }
      if (fRes.ok) setFeed(await fRes.json());
    } catch {
      setReachable(false);
    } finally {
      setRunning((prev) => ({ ...prev, [s.id]: false }));
    }
  }

  async function toggleKillswitch() {
    if (!health) return;
    try {
      const path = health.killswitch ? "/killswitch/clear" : "/killswitch";
      await fetch(`${AI_API}${path}`, { method: "POST" });
      const r = await fetch(`${AI_API}/health`);
      if (r.ok) setHealth(await r.json());
    } catch {
      setReachable(false);
    }
  }

  function draftOf(s: Strategy, key: keyof Strategy): number {
    const d = limitDrafts[s.id]?.[key];
    return d !== undefined ? (d as number) : (s[key] as number);
  }

  function setDraft(id: string, key: keyof Strategy, v: number) {
    setLimitDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), [key]: v } }));
  }

  const ks = !!health?.killswitch;
  const healthColor = !health ? "bg-muted" : health.status === "ok" ? "bg-brand" : "bg-warm";

  return (
    <div className="min-h-screen px-8 py-6 max-w-[1700px] mx-auto">
      {/* Top Bar */}
      <header className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-brand flex items-center justify-center">
            <div className="w-3 h-3 bg-bg rounded-sm" />
          </div>
          <span className="text-white font-semibold text-lg">Stocky</span>
          <span className="text-muted text-sm ml-3">/ AI Trading</span>
        </div>
        <nav className="flex items-center gap-8 text-sm font-medium">
          <a href="/" className="text-white hover:text-brand">Dashboard</a>
          <a href="/stocks" className="text-white hover:text-brand">Stocks</a>
          <a href="/manager" className="text-white hover:text-brand">Stress Test</a>
          <a href="/ai" className="text-brand">AI Trading</a>
        </nav>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-panel border border-border rounded-full px-3 py-1.5">
            <span className={`w-2 h-2 rounded-full ${healthColor}`} />
            <span className="text-muted text-xs">{health ? `${health.status} · ${health.strategies_loaded} loaded` : "unreachable"}</span>
          </div>
        </div>
      </header>

      {/* Header strip */}
      <div className="flex items-end justify-between mb-6">
        <div>
          <div className="text-white text-4xl font-semibold tracking-tight">AI Trading</div>
          <div className="text-muted text-sm mt-2">Suggest or auto-execute model-driven trades. Guardrails enforced server-side.</div>
        </div>
        <button
          onClick={toggleKillswitch}
          disabled={!reachable}
          className={`flex items-center gap-2 px-5 py-3 rounded-xl border font-semibold text-sm disabled:opacity-40 ${
            ks
              ? "bg-danger text-white border-danger"
              : "bg-panel text-white border-border hover:border-danger/60"
          }`}
        >
          <Power className="w-4 h-4" />
          {ks ? "Kill Switch Armed" : "Engage Kill Switch"}
        </button>
      </div>

      {!reachable && !loading && (
        <div className="mb-6 bg-panel border border-danger/40 rounded-xl p-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-danger" />
            <div>
              <div className="text-white font-medium">AI service unreachable</div>
              <div className="text-muted text-xs mt-0.5">Could not reach <span className="text-white">{AI_API}</span>. Start it with <span className="text-white">uvicorn app.main:app --port 8090</span>.</div>
            </div>
          </div>
          <button
            onClick={() => { setLoading(true); refreshAll(); }}
            className="flex items-center gap-2 bg-brand text-bg font-semibold px-4 py-2 rounded-lg text-sm"
          >
            <RefreshCw className="w-4 h-4" /> Retry
          </button>
        </div>
      )}

      <div className="grid grid-cols-[1fr_400px] gap-6">
        {/* Strategies grid */}
        <div className="space-y-4">
          {loading && reachable && (
            <div className="bg-panel border border-border rounded-xl p-12 text-center text-muted text-sm">Loading strategies…</div>
          )}
          {!loading && strategies.length === 0 && reachable && (
            <div className="bg-panel border border-border rounded-xl p-12 text-center text-muted text-sm">No strategies registered.</div>
          )}
          {strategies.map((s) => {
            const recs = recsByStrategy[s.id] ?? [];
            const isRunning = !!running[s.id];
            return (
              <div key={s.id} className="bg-panel border border-border rounded-xl p-6">
                <div className="flex items-start justify-between mb-5">
                  <div>
                    <div className="flex items-center gap-3 mb-1">
                      <span className="text-white text-lg font-semibold">{s.name}</span>
                      <span className="bg-bg border border-border rounded-md px-2 py-0.5 text-muted text-[10px] font-medium font-mono">{s.id}</span>
                      {s.drawdown_tripped && (
                        <span className="bg-danger/15 border border-danger/30 text-danger rounded-md px-2 py-0.5 text-[10px] font-medium">DRAWDOWN TRIPPED</span>
                      )}
                      {!s.enabled && (
                        <span className="bg-muted/20 border border-border text-muted rounded-md px-2 py-0.5 text-[10px] font-medium">DISABLED</span>
                      )}
                    </div>
                    {s.description && <div className="text-muted text-xs">{s.description}</div>}
                  </div>
                  <div className="flex items-center gap-3">
                    {/* Mode toggle */}
                    <div className="flex bg-panel2 border border-border rounded-full p-1">
                      {(["suggest", "auto"] as Mode[]).map((m) => (
                        <button
                          key={m}
                          onClick={() => setMode(s, m)}
                          disabled={ks}
                          className={`px-4 py-1.5 rounded-full text-xs font-medium capitalize disabled:opacity-40 disabled:cursor-not-allowed ${
                            s.mode === m ? (m === "auto" ? "bg-warm/20 text-warm" : "bg-brand/15 text-brand") : "text-muted hover:text-white"
                          }`}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={() => runNow(s)}
                      disabled={isRunning || ks}
                      className="flex items-center gap-2 bg-brand text-bg font-semibold px-4 py-2 rounded-lg text-xs disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isRunning ? "animate-spin" : ""}`} />
                      {isRunning ? "Running…" : "Run Now"}
                    </button>
                  </div>
                </div>

                {/* Limits panel */}
                <div className="grid grid-cols-4 gap-3 mb-4">
                  <LimitField label="Max Position Qty" value={draftOf(s, "max_position_qty")} onChange={(v) => setDraft(s.id, "max_position_qty", v)} />
                  <LimitField label="Max Daily Notional" value={draftOf(s, "max_daily_notional")} onChange={(v) => setDraft(s.id, "max_daily_notional", v)} />
                  <LimitField label="Max Drawdown %" value={draftOf(s, "max_drawdown_pct")} onChange={(v) => setDraft(s.id, "max_drawdown_pct", v)} step={0.01} />
                  <LimitField label="Cooldown (s)" value={draftOf(s, "cooldown_seconds")} onChange={(v) => setDraft(s.id, "cooldown_seconds", v)} />
                </div>
                <div className="flex items-center justify-between mb-5">
                  <div className="text-muted text-[11px]">
                    Active: qty {numFmt.format(s.max_position_qty)} · notional {moneyFmt.format(s.max_daily_notional)} · dd {pctFmt.format(s.max_drawdown_pct)} · cooldown {numFmt.format(s.cooldown_seconds)}s
                  </div>
                  <button
                    onClick={() => saveLimits(s)}
                    disabled={!limitDrafts[s.id] || Object.keys(limitDrafts[s.id] ?? {}).length === 0}
                    className="px-3 py-1.5 rounded-lg border border-brand/40 text-brand text-xs hover:bg-brand/10 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Save Limits
                  </button>
                </div>

                {/* Recent recommendations */}
                <div className="border-t border-border pt-4">
                  <div className="text-muted text-xs uppercase tracking-wider mb-3">Recent Recommendations</div>
                  {recs.length === 0 ? (
                    <div className="text-muted text-xs italic">No recommendations yet. Click Run Now.</div>
                  ) : (
                    <div className="space-y-1">
                      {recs.map((r) => <RecRow key={r.id} r={r} />)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Activity feed */}
        <div className="bg-panel border border-border rounded-xl p-6 sticky top-6 self-start max-h-[calc(100vh-3rem)] overflow-y-auto">
          <div className="flex items-center justify-between mb-1">
            <div className="text-white font-semibold text-lg">Activity</div>
            <span className="text-brand text-xs">● live</span>
          </div>
          <div className="text-muted text-xs mb-5">latest signals across strategies</div>
          {feed.length === 0 ? (
            <div className="text-muted text-xs italic">No recent activity.</div>
          ) : (
            <div className="space-y-1">
              {feed.map((r) => <RecRow key={r.id} r={r} showStrategy />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LimitField({ label, value, onChange, step }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <div>
      <label className="text-muted text-[10px] uppercase tracking-wider">{label}</label>
      <input
        type="number"
        step={step ?? 1}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full mt-1 bg-panel2 border border-border rounded-lg px-3 py-2 text-white text-sm tabular-nums focus:outline-none focus:border-brand"
      />
    </div>
  );
}

function RecRow({ r, showStrategy }: { r: Recommendation; showStrategy?: boolean }) {
  const isBuy = r.action === "BUY";
  const isSell = r.action === "SELL";
  const sideColor = isBuy ? "text-brand" : isSell ? "text-danger" : "text-muted";
  const Arrow = isBuy ? ArrowUpRight : isSell ? ArrowDownRight : null;

  const status = r.status.toLowerCase();
  let statusClass = "bg-muted/20 text-muted border-border";
  if (status === "executed") statusClass = "bg-brand/15 text-brand border-brand/30";
  else if (status === "suggested") statusClass = "bg-warm/15 text-warm border-warm/30";
  else if (status.startsWith("rejected") || status === "failed") statusClass = "bg-danger/15 text-danger border-danger/30";

  const statusLabel = r.rejection_reason ? `${status}:${r.rejection_reason}` : status;

  return (
    <div className="grid grid-cols-[64px_1fr_auto_auto_auto] items-center gap-3 py-2 border-b border-border last:border-b-0 text-xs">
      <span className="text-muted tabular-nums">{timeFmt(r.created_at)}</span>
      <div className="flex items-center gap-2 min-w-0">
        <span className={`flex items-center gap-1 ${sideColor} font-semibold`}>
          {Arrow && <Arrow className="w-3 h-3" />}
          {r.action}
        </span>
        <span className="text-white font-medium">{r.symbol}</span>
        {showStrategy && <span className="text-muted text-[10px] truncate font-mono">{r.strategy_id}</span>}
      </div>
      <span className="text-white tabular-nums">{numFmt.format(r.quantity)}</span>
      <span className="text-muted tabular-nums">{r.price_hint != null ? `$${r.price_hint.toFixed(2)}` : "—"}</span>
      <span className={`px-2 py-0.5 rounded-md border text-[10px] uppercase tracking-wider ${statusClass}`}>{statusLabel}</span>
    </div>
  );
}
