CREATE TABLE IF NOT EXISTS incidents.monitored_sites (
    id               TEXT PRIMARY KEY,          
    url              TEXT NOT NULL UNIQUE,
    name             TEXT NOT NULL,            
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
