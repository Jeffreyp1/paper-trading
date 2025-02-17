const express = require('express');
const pool = require('../db')
const axios = require('axios');
const authenticateToken = require('../middleware/authMiddleware');
require('dotenv').config()

const router = express.Router();
const STOCK_API_KEY = process.env.STOCK_API_KEY;
router.get('/holdings', authenticateToken, async(req,res)=>{
    if (!req.user || !req.user.id){
        return res.status(401).json({error: "Unauthorized."})
    }
    const userId = req.user.id
    if (!userId){
        return res.status(400).json({error:"Unauthorized"})

    }
    try{
        const holdingsQuery = `
            SELECT 
                symbol,
                SUM(CASE WHEN trade_type = 'BUY' THEN quantity ELSE -quantity END) AS quantity_owned,
                SUM(CASE WHEN trade_type = 'BUY' THEN quantity * executed_price ELSE 0 END) /
                NULLIF(SUM(CASE WHEN trade_type = 'BUY' THEN quantity ELSE 0 END), 0) AS avg_buy_price
            FROM trades 
            WHERE user_id = $1
            GROUP BY symbol
            HAVING SUM(CASE WHEN trade_type = 'BUY' THEN quantity ELSE -quantity END) > 0;
        `;
        const holdingsResult = await pool.query(holdingsQuery,[userId]);
        console.log(holdingsResult)
        if(holdingsResult.rows.length === 0){
            return res.status(404).json({error:"No holdings found", holdings: []})
        }
        let totalPortfolio = 0;
        return res.status(200).json({message: "Query Successful", data: holdingsResult.rows})
        // console.log(holdingsResult)

    }catch(error){
        return res.status(400).json({error:"Error occurred"})
    }
})
module.exports = router;
