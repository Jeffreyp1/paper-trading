package redisClient

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

var Ctx = context.Background()
var Client *redis.Client

func InitRedis() {
	Client = redis.NewClient(&redis.Options{
		Addr:         "localhost:6379",
		PoolSize:     10, // Increase this based on your system's capabilities
		MinIdleConns: 5,  // Keep some connections ready
		PoolTimeout:  time.Second * 3,
	})
	_, err := Client.Ping(Ctx).Result()
	if err != nil {
		log.Fatalf("Failed to connect to Redis %v", err)

	}
	fmt.Println("Successfully connected to Redis!")
}
