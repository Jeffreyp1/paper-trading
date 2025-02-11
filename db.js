// db.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER, // Username for the database
  host: process.env.DB_HOST, // Database host
  database: process.env.DB_DATABASE, // Database name
  password: process.env.DB_PASSWORD, // Password for the database
  port: process.env.DB_PORT, // Database port, usually 5432
});

module.exports = pool; // Export the pool object