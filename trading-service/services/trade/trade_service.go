package trade_service

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"trading-service/pkg/redisClient"

	"github.com/redis/go-redis/v9"
)

type StockData struct {
	Symbol string  `json:"symbol"`
	Price  float64 `json:"price"`
}

type TradeRequest struct {
	UserID int    `json:"user_id"`
	Action string `json:"action"`
	Stock  []struct {
		Symbol   string  `json:"symbol"`
		Quantity float64 `json:"quantity"`
		Price    float64 `json:"price"`
	} `json:"stock"`
}

// ExecuteBuy now returns an error instead of log.Fatalf-ing on Redis hiccups.
// A transient Redis timeout used to kill the entire service; now the caller
// can log and skip the trade. The Redis Stream queue will pick up next time.
func ExecuteBuy(ctx context.Context, trade TradeRequest, balance float64, totalCost float64) error {
	stockJSON, err := json.Marshal(trade.Stock)
	if err != nil {
		return fmt.Errorf("serialize stock data: %w", err)
	}
	pipeline := redisClient.Client.TxPipeline()
	pipeline.HSet(ctx, "user_balance", fmt.Sprint(trade.UserID), balance-totalCost)
	pipeline.XAdd(ctx, &redis.XAddArgs{
		Stream: "buy_stream",
		Values: map[string]interface{}{
			"user_id": trade.UserID,
			"action":  trade.Action,
			"balance": balance - totalCost,
			"stocks":  string(stockJSON),
		},
	})
	if _, err = pipeline.Exec(ctx); err != nil {
		// Best-effort rollback of the balance write that may have partially landed.
		// Use a fresh context so this doesn't fail too if `ctx` was the cause.
		redisClient.Client.HSet(context.Background(), "user_balance", fmt.Sprint(trade.UserID), balance)
		return fmt.Errorf("redis pipeline exec: %w", err)
	}
	return nil
}

// keep import of log to avoid editing other files; suppress unused-import if needed
var _ = log.Printf
