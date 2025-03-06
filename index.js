import express from "express";
import redis from "./redis.js";
import authenticateToken from './middleware/authMiddleware.js'; 
import pool from "./db.js"
import fetchStockPrices  from "./services/stockService.js";
import getStockPrice from "./services/getStockPrice.js";
const app = express()
const PORT = 3000
// const bcrypt = require('bcrypt');
// const authenticateToken = require('./middleware/authMiddleware');

import routes from "./routes/v1/index.js"

app.use(express.json());

// Use centralized routes
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
      multi.set(symbol, price, "EX", 3600);
  }

  try {
      await multi.exec(); // ✅ Execute batch update
      console.log(` Updated ${Object.keys(prices).length} stocks at ${new Date().toLocaleTimeString()}`);
  } catch (error) {
      console.error("Redis Batch Update Error:", error);
  }
}
async function updateLeaderboard(){
      try{
        const start = Date.now();
        const users = await pool.query(`SELECT
        users.id,
        users.username,
        users.balance,
        positions.symbol,
        positions.quantity 
        FROM users
        LEFT JOIN positions ON users.id = positions.user_id
        GROUP BY users.id, users.username, users.balance, positions.symbol, positions.quantity
        ORDER BY(users.balance + COALESCE(SUM(positions.quantity) * 100,0)) DESC
        ;
        `)
        let userMap = new Map()
        for (const user of users.rows) {
            if (!userMap.has(user.id)){
                userMap.set(user.id,{
                    username: user.username,
                    balance: parseFloat(user.balance),
                    total_shares: user.quantity,
                    portfolio_value: 0,
                    net_worth: parseFloat(user.balance),
                    holdings: []
                })
            }
            if (user.symbol){
                const stockPrice = await getStockPrice(user.symbol)|| 0
                const totalValue = stockPrice * (user.quantity || 0)
                let userEntry = userMap.get(user.id)

                userEntry.portfolio_value += totalValue
                userEntry.net_worth += totalValue
                userEntry.total_shares += user.quantity || 0

                userEntry.holdings.push({
                    symbol: user.symbol,
                    quantity: user.quantity || 0,
                    currentPrice: stockPrice,
                    totalValue: totalValue
                })
                userMap.set(user.id, userEntry)
            }
        }
        // 1) Sort and measure time
        let leaderboard = Array.from(userMap.values()).sort(
            (a, b) => b.net_worth - a.net_worth
        );
        
        const leaderboardKey = "leaderboard";
        await redis.del(leaderboardKey);
        
        await Promise.all(
        leaderboard.map(async (user) => {
            const netWorth = Number(user.net_worth);
            if (isNaN(netWorth)) {
            console.error(`Skipping ${user.username}: invalid net_worth`);
            return;
            }

            // ✅ Corrected `zAdd` call
            await redis.zAdd(leaderboardKey, { score: netWorth, value: JSON.stringify({username:user.username, holdings: user.holdings})});
        })
        );

        // 3️⃣ Retrieve top 10 from Redis
        const redisData = await redis.zRangeWithScores(leaderboardKey, 0, 9, { withScores: true, rev: true });


        if (redisData.length === 0) {
        console.error("🚨 No data found in Redis.");
        return res.json({ message: "success", leaderboard: [] });
        }

        // 4️⃣ Correctly parse username → score pairs
        const formattedLeaderboard = redisData.map(entry => {
            const userData = JSON.parse(entry.value); // Convert back to object
            return{
                username: userData.username,
                net_worth: entry.score,
                holdings: userData.holdings
            };
        });
        const end = Date.now();
        console.log(`leaderboard API Response Time: ${end - start}ms`);
        console.log("Formatted Leaderboard:", formattedLeaderboard);
        return formattedLeaderboard

        
    }catch(error){
        throw error;
    }
}

updateLeaderboard();
updateStockPrices();
setInterval(updateLeaderboard, 360000);
setInterval(updateStockPrices, 360000); 

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
})


// app.post('/register', async (req, res) => {
//     const { email, password, username} = req.body;
//     const initialBalance = 10000;

//     try {
//         const exisitingUser = await pool.query("Select * FROM users WHERE email = $1",[email])
//         if (exisitingUser.rowCount>0){
//           return res.status(400).json({error:"Email already in use"})
//         }
//         const hashedPassword = await bcrypt.hash(password, 10); // ✅ Hash the password

//         const result = await pool.query(
//             'INSERT INTO users (email, password_hash, balance, username) VALUES ($1, $2, $3,$4) RETURNING *',
//             [email, hashedPassword, initialBalance,username]
//         );

//         res.status(201).json({success: true, user: result.rows[0]});
//     } catch (err) {
//         console.error(err);
//         res.status(500).send('Error registering user');
//     }
// });

  // app.get('/get_user', async (req, res) => {
  //   try {
  //     // ✅ Fetch all users
  //     const result = await pool.query('SELECT * FROM users');
  
  //     if (result.rows.length === 0) {
  //       return res.status(404).json({ error: "No users found in the database" });
  //     }
  
  //     res.status(200).json(result.rows);
  //   } catch (err) {
  //     console.error("Database Error:", err);
  //     res.status(500).json({ error: "Error retrieving all users", details: err.message });
  //   }
  // });



