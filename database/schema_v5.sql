-- ============================================================
-- Schema v5 — Web performance anomaly pipeline
-- Run AFTER schema_v2.sql, schema_v3.sql, schema_v4.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE SCHEMA IF NOT EXISTS metrics;
CREATE SCHEMA IF NOT EXISTS ml;

-- ------------------------------------------------------------------
-- High-fidelity probe readings (TTFB, DNS, TLS, SSL, error profile)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metrics.probe_readings (
    id                  BIGSERIAL,
    url                 TEXT NOT NULL,
    service_id          TEXT,
    probed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    ttfb_ms             FLOAT,
    dns_ms              FLOAT,
    tcp_ms              FLOAT,
    tls_ms              FLOAT,
    response_time_ms    FLOAT,

    status_code         INT,
    error_rate          FLOAT,
    availability        INT,
    ssl_days_left       FLOAT,

    response_size       INT,
    content_type        TEXT,

    PRIMARY KEY (id, probed_at)
);

SELECT create_hypertable(
    'metrics.probe_readings',
    'probed_at',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_probe_url_time
    ON metrics.probe_readings (url, probed_at DESC);

CREATE INDEX IF NOT EXISTS idx_probe_service_time
    ON metrics.probe_readings (service_id, probed_at DESC);

CREATE INDEX IF NOT EXISTS idx_probe_time
    ON metrics.probe_readings (probed_at DESC);

-- ------------------------------------------------------------------
-- Baselines + labels for pivot training pipeline
-- ------------------------------------------------------------------
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
    label_confidence    FLOAT,
    UNIQUE (url, probed_at)
);

CREATE INDEX IF NOT EXISTS idx_labeled_url
    ON ml.labeled_probe_readings (url);

CREATE INDEX IF NOT EXISTS idx_labeled_at
    ON ml.labeled_probe_readings (probed_at DESC);

CREATE INDEX IF NOT EXISTS idx_labeled_type
    ON ml.labeled_probe_readings (anomaly_type);

SELECT 'schema_v5 applied' AS status;
