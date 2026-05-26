import express from 'express';
import pool from '../../../db.js';
import redis from '../../../redis.js';
import authenticateToken from '../../../middleware/authMiddleware.js';
import 'dotenv/config';

const router = express.Router();

async function executeBuy(client, priceMap, userId, stockData, totalCost) {
    const update_balance = await client.query(
        "UPDATE users SET balance = balance - $1 WHERE id = $2",
        [totalCost, userId]
    );
    if (update_balance.rowCount === 0) {
        throw new Error("Unable to update balance");
    }

    // Parameterized multi-row INSERT into trades.
    // For each stock we emit a 5-column placeholder group: ($n, $n+1, $n+2, $n+3, 'BUY').
    const tradePlaceholders = [];
    const tradeParams = [];
    let i = 1;
    for (const stock of stockData) {
        const price = priceMap[stock.symbol];
        if (price === undefined || price === null) {
            console.error(`🚨 No price found for ${stock.symbol}. Aborting trade.`);
            throw new Error(`Missing price for symbol ${stock.symbol}`);
        }
        tradePlaceholders.push(`($${i}, $${i + 1}, $${i + 2}, $${i + 3}, 'BUY')`);
        tradeParams.push(userId, stock.symbol, stock.quantity, price);
        i += 4;
    }

    const insert_trades_sql = `
        INSERT INTO trades (user_id, symbol, quantity, executed_price, trade_type)
        VALUES ${tradePlaceholders.join(", ")}
    `;
    const insert_trade_to_db = await client.query(insert_trades_sql, tradeParams);
    if (insert_trade_to_db.rowCount === 0) {
        throw new Error(`Failed to insert ${tradePlaceholders.length} trade(s) into database`);
    }

    // Parameterized multi-row INSERT into positions with weighted-average upsert.
    const positionPlaceholders = [];
    const positionParams = [];
    let j = 1;
    for (const stock of stockData) {
        const price = priceMap[stock.symbol];
        positionPlaceholders.push(`($${j}, $${j + 1}, $${j + 2}, $${j + 3})`);
        positionParams.push(userId, stock.symbol, stock.quantity, price);
        j += 4;
    }

    const upsert_positions_sql = `
        INSERT INTO positions (user_id, symbol, quantity, average_price)
        VALUES ${positionPlaceholders.join(", ")}
        ON CONFLICT(user_id, symbol)
        DO UPDATE SET
            quantity = positions.quantity + EXCLUDED.quantity,
            average_price = ((positions.quantity * positions.average_price) + (EXCLUDED.quantity * EXCLUDED.average_price)) / (positions.quantity + EXCLUDED.quantity),
            updated_at = CURRENT_TIMESTAMP;
    `;
    const add_to_positions = await client.query(upsert_positions_sql, positionParams);
    if (add_to_positions.rowCount === 0) {
        throw new Error("Failed to Insert or Update the trade(s) into database");
    }
}

// NOTE: SELL path is intentionally left untouched (broken). Tracked separately.
async function executeSell(client, userId, symbol, quantity, stockPrice) {
    const holding = await client.query(
        `UPDATE positions
            SET quantity = quantity - $1, updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $2 AND symbol = $3 and quantity >= $1
            RETURNING *;
            `[quantity, userId, symbol]);
    if (holding.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Not enough shares" });
    }
    await client.query("UPDATE users SET balance = balance + $1 WHERE id = $2", [totalCost, userId]);
    await client.query(
        `INSERT into trades (user_id, symbol, quantity, executed_price, trade_type) VALUES ($1,$2,$3,$4, 'SELL')
            `, [userId, symbol, quantity, stockPrice]
    );
}

router.post('/trade', authenticateToken, async (req, res) => {
    const { action, stock } = req.body;
    const userId = req.user && req.user.id;

    if (!stock || !userId || !action) {
        return res.status(400).json({ error: "Missing required fields" });
    }
    if (!Array.isArray(stock) || stock.length === 0) {
        return res.status(400).json({ error: "stock must be a non-empty array" });
    }
    if (!['buy', 'sell'].includes(action.toLowerCase())) {
        return res.status(400).json({ error: "Action must be to buy or sell" });
    }

    const client = await pool.connect();

    try {
        const stock_symbols = stock.map(data => data.symbol);

        if (action.toLowerCase() === "buy") {
            // Build the symbol -> price map BEFORE the transaction (Redis I/O outside the lock).
            const pricesArr = await redis.sendCommand(["HMGET", "stockPrices", ...stock_symbols]);
            const priceMap = {};
            stock_symbols.forEach((sym, idx) => {
                const raw = pricesArr[idx];
                if (raw === null || raw === undefined) return;
                priceMap[sym] = parseFloat(raw);
            });

            // Validate every requested symbol has a price.
            for (const s of stock) {
                if (priceMap[s.symbol] === undefined || Number.isNaN(priceMap[s.symbol])) {
                    return res.status(400).json({ error: `No price available for ${s.symbol}` });
                }
                if (!Number.isFinite(s.quantity) || s.quantity <= 0) {
                    return res.status(400).json({ error: `Invalid quantity for ${s.symbol}` });
                }
            }

            const total = stock.reduce(
                (sum, s) => sum + s.quantity * priceMap[s.symbol],
                0
            );

            // Begin tx, then SELECT FOR UPDATE to serialize concurrent trades for this user.
            await client.query("BEGIN");
            try {
                const userResult = await client.query(
                    "SELECT balance FROM users WHERE id = $1 FOR UPDATE",
                    [userId]
                );
                if (userResult.rows.length === 0) {
                    await client.query("ROLLBACK");
                    return res.status(404).json({ error: "User not found" });
                }
                const balance = parseFloat(userResult.rows[0].balance);

                // Re-verify total <= balance AFTER acquiring the lock.
                if (total > balance) {
                    await client.query("ROLLBACK");
                    return res.status(400).json({ error: "Insufficient funds" });
                }

                await executeBuy(client, priceMap, userId, stock, total);
                await client.query("COMMIT");
            } catch (innerErr) {
                await client.query("ROLLBACK");
                throw innerErr;
            }
        } else if (action.toLowerCase() === 'sell') {
            // Sell path intentionally untouched and still broken; will throw and rollback.
            await client.query("BEGIN");
            await executeSell(client, userId, undefined, undefined, undefined);
            await client.query("COMMIT");
        }

        return res.status(200).json({ message: "Successful!" });

    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) { /* tx may already be closed */ }
        console.error("Trade Error: ", error.message);
        return res.status(500).json({ error: "Trade processing error", details: error.message });
    } finally {
        client.release();
    }
});


export default router;
