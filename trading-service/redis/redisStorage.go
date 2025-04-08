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

func InitRedis(c *redis.Client) {
	client = c
}

// GetStockPrice retrieves a stock price from cache or Redis
func GetStockPrice(symbol string) (float64, error) {
	// 🔍 1. Check local cache
	cacheMutex.RLock()
	price, ok := cache[symbol]
	cacheMutex.RUnlock()
	if ok {
		return price, nil
	}

	// 🌐 2. Fetch from Redis if not in cache
	ctx := context.Background()
	val, err := client.Get(ctx, fmt.Sprintf("stock:%s", symbol)).Result()
	if err != nil {
		return 0, err
	}

	parsed, err := strconv.ParseFloat(val, 64)
	if err != nil {
		return 0, err
	}

	// 💾 3. Save to cache
	cacheMutex.Lock()
	cache[symbol] = parsed
	cacheMutex.Unlock()

	return parsed, nil
}


// func main() {
// 	redisClient := RedisClient()
// 	val, err := redisClient.HGet(ctx, "stockPrices", "META").Result()
// 	if err != nil {
// 		log.Fatalf("Failed to retrieve stock price from redis")
// 	}
// 	fmt.Println("META PRICE:", val)
// }
