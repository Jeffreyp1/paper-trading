// db.js
import pkg from 'pg';
import 'dotenv/config';

const {Pool} = pkg

const pool = new Pool({
  user: process.env.DB_USER, // Username for the database
  host: process.env.DB_HOST, // Database host
  database: process.env.DB_DATABASE, // Database name
  password: process.env.DB_PASSWORD, // Password for the database
  port: process.env.DB_PORT, // Database port, usually 5432
});

export default pool; // Export the pool object