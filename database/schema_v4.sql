-- ============================================================
-- Schema v4 — Website monitoring
-- Run AFTER schema_v2.sql and schema_v3.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS incidents.monitored_sites (
    id               TEXT PRIMARY KEY,          -- slug: "github-com"
    url              TEXT NOT NULL UNIQUE,
    name             TEXT NOT NULL,             -- display name
    active           BOOLEAN DEFAULT TRUE,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    last_probed      TIMESTAMPTZ,
    last_status      TEXT DEFAULT 'unknown',    -- up / degraded / down / unknown
    last_response_ms INTEGER
);

-- Index for active site lookups
CREATE INDEX IF NOT EXISTS idx_sites_active
    ON incidents.monitored_sites(active)
    WHERE active = TRUE;

-- Verification
SELECT 'monitored_sites table created' AS status;
