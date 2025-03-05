import express from 'express';
import pool from '../../../db.js';
import redis from '../../../redis.js';

import axios from 'axios';
import authenticateToken from '../../../middleware/authMiddleware.js';
import getStockPrice from '../../../services/getStockPrice.js';
import 'dotenv/config';

const router = express.Router();

router.post('/new_trade', async (req, res) => {
    const { trades } = req.body;

    if (!Array.isArray(trades) || trades.length === 0) {
        return res.status(400).json({ error: "Invalid batch request" });
    }

    const client = await pool.connect();
    
    try {
        await client.query("BEGIN");

        // Prepare batched query structure
        const queryText = `INSERT INTO trades (user_id, symbol, quantity, trade_type, executed_price)
                           VALUES ${trades.map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(", ")}`;

        // Fetch latest stock prices from Redis
        const pricePromises = trades.map(trade => redis.get(trade.symbol));
        const stockPrices = await Promise.all(pricePromises);

        const queryValues = trades.flatMap(({ userId, symbol, quantity, action }, index) => [
            userId,
            symbol,
            quantity,
            action.toUpperCase(), // Ensure action is 'BUY' or 'SELL'
            stockPrices[index] || 0 // Use Redis price, default to 0 if not found
        ]);

        await client.query(queryText, queryValues);
        await client.query("COMMIT");

        res.json({ message: `✅ Batch trade executed for ${trades.length} trades.` });

    } catch (error) {
        await client.query("ROLLBACK");
        console.error(`Batch Trade Error: ${error.message}`);
        res.status(500).json({ error: "Batch trade execution failed" });
    } finally {
        client.release();
    }
});

export default router;
