import redis from "../redis.js"
export default async function getStockPrice(symbol){
    const price = await redis.get(symbol)
    if (price){
        return parseFloat(price)

    }else{
        return null
    }
}