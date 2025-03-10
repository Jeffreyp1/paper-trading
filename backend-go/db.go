package main

import (
	"database/sql"
	"fmt"
	"log"
	"os"

	_ "github.com/lib/pq" // PostgreSQL driver
)

var db *sql.DB

func initDB() {
	connStr := fmt.Sprintf(
		"host=%s port=%s user=%s password=%s dbname=%s sslmode=disable",
		os.Getenv("DB_HOST"),
		os.Getenv("DB_PORT"),
		os.Getenv("DB_USER"),
		os.Getenv("DB_PASSOWRD"),
		os.Getenv("DB_DATABASE"),
	)

	var err error
	db, err = sql.Open("postgres", connStr)
	if err != nil {
		log.Fatalf("Failed to connect to DB: %v", err)

	}

	err = db.Ping()
	if err != nil {
		log.Fatalf("Database is unreacheable %v", err)
	}

	log.Println("Connected to PostgreSQL!!")
}
