import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const REMEDIATION_URL =
  process.env.REMEDIATION_URL || "http://remediation-engine:6000/act";

/**
 * Compare actual current metrics vs predicted baseline
 * If deviation is high → anomaly
 */
function classifySeverity(predictionData, currentMetrics) {
  const future = predictionData?.prediction;
  if (!future || future.length === 0) return "normal";

  const predicted = future[0]; // next-step forecast

  const cpuDeviation = Math.abs(currentMetrics.cpu - predicted[0]);
  const memoryDeviation = Math.abs(currentMetrics.memory - predicted[1]);
  const errorDeviation = Math.abs(currentMetrics.error_rate - predicted[3]);
  const latencyDeviation = Math.abs(currentMetrics.latency - predicted[4]);

  if (
    cpuDeviation > 30 ||
    memoryDeviation > 30 ||
    errorDeviation > 15 ||
    latencyDeviation > 150
  ) {
    return "critical";
  }

  if (
    cpuDeviation > 15 ||
    memoryDeviation > 15 ||
    errorDeviation > 8 ||
    latencyDeviation > 80
  ) {
    return "warning";
  }

  return "normal";
}

app.post("/evaluate", async (req, res) => {
  try {
    const { service_id, prediction, current_metrics } = req.body;

    const severity = classifySeverity(prediction, current_metrics);

    console.log("Decision:", service_id, severity);

    if (severity !== "normal") {
      await fetch(REMEDIATION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service_id,
          severity,
          prediction,
        }),
      });
    }

    res.json({ status: "evaluated", severity });
  } catch (err) {
    console.error("Decision error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(5000, () =>
  console.log("Decision Engine running on port 5000")
);