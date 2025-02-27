const express = require('express')
const pool = require('./db')
const app = express()
const PORT = 3000
const bcrypt = require('bcrypt');
const authenticateToken = require('./middleware/authMiddleware');

const routes = require('./routes/v1');

app.use(express.json());

// Use centralized routes
app.use('/api/v1', routes);
require('dotenv').config();


app.use(express.json())

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



