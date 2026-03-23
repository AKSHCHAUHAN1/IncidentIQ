import { Router } from "express";
import { pool } from "../db.js";

const router = Router();

// GET /api/approvals — open predictions with confidence 70-89% for user sites
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, ms.name AS site_name
       FROM ml.predictions p
       JOIN public.monitored_sites ms ON ms.url = p.url
       WHERE p.status = 'open'
         AND p.confidence BETWEEN 0.70 AND 0.89
         AND ms.is_training_only = FALSE
         AND ms.is_active = TRUE
       ORDER BY p.created_at DESC`
    );
    res.json({ success: true, approvals: result.rows });
  } catch (err) {
    console.error("[approvals GET /] error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/approvals/count — count of pending approvals
router.get("/count", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT COUNT(*) FROM ml.predictions p
       JOIN public.monitored_sites ms ON ms.url = p.url
       WHERE p.status = 'open'
         AND p.confidence BETWEEN 0.70 AND 0.89
         AND ms.is_training_only = FALSE
         AND ms.is_active = TRUE`
    );
    res.json({ success: true, count: parseInt(r.rows[0].count) });
  } catch (err) {
    console.error("[approvals GET /count] error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/approvals/:id — mark as action_taken or ignored
router.patch("/:id", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["action_taken", "ignored"].includes(status)) {
      return res.status(400).json({ success: false, error: "status must be 'action_taken' or 'ignored'" });
    }

    const r = await pool.query(
      `UPDATE ml.predictions SET status = $1, actioned_at = NOW()
       WHERE id = $2 AND status = 'open'
       RETURNING *`,
      [status, req.params.id]
    );

    if (!r.rows.length) {
      return res.status(404).json({ success: false, error: "Not found or already processed" });
    }

    // Also update linked incident if one exists
    await pool.query(
      `UPDATE incidents.incidents SET status = $1, resolved_at = NOW()
       WHERE prediction_id = $2`,
      [status, req.params.id]
    );

    console.log(`[approvals PATCH] ${req.params.id} → ${status}`);
    res.json({ success: true, prediction: r.rows[0] });
  } catch (err) {
    console.error("[approvals PATCH] error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;