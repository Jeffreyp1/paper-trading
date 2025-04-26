package workers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
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
		"queue.buffering.max.messages": 8000000, // default is 100000
		"queue.buffering.max.kbytes": 8048576,   // 1GB
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
			_, err = redisClient.Client.XAck(context.Background(), "buy_stream", "kafka_workers", jobID).Result()
			_, _ = redisClient.Client.XDel(context.Background(), "buy_stream", jobID).Result()
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

// package workers

// import (
// 	"context"
// 	"encoding/json"
// 	"fmt"
// 	"log"
// 	"strconv"
// 	"time"

// 	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
// 	redis "github.com/redis/go-redis/v9"

// 	"trading-service/pkg/redisClient"
// )

// /* -------- data model -------- */


// /* -------- kafka producer -------- */

// var producer *kafka.Producer

// func initKafkaProducer() {
// 	if producer != nil {
// 		return // already initialised
// 	}
// 	var err error
// 	producer, err = kafka.NewProducer(&kafka.ConfigMap{
// 		"bootstrap.servers": "localhost:9092", // adjust for your env
// 	})
// 	if err != nil {
// 		log.Fatalf("❌ Failed to create Kafka producer: %v", err)
// 	}
// }

// /* -------- redis‑stream worker -------- */

// func processRedisStream(workerID int) {
// 	ctx := context.Background()

// 	for {
// 		msgs, err := redisClient.Client.XReadGroup(ctx, &redis.XReadGroupArgs{
// 			Group:    "kafka_workers",
// 			Consumer: fmt.Sprintf("redisConsumer-%d", workerID),
// 			Streams:  []string{"buy_stream", ">"}, // only new msgs; we always ack/del
// 			Count:    10,
// 			Block:    5 * time.Second,
// 		}).Result()

// 		switch {
// 		case err == redis.Nil, len(msgs) == 0, len(msgs[0].Messages) == 0:
// 			log.Printf("⚠️ Worker %d: no messages", workerID)
// 			continue
// 		case err != nil:
// 			log.Printf("❌ Worker %d: XReadGroup error: %v", workerID, err)
// 			continue
// 		}

// 		for _, m := range msgs[0].Messages {
// 			handleMessage(ctx, m)
// 		}
// 	}
// }

// func handleMessage(ctx context.Context, m redis.XMessage) {
// 	defer func() {
// 		redisClient.Client.XAck(ctx, "buy_stream", "kafka_workers", m.ID)
// 		redisClient.Client.XDel(ctx, "buy_stream", m.ID)
// 	}()

// 	/* ---- parse redis payload ---- */

// 	vals := m.Values
// 	userID, _ := strconv.Atoi(vals["user_id"].(string))
// 	balance, _ := strconv.ParseFloat(vals["balance"].(string), 64)
// 	action := vals["action"].(string)


// 	type Stock struct {
// 		Symbol   string  `json:"symbol"`
// 		Quantity float64 `json:"quantity"`
// 		Price    float64 `json:"price"`
// 	}

// 	type Trade struct {
// 		UserID  int      `json:"user_id"`
// 		Action  string   `json:"action"`
// 		Balance float64  `json:"balance"`
// 		Stocks  []Stock  `json:"stocks"`
// 	}
// 	var stocks []Stock
// 	if err := json.Unmarshal([]byte(vals["stocks"].(string)), &stocks); err != nil {
// 		log.Printf("❌ Bad stocks JSON for %s: %v", m.ID, err)
// 		return
// 	}

// 	payload, err := json.Marshal(Trade{
// 		UserID:  userID,
// 		Action:  action,
// 		Balance: balance,
// 		Stocks:  stocks,
// 	})
// 	if err != nil {
// 		log.Printf("❌ Marshal error for %s: %v", m.ID, err)
// 		return
// 	}

// 	/* ---- publish to kafka ---- */

// 	if err = producer.Produce(&kafka.Message{
// 		TopicPartition: kafka.TopicPartition{Topic: ptr("trade_events"), Partition: kafka.PartitionAny},
// 		Value:          payload,
// 	}, nil); err != nil {
// 		log.Printf("❌ Kafka publish error for %s: %v", m.ID, err)
// 	}
// }

// /* -------- public entry point -------- */

// func StartKafkaProducer(workerCount int) {
// 	initKafkaProducer()
// 	for i := 1; i <= workerCount; i++ {
// 		go processRedisStream(i)
// 	}
// }

// /* -------- helpers -------- */

// func ptr(s string) *string { return &s }
