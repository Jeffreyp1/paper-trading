const express = require('express')
const pool = require('../../../db')
const bcrypt = require('bcrypt')
const router = express.Router()
const app = express()
app.post('/register', async (req, res) => {
    const { email, password, username} = req.body;
    const initialBalance = 10000;

    try {
        const exisitingUser = await pool.query("Select * FROM users WHERE email = $1",[email])
        if (exisitingUser.rowCount>0){
          return res.status(400).json({error:"Email already in use"})
        }
        const hashedPassword = await bcrypt.hash(password, 10); 

        const result = await pool.query(
            'INSERT INTO users (email, password_hash, balance, username) VALUES ($1, $2, $3,$4) RETURNING *',
            [email, hashedPassword, initialBalance,username]
        );

        res.status(201).json({success: true, user: result.rows[0]});
    } catch (err) {
        console.error(err);
        res.status(500).send('Error registering user');
    }
});

module.exports = router;