// server/server.go

package server

import (
	"encoding/json" // for JSON parsing
	"net/http" // for HTTP server

	"github.com/go-chi/chi/v5" // lightweight router
	"github.com/go-chi/chi/v5/middleware" // common middleware functions

	trade "trading-service/services/trade"
	"trading-service/services/workers"
)

// SetupRouter sets up HTTP routes and returns the router
func SetupRouter() http.Handler {
	r := chi.NewRouter() // initialize new chi router

	r.Use(middleware.Logger) // logs every HTTP request
	r.Use(middleware.AllowContentType("application/json")) // ensures request content type is JSON

	// health check endpoint
	r.Get("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("✅ Trading microservice is running"))
	})

	// endpoint to submit a trade
	r.Post("/api/trade", func(w http.ResponseWriter, r *http.Request) {
		var tradeReq trade.TradeRequest
		if err := json.NewDecoder(r.Body).Decode(&tradeReq); err != nil {
			http.Error(w, "❌ Invalid JSON", http.StatusBadRequest)
			return
		}

		// enqueue the trade for async processing
		select {
		case workers.TradeJobQueue <- workers.TradeJob{Trade: tradeReq}:
			w.WriteHeader(http.StatusAccepted) // 202 - Accepted
			w.Write([]byte("🟢 Trade enqueued successfully"))
		default:
			http.Error(w, "🚫 Trade queue is full", http.StatusServiceUnavailable)
		}
	})

	return r // return configured router
}
