package trade_service

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"

	"trading-service/pkg/redisClient"
	redisStorage "trading-service/redis"

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

func executeBuy(ctx context.Context, trade TradeRequest, balance float64, totalCost float64) {
	// ✅ Convert stock slice to JSON
	stockJSON, err := json.Marshal(trade.Stock)
	if err != nil {
		log.Fatalf("Failed to serialize stock data: %v", err)
		return
	}

	// ✅ Push to Redis Stream
	// fmt.Println(trade.Stock)
	pipeline := redisClient.Client.TxPipeline()
	pipeline.HSet(ctx, "user_balance", fmt.Sprint(trade.UserID), balance-totalCost)
	stock, err := pipeline.XAdd(ctx, &redis.XAddArgs{
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
	} else {
		fmt.Println(stock)
	}
	_, err = pipeline.Exec(ctx)
	if err != nil {
		log.Fatalf("Failed to execute pipeline: %v", err)
	}
	log.Println("✅ Trade successfully added to Redis Stream!")
}

func HandleTrade(response http.ResponseWriter, request *http.Request) {
	ctx := context.Background()
	var tradeData TradeRequest
	defer request.Body.Close()
	err := json.NewDecoder(request.Body).Decode(&tradeData)
	if err != nil {
		http.Error(response, "Invalid request", http.StatusBadRequest)
		return
	}
	userId := tradeData.UserID
	if strings.ToLower((tradeData.Action)) == "buy" {
		balanceStr, err := redisClient.Client.HGet(ctx, "user_balance", fmt.Sprint(userId)).Result()
		balance, err := strconv.ParseFloat(balanceStr, 64)
		if err != nil {
			http.Error(response, "User not found or balance", http.StatusBadRequest)
		}
		var totalCost float64
		for i, stock := range tradeData.Stock {
			stockPrice, err := redisStorage.GetStockPrice(stock.Symbol)
			if err != nil {
				log.Printf("Failed to fetch price")
			} else {
				tradeData.Stock[i].Price = stockPrice.Price
			}
			totalCost += stockPrice.Price * stock.Quantity
		}
		if totalCost < balance {
			executeBuy(ctx, tradeData, balance, totalCost)
			// if success != nil {
			// 	fmt.Println("FAILED TO RUN ", success)
			// 	return
			// }
		} else {
			http.Error(response, "Insufficient funds", http.StatusForbidden)
			return
		}

	}
	response.WriteHeader(http.StatusOK)
	response.Write([]byte(`{"message": "Trade executed successfully"}`))

}

//
