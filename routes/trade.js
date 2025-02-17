const express = require('express');
const pool = require('../db')
const axios = require('axios');
const authenticateToken = require('../middleware/authMiddleware');
require('dotenv').config()

const router = express.Router();
const STOCK_API_KEY = process.env.STOCK_API_KEY;

router.post('/trade', authenticateToken, async (req,res)=>{
    const {symbol, quantity, action} = req.body
    const userId = req.user.id
    if (!symbol || !quantity || !action){
        return res.status(400).json({error: "Missing required fields"})
    }
    if (!['buy','sell'].includes(action.toLowerCase())){
        return res.status(400).json({error: "Action must be to buy or sell"})
    }
    try{
        const stockData = await axios.get(`https://www.alphavantage.co/query`,{
            params:{
                function: "GLOBAL_QUOTE",
                symbol: symbol,
                apikey: STOCK_API_KEY
            },
            timeout: 5000
        })
        const stockQuote = stockData.data["Global Quote"];
        if (!stockQuote || !stockQuote["05. price"] || isNaN(parseFloat(stockQuote["05. price"]))){
            return res.status(500).json({error: "Failed to retrieve stock price"})
        }
        const price = parseFloat(stockQuote["05. price"])
        if (!price || isNaN(price)){
            return res.status(500).json({error:"Failed to retrieve stock price"})
        }

        const userResult = await pool.query("SELECT balance from users WHERE id = $1", [userId])
        if (userResult.rows.length === 0){
            return res.status(404).json({error:"User not found"})
        }
        
        let balance = parseFloat(userResult.rows[0].balance)
        let totalCost = quantity * price
        if (action.toLowerCase() === "buy"){
            if (balance < totalCost){
                return res.status(400).json({error:"Insufficient funds"})
            }
            await pool.query("Update USERS SET balance = balance - $1 WHERE id = $2",[totalCost, userId]);
            await pool.query(
                "Insert INTO trades (user_id, symbol, quantity, executed_price, trade_type) VALUES ($1, $2,$3,$4, 'BUY')",[userId, symbol, quantity,price]
            )
        }else if (action.toLowerCase() === 'sell'){
            const holdings = await pool.query(
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

            await pool.query("UPDATE users SET balance = balance + $1 WHERE id = $2",[totalCost, userId])
            await pool.query(
                "INSERT into trades (user_id, symbol, quantity, executed_price, trade_type) VALUES ($1,$2,$3,$4, 'SELL')",[userId, symbol, quantity, price]
            )

        }  
        return res.status(200).json({message: "Trade Successful!"})


    }catch(error){
        console.error("Trade Error: ", error.message)
        res.status(500).json({error: "Trade processing error", details: error.message})
    }
})

module.exports = router;