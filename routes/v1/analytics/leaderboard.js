import express from 'express';
import pool from '../../../db.js';
import redis from '../../../redis.js';
import axios from 'axios';
import authenticateToken from '../../../middleware/authMiddleware.js';
import 'dotenv/config';
import getStockPrice from '../../../services/getStockPrice.js';

const router = express.Router();
router.get('/leaderboard', authenticateToken, async (req,res)=>{
    const topUsers = await redis.zRange("leaderboard", 0, 9, { withScores: true, rev: true });
    if (!topUsers){
        return res.status(200).json({message:"success", topUsers})
    }
    try{
        const start = Date.now();
        const users = await pool.query(`SELECT
        users.id,
        users.username,
        users.balance,
        positions.symbol,
        positions.quantity 
        FROM users
        LEFT JOIN positions ON users.id = positions.user_id
        GROUP BY users.id, users.username, users.balance, positions.symbol, positions.quantity
        ORDER BY(users.balance + COALESCE(SUM(positions.quantity) * 100,0)) DESC
        ;
        `)
        let userMap = new Map()
        for (const user of users.rows) {
            if (!userMap.has(user.id)){
                userMap.set(user.id,{
                    username: user.username,
                    balance: parseFloat(user.balance),
                    total_shares: user.quantity,
                    portfolio_value: 0,
                    net_worth: parseFloat(user.balance),
                    holdings: []
                })
            }
            if (user.symbol){
                const stockPrice = await getStockPrice(user.symbol)|| 0
                const totalValue = stockPrice * (user.quantity || 0)
                let userEntry = userMap.get(user.id)

                userEntry.portfolio_value += totalValue
                userEntry.net_worth += totalValue
                userEntry.total_shares += user.quantity || 0

                userEntry.holdings.push({
                    symbol: user.symbol,
                    quantity: user.quantity || 0,
                    currentPrice: stockPrice,
                    totalValue: totalValue
                })
                userMap.set(user.id, userEntry)
            }
        }
        let leaderboard = Array.from(userMap.values()).sort((a,b) => b.net_worth - a.net_worth)
        const end = Date.now();
        console.log(`leaderboard API Response Time: ${end - start}ms`);
        const leaderboardKey = "leaderboard"
        leaderboard.forEach(async (user)=>{
            await redis.zAdd(leaderboardKey, {
                net_worth: user.net_worth, username: user.username, portfolio_value: user.portfolio_value, holdings: user.holdings});
        })
        return res.json({
            message: "Leaderboard successfully retrieved",
            leaderboard
        })
        
    }catch(error){
        return res.status(400).json({error:"Error retrieving leaderboard"})
    }
})

export default router;