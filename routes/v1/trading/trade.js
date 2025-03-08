import express from 'express';
import pool from '../../../db.js';
import redis from '../../../redis.js';

import axios from 'axios';
import authenticateToken from '../../../middleware/authMiddleware.js';
import getStockPrice from '../../../services/getStockPrice.js';
import 'dotenv/config';

const router = express.Router();
async function executeBuy(client, userId, stockData, balance, totalCost){
    if (balance < totalCost){
        await client.query("ROLLBACK")
        return res.status(400).json({error:"Insufficient funds"})
    }
    console.log("WE HAVE MULA!", balance, totalCost)
    return;
    // await client.query("Update USERS SET balance = balance - $1 WHERE id = $2",[totalCost, userId]);
    // await client.query(
    //     `Insert INTO trades (user_id, symbol, quantity, executed_price, trade_type) VALUES ($1, $2,$3,$4, 'BUY')
    //     `,[userId, symbol, quantity,stockPrice]
    // )
    // await client.query(
    //     `Insert INTO positions (user_id, symbol, quantity, average_price) VALUES ($1, $2,$3,$4) 
    //     ON CONFLICT(user_id, symbol) 
    //     DO UPDATE SET
    //         quantity = positions.quantity + EXCLUDED.quantity,
    //         average_price = ((positions.quantity * positions.average_price) + (EXCLUDED.quantity * EXCLUDED.average_price))/ (positions.quantity + EXCLUDED.quantity),
    //         updated_at = CURRENT_TIMESTAMP;
    //     `,[userId, symbol, quantity, stockPrice]
    // )
}
router.post('/trade', authenticateToken, async (req,res)=>{
    const start = Date.now();
    const {action, stock} = req.body
    const userId = req.user.id
    if (!stock || !action){
        return res.status(400).json({error: "Missing required fields"})
    }
    if (!['buy','sell'].includes(action.toLowerCase())){
        return res.status(400).json({error: "Action must be to buy or sell"})
    }
    const client = await pool.connect()

    try{
        await client.query("BEGIN");
        if (action.toLowerCase() === "buy"){
            const userResult = await client.query("SELECT balance from users WHERE id = $1", [userId])
            if (userResult.rows.length === 0){
                return res.status(404).json({error:"User not found"})
            }
            const stock_symbols = stock.map(data=>
                data.symbol
            )
            console.log(stock_symbols)
            const prices = await redis.sendCommand(["HMGET", "stockPrices", ...stock_symbols]);
            console.log("PRICES", prices)
            let total = 0
            stock.forEach(s=>{
                total += (s.quantity) * prices[s.symbol]
            })
            let balance = parseFloat(userResult.rows[0].balance)
            if (total < balance){
                console.log("You have enough money!")
            }
            console.log("WE HAVE MULA!", stock, total, balance)
            return await executeBuy(client, userId, stock, total, balance)
        }else if (action.toLowerCase() === 'sell'){
            await executeSell(client, userId, symbol, quantity, stockPrice)
        }  
        // let stockPrice = await getStockPrice(symbol)
        // if (!stockPrice){
        //     return res.status(400).json({Error:"Error getting stock price from cache"})
        // }
        // let totalCost = quantity * parseFloat(stockPrice)
        // await client.query("COMMIT")
        // const end = Date.now();
        // console.log(` Portfolio API Response Time: ${end - start}ms`);
        // return res.status(200).json({message: "Trade Successful!"})


    }catch(error){
        await client.query("ROLLBACK")
        console.error("Trade Error: ", error.message)
        res.status(500).json({error: "Trade processing error", details: error.message})
    }
    finally{
        client.release()
    }
})
// async function executeBuy(client, balance, totalCost, userId, symbol, quantity, stockPrice){
//     if (balance < totalCost){
//         await client.query("ROLLBACK")
//         return res.status(400).json({error:"Insufficient funds"})
//     }
//     await client.query("Update USERS SET balance = balance - $1 WHERE id = $2",[totalCost, userId]);
//     await client.query(
//         `Insert INTO trades (user_id, symbol, quantity, executed_price, trade_type) VALUES ($1, $2,$3,$4, 'BUY')
//         `,[userId, symbol, quantity,stockPrice]
//     )
//     await client.query(
//         `Insert INTO positions (user_id, symbol, quantity, average_price) VALUES ($1, $2,$3,$4) 
//         ON CONFLICT(user_id, symbol) 
//         DO UPDATE SET
//             quantity = positions.quantity + EXCLUDED.quantity,
//             average_price = ((positions.quantity * positions.average_price) + (EXCLUDED.quantity * EXCLUDED.average_price))/ (positions.quantity + EXCLUDED.quantity),
//             updated_at = CURRENT_TIMESTAMP;
//         `,[userId, symbol, quantity, stockPrice]
//     )
// }
// async function executeSell(client, userId, symbol, quantity, stockPrice){
//     const holding = await client.query(
//             `UPDATE positions
//             SET quantity = quantity - $1, updated_at = CURRENT_TIMESTAMP
//             WHERE user_id = $2 AND symbol = $3 and quantity >= $1
//             RETURNING *;
//             `[quantity, userId, symbol])
//         if (holding.rowCount === 0){
//             await client.query("ROLLBACK")
//             return res.status(400).json({error:"Not enough shares"});
//         }
//         await client.query("UPDATE users SET balance = balance + $1 WHERE id = $2",[totalCost, userId])
//         await client.query(
//             `INSERT into trades (user_id, symbol, quantity, executed_price, trade_type) VALUES ($1,$2,$3,$4, 'SELL')
//             `,[userId, symbol, quantity, stockPrice]
//     )
// }
async function executeSell(client, userId, symbol, quantity, stockPrice){
    const holding = await client.query(
            `UPDATE positions
            SET quantity = quantity - $1, updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $2 AND symbol = $3 and quantity >= $1
            RETURNING *;
            `[quantity, userId, symbol])
        if (holding.rowCount === 0){
            await client.query("ROLLBACK")
            return res.status(400).json({error:"Not enough shares"});
        }
        await client.query("UPDATE users SET balance = balance + $1 WHERE id = $2",[totalCost, userId])
        await client.query(
            `INSERT into trades (user_id, symbol, quantity, executed_price, trade_type) VALUES ($1,$2,$3,$4, 'SELL')
            `,[userId, symbol, quantity, stockPrice]
    )
}

// router.post('/trade', authenticateToken, async (req,res)=>{
//     const start = Date.now();
//     const {symbol, quantity, action} = req.body
//     const userId = req.user.id
//     if (!symbol || !quantity || !action){
//         return res.status(400).json({error: "Missing required fields"})
//     }
//     if (!['buy','sell'].includes(action.toLowerCase())){
//         return res.status(400).json({error: "Action must be to buy or sell"})
//     }
//     const client = await pool.connect()

//     try{
//         await client.query("BEGIN");

//         const userResult = await client.query("SELECT balance from users WHERE id = $1", [userId])
//         if (userResult.rows.length === 0){
//             return res.status(404).json({error:"User not found"})
//         }
//         let balance = parseFloat(userResult.rows[0].balance)
//         let stockPrice = await getStockPrice(symbol)
//         if (!stockPrice){
//             return res.status(400).json({Error:"Error getting stock price from cache"})
//         }
//         let totalCost = quantity * parseFloat(stockPrice)
//         if (action.toLowerCase() === "buy"){
//             await executeBuy(client, balance, totalCost, userId, symbol, quantity, stockPrice)
//         }else if (action.toLowerCase() === 'sell'){
//             await executeSell(client, userId, symbol, quantity, stockPrice)
//         }  
//         await client.query("COMMIT")
//         const end = Date.now();
//         console.log(` Portfolio API Response Time: ${end - start}ms`);
//         return res.status(200).json({message: "Trade Successful!"})


//     }catch(error){
//         await client.query("ROLLBACK")
//         console.error("Trade Error: ", error.message)
//         res.status(500).json({error: "Trade processing error", details: error.message})
//     }
//     finally{
//         client.release()
//     }
// })

export default router;