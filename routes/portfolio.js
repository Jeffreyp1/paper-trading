const express = require('express');
const pool = require('../db')
const axios = require('axios');
require('dotenv').config()

const router = express.Router();
const STOCK_API_KEY = process.env.STOCK_API_KEY;

router.post('/portfolio', async (req,res)=>{
    
    const {userId} = req.body
    if (!userId){
        return res.status(400).json({error:"Missing userId"})
    }
    try{
        const userResult = await pool.query("Select * FROM trades WHERE user_id = $1", [userId])
    if (userResult.rows.length === 0){
        res.status(400).json({error: "Erorr retrieving userResult"})
    }
    let total_investment = 0
    const stockPrices = await Promise.all(userResult.rows.map(async (trade)=>{
        try{
            const stockData = await axios.get(`https://www.alphavantage.co/query`, {
            params: {
                function: "GLOBAL_QUOTE",
                symbol: trade.stock_symbol,
                apikey: STOCK_API_KEY
            },
            timeout: 5000
            });
            const price = parseFloat(stockData.data["Global Quote"]["05. price"])
            if (!price || isNaN(price)){
                return res.status(500).json({error:"Failed to retrieve stock price"})
            }
            // buyPrice: parseFloat(trade.buy_price), // ✅ Ensure it's correctly retrieved
            //         currentPrice,
            total_investment += (price*trade.quantity)
            return {  buyPrice: parseFloat(trade.price), stockSymbol: trade.stock_symbol, quantity: trade.quantity, currentPrice: price, totalValue: price * trade.quantity };
        }
        catch (error) {
            return { stockSymbol: trade.stock_symbol, error: "Failed to fetch price" };
        }
    
    }))
    return res.status(200).json({
        message: "Portfolio retrieved Successfully", total_investment, holdings: stockPrices, trades: userResult.buy_price
    })
    }catch(error){
        res.status(500).json({error:"Error retrieving portfolio",details: error.message})
    }
})
module.exports = router;