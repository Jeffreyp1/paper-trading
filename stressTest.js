// Load test for POST /api/v1/trading/trade.
// Registers + logs in a bench user once, then drives N concurrent BUY requests
// for a fixed duration, records latency into an HDR histogram, prints
// sustained TPS + p50/p95/p99 + hardware info.
//
// Env vars:
//   TEST_DURATION_MS   default 30000
//   BATCH_SIZE         default 200 (concurrent in-flight requests)
//   API_BASE           default http://localhost:3000
//   BENCH_USER         default "bench" (will be registered if needed)
//   BENCH_PW           default "benchpw"

import axios from "axios";
import { performance } from "perf_hooks";
import os from "os";
import * as hdr from "hdr-histogram-js";

const API_BASE         = process.env.API_BASE || "http://localhost:3000";
const TEST_DURATION_MS = Number(process.env.TEST_DURATION_MS) || 30_000;
const BATCH_SIZE       = Number(process.env.BATCH_SIZE) || 200;
const USER             = process.env.BENCH_USER || "bench";
const PW               = process.env.BENCH_PW || "benchpw";
const STOCKS           = ["AAPL","MSFT","AMZN","GOOGL","META"];

const histogram = hdr.build({ lowestDiscernibleValue: 1, highestTrackableValue: 60_000_000, numberOfSignificantValueDigits: 3 });

let sent = 0, success = 0, fail = 0, sampleErr = null;
const rand = arr => arr[Math.floor(Math.random()*arr.length)];

const genTrade = () => ({
  action: "BUY",
  stock: [{ symbol: rand(STOCKS), quantity: Math.floor(Math.random()*5)+1, price: 0 }],
});

const ensureBearer = async () => {
  // try login first
  try {
    const r = await axios.post(`${API_BASE}/api/v1/auth/login`, { email: `${USER}@bench.io`, password: PW });
    return r.data.token;
  } catch {}
  // else register, then login
  await axios.post(`${API_BASE}/api/v1/auth/register`, { username: USER, email: `${USER}@bench.io`, password: PW }).catch(() => {});
  const r = await axios.post(`${API_BASE}/api/v1/auth/login`, { email: `${USER}@bench.io`, password: PW });
  return r.data.token;
};

const postTrade = async (axiosInstance) => {
  const t0 = performance.now();
  try {
    await axiosInstance.post(`/api/v1/trading/trade`, genTrade());
    histogram.recordValue(Math.max(1, Math.round((performance.now() - t0) * 1000))); // µs
    success++;
  } catch (e) {
    fail++;
    if (!sampleErr) sampleErr = `${e.response?.status || ""} ${JSON.stringify(e.response?.data || e.message).slice(0,200)}`;
  }
};

const runTest = async () => {
  console.log(`🚀 load test: ${TEST_DURATION_MS}ms, batch=${BATCH_SIZE}, base=${API_BASE}`);
  const token = await ensureBearer();
  console.log(`🔑 token acquired (${token.length} chars)`);
  const ax = axios.create({ baseURL: API_BASE, timeout: 10000, headers: { Authorization: `Bearer ${token}` } });

  const start  = Date.now();
  const stopAt = start + TEST_DURATION_MS;
  while (Date.now() < stopAt) {
    const batch = [];
    for (let i = 0; i < BATCH_SIZE; i++) { batch.push(postTrade(ax)); sent++; }
    await Promise.all(batch);
  }

  const durSec = (Date.now() - start)/1000;
  const tps    = (success / durSec).toFixed(1);
  const p = us => (us/1000).toFixed(2);

  console.log("================================================");
  console.log(`hardware           : ${os.platform()} ${os.arch()} / ${os.cpus()[0].model} x${os.cpus().length} / ${Math.round(os.totalmem()/1e9)}GB`);
  console.log(`node               : ${process.version}`);
  console.log(`duration (s)       : ${durSec.toFixed(2)}`);
  console.log(`sent               : ${sent}`);
  console.log(`ok                 : ${success}`);
  console.log(`err                : ${fail}`);
  if (sampleErr) console.log(`first err          : ${sampleErr}`);
  console.log(`TPS (ok/s)         : ${tps}`);
  console.log(`latency p50 (ms)   : ${p(histogram.getValueAtPercentile(50))}`);
  console.log(`latency p95 (ms)   : ${p(histogram.getValueAtPercentile(95))}`);
  console.log(`latency p99 (ms)   : ${p(histogram.getValueAtPercentile(99))}`);
  console.log(`latency p99.9 (ms) : ${p(histogram.getValueAtPercentile(99.9))}`);
  console.log(`latency max  (ms)  : ${p(histogram.maxValue)}`);
  console.log("================================================");
};

runTest().catch(err => { console.error("FATAL:", err.message); process.exit(1); });
