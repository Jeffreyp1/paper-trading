package workers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"time"
	"trading-service/pkg/redisClient"

	kafka "github.com/segmentio/kafka-go"

	"github.com/redis/go-redis/v9"
)

// func addToKafka( userId int, action string, balance float64, stocks []struct {
// 	Symbol   string  `json:"symbol"`
// 	Quantity float64 `json:"quantity"`
// 	Price    float64 `json:"price"`
// }) error{

//		return nil
//	}
var kafkaWriter = kafka.NewWriter(kafka.WriterConfig{
	Brokers:  []string{"localhost:9092"}, // your broker
	Topic:    "trades-topic",
	Balancer: &kafka.LeastBytes{},
})

func processRedisStream(workerId int) {
	for {
		// log.Printf("📥 Worker %d attempting to read from `buy_stream`...", workerId)
		messages, err := redisClient.Client.XReadGroup(context.Background(), &redis.XReadGroupArgs{
			Group:    "kafka_workers",
			Consumer: fmt.Sprintf("redisConsumer-%d", workerId),
			Streams:  []string{"buy_stream", ">"},
			Count:    10,
			Block:    5 * time.Second,
		}).Result()
		// log.Printf("reading message now!")
		if err != nil {
			log.Println("Error reading from Redis Stream: ", err)
			break
		} else {
			if len(messages) == 0 || len(messages[0].Messages) == 0 {
				log.Printf("⚠️ Worker %d found no messages", workerId)
				continue
			}
		}
		for _, message := range messages[0].Messages {
			jobID := message.ID
			values := message.Values
			tempUserId, ok := values["user_id"].(string)
			if !ok || tempUserId == "" {
				log.Println("Missing or invalid user_id", values)
				continue
			}
			userId, err := strconv.Atoi(tempUserId)
			if err != nil {
				log.Printf("Error converting user_id", values)
			}
			action, ok := values["action"].(string)
			if !ok {
				log.Printf("Missing or invalid action", values)
				continue
			}
			balanceStr, ok := values["balance"].(string)
			if !ok {
				log.Printf("Missing or invalid balance", values)
				continue
			}
			balance, err := strconv.ParseFloat(balanceStr, 64)
			if err != nil {
				log.Printf("Failed to convert balance to float", values)
				continue
			}
			stockData, ok := values["stocks"].(string)
			if !ok {
				log.Printf("Failed to retrieve list of stocks")
				continue
			}
			var stocks []struct {
				Symbol   string  `json:"symbol"`
				Quantity float64 `json:"quantity"`
				Price    float64 `json:"price"`
			}
			err = json.Unmarshal([]byte(stockData), &stocks)
			if err != nil {
				log.Println("Failed to deserialized stock data: ", err)
				continue
			}
			err = addToKafka(userId, action, balance, stocks)
			if err != nil {
				log.Println("Error processing to SQL: ", err)
				continue
			}
			_, err = redisClient.Client.XAck(context.Background(), "buy_stream", "sql_workers", jobID).Result()
			if err != nil {
				log.Println("Error acknowledging job: ", err)
			} else {
				log.Printf("Trade %s acknowledged", jobID)
				// redisClient.Client.XTrimMaxLen(context.Background(), "buy_stream", 200000).Result()
				// if trimErr != nil {
				// 	log.Println("❌ Error trimming Redis stream: ", trimErr)
				// } else {
				// 	log.Println("✅ Successfully trimmed processed trades.")
				// }
			}
		}
	}
}

func StartKafkaConsumer(workerCount int) {

	for i := 1; i <= workerCount; i++ {
		go processRedisStream(i)

	}

}
