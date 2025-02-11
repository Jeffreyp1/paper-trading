const express = require('express')
const pool = require('./db')
const app = express()
const PORT = 3000
const loginRoute = require('./routes/login')
const tradeRoute = require('./routes/trade')
const portfolioRoute = require('./routes/portfolio')
require('dotenv').config();

const bcrypt = require('bcrypt');

app.use(express.json())
app.use('/routes', loginRoute)
app.use('/routes', tradeRoute)
app.use('/routes', portfolioRoute)
app.get('/', (req,res)=>{
    res.send("Home")
})
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
})


pool.query('SELECT NOW()', (err, res)=>{
    if (err) {
        console.error('Database connection error:', err);
      } else {
        console.log('Database connected:', res.rows);
      }
})

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    const initialBalance = 10000;

    try {
        const hashedPassword = await bcrypt.hash(password, 10); // ✅ Hash the password

        const result = await pool.query(
            'INSERT INTO users (username, password, balance) VALUES ($1, $2, $3) RETURNING *',
            [username, hashedPassword, initialBalance]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error registering user');
    }
});

  app.get('/get_user', async (req, res) => {
    try {
      // ✅ Fetch all users
      const result = await pool.query('SELECT * FROM users');
  
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "No users found in the database" });
      }
  
      res.status(200).json(result.rows);
    } catch (err) {
      console.error("Database Error:", err);
      res.status(500).json({ error: "Error retrieving all users", details: err.message });
    }
  });
  