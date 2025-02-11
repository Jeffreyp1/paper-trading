const express = require('express');
const pool = require('../db')
const axios = require('axios');
require('dotenv').config()

const router = express.Router();
const STOCK_API_KEY = process.env.STOCK_API_KEY;

router.post('/trade', async (req,res)=>{
    const {userId, stockSymbol, quantity, action} = req.body
    if (!userId || !stockSymbol || !quantity || !action){
        return res.status(400).json({error: "Missing required fields"})
    }
    if (!['buy','sell'].includes(action.toLowerCase())){
        return res.status(400).json({error: "Action must be to buy or sell"})
    }
    try{
        const stockData = await axios.get(`https://www.alphavantage.co/query`,{
            params:{
                function: "GLOBAL_QUOTE",
                symbol: stockSymbol,
                apikey: STOCK_API_KEY
            },
            timeout: 5000
        })
        const price = parseFloat(stockData.data["Global Quote"]["05. price"])
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
                "Insert INTO trades (user_id, stock_symbol, quantity, price, trade_type) VALUES ($1, $2,$3,$4, 'buy')",[userId, stockSymbol, quantity,price]
            )
        }else if (action.toLowerCase() === 'sell'){
            const holdings = await pool.query(
                "SELECT SUM(quantity) as total_shares FROM trades WHERE user_id = $1 AND stock_symbol = $2",[userId, stockSymbol]
            )
            let totalShares = parseInt(holdings.rows[0].total_shares) || 0;
            if (totalShares < quantity){
                return res.status(400).json({error:"Not enough shares"});
            }

            await pool.query("UPDATE users SET balance = balance + $1 WHERE id = $2",[totalCost, userId])
            await pool.query(
                "INSERT into trades (user_id, stock_symbol, quantity, price, trade_type) VALUES ($1,$2,$3,$4, 'sell')",[userId, stockSymbol, quantity, price]
            )

        }  
        return res.status(200).json({message: "Trade Successful!"})


    }catch(error){
        console.error("Trade Error: ", error.message)
        res.status(500).json({error: "Trade processing error", details: error.message})
    }
})

module.exports = router;