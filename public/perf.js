const API = "/api/v1";
const WS_URL = `ws://${location.hostname}:8080`;

const token = localStorage.getItem("token");
const userId = parseInt(localStorage.getItem("userId") || "0", 10);

let stopRequested = false;
let prices = {};

// Pull live symbols off the WebSocket so the trade form has a real list to pick from.
function loadSymbols() {
  try {
    const ws = new WebSocket(WS_URL);
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "stocks" && msg.data) {
        prices = msg.data;
        const sel = document.getElementById("cfg-symbol");
        const prev = sel.value;
        sel.innerHTML = "";
        Object.keys(msg.data).sort().forEach(s => {
          const o = document.createElement("option");
          o.value = s; o.textContent = s;
          sel.appendChild(o);
        });
        if (prev) sel.value = prev;
        ws.close();
      }
    };
    ws.onerror = () => {
      // Fallback: type a symbol manually
      const sel = document.getElementById("cfg-symbol");
      sel.outerHTML = `<input id="cfg-symbol" type="text" value="AAPL" />`;
    };
  } catch {}
}

// ---------- request builders ----------

function buildRequest(endpoint) {
  switch (endpoint) {
    case "trade": {
      const symbol = document.getElementById("cfg-symbol").value || "AAPL";
      const quantity = parseInt(document.getElementById("cfg-qty").value, 10) || 1;
      const action = document.getElementById("cfg-action").value;
      return {
        url: API + "/trading/trade",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, action, stock: [{ symbol, quantity }] }),
        },
      };
    }
    case "portfolio":
      return { url: API + "/analytics/portfolio", init: { method: "GET", headers: authHeaders() } };
    case "holdings":
      return { url: API + "/analytics/holdings", init: { method: "GET", headers: authHeaders() } };
    case "leaderboard":
      return { url: API + "/analytics/leaderboard", init: { method: "GET", headers: authHeaders() } };
    case "trade_history":
      return { url: API + "/trading/trade_history", init: { method: "GET", headers: authHeaders() } };
  }
}

function authHeaders() {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ---------- runner ----------

async function runTest() {
  stopRequested = false;
  const endpoint = document.getElementById("cfg-endpoint").value;
  const total = Math.max(1, parseInt(document.getElementById("cfg-total").value, 10) || 1);
  const concurrency = Math.max(1, parseInt(document.getElementById("cfg-concurrency").value, 10) || 1);
  const msg = document.getElementById("run-msg");
  msg.textContent = "";
  resetMetrics();

  if (endpoint === "trade" && !userId) {
    msg.textContent = "Trade endpoint needs a logged-in user. Log in on the Dashboard tab first.";
    return;
  }

  document.getElementById("run-btn").disabled = true;
  document.getElementById("stop-btn").disabled = false;

  const latencies = new Array(total);
  const errors = [];
  let sent = 0;
  let succ = 0;
  let fail = 0;

  const start = performance.now();
  const status = document.getElementById("run-status");
  const progress = document.getElementById("run-progress");

  const tick = setInterval(() => {
    const elapsed = (performance.now() - start) / 1000;
    const tps = sent > 0 ? sent / elapsed : 0;
    status.textContent = `Sent ${sent}/${total} · success ${succ} · fail ${fail} · ${tps.toFixed(1)} req/s`;
    progress.style.width = `${((sent / total) * 100).toFixed(1)}%`;
  }, 100);

  // Bounded concurrency: each worker pulls the next index until exhausted.
  let index = 0;
  async function worker() {
    while (!stopRequested) {
      const i = index++;
      if (i >= total) return;
      const { url, init } = buildRequest(endpoint);
      const t0 = performance.now();
      try {
        const res = await fetch(url, init);
        const lat = performance.now() - t0;
        latencies[i] = lat;
        if (res.ok) {
          succ++;
        } else {
          fail++;
          if (errors.length < 10) {
            let body = "";
            try { body = (await res.text()).slice(0, 200); } catch {}
            errors.push(`HTTP ${res.status}: ${body}`);
          }
        }
      } catch (e) {
        const lat = performance.now() - t0;
        latencies[i] = lat;
        fail++;
        if (errors.length < 10) errors.push(String(e));
      }
      sent++;
    }
  }

  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);

  const wallMs = performance.now() - start;
  clearInterval(tick);

  // Trim any holes (if stopped early)
  const completed = latencies.slice(0, sent).filter(x => typeof x === "number");
  renderMetrics({ wallMs, total: sent, succ, fail, latencies: completed, errors });

  document.getElementById("run-btn").disabled = false;
  document.getElementById("stop-btn").disabled = true;
  status.textContent = stopRequested ? "Stopped." : "Done.";
  progress.style.width = "100%";
}

function stopTest() {
  stopRequested = true;
}

// ---------- metrics ----------

function pct(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function resetMetrics() {
  for (const id of ["m-tps","m-avg","m-p95","m-err","m-total","m-success","m-fail","m-wall","m-min","m-p50","m-p99","m-max"]) {
    document.getElementById(id).textContent = "—";
  }
  document.getElementById("hist").innerHTML = "";
  document.getElementById("hist-label").textContent = "Running…";
  document.getElementById("err-sample").textContent = "—";
}

function renderMetrics({ wallMs, total, succ, fail, latencies, errors }) {
  const sec = wallMs / 1000;
  const tps = sec > 0 ? total / sec : 0;
  const avg = latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1);

  document.getElementById("m-tps").textContent = tps.toFixed(1);
  document.getElementById("m-avg").textContent = avg.toFixed(1);
  document.getElementById("m-p95").textContent = pct(latencies, 95).toFixed(1);
  document.getElementById("m-err").textContent = total ? ((fail / total) * 100).toFixed(1) : "0";
  document.getElementById("m-total").textContent = total;
  document.getElementById("m-success").textContent = succ;
  document.getElementById("m-fail").textContent = fail;
  document.getElementById("m-wall").textContent = `${wallMs.toFixed(0)} ms`;
  document.getElementById("m-min").textContent = `${pct(latencies, 0).toFixed(1)} ms`;
  document.getElementById("m-p50").textContent = `${pct(latencies, 50).toFixed(1)} ms`;
  document.getElementById("m-p99").textContent = `${pct(latencies, 99).toFixed(1)} ms`;
  document.getElementById("m-max").textContent = `${pct(latencies, 100).toFixed(1)} ms`;

  renderHistogram(latencies);

  document.getElementById("err-sample").textContent =
    errors.length ? errors.join("\n") : "(no errors)";
}

function renderHistogram(latencies) {
  const hist = document.getElementById("hist");
  const label = document.getElementById("hist-label");
  hist.innerHTML = "";
  if (!latencies.length) {
    label.textContent = "No samples.";
    return;
  }
  const min = Math.min(...latencies);
  const max = Math.max(...latencies);
  const buckets = 30;
  const span = Math.max(0.001, max - min);
  const counts = new Array(buckets).fill(0);
  for (const v of latencies) {
    const idx = Math.min(buckets - 1, Math.floor(((v - min) / span) * buckets));
    counts[idx]++;
  }
  const peak = Math.max(...counts);
  for (const c of counts) {
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = `${(c / peak) * 100}%`;
    bar.title = `${c} requests`;
    hist.appendChild(bar);
  }
  label.textContent = `${latencies.length} samples · range ${min.toFixed(1)}–${max.toFixed(1)} ms · peak bucket ${peak} requests`;
}

// ---------- wire up ----------

function showHideTradeCfg() {
  const ep = document.getElementById("cfg-endpoint").value;
  document.getElementById("trade-cfg").style.display = ep === "trade" ? "" : "none";
}

document.getElementById("run-btn").addEventListener("click", runTest);
document.getElementById("stop-btn").addEventListener("click", stopTest);
document.getElementById("cfg-endpoint").addEventListener("change", showHideTradeCfg);

showHideTradeCfg();
loadSymbols();
