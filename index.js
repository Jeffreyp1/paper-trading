import express from "express";
import redis from "./redis.js";
import authenticateToken from './middleware/authMiddleware.js'; 
import fetchStockPrices  from "./services/stockService.js";
const app = express()
const PORT = 3000
// const bcrypt = require('bcrypt');
// const authenticateToken = require('./middleware/authMiddleware');

import routes from "./routes/v1/index.js"

app.use(express.json());

// Use centralized routes
app.use('/api/v1', routes);


app.use(express.json())

// async function updateStockPrices(){
//   const prices = await fetchStockPrices()
//   if (!prices){
//     return;
//   }
//   const commands = [];
//   for (const [symbol, price] of Object.entries(prices)) {
//       commands.push(["SET", symbol, price, "EX", 3600]); // Format for Redis
//   }

//   try {
//     await redis.sendCommand(["MULTI"]); // ✅ Start transaction
//     for (const command of commands) {
//         await redis.sendCommand(command); // ✅ Batch insert stocks
//     }
//     await redis.sendCommand(["EXEC"]); // ✅ Execute transaction

//     console.log(`✅ Updated ${Object.keys(prices).length} stocks at ${new Date().toLocaleTimeString()}`);
//   } catch (error) {
//       console.error(" Redis Batch Update Error:", error);
//   }
// }
async function updateStockPrices() {
  console.log("🔄 Fetching stock prices...");

  const prices = await fetchStockPrices();
  if (!prices) {
      console.log("❌ No prices fetched.");
      return;
  }

  const multi = redis.multi(); // ✅ Start a Redis transaction

  for (const [symbol, price] of Object.entries(prices)) {
      multi.set(symbol, price, "EX", 3600); // ✅ Batch update with expiration
  }

  try {
      await multi.exec(); // ✅ Execute batch update
      console.log(`✅ Updated ${Object.keys(prices).length} stocks at ${new Date().toLocaleTimeString()}`);
  } catch (error) {
      console.error("❌ Redis Batch Update Error:", error);
  }
}

updateStockPrices();
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



