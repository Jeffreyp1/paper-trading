import express from "express";
import redis from "./redis.js";
import authenticateToken from './middleware/authMiddleware.js'; 
import pool from "./db.js"
import fetchStockPrices  from "./services/stockService.js";
import {pushLeaderboard} from "./wsServer.js"
import {pushStockPrices} from "./wsServer.js";
const app = express()
const PORT = 3000
import routes from "./routes/v1/index.js"

app.use(express.json());
app.use('/api/v1', routes);
app.use(express.json())
async function updateStockPrices() {
  console.log(" Fetching stock prices...");

  const prices = await fetchStockPrices();
  if (!prices) {
      console.log("No prices fetched.");
      return;
  }

  const multi = redis.multi(); 
  for (const [symbol, price] of Object.entries(prices)) {
    multi.hSet("stockPrices", symbol, price);
}

  try {
      await multi.exec();
      pushStockPrices();
      console.log(` Updated ${Object.keys(prices).length} stocks at ${new Date().toLocaleTimeString()}`);
  } catch (error) {
      console.error("Redis Batch Update Error:", error);
  }
}
async function updateLeaderboard() {
  try {
    const start = Date.now()
      const users = await pool.query(`
      SELECT users.id, users.username, users.balance
      FROM users
      `);
      let userMap = new Map();
      for (const user of users.rows) {
          userMap.set(user.id, {
              username: user.username,
              balance: parseFloat(user.balance),
              portfolio_value: 0,
              net_worth: parseFloat(user.balance),
              holdings: [] 
          });
      }
      const stockData = redis.hGetAll("stockPrices")
      const holdings = await pool.query(`SELECT user_id, symbol, quantity FROM positions`);
      for (const stock of holdings.rows) {
        const stockPrice = stockData[stock.symbol] || 0;
        const totalValue = stockPrice * (stock.quantity || 0);
        let userEntry = userMap.get(stock.user_id);
        userEntry.holdings.push({
            symbol: stock.symbol,
            quantity: stock.quantity || 0,
            currentPrice: stockPrice,
            totalValue: totalValue
        });
          userEntry.net_worth += totalValue;
      }
      let leaderboard = Array.from(userMap.values()).sort(
          (a, b) => b.net_worth - a.net_worth
      );
      const leaderboardKey = "leaderboard";
      const pipeline = redis.multi();
      pipeline.del("leaderboard");
    
      leaderboard.forEach((user) => {
          const netWorth = Number(user.net_worth);
          if (isNaN(netWorth)) {
              console.error(`Skipping ${user.username}: invalid net_worth`);
              return;
          }
    
          pipeline.zAdd(leaderboardKey, 
            { score: netWorth, value: JSON.stringify({ username: user.username, holdings: user.holdings || [] }) }
        );
        
      });
    
      try {
          await pipeline.exec();
          pushLeaderboard(); // ✅ Broadcast updates via WebSocket
      } catch (error) {
          console.error("🚨 Leaderboard update error:", error);
      }
    
      const end = Date.now();
      console.log(`✅ Leaderboard Updated! Response Time: ${end - start}ms`);
      
  } catch (error) {
      console.error("Error updating leaderboard:", error);
      throw error;
  }
}
await updateLeaderboard();
setInterval(async()=>{
  await updateLeaderboard();
}, 360000);
// await updateStockPrices();
// setInterval(updateStockPrices, 360000); 

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
})


