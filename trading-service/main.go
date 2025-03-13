package main

import (
	"bytes"
	"encoding/json"
	"log"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"sync"
	"time"

	"trading-service/db"
	"trading-service/redis"
)

// ✅ Stock symbols list
var stockList = []string{"AAPL", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "JNJ", "V", "PG"}

const batchTradeChance = 0.15
const numTrades = 60             // Number of concurrent workers
const testDuration = time.Minute // Run test for 1 minute

// ✅ TradeRequest struct
type TradeRequest struct {
	UserID int    `json:"user_id"`
	Action string `json:"action"`
	Stock  []struct {
		Symbol   string  `json:"symbol"`
		Quantity float64 `json:"quantity"`
	} `json:"stock"`
}

// ✅ Generate single-trade data (1 stock)
func generateSingleTradeData(userID int) TradeRequest {
	return TradeRequest{
		UserID: userID,
		Action: "BUY",
		Stock: []struct {
			Symbol   string  `json:"symbol"`
			Quantity float64 `json:"quantity"`
		}{
			{
				Symbol:   stockList[rand.Intn(len(stockList))],
				Quantity: 1,
			},
		},
	}
}

// ✅ Generate batch-trade data (25-50 stocks)
func generateBatchTradeData(userID int) TradeRequest {
	numStocks := rand.Intn(50-25+1) + 25
	var stockSlice []struct {
		Symbol   string  `json:"symbol"`
		Quantity float64 `json:"quantity"`
	}

	for i := 0; i < numStocks; i++ {
		stockSlice = append(stockSlice, struct {
			Symbol   string  `json:"symbol"`
			Quantity float64 `json:"quantity"`
		}{
			Symbol:   stockList[rand.Intn(len(stockList))],
			Quantity: float64(rand.Intn(3) + 1),
		})
	}

	return TradeRequest{
		UserID: userID,
		Action: "BUY",
		Stock:  stockSlice,
	}
}

// ✅ Decide whether to generate single or batch trade
func generateTradeData(userID int) TradeRequest {
	if rand.Float32() < batchTradeChance {
		return generateBatchTradeData(userID)
	}
	return generateSingleTradeData(userID)
}

// ✅ Execute a trade by calling `handleTrade`
func executeTrade(userID int) (bool, TradeRequest) {
	tradeData := generateTradeData(userID)
	jsonData, err := json.Marshal(tradeData)
	if err != nil {
		log.Println("❌ Error marshalling trade data:", err)
		return false, tradeData
	}

	req := httptest.NewRequest("POST", "/trade", bytes.NewBuffer(jsonData))
	req.Header.Set("Content-Type", "application/json")

	rr := httptest.NewRecorder()
	handleTrade(rr, req)

	return rr.Code == http.StatusOK, tradeData
}

func main() {
	db.InitDB()
	redis.InitRedis()

	rand.Seed(time.Now().UnixNano())

	var wg sync.WaitGroup
	tradeChan := make(chan int, numTrades) // Buffered channel to control concurrency

	startTime := time.Now()
	totalTrades := 0
	failedTrades := 0
	var tradeMutex sync.Mutex // Prevent race condition on `totalTrades` & `failedTrades`

	// ✅ Spawn worker pool
	for i := 0; i < numTrades; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for userID := range tradeChan {
				success, tradeData := executeTrade(userID)
				tradeMutex.Lock()
				if success {
					totalTrades++
					log.Printf("✅ Trade Success: User %d | Stocks: %v", userID, tradeData.Stock)
				} else {
					failedTrades++
					log.Printf("❌ Trade Failed: User %d | Stocks: %v", userID, tradeData.Stock)
				}
				tradeMutex.Unlock()
			}
		}()
	}

	// ✅ Generate trades for 1 minute
	for time.Since(startTime) < testDuration {
		userID := 5 + rand.Intn(1000)
		tradeChan <- userID
	}

	close(tradeChan) // Signal workers to stop
	wg.Wait()        // Wait for all workers to finish

	// ✅ Compute performance metrics
	durationSeconds := time.Since(startTime).Seconds()
	avgTradesPerSecond := float64(totalTrades) / durationSeconds

	log.Println("===================================")
	log.Printf("🏁 All trades completed in 1 minute!")
	log.Printf("✅ Successful Trades: %d", totalTrades)
	log.Printf("❌ Failed Trades: %d", failedTrades)
	log.Printf("⏱️ Average Trades Per Second: %.2f", avgTradesPerSecond)
	log.Println("===================================")
}

// package main

// import (
// 	"bytes"
// 	"encoding/json"
// 	"log"
// 	"math/rand"
// 	"net/http"
// 	"net/http/httptest"
// 	"time"

// 	"trading-service/db"
// 	"trading-service/redis"
// )

// // ✅ Stock symbols list
// var stockList = []string{"AAPL", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "JNJ", "V", "PG"}

// // ✅ Probability that a trade is batch vs. single
// // e.g., 10-15% chance is 0.10 - 0.15.
// const batchTradeChance = 0.15

// // ✅ TradeRequest struct
// type TradeRequest struct {
// 	UserID int    `json:"user_id"`
// 	Action string `json:"action"`
// 	Stock  []struct {
// 		Symbol   string  `json:"symbol"`
// 		Quantity float64 `json:"quantity"`
// 	} `json:"stock"`
// }

// // ✅ Generate single-trade data (1 stock)
// func generateSingleTradeData(userID int) TradeRequest {
// 	return TradeRequest{
// 		UserID: userID,
// 		Action: "BUY",
// 		Stock: []struct {
// 			Symbol   string  `json:"symbol"`
// 			Quantity float64 `json:"quantity"`
// 		}{
// 			{
// 				Symbol:   stockList[rand.Intn(len(stockList))],
// 				Quantity: 1,
// 			},
// 		},
// 	}
// }

// // ✅ Generate batch-trade data (25-50 stocks)
// func generateBatchTradeData(userID int) TradeRequest {
// 	numStocks := rand.Intn(50-25+1) + 25 // random [25..50]

// 	var stockSlice []struct {
// 		Symbol   string  `json:"symbol"`
// 		Quantity float64 `json:"quantity"`
// 	}

// 	for i := 0; i < numStocks; i++ {
// 		stockSlice = append(stockSlice, struct {
// 			Symbol   string  `json:"symbol"`
// 			Quantity float64 `json:"quantity"`
// 		}{
// 			Symbol:   stockList[rand.Intn(len(stockList))],
// 			Quantity: float64(rand.Intn(3) + 1), // quantity 1-3 each
// 		})
// 	}

// 	return TradeRequest{
// 		UserID: userID,
// 		Action: "BUY",
// 		Stock:  stockSlice,
// 	}
// }

// // ✅ Decide whether to generate single or batch trade
// func generateTradeData(userID int) TradeRequest {
// 	// 10-15% chance of batch trade => we'll use batchTradeChance=0.15
// 	if rand.Float32() < batchTradeChance {
// 		return generateBatchTradeData(userID)
// 	}
// 	return generateSingleTradeData(userID)
// }

// // ✅ Execute a trade by calling `handleTrade`
// func executeTrade(userID int) bool {
// 	tradeData := generateTradeData(userID)
// 	jsonData, err := json.Marshal(tradeData)
// 	if err != nil {
// 		log.Println("❌ Error marshalling trade data:", err)
// 		return false
// 	}

// 	// ✅ Simulate HTTP request to `handleTrade`
// 	req := httptest.NewRequest("POST", "/trade", bytes.NewBuffer(jsonData))
// 	req.Header.Set("Content-Type", "application/json")

// 	rr := httptest.NewRecorder()
// 	handleTrade(rr, req) // ✅ Calls `handleTrade` directly

// 	if rr.Code == http.StatusOK {
// 		// Log how many stocks in this trade
// 		numStocks := len(tradeData.Stock)
// 		if numStocks > 1 {
// 			log.Printf("✅ BATCH Trade Success: User %d, Stocks: %d\n", tradeData.UserID, numStocks)
// 		} else {
// 			log.Printf("✅ Single Trade Success: User %d, Stock %s, Quantity %.2f",
// 				tradeData.UserID, tradeData.Stock[0].Symbol, tradeData.Stock[0].Quantity)
// 		}
// 		return true
// 	}

// 	log.Printf("❌ Trade Failed: User %d, Response Code %d",
// 		tradeData.UserID, rr.Code)
// 	return false
// }

// // ✅ Run trades for 1 minute and measure average trades per second
// func executeTradesForOneMinute() {
// 	log.Println("📡 Starting trade test for users with ID >= 5... (10-15% batch trades)")
// 	totalTrades := 0
// 	startTime := time.Now()

// 	for time.Since(startTime) < time.Minute {
// 		userID := 5 + rand.Intn(1000) // Random user ID (>= 5)
// 		if executeTrade(userID) {
// 			totalTrades++
// 		}
// 	}

// 	// ✅ Calculate average trades per second
// 	durationSeconds := time.Since(startTime).Seconds()
// 	avgTradesPerSecond := float64(totalTrades) / durationSeconds

// 	log.Printf("✅ Trades completed in 1 minute: %d\n", totalTrades)
// 	log.Printf("⏱️ Average trades per second: %.2f\n", avgTradesPerSecond)
// }

// func main() {
// 	db.InitDB()       // ✅ Initialize DB
// 	redis.InitRedis() // ✅ Initialize Redis

// 	rand.Seed(time.Now().UnixNano()) // ✅ Ensure randomization
// 	executeTradesForOneMinute()      // 🔥 Start the test
// }

// package main

// import (
// 	"bytes"
// 	"encoding/json"
// 	"log"
// 	"math/rand"
// 	"net/http"
// 	"net/http/httptest"
// 	"time"

// 	"trading-service/db"
// 	"trading-service/redis"
// )

// // ✅ Stock symbols list
// var stockList = []string{"AAPL", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "JNJ", "V", "PG"}

// // ✅ TradeRequest struct
// type TradeRequest struct {
// 	UserID int    `json:"user_id"`
// 	Action string `json:"action"`
// 	Stock  []struct {
// 		Symbol   string  `json:"symbol"`
// 		Quantity float64 `json:"quantity"`
// 	} `json:"stock"`
// }

// // ✅ Generate trade data for a user
// func generateTradeData(userID int) TradeRequest {
// 	return TradeRequest{
// 		UserID: userID,
// 		Action: "BUY",
// 		Stock: []struct {
// 			Symbol   string  `json:"symbol"`
// 			Quantity float64 `json:"quantity"`
// 		}{
// 			{Symbol: stockList[rand.Intn(len(stockList))], Quantity: 1}, // Random stock, 1 quantity
// 		},
// 	}
// }

// // ✅ Execute a trade by calling `handleTrade`
// func executeTrade(userID int) bool {
// 	tradeData := generateTradeData(userID)
// 	jsonData, err := json.Marshal(tradeData)
// 	if err != nil {
// 		log.Println("❌ Error marshalling trade data:", err)
// 		return false
// 	}

// 	// ✅ Simulate HTTP request to `handleTrade`
// 	req := httptest.NewRequest("POST", "/trade", bytes.NewBuffer(jsonData))
// 	req.Header.Set("Content-Type", "application/json")

// 	rr := httptest.NewRecorder()
// 	handleTrade(rr, req) // ✅ Calls `handleTrade` directly

// 	if rr.Code == http.StatusOK {
// 		log.Printf("✅ Trade Success: User %d, Stock %s, Quantity %.2f",
// 			tradeData.UserID, tradeData.Stock[0].Symbol, tradeData.Stock[0].Quantity)
// 		return true
// 	}

// 	log.Printf("❌ Trade Failed: User %d, Stock %s, Response Code %d",
// 		tradeData.UserID, tradeData.Stock[0].Symbol, rr.Code)
// 	return false
// }

// // ✅ Run trades for 1 minute and measure average trades per second
// func executeTradesForOneMinute() {
// 	log.Println("📡 Starting trade test for users with ID >= 5...")
// 	totalTrades := 0
// 	startTime := time.Now()

// 	for time.Since(startTime) < time.Minute {
// 		userID := 5 + rand.Intn(1000) // Random user ID (>= 5)
// 		if executeTrade(userID) {
// 			totalTrades++
// 		}
// 	}

// 	// ✅ Calculate average trades per second
// 	durationSeconds := time.Since(startTime).Seconds()
// 	avgTradesPerSecond := float64(totalTrades) / durationSeconds

// 	log.Printf("✅ Trades completed in 1 minute: %d\n", totalTrades)
// 	log.Printf("⏱️ Average trades per second: %.2f\n", avgTradesPerSecond)
// }

// func main() {
// 	db.InitDB()       // ✅ Initialize DB
// 	redis.InitRedis() // ✅ Initialize Redis

// 	rand.Seed(time.Now().UnixNano()) // ✅ Ensure randomization
// 	executeTradesForOneMinute()      // 🔥 Start the test
// }
// package main

// import (
// 	"bytes"
// 	"encoding/json"
// 	"log"
// 	"math/rand"
// 	"net/http/httptest"
// 	"time"

// 	"trading-service/db"
// 	"trading-service/redis"
// )

// // ✅ Stock symbols list
// var stockList = []string{"AAPL", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "JNJ", "V", "PG"}

// // ✅ TradeRequest struct
// type TradeRequest struct {
// 	UserID int    `json:"user_id"`
// 	Action string `json:"action"`
// 	Stock  []struct {
// 		Symbol   string  `json:"symbol"`
// 		Quantity float64 `json:"quantity"`
// 	} `json:"stock"`
// }

// // ✅ Generate trade data for a user
// func generateTradeData(userID int) TradeRequest {
// 	return TradeRequest{
// 		UserID: userID,
// 		Action: "BUY",
// 		Stock: []struct {
// 			Symbol   string  `json:"symbol"`
// 			Quantity float64 `json:"quantity"`
// 		}{
// 			{Symbol: stockList[rand.Intn(len(stockList))], Quantity: 1}, // Random stock, 1 quantity
// 		},
// 	}
// }

// // ✅ Execute a trade by calling `handleTrade`
// func executeTrade(userID int) bool {
// 	tradeData := generateTradeData(userID)
// 	jsonData, err := json.Marshal(tradeData)
// 	if err != nil {
// 		log.Println("❌ Error marshalling trade data:", err)
// 		return false
// 	}

// 	// ✅ Simulate HTTP request to `handleTrade`
// 	req := httptest.NewRequest("POST", "/trade", bytes.NewBuffer(jsonData))
// 	req.Header.Set("Content-Type", "application/json")

// 	rr := httptest.NewRecorder()
// 	handleTrade(rr, req) // ✅ Calls `handleTrade` directly

// 	if rr.Code == 200 {
// 		return true
// 	}
// 	return false
// }

// // ✅ Run trades for 1 minute and measure average trades per second
// func executeTradesForOneMinute() {
// 	log.Println("📡 Starting trade test for users with ID >= 5...")

// 	totalTrades := 0
// 	startTime := time.Now()

// 	for time.Since(startTime) < time.Minute {
// 		userID := 5 + rand.Intn(1000) // Random user ID (>= 5)
// 		if executeTrade(userID) {
// 			totalTrades++
// 		}
// 	}

// 	// ✅ Calculate average trades per second
// 	durationSeconds := time.Since(startTime).Seconds()
// 	avgTradesPerSecond := float64(totalTrades) / durationSeconds

// 	log.Printf("✅ Trades completed in 1 minute: %d\n", totalTrades)
// 	log.Printf("⏱️ Average trades per second: %.2f\n", avgTradesPerSecond)
// }

// func main() {
// 	db.InitDB()       // ✅ Initialize DB
// 	redis.InitRedis() // ✅ Initialize Redis

// 	rand.Seed(time.Now().UnixNano()) // ✅ Ensure randomization
// 	executeTradesForOneMinute()      // 🔥 Start the test
// }

// package main

// import (
// 	"bytes"
// 	"encoding/json"
// 	"fmt"
// 	"net/http/httptest"

// 	"trading-service/db"
// 	"trading-service/redis"
// )

// //	func main(){
// //		// db.InitDB()
// //		// redis.InitRedis()
// //		handleTrade()
// //	}
// func main() {
// 	db.InitDB()       // ✅ Initialize DB
// 	redis.InitRedis() // ✅ Initialize Redis

// 	// ✅ Create a test TradeRequest
// 	trade := TradeRequest{
// 		UserID: 5,
// 		Action: "buy",
// 		Stock: []struct {
// 			Symbol   string  `json:"symbol"`
// 			Quantity float64 `json:"quantity"`
// 		}{
// 			{"GD", 10},
// 			{"PGR", 5},
// 		},
// 	}

// 	// ✅ Convert struct to JSON
// 	jsonData, _ := json.Marshal(trade)

// 	// ✅ Simulate HTTP request
// 	req := httptest.NewRequest("POST", "/trade", bytes.NewBuffer(jsonData))
// 	req.Header.Set("Content-Type", "application/json")

// 	rr := httptest.NewRecorder()
// 	handleTrade(rr, req) // ✅ Call `handleTrade` correctly

// 	// ✅ Print Response
// 	fmt.Println("Response Code:", rr.Code)
// 	fmt.Println("Response Body:", rr.Body.String())
// }
