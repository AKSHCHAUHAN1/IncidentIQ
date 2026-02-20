import pkg from "pg";
const { Pool } = pkg;

export const pool = new Pool({
  host: process.env.POSTGRES_HOST,
  port: 5432,
  user: "postgres",
  password: "postgres",
  database: "incident_predictor",
});

pool.on("connect", () => console.log("Postgres connected"));
pool.on("error", (err) => console.error("Postgres error:", err.message));
