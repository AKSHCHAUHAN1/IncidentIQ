import express from "express";
import fetch from "node-fetch";
import pkg from "pg";
const { Pool } = pkg;
import { randomUUID } from "crypto";

const app = express();
app.use(express.json());

const API_GATEWAY_URL = process.env.API_GATEWAY_URL || "http://api-gateway:3000";
const SLA_TTFB_MS = parseFloat(process.env.SLA_TTFB_MS || "2000");

const pool = new Pool({
  host:     process.env.DB_HOST     || "postgres",
  port:     parseInt(process.env.DB_PORT || "5432"),
  user:     process.env.DB_USER     || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME     || "incident_predictor",
  max:                 20,
  idleTimeoutMillis:   30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => console.error("[Decision] DB pool error:", err.message));

// ── Notify API Gateway (fires WebSocket event to frontend) ────
async function notify(type, data) {
  try {
    console.log(`[Decision] Notifying gateway: type=${type}, url=${data?.url || data?.service_id}`);
    await fetch(`${API_GATEWAY_URL}/internal/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, data }),
    });
  } catch (err) {
    console.warn("[Decision] Gateway notify failed:", err.message);
  }
}

// ── Check if URL is training-only ────────────────────────────
async function isTrainingOnly(url) {
  if (!url) return false;
  try {
    const result = await pool.query(
      `SELECT is_training_only FROM public.monitored_sites WHERE url = $1`,
      [url]
    );
    if (result.rows.length > 0) {
      return result.rows[0].is_training_only === true;
    }
    return false;
  } catch (err) {
    console.warn("[Decision] is_training_only check failed:", err.message);
    return false;
  }
}

function clamp01(v) {
  return Math.max(0, Math.min(v, 0.99));
}

function deriveRootCause(currentMetrics, prediction) {
  if (prediction?.root_cause && prediction.root_cause !== "normal") {
    return prediction.root_cause;
  }

  const ttfb = Number(currentMetrics?.ttfb_ms || 0);
  const dns = Number(currentMetrics?.dns_ms || 0);
  const error = Number(currentMetrics?.error_rate || 0);
  const ssl = Number(currentMetrics?.ssl_days_left || 365);
  const status = Number(currentMetrics?.status_code || 200);

  if (ssl < 14) return "ssl_expiry_warning";
  if (status >= 500 || error >= 0.10) return "error_spike";

  const ratio = ttfb / Math.max(dns, 1);
  if (dns >= 250 && ratio <= 3.5) return "dns_degradation";
  if (ttfb >= 1200 && ratio >= 5) return "origin_slowdown";
  if (ttfb >= 900) return "latency_spike";
  return "normal";
}

function computeConfidence(prediction, currentMetrics) {
  const ttfb = Number(currentMetrics?.ttfb_ms || 0);
  const dns = Number(currentMetrics?.dns_ms || 0);
  const error = Number(currentMetrics?.error_rate || 0);
  const breachEta = Number(prediction?.breach_eta_min || 0);
  const modelConfidence = Number(prediction?.confidence || 0);
  const status = Number(currentMetrics?.status_code || 200);

  // Metric-based confidence score
  let metricScore = 0.15;
  metricScore += Math.min(ttfb / SLA_TTFB_MS, 1) * 0.30;
  metricScore += Math.min(dns / 300, 1) * 0.10;
  metricScore += Math.min(error / 0.50, 1) * 0.20;  // error_rate is 0.0–1.0 fraction
  metricScore += prediction?.iso_flag === -1 ? 0.15 : 0;
  metricScore += breachEta > 0 && breachEta <= 30 ? 0.15 : 0;
  // Only 5xx and connection failures boost confidence (4xx from WAFs/bot-protection is expected)
  if (status >= 500 || status === 0) metricScore += 0.25;
  // High TTFB (over 50% SLA) adds urgency
  if (ttfb > SLA_TTFB_MS * 0.5) metricScore += 0.10;

  // Blend metric score with ML model confidence (model gets 40% weight)
  const blended = metricScore * 0.6 + modelConfidence * 0.4;

  return clamp01(Math.max(blended, modelConfidence));
}

function deriveSeverity(prediction, currentMetrics, confidence) {
  if (["critical", "warning", "normal"].includes(prediction?.severity)) {
    return prediction.severity;
  }

  const ttfb = Number(currentMetrics?.ttfb_ms || 0);
  const error = Number(currentMetrics?.error_rate || 0);
  const breachEta = Number(prediction?.breach_eta_min || 0);

  if (breachEta > 0 && breachEta <= 10) return "critical";
  if (ttfb >= SLA_TTFB_MS || error >= 0.15 || confidence >= 0.85) return "critical";
  if (breachEta > 0 && breachEta <= 30) return "warning";
  if (ttfb >= SLA_TTFB_MS * 0.7 || error >= 0.05 || confidence >= 0.55) return "warning";
  return "normal";
}

function buildRootCauseMessage(url, rootCause, currentMetrics, breachEtaMin) {
  const explanations = {
    ssl_expiry_warning: `SSL certificate for ${url} expires in ${Math.round(currentMetrics?.ssl_days_left || 0)} days`,
    error_spike: `Error rate spiked to ${(currentMetrics?.error_rate || 0).toFixed(1)}% with status ${currentMetrics?.status_code || 'unknown'}`,
    dns_degradation: `DNS resolution degraded to ${Math.round(currentMetrics?.dns_ms || 0)}ms`,
    origin_slowdown: `Origin server slowdown — TTFB ${Math.round(currentMetrics?.ttfb_ms || 0)}ms`,
    latency_spike: `Latency spike — TTFB ${Math.round(currentMetrics?.ttfb_ms || 0)}ms`,
    normal: `All metrics within normal bounds`,
  };
  const explanation = explanations[rootCause] || rootCause;
  const etaPart = breachEtaMin ? ` Estimated SLA breach in ${breachEtaMin} minutes.` : "";
  return `${rootCause.replace(/_/g, " ")} detected on ${url}. ${explanation}.${etaPart}`;
}

async function savePrediction(serviceId, url, severity, confidence, predictionData) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO ml.predictions (id, service_id, url, model_name, severity, confidence, prediction_data, outcome, status)
     VALUES ($1,$2,$3,'sla-ensemble',$4,$5,$6,'pending','open')`,
    [id, serviceId, url, severity, confidence, JSON.stringify(predictionData)]
  );
  console.log(`[Decision] Saved prediction ${id} for ${url} (severity=${severity}, confidence=${(confidence * 100).toFixed(1)}%)`);
  return id;
}

async function saveIncident(serviceId, url, severity, confidence, predictionId, metricsSnapshot, rootCause) {
  const id = `INC-${randomUUID().split('-')[0]}`;
  await pool.query(
    `INSERT INTO incidents.incidents (
       id, service_id, url, severity, confidence, prediction_id, root_cause, metrics_snapshot, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open')`,
    [id, serviceId, url, severity, confidence, predictionId, rootCause, JSON.stringify(metricsSnapshot)]
  );
  console.log(`[Decision] Saved incident ${id} for ${url}`);
  return id;
}

app.post("/evaluate", async (req, res) => {
  try {
    const { service_id, prediction = {}, current_metrics = {}, url } = req.body;

    if (!service_id) {
      return res.status(400).json({ error: "service_id is required" });
    }

    // Resolve URL — from request body or derive from service_id
    const resolvedUrl = url || current_metrics?.url || null;

    // ── CHECK: is this URL training-only? ──
    if (resolvedUrl) {
      const training = await isTrainingOnly(resolvedUrl);
      if (training) {
        console.log(`[Decision] SKIP (training-only): ${resolvedUrl}`);
        return res.json({ status: "skipped_training", service_id, url: resolvedUrl });
      }
    }

    const confidence = computeConfidence(prediction, current_metrics);
    const severity = deriveSeverity(prediction, current_metrics, confidence);
    const rootCause = deriveRootCause(current_metrics, prediction);
    const message = buildRootCauseMessage(resolvedUrl || service_id, rootCause, current_metrics, prediction?.breach_eta_min);

    console.log(`[Decision] ${service_id} | url=${resolvedUrl} | severity=${severity} | confidence=${(confidence * 100).toFixed(1)}% | root_cause=${rootCause}`);

    // ── confidence < 0.70 → log only, no DB insert ──
    if (confidence < 0.70) {
      console.log(`[Decision] LOW CONFIDENCE (${(confidence * 100).toFixed(1)}%) — log only`);
      return res.json({ status: "normal", confidence, severity, root_cause: rootCause, url: resolvedUrl });
    }

    // Save prediction for all user-site results with confidence >= 0.70
    const predictionId = await savePrediction(service_id, resolvedUrl, severity, confidence, {
      ...prediction,
      root_cause: rootCause,
      message,
    });

    // ── confidence >= 0.90 → incident + new_alert ──
    if (confidence >= 0.90) {
      const incidentId = await saveIncident(service_id, resolvedUrl, severity, confidence, predictionId, current_metrics, rootCause);
      console.log(`[Decision] ALERT FIRED: ${service_id} | root_cause=${rootCause} | confidence=${(confidence * 100).toFixed(1)}%`);

      notify("new_alert", {
        url: resolvedUrl,
        anomaly_type: rootCause,
        confidence,
        ttfb_ms: current_metrics?.ttfb_ms ?? 0,
        message,
        incident_id: incidentId,
        service_id,
      });

      // Also emit as new_prediction
      notify("new_prediction", {
        url: resolvedUrl,
        anomaly_type: rootCause,
        confidence,
        predicted_at: new Date().toISOString(),
        service_id,
        severity,
        prediction_id: predictionId,
      });

      return res.json({
        status: "alert_fired",
        confidence,
        severity,
        incident_id: incidentId,
        prediction_id: predictionId,
        root_cause: rootCause,
        url: resolvedUrl,
      });
    }

    // ── confidence 0.70–0.89 → new_prediction (approval queue) ──
    console.log(`[Decision] PREDICTION (approval queue): ${service_id} | confidence=${(confidence * 100).toFixed(1)}%`);

    notify("new_prediction", {
      url: resolvedUrl,
      anomaly_type: rootCause,
      confidence,
      predicted_at: new Date().toISOString(),
      service_id,
      severity,
      prediction_id: predictionId,
    });

    return res.json({
      status: "pending_approval",
      confidence,
      severity,
      prediction_id: predictionId,
      root_cause: rootCause,
      url: resolvedUrl,
    });

  } catch (err) {
    console.error("[Decision] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "running", db: "connected" });
  } catch (err) {
    res.status(503).json({ status: "unhealthy", error: err.message });
  }
});

const server = app.listen(5000, () => console.log("Decision Engine running on port 5000"));

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[Decision] Shutting down...");
  server.close();
  await pool.end();
  process.exit(0);
});