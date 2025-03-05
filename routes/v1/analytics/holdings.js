import express from 'express';
import pool from '../../../db.js';
import redis from '../../../redis.js';

import axios from 'axios';
import authenticateToken from '../../../middleware/authMiddleware.js';
import 'dotenv/config';

const router = express.Router();
router.get('/holdings', authenticateToken, async(req,res)=>{
    const start = Date.now();
    if (!req.user || !req.user.id){
        return res.status(401).json({error: "Unauthorized."})
    }
    const userId = req.user.id
    if (!userId){
        return res.status(400).json({error:"Unauthorized"})

    }
    try{
        // const holdingsQuery = `
        //     SELECT 
        //         symbol,
        //         SUM(CASE WHEN trade_type = 'BUY' THEN quantity ELSE -quantity END) AS quantity_owned,
        //         SUM(CASE WHEN trade_type = 'BUY' THEN quantity * executed_price ELSE 0 END) /
        //         NULLIF(SUM(CASE WHEN trade_type = 'BUY' THEN quantity ELSE 0 END), 0) AS avg_buy_price
        //     FROM trades 
        //     WHERE user_id = $1
        //     GROUP BY symbol
        //     HAVING SUM(CASE WHEN trade_type = 'BUY' THEN quantity ELSE -quantity END) > 0;
        // `;
        
        const holdingsQuery = `
            SELECT
                symbol,
                quantity,
                average_price
            FROM positions
            WHERE user_id = $1
        `;
        const holdingsResult = await pool.query(holdingsQuery,[userId]);
        console.log(holdingsResult)
        if(holdingsResult.rows.length === 0){
            return res.status(404).json({error:"No holdings found", holdings: []})
        }
        let totalPortfolio = 0;
        const end = Date.now();
        console.log(` Portfolio API Response Time: ${end - start}ms`);
        return res.status(200).json({message: "Query Successful", data: holdingsResult.rows})

    }catch(error){
        return res.status(400).json({error:"Error occurred"})
    }
})
export default router;
