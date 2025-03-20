import express from 'express';
import pool from '../../../db.js';
import redis from '../../../redis.js';

import axios from 'axios';
import authenticateToken from '../../../middleware/authMiddleware.js';
import 'dotenv/config';

const router = express.Router();
router.get('/holdings', authenticateToken, async(req,res)=>{
    const start = Date.now();
    const client = await pool.connect()
    if (!req.user || !req.user.id){
        return res.status(401).json({error: "Unauthorized."})
    }
    const userId = req.user.id
    if (!userId){
        return res.status(400).json({error:"Unauthorized"})

    }
    try{
        const positions = await redis.hGetAll(`positions:${userId}`)
        const val = Object.entries(positions).map(([symbol, value])=>{
            const [quantity, avgPrice] = value.split(",").map(Number);
            return {symbol, quantity, avgPrice};
        })
        const end = Date.now();
        console.log(` Portfolio API Response Time: ${end - start}ms`);
        return res.status(200).json({message: "Query Successful", data: val})
    }catch(error){
        return res.status(400).json({error:"Error occurred", error})
    }
    finally{
        client.release()
    }
})
export default router;
