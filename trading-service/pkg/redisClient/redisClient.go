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
		PoolSize:     75,
		MinIdleConns: 5,
		PoolTimeout:  time.Second * 10,
	})
	_, err := Client.Ping(Ctx).Result()
	if err != nil {
		log.Fatalf("Failed to connect to Redis %v", err)

	}
	fmt.Println("Successfully connected to Redis!")
}
