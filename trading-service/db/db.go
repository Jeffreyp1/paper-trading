package db

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/joho/godotenv"
	_ "github.com/lib/pq" // PostgreSQL driver
)

var DB *sql.DB

func InitDB() {
	envPath, _ := filepath.Abs("../.env") // Go up one level
	err := godotenv.Load(envPath)
	if err != nil {
		log.Println("Could not find .env")
	}
	connStr := fmt.Sprintf(
		"host=%s port=%s user=%s password=%s dbname=%s sslmode=disable",
		os.Getenv("DB_HOST"),
		os.Getenv("DB_PORT"),
		os.Getenv("DB_USER"),
		os.Getenv("DB_PASSWORD"),
		os.Getenv("DB_DATABASE"),
	)

	var error error
	DB, error = sql.Open("postgres", connStr)
	if error != nil {
		log.Fatalf("Failed to connect to DB: %v", err)

	}

	err = DB.Ping()
	if err != nil {
		log.Fatalf("Database is unreacheable %v", err)
	}

	log.Println("Connected to PostgreSQL!!")
}

// func main() {
// 	initDB()
// 	defer dbConn.Close()
// }
