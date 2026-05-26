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
		"bootstrap.servers":            "localhost:9092",
		"queue.buffering.max.messages": 8000000,
		"queue.buffering.max.kbytes":   8048576,
		// S-tier #5: let librdkafka batch + compress on the wire.
		"linger.ms":        10,
		"batch.size":       1048576,
		"compression.type": "snappy",
		"acks":             "all",
		"enable.idempotence": true,
	})
	if err != nil {
		log.Fatalf("Failed to create Kafka producer: %v", err)
	}

	// Drain delivery reports in a single goroutine: ack Redis Stream ONLY after
	// the broker confirms the message landed. Closes the prior data-loss window
	// where XAck+XDel happened immediately after a non-blocking Produce.
	go func() {
		for e := range producer.Events() {
			m, ok := e.(*kafka.Message)
			if !ok {
				continue
			}
			meta, _ := m.Opaque.(*deliveryMeta)
			if meta == nil {
				continue
			}
			if m.TopicPartition.Error != nil {
				log.Printf("kafka delivery err for redis msg %s: %v", meta.jobID, m.TopicPartition.Error)
				// Do NOT ack; the stream replay will retry on next restart.
				continue
			}
			ctx := context.Background()
			if _, err := redisClient.Client.XAck(ctx, "buy_stream", "kafka_workers", meta.jobID).Result(); err != nil {
				log.Printf("redis xack err for %s: %v", meta.jobID, err)
				continue
			}
			redisClient.Client.XDel(ctx, "buy_stream", meta.jobID)
		}
	}()
}

// deliveryMeta is attached to each Kafka produce request so the delivery-report
// callback can find the originating Redis Stream message ID to ack.
type deliveryMeta struct {
	jobID string
}

func processRedisStream(workerId int) error {
	if producer == nil {
		log.Fatal("kafka producer is NIL ")
	}
	for {
		// S-tier #3: Block up to 5s on empty stream instead of hot-looping.
		messages, err := redisClient.Client.XReadGroup(context.Background(), &redis.XReadGroupArgs{
			Group:    "kafka_workers",
			Consumer: fmt.Sprintf("redisConsumer-%d", workerId),
			Streams:  []string{"buy_stream", ">"},
			Count:    100,
			Block:    5 * time.Second,
		}).Result()
		if err != nil {
			if err == redis.Nil { // timeout, no messages — normal idle case
				continue
			}
			log.Println("Error reading from Redis Stream: ", err)
			continue
		}
		if len(messages) == 0 || len(messages[0].Messages) == 0 {
			continue
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
			// Pattern 1a: shard by user_id. librdkafka's default partitioner
			// hashes Key -> partition, so all trades for the same user always
			// land on the same partition, consumed by the same SQL writer.
			// No two writers ever see the same user => no cross-consumer
			// row contention => no deadlocks.
			//
			// S-tier #4: Opaque carries the Redis Stream jobID so the
			// delivery-report goroutine can XAck only after Kafka confirms.
			err = producer.Produce(&kafka.Message{
				TopicPartition: kafka.TopicPartition{Topic: ptr("trade_events"), Partition: kafka.PartitionAny},
				Key:            []byte(strconv.Itoa(userID)),
				Value:          jsonPayload,
				Opaque:         &deliveryMeta{jobID: jobID},
			}, nil)
			if err != nil {
				log.Printf("Kafka publish error %v", err)
				// Do NOT ack; the message stays in the pending list and will retry.
			}
		}
	}
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
