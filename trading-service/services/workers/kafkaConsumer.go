package workers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"time"
	"trade-worker/pkg/redisClient"

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
	for {
		// log.Printf("📥 Worker %d attempting to read from `buy_stream`...", workerId)
		messages, err := redisClient.Client.XReadGroup(context.Background(), &redisClient.XReadGroupArgs{
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
			_, err := strconv.Atoi(tempUserId)
			if err != nil {
				log.Printf("Error converting user_id", values)
			}
			_, ok = values["action"].(string)
			if !ok {
				log.Printf("Missing or invalid action", values)
				continue
			}
			balanceStr, ok := values["balance"].(string)
			if !ok {
				log.Printf("Missing or invalid balance", values)
				continue
			}
			_, err = strconv.ParseFloat(balanceStr, 64)
			if err != nil {
				log.Printf("Failed to convert balance to float", values)
				continue
			}
			_, ok = values["stocks"].(string)
			if !ok {
				log.Printf("Failed to retrieve list of stocks")
				continue
			}
			jsonPayload, err := json.Marshal(values)
			err = producer.Produce(&kafka.Message{
				TopicPartition: kafka.TopicPartition{Topic: ptr("trade_events"), Partition: kafka.PartitionAny},
				Value:          jsonPayload,
			}, nil)
			if err != nil {
				log.Printf("Kafka publish error %v", err)
			}
			_, err = redisClient.Client.XAck(context.Background(), "buy_stream", "sql_workers", jobID).Result()
			if err != nil {
				log.Println("Error acknowledging job: ", err)
			} else {
				_, trimErr := redisClient.Client.XTrimMinID(context.Background(), "buy_stream", jobID).Result()
				if trimErr != nil {
					log.Println("Error trimming Redis stream:", trimErr)
				}
			}
		}
	}
	return nil
}

func StartKafkaConsumer(workerCount int) {

	for i := 1; i <= workerCount; i++ {
		go processRedisStream(i)

	}

}
func ptr(s string) *string {
	return &s
}
