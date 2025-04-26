// main.go — API + load‑test version

package main

import (
    "bytes"
    "encoding/json"
    "log"
    "math/rand"
    "net/http"
    "runtime"
    "sync/atomic"
    "time"

    "github.com/go-chi/chi/v5"

    "trading-service/db"
    "trading-service/pkg/redisClient"
    redisStorage "trading-service/redis"
    trade_service "trading-service/services/trade"
    "trading-service/services/workers"
)

// ─── global counters ───────────────────────────────────────────────────────────
var (
    totalTrades        int64
    totalStocksTraded  int64
)

const (
    testDuration   = 5 * 60 * time.Second
    workerCount    = 20
)

// ─── random stock list (trimmed for brevity) ───────────────────────────────────
var stockList = []string{"AAPL", "MSFT", "AMZN", "GOOGL", "META"}

// ─── helper: fetch user ids from DB ─────────────────────────────────────────────
func fetchAllUserIDs() []int {
    rows, err := db.DB.Query("SELECT id FROM users")
    if err != nil {
        log.Fatalf("query users: %v", err)
    }
    defer rows.Close()

    var ids []int
    for rows.Next() {
        var id int
        rows.Scan(&id)
        ids = append(ids, id)
    }
    return ids
}

// ─── helper: create random trade request ───────────────────────────────────────
func randomTrade(userID int) trade_service.TradeRequest {
    return trade_service.TradeRequest{
        UserID: userID,
        Action: "BUY",
        Stock: []struct {
            Symbol   string  `json:"symbol"`
            Quantity float64 `json:"quantity"`
            Price    float64 `json:"price"`
        }{{
            Symbol:   stockList[rand.Intn(len(stockList))],
            Quantity: float64(rand.Intn(5) + 1),
            Price:    0,
        }},
    }
}

// ─── API handler: enqueue trade ────────────────────────────────────────────────
func tradeHandler(w http.ResponseWriter, r *http.Request) {
    var req trade_service.TradeRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "bad json", http.StatusBadRequest)
        return
    }
    select {
    case workers.TradeJobQueue <- workers.TradeJob{Trade: req}:
        w.WriteHeader(http.StatusAccepted)
    default:
        http.Error(w, "queue full", http.StatusServiceUnavailable)
    }
}

// ─── router setup ─────────────────────────────────────────────────────────────
func apiRouter() http.Handler {
    r := chi.NewRouter()
    r.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
    r.Post("/api/trade", tradeHandler)
    return r
}

// ─── load tester (sends HTTP requests) ─────────────────────────────────────────
func startLoadTest() {
    ids := fetchAllUserIDs()
    stop := time.After(testDuration)

    go func() {
        client := http.Client{}
        for {
            for _, uid := range ids {
                select {
                case <-stop:
                    return
                default:
                    tr := randomTrade(uid)
                    body, _ := json.Marshal(tr)
                    client.Post("http://localhost:8081/api/trade", "application/json", bytes.NewReader(body))
                    atomic.AddInt64(&totalTrades, 1)
                    for _, s := range tr.Stock { atomic.AddInt64(&totalStocksTraded, int64(s.Quantity)) }
                }
            }
        }
    }()
}

// ─── main ─────────────────────────────────────────────────────────────────────
// func main() {
//     rand.Seed(time.Now().UnixNano())
//     runtime.GOMAXPROCS(runtime.NumCPU())
//     log.SetFlags(log.LstdFlags | log.Lshortfile)

//     db.InitDB()
//     redisClient.InitRedis()
//     redisStorage.InitRedis(redisClient.Client)
//     workers.EnsureRedisStream()
//     workers.StartKafkaProducer(5)
//     workers.StartKafkaConsumer(2, db.DB)

//     // go workers.StartWorkerPool(workerCount, workers.TradeJobQueue)

//     // start background processing
//     go workers.StartWorkerPool(30, workers.TradeJobQueue)

//     // start HTTP API
//     go func() {
//         log.Println("🌐 API listening on :8081")
//         if err := http.ListenAndServe(":8081", apiRouter()); err != nil {
//             log.Fatalf("server: %v", err)
//         }
//     }()

//     // give server a moment to boot, then run load test
//     time.Sleep(time.Second)
//     startLoadTest()

//     // wait for test window to finish
//     time.Sleep(testDuration + 10*time.Second)

//     // report
//     log.Printf("✅ Trades: %d | Stocks: %d | TPS: %.1f", totalTrades, totalStocksTraded, float64(totalTrades)/testDuration.Seconds())
// }

func getExecutedTradeCountFromDB() int {
	row := db.DB.QueryRow("SELECT COUNT(*) FROM trades")
	var count int
	if err := row.Scan(&count); err != nil {
		log.Printf("❌ Failed to count trades in DB: %v", err)
		return -1
	}
	return count
}
// ─── main ─────────────────────────────────────────────────────────────────────
func main() {
    rand.Seed(time.Now().UnixNano())
    runtime.GOMAXPROCS(runtime.NumCPU())
    log.SetFlags(log.LstdFlags | log.Lshortfile)

    db.InitDB()
    redisClient.InitRedis()
    redisStorage.InitRedis(redisClient.Client)
	oldTrades := getExecutedTradeCountFromDB()
    workers.EnsureRedisStream()
    workers.StartKafkaProducer(2)
    workers.StartKafkaConsumer(15, db.DB)

    // go workers.StartWorkerPool(workerCount, workers.TradeJobQueue)

    // start background processing
    go workers.StartWorkerPool(30, workers.TradeJobQueue)

    // start HTTP API
    go func() {
        log.Println("🌐 API listening on :8081")
        if err := http.ListenAndServe(":8081", apiRouter()); err != nil {
            log.Fatalf("server: %v", err)
        }
    }()

    // give server a moment to boot, then run load test
    time.Sleep(time.Second)
    startLoadTest()

    // wait for test window to finish
    time.Sleep(testDuration + 20*time.Second)

    // report
	actualTrades := getExecutedTradeCountFromDB()
	log.Println("===================================")
	log.Printf("✅ Total Trades Sent: %d", totalTrades)
	log.Printf("📦 Total Stocks Traded: %d", totalStocksTraded)
	log.Printf("📊 TPS: %.2f", float64(totalTrades)/testDuration.Seconds())
	log.Printf("🧾 Actual Trades Stored in DB: %d",actualTrades)
	log.Printf("🧾 Before Trades Stored in DB: %d",oldTrades)
	log.Printf("🔍 Total trades done %d", actualTrades-oldTrades)
	log.Println("===================================")
    // log.Printf("✅ Trades: %d | Stocks: %d | TPS: %.1f", totalTrades, totalStocksTraded, float64(totalTrades)/testDuration.Seconds())
}

// package main

// import (
// 	"log"
// 	"context"
// 	"math/rand"
// 	"runtime"
// 	"sync/atomic"
// 	"time"

// 	"trading-service/db"
// 	"trading-service/pkg/redisClient"
// 	redisStorage "trading-service/redis"
// 	trade "trading-service/services/trade"
// 	workers "trading-service/services/workers"
// )

// var totalStocksTraded int64
// var totalTrades int64
// var totalTradeTime time.Duration
// var tradeTimestamps []time.Time

// const (
// 	testDuration   = 21 * time.Second
// 	currentWorkers = 30
// )

// var stockList = []string{
// 	"AAPL", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "JNJ", "V", "PG",
// 	"NVDA", "UNH", "HD", "MA", "DIS", "BAC", "VZ", "ADBE", "CMCSA", "NFLX",
// 	"PFE", "T", "KO", "NKE", "MRK", "INTC", "CSCO", "XOM", "CVX", "ABT",
// 	"ORCL", "CRM", "PEP", "IBM", "MCD", "WFC", "QCOM", "UPS", "COST", "MDT",
// 	"CAT", "HON", "AMGN", "LLY", "PM", "BLK", "GE", "BA", "SBUX", "MMM",
// 	"F", "GM", "ADP", "SPGI", "RTX", "TMO", "NOW", "BKNG", "MO", "ZTS",
// 	"COP", "AXP", "SCHW", "CVS", "LOW", "DE", "MET", "PNC", "GS", "CI",
// 	"TJX", "ICE", "PLD", "DUK", "SO", "ED", "OXY", "FDX", "MMC", "EXC",
// 	"EQIX", "SLB", "GD", "APD", "NEE", "EOG", "LMT", "USB", "HCA", "BK",
// 	"ITW", "AEP", "ECL", "PGR", "CSX", "CB", "MS", "TRV", "AON", "VLO",
// }

// func fetchAllUserIDs() []int {
// 	rows, err := db.DB.Query("SELECT id FROM users")
// 	if err != nil {
// 		log.Fatalf("Failed to query users: %v", err)
// 	}
// 	defer rows.Close()

// 	var userIDs []int
// 	for rows.Next() {
// 		var id int
// 		rows.Scan(&id)
// 		userIDs = append(userIDs, id)
// 	}
// 	return userIDs
// }

// func generateRandomTrade(userID int) trade.TradeRequest {
// 	return trade.TradeRequest{
// 		UserID: userID,
// 		Action: "BUY",
// 		Stock: []struct {
// 			Symbol   string  `json:"symbol"`
// 			Quantity float64 `json:"quantity"`
// 			Price    float64 `json:"price"`
// 		}{
// 			{
// 				Symbol:   stockList[rand.Intn(len(stockList))],
// 				Quantity: float64(rand.Intn(5) + 1),
// 				Price:    0,
// 			},
// 		},
// 	}
// }

// func runTest() {
// 	log.Printf("🚀 Running Load Test for %s...", testDuration)

// 	userIDs := fetchAllUserIDs()
// 	stop := time.After(testDuration)

// 	go func() {
// 		for {
// 			for _, uid := range userIDs {
// 				select {
// 				case <-stop:
// 					close(workers.TradeJobQueue)
// 					return
// 				default:
// 					trade := generateRandomTrade(uid)
// 					atomic.AddInt64(&totalTrades, 1)
// 					for _, s := range trade.Stock {
// 						atomic.AddInt64(&totalStocksTraded, int64(s.Quantity))
// 					}
// 					workers.TradeJobQueue <- workers.TradeJob{Trade: trade}
// 				}
// 			}
// 		}
// 	}()
// }

// func waitUntilRedisStreamEmpty() {
// 		ctx := context.Background()

// 		for {
// 		pending, _ := redisClient.Client.XPending(ctx, "buy_stream", "kafka_workers").Result()
// 		length, _ := redisClient.Client.XLen(ctx, "buy_stream").Result()
// 		if pending.Count == 0 && length == 0 {
// 			break
// 		}
// 		time.Sleep(500 * time.Millisecond)
// 	}
// }

// func main() {
// 	log.SetFlags(log.LstdFlags | log.Lshortfile)
// 	db.InitDB()
// 	redisClient.InitRedis()
// 	redisStorage.InitRedis(redisClient.Client)

// 	workers.EnsureRedisStream()

// 	runtime.GOMAXPROCS(runtime.NumCPU())
// 	rand.Seed(time.Now().UnixNano())

// 	workers.StartKafkaProducer(10)
// 	workers.StartKafkaConsumer(10, db.DB)

// 	// ✅ Use your in-memory trade workers
// 	workers.StartWorkerPool(currentWorkers, workers.TradeJobQueue)

// 	runTest()

// 	// ✅ Wait until Redis stream is empty (Kafka already took everything)
// 	waitUntilRedisStreamEmpty()

// 	// ✅ Optional: small buffer wait to allow final SQL flush
// 	time.Sleep(2 * time.Second)

// 	log.Println("===================================")
// 	log.Printf("✅ Total Trades Sent: %d", totalTrades)
// 	log.Printf("📦 Total Stocks Traded: %d", totalStocksTraded)
// 	log.Printf("📊 TPS: %.2f", float64(totalTrades)/testDuration.Seconds())
// 	log.Println("===================================")
// }

// package main

// import (
// 	"context"
// 	"log"
// 	"math/rand"
// 	"runtime"
// 	"sync"
// 	"sync/atomic"
// 	"time"

// 	"trading-service/db"
// 	"trading-service/pkg/redisClient"
// 	trade "trading-service/services/trade"
// 	workers "trading-service/services/workers"
// )

// var totalStocksTraded int64 // 🔢 total quantity of stocks traded

// var (
// 	// Worker concurrency params
// 	baseWorkers     = runtime.NumCPU() * 2
// 	workerIncrement = 4
// 	maxWorkers      = 200
// 	currentWorkers  = 30

// 	// Performance tracking
// 	totalTrades     int64
// 	totalTradeTime  time.Duration
// 	tradeMutex      sync.Mutex
// 	tradeTimestamps []time.Time
// )

// // Modified: Changed test duration from 2 seconds to 5 seconds
// const testDuration = 5 * time.Second

// var stockList = []string{
// 	"AAPL", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "JNJ", "V", "PG",
// 	"NVDA", "UNH", "HD", "MA", "DIS", "BAC", "VZ", "ADBE", "CMCSA", "NFLX",
// 	"PFE", "T", "KO", "NKE", "MRK", "INTC", "CSCO", "XOM", "CVX", "ABT",
// 	"ORCL", "CRM", "PEP", "IBM", "MCD", "WFC", "QCOM", "UPS", "COST", "MDT",
// 	"CAT", "HON", "AMGN", "LLY", "PM", "BLK", "GE", "BA", "SBUX", "MMM",
// 	"F", "GM", "ADP", "SPGI", "RTX", "TMO", "NOW", "BKNG", "MO", "ZTS",
// 	"COP", "AXP", "SCHW", "CVS", "LOW", "DE", "MET", "PNC", "GS", "CI",
// 	"TJX", "ICE", "PLD", "DUK", "SO", "ED", "OXY", "FDX", "MMC", "EXC",
// 	"EQIX", "SLB", "GD", "APD", "NEE", "EOG", "LMT", "USB", "HCA", "BK",
// 	"ITW", "AEP", "ECL", "PGR", "CSX", "CB", "MS", "TRV", "AON", "VLO",
// }

// // ✅ Fetch real user IDs from the DB
// func fetchAllUserIDs() []int {
// 	rows, err := db.DB.Query("SELECT id FROM users")
// 	if err != nil {
// 		log.Fatalf("Failed to query users: %v", err)
// 	}
// 	defer rows.Close()

// 	var userIDs []int
// 	for rows.Next() {
// 		var id int
// 		if err := rows.Scan(&id); err != nil {
// 			log.Printf("Failed to scan row: %v", err)
// 			continue
// 		}
// 		userIDs = append(userIDs, id)
// 	}

// 	if err := rows.Err(); err != nil {
// 		log.Fatalf("Error iterating rows: %v", err)
// 	}

// 	log.Printf("✅ Loaded %d user IDs from database", len(userIDs))
// 	return userIDs
// }

// func generateRandomTrade(userID int) trade.TradeRequest {
// 	return trade.TradeRequest{
// 		UserID: userID,
// 		Action: "BUY",
// 		Stock: []struct {
// 			Symbol   string  `json:"symbol"`
// 			Quantity float64 `json:"quantity"`
// 			Price    float64 `json:"price"`
// 		}{
// 			{
// 				Symbol:   stockList[rand.Intn(len(stockList))],
// 				Quantity: float64(rand.Intn(5) + 1),
// 				Price:    100.0,
// 			},
// 		},
// 	}
// }

// var inFlightUsers sync.Map

// func executeTrade(userID int) {
// 	if _, exists := inFlightUsers.LoadOrStore(userID, struct{}{}); exists {
// 		return
// 	}
// 	defer inFlightUsers.Delete(userID)

// 	tradeData := generateRandomTrade(userID)

// 	start := time.Now()
// 	balance := 100000.0
// 	totalCost := tradeData.Stock[0].Price * tradeData.Stock[0].Quantity

// 	trade.ExecuteBuy(context.Background(), tradeData, balance, totalCost)

// 	elapsed := time.Since(start)

// 	tradeMutex.Lock()
// 	totalTradeTime += elapsed
// 	tradeTimestamps = append(tradeTimestamps, time.Now())
// 	tradeMutex.Unlock()

// 	atomic.AddInt64(&totalTrades, 1)
// 	for _, s := range tradeData.Stock {
// 		atomic.AddInt64(&totalStocksTraded, int64(s.Quantity))
// 	}
// }

// // Modified: Updated runTest to run for a fixed duration instead of fixed number of users
// func runTest(concurrent bool) {
// 	log.Printf("🚀 Running Load Test | concurrent=%t | workers=%d | duration=%s", concurrent, currentWorkers, testDuration)
// 	var wg sync.WaitGroup

// 	userIDs := fetchAllUserIDs()
// 	// Create a stopChan to signal workers to stop after test duration
// 	stopChan := make(chan struct{})
	
// 	// Start a timer to close stopChan after test duration
// 	go func() {
// 		time.Sleep(testDuration)
// 		close(stopChan)
// 		log.Printf("⏰ Test duration (%s) reached, stopping new trades...", testDuration)
// 	}()
	
// 	if concurrent {
// 		tradeChan := make(chan int, 1000)
		
// 		// Start worker goroutines
// 		for i := 0; i < currentWorkers; i++ {
// 			wg.Add(1)
// 			go func() {
// 				defer wg.Done()
// 				for userID := range tradeChan {
// 					executeTrade(userID)
// 				}
// 			}()
// 		}
		
// 		// Feed user IDs to tradeChan until stopChan is closed
// 		go func() {
// 			defer close(tradeChan)
			
// 			// Loop continuously sending user IDs until stop signal
// 			for {
// 				select {
// 				case <-stopChan:
// 					return
// 				default:
// 					// Continuously cycle through all valid user IDs
// 					for _, userID := range userIDs {
// 						if userID >= 1 && userID <= 7000 {
// 							select {
// 							case <-stopChan:
// 								return
// 							case tradeChan <- userID:
// 								// Successfully sent user ID to trade channel
// 							}
// 						}
// 					}
// 				}
// 			}
// 		}()
		
// 		// Wait for all worker goroutines to finish
// 		wg.Wait()
// 	} else {
// 		// Non-concurrent version with time limit
// 		startTime := time.Now()
// 		for time.Since(startTime) < testDuration {
// 			for _, userID := range userIDs {
// 				if userID >= 1 && userID <= 7000 {
// 					executeTrade(userID)
					
// 					// Check if test duration has elapsed
// 					if time.Since(startTime) >= testDuration {
// 						break
// 					}
// 				}
// 			}
// 		}
// 	}

// 	waitUntilRedisStreamEmpty()
// 	analyzePerformance()
// }

// func waitUntilRedisStreamEmpty() {
// 	ctx := context.Background()
// 	log.Println("⏳ Waiting for Redis stream to drain...")

// 	for {
// 		pending, err := redisClient.Client.XPending(ctx, "buy_stream", "kafka_workers").Result()
// 		if err != nil {
// 			log.Printf("❌ XPENDING error: %v", err)
// 			time.Sleep(1 * time.Second)
// 			continue
// 		}
// 		length, err := redisClient.Client.XLen(ctx, "buy_stream").Result()
// 		if err != nil {
// 			log.Printf("❌ XLEN error: %v", err)
// 			time.Sleep(1 * time.Second)
// 			continue
// 		}

// 		if pending.Count == 0 && length == 0 {
// 			log.Println("✅ All Redis stream messages processed.")
// 			break
// 		}
// 		log.Printf("⌛ Stream has length=%d, pending=%d; waiting...", length, pending.Count)
// 		time.Sleep(1 * time.Second)
// 	}
// }

// func analyzePerformance() {
// 	tradeMutex.Lock()
// 	defer tradeMutex.Unlock()

// 	var tps float64
// 	if len(tradeTimestamps) > 1 {
// 		first := tradeTimestamps[0]
// 		last := tradeTimestamps[len(tradeTimestamps)-1]
// 		duration := last.Sub(first).Seconds()
// 		if duration > 0 {
// 			tps = float64(len(tradeTimestamps)) / duration
// 		}
// 	}

// 	avgTime := time.Duration(0)
// 	if totalTrades > 0 {
// 		avgTime = totalTradeTime / time.Duration(totalTrades)
// 	}

// 	log.Println("===================================")
// 	log.Printf("✅ Total Trades Sent: %d", totalTrades)
// 	log.Printf("📦 Total Stocks Traded: %d", totalStocksTraded)
// 	log.Printf("📊 TPS: %.2f", tps)
// 	log.Printf("⏳ Avg Time to Enqueue: %v", avgTime)
// 	log.Println("===================================")
// }

// func ensureRedisStream() {
// 	ctx := context.Background()
// 	err := redisClient.Client.XGroupCreateMkStream(ctx, "buy_stream", "kafka_workers", "$").Err()
// 	if err != nil && err.Error() != "BUSYGROUP Consumer Group name already exists" {
// 		log.Fatalf("Error creating consumer group: %v", err)
// 	}
// 	log.Println("✅ Redis Stream + 'kafka_workers' group ready!")
// }
// func getExecutedTradeCountFromDB() int {
// 	row := db.DB.QueryRow("SELECT COUNT(*) FROM trades")
// 	var count int
// 	if err := row.Scan(&count); err != nil {
// 		log.Printf("❌ Failed to count trades in DB: %v", err)
// 		return -1
// 	}
// 	return count
// }
// func main() {
// 	log.SetFlags(log.LstdFlags | log.Lshortfile)

// 	db.InitDB()
// 	oldTrades := getExecutedTradeCountFromDB()
// 	redisClient.InitRedis()
// 	ensureRedisStream()

// 	runtime.GOMAXPROCS(runtime.NumCPU())

// 	workers.StartKafkaProducer(10)
// 	workers.StartKafkaConsumer(10, db.DB)

// 	rand.Seed(time.Now().UnixNano())

// 	runTest(true)
// 	time.Sleep(30*time.Second)
// 	actualTrades := getExecutedTradeCountFromDB()
// 	log.Println("===================================")
// 	log.Printf("✅ Total Trades Sent: %d", totalTrades)
// 	log.Printf("📦 Total Stocks Traded: %d", totalStocksTraded)
// 	log.Printf("📊 TPS: %.2f", float64(totalTrades)/testDuration.Seconds())
// 	log.Printf("🧾 Actual Trades Stored in DB: %d", actualTrades)
// 	log.Printf("🔍 Difference (Lost Trades): %d", actualTrades-oldTrades)
// 	log.Println("===================================")

// }
// package main

// import (
// 	"context"
// 	"log"
// 	"math/rand"
// 	"runtime"
// 	"sync"
// 	"sync/atomic"
// 	"time"

// 	"trading-service/db"
// 	"trading-service/pkg/redisClient"
// 	trade "trading-service/services/trade"
// 	workers "trading-service/services/workers"
// )

// var totalStocksTraded int64 // 🔢 total quantity of stocks traded

// var (
// 	// Worker concurrency params
// 	baseWorkers     = runtime.NumCPU() * 2
// 	workerIncrement = 4
// 	maxWorkers      = 200
// 	currentWorkers  = 30

// 	// Performance tracking
// 	totalTrades     int64
// 	totalTradeTime  time.Duration
// 	tradeMutex      sync.Mutex
// 	tradeTimestamps []time.Time
// )

// const testDuration = 2 * time.Second

// var stockList = []string{
// 	"AAPL", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "JNJ", "V", "PG",
// 	"NVDA", "UNH", "HD", "MA", "DIS", "BAC", "VZ", "ADBE", "CMCSA", "NFLX",
// 	"PFE", "T", "KO", "NKE", "MRK", "INTC", "CSCO", "XOM", "CVX", "ABT",
// 	"ORCL", "CRM", "PEP", "IBM", "MCD", "WFC", "QCOM", "UPS", "COST", "MDT",
// 	"CAT", "HON", "AMGN", "LLY", "PM", "BLK", "GE", "BA", "SBUX", "MMM",
// 	"F", "GM", "ADP", "SPGI", "RTX", "TMO", "NOW", "BKNG", "MO", "ZTS",
// 	"COP", "AXP", "SCHW", "CVS", "LOW", "DE", "MET", "PNC", "GS", "CI",
// 	"TJX", "ICE", "PLD", "DUK", "SO", "ED", "OXY", "FDX", "MMC", "EXC",
// 	"EQIX", "SLB", "GD", "APD", "NEE", "EOG", "LMT", "USB", "HCA", "BK",
// 	"ITW", "AEP", "ECL", "PGR", "CSX", "CB", "MS", "TRV", "AON", "VLO",
// }

// // ✅ Fetch real user IDs from the DB
// func fetchAllUserIDs() []int {
// 	rows, err := db.DB.Query("SELECT id FROM users")
// 	if err != nil {
// 		log.Fatalf("Failed to query users: %v", err)
// 	}
// 	defer rows.Close()

// 	var userIDs []int
// 	for rows.Next() {
// 		var id int
// 		if err := rows.Scan(&id); err != nil {
// 			log.Printf("Failed to scan row: %v", err)
// 			continue
// 		}
// 		userIDs = append(userIDs, id)
// 	}

// 	if err := rows.Err(); err != nil {
// 		log.Fatalf("Error iterating rows: %v", err)
// 	}

// 	log.Printf("✅ Loaded %d user IDs from database", len(userIDs))
// 	return userIDs
// }

// func generateRandomTrade(userID int) trade.TradeRequest {
// 	return trade.TradeRequest{
// 		UserID: userID,
// 		Action: "BUY",
// 		Stock: []struct {
// 			Symbol   string  `json:"symbol"`
// 			Quantity float64 `json:"quantity"`
// 			Price    float64 `json:"price"`
// 		}{
// 			{
// 				Symbol:   stockList[rand.Intn(len(stockList))],
// 				Quantity: float64(rand.Intn(5) + 1),
// 				Price:    100.0,
// 			},
// 		},
// 	}
// }

// var inFlightUsers sync.Map

// func executeTrade(userID int) {
// 	if _, exists := inFlightUsers.LoadOrStore(userID, struct{}{}); exists {
// 		return
// 	}
// 	defer inFlightUsers.Delete(userID)

// 	tradeData := generateRandomTrade(userID)

// 	start := time.Now()
// 	balance := 100000.0
// 	totalCost := tradeData.Stock[0].Price * tradeData.Stock[0].Quantity

// 	trade.ExecuteBuy(context.Background(), tradeData, balance, totalCost)

// 	elapsed := time.Since(start)

// 	tradeMutex.Lock()
// 	totalTradeTime += elapsed
// 	tradeTimestamps = append(tradeTimestamps, time.Now())
// 	tradeMutex.Unlock()

// 	atomic.AddInt64(&totalTrades, 1)
// 	for _, s := range tradeData.Stock {
// 		atomic.AddInt64(&totalStocksTraded, int64(s.Quantity))
// 	}
// }
// func runTest(concurrent bool) {
// 	log.Printf("🚀 Running Load Test | concurrent=%t | workers=%d", concurrent, currentWorkers)
// 	var wg sync.WaitGroup

// 	userIDs := fetchAllUserIDs()

// 	if concurrent {
// 		tradeChan := make(chan int, 1000)
// 		for i := 0; i < currentWorkers; i++ {
// 			wg.Add(1)
// 			go func() {
// 				defer wg.Done()
// 				for userID := range tradeChan {
// 					executeTrade(userID)
// 				}
// 			}()
// 		}

// 		for _, userID := range userIDs {
// 			if userID >= 1 && userID <= 7000 {
// 				tradeChan <- userID
// 			}
// 		}

// 		close(tradeChan)
// 		wg.Wait()
// 	} else {
// 		for _, userID := range userIDs {
// 			if userID >= 1 && userID <= 7000{
// 				executeTrade(userID)
// 			}
// 		}
// 	}

// 	waitUntilRedisStreamEmpty()
// 	analyzePerformance()
// }

// func waitUntilRedisStreamEmpty() {
// 	ctx := context.Background()
// 	log.Println("⏳ Waiting for Redis stream to drain...")

// 	for {
// 		pending, err := redisClient.Client.XPending(ctx, "buy_stream", "kafka_workers").Result()
// 		if err != nil {
// 			log.Printf("❌ XPENDING error: %v", err)
// 			time.Sleep(1 * time.Second)
// 			continue
// 		}
// 		length, err := redisClient.Client.XLen(ctx, "buy_stream").Result()
// 		if err != nil {
// 			log.Printf("❌ XLEN error: %v", err)
// 			time.Sleep(1 * time.Second)
// 			continue
// 		}

// 		if pending.Count == 0 && length == 0 {
// 			log.Println("✅ All Redis stream messages processed.")
// 			break
// 		}
// 		log.Printf("⌛ Stream has length=%d, pending=%d; waiting...", length, pending.Count)
// 		time.Sleep(1 * time.Second)
// 	}
// }

// func analyzePerformance() {
// 	tradeMutex.Lock()
// 	defer tradeMutex.Unlock()

// 	var tps float64
// 	if len(tradeTimestamps) > 1 {
// 		first := tradeTimestamps[0]
// 		last := tradeTimestamps[len(tradeTimestamps)-1]
// 		duration := last.Sub(first).Seconds()
// 		if duration > 0 {
// 			tps = float64(len(tradeTimestamps)) / duration
// 		}
// 	}

// 	avgTime := time.Duration(0)
// 	if totalTrades > 0 {
// 		avgTime = totalTradeTime / time.Duration(totalTrades)
// 	}

// 	log.Println("===================================")
// 	log.Printf("✅ Total Trades Sent: %d", totalTrades)
// 	log.Printf("📦 Total Stocks Traded: %d", totalStocksTraded)
// 	log.Printf("📊 TPS: %.2f", tps)
// 	log.Printf("⏳ Avg Time to Enqueue: %v", avgTime)
// 	log.Println("===================================")
// }

// func ensureRedisStream() {
// 	ctx := context.Background()
// 	err := redisClient.Client.XGroupCreateMkStream(ctx, "buy_stream", "kafka_workers", "$").Err()
// 	if err != nil && err.Error() != "BUSYGROUP Consumer Group name already exists" {
// 		log.Fatalf("Error creating consumer group: %v", err)
// 	}
// 	log.Println("✅ Redis Stream + 'kafka_workers' group ready!")
// }

// func main() {
// 	log.SetFlags(log.LstdFlags | log.Lshortfile)

// 	db.InitDB()
// 	redisClient.InitRedis()
// 	ensureRedisStream()

// 	runtime.GOMAXPROCS(runtime.NumCPU())

// 	workers.StartKafkaProducer(10)
// 	workers.StartKafkaConsumer(10, db.DB)

// 	rand.Seed(time.Now().UnixNano())

// 	runTest(true)

// 	log.Printf("✅ Done. currentWorkers=%d", currentWorkers)
// }

// package main

// import (
// 	"bytes"
// 	"encoding/json"
// 	"log"
// 	"math/rand"
// 	"net/http"
// 	"net/http/httptest"
// 	"sync"
// 	"time"

// 	"trading-service/db"
// 	"trading-service/redis"
// )

// // ✅ Stock symbols list
// var stockList = []string{"AAPL", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "JNJ", "V", "PG"}

// const batchTradeChance = 0.15
// const numTrades = 60             // Number of concurrent workers
// const testDuration = time.Minute // Run test for 1 minute

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
// 	numStocks := rand.Intn(50-25+1) + 25
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
// 			Quantity: float64(rand.Intn(3) + 1),
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
// 	if rand.Float32() < batchTradeChance {
// 		return generateBatchTradeData(userID)
// 	}
// 	return generateSingleTradeData(userID)
// }

// // ✅ Execute a trade by calling `handleTrade`
// func executeTrade(userID int) (bool, TradeRequest) {
// 	tradeData := generateTradeData(userID)
// 	jsonData, err := json.Marshal(tradeData)
// 	if err != nil {
// 		log.Println("❌ Error marshalling trade data:", err)
// 		return false, tradeData
// 	}

// 	req := httptest.NewRequest("POST", "/trade", bytes.NewBuffer(jsonData))
// 	req.Header.Set("Content-Type", "application/json")

// 	rr := httptest.NewRecorder()
// 	handleTrade(rr, req)

// 	return rr.Code == http.StatusOK, tradeData
// }

// func main() {
// 	db.InitDB()
// 	redis.InitRedis()

// 	rand.Seed(time.Now().UnixNano())

// 	var wg sync.WaitGroup
// 	tradeChan := make(chan int, numTrades) // Buffered channel to control concurrency

// 	startTime := time.Now()
// 	totalTrades := 0
// 	failedTrades := 0
// 	var tradeMutex sync.Mutex // Prevent race condition on `totalTrades` & `failedTrades`

// 	// ✅ Spawn worker pool
// 	for i := 0; i < numTrades; i++ {
// 		wg.Add(1)
// 		go func() {
// 			defer wg.Done()
// 			for userID := range tradeChan {
// 				success, tradeData := executeTrade(userID)
// 				tradeMutex.Lock()
// 				if success {
// 					totalTrades++
// 					log.Printf("✅ Trade Success: User %d | Stocks: %v", userID, tradeData.Stock)
// 				} else {
// 					failedTrades++
// 					log.Printf("❌ Trade Failed: User %d | Stocks: %v", userID, tradeData.Stock)
// 				}
// 				tradeMutex.Unlock()
// 			}
// 		}()
// 	}

// 	// ✅ Generate trades for 1 minute
// 	for time.Since(startTime) < testDuration {
// 		userID := 5 + rand.Intn(1000)
// 		tradeChan <- userID
// 	}

// 	close(tradeChan) // Signal workers to stop
// 	wg.Wait()        // Wait for all workers to finish

// 	// ✅ Compute performance metrics
// 	durationSeconds := time.Since(startTime).Seconds()
// 	avgTradesPerSecond := float64(totalTrades) / durationSeconds

// 	log.Println("===================================")
// 	log.Printf("🏁 All trades completed in 1 minute!")
// 	log.Printf("✅ Successful Trades: %d", totalTrades)
// 	log.Printf("❌ Failed Trades: %d", failedTrades)
// 	log.Printf("⏱️ Average Trades Per Second: %.2f", avgTradesPerSecond)
// 	log.Println("===================================")
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
