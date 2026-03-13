import { Router } from "express";
import { pool } from "../db.js";

const router = Router();

router.get("/summary", async (req, res) => {
  try {
    const slaThreshold = parseFloat(process.env.SLA_TTFB_MS || "2000");

    const [p, i, r, m] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total,
        AVG(confidence) as avg_confidence,
        COUNT(*) FILTER (WHERE outcome IN ('true_positive','prevented','pending')) as correct,
        COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '24 hours') as last_24h
        FROM ml.predictions`),
      pool.query(`SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE status='predicted') as predicted,
        COUNT(*) FILTER (WHERE status='alerted') as alerted,
        COUNT(*) FILTER (WHERE status='prevented') as prevented,
        COUNT(*) FILTER (WHERE status='occurred') as occurred,
        COUNT(*) FILTER (WHERE severity='critical') as critical
        FROM incidents.incidents`),
      pool.query(`SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE status='success') as successful,
        COUNT(*) FILTER (WHERE status='pending') as pending,
        COUNT(*) FILTER (WHERE action='dispatch_alert_report' AND status='success') as alert_reports,
        COUNT(*) FILTER (WHERE auto_executed=true) as auto_executed
        FROM incidents.remediations`),
      pool.query(`SELECT AVG(EXTRACT(EPOCH FROM (resolved_at-predicted_at))/60) as avg_mttr
        FROM incidents.incidents WHERE resolved_at IS NOT NULL`),
    ]);

    let sla;
    const probeTable = await pool.query(`SELECT to_regclass('metrics.probe_readings') AS probe_table`);
    if (probeTable.rows[0].probe_table) {
      sla = await pool.query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE ttfb_ms > $1) AS breaches
         FROM metrics.probe_readings
         WHERE probed_at > NOW() - INTERVAL '24 hours'`,
        [slaThreshold]
      );
    } else {
      sla = { rows: [{ total: 0, breaches: 0 }] };
    }

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
      predictions: {
        total: +p.rows[0].total,
        last_24h: +p.rows[0].last_24h,
        accuracy_pct: +accuracy,
        confidence_avg_pct: +avgConfidencePct,
      },
      incidents: {
        total: +i.rows[0].total,
        predicted: +i.rows[0].predicted,
        alerted: +i.rows[0].alerted,
        prevented: +i.rows[0].prevented,
        occurred: +i.rows[0].occurred,
        critical: +i.rows[0].critical,
      },
      remediations: {
        total: +r.rows[0].total,
        successful: +r.rows[0].successful,
        pending: +r.rows[0].pending,
        auto_executed: +r.rows[0].auto_executed,
        alert_reports: +r.rows[0].alert_reports,
      },
      sla: {
        threshold_ms: slaThreshold,
        last_24h_total: slaTotal,
        last_24h_breaches: slaBreaches,
        compliance_pct: +slaCompliance.toFixed(2),
      },
      mttr_minutes: m.rows[0].avg_mttr ? +parseFloat(m.rows[0].avg_mttr).toFixed(1) : null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/accuracy", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT DATE_TRUNC('day', created_at) as day, COUNT(*) as total,
        COUNT(*) FILTER (WHERE outcome IN ('true_positive','prevented')) as correct
      FROM ml.predictions WHERE created_at > NOW()-INTERVAL '30 days'
      GROUP BY day ORDER BY day ASC`);
    res.json({ accuracy_trend: r.rows.map(row => ({
      date: row.day, total: +row.total, correct: +row.correct,
      accuracy: row.total > 0 ? +(row.correct/row.total*100).toFixed(1) : 0,
    }))});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/services", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT service_id, COUNT(*) as total_incidents,
        COUNT(*) FILTER (WHERE severity='critical') as critical,
        COUNT(*) FILTER (WHERE status='prevented') as prevented
      FROM incidents.incidents GROUP BY service_id ORDER BY total_incidents DESC`);
    res.json({ services: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;