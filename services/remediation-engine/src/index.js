import express from "express";
import { exec } from "child_process";
import pkg from "pg";
const { Pool } = pkg;

const app = express();
app.use(express.json());

// ── DB ────────────────────────────────────────────────────────
const pool = new Pool({
  host:     process.env.DB_HOST     || "postgres",
  port:     parseInt(process.env.DB_PORT || "5432"),
  user:     process.env.DB_USER     || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME     || "incident_predictor",
});

// Map logical service IDs → real Docker container names
const containerMap = {
  "service-a": "incident-predictor-synthetic-generator-1",
  "service-b": "incident-predictor-data-ingestion-1",
  "service-c": "incident-predictor-ml-service-1",
};

// ── Safety Checks ─────────────────────────────────────────────
async function runSafetyChecks(serviceId, action) {
  const errors = [];

  // Check container exists
  const container = containerMap[serviceId];
  if (!container) {
    errors.push(`No container mapping for service: ${serviceId}`);
  }

  // Prevent restarting critical infrastructure
  const protected_services = ["postgres", "redis"];
  if (protected_services.includes(serviceId)) {
    errors.push(`Service ${serviceId} is protected and cannot be restarted`);
  }

  return errors;
}

// ── Execute Action ────────────────────────────────────────────
function executeAction(serviceId, action) {
  return new Promise((resolve, reject) => {
    const container = containerMap[serviceId];
    if (!container) {
      return reject(new Error(`No container mapping for: ${serviceId}`));
    }

    let cmd;
    switch (action) {
      case "restart":
        cmd = `docker restart ${container}`;
        break;
      default:
        cmd = `docker restart ${container}`;
    }

    console.log(`[Remediation] Executing: ${cmd}`);

    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

// ── Update Remediation Status in DB ──────────────────────────
async function updateRemediationStatus(remediationId, status, result) {
  if (!remediationId) return;
  await pool.query(
    `UPDATE incidents.remediations
     SET status=$1, result=$2, executed_at=NOW()
     WHERE id=$3`,
    [status, result, remediationId]
  );
}

async function updateIncidentStatus(incidentId, status) {
  if (!incidentId) return;
  await pool.query(
    `UPDATE incidents.incidents
     SET status=$1, resolved_at=NOW()
     WHERE id=$2`,
    [status, incidentId]
  );
}

// ── /act — main execution endpoint ───────────────────────────
app.post("/act", async (req, res) => {
  const { service_id, action, severity, remediationId, incidentId } = req.body;

  console.log(`[Remediation] Received: ${service_id} | action=${action} | severity=${severity}`);

  // Safety checks
  const errors = await runSafetyChecks(service_id, action);
  if (errors.length > 0) {
    console.warn("[Remediation] Safety check failed:", errors);
    await updateRemediationStatus(remediationId, "failed", errors.join("; "));
    return res.status(400).json({ status: "rejected", errors });
  }

  // Update status to executing
  await updateRemediationStatus(remediationId, "executing", null);

  try {
    const result = await executeAction(service_id, action);

    await updateRemediationStatus(remediationId, "success", result || "completed");
    await updateIncidentStatus(incidentId, "prevented");

    console.log(`[Remediation] SUCCESS: ${action} on ${service_id}`);

    res.json({ status: "success", service_id, action, result });

  } catch (err) {
    console.error("[Remediation] Execution failed:", err.message);

    await updateRemediationStatus(remediationId, "failed", err.message);
    await updateIncidentStatus(incidentId, "occurred");

    res.status(500).json({ status: "failed", error: err.message });
  }
});

// ── /approve — called by API Gateway when user approves ───────
app.post("/approve", async (req, res) => {
  const { service_id, action, remediationId, incidentId } = req.body;

  console.log(`[Remediation] APPROVED by user: ${service_id} | ${action}`);

  const errors = await runSafetyChecks(service_id, action);
  if (errors.length > 0) {
    await updateRemediationStatus(remediationId, "failed", errors.join("; "));
    return res.status(400).json({ status: "rejected", errors });
  }

  await updateRemediationStatus(remediationId, "executing", null);

  try {
    const result = await executeAction(service_id, action);

    await updateRemediationStatus(remediationId, "success", result || "completed");
    await updateIncidentStatus(incidentId, "prevented");

    res.json({ status: "success", service_id, action });

  } catch (err) {
    await updateRemediationStatus(remediationId, "failed", err.message);
    res.status(500).json({ status: "failed", error: err.message });
  }
});

// ── Health ────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "running" }));

app.listen(6000, () => console.log("Remediation Engine running on port 6000"));
