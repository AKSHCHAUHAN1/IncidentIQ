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
import sitesRouter       from "./routes/sites.js";
import { pool } from "./db.js";

const app = express();
const httpServer = createServer(app);

app.use(cors());
app.use(express.json());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500 }));

initWebSocket(httpServer);

// ── Auth ──────────────────────────────────────────────────────
// Dev mode: any credentials work
app.post("/auth/login", (req, res) => {
  const { username = "admin" } = req.body;
  res.json({ token: generateToken({ username, role: "admin" }), username });
});

// ── Health ────────────────────────────────────────────────────
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "healthy", timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: "unhealthy", error: err.message });
  }
});

// ── ML service health proxy (avoids CORS from browser) ───────
app.get("/api/ml/health", authMiddleware, async (req, res) => {
  try {
    const r = await fetch("http://ml-service:8000/health");
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(503).json({
      lstm_loaded:     false,
      iso_loaded:      false,
      log_loaded:      false,
      baseline_loaded: false,
      error:           err.message,
    });
  }
});

// ── API routes ────────────────────────────────────────────────
app.use("/api/predictions", authMiddleware, predictionsRouter);
app.use("/api/incidents",   authMiddleware, incidentsRouter);
app.use("/api/approvals",   authMiddleware, approvalsRouter);
app.use("/api/analytics",   authMiddleware, analyticsRouter);
app.use("/api/sites",       authMiddleware, sitesRouter);

app.get("/api/metrics/live", authMiddleware, async (req, res) => {
  try {
    const { url, limit = 60 } = req.query;
    let result;
    if (url) {
      result = await pool.query(
        `SELECT probed_at as time, ttfb_ms, dns_ms, tcp_ms, tls_ms, error_rate, ssl_days_left, status_code
         FROM metrics.probe_readings
         WHERE url=$1 AND probed_at > NOW()-INTERVAL '15 minutes'
         ORDER BY probed_at ASC
         LIMIT $2`,
        [url, parseInt(limit)]
      );
    } else {
      result = await pool.query(
        `SELECT probed_at as time, url, ttfb_ms, dns_ms, tcp_ms, tls_ms, error_rate, ssl_days_left, status_code
         FROM metrics.probe_readings
         WHERE probed_at > NOW()-INTERVAL '15 minutes'
         ORDER BY probed_at ASC
         LIMIT $1`,
        [parseInt(limit)]
      );
    }
    res.json({ metrics: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/services", authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT url, MAX(probed_at) as last_seen, COUNT(*) as metric_count
       FROM metrics.probe_readings WHERE probed_at > NOW()-INTERVAL '1 hour'
       GROUP BY url ORDER BY last_seen DESC`
    );
    res.json({ services: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `${req.method} ${req.path} not found` }));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`API Gateway running on port ${PORT}`);
});