import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const REMEDIATION_URL =
  process.env.REMEDIATION_URL || "http://remediation-engine:6000/act";

function classifySeverity(predictionData) {
  const future = predictionData?.prediction;

  if (!future || future.length === 0) return "normal";

  // use last predicted timestep
  const last = future[future.length - 1];

  const cpu = last[0];
  const memory = last[1];
  const requestRate = last[2];
  const errorRate = last[3];
  const latency = last[4];

  if (cpu > 85 || memory > 85 || errorRate > 20 || latency > 300) {
    return "critical";
  }

  if (cpu > 70 || memory > 75 || errorRate > 10 || latency > 200) {
    return "warning";
  }

  return "normal";
}

app.post("/evaluate", async (req, res) => {
  try {
    const { service_id, prediction } = req.body;

    const severity = classifySeverity(prediction);

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