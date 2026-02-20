import express from "express";
import { redis } from "./redis.js";
import { pool } from "./postgres.js";

export function startServer() {
  const app = express();

  app.get("/health/live", (req, res) => {
    res.status(200).json({ status: "alive" });
  });

  app.get("/health/ready", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      await redis.ping();
      res.status(200).json({ status: "ready" });
    } catch (err) {
      res.status(503).json({ status: "not ready", error: err.message });
    }
  });

  return app.listen(4000, () => {
    console.log("Health server running on port 4000");
  });
}
