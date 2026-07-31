import pkg from "pg";
const { Pool } = pkg;

export const pool = new Pool({
  host:     process.env.DB_HOST     || "postgres",
  port:     parseInt(process.env.DB_PORT || "5432"),
  user:     process.env.DB_USER     || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME     || "incident_predictor",
  max:                     20,
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 5000,
});

pool.on("connect", () => console.log("API Gateway: DB connected"));
pool.on("error",   (err) => console.error("DB error:", err.message));