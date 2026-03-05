import { Router } from "express";
import { pool } from "../db.js";

const router = Router();

// GET /api/incidents
router.get("/", async (req, res) => {
  try {
    const { service_id, status, severity, limit = 50, offset = 0 } = req.query;
    let conditions = [], params = [], i = 1;

    if (service_id) { conditions.push(`i.service_id=$${i++}`); params.push(service_id); }
    if (status)     { conditions.push(`i.status=$${i++}`);     params.push(status); }
    if (severity)   { conditions.push(`i.severity=$${i++}`);   params.push(severity); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(
      `SELECT i.*,
              r.action        as remediation_action,
              r.status        as remediation_status,
              r.auto_executed as auto_executed
       FROM incidents.incidents i
       LEFT JOIN incidents.remediations r ON r.incident_id = i.id
       ${where}
       ORDER BY i.predicted_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      params
    );

    const count = await pool.query(
      `SELECT COUNT(*) FROM incidents.incidents i ${where}`,
      params.slice(0, -2)
    );

    res.json({ incidents: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/incidents/:id — full detail with remediations
router.get("/:id", async (req, res) => {
  try {
    const inc = await pool.query(
      "SELECT * FROM incidents.incidents WHERE id=$1",
      [req.params.id]
    );
    if (!inc.rows.length) return res.status(404).json({ error: "Not found" });

    const rem = await pool.query(
      "SELECT * FROM incidents.remediations WHERE incident_id=$1",
      [req.params.id]
    );

    res.json({ incident: inc.rows[0], remediations: rem.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/incidents/:id/similar — pgvector similarity search
// Returns top 5 most similar past incidents based on metric fingerprint
router.get("/:id/similar", async (req, res) => {
  try {
    const { id } = req.params;
    const limit  = Math.min(parseInt(req.query.limit || "5"), 10);

    // First check if embeddings table exists (pgvector may not be set up)
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'incidents'
        AND table_name = 'incident_embeddings'
      ) AS exists
    `);

    if (!tableCheck.rows[0].exists) {
      return res.status(503).json({
        error: "pgvector not set up yet. Run schema_v3.sql first.",
        setup_command: "docker compose exec postgres psql -U postgres -d incident_predictor -f /tmp/schema_v3.sql"
      });
    }

    // Make sure this incident has an embedding
    await pool.query("SELECT incidents.generate_embedding($1)", [id]);

    // Find similar incidents using cosine distance
    const result = await pool.query(`
      SELECT
        i.id,
        i.service_id,
        i.severity,
        i.status,
        i.predicted_at,
        i.metrics_snapshot,
        (1 - (e.embedding <=> target.embedding)) AS similarity
      FROM incidents.incident_embeddings e
      JOIN incidents.incidents i ON i.id = e.id
      CROSS JOIN (
        SELECT embedding FROM incidents.incident_embeddings WHERE id = $1
      ) AS target
      WHERE e.id != $1
        AND i.status IN ('prevented', 'occurred')
      ORDER BY e.embedding <=> target.embedding ASC
      LIMIT $2
    `, [id, limit]);

    res.json({
      incident_id: id,
      similar:     result.rows.map(r => ({
        ...r,
        similarity_pct: Math.round(r.similarity * 100),
      })),
    });
  } catch (err) {
    console.error("Similar incidents error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;