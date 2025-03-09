import axios from "axios";
import 'dotenv/config';

// API Config
const API_URL = "http://localhost:3000/api/v1/trading/trade";
const NUM_USERS = 10000;  // Users 5 - 10000
const TRADES_PER_USER = 50;
const TOTAL_TRADES = NUM_USERS * TRADES_PER_USER;
const BATCH_SIZE = 100;  // Process 100 trades at a time
const MAX_RETRIES = 3;  // Retry failed trades up to 3 times

// Stock Symbols (Keep it the same)
const STOCK_SYMBOLS = [
    "AAPL", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "JNJ", "V", "PG"
];

// ✅ Generate Trade Data
const generateTradeData = (userId) => ({
    action: "BUY",
    stock: [
        {
            symbol: STOCK_SYMBOLS[Math.floor(Math.random() * STOCK_SYMBOLS.length)],
            quantity: 1 // 1 stock per trade
        }
    ],
    userId: userId // Include userId in request
});

// ✅ Execute a Single Trade
const executeTrade = async (userId, attempt = 1) => {
    const tradeData = generateTradeData(userId);
    
    try {
        const response = await axios.post(API_URL, tradeData);
        console.log(`✅ Trade (User ${userId}) completed in ${response?.data?.time}ms`);
    } catch (error) {
        // Capture Detailed Error Logs
        const errorMessage = error.response?.data?.error || error.message;
        const statusCode = error.response?.status || "No Status";
        const responseData = error.response?.data || "No Response Data";
        
        console.error(`❌ Trade Failed (User ${userId}, Attempt ${attempt})`);
        console.error(`   → Status Code: ${statusCode}`);
        console.error(`   → Error Message: ${errorMessage}`);
        console.error(`   → Response Data:`, responseData);
        
        // Retry failed trades up to MAX_RETRIES
        if (attempt < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms before retrying
            return executeTrade(userId, attempt + 1);
        }
    }
};


// ✅ Execute Trades with Controlled Speed
const executeTrades = async () => {
    console.log(`📡 Starting stress test: ${NUM_USERS} users x ${TRADES_PER_USER} trades...`);
    const start = Date.now();
    
    let tradeQueue = [];

    for (let i = 5; i <= NUM_USERS; i++) {
        for (let j = 0; j < TRADES_PER_USER; j++) {
            tradeQueue.push(() => executeTrade(i));
        }
    }

    // ✅ Process trades in batches with a delay
    for (let i = 0; i < tradeQueue.length; i += BATCH_SIZE) {
        const batch = tradeQueue.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(trade => trade()));

        console.log(`🚀 Processed batch ${i / BATCH_SIZE + 1}/${Math.ceil(tradeQueue.length / BATCH_SIZE)}`);
        await new Promise(resolve => setTimeout(resolve, Math.random() * 20 + 5)); // Random delay (5-20ms)
    }

    const end = Date.now();
    console.log(`✅ Successfully processed ${TOTAL_TRADES} trades in ${end - start}ms.`);
};

// Run Stress Test
executeTrades();
