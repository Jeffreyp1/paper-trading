const express = require('express');
const pool = require('../db')
const axios = require('axios');
require('dotenv').config()

const router = express.Router();

router.post('/portfolio', async (req,res)=>{
    const {userId} = req.body
    if (!userId){
        return res.status(400).json({error:"Missing userId"})
    }
    const userResult = await pool.query("Select * FROM trades WHERE user_id = $1", [userId])
    if (userResult.rows.length === 0){
        res.status(400).json({error: "Erorr retrieving userResult"})
    }
    else{
        res.status(200).json({message: "Retrieving trade information successful!", trades: userResult.rows[0]})
    }
})
module.exports = router;