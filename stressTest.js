import axios from "axios";
import 'dotenv/config';

// API Config
const API_URL = "http://localhost:3000/api/v1/trading/trade";
const NUM_USERS = 100;  // Adjust if needed
const TRADES_PER_USER = 2;
const TOTAL_TRADES = NUM_USERS * TRADES_PER_USER;

// Stock Symbols for Randomized Trades
const STOCK_SYMBOLS = [
    "AAPL", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "BRK.B", "JNJ", "V", "PG"
];
// **📌 Function to Generate Trade Data**
const generateTradeData = () => {
    const stocks = [
        {
            symbol: STOCK_SYMBOLS[Math.floor(Math.random() * STOCK_SYMBOLS.length)],
            quantity: 1 // Fixed 1 quantity per trade for test consistency
        }
    ];
    return {
        action:"BUY" ,
        stock: stocks
    };
};

// **📌 Retry Function for Failed Trades**
const retryTrade = async (tradeData, userId, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        const start = Date.now();
        try {
            await axios.post(API_URL, tradeData);
            const end = Date.now();
            console.log(`Trade (User ${userId}) completed in ${end - start}ms`);
            return;
        } catch (error) {
            console.error(`Trade Failed (User ${userId}, Attempt ${i + 1}): ${error.response?.data?.error || error.message}`);
            await new Promise(resolve => setTimeout(resolve, 200)); // Wait before retry
        }
    }
    console.error(`🚨 Trade permanently failed for User ${userId}:`, tradeData);
};

// **📌 Execute Trades with Concurrency**
const executeTrades = async () => {
    console.log(`Starting stress test: ${NUM_USERS} users x ${TRADES_PER_USER} trades...`);
    const start = Date.now();
    const tradeRequests = [];

    for (let i = 5; i <= NUM_USERS; i++) {
        for (let j = 0; j < TRADES_PER_USER; j++) {
            const tradeData = generateTradeData();
            tradeRequests.push(retryTrade(tradeData, i));
        }
    }

    // ✅ Execute All Requests in Parallel
    await Promise.all(tradeRequests);

    const end = Date.now();
    console.log(`Successfully processed ${TOTAL_TRADES} trades in ${end - start}ms.`);
};

// **🔥 Run Stress Test**
executeTrades();
