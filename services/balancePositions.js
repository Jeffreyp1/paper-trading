import redis from "../redis.js"
import pool from "../db.js"
export async function storeBalanceToRedis(){
    const start = Date.now()
    const count = await redis.hLen("user_balance")
    if (count === 0){
        const result = await pool.query("SELECT id, balance FROM users")
        const balances = []
        result.rows.forEach(user=>{
            balances.push(user.id.toString(), user.balance.toString())
        })
        if (balances.length > 0){
            await redis.hSet("user_balance", ...balances)
        }else{
            console.log("There are no existing users")
        }
        console.log("Added user balance to redis")
    }else{
        console.log("Users have already been stored in redis")
    }
    console.log(`It took ${Date.now()-start}ms to store balance to redis`)
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