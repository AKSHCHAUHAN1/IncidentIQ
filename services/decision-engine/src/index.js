import express from "express";
import fetch from "node-fetch";
import pkg from "pg";
const { Pool } = pkg;
import { randomUUID } from "crypto";

const app = express();
app.use(express.json());

const REMEDIATION_URL  = process.env.REMEDIATION_URL  || "http://remediation-engine:6000/act";
const API_GATEWAY_URL  = process.env.API_GATEWAY_URL  || "http://api-gateway:3000";

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

// ── Confidence Scoring ────────────────────────────────────────
function computeConfidence(prediction, currentMetrics) {
  const thresholds = {
    cpu:          { warn: 70,   crit: 90,   weight: 1.5 },
    memory:       { warn: 75,   crit: 90,   weight: 1.5 },
    error_rate:   { warn: 10,   crit: 25,   weight: 2.0 },
    latency:      { warn: 200,  crit: 400,  weight: 1.0 },
    request_rate: { warn: 1000, crit: 1400, weight: 0.8 },
  };

  function scoreValues(values) {
    let total = 0, weight = 0;
    for (const [metric, { warn, crit, weight: w }] of Object.entries(thresholds)) {
      const val = values[metric];
      if (val == null) continue;
      let score = 0;
      if (val >= crit)      score = 0.8 + 0.2 * Math.min((val - crit) / crit, 1);
      else if (val >= warn) score = 0.4 + 0.4 * ((val - warn) / (crit - warn));
      else                  score = Math.max(0, val / warn) * 0.3;
      total  += score * w;
      weight += w;
    }
    return weight > 0 ? Math.min(total / weight, 1.0) : 0;
  }

  const currentScore = scoreValues(currentMetrics);

  let predScore = 0;
  const future = prediction?.prediction;
  if (future?.length) {
    const worst = future[future.length - 1];
    const [cpu, memory, request_rate, error_rate, latency] = worst;
    predScore = scoreValues({ cpu, memory, request_rate, error_rate, latency });
  }

  return Math.max(currentScore, predScore);
}

function selectAction(currentMetrics) {
  if (currentMetrics.memory > 85)     return "restart";
  if (currentMetrics.cpu > 90)        return "restart";
  if (currentMetrics.error_rate > 20) return "restart";
  return "restart";
}

async function savePrediction(serviceId, severity, confidence, predictionData) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO ml.predictions (id, service_id, severity, confidence, prediction_data, outcome)
     VALUES ($1,$2,$3,$4,$5,'pending')`,
    [id, serviceId, severity, confidence, JSON.stringify(predictionData)]
  );
  return id;
}

async function saveIncident(serviceId, severity, confidence, predictionId, metricsSnapshot) {
  const id = `INC-${Date.now()}`;
  await pool.query(
    `INSERT INTO incidents.incidents (id, service_id, severity, confidence, prediction_id, metrics_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, serviceId, severity, confidence, predictionId, JSON.stringify(metricsSnapshot)]
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

app.post("/evaluate", async (req, res) => {
  try {
    const { service_id, prediction, current_metrics } = req.body;

    const confidence = computeConfidence(prediction, current_metrics);
    const severity   = confidence >= 0.6 ? "critical"
                     : confidence >= 0.35 ? "warning"
                     : "normal";

    console.log(`[Decision] ${service_id} | severity=${severity} | confidence=${(confidence * 100).toFixed(1)}%`);

    if (severity === "normal") {
      return res.json({ status: "normal", confidence, severity });
    }

    const action       = selectAction(current_metrics);
    const predictionId = await savePrediction(service_id, severity, confidence, prediction);
    const incidentId   = await saveIncident(service_id, severity, confidence, predictionId, current_metrics);

    // Notify frontend of new prediction
    notify("prediction", { service_id, severity, confidence, incident_id: incidentId });

    if (confidence >= 0.9) {
      const remediationId = await saveRemediation(incidentId, service_id, action, confidence, true);
      await fetch(REMEDIATION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service_id, action, severity, remediationId, incidentId }),
      });
      console.log(`[Decision] AUTO-EXECUTED: ${action} on ${service_id}`);
      notify("remediation_done", { service_id, action, remediationId });
      return res.json({ status: "auto_executed", confidence, severity, action, incident_id: incidentId });
    }

    if (confidence >= 0.7) {
      const remediationId = await saveRemediation(incidentId, service_id, action, confidence, false);
      console.log(`[Decision] PENDING APPROVAL: ${action} on ${service_id}`);
      // Notify frontend that approval is needed
      notify("approval_needed", { service_id, action, confidence, remediationId, incidentId });
      return res.json({ status: "pending_approval", confidence, severity, action, incident_id: incidentId, remediation_id: remediationId });
    }

    console.log(`[Decision] ALERT ONLY: ${service_id}`);
    return res.json({ status: "alert_only", confidence, severity, incident_id: incidentId });

  } catch (err) {
    console.error("Decision error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "running" }));

app.listen(5000, () => console.log("Decision Engine running on port 5000"));