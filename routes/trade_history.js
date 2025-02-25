const express = require('express');
const pool = require('../db')
const axios = require('axios');
const authenticateToken = require('../middleware/authMiddleware');

require('dotenv').config()

const router = express.Router();
const STOCK_API_KEY = process.env.STOCK_API_KEY;
router.get('/trade_history', authenticateToken, async (req,res)=>{
    if (!req.user || !req.user.id){
        return res.status(401).json({error: "Unauthorized."})
    }
    const userId = req.user.id
    if (!userId){
        return res.status(400).json({error:"Missing userId"})
    }
    try{
        const userResult = await pool.query("Select * FROM trades WHERE user_id = $1", [userId])
    if (userResult.rows.length === 0){
        return res.status(400).json({error: "Erorr retrieving userResult"})
    }
    // const trade_price = await pool.query("Select price FROM orders where id = $1", [userId])
    const trade_data = await pool.query("Select symbol, trade_type, quantity, created_at, executed_price FROM trades WHERE user_id = $1",[userId])
    if (trade_data.rows.length === 0){
        return res.status(400).json({error:"No Trade Data Found"})

    }
    return res.json({
        message: "Trade history retrieved successfully",
        trades: trade_data.rows
    });

    // return {symbol: trade_data.symbol, trade_type: trade_data.trade_type, price: trade_data.executed_price, created_at: trade_data.created_at}
    // let total_investment = 0
    // const priceCache = new Map(); // Stores stock prices temporarily
    // const stockPrices = await Promise.all(userResult.rows.map(async (trade)=>{
    //     // console.log(trade)
    //     try{
    //         // console.log(trade.symbol)
    //         if (!trade.symbol) {
    //             return { error: "Missing stock symbol in trade data." };
    //         }
    //         console.log(trade.symbol)
    //         const stockData = await axios.get(`https://www.alphavantage.co/query`, {
    //         params: {
    //             function: "GLOBAL_QUOTE",
    //             symbol: trade.symbol,
    //             apikey: STOCK_API_KEY
    //         },
    //         timeout: 5000
    //         });

            
    //         if (!stockData.data || !stockData.data["Global Quote"] || !stockData.data["Global Quote"]["05. price"]) {
    //             console.error(`No valid price data for ${trade.symbol}`);
    //             return { symbol: trade.symbol, error: "API did not return a valid stock quote." };
    //         }

    //         const price = parseFloat(stockData.data["Global Quote"]["05. price"]);
    //         if (isNaN(price) || price <= 0) {
    //             console.error(`Invalid stock price for ${trade.symbol}`);
    //             return { symbol: trade.symbol, error: "Invalid stock price retrieved." };
    //         }
    //         total_investment += (price*trade.quantity)
    //         return {  buyPrice: trade.executed_price, symbol: trade.symbol, quantity: trade.quantity, currentPrice: price, totalValue: price * trade.quantity };
    //     }
    //     catch (error) {
    //         return { symbol: trade.symbol, error: `Failed to fetch price for ${userId}` };
    //     }
    
    // }))
    // return res.status(200).json({
    //     message: "Portfolio retrieved Successfully", total_investment, holdings: stockPrices, trades: userResult.executed_price
    // })
    }catch(error){
        res.status(500).json({error:"Error retrieving portfolio",details: error.message})
    }
})
module.exports = router;