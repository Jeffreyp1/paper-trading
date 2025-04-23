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

func ExecuteBuy(ctx context.Context, trade TradeRequest, balance float64, totalCost float64) {
	stockJSON, err := json.Marshal(trade.Stock)
	if err != nil {
		log.Fatalf("Failed to serialize stock data: %v", err)
		return
	}
	pipeline := redisClient.Client.TxPipeline()
	pipeline.HSet(ctx, "user_balance", fmt.Sprint(trade.UserID), balance-totalCost)
	_, err = pipeline.XAdd(ctx, &redis.XAddArgs{
		Stream: "buy_stream",
		Values: map[string]interface{}{
			"user_id": trade.UserID,
			"action":  trade.Action,
			"balance": balance - totalCost,
			"stocks":  string(stockJSON),
		},
	}).Result()
	if err != nil {
		log.Fatalf("Failed to push trade to Redis Stream: %v", err)
		redisClient.Client.HSet(ctx, "user_balance", fmt.Sprint(trade.UserID), balance)
		return
	} 
	_, err = pipeline.Exec(ctx)
	if err != nil {
		log.Fatalf("Failed to execute pipeline: %v", err)
	}
	// log.Println("✅ Trade successfully added to Redis Stream!")
}
