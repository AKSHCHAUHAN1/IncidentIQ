import express from "express";
import { exec } from "child_process";

const app = express();
app.use(express.json());

// Map logical service IDs → real Docker container names
const containerMap = {
  "service-a": "synthetic-generator",
  "service-b": "data-ingestion",
  "service-c": "ml-service"
};

function restartService(serviceId) {
  const container = containerMap[serviceId];

  if (!container) {
    console.log("No container mapping found for:", serviceId);
    return;
  }

  exec(`docker restart ${container}`, (err, stdout, stderr) => {
    if (err) {
      console.error("Restart error:", err.message);
      return;
    }
    console.log("Restarted:", container);
  });
}

app.post("/act", (req, res) => {
  const { service_id, severity } = req.body;

  console.log("Remediation triggered:", service_id, severity);

  if (severity === "critical") {
    restartService(service_id);
  }

  if (severity === "warning") {
    console.log("Warning: monitoring service", service_id);
  }

  res.json({ status: "action triggered" });
});

app.listen(6000, () =>
  console.log("Remediation Engine running on port 6000")
);