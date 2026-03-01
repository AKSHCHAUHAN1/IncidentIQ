import { Router } from "express";
import { pool } from "../db.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const { service_id, severity, limit = 50, offset = 0 } = req.query;
    let conditions = [], params = [], i = 1;
    if (service_id) { conditions.push(`service_id = $${i++}`); params.push(service_id); }
    if (severity)   { conditions.push(`severity = $${i++}`);   params.push(severity);   }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(parseInt(limit), parseInt(offset));
    const result = await pool.query(
      `SELECT * FROM ml.predictions ${where} ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i++}`,
      params
    );
    const count = await pool.query(`SELECT COUNT(*) FROM ml.predictions ${where}`, params.slice(0,-2));
    res.json({ predictions: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/:id", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM ml.predictions WHERE id=$1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;