import { Router } from "express";
import { pool } from "../db.js";

const router = Router();

/**
 * Helper: builds a WHERE clause fragment to filter incidents (which only have service_id, not url)
 * by matching against the hostname of user-monitored sites.
 */
const incidentUserFilter = `i.service_id IN (
  SELECT DISTINCT
    CASE
      WHEN position('://' IN ms.url) > 0
        THEN regexp_replace(split_part(split_part(ms.url, '://', 2), '/', 1), '^www\\.', '')
      ELSE regexp_replace(split_part(ms.url, '/', 1), '^www\\.', '')
    END
  FROM public.monitored_sites ms
  WHERE ms.is_training_only = FALSE AND ms.is_active = TRUE
  UNION
  SELECT DISTINCT
    CASE
      WHEN position('://' IN ms.url) > 0
        THEN split_part(split_part(ms.url, '://', 2), '/', 1)
      ELSE split_part(ms.url, '/', 1)
    END
  FROM public.monitored_sites ms
  WHERE ms.is_training_only = FALSE AND ms.is_active = TRUE
)`;

const predictionUserFilter = `(
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
)`;

router.get("/summary", async (req, res) => {
  try {
    const slaThreshold = parseFloat(process.env.SLA_TTFB_MS || "2000");

    const probeUserFilter = `url IN (SELECT url FROM public.monitored_sites WHERE is_training_only = FALSE AND is_active = TRUE)`;

    const [p, i, m, siteStatus] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total,
        AVG(confidence) as avg_confidence,
        COUNT(*) FILTER (WHERE outcome IN ('true_positive','prevented','pending')) as correct,
        COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '24 hours') as last_24h
        FROM ml.predictions p WHERE ${predictionUserFilter}`),
      pool.query(`SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE status='open') as open,
        COUNT(*) FILTER (WHERE status='action_taken') as action_taken,
        COUNT(*) FILTER (WHERE status='ignored') as ignored,
        COUNT(*) FILTER (WHERE severity='critical') as critical
        FROM incidents.incidents i WHERE ${incidentUserFilter}`),
      pool.query(`SELECT AVG(EXTRACT(EPOCH FROM (resolved_at-predicted_at))/60) as avg_mttr
        FROM incidents.incidents i WHERE resolved_at IS NOT NULL AND ${incidentUserFilter}`),
      pool.query(`
        WITH latest AS (
          SELECT DISTINCT ON (pr.url) pr.url, pr.ttfb_ms, pr.error_rate, pr.status_code
          FROM metrics.probe_readings pr
          WHERE pr.url IN (SELECT url FROM public.monitored_sites WHERE is_training_only = FALSE AND is_active = TRUE)
          ORDER BY pr.url, pr.probed_at DESC
        )
        SELECT
          COUNT(*) FILTER (WHERE ttfb_ms < 2000 AND COALESCE(error_rate, 0) < 0.1 AND COALESCE(status_code, 200) < 500) AS sites_up,
          COUNT(*) FILTER (WHERE (ttfb_ms BETWEEN 1000 AND 2000 OR (error_rate BETWEEN 0.05 AND 0.1)) AND COALESCE(status_code, 200) < 500) AS degraded,
          COUNT(*) FILTER (WHERE ttfb_ms >= 2000 OR COALESCE(error_rate, 0) >= 0.1 OR COALESCE(status_code, 200) >= 500) AS down
        FROM latest
      `),
    ]);

    let sla;
    const probeTable = await pool.query(`SELECT to_regclass('metrics.probe_readings') AS probe_table`);
    if (probeTable.rows[0].probe_table) {
      sla = await pool.query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE ttfb_ms > $1) AS breaches
         FROM metrics.probe_readings
         WHERE probed_at > NOW() - INTERVAL '24 hours' AND ${probeUserFilter}`,
        [slaThreshold]
      );
    } else {
      sla = { rows: [{ total: 0, breaches: 0 }] };
    }

    const pendingApprovals = await pool.query(
      `SELECT COUNT(*) FROM ml.predictions p
       JOIN public.monitored_sites ms ON ms.url = p.url
       WHERE p.status = 'open' AND p.confidence BETWEEN 0.70 AND 0.89
         AND ms.is_training_only = FALSE`
    );

    const totalPred = Number(p.rows[0].total || 0);
    const accuracy = totalPred > 0
      ? (Number(p.rows[0].correct || 0) / totalPred * 100).toFixed(1)
      : 0;

    const avgConfidencePct = totalPred > 0
      ? (Number(p.rows[0].avg_confidence || 0) * 100).toFixed(1)
      : 0;

    const slaTotal = Number(sla.rows[0].total || 0);
    const slaBreaches = Number(sla.rows[0].breaches || 0);
    const slaCompliance = slaTotal > 0
      ? ((slaTotal - slaBreaches) / slaTotal * 100)
      : 100;

    res.json({
      success: true,
      predictions: {
        total: +p.rows[0].total,
        last_24h: +p.rows[0].last_24h,
        accuracy_pct: +accuracy,
        confidence_avg_pct: +avgConfidencePct,
      },
      incidents: {
        total: +i.rows[0].total,
        open: +i.rows[0].open,
        action_taken: +i.rows[0].action_taken,
        ignored: +i.rows[0].ignored,
        critical: +i.rows[0].critical,
      },
      sites: {
        up: parseInt(siteStatus.rows[0]?.sites_up || 0),
        degraded: parseInt(siteStatus.rows[0]?.degraded || 0),
        down: parseInt(siteStatus.rows[0]?.down || 0),
      },
      pending_approvals: parseInt(pendingApprovals.rows[0]?.count || 0),
      sla: {
        threshold_ms: slaThreshold,
        last_24h_total: slaTotal,
        last_24h_breaches: slaBreaches,
        compliance_pct: +slaCompliance.toFixed(2),
      },
      mttr_minutes: m.rows[0].avg_mttr ? +parseFloat(m.rows[0].avg_mttr).toFixed(1) : null,
      remediations: {
        alert_reports: parseInt(i.rows[0].action_taken || 0),
      },
    });
  } catch (err) {
    console.error("[analytics GET /summary] error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/accuracy", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT DATE_TRUNC('day', created_at) as day, COUNT(*) as total,
        COUNT(*) FILTER (WHERE outcome IN ('true_positive','prevented')) as correct
      FROM ml.predictions p
      WHERE created_at > NOW()-INTERVAL '30 days'
        AND ${predictionUserFilter}
      GROUP BY day ORDER BY day ASC`);
    res.json({ success: true, accuracy_trend: r.rows.map(row => ({
      date: row.day, total: +row.total, correct: +row.correct,
      accuracy: row.total > 0 ? +(row.correct/row.total*100).toFixed(1) : 0,
    }))});
  } catch (err) {
    console.error("[analytics GET /accuracy] error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/services", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT service_id, COUNT(*) as total_incidents,
        COUNT(*) FILTER (WHERE severity='critical') as critical,
        COUNT(*) FILTER (WHERE status='action_taken') as action_taken
      FROM incidents.incidents i
      WHERE ${incidentUserFilter}
      GROUP BY service_id ORDER BY total_incidents DESC`);
    res.json({ success: true, services: r.rows });
  } catch (err) {
    console.error("[analytics GET /services] error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;