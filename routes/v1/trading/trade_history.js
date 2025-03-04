import express from 'express';
import pool from '../../../db.js';
import redis from '../../../redis.js';

import axios from 'axios';
import authenticateToken from '../../../middleware/authMiddleware.js';
import 'dotenv/config';

const router = express.Router();
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
    }catch(error){
        res.status(500).json({error:"Error retrieving portfolio",details: error.message})
    }
})
export default router;