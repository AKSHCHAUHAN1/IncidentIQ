import { Router } from "express";
import { pool } from "../db.js";

const router = Router();

// GET /api/predictions — list predictions for user sites only
router.get("/", async (req, res) => {
  try {
    const { service_id, severity, limit = 50, offset = 0 } = req.query;
    let conditions = [
      `(
        p.url IN (SELECT url FROM public.monitored_sites WHERE is_training_only = FALSE AND is_active = TRUE)
        OR p.service_id IN (
          SELECT DISTINCT
            CASE
              WHEN position('://' IN ms.url) > 0
                THEN split_part(split_part(ms.url, '://', 2), '/', 1)
              ELSE split_part(ms.url, '/', 1)
            END
          FROM public.monitored_sites ms
          WHERE ms.is_training_only = FALSE AND ms.is_active = TRUE
        )
      )`
    ];
    let params = [];
    let i = 1;

    if (service_id) { conditions.push(`p.service_id = $${i++}`); params.push(service_id); }
    if (severity)   { conditions.push(`p.severity = $${i++}`);   params.push(severity);   }

    const where = `WHERE ${conditions.join(" AND ")}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(
      `SELECT p.* FROM ml.predictions p ${where} ORDER BY p.created_at DESC LIMIT $${i++} OFFSET $${i++}`,
      params
    );
    const count = await pool.query(
      `SELECT COUNT(*) FROM ml.predictions p ${where}`,
      params.slice(0, -2)
    );
    res.json({ success: true, predictions: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    console.error("[predictions GET /] error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/predictions/:id
router.get("/:id", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM ml.predictions WHERE id=$1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, prediction: r.rows[0] });
  } catch (err) {
    console.error("[predictions GET /:id] error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;