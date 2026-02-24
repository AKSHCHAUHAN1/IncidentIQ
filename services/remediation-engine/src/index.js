import express from "express";
import { exec } from "child_process";

const app = express();
app.use(express.json());

function restartService(service) {
  exec(`docker restart ${service}`, (err, stdout, stderr) => {
    if (err) {
      console.error("Restart error:", err.message);
      return;
    }
    console.log("Restarted:", service);
  });
}

app.post("/act", (req, res) => {
  const { service_id, severity } = req.body;

  console.log("Remediation triggered:", service_id, severity);

  if (severity === "critical") {
    restartService(service_id);
  }

  if (severity === "warning") {
    console.log("Warning: monitor service", service_id);
  }

  res.json({ status: "action triggered" });
});

app.listen(6000, () =>
  console.log("Remediation Engine running on port 6000")
);