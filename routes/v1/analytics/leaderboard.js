import express from 'express';
import pool from '../../../db.js';
import redis from '../../../redis.js';
import axios from 'axios';
import authenticateToken from '../../../middleware/authMiddleware.js';
import 'dotenv/config';
import getStockPrice from '../../../services/getStockPrice.js';
import { stringify } from 'postcss';

const router = express.Router();
router.get('/leaderboard', authenticateToken, async (req,res)=>{
    try{
        const start = Date.now();
        const data = await redis.zRangeWithScores("leaderboard", 0, 9, { withScores: true, rev: true });

        if (data.length >= 0) {
            const resLeaderboard = data.map(entry => {
                const userData = JSON.parse(entry.value);
                return{
                    username: userData.username,
                    net_worth: entry.score,
                    holdings: userData.holdings
                };
            });
            const end = Date.now();
            console.log(`leaderboard API Response Time: ${end - start}ms`);
            return res.json({message:"Success", resLeaderboard})
        }
    }catch(error){
        return res.status(400).json({error:"Error retrieving leaderboard"})
    }
})

export default router;