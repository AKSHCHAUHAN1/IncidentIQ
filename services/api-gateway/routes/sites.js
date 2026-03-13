import { Router } from "express";
import { pool }   from "../db.js";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────
function urlToId(url) {
  // "https://github.com/foo" → "github-com"
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/\./g, "-").replace(/[^a-z0-9-]/gi, "").toLowerCase();
  } catch {
    return url.replace(/[^a-z0-9]/gi, "-").toLowerCase().slice(0, 40);
  }
}

function urlToName(url) {
  try { return new URL(url).hostname; }
  catch { return url; }
}

// GET /api/sites — list all monitored sites
router.get("/", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.*,
              COUNT(i.id)                                  AS total_incidents,
              COUNT(i.id) FILTER (WHERE i.severity='critical') AS critical_incidents
       FROM incidents.monitored_sites s
       LEFT JOIN incidents.incidents i ON i.service_id = s.id
       WHERE s.active = TRUE
       GROUP BY s.id
       ORDER BY s.created_at DESC`
    );
    res.json({ sites: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sites — register a new URL to monitor
router.post("/", async (req, res) => {
  try {
    let { url, name } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });

    // Normalise: ensure scheme present
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;

    // Validate URL
    try { new URL(url); } catch {
      return res.status(400).json({ error: "Invalid URL" });
    }

    const id   = urlToId(url);
    const displayName = name || urlToName(url);

    await pool.query(
      `INSERT INTO incidents.monitored_sites (id, url, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (url) DO UPDATE SET active = TRUE, name = EXCLUDED.name`,
      [id, url, displayName]
    );

    const r = await pool.query(
      "SELECT * FROM incidents.monitored_sites WHERE id = $1", [id]
    );
    res.status(201).json({ site: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sites/:id — remove a monitored site and its data
router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Remove remediations linked to this site's incidents
    await client.query(
      "DELETE FROM incidents.remediations WHERE service_id = $1",
      [req.params.id]
    );
    // Remove incidents
    await client.query(
      "DELETE FROM incidents.incidents WHERE service_id = $1",
      [req.params.id]
    );
    // Remove predictions
    await client.query(
      "DELETE FROM ml.predictions WHERE service_id = $1",
      [req.params.id]
    );
    // Remove raw metrics
    await client.query(
      "DELETE FROM metrics.raw_metrics WHERE service_id = $1",
      [req.params.id]
    );
    // Remove the site itself
    await client.query(
      "DELETE FROM incidents.monitored_sites WHERE id = $1",
      [req.params.id]
    );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/sites/:id/metrics — recent probe metrics for a site
router.get("/:id/metrics", async (req, res) => {
  try {
    const { limit = 60 } = req.query;
    const r = await pool.query(
      `SELECT time_bucket('30 seconds', time) AS bucket,
              metric_name, AVG(value) AS value
       FROM metrics.raw_metrics
       WHERE service_id = $1 AND time > NOW() - INTERVAL '30 minutes'
         AND metric_name IN ('ttfb_ms', 'dns_ms', 'error_rate', 'response_time_ms', 'latency', 'availability', 'status_code')
       GROUP BY bucket, metric_name
       ORDER BY bucket ASC`,
      [req.params.id]
    );

    // Pivot to [{time, response_time, error_rate, ...}]
    const buckets = {};
    for (const row of r.rows) {
      if (!buckets[row.bucket]) buckets[row.bucket] = { time: row.bucket };
      buckets[row.bucket][row.metric_name] = parseFloat(row.value);
    }

    const rows = Object.values(buckets).slice(-parseInt(limit));
    res.json({ metrics: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;