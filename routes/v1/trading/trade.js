import express from 'express';
import pool from '../../../db.js';
import redis from '../../../redis.js';
import authenticateToken from '../../../middleware/authMiddleware.js';
import 'dotenv/config';

const router = express.Router();
async function executeBuy(client,prices, userId, stockData, totalCost){
    const update_balance = await client.query("Update USERS SET balance = balance - $1 WHERE id = $2",[totalCost, userId]);
    if (update_balance.rowCount === 0){
        await client.query("ROLLBACK")
        throw new Error("Unable to update balance")
    }
    const insert_trades_values = stockData.map((stock,index)=>{
        const price = prices[index]
        if (!price) {
            console.error(`🚨 No price found for ${stock.symbol}. Skipping trade.`);
            return null;
        }
        return `(${userId},'${stock.symbol}', ${stock.quantity}, ${prices[index]}, 'BUY')`
    })

    const insert_trades = `
                    INSERT INTO trades (user_id, symbol, quantity, executed_price, trade_type)
                    VALUES ${insert_trades_values.join(", ")}`
    const insert_trade_to_db = await client.query(insert_trades)
    if(insert_trade_to_db.rowCount === 0){
        throw new Error(`Failed to insert ${insert_trades_values.length} trade(s) into database`)
    }
    const insert_position_values = stockData.map((stock,index)=>
        `(${userId}, '${stock.symbol}', ${stock.quantity}, ${prices[index]})`
    )
    const add_to_positions = await client.query(
        `Insert INTO positions (user_id, symbol, quantity, average_price) VALUES ${insert_position_values.join(", ")}
        ON CONFLICT(user_id, symbol) 
        DO UPDATE SET
            quantity = positions.quantity + EXCLUDED.quantity,
            average_price = ((positions.quantity * positions.average_price) + (EXCLUDED.quantity * EXCLUDED.average_price))/ (positions.quantity + EXCLUDED.quantity),
            updated_at = CURRENT_TIMESTAMP;`
    )
    if(add_to_positions.rowCount === 0){
        await client.query("ROLLBACK")
        throw new Error("Failed to Insert or Update the trade(s) into database")
    }
}
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
router.post('/trade', async (req,res)=>{
    const start = Date.now();
    const {userId, action, stock} = req.body
    // const userId = req.user.id
    if (!stock || !userId || !action){
        return res.status(400).json({error: "Missing required fields"})
    }
    if (!['buy','sell'].includes(action.toLowerCase())){
        return res.status(400).json({error: "Action must be to buy or sell"})
    }
    const client = await pool.connect()

    try{
        const stock_symbols = stock.map(data=>
            data.symbol
        )
        if (action.toLowerCase() === "buy"){
            const userResult = await client.query("SELECT balance from users WHERE id = $1", [userId])
            if (userResult.rows.length === 0){
                return res.status(404).json({error:"User not found"})
            }
            const balance = parseFloat(userResult.rows[0].balance)
            const prices = await redis.sendCommand(["HMGET", "stockPrices", ...stock_symbols]);
            // const total = stock.reduce((sum,s,index) => sum + (s.quantity) * (prices[index]))
            const total = stock.reduce((sum, s) => {
                const stockPrice = prices[s.symbol] || 0;  // Ensure price lookup works
                return sum + (s.quantity * stockPrice);
            }, 0);
            if (total < balance){
                await client.query("BEGIN");
                await executeBuy(client, prices, userId, stock, total)
                await client.query("COMMIT")
            }
        }else if (action.toLowerCase() === 'sell'){
            await client.query("BEGIN");
            await executeSell(client, userId, symbol, quantity, stockPrice)
            await client.query("COMMIT")
        }  
        const end = Date.now()
        // console.log(`${action} transaction took ${start-end}ms`)
        return res.status(200).json({message: "Successful!"})

    }catch(error){
        await client.query("ROLLBACK")
        console.error("Trade Error: ", error.message)
        res.status(500).json({error: "Trade processing error", details: error.message})
    }
    finally{
        client.release()
    }
})


export default router;