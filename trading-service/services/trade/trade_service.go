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

func executeBuy(ctx context.Context, userId int, stockData TradeRequest, totalCost float64, balance float64, stockSymbol []string) error {
	pipeline := redisClient.Client.TxPipeline()
	//balance rollback
	pipeline.SAdd(ctx, "queue_user", userId)
	rollbackbalanceKey := fmt.Sprintf("rollback:balance:%d", userId)
	pipeline.HSet(ctx, rollbackbalanceKey, "balance", balance)
	//balance updating
	newBalance := balance - totalCost
	pipeline.HSet(ctx, "user_balance", fmt.Sprint(userId), newBalance)
	//positionsrollback
	rollBackKey := fmt.Sprintf("rollback:position:%d", userId)
	userPositions, _ := redisClient.Client.HMGet(ctx, fmt.Sprintf("positions:%d", userId), stockSymbol...).Result()
	fmt.Println("userPositions:", userPositions)
	fmt.Println("Symbols: ", stockSymbol)
	rollbackData := make(map[string]interface{})
	for i, position := range userPositions {
		quantity_and_average := strings.Split(position.(string), ",")
		curr_quantity, _ := strconv.Atoi(quantity_and_average[0])
		curr_avg_price, _ := strconv.ParseFloat(quantity_and_average[1], 64)
		rollbackData[stockSymbol[i]] = fmt.Sprintf("%d,%.2f", curr_quantity, curr_avg_price)
	}
	pipeline.HMSet(ctx, rollBackKey, rollbackData)

	//positions update
	key := fmt.Sprintf("positions:%d", userId)
	positionsData := make(map[string]interface{})
	// tradeData := []interface{}{}
	for i, stock := range stockData.Stock {
		var updated_quantity int
		var updated_average_price float64
		temp, _ := redis.GetStockPrice(stock.Symbol)
		curr_price := temp.Price
		if userPositions[i] != nil {
			quantity_and_average := strings.Split(userPositions[i].(string), ",")
			curr_quantity, _ := strconv.Atoi(quantity_and_average[0])
			curr_avg_price, _ := strconv.ParseFloat(quantity_and_average[1], 64)
			updated_quantity = int(stock.Quantity) + curr_quantity
			updated_average_price = ((float64(curr_quantity) * curr_avg_price) + (float64(updated_quantity) * curr_price)) / (float64(updated_quantity) + float64(curr_quantity))
		} else {
			updated_quantity = int(stock.Quantity)
			updated_average_price = temp.Price
		}

		positionsData[stock.Symbol] = fmt.Sprintf("%d,%.2f", updated_quantity, updated_average_price)
	}
	pipeline.HMSet(ctx, key, positionsData)
	_, err := pipeline.Exec(ctx)
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
			return fmt.Errorf(("failed to restore"))
		}
	}
	return nil
}
func HandleTrade(response http.ResponseWriter, request *http.Request) {
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
	var stockSymbol []string
	for _, stock := range tradeData.Stock {
		stockSymbol = append(stockSymbol, stock.Symbol)
	}
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
		if totalCost < balance {
			success := executeBuy(ctx, userId, tradeData, totalCost, balance, stockSymbol)
			if success != nil {
				fmt.Println("FAILED TO RUN ", success)
				return
			}
		} else {
			http.Error(response, "Insufficient funds", http.StatusForbidden)
			return
		}

	}
	response.WriteHeader(http.StatusOK)
	response.Write([]byte(`{"message": "Trade executed successfully"}`))

}

//
