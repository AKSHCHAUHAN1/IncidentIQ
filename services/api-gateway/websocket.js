import { Server } from "socket.io";
import { pool } from "./db.js";

let io;

export function initWebSocket(httpServer) {
  io = new Server(httpServer, { cors: { origin: "*" } });
  io.on("connection", (socket) => {
    console.log("WS client connected:", socket.id);
    socket.on("disconnect", () => console.log("WS disconnected:", socket.id));
  });

  // Emit metrics_update every 60 seconds
  setInterval(async () => {
    try {
      const counts = await computeMetricsCounts();
      io.emit("metrics_update", counts);
      console.log("[WS] metrics_update emitted:", counts);
    } catch (err) {
      console.error("[WS] metrics_update error:", err.message);
    }
  }, 60_000);

  console.log("WebSocket server ready");
  return io;
}

async function computeMetricsCounts() {
  // Count user-added site statuses from latest probe readings
  const result = await pool.query(`
    WITH user_sites AS (
      SELECT url FROM public.monitored_sites WHERE is_training_only = FALSE AND is_active = TRUE
    ),
    latest AS (
      SELECT DISTINCT ON (pr.url) pr.url, pr.ttfb_ms, pr.error_rate, pr.status_code
      FROM metrics.probe_readings pr
      JOIN user_sites us ON us.url = pr.url
      ORDER BY pr.url, pr.probed_at DESC
    )
    SELECT
      COUNT(*) FILTER (WHERE ttfb_ms < 2000 AND COALESCE(error_rate, 0) < 0.1 AND COALESCE(status_code, 200) < 500) AS sites_up,
      COUNT(*) FILTER (WHERE (ttfb_ms BETWEEN 1000 AND 2000 OR (error_rate BETWEEN 0.05 AND 0.1)) AND COALESCE(status_code, 200) < 500) AS degraded,
      COUNT(*) FILTER (WHERE ttfb_ms >= 2000 OR COALESCE(error_rate, 0) >= 0.1 OR COALESCE(status_code, 200) >= 500) AS down
    FROM latest
  `);

  const pendingResult = await pool.query(`
    SELECT COUNT(*) FROM ml.predictions p
    JOIN public.monitored_sites ms ON ms.url = p.url
    WHERE p.status = 'open'
      AND p.confidence BETWEEN 0.70 AND 0.89
      AND ms.is_training_only = FALSE
  `);

  return {
    sites_up: parseInt(result.rows[0]?.sites_up || 0),
    degraded: parseInt(result.rows[0]?.degraded || 0),
    down: parseInt(result.rows[0]?.down || 0),
    pending_approvals: parseInt(pendingResult.rows[0]?.count || 0),
  };
}

// ── Event emitters ────────────────────────────────────────────
export function emitNewPrediction(data) {
  console.log("[WS] Emitting new_prediction:", data.url);
  io?.emit("new_prediction", data);
}

export function emitNewAlert(data) {
  console.log("[WS] Emitting new_alert:", data.url);
  io?.emit("new_alert", data);
}

export function emitMetricsUpdate(data) {
  console.log("[WS] Emitting metrics_update");
  io?.emit("metrics_update", data);
}

// Legacy compat
export function emitPrediction(data)      { emitNewPrediction(data); }
export function emitApprovalNeeded(data)   { emitNewPrediction(data); }
export function emitRemediationDone(data)  { /* no-op, legacy */ }