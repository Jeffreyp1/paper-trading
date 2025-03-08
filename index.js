import express from "express";
import redis from "./redis.js";
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
      const client = await pool.connect()
      const users = await client.query(`
      SELECT DISTINCT ON(u.id) u.id, u.username, u.balance, p.symbol, p.quantity
      FROM users u
      INNER JOIN positions p 
      ON u.id = p.user_id
      `);
      let userMap = new Map();
      for (const user of users.rows) {
          userMap.set(user.id, {
              username: user.username,
              balance: parseFloat(user.balance),
              // portfolio_value: 0,
              net_worth: parseFloat(user.balance),
              holdings: [] 
          });
      }
      const stockData = await redis.hGetAll("stockPrices")
      for (const stock of users.rows) {
        const stockPrice = parseFloat(stockData[stock.symbol]) || 0;
        const totalValue = stockPrice * (stock.quantity || 0);
        let userEntry = userMap.get(stock.id);
        userEntry.holdings.push({
            symbol: stock.symbol,
            quantity: stock.quantity || 0,
            currentPrice: stockPrice,
            totalValue: totalValue
        });
          userEntry.net_worth += totalValue;
      }
      const pipeline = redis.multi();
      pipeline.del("leaderboard");
      userMap.forEach((user) => {
          const netWorth = Number(user.net_worth);
          if (isNaN(netWorth)) {
              return;
          }
          pipeline.zAdd("leaderboard", 
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
await updateStockPrices();
setInterval(updateStockPrices, 360000); 
await updateLeaderboard();
setInterval(async()=>{
  await updateLeaderboard();
}, 370000);

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
})


