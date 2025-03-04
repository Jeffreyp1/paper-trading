import express from 'express';
import pool from '../../../db.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

import 'dotenv/config';

const router = express.Router()
const SECRET_KEY = process.env.JWT_SECRET

router.post('/login', async(req,res)=>{
    const {email, password} = req.body;
    try{
        const userResult = await pool.query('SELECT * FROM users WHERE email = $1',
        [email])
        if (userResult.rows.length === 0){
            return res.status(400).json({error:"User not found"})

        }
        const user = userResult.rows[0]
        const passwordMatch = await bcrypt.compare(password, user.password_hash);

        if (!passwordMatch){
            return res.status(401).json({error:"Invalid Password"});

        }
        const token = jwt.sign(
            {id: user.id, email: user.email},
            SECRET_KEY,
            {expiresIn: "24h"}
        )
        res.status(200).json({token, email: user.email, balance: user.balance})
    }
    catch(err){
        console.error(err)
        res.status(500).send('Error logging in');
    }
})
export default router;
