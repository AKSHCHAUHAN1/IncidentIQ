import pkg from "pg";
const { Pool } = pkg;

export const pool = new Pool({
  host:     process.env.DB_HOST     || "postgres",
  port:     parseInt(process.env.DB_PORT || "5432"),
  user:     process.env.DB_USER     || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME     || "incident_predictor",
});

pool.on("connect", () => console.log("API Gateway: DB connected"));
pool.on("error",   (err) => console.error("DB error:", err.message));