import { createClient } from "redis";

const redis = createClient();

redis.on("error", (err) => console.error(" Redis Client Error:", err));

await redis.connect(); // ✅ Required for node-redis v4+

export default redis;
