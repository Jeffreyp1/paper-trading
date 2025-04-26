// import redis from "../redis.js"
// import pool from "../db.js"
// export async function storeBalanceToRedis(){
//     const start = Date.now()
//     const result = await pool.query("SELECT id, balance FROM users")
//     console.log("row count", result)
//     const balances = []
//     console.log(result)
//     result.rows.forEach(user=>{
//         balances.push(user.id.toString(), user.balance.toString())
//     })
//     console.log(balances)
//     if (balances.length > 0){
//         console.log("Getting User_balance")
//         await redis.del("user_balance"); // 💥 Clears the hash
//         const res = await redis.hSet("user_balance", ...balances);
//         console.log(`✅ Redis fields added: ${res}`);

//     }else{
//         console.log("There are no existing users")
//     }
//     console.log("Added user balance to redis")
//     console.log(`It took ${Date.now()-start}ms to store balance to redis`)
// }
// src/utils/storeBalanceToRedis.js
import redis from "../redis.js";
import pool  from "../db.js";

/**
 * Pull every user’s balance from Postgres and write them
 * into the Redis hash  user_balance  (field = user‑id, value = balance).
 */
export async function storeBalanceToRedis() {
  const start = Date.now();

  /* 1️⃣  fetch balances from Postgres */
  const { rows } = await pool.query("SELECT id, balance FROM users");
  console.log("🔢 rows from DB:", rows.length);
  if (rows.length === 0) {
    console.log("❌ no users found — nothing to write");
    return;
  }

  /* 2️⃣  build an object:  { "1": "100000", "2": "98750", ... }  */
  const balanceMap = Object.fromEntries(
    rows.map(u => [u.id.toString(), u.balance.toString()])
  );

  /* 3️⃣  replace the Redis hash in one shot */
  try {
    await redis.del("user_balance");                    // clear old
    const added = await redis.hSet("user_balance", balanceMap); // ← object form
    const count = await redis.hLen("user_balance");

    console.log(`✅ fields added: ${added}`);            // should equal rows.length
    console.log(`📊 hash length : ${count}`);
  } catch (err) {
    console.error("❌ Redis write failed:", err);
    return;
  }

  /* 4️⃣  optional preview for sanity */
  const sample = await redis.hGetAll("user_balance");
  console.log("🔍 sample (first 3):", Object.entries(sample).slice(0, 3));
  console.log(`⏱ done in ${Date.now() - start} ms`);
}

export async function storePositionsToRedis(){
    const start = Date.now()
    const count = await redis.keys("positions:*")
    if (count.length === 0){
        const result = await pool.query("SELECT user_id, symbol, quantity, average_price FROM positions")
        const pipeline = redis.multi()
        result.rows.forEach(user=>{
            pipeline.hSet(`positions:${user.user_id}`, user.symbol, `${user.quantity},${user.average_price}`)
        })
        await pipeline.exec()
        const length_of_redis = await redis.keys("positions:*")
        console.log(`Added ${result.rowCount} results from positions to redis and ${length_of_redis.length} keys to redis`)
    }else{
        console.log("Positions have already been stored in redis")
    }
    console.log(`It took ${Date.now()-start}ms to store positions to redis`)
}