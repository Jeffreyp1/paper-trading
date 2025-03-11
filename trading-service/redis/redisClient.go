package redis

import (
	"context"
	"fmt"
	"log"

	"github.com/redis/go-redis/v9"
)

var ctx = context.Background()
var RedisClient *redis.Client

func InitRedis() {
	RedisClient = redis.NewClient(&redis.Options{
		Addr: "localhost:6379",
	})
	_, err := RedisClient.Ping(ctx).Result()
	if err != nil {
		log.Fatalf("Failed to connect to Redis %v", err)

	}
	fmt.Println("Successfully connected to Redis!")
	// return RedisClient
}

// func main() {
// 	redisClient := RedisClient()
// 	val, err := redisClient.HGet(ctx, "stockPrices", "META").Result()
// 	if err != nil {
// 		log.Fatalf("Failed to retrieve stock price from redis")
// 	}
// 	fmt.Println("META PRICE:", val)
// }
