const express = require('express');
const pool = require('../db');
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
require('dotenv').config();

const router = express.Router()
const SECRET_KEY = process.env.JWT_SECRET

router.post('/login', async(req,res)=>{
    const {username, password} = req.body;
    try{
        const userResult = await pool.query('SELECT * FROM users WHERE username = $1',
        [username])
        if (userResult.rows.length === 0){
            return res.status(400).json({error:"User not found"})

        }
        const user = userResult.rows[0]
        const passwordMatch = await bcrypt.compare(password, user.password);

        if (!passwordMatch){
            return res.status(401).json({error:"Invalid Password"});

        }
        const token = jwt.sign(
            {id: user.id, username: user.username},
            SECRET_KEY,
            {expiresIn: "1h"}
        )
        res.status(200).json({token, username: user.username, balance: user.balance})
    }
    catch(err){
        console.error(err)
        res.status(500).send('Error logging in');
    }
})
module.exports = router;
