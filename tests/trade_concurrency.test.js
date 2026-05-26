/**
 * Concurrency test for POST /api/v1/trading/trade (BUY path).
 *
 * What it verifies:
 *   - 10 parallel requests, each buying 1 share at $1,100, against a $10,000 balance.
 *   - Final users.balance must never go negative.
 *   - Number of successful trades * $1,100 must be <= $10,000 (i.e. at most 9 succeed).
 *   - This proves the SELECT FOR UPDATE + re-check protects against the overdraft race.
 *
 * How to run (manual; the Node service must be running and Postgres + Redis up):
 *
 *   # 1. Start infra
 *   docker compose -f /Users/jeffrey/paper-trading/docker-compose.yml up -d postgres redis
 *
 *   # 2. Start the Node service in another shell
 *   cd /Users/jeffrey/paper-trading && npm start
 *
 *   # 3. Run the test (uses the same .env for DB_*, JWT_SECRET, REDIS_*)
 *   cd /Users/jeffrey/paper-trading && node tests/trade_concurrency.test.js
 *
 * Optional env overrides:
 *   API_URL       (default http://localhost:3000)
 *   TEST_SYMBOL   (default __TEST_SYM__, written into the stockPrices hash by this script)
 *   TEST_PRICE    (default 1100)
 *   TEST_EMAIL    (default trade_race_test@example.com)
 *
 * Exit code 0 on success, 1 on any assertion failure.
 */

import assert from 'node:assert/strict';
import axios from 'axios';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import redis from '../redis.js';
import 'dotenv/config';

const API_URL = process.env.API_URL || 'http://localhost:3000';
const TEST_SYMBOL = process.env.TEST_SYMBOL || '__TEST_SYM__';
const TEST_PRICE = parseFloat(process.env.TEST_PRICE || '1100');
const TEST_EMAIL = process.env.TEST_EMAIL || 'trade_race_test@example.com';
const TEST_USERNAME = 'trade_race_test_user';
const TEST_PASSWORD = 'pw_does_not_matter_for_this_test';
const STARTING_BALANCE = 10000.00;
const PARALLEL_REQUESTS = 10;

async function setup() {
    // Ensure Redis is connected (node-redis v4 lazily connects in some setups, but
    // redis.js calls .connect() at module load, so we just confirm reachability).
    if (!redis.isOpen) {
        await redis.connect().catch(() => {});
    }

    // Seed the test symbol into the stockPrices hash so trade.js's HMGET resolves it.
    await redis.hSet('stockPrices', TEST_SYMBOL, String(TEST_PRICE));

    // Make sure JWT_SECRET is present.
    if (!process.env.JWT_SECRET) {
        throw new Error('JWT_SECRET is not set in env — required to mint a test token.');
    }

    // Clean up any prior test user, then create a fresh one with exactly $10,000.
    const cleanupClient = await pool.connect();
    try {
        await cleanupClient.query('BEGIN');
        const existing = await cleanupClient.query(
            'SELECT id FROM users WHERE email = $1',
            [TEST_EMAIL]
        );
        if (existing.rows.length > 0) {
            const uid = existing.rows[0].id;
            await cleanupClient.query('DELETE FROM trades WHERE user_id = $1', [uid]);
            await cleanupClient.query('DELETE FROM positions WHERE user_id = $1', [uid]);
            await cleanupClient.query('DELETE FROM users WHERE id = $1', [uid]);
        }
        const hash = await bcrypt.hash(TEST_PASSWORD, 4);
        const inserted = await cleanupClient.query(
            `INSERT INTO users (username, email, password_hash, balance)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [TEST_USERNAME, TEST_EMAIL, hash, STARTING_BALANCE]
        );
        const userId = inserted.rows[0].id;
        await cleanupClient.query('COMMIT');

        const token = jwt.sign(
            { id: userId, email: TEST_EMAIL },
            process.env.JWT_SECRET,
            { expiresIn: '1h' }
        );
        return { userId, token };
    } catch (e) {
        await cleanupClient.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        cleanupClient.release();
    }
}

async function fireOneTrade(token) {
    try {
        const resp = await axios.post(
            `${API_URL}/api/v1/trading/trade`,
            { action: 'buy', stock: [{ symbol: TEST_SYMBOL, quantity: 1 }] },
            {
                headers: { Authorization: `Bearer ${token}` },
                validateStatus: () => true, // we want to inspect every status
                timeout: 15000,
            }
        );
        return { status: resp.status, body: resp.data };
    } catch (err) {
        return { status: 0, body: { error: err.message } };
    }
}

async function readBalance(userId) {
    const r = await pool.query('SELECT balance FROM users WHERE id = $1', [userId]);
    return parseFloat(r.rows[0].balance);
}

async function countTrades(userId) {
    const r = await pool.query(
        "SELECT COUNT(*)::int AS c FROM trades WHERE user_id = $1 AND trade_type = 'BUY'",
        [userId]
    );
    return r.rows[0].c;
}

async function main() {
    console.log('Setting up test user + seed price...');
    const { userId, token } = await setup();
    console.log(`  user_id=${userId}, starting balance=$${STARTING_BALANCE}, ${TEST_SYMBOL}=$${TEST_PRICE}`);

    console.log(`Firing ${PARALLEL_REQUESTS} parallel BUY requests...`);
    const results = await Promise.all(
        Array.from({ length: PARALLEL_REQUESTS }, () => fireOneTrade(token))
    );

    const successes = results.filter(r => r.status === 200).length;
    const insufficient = results.filter(r => r.status === 400).length;
    const other = results.filter(r => r.status !== 200 && r.status !== 400);

    console.log(`  200 OK:           ${successes}`);
    console.log(`  400 Insufficient: ${insufficient}`);
    if (other.length > 0) {
        console.log(`  other:            ${other.length}`);
        for (const o of other) console.log(`    -> status=${o.status} body=${JSON.stringify(o.body)}`);
    }

    const finalBalance = await readBalance(userId);
    const tradesPersisted = await countTrades(userId);

    console.log(`Final balance in DB: $${finalBalance.toFixed(2)}`);
    console.log(`BUY trades persisted: ${tradesPersisted}`);

    // Assertions.
    assert.ok(
        finalBalance >= 0,
        `Final balance must be >= 0, got ${finalBalance}`
    );

    const spent = successes * TEST_PRICE;
    assert.ok(
        spent <= STARTING_BALANCE,
        `Successful trades * price (${spent}) must be <= starting balance (${STARTING_BALANCE})`
    );

    // Strongest invariant: persisted trades must match the money actually spent.
    const expectedBalance = STARTING_BALANCE - tradesPersisted * TEST_PRICE;
    assert.ok(
        Math.abs(finalBalance - expectedBalance) < 0.01,
        `Balance (${finalBalance}) should equal starting (${STARTING_BALANCE}) - tradesPersisted (${tradesPersisted}) * price (${TEST_PRICE}) = ${expectedBalance}`
    );

    // At $1,100/trade against a $10,000 balance, at most 9 can succeed.
    assert.ok(
        successes <= 9,
        `At most 9 successes possible at $${TEST_PRICE} each against $${STARTING_BALANCE}; got ${successes}`
    );

    console.log('PASS: concurrency invariants hold.');
}

main()
    .then(async () => {
        await pool.end().catch(() => {});
        await redis.quit().catch(() => {});
        process.exit(0);
    })
    .catch(async (err) => {
        console.error('FAIL:', err && err.stack ? err.stack : err);
        await pool.end().catch(() => {});
        await redis.quit().catch(() => {});
        process.exit(1);
    });
