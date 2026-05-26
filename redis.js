import { createClient } from "redis";
import "dotenv/config";

const host = process.env.REDIS_HOST || "localhost";
const port = process.env.REDIS_PORT || 6379;
const redis = createClient({ url: `redis://${host}:${port}` });

redis.on("error", (err) => console.error(" Redis Client Error:", err));

await redis.connect(); // ✅ Required for node-redis v4+

export default redis;
