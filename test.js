import { faker } from "@faker-js/faker";
import pg from "pg";
import bcrypt from "bcrypt";
import 'dotenv/config';
import redis from "./redis.js";
import { pushLeaderboard } from "./wsServer.js"; // Import leaderboard update function

const pool = new pg.Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// Stock Symbols for Randomized Trades
const STOCK_SYMBOLS = [
    "AAPL", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "BRK.B", "JNJ", "V", "PG"
];

// **Metrics**
let totalUsers = 0;
let totalTrades = 0;
let totalPositionsUpdated = 0;

// ==============================
// 1️⃣ Main Test Function
// ==============================
async function testDatabase(times = 9000) {
    const start = Date.now();

    for (let i = 0; i < times; i++) {
        const userId = await testUsers();
        if (userId) {
            await testTrades(userId);
            await updatePositions(userId);
        }
    }

    await testLeaderboard(); // Leaderboard updates after all trades
    const end = Date.now();

    console.log(`✅ Added ${totalUsers} users, ${totalTrades} trades, updated ${totalPositionsUpdated} positions.`);
    console.log(`🏁 Test completed in ${end - start}ms.`);
    process.exit();
}

// ==============================
// 2️⃣ Test User Insertion
// ==============================

async function testUsers() {
    const uniqueUsername = `testuser_${Date.now()}`;
    const uniqueEmail = `testemail_${Date.now()}@example.com`; // ✅ Ensure email uniqueness
    const passwordHash = await bcrypt.hash("testpassword", 10);

    const result = await pool.query(
        `INSERT INTO users (username, email, password_hash, balance)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [uniqueUsername, uniqueEmail, passwordHash, 10000.00]
    );

    totalUsers++;
    return result.rows[0].id;
}


// ==============================
// 3️⃣ Test Trade Insertion (5 per user)
// ==============================
async function testTrades(userId) {
    const trades = [];
    const selectedStocks = STOCK_SYMBOLS.sort(() => 0.5 - Math.random()).slice(0, 5); // Pick 5 random stocks

    selectedStocks.forEach(symbol => {
        trades.push([
            userId,
            symbol,
            "BUY",
            (Math.random() * 1000).toFixed(2), // Random price
            5 // Fixed quantity
        ]);
    });

    const query = `
        INSERT INTO trades (user_id, symbol, trade_type, executed_price, quantity) 
        VALUES ${trades.map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(", ")}
    `;

    await pool.query(query, trades.flat());
    totalTrades += trades.length;
}

// ==============================
// 4️⃣ Update Positions Based on Trades
// ==============================
async function updatePositions(userId) {
    const result = await pool.query(`
        INSERT INTO positions (user_id, symbol, quantity, average_price)
        SELECT user_id, symbol, SUM(quantity), AVG(executed_price)
        FROM trades 
        WHERE user_id = $1
        GROUP BY user_id, symbol
        ON CONFLICT (user_id, symbol) 
        DO UPDATE SET 
            quantity = EXCLUDED.quantity,
            average_price = EXCLUDED.average_price;
    `, [userId]);

    totalPositionsUpdated += result.rowCount;
}

// ==============================
// 5️⃣ Test Leaderboard Update
// ==============================
async function testLeaderboard() {
    console.log("Updating Leaderboard...");
    await pushLeaderboard(); // Calls the function from index.js
}

// ==============================
// 🔥 Run Tests
// ==============================
testDatabase();
