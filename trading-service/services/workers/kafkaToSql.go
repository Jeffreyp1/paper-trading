package workers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
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
	batchSize     = 1000
	batchTimeout  = 1 * time.Second
	consumerTopic = "trade_events"
)

func processKafka(workerId int, db *sql.DB) error {
	r, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers": "localhost:9092",
		"group.id":          "postgres-writer",
		"auto.offset.reset": "earliest",
		"enable.auto.commit": true,
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
	// Before the for loop:
	seenUsers := make(map[int]bool)

	for {
		event, err := r.ReadMessage(100 * time.Millisecond)
		// log.Printf("✅ Kafka Message: %s", string(event))
		if err == nil {
			var t Trade
			if err := json.Unmarshal(event.Value, &t); err != nil {
				continue
			}
			if seenUsers[t.UserID] {
				log.Printf("Skipping user %d (already in batch)", t.UserID)
				continue
			}
			seenUsers[t.UserID] = true
			batch = append(batch, t)

			if len(batch) >= batchSize {
				insertBatchToPostgres(db, batch)
				batch = nil
				seenUsers = make(map[int]bool)
			}
		}

		// flush once per second, only if there's something
		select {
		case <-ticker.C:
			if len(batch) > 0 {
				insertBatchToPostgres(db, batch)
				batch = nil
				seenUsers = make(map[int]bool)
			}
		default:
			// nothing to do
		}
	}

	// for {
	// 	select {
	// 	case <-ticker.C:
	// 		if len(batch) > 0 {
	// 			insertBatchToPostgres(db, batch)
	// 			batch = nil
	// 		}
	// 	default:
	// 		event, err := r.ReadMessage(10 * time.Millisecond)
	// 		if err != nil {
	// 			continue
	// 		}
	// 		var trade Trade
	// 		// log.Printf("🔥 RAW Kafka payload: %s", string(event.Value))
	// 		err = json.Unmarshal(event.Value, &trade)
	// 		if err != nil {
	// 			log.Println("Invalid Trade Payload", err)
	// 			continue
	// 		}

	// 		batch = append(batch, trade)

	// 		if len(batch) >= batchSize {
	// 			err := insertBatchToPostgres(db, batch)
	// 			if err != nil {
	// 				log.Printf("Failed to insert Batch %v, err")
	// 			}
	// 			batch = nil
	// 		}

	// 	}

	// }
}
func upsertBalancePositionsAndTradeHistory(db *sql.DB, trades []Trade) error {
	fmt.Printf("Starting")
	if len(trades) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	var insert_trades []string
	var positions []string
	var args []interface{}
	var (
		statement    strings.Builder
		whereIn      []string
		balance_args []interface{}
	)
	for i, trade := range trades {
		pos := i*2 + 1
		statement.WriteString(fmt.Sprintf("When id = $%d THEN $%d ", pos, pos+1))
		whereIn = append(whereIn, fmt.Sprintf("$%d", pos))
		balance_args = append(balance_args, trade.UserID, trade.Balance)
		for _, stock := range trade.Stocks {
			pos = len(args) + 1
			insert_trades = append(insert_trades, fmt.Sprintf(" ($%d, $%d, $%d, $%d, 'BUY') ", pos, pos+1, pos+2, pos+3))
			positions = append(positions, fmt.Sprintf("($%d, $%d, $%d, $%d)", pos, pos+1, pos+2, pos+3))
			args = append(args, trade.UserID, stock.Symbol, stock.Quantity, stock.Price)
		}
	}
	if len(insert_trades) == 0 || len(positions) == 0 {
		return fmt.Errorf("no valid inserts/upserts")
	}
	final_trades := fmt.Sprintf(`
		INSERT INTO trades (user_id, symbol, quantity, executed_price, trade_type)
		VALUES %s`, strings.Join(insert_trades, ", "))

	insert_update_positions := fmt.Sprintf(
		`Insert INTO positions (user_id, symbol, quantity, average_price)
		VALUES %s
		ON CONFLICT(user_id, symbol)
		DO UPDATE SET
			quantity = positions.quantity + EXCLUDED.quantity,
			average_price = ((positions.quantity * positions.average_price) + (EXCLUDED.quantity * EXCLUDED.average_price))/ (positions.quantity + EXCLUDED.quantity),
			updated_at = CURRENT_TIMESTAMP;`, strings.Join(positions, ", "))
	query := fmt.Sprintf(`
			UPDATE users
			SET balance = CASE
				%s
				ELSE balance
			END
			WHERE id IN (%s)
		`, statement.String(), strings.Join(whereIn, ","))
	_, err = tx.ExecContext(ctx, final_trades, args...)
	if err != nil {
		tx.Rollback()
		return err
	}
	_, err = tx.ExecContext(ctx, insert_update_positions, args...)
	if err != nil {
		tx.Rollback()
		return err
	}
	_, err = tx.ExecContext(ctx, query, balance_args...)
	if err != nil {
		tx.Rollback()
		fmt.Printf("Failed to insert/update positions: %v\n", err) // Log exact failure
		return err
	}
	err = tx.Commit()
	if err != nil {
		tx.Rollback()
		log.Printf("Transaction cimmit failed: %v\n", err)
		return err
	}
	return nil
}
func insertBatchToPostgres(db *sql.DB, trades []Trade) error {
	err := upsertBalancePositionsAndTradeHistory(db, trades)
	if err != nil {
		log.Printf("Error upserting balance, positions, and trade history %v", err)
		return err
	}
	return nil

}
func StartKafkaConsumer(workerCount int, db *sql.DB) {
	for i := 1; i <= workerCount; i++ {
		go func(id int) {
			processKafka(id, db)
		}(i)
	}
}

// func updateBalances(db *sql.DB, trades []Trade) error {
// 	if len(trades) == 0 {
// 		return nil
// 	}
// 	var (
// 		statement strings.Builder
// 		whereIn   []string
// 		args      []interface{}
// 	)
// 	for i, trade := range trades {
// 		pos := i*2 + 1
// 		statement.WriteString(fmt.Sprintf("When id = $%d THEN $%d ", pos, pos+1))
// 		whereIn = append(whereIn, fmt.Sprintf("$%d", pos))
// 		args = append(args, trade.UserID, trade.Balance)

// 	}

// 	query := fmt.Sprintf(`
// 		UPDATE users
// 		SET balance = CASE
// 			%s
// 			ELSE balance
// 		END
// 		WHERE id IN (%s)
// 	`, statement.String(), strings.Join(whereIn, ","))

// 	_, err := db.Exec(query, args...)
// 	return err
// }
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
