import { Router } from "express";
import { pool } from "../db.js";
import fetch from "node-fetch";

const router = Router();
const REMEDIATION_URL = process.env.REMEDIATION_URL || "http://remediation-engine:6000";

router.get("/", async (req, res) => {
  try {
    const { status = "pending" } = req.query;
    const result = await pool.query(
      `SELECT r.*, i.severity as incident_severity, i.metrics_snapshot, i.predicted_at
       FROM incidents.remediations r
       JOIN incidents.incidents i ON i.id=r.incident_id
       WHERE r.status=$1 ORDER BY r.created_at DESC`,
      [status]
    );
    res.json({ approvals: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/count", async (req, res) => {
  try {
    const r = await pool.query("SELECT COUNT(*) FROM incidents.remediations WHERE status='pending'");
    res.json({ count: parseInt(r.rows[0].count) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/:id/approve", async (req, res) => {
  try {
    const rem = await pool.query(
      "SELECT * FROM incidents.remediations WHERE id=$1 AND status='pending'", [req.params.id]
    );
    if (!rem.rows.length) return res.status(404).json({ error: "Not found or already processed" });
    await pool.query("UPDATE incidents.remediations SET status='approved' WHERE id=$1", [req.params.id]);
    const r = rem.rows[0];
    const exec = await fetch(`${REMEDIATION_URL}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service_id: r.service_id, action: r.action, remediationId: r.id, incidentId: r.incident_id }),
    });
    res.json({ status: "approved", result: await exec.json() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/:id/reject", async (req, res) => {
  try {
    const { reason = "Rejected by operator" } = req.body;
    const r = await pool.query(
      "UPDATE incidents.remediations SET status='rejected', reason=$1 WHERE id=$2 AND status='pending' RETURNING *",
      [reason, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found or already processed" });
    res.json({ status: "rejected", reason });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;