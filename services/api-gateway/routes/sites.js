import { Router } from "express";
import { pool }   from "../db.js";

const router = Router();

// GET /api/sites — list user-added sites only (exclude training)
router.get("/", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ms.*,
              lr.ttfb_ms AS last_response_ms,
              lr.probed_at AS last_probed,
              lr.status_code,
              CASE
                WHEN lr.ttfb_ms IS NULL THEN 'unknown'
                WHEN lr.status_code >= 500 OR COALESCE(lr.error_rate, 0) >= 0.1 THEN 'down'
                WHEN lr.ttfb_ms >= 2000 THEN 'down'
                WHEN lr.ttfb_ms >= 1000 OR COALESCE(lr.error_rate, 0) >= 0.05 THEN 'degraded'
                ELSE 'up'
              END AS last_status
       FROM public.monitored_sites ms
       LEFT JOIN LATERAL (
         SELECT ttfb_ms, probed_at, status_code, error_rate
         FROM metrics.probe_readings pr
         WHERE pr.url = ms.url
         ORDER BY pr.probed_at DESC
         LIMIT 1
       ) lr ON true
       WHERE ms.is_training_only = FALSE AND ms.is_active = TRUE
       ORDER BY ms.added_at DESC`
    );
    res.json({ success: true, sites: r.rows });
  } catch (err) {
    console.error("[sites GET /] error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/sites/status — live status for all user sites
router.get("/status", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ms.id, ms.url, ms.name,
              lr.ttfb_ms, lr.dns_ms, lr.error_rate, lr.status_code, lr.ssl_days_left,
              lr.probed_at AS last_probed,
              CASE
                WHEN lr.ttfb_ms IS NULL THEN 'unknown'
                WHEN lr.status_code >= 500 OR COALESCE(lr.error_rate, 0) >= 0.1 THEN 'down'
                WHEN lr.ttfb_ms >= 2000 THEN 'down'
                WHEN lr.ttfb_ms >= 1000 OR COALESCE(lr.error_rate, 0) >= 0.05 THEN 'degraded'
                ELSE 'up'
              END AS status
       FROM public.monitored_sites ms
       LEFT JOIN LATERAL (
         SELECT ttfb_ms, dns_ms, error_rate, status_code, ssl_days_left, probed_at
         FROM metrics.probe_readings pr
         WHERE pr.url = ms.url
         ORDER BY pr.probed_at DESC
         LIMIT 1
       ) lr ON true
       WHERE ms.is_training_only = FALSE AND ms.is_active = TRUE
       ORDER BY ms.added_at DESC`
    );
    res.json({ success: true, sites: r.rows });
  } catch (err) {
    console.error("[sites GET /status] error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/sites — add a new user URL to monitor
router.post("/", async (req, res) => {
  try {
    let { url, name } = req.body;
    if (!url) return res.status(400).json({ success: false, error: "url is required" });

    // Normalise: ensure scheme present
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;

    // Validate URL
    try { new URL(url); } catch {
      return res.status(400).json({ success: false, error: "Invalid URL" });
    }

    const displayName = name || new URL(url).hostname;

    const r = await pool.query(
      `INSERT INTO public.monitored_sites (url, name, is_training_only)
       VALUES ($1, $2, FALSE)
       ON CONFLICT (url) DO UPDATE SET is_active = TRUE, name = EXCLUDED.name
       RETURNING *`,
      [url, displayName]
    );

    console.log(`[sites POST] Added user site: ${url}`);
    res.status(201).json({ success: true, site: r.rows[0] });
  } catch (err) {
    console.error("[sites POST] error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/sites/:id — soft-delete (mark inactive)
router.delete("/:id", async (req, res) => {
  try {
    await pool.query(
      "UPDATE public.monitored_sites SET is_active = FALSE WHERE id = $1",
      [req.params.id]
    );
    console.log(`[sites DELETE] Deactivated site id=${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[sites DELETE] error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/sites/:id/metrics — recent probe metrics for a site
router.get("/:id/metrics", async (req, res) => {
  try {
    const { limit = 60 } = req.query;

    // Get the URL for this site id
    const site = await pool.query(
      "SELECT url FROM public.monitored_sites WHERE id=$1", [req.params.id]
    );
    if (!site.rows.length) return res.status(404).json({ success: false, error: "Site not found" });

    const siteUrl = site.rows[0].url;

    const r = await pool.query(
      `SELECT probed_at AS time, ttfb_ms, dns_ms, tcp_ms, tls_ms,
              error_rate, ssl_days_left, status_code
       FROM metrics.probe_readings
       WHERE url = $1 AND probed_at > NOW() - INTERVAL '30 minutes'
       ORDER BY probed_at ASC
       LIMIT $2`,
      [siteUrl, parseInt(limit)]
    );

    const rows = r.rows.map(row => ({
      time: row.time,
      ttfb_ms: parseFloat(row.ttfb_ms || 0),
      response_time_ms: parseFloat(row.ttfb_ms || 0),
      dns_ms: parseFloat(row.dns_ms || 0),
      error_rate: parseFloat(row.error_rate || 0),
      ssl_days_left: parseFloat(row.ssl_days_left || 0),
      status_code: parseInt(row.status_code || 0),
    }));

    res.json({ success: true, metrics: rows });
  } catch (err) {
    console.error("[sites GET /:id/metrics] error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;