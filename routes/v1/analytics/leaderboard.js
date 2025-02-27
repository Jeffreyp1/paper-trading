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
router.get('/leaderboard', authenticateToken, async (req,res)=>{

    try{
        const users = await pool.query(`SELECT 
        users.id, 
        users.username, 
        users.balance, 
        trades.symbol,
        COALESCE(SUM(trades.quantity), 0) AS total_shares
        FROM users
        LEFT JOIN trades ON users.id = trades.user_id
        GROUP BY users.id, users.username, users.balance, trades.symbol
        ORDER BY (users.balance + COALESCE(SUM(trades.quantity) * 100, 0)) DESC;
        `)
        const uniqueSymbols = [...new Set(users.rows.map(row => row.symbol).filter(Boolean))];
        const priceCache = await fetchStockPrices(uniqueSymbols);
        let userMap = new Map()
        users.rows.forEach(user=>{
            if (!userMap.has(user.id)){
                userMap.set(user.id,{
                    username: user.username,
                    balance: parseFloat(user.balance),
                    total_shares: 0,
                    portfolio_value: 0,
                    net_worth: parseFloat(user.balance),
                    holdings: []
                })
            }
            if (user.symbol){
                const stockPrice = priceCache[user.symbol] || 0
                const totalValue = stockPrice * (user.total_shares || 0)
                let userEntry = userMap.get(user.id)

                userEntry.portfolio_value += totalValue
                userEntry.net_worth += totalValue
                userEntry.total_shares += user.total_shares || 0

                userEntry.holdings.push({
                    symbol: user.symbol,
                    quantity: user.total_shares || 0,
                    currentPrice: stockPrice,
                    totalValue: totalValue
                })

                userMap.set(user.id, userEntry)
            }

        })
        let leaderboard = Array.from(userMap.values()).sort((a,b) => b.net_worth - a.net_worth)
            return res.json({
                message: "Leaderboard successfully retrieved",
                leaderboard
            })

    }catch(error){
        return res.status(400).json({error:"Error retrieving leaderboard"})
    }
})

module.exports = router;