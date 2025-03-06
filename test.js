import { faker } from "@faker-js/faker";
import pg from "pg";
import bcrypt from "bcrypt";
import 'dotenv/config';
import redis from "./redis.js"; // Ensure your Redis connection is correct

const pool = new pg.Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// List of stock symbols
const STOCK_SYMBOLS = ["AAPL", "GOOGL", "MSFT", "TSLA", "AMZN", "META", "NFLX", "NVDA", "IBM", "AMD"];

// Metrics Tracking
let totalUsers = 0;
let totalTrades = 0;
let totalPositionsChecked = 0;

// ==============================
// 1️⃣ Main Test Function
// ==============================
async function testDatabase(times = 500) {
    const start = Date.now();

    for (let i = 0; i < times; i++) {
        const userId = await testUsers();
        if (userId) {
            await testTrades(userId);
            await testPositions(userId);
        }
    }

    await testLeaderboard();
    const end = Date.now();

    console.log(`✅ Added ${totalUsers} users, ${totalTrades} trades, and checked ${totalPositionsChecked} positions.`);
    console.log(`🏁 Test completed in ${end - start}ms.`);
    process.exit();
}

// ==============================
// 2️⃣ Test User Insertion
// ==============================
async function testUsers() {
    const uniqueUsername = `testuser_${Date.now()}`;
    const passwordHash = await bcrypt.hash("testpassword", 10);

    const result = await pool.query(
        `INSERT INTO users (username, email, password_hash, balance)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [uniqueUsername, faker.internet.email(), passwordHash, 10000.00]
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
// 4️⃣ Test Positions Update
// ==============================
async function testPositions(userId) {
    await pool.query(`SELECT * FROM positions WHERE user_id = $1`, [userId]);
    totalPositionsChecked++;
}

// ==============================
// 5️⃣ Test Leaderboard Update
// ==============================
async function testLeaderboard() {
    await redis.del("leaderboard");
    await redis.zAdd("leaderboard", { score: 50000, value: JSON.stringify({ username: "testuser" }) });
}

// ==============================
// 🔥 Run Tests
// ==============================
testDatabase();
