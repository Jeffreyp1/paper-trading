package redisClient

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/redis/go-redis/v9"
)

var Ctx = context.Background()
var Client *redis.Client

func InitRedis() {
	host := os.Getenv("REDIS_HOST")
	if host == "" {
		host = "localhost"
	}
	port := os.Getenv("REDIS_PORT")
	if port == "" {
		port = "6379"
	}
	Client = redis.NewClient(&redis.Options{
		Addr:         host + ":" + port,
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
