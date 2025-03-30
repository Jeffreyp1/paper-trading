package workers

import (
	"database/sql"
	"encoding/json"
	"log"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/segmentio/kafka-go"
)

type Trade struct {
	UserID  int     `json:"user_id"`
	Action  string  `json:"action"`
	Balance float64 `json:"balance"`
	Stocks  []struct {
		Symbol   string  `json:"symbol"`
		Quantity float64 `json:"quantity"`
		Price    float64 `json:"price"`
	} `json:"stocks"`
}

var (
	batchSize     = 10000
	batchTimeout  = 1 * time.Second
	consumerTopic = "trade_events"
)

// func insertTradeToPostgres(ctx context.Context, db *sql.DB, trade Trade) error {
// 	tx, err := db.BeginTx(ctx, nil)
// 	trade.Balance
// 	_, err := tx.ExecContext(ctx, "Update USERS SET balance = balance - $1 WHERE id = $2", totalCost, userId)
// 	if err != nil {
// 		return fmt.Errorf("error updating user: %w", err)
// 	}
// 	var trades []string
// 	var positions []string
// 	var args []interface{}
// 	for _, stock := range stockData.Stock {
// 		price, _ := redis.GetStockPrice(stock.Symbol)

// 		trades = append(trades, fmt.Sprintf(" ($%d, $%d, $%d, $%d, 'BUY') ", len(args)+1, len(args)+2, len(args)+3, len(args)+4))
// 		positions = append(positions, fmt.Sprintf("($%d, $%d, $%d, $%d)", len(args)+1, len(args)+2, len(args)+3, len(args)+4))
// 		args = append(args, userId, stock.Symbol, stock.Quantity, price.Price)
// 	}
// 	if len(trades) == 0 {
// 		return fmt.Errorf("no valid inserts")
// 	}
// 	if len(positions) == 0 {
// 		return fmt.Errorf("no valid position to insert")
// 	}
// 	insert_trades := fmt.Sprintf(`
// 		INSERT INTO trades (user_id, symbol, quantity, executed_price, trade_type)
// 		VALUES %s`, strings.Join(trades, ", "))
// 	_, err = tx.ExecContext(ctx, insert_trades, args...)
// 	if err != nil {
// 		return fmt.Errorf("failed to insert trades")
// 	}

//		insert_update_positions := fmt.Sprintf(
//			`Insert INTO positions (user_id, symbol, quantity, average_price)
//			VALUES %s
//			ON CONFLICT(user_id, symbol)
//	        DO UPDATE SET
//	            quantity = positions.quantity + EXCLUDED.quantity,
//	            average_price = ((positions.quantity * positions.average_price) + (EXCLUDED.quantity * EXCLUDED.average_price))/ (positions.quantity + EXCLUDED.quantity),
//	            updated_at = CURRENT_TIMESTAMP;`, strings.Join(positions, ", "))
//		_, err = tx.ExecContext(ctx, insert_update_positions, args...)
//		if err != nil {
//			fmt.Printf("Failed to insert/update positions: %v\n", err) // Log exact failure
//			return fmt.Errorf("Failed to insert/update positions: %v", err)
//		}
//		return nil
//	}
func processKafka(workerId int, db *sql.DB) error {
	r, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers": "localhost:9092",
		"group.id":          "postgres-writer",
		"auto.offset.reset": "earliest",
	})
	if err != nil {
		log.Fatalf("Failed to create Kafka Consumer: %v", err)
	}
	err = r.SubscribeTopics([]string{consumerTopic}, nil)
	if err != nil {
		log.Fatalf("Subscription Error: %v", err)
	}
	var batch []Trade
	ticker := time.NewTicker(batchTimeout)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if len(batch) > 0 {
				insertBatchToPostgres(db, batch)
				batch = nil
			}
		default:
			event, err := r.ReadMessage(100 * time.Millisecond)
			if err != nil {
				continue
			}
			var trade Trade
			err = json.Unmarshal(event.Value, &trade)
			if err != nil {
				log.Println("Invalid Trade Payload", err)
				continue
			}

			batch = append(batch, trade)

			if len(batch) >= batchSize {
				insertBatchToPostgres(db, batch)
				batch = nil
			}

		}
		// ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		// defer cancel()

		// message, err := r.ReadMessage(ctx)
		// if err != nil {
		// 	log.Printf("Error reading message %v", err)
		// 	continue
		// }

		// var trade Trade
		// err = json.Unmarshal(message.Value, &trade)
		// if err != nil {
		// 	log.Printf("Failed to unmarshal message.Value %v", err)
		// 	continue
		// }

		// err = insertTradeToPostgres(ctx, db, trade)

	}
	return nil
}
func insertBatchToPostgres(db *sql.DB, trades []Trade) {
	updateBalances(db, trades)
	upsertPositions(db, trades)
	insertTradeHistory(db, trades)

}
