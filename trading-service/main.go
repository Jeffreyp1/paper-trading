package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http/httptest"

	"trading-service/db"
	"trading-service/redis"
)

//	func main(){
//		// db.InitDB()
//		// redis.InitRedis()
//		handleTrade()
//	}
func main() {
	db.InitDB()       // ✅ Initialize DB
	redis.InitRedis() // ✅ Initialize Redis

	// ✅ Create a test TradeRequest
	trade := TradeRequest{
		UserID: 5,
		Action: "buy",
		Stock: []struct {
			Symbol   string  `json:"symbol"`
			Quantity float64 `json:"quantity"`
		}{
			{"AAPL", 10},
			{"TSLA", 5},
		},
	}

	// ✅ Convert struct to JSON
	jsonData, _ := json.Marshal(trade)

	// ✅ Simulate HTTP request
	req := httptest.NewRequest("POST", "/trade", bytes.NewBuffer(jsonData))
	req.Header.Set("Content-Type", "application/json")

	rr := httptest.NewRecorder()
	handleTrade(rr, req) // ✅ Call `handleTrade` correctly

	// ✅ Print Response
	fmt.Println("Response Code:", rr.Code)
	fmt.Println("Response Body:", rr.Body.String())
}
