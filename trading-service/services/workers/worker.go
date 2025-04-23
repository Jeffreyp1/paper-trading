package workers

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"sync"

	"trading-service/pkg/redisClient"
	redisStorage "trading-service/redis"
	trade_service "trading-service/services/trade"
)

type TradeJob struct {
	Trade trade_service.TradeRequest
}
var TradeJobQueue = make(chan TradeJob, 10000)

func TradeWorker(id int, jobs <-chan TradeJob, wg *sync.WaitGroup) {
	defer wg.Done()

	for job := range jobs {
		ctx := context.Background()
		tradeData := job.Trade

		balanceStr, err := redisClient.Client.HGet(ctx, "user_balance", fmt.Sprint(tradeData.UserID)).Result()
		balance, err := strconv.ParseFloat(balanceStr, 64)
		if err != nil {
			log.Printf("User not found or balance", http.StatusBadRequest)
		}
		var totalCost float64
		for i, stock := range tradeData.Stock {
			stockPrice, err := redisStorage.GetStockPrice(stock.Symbol)
			if err != nil {
				log.Printf("Failed to fetch price", err)
			} else {
				tradeData.Stock[i].Price = stockPrice
			}
			totalCost += stockPrice * stock.Quantity
		}
		if totalCost <= balance {
			trade_service.ExecuteBuy(ctx, tradeData, balance, totalCost)
		} else {
			log.Print(totalCost, balance, tradeData.UserID)
			log.Printf("Insufficient funds",  http.StatusForbidden)
			continue
		}
	}
}

func StartWorkerPool(workerCount int, jobs chan TradeJob) {
	var wg sync.WaitGroup
	if jobs == nil {
		log.Fatal("Trade job queue (jobs) is nil")
	}
	for i := 1; i <= workerCount; i++ {
		wg.Add(1)
		go TradeWorker(i, jobs, &wg)
	}
}
func EnsureRedisStream() {
	ctx := context.Background()
	err := redisClient.Client.XGroupCreateMkStream(ctx, "buy_stream", "kafka_workers", "$").Err()
	if err != nil && err.Error() != "BUSYGROUP Consumer Group name already exists" {
		log.Fatalf("Error creating consumer group: %v", err)
	}
	log.Println("✅ Redis Stream + 'kafka_workers' group ready!")
}
