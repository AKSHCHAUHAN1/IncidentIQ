import express from "express";
import cors from "cors";
import { createServer } from "http";
import rateLimit from "express-rate-limit";
import { generateToken, authMiddleware } from "./auth.js";
import { initWebSocket, emitPrediction, emitApprovalNeeded, emitRemediationDone } from "./websocket.js";
import predictionsRouter from "./routes/predictions.js";
import incidentsRouter   from "./routes/incidents.js";
import approvalsRouter   from "./routes/approvals.js";
import analyticsRouter   from "./routes/analytics.js";
import { pool } from "./db.js";

const app = express();
const httpServer = createServer(app);

app.use(cors());
app.use(express.json());
app.use(rateLimit({ windowMs: 15*60*1000, max: 500 }));

initWebSocket(httpServer);

// Login — dev mode accepts any credentials
app.post("/auth/login", (req, res) => {
  const { username = "admin" } = req.body;
  res.json({ token: generateToken({ username, role: "admin" }), username });
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "healthy", timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: "unhealthy", error: err.message });
  }
});

app.use("/api/predictions", authMiddleware, predictionsRouter);
app.use("/api/incidents",   authMiddleware, incidentsRouter);
app.use("/api/approvals",   authMiddleware, approvalsRouter);
app.use("/api/analytics",   authMiddleware, analyticsRouter);

app.get("/api/metrics/live", authMiddleware, async (req, res) => {
  try {
    const { service_id = "service-a", limit = 60 } = req.query;
    const result = await pool.query(
      `SELECT time_bucket('10 seconds', time) as bucket, metric_name, AVG(value) as value
       FROM metrics.raw_metrics
       WHERE service_id=$1 AND time > NOW()-INTERVAL '15 minutes'
       GROUP BY bucket, metric_name ORDER BY bucket ASC`,
      [service_id]
    );
    const buckets = {};
    for (const row of result.rows) {
      if (!buckets[row.bucket]) buckets[row.bucket] = { time: row.bucket };
      buckets[row.bucket][row.metric_name] = parseFloat(row.value);
    }
    res.json({ metrics: Object.values(buckets).slice(-parseInt(limit)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/services", authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT service_id, MAX(time) as last_seen, COUNT(*) as metric_count
       FROM metrics.raw_metrics WHERE time > NOW()-INTERVAL '1 hour'
       GROUP BY service_id`
    );
    res.json({ services: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── Internal webhook — decision engine → WebSocket relay ─────
// No auth — internal Docker network only
app.post("/internal/event", (req, res) => {
  const { type, data } = req.body;
  if      (type === "prediction")       emitPrediction(data);
  else if (type === "approval_needed")  emitApprovalNeeded(data);
  else if (type === "remediation_done") emitRemediationDone(data);
  res.json({ ok: true });
});

app.use((req, res) => res.status(404).json({ error: `${req.method} ${req.path} not found` }));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`API Gateway running on port ${PORT}`);
  console.log("POST /auth/login | GET /health | GET /api/metrics/live");
  console.log("GET|POST /api/predictions | /api/incidents | /api/approvals | /api/analytics");
});