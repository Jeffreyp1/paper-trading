import express from 'express';
import pool from '../../../db.js';
import redis from '../../../redis.js';

import axios from 'axios';
import authenticateToken from '../../../middleware/authMiddleware.js';
import getStockPrice from '../../../services/getStockPrice.js';

import 'dotenv/config';

const router = express.Router();
router.get('/portfolio', authenticateToken, async (req,res)=>{
    const start = Date.now();
    const client = await pool.connect()
    if (!req.user || !req.user.id){
        return res.status(401).json({error: "Unauthorized."})
    }
    const userId = req.user.id
    if (!userId){
        return res.status(400).json({error:"Missing userId"})
    }
    try{
        const holdingsQuery = `
            SELECT
                users.id,
                symbol, 
                quantity,
                average_price,
                users.balance
            FROM positions
            JOIN users ON positions.user_id = users.id
            WHERE user_id = $1
        `
        const holdingsResult = await client.query(holdingsQuery,[userId]);
        let total_investment = parseFloat(holdingsResult.rows[0].balance)
        let current_value = parseFloat(holdingsResult.rows[0].balance)
        const stock_symbols = holdingsResult.rows.map(data=>data.symbol)
        const prices = await redis.sendCommand(["HMGET", "stockPrices", ...stock_symbols]);
        if (!prices){
            console.error("Failed to retrieve stock prices from Redis")
        }
        holdingsResult.rows.forEach((val,index) => {
            current_value += (val.quantity) * parseFloat(prices[index])
            total_investment += (val.quantity) * val.average_price
        })
        let return_on_investment = (current_value - total_investment) / total_investment * 100
        const end = Date.now();
        console.log(` Portfolio API Response Time: ${end - start}ms`);

        res.status(200).json({current_value: current_value.toFixed(2), total_investment: total_investment.toFixed(2), ROI: return_on_investment.toFixed(2)+"%"})
    }catch(error){
        return res.status(400).json({error:"Error retrieving Portfolio"})
    }
    finally{
        client.release()
    }
})

export default router;