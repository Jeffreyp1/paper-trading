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
        const balance = await redis.hGet("user_balance", userId.toString())
        const user_balance = balance ? parseFloat(balance) : 0
        let total_investment = user_balance
        let current_value = user_balance
        const positions = await redis.hGetAll(`positions:${userId}`)
        const stock_symbols = Object.keys(positions)
        const prices = await redis.sendCommand(["HMGET", "stockPrices", ...stock_symbols]);
        var index = 0;
        Object.entries(positions).forEach(([symbol, value])=>{
            const [quantity, avgPrice] = value.split(",").map(Number);
            total_investment += quantity * avgPrice
            current_value += quantity * prices[index]
            index += 1
        })
        let return_on_investment = (current_value - total_investment) / total_investment * 100
        const end = Date.now();
        console.log(` Portfolio API Response Time: ${end - start}ms`);


        return res.status(200).json({current_value: current_value.toFixed(2), total_investment: total_investment.toFixed(2), ROI: return_on_investment.toFixed(2)+"%"})
    }catch(error){
        return res.status(400).json({error:"Error retrieving Portfolio", error})
    }
    finally{
        client.release()
    }
})

export default router;