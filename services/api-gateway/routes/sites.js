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
                WHEN lr.status_code = 0 OR lr.status_code IS NULL THEN 'down'
                WHEN lr.status_code >= 500 OR COALESCE(lr.error_rate, 0) >= 0.5 THEN 'down'
                WHEN lr.ttfb_ms >= 2000 THEN 'down'
                WHEN lr.ttfb_ms >= 1000 OR COALESCE(lr.error_rate, 0) >= 0.15 THEN 'degraded'
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
                WHEN lr.status_code = 0 OR lr.status_code IS NULL THEN 'down'
                WHEN lr.status_code >= 500 OR COALESCE(lr.error_rate, 0) >= 0.5 THEN 'down'
                WHEN lr.ttfb_ms >= 2000 THEN 'down'
                WHEN lr.ttfb_ms >= 1000 OR COALESCE(lr.error_rate, 0) >= 0.15 THEN 'degraded'
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

// DELETE /api/sites/:id — HARD DELETE: removes site + ALL associated data
router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  const siteId = Number.parseInt(req.params.id, 10);

  if (!Number.isInteger(siteId) || siteId <= 0) {
    client.release();
    return res.status(400).json({ success: false, error: "Invalid site id" });
  }

  try {
    await client.query("BEGIN");

    // Get the URL first so we can clean up related tables
    const siteResult = await client.query(
      "SELECT url FROM public.monitored_sites WHERE id = $1 AND is_training_only = FALSE",
      [siteId]
    );

    if (!siteResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, error: "Site not found or is a training site" });
    }

    const { url } = siteResult.rows[0];
    const serviceId = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    })();
    console.log(`[sites DELETE] Hard deleting site: ${url}`);

    // 1. Delete probe readings (TimescaleDB hypertable — use DELETE not TRUNCATE)
    const probeResult = await client.query(
      "DELETE FROM metrics.probe_readings WHERE url = $1",
      [url]
    );
    console.log(`[sites DELETE] Removed ${probeResult.rowCount} probe readings`);

    // 2. Delete labeled probe readings (ML training data)
    const labelResult = await client.query(
      "DELETE FROM ml.labeled_probe_readings WHERE url = $1",
      [url]
    );
    console.log(`[sites DELETE] Removed ${labelResult.rowCount} labeled readings`);

    const predictionUrlCol = await client.query(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'ml' AND table_name = 'predictions' AND column_name = 'url'
       ) AS has_url`
    );
    const incidentUrlCol = await client.query(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'incidents' AND table_name = 'incidents' AND column_name = 'url'
       ) AS has_url`
    );

    const hasPredictionUrl = predictionUrlCol.rows[0]?.has_url === true;
    const hasIncidentUrl = incidentUrlCol.rows[0]?.has_url === true;

    // 3. Delete predictions (schema-compatible: url in new schema, service_id in legacy)
    const predResult = hasPredictionUrl
      ? await client.query("DELETE FROM ml.predictions WHERE url = $1", [url])
      : await client.query("DELETE FROM ml.predictions WHERE service_id = $1", [serviceId]);
    console.log(`[sites DELETE] Removed ${predResult.rowCount} predictions`);

    // 4. Delete remediations linked to this site's incidents (schema-compatible)
    const remResult = hasIncidentUrl
      ? await client.query(
          `DELETE FROM incidents.remediations
           WHERE incident_id IN (SELECT id FROM incidents.incidents WHERE url = $1)`,
          [url]
        )
      : await client.query(
          `DELETE FROM incidents.remediations
           WHERE incident_id IN (SELECT id FROM incidents.incidents WHERE service_id = $1)`,
          [serviceId]
        );
    console.log(`[sites DELETE] Removed ${remResult.rowCount} remediations`);

    // 5. Delete incidents (schema-compatible)
    const incResult = hasIncidentUrl
      ? await client.query("DELETE FROM incidents.incidents WHERE url = $1", [url])
      : await client.query("DELETE FROM incidents.incidents WHERE service_id = $1", [serviceId]);
    console.log(`[sites DELETE] Removed ${incResult.rowCount} incidents`);

    // 6. Delete URL baselines
    await client.query("DELETE FROM ml.url_baselines WHERE url = $1", [url]);

    // 7. Delete status incidents for this URL
    await client.query("DELETE FROM ml.status_incidents WHERE url = $1", [url]);

    // 8. Finally delete the site record itself
    const deleteSiteResult = await client.query(
      "DELETE FROM public.monitored_sites WHERE id = $1",
      [siteId]
    );

    if (deleteSiteResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, error: "Site not found" });
    }

    await client.query("COMMIT");

    console.log(`[sites DELETE] Complete — all data for ${url} removed`);
    res.json({
      success: true,
      deleted: {
        site_id: siteId,
        url,
        probe_readings: probeResult.rowCount,
        labeled_readings: labelResult.rowCount,
        predictions: predResult.rowCount,
        incidents: incResult.rowCount,
      }
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[sites DELETE] error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/sites/:id/metrics — recent probe metrics for a site
router.get("/:id/metrics", async (req, res) => {
  try {
    const { limit = 60 } = req.query;

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
      time:             row.time,
      ttfb_ms:          parseFloat(row.ttfb_ms || 0),
      response_time_ms: parseFloat(row.ttfb_ms || 0),
      dns_ms:           parseFloat(row.dns_ms || 0),
      error_rate:       parseFloat(row.error_rate || 0),
      ssl_days_left:    parseFloat(row.ssl_days_left || 0),
      status_code:      parseInt(row.status_code || 0),
    }));

    res.json({ success: true, metrics: rows });
  } catch (err) {
    console.error("[sites GET /:id/metrics] error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;