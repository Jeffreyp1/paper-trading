// tradeLoadTest.js
import axios from "axios";
import { performance } from "perf_hooks";

// ─── Config ─────────────────────────────────────────────────────────
const API_URL          = "http://localhost:3000/api/v1/trading/trade";
const TEST_DURATION_MS = 1000;            // run for 5 s
const MAX_USERS        = 10_000;          // user ids 1-10 000
const BATCH_SIZE       = 200;             // concurrent requests per tick
const STOCKS           = ["AAPL","MSFT","AMZN","GOOGL","META"];

// ─── Metrics ────────────────────────────────────────────────────────
let sent = 0;
let success = 0;
let fail = 0;
let totalLatency = 0;

// ─── Helpers ────────────────────────────────────────────────────────
const rand  = arr => arr[Math.floor(Math.random()*arr.length)];
const delay = ms  => new Promise(r => setTimeout(r, ms));

const genTrade = (uid) => ({
  userId : uid,
  action : "BUY",
  stock  : [{
    symbol   : rand(STOCKS),
    quantity : Math.floor(Math.random()*5)+1,
    price    : 0,
  }],
});

const postTrade = async (data) => {
  const t0 = performance.now();
  try {
    await axios.post(API_URL, data);
    const t1 = performance.now();
    success++;
    totalLatency += (t1 - t0);
  } catch (err) {
    fail++;
  }
};

// ─── Main load test loop ────────────────────────────────────────────
const runTest = async () => {
  console.log("🚀 5-second load test started…");
  const start  = Date.now();
  const stopAt = start + TEST_DURATION_MS;
  const users  = Array.from({length: MAX_USERS}, (_,i)=> i+1);

  while (Date.now() < stopAt) {
    const batch = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      const uid = rand(users);
      batch.push(postTrade(genTrade(uid)));
      sent++;
    }
    await Promise.all(batch);            // wait for batch to finish
  }

  // ─── Report ──────────────────────────────────────────────────────
  const durSec     = (Date.now() - start)/1000;
  const tps        = (success / durSec).toFixed(1);
  const avgLatency = success ? (totalLatency / success).toFixed(2) : "n/a";

  console.log("================================================");
  console.log(`🟢 Sent requests      : ${sent}`);
  console.log(`✅ Successful trades  : ${success}`);
  console.log(`❌ Failed trades      : ${fail}`);
  console.log(`📊 TPS (success only) : ${tps}`);
  console.log(`⏱️ Avg latency (ms)   : ${avgLatency}`);
  console.log("================================================");
};

runTest();



// import axios from "axios";
// import 'dotenv/config';

// // API Config
// const API_URL = "http://localhost:3000/api/v1/trading/trade";
// const NUM_USERS = 10000;  // Users 5 - 10000
// const TRADES_PER_USER = 1;
// const TOTAL_TRADES = NUM_USERS * TRADES_PER_USER;
// const BATCH_SIZE = 100;  // Process 100 trades at a time
// const MAX_RETRIES = 3;  // Retry failed trades up to 3 times

// // Stock Symbols (Keep it the same)
// const STOCK_SYMBOLS = [
//     "AAPL", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "JNJ", "V", "PG"
// ];

// // ✅ Generate Trade Data
// const generateTradeData = (userId) => ({
//     action: "BUY",
//     stock: [
//         {
//             symbol: STOCK_SYMBOLS[Math.floor(Math.random() * STOCK_SYMBOLS.length)],
//             quantity: Math.floor(Math.random() * 5) + 1, // 🔁 Random quantity between 1–5
//             price: 0, // 🧮 Fixed price like Go
//         }
//     ],
//     userId: userId
// });

// // ✅ Execute a Single Trade
// const executeTrade = async (userId, attempt = 1) => {
//     const tradeData = generateTradeData(userId);
    
//     try {
//         const response = await axios.post(API_URL, tradeData);
//         console.log(`✅ Trade (User ${userId}) completed in ${response?.data?.time}ms`);
//     } catch (error) {
//         // Capture Detailed Error Logs
//         const errorMessage = error.response?.data?.error || error.message;
//         const statusCode = error.response?.status || "No Status";
//         const responseData = error.response?.data || "No Response Data";
        
//         console.error(`❌ Trade Failed (User ${userId}, Attempt ${attempt})`);
//         console.error(`   → Status Code: ${statusCode}`);
//         console.error(`   → Error Message: ${errorMessage}`);
//         console.error(`   → Response Data:`, responseData);
        
//         // Retry failed trades up to MAX_RETRIES
//         if (attempt < MAX_RETRIES) {
//             await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms before retrying
//             return executeTrade(userId, attempt + 1);
//         }
//     }
// };


// // ✅ Execute Trades with Controlled Speed
// const executeTrades = async () => {
//     console.log(`📡 Starting stress test: ${NUM_USERS} users x ${TRADES_PER_USER} trades...`);
//     const start = Date.now();
    
//     let tradeQueue = [];

//     for (let i = 5; i <= NUM_USERS; i++) {
//         for (let j = 0; j < TRADES_PER_USER; j++) {
//             tradeQueue.push(() => executeTrade(i));
//         }
//     }

//     // ✅ Process trades in batches with a delay
//     for (let i = 0; i < tradeQueue.length; i += BATCH_SIZE) {
//         const batch = tradeQueue.slice(i, i + BATCH_SIZE);
//         await Promise.all(batch.map(trade => trade()));

//         console.log(`🚀 Processed batch ${i / BATCH_SIZE + 1}/${Math.ceil(tradeQueue.length / BATCH_SIZE)}`);
//         // await new Promise(resolve => setTimeout(resolve, Math.random() * 20 + 5)); // Random delay (5-20ms) 
//     }

//     const end = Date.now();
//     console.log(`✅ Successfully processed ${TOTAL_TRADES} trades in ${end - start}ms.`);
// };

// // Run Stress Test
// executeTrades();
