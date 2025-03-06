import express from "express";
import redis from "./redis.js";
import authenticateToken from './middleware/authMiddleware.js'; 
import pool from "./db.js"
import fetchStockPrices  from "./services/stockService.js";
import getStockPrice from "./services/getStockPrice.js";
import {pushLeaderboard} from "./wsServer.js"
const app = express()
const PORT = 3000
import WebSocket from "ws";

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

  // for (const [symbol, price] of Object.entries(prices)) {
  //     multi.set(symbol, price, "EX", 3600);
  // }
  for (const [symbol, price] of Object.entries(prices)) {
    multi.hSet("stockPrices", symbol, price);
}

  try {
      await multi.exec();
      // console.log(` Updated ${Object.keys(prices).length} stocks at ${new Date().toLocaleTimeString()}`);
  } catch (error) {
      console.error("Redis Batch Update Error:", error);
  }
}
async function updateLeaderboard() {
  try {
      const users = await pool.query(`
      SELECT users.id, users.username, users.balance, 
      COALESCE(SUM(positions.quantity * 100), 0) AS portfolio_value
FROM users
LEFT JOIN positions ON users.id = positions.user_id
GROUP BY users.id, users.username, users.balance
ORDER BY (users.balance + COALESCE(SUM(positions.quantity * 100), 0)) DESC;
      `);

      let userMap = new Map();

      for (const user of users.rows) {
          userMap.set(user.id, {
              username: user.username,
              balance: parseFloat(user.balance),
              portfolio_value: parseFloat(user.portfolio_value),
              net_worth: parseFloat(user.balance) + parseFloat(user.portfolio_value),
              holdings: [] // Holdings will be fetched separately
          });
      }

      // Fetch stock prices and holdings
      for (const [userId, userEntry] of userMap.entries()) {
          const holdings = await pool.query(`
              SELECT symbol, quantity FROM positions WHERE user_id = $1
          `, [userId]);

          for (const stock of holdings.rows) {
              const stockPrice = await getStockPrice(stock.symbol) || 0;
              const totalValue = stockPrice * (stock.quantity || 0);
              userEntry.holdings.push({
                  symbol: stock.symbol,
                  quantity: stock.quantity || 0,
                  currentPrice: stockPrice,
                  totalValue: totalValue
              });
              userEntry.net_worth += totalValue;
          }

          // Update the map entry
          userMap.set(userId, userEntry);
      }

      // Sort users by net_worth
      let leaderboard = Array.from(userMap.values()).sort(
          (a, b) => b.net_worth - a.net_worth
      );


      return leaderboard;
  } catch (error) {
      console.error("Error updating leaderboard:", error);
      throw error;
  }
}
async function updateLead() {
  const start = Date.now();
  const latest = await updateLeaderboard();
  if (!latest || latest.length === 0) {
      console.error("🚨 No valid leaderboard data.");
      return;
  }

  const leaderboardKey = "leaderboard";
  const pipeline = redis.multi();
  pipeline.del(leaderboardKey);

  latest.forEach((user) => {
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
}

// async function updateLeaderboardd(){
//       try{
//         // const users = await pool.query(`SELECT
//         // users.id,
//         // users.username,
//         // users.balance,
//         // positions.symbol,
//         // positions.quantity 
//         // FROM users
//         // LEFT JOIN positions ON users.id = positions.user_id
//         // GROUP BY users.id, users.username, users.balance, positions.symbol, positions.quantity
//         // ORDER BY(users.balance + COALESCE(SUM(positions.quantity) * 100,0)) DESC
//         // ;
//         // `)
//         const users = await pool.query(`
//             SELECT users.id, users.username, users.balance, 
//                    COALESCE(SUM(positions.quantity * 100), 0) AS portfolio_value
//             FROM users
//             LEFT JOIN positions ON users.id = positions.user_id
//             GROUP BY users.id, users.username, users.balance
//             ORDER BY (users.balance + COALESCE(SUM(positions.quantity * 100), 0)) DESC;
//         `);
//         let userMap = new Map()
//         for (const user of users.rows) {
//             if (!userMap.has(user.id)){
//                 userMap.set(user.id,{
//                     username: user.username,
//                     balance: parseFloat(user.balance),
//                     total_shares: user.quantity,
//                     portfolio_value: 0,
//                     net_worth: parseFloat(user.balance),
//                     holdings: []
//                 })
//             }
//             if (user.symbol){
//                 const stockPrice = await getStockPrice(user.symbol)|| 0
//                 const totalValue = stockPrice * (user.quantity || 0)
//                 let userEntry = userMap.get(user.id)

//                 userEntry.portfolio_value += totalValue
//                 userEntry.net_worth += totalValue
//                 userEntry.total_shares += user.quantity || 0

//                 userEntry.holdings.push({
//                     symbol: user.symbol,
//                     quantity: user.quantity || 0,
//                     currentPrice: stockPrice,
//                     totalValue: totalValue
//                 })
//                 userMap.set(user.id, userEntry)
//             }
//         }
//         let leaderboard = Array.from(userMap.values()).sort(
//             (a, b) => b.net_worth - a.net_worth
//         );
//         return leaderboard

        
//     }catch(error){
//         throw error;
//     }
// }
// async function updateLeadd(){
//   const start = Date.now();
//   const latest = await updateLeaderboard()
//   if(!latest || latest.length === 0){
//     return [];
//   }
//   const pipeline = redis.multi();
//   const leaderboardKey = "leaderboard";
//   pipeline.del(leaderboardKey)
//   latest.forEach((user) => {
//     const netWorth = Number(user.net_worth);
//     if (isNaN(netWorth)) {
//       console.error(`Skipping ${user.username}: invalid net_worth`);
//       return;
//     }
//     pipeline.zAdd("leaderboard", {
//       score: netWorth,
//       value: JSON.stringify({ username: user.username, holdings: user.holdings || [] })
//     });
//   });
//   try{
//     await pipeline.exec();
//     pushLeaderboard();
//   }catch(error){
//     console.error("leaderboard error", error)
//   }
//   const end = Date.now();
//   console.log(`Update Lead API Response Time: ${end - start}ms`);
//   // return formattedLeaderboard
// }
await updateLead();
setInterval(async()=>{
  await updateLead();
}, 360000);
// await updateStockPrices();
// setInterval(updateStockPrices, 360000); 

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
})


