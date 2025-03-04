import express from 'express';
import pool from '../../../db.js';
import redis from '../../../redis.js';

import axios from 'axios';
import authenticateToken from '../../../middleware/authMiddleware.js';
import getStockPrice from '../../../services/getStockPrice.js';
import 'dotenv/config';

const router = express.Router();
router.post('/trade', authenticateToken, async (req,res)=>{
    const start = Date.now();
    const {symbol, quantity, action} = req.body
    const userId = req.user.id
    if (!symbol || !quantity || !action){
        return res.status(400).json({error: "Missing required fields"})
    }
    if (!['buy','sell'].includes(action.toLowerCase())){
        return res.status(400).json({error: "Action must be to buy or sell"})
    }
    const client = await pool.connect()

    try{
        await client.query("BEGIN");

        const userResult = await client.query("SELECT balance from users WHERE id = $1", [userId])
        if (userResult.rows.length === 0){
            return res.status(404).json({error:"User not found"})
        }
        
        let balance = parseFloat(userResult.rows[0].balance)
        let stockPrice = await getStockPrice(symbol)
        if (!stockPrice){
            return res.status(400).json({Error:"Error getting stock price from cache"})
        }
        let totalCost = quantity * parseFloat(stockPrice)
        if (action.toLowerCase() === "buy"){
            if (balance < totalCost){
                await client.query("ROLLBACK")
                return res.status(400).json({error:"Insufficient funds"})
            }
            await client.query("Update USERS SET balance = balance - $1 WHERE id = $2",[totalCost, userId]);
            await client.query(
                "Insert INTO trades (user_id, symbol, quantity, executed_price, trade_type) VALUES ($1, $2,$3,$4, 'BUY')",[userId, symbol, quantity,stockPrice]
            )
        }else if (action.toLowerCase() === 'sell'){
            const holdings = await client.query(
                `SELECT 
                    COALESCE(SUM(CASE WHEN trade_type = 'BUY' THEN quantity ELSE 0 END), 0) -
                    COALESCE(SUM(CASE WHEN trade_type = 'SELL' THEN quantity ELSE 0 END), 0) 
                AS total_shares
                FROM trades WHERE user_id = $1 AND symbol = $2`,
                [userId, symbol]
            );
            let totalShares = parseInt(holdings.rows[0].total_shares) || 0;
            if (totalShares < quantity){
                return res.status(400).json({error:"Not enough shares"});
            }

            await client.query("UPDATE users SET balance = balance + $1 WHERE id = $2",[totalCost, userId])
            await client.query(
                "INSERT into trades (user_id, symbol, quantity, executed_price, trade_type) VALUES ($1,$2,$3,$4, 'SELL')",[userId, symbol, quantity, stockPrice]
            )

        }  
        await client.query("COMMIT")
        const end = Date.now();
        console.log(` Portfolio API Response Time: ${end - start}ms`);
        return res.status(200).json({message: "Trade Successful!"})


    }catch(error){
        await client.query("ROLLBACK")
        console.error("Trade Error: ", error.message)
        res.status(500).json({error: "Trade processing error", details: error.message})
    }
    finally{
        client.release()
    }
})

export default router;