import { Router } from "express";
import { pool } from "../db.js";

const router = Router();

// GET /api/incidents — list incidents for user sites only
router.get("/", async (req, res) => {
  try {
    const { service_id, status, severity, limit = 50, offset = 0 } = req.query;
    let conditions = [
      `i.service_id IN (
        SELECT DISTINCT
          CASE
            WHEN position('://' IN ms.url) > 0
              THEN split_part(split_part(ms.url, '://', 2), '/', 1)
            ELSE split_part(ms.url, '/', 1)
          END
        FROM public.monitored_sites ms
        WHERE ms.is_active = TRUE
      )`
    ];
    let params = [];
    let i = 1;

    if (service_id) { conditions.push(`i.service_id=$${i++}`); params.push(service_id); }
    if (status)     { conditions.push(`i.status=$${i++}`);     params.push(status); }
    if (severity)   { conditions.push(`i.severity=$${i++}`);   params.push(severity); }

    const where = `WHERE ${conditions.join(" AND ")}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(
      `SELECT i.id, COALESCE(p.url, i.service_id) AS url, i.root_cause AS anomaly_type, i.confidence,
              i.predicted_at AS started_at, i.resolved_at, i.status, i.severity,
              i.service_id,
              CASE
                WHEN i.resolved_at IS NOT NULL
                THEN ROUND(EXTRACT(EPOCH FROM (i.resolved_at - i.predicted_at)) / 60)
                ELSE NULL
              END AS duration_min
       FROM incidents.incidents i
       LEFT JOIN ml.predictions p ON p.id = i.prediction_id
       ${where}
       ORDER BY i.predicted_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      params
    );

    const count = await pool.query(
      `SELECT COUNT(*) FROM incidents.incidents i ${where}`,
      params.slice(0, -2)
    );

    res.json({ success: true, incidents: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    console.error("[incidents GET /] error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/incidents/:id — full detail
router.get("/:id", async (req, res) => {
  try {
    const inc = await pool.query(
      `SELECT i.id, COALESCE(p.url, i.service_id) AS url, i.root_cause AS anomaly_type, i.confidence,
              i.predicted_at AS started_at, i.resolved_at, i.status, i.severity,
              i.service_id, i.metrics_snapshot,
              CASE
                WHEN i.resolved_at IS NOT NULL
                THEN ROUND(EXTRACT(EPOCH FROM (i.resolved_at - i.predicted_at)) / 60)
                ELSE NULL
              END AS duration_min
       FROM incidents.incidents i
       LEFT JOIN ml.predictions p ON p.id = i.prediction_id
       WHERE i.id=$1`,
      [req.params.id]
    );
    if (!inc.rows.length) return res.status(404).json({ success: false, error: "Not found" });

    res.json({ success: true, incident: inc.rows[0] });
  } catch (err) {
    console.error("[incidents GET /:id] error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/incidents/:id — mark as action_taken or ignored
router.patch("/:id", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["action_taken", "ignored"].includes(status)) {
      return res.status(400).json({ success: false, error: "status must be 'action_taken' or 'ignored'" });
    }

    const r = await pool.query(
      `UPDATE incidents.incidents SET status = $1, resolved_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [status, req.params.id]
    );

    if (!r.rows.length) {
      return res.status(404).json({ success: false, error: "Incident not found" });
    }

    // Also update linked prediction if one exists
    if (r.rows[0].prediction_id) {
      await pool.query(
        `UPDATE ml.predictions SET status = $1, actioned_at = NOW()
         WHERE id = $2`,
        [status, r.rows[0].prediction_id]
      );
    }

    console.log(`[incidents PATCH] ${req.params.id} → ${status}`);
    res.json({ success: true, incident: r.rows[0] });
  } catch (err) {
    console.error("[incidents PATCH] error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;