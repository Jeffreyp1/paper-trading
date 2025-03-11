package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"trading-service/db"
	"trading-service/redis"
)

// type TradeRequest struct {
// 	UserID int    `json:"user_id"`
// 	Action string `json:"action"`
// 	Stock  []struct {
// 		Symbol   string  `json:"symbol"`
// 		Quantity float64 `json:"quantity"`
// 	} `json:"stock"`
// }

func executeBuy(tx *sql.Tx, ctx context.Context, userId int, priceMap map[string]float64, stockData TradeRequest, totalCost float64) error {
	_, err := tx.ExecContext(ctx, "Update USERS SET balance = balance - $1 WHERE id = $2", totalCost, userId)
	if err != nil {
		return fmt.Errorf("error updating user: %w", err)
	}
	var trades []string
	var positions []string
	var args []interface{}
	for _, stock := range stockData.Stock {
		price := priceMap[stock.Symbol]

		trades = append(trades, fmt.Sprintf("($%d, $%d, $%d, $%d, 'BUY')", len(args)+1, len(args)+2, len(args)+3, len(args)+4))
		positions = append(positions, fmt.Sprintf("($%d, $%d, $%d, $%d)", len(args)+1, len(args)+2, len(args)+3, len(args)+4))
		args = append(args, userId, stock.Symbol, stock.Quantity, price)
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
		return fmt.Errorf("failed to insert trades")
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
		return fmt.Errorf(("failed to insert/update positions"))
	}
	return nil
}
func handleTrade(response http.ResponseWriter, request *http.Request) {
	start := time.Now()
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

	tx, err := db.DB.BeginTx(ctx, nil)
	if err != nil {
		http.Error(response, "Database error: ", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()
	stockSymbol := make([]string, 0, len(tradeData.Stock)) // Preallocate memory
	for _, stock := range tradeData.Stock {
		stockSymbol = append(stockSymbol, stock.Symbol)
	}
	userId := tradeData.UserID
	if strings.ToLower((tradeData.Action)) == "buy" {
		err := tx.QueryRow("SELECT balance from users WHERE id = $1 FOR UPDATE", tradeData.UserID).Scan(&balance)
		if err != nil {
			http.Error(response, "User not found or error retrieving data", http.StatusBadRequest)
		}
		// prices, err := redisClient.HGet(ctx, "stockPrices", "META").Result()

		// fmt.Println("Balance", balance)
		priceMap := make(map[string]float64)
		if len(stockSymbol) <= 50 {
			prices, err := redis.RedisClient.HMGet(ctx, "stockPrices", stockSymbol...).Result()
			if err != nil {
				fmt.Println("Error fetching stock prices")
			}

			for i, symbol := range stockSymbol {
				price, _ := strconv.ParseFloat(prices[i].(string), 64)
				priceMap[symbol] = price
			}
		}
		// if len(stockSymbol) <= 25 {
		// 	for _, symbol := range stockSymbol {
		// 		priceStr, err := redis.RedisClient.HGet(ctx, "stockPrices", symbol).Result()
		// 		if err != nil {
		// 			fmt.Println("Error fetching stock price for: ", symbol)
		// 		}
		// 		price, _ := strconv.ParseFloat(priceStr, 64)
		// 		priceMap[symbol] = price
		// 	}
		// } else if len(stockSymbol) <= 50 {
		// 	prices, err := redis.RedisClient.HMGet(ctx, "stockPrices", stockSymbol...).Result()
		// 	if err != nil {
		// 		fmt.Println("Error fetching stock prices")
		// 	}

		// 	for i, symbol := range stockSymbol {
		// 		price, _ := strconv.ParseFloat(prices[i].(string), 64)
		// 		priceMap[symbol] = price
		// 	}
		// } else {
		// 	pricesMap, err := redis.RedisClient.HGetAll(ctx, "stockPrices").Result()
		// 	if err != nil {
		// 		fmt.Println("Error fetching all stock prices")
		// 	}
		// 	for symbol, priceStr := range pricesMap {
		// 		price, _ := strconv.ParseFloat(priceStr, 64)
		// 		priceMap[symbol] = price
		// 	}
		// }
		var totalCost float64
		for _, stock := range tradeData.Stock {
			totalCost += priceMap[stock.Symbol] * stock.Quantity
		}
		// fmt.Println("totalCost: ", totalCost)
		if totalCost < balance {
			success := executeBuy(tx, ctx, userId, priceMap, tradeData, totalCost)
			if success != nil {
				fmt.Println("FAILED TO RUN ", success)
			}
			commit := tx.Commit()
			if commit != nil {
				fmt.Println("commit failed")
			}
			fmt.Println("Commit success!")
			elapsed := time.Since(start)
			fmt.Println("Execution time:", elapsed)
		}

	}

}

//
