package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"trading-service/db"
	"trading-service/redis"
)

type TradeRequest struct {
	UserID int    `json:"user_id"`
	Action string `json:"action"`
	Stock  []struct {
		Symbol   string  `json:"symbol"`
		Quantity float64 `json:"quantity"`
	} `json:"stock"`
}

func executeBuy() {
	fmt.Println("Executing buy!")
}
func handleTrade(response http.ResponseWriter, request *http.Request) {
	ctx := context.Background()
	var tradeData TradeRequest
	var balance float64
	//r.Body is parsed and is being rewritten as req
	err := json.NewDecoder(request.Body).Decode(&tradeData)
	if err != nil {
		// responds to w or response that request is invalid
		http.Error(response, "Invalid request", http.StatusBadRequest)
		return
	}

	tx, err := db.DB.Begin()
	if err != nil {
		http.Error(response, "Database error: ", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()
	stockSymbol := make([]string, 0, len(tradeData.Stock)) // Preallocate memory
	for _, stock := range tradeData.Stock {
		stockSymbol = append(stockSymbol, stock.Symbol)
	}
	if strings.ToLower((tradeData.Action)) == "buy" {
		err := tx.QueryRow("SELECT balance from users WHERE id = $1 FOR UPDATE", tradeData.UserID).Scan(&balance)
		if err != nil {
			http.Error(response, "User not found or error retrieving data", http.StatusBadRequest)
		}
		// prices, err := redisClient.HGet(ctx, "stockPrices", "META").Result()

		fmt.Println("Balance", balance)
		priceMap := make(map[string]float64)

		if len(stockSymbol) <= 25 {
			for _, symbol := range stockSymbol {
				priceStr, err := redis.RedisClient.HGet(ctx, "stockPrices", symbol).Result()
				if err != nil {
					fmt.Println("Error fetching stock price for: ", symbol)
				}
				price, _ := strconv.ParseFloat(priceStr, 64)
				priceMap[symbol] = price
			}
		} else if len(stockSymbol) <= 50 {
			prices, err := redis.RedisClient.HMGet(ctx, "stockPrices", stockSymbol...).Result()
			if err != nil {
				fmt.Println("Error fetching stock prices")
			}

			for i, symbol := range stockSymbol {
				price, _ := strconv.ParseFloat(prices[i].(string), 64)
				priceMap[symbol] = price
			}
		} else {
			pricesMap, err := redis.RedisClient.HGetAll(ctx, "stockPrices").Result()
			if err != nil {
				fmt.Println("Error fetching all stock prices")
			}
			for symbol, priceStr := range pricesMap {
				price, _ := strconv.ParseFloat(priceStr, 64)
				priceMap[symbol] = price
			}
		}
		var totalCost float64
		for _, stock := range tradeData.Stock {
			totalCost += priceMap[stock.Symbol] * stock.Quantity
		}
		fmt.Println("totalCost: ", totalCost)
		if totalCost < balance {
			executeBuy()
		}
		fmt.Println("QUantity * price", totalCost, balance)

	}

}

//
