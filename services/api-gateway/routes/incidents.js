import { Router } from "express";
import { pool } from "../db.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const { service_id, status, severity, limit = 50, offset = 0 } = req.query;
    let conditions = [], params = [], i = 1;
    if (service_id) { conditions.push(`i.service_id=$${i++}`); params.push(service_id); }
    if (status)     { conditions.push(`i.status=$${i++}`);     params.push(status);     }
    if (severity)   { conditions.push(`i.severity=$${i++}`);   params.push(severity);   }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(parseInt(limit), parseInt(offset));
    const result = await pool.query(
      `SELECT i.*, r.action as remediation_action, r.status as remediation_status, r.auto_executed
       FROM incidents.incidents i
       LEFT JOIN incidents.remediations r ON r.incident_id=i.id
       ${where} ORDER BY i.predicted_at DESC LIMIT $${i++} OFFSET $${i++}`,
      params
    );
    const count = await pool.query(`SELECT COUNT(*) FROM incidents.incidents i ${where}`, params.slice(0,-2));
    res.json({ incidents: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/:id", async (req, res) => {
  try {
    const inc = await pool.query("SELECT * FROM incidents.incidents WHERE id=$1", [req.params.id]);
    if (!inc.rows.length) return res.status(404).json({ error: "Not found" });
    const rem = await pool.query("SELECT * FROM incidents.remediations WHERE incident_id=$1", [req.params.id]);
    res.json({ incident: inc.rows[0], remediations: rem.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;