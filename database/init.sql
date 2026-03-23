-- ============================================================
-- IncidentIQ — Complete Database Schema
-- Covers: metrics, ml, incidents schemas
-- ============================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Schemas
CREATE SCHEMA IF NOT EXISTS metrics;
CREATE SCHEMA IF NOT EXISTS ml;
CREATE SCHEMA IF NOT EXISTS incidents;

-- ============================================================
-- PUBLIC SCHEMA — Shared Tables
-- ============================================================

-- Unified site registry: training URLs + user-added URLs
CREATE TABLE IF NOT EXISTS public.monitored_sites (
    id              BIGSERIAL PRIMARY KEY,
    url             TEXT NOT NULL UNIQUE,
    name            TEXT,
    added_at        TIMESTAMPTZ DEFAULT NOW(),
    is_active       BOOLEAN DEFAULT TRUE,
    is_training_only BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_monitored_sites_active
    ON public.monitored_sites (is_active, is_training_only);

-- ============================================================
-- METRICS SCHEMA
-- ============================================================

-- Raw probe readings (TimescaleDB hypertable)
CREATE TABLE IF NOT EXISTS metrics.probe_readings (
    id              BIGSERIAL,
    url             TEXT NOT NULL,
    probed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Timing metrics (milliseconds)
    ttfb_ms         FLOAT,
    dns_ms          FLOAT,
    tcp_ms          FLOAT,
    tls_ms          FLOAT,

    -- Health metrics
    status_code     INT,
    error_rate      FLOAT,
    ssl_days_left   FLOAT,

    -- Response info
    response_size   INT,
    content_type    TEXT,

    PRIMARY KEY (id, probed_at)
);

SELECT create_hypertable(
    'metrics.probe_readings',
    'probed_at',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

-- Retention: keep 90 days of raw probe data
SELECT add_retention_policy(
    'metrics.probe_readings',
    INTERVAL '90 days',
    if_not_exists => TRUE
);

-- Compression after 7 days
SELECT add_compression_policy(
    'metrics.probe_readings',
    INTERVAL '7 days',
    if_not_exists => TRUE
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_probe_url_time
    ON metrics.probe_readings (url, probed_at DESC);

CREATE INDEX IF NOT EXISTS idx_probe_time
    ON metrics.probe_readings (probed_at DESC);

-- 5-minute continuous aggregate
CREATE MATERIALIZED VIEW IF NOT EXISTS metrics.probe_5min
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('5 minutes', probed_at) AS bucket,
    url,
    AVG(ttfb_ms)      AS avg_ttfb_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ttfb_ms) AS p95_ttfb_ms,
    AVG(dns_ms)       AS avg_dns_ms,
    AVG(error_rate)   AS avg_error_rate,
    MIN(ssl_days_left)AS min_ssl_days_left,
    COUNT(*)          AS sample_count
FROM metrics.probe_readings
GROUP BY bucket, url
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
    'metrics.probe_5min',
    start_offset  => INTERVAL '1 hour',
    end_offset    => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '5 minutes',
    if_not_exists => TRUE
);


-- ============================================================
-- ML SCHEMA
-- ============================================================

-- Per-URL baselines from CrUX + probe-derived stats
CREATE TABLE IF NOT EXISTS ml.url_baselines (
    url                         TEXT PRIMARY KEY,
    ttfb_p75_ms                 FLOAT,
    lcp_p75_ms                  FLOAT,
    fcp_p75_ms                  FLOAT,
    ttfb_anomaly_threshold_ms   FLOAT,
    probe_ttfb_mean_ms          FLOAT,
    probe_ttfb_std_ms           FLOAT,
    probe_dns_mean_ms           FLOAT,
    probe_dns_std_ms            FLOAT,
    probe_error_rate_mean       FLOAT,
    probe_error_rate_std        FLOAT,
    baseline_computed_at        TIMESTAMPTZ,
    crux_fetched_at             TIMESTAMPTZ,
    source                      TEXT DEFAULT 'crux_api'
);

-- Real incident history from public status pages
CREATE TABLE IF NOT EXISTS ml.status_incidents (
    incident_id     TEXT,
    url             TEXT NOT NULL,
    service_name    TEXT,
    title           TEXT,
    impact          TEXT,
    anomaly_type    TEXT NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL,
    resolved_at     TIMESTAMPTZ NOT NULL,
    duration_min    FLOAT,
    source          TEXT DEFAULT 'statuspage_api',
    fetched_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (incident_id, url)
);

-- Labeled probe readings (ML training dataset)
CREATE TABLE IF NOT EXISTS ml.labeled_probe_readings (
    id                  BIGSERIAL PRIMARY KEY,
    url                 TEXT NOT NULL,
    probed_at           TIMESTAMPTZ NOT NULL,
    ttfb_ms             FLOAT,
    dns_ms              FLOAT,
    origin_time_ms      FLOAT,
    error_rate          FLOAT,
    status_code         INT,
    ssl_days_left       FLOAT,
    ttfb_zscore         FLOAT,
    dns_zscore          FLOAT,
    origin_zscore       FLOAT,
    error_zscore        FLOAT,
    metric_text         TEXT,
    anomaly_type        TEXT NOT NULL DEFAULT 'normal',
    is_anomaly          BOOLEAN NOT NULL DEFAULT FALSE,
    label_source        TEXT,
    label_confidence    FLOAT
);

CREATE INDEX IF NOT EXISTS idx_labeled_url  ON ml.labeled_probe_readings (url);
CREATE INDEX IF NOT EXISTS idx_labeled_at   ON ml.labeled_probe_readings (probed_at DESC);
CREATE INDEX IF NOT EXISTS idx_labeled_type ON ml.labeled_probe_readings (anomaly_type);

-- Ensemble predictions (written by decision-engine)
CREATE TABLE IF NOT EXISTS ml.predictions (
    id              TEXT PRIMARY KEY,
    service_id      TEXT NOT NULL,
    url             TEXT,
    model_name      TEXT DEFAULT 'sla-ensemble',
    severity        TEXT NOT NULL DEFAULT 'normal',
    confidence      FLOAT DEFAULT 0,
    prediction_data JSONB,
    outcome         TEXT DEFAULT 'pending',
    status          TEXT DEFAULT 'open',
    actioned_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_predictions_service ON ml.predictions (service_id);
CREATE INDEX IF NOT EXISTS idx_predictions_created ON ml.predictions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_severity ON ml.predictions (severity);


-- ============================================================
-- INCIDENTS SCHEMA
-- ============================================================

-- Monitored sites (user-added URLs via the Monitor page)
CREATE TABLE IF NOT EXISTS incidents.monitored_sites (
    id          TEXT PRIMARY KEY,
    url         TEXT UNIQUE NOT NULL,
    name        TEXT,
    active      BOOLEAN DEFAULT TRUE,
    last_status TEXT DEFAULT 'unknown',
    last_response_ms FLOAT,
    last_probed TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Incidents detected by the decision engine
CREATE TABLE IF NOT EXISTS incidents.incidents (
    id              TEXT PRIMARY KEY,
    service_id      TEXT NOT NULL,
    url             TEXT,
    severity        TEXT NOT NULL DEFAULT 'warning',
    confidence      FLOAT DEFAULT 0,
    status          TEXT DEFAULT 'open',
    prediction_id   TEXT,
    root_cause      TEXT,
    metrics_snapshot JSONB,
    predicted_at    TIMESTAMPTZ DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_incidents_service ON incidents.incidents (service_id);
CREATE INDEX IF NOT EXISTS idx_incidents_predicted ON incidents.incidents (predicted_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents.incidents (severity);

-- Remediations / alert dispatches
CREATE TABLE IF NOT EXISTS incidents.remediations (
    id              TEXT PRIMARY KEY,
    incident_id     TEXT REFERENCES incidents.incidents(id),
    service_id      TEXT NOT NULL,
    action          TEXT NOT NULL,
    confidence      FLOAT DEFAULT 0,
    auto_executed   BOOLEAN DEFAULT FALSE,
    status          TEXT DEFAULT 'pending',
    reason          TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_remediations_incident ON incidents.remediations (incident_id);
CREATE INDEX IF NOT EXISTS idx_remediations_status ON incidents.remediations (status);
