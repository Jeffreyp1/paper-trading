package redisStorage

import (
	"context"
	"fmt"
	"strconv"
	"sync"

	"github.com/redis/go-redis/v9"
)

var (
	client     *redis.Client
	cache      = make(map[string]float64)
	cacheMutex sync.RWMutex
)

// ✅ Initialize Redis + load all stock prices into memory cache
func InitRedis(c *redis.Client) {
	client = c

	ctx := context.Background()
	keys, err := client.Keys(ctx, "stock:*").Result()
	if err != nil {
		fmt.Printf("❌ Failed to list stock keys: %v\n", err)
		return
	}

	for _, key := range keys {
		val, err := client.Get(ctx, key).Result()
		if err != nil {
			fmt.Printf("⚠️ Failed to get %s: %v\n", key, err)
			continue
		}
		price, err := strconv.ParseFloat(val, 64)
		if err != nil {
			fmt.Printf("⚠️ Invalid price for %s: %v\n", key, err)
			continue
		}
		symbol := key[len("stock:"):] // remove "stock:" prefix
		cacheMutex.Lock()
		cache[symbol] = price
		cacheMutex.Unlock()
	}

	fmt.Printf("✅ Loaded %d stock prices from Redis into memory\n", len(cache))
}

// ✅ Read-only fast lookup from in-memory cache
func GetStockPrice(symbol string) (float64, error) {
	cacheMutex.RLock()
	price, ok := cache[symbol]
	cacheMutex.RUnlock()
	if ok {
		return price, nil
	}

	// 🔄 Pull from Redis hash
	ctx := context.Background()
	val, err := client.HGet(ctx, "stockPrices", symbol).Result()
	if err == redis.Nil {
		return 0, fmt.Errorf("❌ symbol not found in Redis hash: %s", symbol)
	}
	if err != nil {
		return 0, fmt.Errorf("redis HGET error for %s: %v", symbol, err)
	}

	parsed, err := strconv.ParseFloat(val, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid price for %s: %v", symbol, err)
	}

	// ✅ Save to local cache
	cacheMutex.Lock()
	cache[symbol] = parsed
	cacheMutex.Unlock()

	return parsed, nil
}




// func GetStockPrice(symbol string) (float64, error) {
// 	// 🔍 1. Check local cache
// 	cacheMutex.RLock()
// 	price, ok := cache[symbol]
// 	cacheMutex.RUnlock()
// 	if ok {
// 		return price, nil
// 	}

// 	// 🌐 2. Fetch from Redis if not in cache
// 	ctx := context.Background()
// 	val, err := client.Get(ctx, fmt.Sprintf("stock:%s", symbol)).Result()
// 	if err != nil {
// 		return 0, err
// 	}

// 	parsed, err := strconv.ParseFloat(val, 64)
// 	if err != nil {
// 		return 0, err
// 	}

// 	// 💾 3. Save to cache
// 	cacheMutex.Lock()
// 	cache[symbol] = parsed
// 	cacheMutex.Unlock()

// 	return parsed, nil
// }


// func main() {
// 	redisClient := RedisClient()
// 	val, err := redisClient.HGet(ctx, "stockPrices", "META").Result()
// 	if err != nil {
// 		log.Fatalf("Failed to retrieve stock price from redis")
// 	}
// 	fmt.Println("META PRICE:", val)
// }
