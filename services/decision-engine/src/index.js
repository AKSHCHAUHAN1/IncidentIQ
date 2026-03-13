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
});

// ── Notify API Gateway (fires WebSocket event to frontend) ────
async function notify(type, data) {
  try {
    await fetch(`${API_GATEWAY_URL}/internal/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, data }),
    });
  } catch (err) {
    console.warn("Gateway notify failed:", err.message);
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
  if (status >= 500 || error >= 10) return "error_spike";

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

  let confidence = 0.2;
  confidence += Math.min(ttfb / SLA_TTFB_MS, 1) * 0.35;
  confidence += Math.min(dns / 300, 1) * 0.15;
  confidence += Math.min(error / 20, 1) * 0.2;
  confidence += prediction?.iso_flag === -1 ? 0.15 : 0;
  confidence += breachEta > 0 && breachEta <= 30 ? 0.15 : 0;

  return clamp01(Math.max(confidence, modelConfidence));
}

function deriveSeverity(prediction, currentMetrics, confidence) {
  if (["critical", "warning", "normal"].includes(prediction?.severity)) {
    return prediction.severity;
  }

  const ttfb = Number(currentMetrics?.ttfb_ms || 0);
  const error = Number(currentMetrics?.error_rate || 0);
  const breachEta = Number(prediction?.breach_eta_min || 0);

  if (breachEta > 0 && breachEta <= 10) return "critical";
  if (ttfb >= SLA_TTFB_MS || error >= 15 || confidence >= 0.85) return "critical";
  if (breachEta > 0 && breachEta <= 30) return "warning";
  if (ttfb >= SLA_TTFB_MS * 0.7 || error >= 5 || confidence >= 0.55) return "warning";
  return "normal";
}

async function savePrediction(serviceId, severity, confidence, predictionData) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO ml.predictions (id, service_id, model_name, severity, confidence, prediction_data, outcome)
     VALUES ($1,$2,'sla-ensemble',$3,$4,$5,'pending')`,
    [id, serviceId, severity, confidence, JSON.stringify(predictionData)]
  );
  return id;
}

async function saveIncident(serviceId, severity, confidence, predictionId, metricsSnapshot, rootCause) {
  const id = `INC-${Date.now()}`;
  await pool.query(
    `INSERT INTO incidents.incidents (
       id, service_id, severity, confidence, prediction_id, root_cause, metrics_snapshot
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, serviceId, severity, confidence, predictionId, rootCause, JSON.stringify(metricsSnapshot)]
  );
  return id;
}

async function saveRemediation(incidentId, serviceId, action, confidence, autoExecuted) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO incidents.remediations (id, incident_id, service_id, action, confidence, auto_executed, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, incidentId, serviceId, action, confidence, autoExecuted, autoExecuted ? "executing" : "pending"]
  );
  return id;
}

function buildIncidentReport(serviceId, prediction, currentMetrics, rootCause) {
  return {
    service_id: serviceId,
    generated_at: new Date().toISOString(),
    root_cause: rootCause,
    breach_eta_min: prediction?.breach_eta_min ?? null,
    sla_threshold_ms: prediction?.sla_threshold_ms ?? SLA_TTFB_MS,
    forecast_ttfb_ms: prediction?.ttfb_forecast_ms ?? [],
    current_metrics: currentMetrics,
    probable_actions: [
      "Notify on-call via webhook/email",
      "Escalate if breach ETA <= 10 minutes",
      "Track DNS, origin latency, and error-rate deltas",
    ],
  };
}

app.post("/evaluate", async (req, res) => {
  try {
    const { service_id, prediction = {}, current_metrics = {} } = req.body;

    if (!service_id) {
      return res.status(400).json({ error: "service_id is required" });
    }

    const confidence = computeConfidence(prediction, current_metrics);
    const severity = deriveSeverity(prediction, current_metrics, confidence);
    const rootCause = deriveRootCause(current_metrics, prediction);
    const report = buildIncidentReport(service_id, prediction, current_metrics, rootCause);

    console.log(`[Decision] ${service_id} | severity=${severity} | confidence=${(confidence * 100).toFixed(1)}%`);

    const predictionId = await savePrediction(service_id, severity, confidence, {
      ...prediction,
      root_cause: rootCause,
    });

    if (severity === "normal") {
      return res.json({ status: "normal", confidence, severity, root_cause: rootCause, prediction_id: predictionId });
    }

    const action = "dispatch_alert_report";
    const incidentId = await saveIncident(service_id, severity, confidence, predictionId, current_metrics, rootCause);

    // Notify frontend of new prediction
    notify("prediction", {
      service_id,
      severity,
      confidence,
      incident_id: incidentId,
      root_cause: rootCause,
      breach_eta_min: prediction?.breach_eta_min ?? null,
    });

    if (severity === "critical" || confidence >= 0.85) {
      const remediationId = await saveRemediation(incidentId, service_id, action, confidence, true);
      console.log(`[Decision] ALERT DISPATCHED: ${service_id} | root_cause=${rootCause}`);
      notify("remediation_done", { service_id, action, remediationId, root_cause: rootCause, report });
      return res.json({
        status: "alert_dispatched",
        confidence,
        severity,
        action,
        incident_id: incidentId,
        root_cause: rootCause,
      });
    }

    const remediationId = await saveRemediation(incidentId, service_id, action, confidence, false);
    console.log(`[Decision] APPROVAL NEEDED: ${service_id} | root_cause=${rootCause}`);
    notify("approval_needed", {
      service_id,
      action,
      confidence,
      remediationId,
      incidentId,
      root_cause: rootCause,
      breach_eta_min: prediction?.breach_eta_min ?? null,
    });

    return res.json({
      status: "pending_approval",
      confidence,
      severity,
      action,
      incident_id: incidentId,
      remediation_id: remediationId,
      root_cause: rootCause,
    });

  } catch (err) {
    console.error("Decision error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "running" }));

app.listen(5000, () => console.log("Decision Engine running on port 5000"));