package workers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"time"
	redis "github.com/redis/go-redis/v9"
	redisClient "trading-service/pkg/redisClient"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

func addToKafka(userId int, action string, balance float64, stocks []struct {
	Symbol   string  `json:"symbol"`
	Quantity float64 `json:"quantity"`
	Price    float64 `json:"price"`
}) error {

	return nil
}

var producer *kafka.Producer

func initKafkaProducer() {
	var err error
	producer, err = kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers": "localhost:9092", // update if needed
	})
	if err != nil {
		log.Fatalf("Failed to create Kafka producer: %v", err)
	}
}
func processRedisStream(workerId int) error {
	if producer == nil{
		log.Fatal("kafka producer is NIL ")
	}
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
			userID, _ := strconv.Atoi(values["user_id"].(string))
			balance, _ := strconv.ParseFloat(values["balance"].(string), 64)
			action := values["action"].(string)

			var stocks []struct {
				Symbol   string  `json:"symbol"`
				Quantity float64 `json:"quantity"`
				Price    float64 `json:"price"`
			}
			err = json.Unmarshal([]byte(values["stocks"].(string)), &stocks)
			if err != nil {
				log.Printf("❌ Failed to parse stocks JSON: %v", err)
				continue
			}

			tradePayload := Trade{
				UserID:  userID,
				Action:  action,
				Balance: balance,
				Stocks:  stocks,
			}

			jsonPayload, err := json.Marshal(tradePayload)
			if err != nil {
				log.Printf("❌ Failed to marshal tradePayload: %v", err)
				continue
			}
			err = producer.Produce(&kafka.Message{
				TopicPartition: kafka.TopicPartition{Topic: ptr("trade_events"), Partition: kafka.PartitionAny},
				Value:          jsonPayload,
			}, nil)
			if err != nil {
				log.Printf("Kafka publish error %v", err)
			}
			_, _ = redisClient.Client.XAck(context.Background(), "buy_stream", "kafka_workers", jobID).Result()

			_, _ = redisClient.Client.XDel(context.Background(), "buy_stream", jobID).Result()

			// _, err = redisClient.Client.XAck(context.Background(), "buy_stream", "kafka_workers", jobID).Result()
			// if err != nil {
			// 	log.Println("Error acknowledging job: ", err)
			// } else {
			// 	_, trimErr := redisClient.Client.XDel(context.Background(), "buy_stream", jobID).Result()
			// 	if trimErr != nil {
			// 		log.Println("Error trimming Redis stream:", trimErr)
			// 	}else{
			// 		log.Println("Successfully trimmed!")
			// 	}
			// }
		}
	}
	return nil
}

func StartKafkaProducer(workerCount int) {
	initKafkaProducer()
	for i := 1; i <= workerCount; i++ {
		go processRedisStream(i)

	}

}
func ptr(s string) *string {
	return &s
}
