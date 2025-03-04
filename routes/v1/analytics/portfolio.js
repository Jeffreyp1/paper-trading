import express from 'express';
import pool from '../../../db.js';
import redis from '../../../redis.js';

import axios from 'axios';
import authenticateToken from '../../../middleware/authMiddleware.js';
import getStockPrice from '../../../services/getStockPrice.js';

import 'dotenv/config';

const router = express.Router();
const STOCK_API_KEY = process.env.STOCK_API_KEY;
router.get('/portfolio', authenticateToken, async (req,res)=>{
    const start = Date.now();
    if (!req.user || !req.user.id){
        return res.status(401).json({error: "Unauthorized."})
    }
    const userId = req.user.id
    if (!userId){
        return res.status(400).json({error:"Missing userId"})
    }
    try{
        const balance = await pool.query(`SELECT  
        balance
        FROM users
        WHERE id = $1
        `,[userId])
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
        let total_investment = parseFloat(balance.rows[0].balance)
        let current_value = parseFloat(balance.rows[0].balance)
        holdingsResult.rows.forEach(async val => {
            let stock_price = await getStockPrice(val.symbol)
            console.log(stock_price, val.symbol)
            if (stock_price !== null ){
                current_value += (val.quantity_owned) * stock_price
            }
            total_investment += (val.quantity_owned) * val.avg_buy_price
        })
        let return_on_investment = (current_value - total_investment) / total_investment * 100
        const end = Date.now();
        console.log(` Portfolio API Response Time: ${end - start}ms`);

        res.status(200).json({current_value: current_value.toFixed(2), total_investment: total_investment.toFixed(2), ROI: return_on_investment.toFixed(2)+"%"})
    }catch(error){
        return res.status(400).json({error:"Error retrieving Portfolio"})
    }
})

export default router;