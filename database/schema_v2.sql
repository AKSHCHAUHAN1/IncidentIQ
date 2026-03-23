-- ── Predictions log ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ml.predictions (
    id            TEXT PRIMARY KEY,
    service_id    TEXT NOT NULL,
    model_name    TEXT DEFAULT 'ensemble',
    severity      TEXT NOT NULL,             -- normal / warning / critical
    confidence    FLOAT NOT NULL,
    prediction_data  JSONB,
    feature_importance JSONB,
    outcome       TEXT DEFAULT 'pending',    -- pending / true_positive / false_positive / prevented
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Incidents ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incidents.incidents (
    id              TEXT PRIMARY KEY,
    service_id      TEXT NOT NULL,
    severity        TEXT NOT NULL,
    status          TEXT DEFAULT 'predicted',  -- predicted / prevented / occurred / missed
    confidence      FLOAT,
    prediction_id   TEXT REFERENCES ml.predictions(id),
    predicted_at    TIMESTAMPTZ DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ,
    root_cause      TEXT,
    metrics_snapshot JSONB
);

-- ── Remediations (approval workflow) ─────────────────────────
CREATE TABLE IF NOT EXISTS incidents.remediations (
    id           TEXT PRIMARY KEY,
    incident_id  TEXT REFERENCES incidents.incidents(id),
    service_id   TEXT NOT NULL,
    action       TEXT NOT NULL,              -- restart / scale / rollback
    status       TEXT DEFAULT 'pending',     -- pending / approved / rejected / executing / success / failed
    confidence   FLOAT,
    auto_executed BOOLEAN DEFAULT FALSE,
    reason       TEXT,                       -- rejection reason
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    executed_at  TIMESTAMPTZ,
    result       TEXT
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_predictions_service   ON ml.predictions(service_id);
CREATE INDEX IF NOT EXISTS idx_predictions_created   ON ml.predictions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_service     ON incidents.incidents(service_id);
CREATE INDEX IF NOT EXISTS idx_incidents_status      ON incidents.incidents(status);
CREATE INDEX IF NOT EXISTS idx_remediations_status   ON incidents.remediations(status);
CREATE INDEX IF NOT EXISTS idx_remediations_incident ON incidents.remediations(incident_id);

-- ── Backfill ml.predictions with columns added in init.sql ────
ALTER TABLE ml.predictions ADD COLUMN IF NOT EXISTS url TEXT;
ALTER TABLE ml.predictions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'open';
ALTER TABLE ml.predictions ADD COLUMN IF NOT EXISTS actioned_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_predictions_url ON ml.predictions (url);