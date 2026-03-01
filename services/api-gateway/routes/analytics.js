import { Router } from "express";
import { pool } from "../db.js";

const router = Router();

router.get("/summary", async (req, res) => {
  try {
    const [p, i, r, m] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE outcome IN ('true_positive','prevented')) as correct,
        COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '24 hours') as last_24h
        FROM ml.predictions`),
      pool.query(`SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE status='prevented') as prevented,
        COUNT(*) FILTER (WHERE status='occurred') as occurred,
        COUNT(*) FILTER (WHERE severity='critical') as critical
        FROM incidents.incidents`),
      pool.query(`SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE status='success') as successful,
        COUNT(*) FILTER (WHERE status='pending') as pending,
        COUNT(*) FILTER (WHERE auto_executed=true) as auto_executed
        FROM incidents.remediations`),
      pool.query(`SELECT AVG(EXTRACT(EPOCH FROM (resolved_at-predicted_at))/60) as avg_mttr
        FROM incidents.incidents WHERE resolved_at IS NOT NULL`),
    ]);
    const accuracy = p.rows[0].total > 0
      ? (p.rows[0].correct / p.rows[0].total * 100).toFixed(1) : 0;
    res.json({
      predictions: { total: +p.rows[0].total, last_24h: +p.rows[0].last_24h, accuracy_pct: +accuracy },
      incidents:   { total: +i.rows[0].total, prevented: +i.rows[0].prevented, occurred: +i.rows[0].occurred, critical: +i.rows[0].critical },
      remediations:{ total: +r.rows[0].total, successful: +r.rows[0].successful, pending: +r.rows[0].pending, auto_executed: +r.rows[0].auto_executed },
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