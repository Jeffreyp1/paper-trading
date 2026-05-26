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
	"trading-service/db"
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
	batchSize     = 2000
	batchTimeout  = 50 * time.Millisecond
	consumerTopic = "trade_events"
)

func processKafka(workerId int, db *sql.DB) error {
	r, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers":  "localhost:9092",
		"group.id":           "postgres-writer",
		"auto.offset.reset":  "earliest",
		"enable.auto.commit": false,
	})
	if err != nil {
		log.Fatalf("Failed to create Kafka Consumer: %v", err)
	}
	err = r.SubscribeTopics([]string{consumerTopic}, nil)
	if err != nil {
		log.Fatalf("Subscription Error: %v", err)
	}
	var batch []Trade
	var lastMsg *kafka.Message
	ticker := time.NewTicker(batchTimeout)
	defer ticker.Stop()

	flush := func() {
		if len(batch) == 0 {
			return
		}
		if err := upsertBalancePositionsAndTradeHistory(db, batch); err != nil {
			// Do NOT commit Kafka offsets on PG failure. The broker still
			// owns these offsets, so they will be re-delivered on next poll.
			log.Printf("❌ PG batch flush failed (worker %d): %v — dropping in-memory batch; Kafka will redeliver", workerId, err)
			batch = nil
			lastMsg = nil
			return
		}
		if lastMsg != nil {
			if _, cerr := r.CommitMessage(lastMsg); cerr != nil {
				log.Printf("⚠️ CommitMessage failed (worker %d): %v", workerId, cerr)
			}
		}
		batch = nil
		lastMsg = nil
	}

	for {
		event, err := r.ReadMessage(100 * time.Millisecond)
		if err == nil {
			var t Trade
			if err := json.Unmarshal(event.Value, &t); err != nil {
				continue
			}
			batch = append(batch, t)
			lastMsg = event

			if len(batch) >= batchSize {
				flush()
			}
		}

		// flush on tick, only if there's something
		select {
		case <-ticker.C:
			if len(batch) > 0 {
				flush()
			}
		default:
			// nothing to do
		}
	}
}

func upsertBalancePositionsAndTradeHistory(db *sql.DB, trades []Trade) error {
	if len(trades) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}

	// Balance: keep the LAST (highest-offset) balance per user_id.
	// Iterate trades in order (Kafka delivers in-order within a partition)
	// and overwrite — final value for each user wins.
	balanceByUser := make(map[int]float64)
	// Preserve first-seen order for deterministic emit.
	var balanceOrder []int
	for _, trade := range trades {
		if _, ok := balanceByUser[trade.UserID]; !ok {
			balanceOrder = append(balanceOrder, trade.UserID)
		}
		balanceByUser[trade.UserID] = trade.Balance
	}

	var insert_trades []string
	var trade_args []interface{}
	var (
		statement    strings.Builder
		whereIn      []string
		balance_args []interface{}
	)

	// Emit one CASE branch per user using the LAST balance value.
	for i, uid := range balanceOrder {
		pos := i*2 + 1
		statement.WriteString(fmt.Sprintf("When id = $%d THEN $%d ", pos, pos+1))
		whereIn = append(whereIn, fmt.Sprintf("$%d", pos))
		balance_args = append(balance_args, uid, balanceByUser[uid])
	}

	// Trades table: one row per (trade, stock) — every execution is its own row.
	for _, trade := range trades {
		for _, stock := range trade.Stocks {
			pos := len(trade_args) + 1
			insert_trades = append(insert_trades, fmt.Sprintf(" ($%d, $%d, $%d, $%d, 'BUY') ", pos, pos+1, pos+2, pos+3))
			trade_args = append(trade_args, trade.UserID, stock.Symbol, stock.Quantity, stock.Price)
		}
	}

	// Positions: pre-aggregate by (user_id, symbol) within the batch so the
	// INSERT...ON CONFLICT statement never sees a duplicate conflict target
	// (Postgres rejects "command cannot affect row a second time" otherwise).
	// Quantity sums; average_price is the weighted average of all entries
	// in this batch (same formula the ON CONFLICT clause uses to merge with
	// the existing row).
	type posKey struct {
		userID int
		symbol string
	}
	type posAgg struct {
		qty    float64
		notional float64 // sum of qty * price; divide at the end
	}
	agg := make(map[posKey]*posAgg)
	var posOrder []posKey // deterministic emit order
	for _, trade := range trades {
		for _, stock := range trade.Stocks {
			k := posKey{trade.UserID, stock.Symbol}
			a, ok := agg[k]
			if !ok {
				a = &posAgg{}
				agg[k] = a
				posOrder = append(posOrder, k)
			}
			a.qty += stock.Quantity
			a.notional += stock.Quantity * stock.Price
		}
	}

	var positions []string
	var position_args []interface{}
	for _, k := range posOrder {
		a := agg[k]
		avg := 0.0
		if a.qty > 0 {
			avg = a.notional / a.qty
		}
		pos := len(position_args) + 1
		positions = append(positions, fmt.Sprintf("($%d, $%d, $%d, $%d)", pos, pos+1, pos+2, pos+3))
		position_args = append(position_args, k.userID, k.symbol, a.qty, avg)
	}

	if len(insert_trades) == 0 || len(positions) == 0 {
		tx.Rollback()
		return fmt.Errorf("no valid inserts/upserts")
	}
	final_trades := fmt.Sprintf(`
		INSERT INTO trades (user_id, symbol, quantity, executed_price, trade_type)
		VALUES %s`, strings.Join(insert_trades, ", "))

	insert_update_positions := fmt.Sprintf(
		`INSERT INTO positions (user_id, symbol, quantity, average_price)
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
	_, err = tx.ExecContext(ctx, final_trades, trade_args...)
	if err != nil {
		tx.Rollback()
		return err
	}
	_, err = tx.ExecContext(ctx, insert_update_positions, position_args...)
	if err != nil {
		tx.Rollback()
		return err
	}
	_, err = tx.ExecContext(ctx, query, balance_args...)
	if err != nil {
		tx.Rollback()
		fmt.Printf("Failed to update balances: %v\n", err)
		return err
	}
	err = tx.Commit()
	if err != nil {
		log.Printf("Transaction commit failed: %v\n", err)
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

func getExecutedTradeCountFromDB() int {
	row := db.DB.QueryRow("SELECT COUNT(*) FROM trades")
	var count int
	if err := row.Scan(&count); err != nil {
		log.Printf("❌ Failed to count trades in DB: %v", err)
		return -1
	}
	return count
}
