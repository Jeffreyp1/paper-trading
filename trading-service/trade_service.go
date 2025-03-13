package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"

	"trading-service/db"
	"trading-service/pkg/redisClient"
	"trading-service/redis"
)

//	type TradeRequest struct {
//		UserID int    `json:"user_id"`
//		Action string `json:"action"`
//		Stock  []struct {
//			Symbol   string  `json:"symbol"`
//			Quantity float64 `json:"quantity"`
//		} `json:"stock"`
//	}
func executeBuy(tx *sql.Tx, ctx context.Context, userId int, stockData TradeRequest, totalCost float64, balance float64) error {
	pipeline := redisClient.Client.TxPipeline()
	//balance rollback
	rollbackbalanceKey := fmt.Sprintf("rollback:balance:%d", userId)
	err := pipeline.HSet(ctx, rollbackbalanceKey, "balance", balance).Err()
	if err != nil {
		return fmt.Errorf("failed to store_ balance")
	}
	//balance updating
	newBalance := balance - totalCost
	err = pipeline.HSet(ctx, "user_balance", fmt.Sprint(userId), newBalance).Err()
	if err != nil {
		return fmt.Errorf("failed to store balance")
	}
	//positionsrollback
	rollBackKey := fmt.Sprintf("rollback:position:%d", userId)
	userPositions, err := redisClient.Client.HGetAll(ctx, fmt.Sprintf("positions:%d", userId)).Result()
	for stockSymbol, position := range userPositions {
		var curr_quantity int
		var curr_avg_price float64
		fmt.Sscanf(position, "%d,%f", &curr_quantity, &curr_avg_price)
		pipeline.HSet(ctx, rollBackKey, stockSymbol, fmt.Sprintf("%d,%.2f", curr_quantity, curr_avg_price))
	}
	if err != nil {
		log.Printf("Error fetching user positions: %v", err)
		return err
	}
	//positions update
	key := fmt.Sprintf("positions:%d", userId)
	for _, stock := range stockData.Stock {
		existingValue, exists := userPositions[stock.Symbol]

		var updated_quantity int
		var updated_average_price float64
		temp, _ := redis.GetStockPrice(stock.Symbol)
		curr_price := temp.Price
		if exists {
			var curr_quantity int
			var curr_avg_price float64

			fmt.Sscanf(existingValue, "%d,%f", &curr_quantity, &curr_avg_price)
			updated_quantity = int(stock.Quantity) + curr_quantity
			updated_average_price = ((float64(curr_quantity) * curr_avg_price) + (float64(updated_quantity) * curr_price)) / (float64(updated_quantity) + float64(curr_quantity))
		} else {
			updated_quantity = int(stock.Quantity)
		}
		err := pipeline.HSet(ctx, key, stock.Symbol, fmt.Sprintf("%d,%.2f", stock.Quantity, updated_average_price))
		if err != nil {
			return fmt.Errorf("Failed to save positions to redis")
		}
	}
	//rollback
	_, err = pipeline.Exec(ctx)
	if err != nil {
		restorePipeline := redisClient.Client.TxPipeline()
		rollbackBalance, err := redisClient.Client.HGet(ctx, rollbackbalanceKey, "balance").Result()
		if err != nil {
			log.Printf("Failed to fetch rollback balance %v", err)
		}
		restorePipeline.HSet(ctx, "user_balance", fmt.Sprint(userId), rollbackBalance)

		rollbackPositions, err := redisClient.Client.HGetAll(ctx, rollBackKey).Result()
		if err != nil {
			return fmt.Errorf("failed to rollback positions")
		}
		for stockSymbol, position := range rollbackPositions {
			var curr_quantity int
			var curr_avg_price float64
			fmt.Sscanf(position, "%d,%f", &curr_quantity, &curr_avg_price)
			restorePipeline.HSet(ctx, key, stockSymbol, fmt.Sprintf("%d,%.2f", curr_quantity, curr_avg_price))

		}

		_, err = restorePipeline.Exec(ctx)
		if err != nil {
			return fmt.Errorf(("Failed to restore"))
		}
	}
	return nil
}
func handleTrade(response http.ResponseWriter, request *http.Request) {
	// start := time.Now()
	ctx := context.Background()
	var tradeData TradeRequest
	defer request.Body.Close()
	//r.Body is parsed and is being rewritten as req
	err := json.NewDecoder(request.Body).Decode(&tradeData)
	if err != nil {
		http.Error(response, "Invalid request", http.StatusBadRequest)
		return
	}

	tx, err := db.DB.BeginTx(ctx, nil)
	if err != nil {
		http.Error(response, "Database error: ", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()
	// stockSymbol := make([]string, 0, len(tradeData.Stock)) // Preallocate memory
	// for _, stock := range tradeData.Stock {
	// 	stockSymbol = append(stockSymbol, stock.Symbol)
	// }
	userId := tradeData.UserID
	if strings.ToLower((tradeData.Action)) == "buy" {
		balanceStr, err := redisClient.Client.HGet(ctx, "user_balance", fmt.Sprint(userId)).Result()
		balance, err := strconv.ParseFloat(balanceStr, 64)
		if err != nil {
			http.Error(response, "User not found or balance", http.StatusBadRequest)
		}
		var totalCost float64
		for _, stock := range tradeData.Stock {
			stockPrice, _ := redis.GetStockPrice(stock.Symbol)
			totalCost += stockPrice.Price * stock.Quantity
		}
		// fmt.Println("totalCost: ", totalCost)
		if totalCost < balance {
			success := executeBuy(tx, ctx, userId, tradeData, totalCost, balance)
			if success != nil {
				fmt.Println("FAILED TO RUN ", success)
				return
			}
			commit := tx.Commit()
			if commit != nil {
				fmt.Println("commit failed")
				return
			}
			// fmt.Println("Commit success!")
			// elapsed := time.Since(start)
			// fmt.Println("Execution time:", elapsed)
		} else {
			http.Error(response, "Insufficient funds", http.StatusForbidden)
			return
		}

	}
	response.WriteHeader(http.StatusOK)
	response.Write([]byte(`{"message": "Trade executed successfully"}`))

}

//
