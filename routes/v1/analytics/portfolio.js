const express = require('express');
const pool = require('../../../db')
const axios = require('axios');
const authenticateToken = require('../../../middleware/authMiddleware');
require('dotenv').config()

const router = express.Router();
const STOCK_API_KEY = process.env.STOCK_API_KEY;
const fetchStockPrices = async (symbols) =>{
    const priceCache= {}
    for (const symbol of symbols){
        try{
            const stockData = await axios.get(`https://www.alphavantage.co/query`,{
                params:{
                    function: "GLOBAL_QUOTE",
                    symbol: symbol,
                    apikey: STOCK_API_KEY
                },
                timeout: 5000
            })
            // const stockPrice = stockData.data["Global Quote"]["05. Price"];
            const stockPrice = parseFloat(stockData.data["Global Quote"]["05. price"])
            if (!isNaN(stockPrice)){
                priceCache[symbol] = stockPrice
            }else{
                priceCache[symbol] = 0
            }
        }
        catch(error){
            console.log(`Error fetching stock price for ${symbol}`)
            return null
        }
    }
    return priceCache
}
router.get('/portfolio', authenticateToken, async (req,res)=>{
    if (!req.user || !req.user.id){
        return res.status(401).json({error: "Unauthorized."})
    }
    const userId = req.user.id
    if (!userId){
        return res.status(400).json({error:"Missing userId"})
    }
    try{
        const symbols = await pool.query(`SELECT  
        DISTINCT ON (symbol) symbol, balance
        FROM trades
        JOIN users ON  users.id = trades.user_id
        WHERE trades.user_id = $1
        `,[userId])
        console.log(symbols)
        // console.log("Balance", balance)
        const symbolRes = symbols.rows.map(row=> row.symbol)
        const priceCache = await fetchStockPrices(symbolRes)
        if (!priceCache){
            res.json(500).json({error:"Error fetching stock prices"})
        }
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
        let total_investment = parseFloat(symbols.rows[0].balance)
        let current_value = parseFloat(symbols.rows[0].balance)
        holdingsResult.rows.forEach(val => {
            current_value += (val.quantity_owned) * priceCache[val.symbol]
            total_investment += (val.quantity_owned) * val.avg_buy_price
        })
        let return_on_investment = (current_value - total_investment) / total_investment * 100
        res.status(200).json({current_value: current_value.toFixed(2), total_investment: total_investment.toFixed(2), ROI: return_on_investment.toFixed(2)+"%"})
    }catch(error){
        return res.status(400).json({error:"Error retrieving Portfolio"})
    }
})

module.exports = router;