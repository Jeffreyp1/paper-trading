package workers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"trading-service/pkg/redisClient"

	"github.com/redis/go-redis/v9"
)

type SQLJob struct {
	UserID  int
	Action  string
	Balance float64
	Stock   string // Serialized JSON of stocks
}

var (
	SqlMutex          sync.Mutex
	SuccessfulInserts int64
	FailedInserts     int64
	TotalSQLTime      time.Duration
)

var ProcessedTrades int64

func addToSQL(db *sql.DB, userId int, action string, balance float64, stocks []struct {
	Symbol   string  `json:"symbol"`
	Quantity float64 `json:"quantity"`
	Price    float64 `json:"price"`
}) error {
	// startSQL := time.Now()

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	var trades []string
	var positions []string
	var args []interface{}
	for _, stock := range stocks {
		trades = append(trades, fmt.Sprintf(" ($%d, $%d, $%d, $%d, 'BUY') ", len(args)+1, len(args)+2, len(args)+3, len(args)+4))
		positions = append(positions, fmt.Sprintf("($%d, $%d, $%d, $%d)", len(args)+1, len(args)+2, len(args)+3, len(args)+4))
		args = append(args, userId, stock.Symbol, stock.Quantity, stock.Price)
	}
	if len(trades) == 0 {
		return fmt.Errorf("no valid inserts")
	}
	if len(positions) == 0 {
		return fmt.Errorf("no valid position to insert")
	}
	insert_trades := fmt.Sprintf(`
		INSERT INTO trades (user_id, symbol, quantity, executed_price, trade_type)
		VALUES %s`, strings.Join(trades, ", "))
	_, err = tx.ExecContext(ctx, insert_trades, args...)
	if err != nil {
		tx.Rollback()
		return err
	}

	insert_update_positions := fmt.Sprintf(
		`Insert INTO positions (user_id, symbol, quantity, average_price)
		VALUES %s
		ON CONFLICT(user_id, symbol)
	    DO UPDATE SET
	        quantity = positions.quantity + EXCLUDED.quantity,
	        average_price = ((positions.quantity * positions.average_price) + (EXCLUDED.quantity * EXCLUDED.average_price))/ (positions.quantity + EXCLUDED.quantity),
	        updated_at = CURRENT_TIMESTAMP;`, strings.Join(positions, ", "))
	_, err = tx.ExecContext(ctx, insert_update_positions, args...)
	if err != nil {
		tx.Rollback()
		fmt.Printf("Failed to insert/update positions: %v\n", err) // Log exact failure
		return err
	}
	err = tx.Commit()

	// ⏱ End timing: measure duration
	// elapsed := time.Since(startSQL)

	// Thread‐safe update of SQL counters
	// SqlMutex.Lock()
	// if err != nil {
	// 	FailedInserts++
	// } else {
	// 	SuccessfulInserts++
	// 	TotalSQLTime += elapsed
	// }
	// SqlMutex.Unlock()

	return err
}
func processTrade(workerId int, db *sql.DB) {
	for {
		// log.Printf("📥 Worker %d attempting to read from `buy_stream`...", workerId)
		messages, err := redisClient.Client.XReadGroup(context.Background(), &redis.XReadGroupArgs{
			Group:    "sql_workers",
			Consumer: fmt.Sprintf("worker-%d", workerId),
			Streams:  []string{"buy_stream", ">"},
			Count:    10,
			Block:    0,
		}).Result()
		// log.Printf("reading message now!")
		if err != nil {
			log.Println("Error reading from Redis Stream: ", err)
			break
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
			err = addToSQL(db, userId, action, balance, stocks)
			if err != nil {
				log.Println("Error processing to SQL: ", err)
				continue
			}
			_, err = redisClient.Client.XAck(context.Background(), "buy_stream", "sql_workers", jobID).Result()
			if err != nil {
				log.Println("Error acknowledging job: ", err)
			} else {
				_, trimErr := redisClient.Client.XTrimMinID(context.Background(), "buy_stream", jobID).Result()
				if trimErr != nil {
					log.Println("❌ Error trimming Redis stream:", trimErr)
				}
				// log.Printf("Trade %s acknowledged", jobID)
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
func StartSQLWorkerPool(workerCount int, db *sql.DB) {
	var wg sync.WaitGroup

	for i := 1; i <= workerCount; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			processTrade(id, db)
		}(i)
	}

	wg.Wait()

}
