const API = "/api/v1";
const WS_URL = `ws://${location.hostname}:8080`;

const state = {
  token: localStorage.getItem("token"),
  email: localStorage.getItem("email"),
  userId: parseInt(localStorage.getItem("userId") || "0", 10),
  prices: {},
};

// ---------- helpers ----------

function decodeJwt(token) {
  try {
    const payload = token.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function fmtMoney(n) {
  const num = typeof n === "string" ? parseFloat(n) : n;
  if (num == null || isNaN(num)) return "—";
  return "$" + num.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

// ---------- auth ----------

async function login() {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const msg = document.getElementById("login-msg");
  msg.textContent = "";
  try {
    const data = await api("/auth/login", { method: "POST", body: { email, password }, auth: false });
    const decoded = decodeJwt(data.token);
    if (!decoded?.id) throw new Error("Token missing id");
    state.token = data.token;
    state.email = data.email;
    state.userId = decoded.id;
    localStorage.setItem("token", data.token);
    localStorage.setItem("email", data.email);
    localStorage.setItem("userId", String(decoded.id));
    showDashboard(parseFloat(data.balance));
  } catch (e) {
    msg.textContent = e.message;
  }
}

async function register() {
  const username = document.getElementById("reg-username").value.trim();
  const email = document.getElementById("reg-email").value.trim();
  const password = document.getElementById("reg-password").value;
  const msg = document.getElementById("register-msg");
  msg.textContent = "";
  msg.className = "success";
  try {
    await api("/auth/register", { method: "POST", body: { email, password, username }, auth: false });
    msg.textContent = "Account created. Now log in.";
  } catch (e) {
    msg.className = "error";
    msg.textContent = e.message;
  }
}

function logout() {
  localStorage.clear();
  state.token = null;
  state.email = null;
  state.userId = 0;
  document.getElementById("dash-view").classList.add("hidden");
  document.getElementById("auth-view").classList.remove("hidden");
  document.getElementById("logout-link").classList.add("hidden");
}

// ---------- dashboard ----------

function showDashboard(initialCash) {
  document.getElementById("auth-view").classList.add("hidden");
  document.getElementById("dash-view").classList.remove("hidden");
  document.getElementById("logout-link").classList.remove("hidden");
  document.getElementById("kpi-email").textContent = state.email || "—";
  if (initialCash != null) document.getElementById("kpi-cash").textContent = fmtMoney(initialCash);
  connectWs();
  refreshAll();
}

async function refreshAll() {
  await Promise.allSettled([
    refreshPortfolio(),
    refreshHoldings(),
    refreshHistory(),
    refreshLeaderboard(),
  ]);
}

async function refreshPortfolio() {
  try {
    const p = await api("/analytics/portfolio");
    document.getElementById("kpi-value").textContent = fmtMoney(p.current_value);
    const roi = p.ROI || "—";
    const el = document.getElementById("kpi-roi");
    el.textContent = roi;
    el.className = "value " + (roi.startsWith("-") ? "red" : "green");
  } catch (e) {
    document.getElementById("kpi-value").textContent = "—";
    document.getElementById("kpi-roi").textContent = "—";
  }
}

async function refreshHoldings() {
  const tbody = document.getElementById("holdings-tbody");
  tbody.innerHTML = "";
  try {
    const r = await api("/analytics/holdings");
    if (!r.data?.length) {
      tbody.innerHTML = `<tr><td colspan="3" class="muted">No holdings yet.</td></tr>`;
      return;
    }
    for (const h of r.data) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${h.symbol}</td><td>${h.quantity}</td><td>${fmtMoney(h.avgPrice)}</td>`;
      tbody.appendChild(tr);
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted">${e.message}</td></tr>`;
  }
}

async function refreshHistory() {
  const tbody = document.getElementById("history-tbody");
  tbody.innerHTML = "";
  try {
    const r = await api("/trading/trade_history");
    const trades = r.trades || [];
    if (!trades.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="muted">No trades yet.</td></tr>`;
      return;
    }
    for (const t of trades.slice(-50).reverse()) {
      const tr = document.createElement("tr");
      const cls = (t.trade_type || "").toLowerCase() === "sell" ? "sell" : "buy";
      tr.innerHTML = `<td>${t.symbol}</td><td><span class="badge ${cls}">${t.trade_type}</span></td><td>${t.quantity}</td><td>${fmtMoney(t.executed_price)}</td>`;
      tbody.appendChild(tr);
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">${e.message}</td></tr>`;
  }
}

async function refreshLeaderboard() {
  const tbody = document.getElementById("leaderboard-tbody");
  tbody.innerHTML = "";
  try {
    const r = await api("/analytics/leaderboard");
    const list = r.resLeaderboard || [];
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="3" class="muted">No data.</td></tr>`;
      return;
    }
    list.forEach((u, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${i + 1}</td><td>${u.username}</td><td style="text-align:right">${fmtMoney(u.net_worth)}</td>`;
      tbody.appendChild(tr);
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted">${e.message}</td></tr>`;
  }
}

// ---------- stocks + WS ----------

function renderStocks() {
  const tbody = document.getElementById("stocks-tbody");
  tbody.innerHTML = "";
  const symbols = Object.keys(state.prices).sort();
  for (const s of symbols) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${s}</td><td style="text-align:right">${fmtMoney(state.prices[s])}</td>`;
    tbody.appendChild(tr);
  }
  const sel = document.getElementById("trade-symbol");
  const prev = sel.value;
  sel.innerHTML = "";
  for (const s of symbols) {
    const o = document.createElement("option");
    o.value = s;
    o.textContent = s;
    sel.appendChild(o);
  }
  if (prev && symbols.includes(prev)) sel.value = prev;
}

function connectWs() {
  const status = document.getElementById("ws-status");
  let ws;
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    status.textContent = "ws unavailable";
    return;
  }
  ws.onopen = () => { status.textContent = "live"; status.className = "tag green"; };
  ws.onclose = () => { status.textContent = "disconnected"; status.className = "tag red"; setTimeout(connectWs, 3000); };
  ws.onerror = () => { status.textContent = "error"; status.className = "tag red"; };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "stocks" && msg.data) {
      state.prices = msg.data;
      renderStocks();
    } else if (msg.type === "leaderboard" || msg.type === "ledaerboard") {
      // server uses both spellings; refresh from REST for canonical formatting
      refreshLeaderboard();
    }
  };
}

// ---------- trade ----------

async function trade() {
  const msg = document.getElementById("trade-msg");
  msg.textContent = "";
  msg.className = "error";
  const symbol = document.getElementById("trade-symbol").value;
  const quantity = parseInt(document.getElementById("trade-quantity").value, 10);
  const action = document.getElementById("trade-action").value;
  if (!symbol || !quantity || quantity <= 0) {
    msg.textContent = "Pick a symbol and a positive quantity.";
    return;
  }
  try {
    await api("/trading/trade", {
      method: "POST",
      body: { userId: state.userId, action, stock: [{ symbol, quantity }] },
    });
    msg.className = "success";
    msg.textContent = `${action.toUpperCase()} ${quantity} ${symbol} submitted.`;
    setTimeout(refreshAll, 200);
  } catch (e) {
    msg.textContent = e.message;
  }
}

// ---------- wire up ----------

document.getElementById("login-btn").addEventListener("click", login);
document.getElementById("register-btn").addEventListener("click", register);
document.getElementById("trade-btn").addEventListener("click", trade);
document.getElementById("refresh-holdings").addEventListener("click", refreshHoldings);
document.getElementById("refresh-history").addEventListener("click", refreshHistory);
document.getElementById("logout-link").addEventListener("click", (e) => { e.preventDefault(); logout(); });

if (state.token && state.userId) showDashboard();
