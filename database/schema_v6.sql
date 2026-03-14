-- Extensions
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Schemas
CREATE SCHEMA IF NOT EXISTS metrics;
CREATE SCHEMA IF NOT EXISTS ml;

CREATE TABLE IF NOT EXISTS metrics.probe_readings (
    id              BIGSERIAL,
    url             TEXT NOT NULL,
    probed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Timing metrics (milliseconds)
    ttfb_ms         FLOAT,          -- Time To First Byte
    dns_ms          FLOAT,          -- DNS resolution time
    tcp_ms          FLOAT,          -- TCP connect time
    tls_ms          FLOAT,          -- TLS handshake time

    -- Health metrics
    status_code     INT,
    error_rate      FLOAT,          -- rolling 5-min error rate (0.0-1.0)
    ssl_days_left   FLOAT,          -- days until SSL cert expires

    -- Response info
    response_size   INT,            -- bytes
    content_type    TEXT,

    PRIMARY KEY (id, probed_at)
);

-- Convert to TimescaleDB hypertable (time-partitioned)
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

-- url_baselines: per-URL normal baselines (from CrUX + probe warmup)
CREATE TABLE IF NOT EXISTS ml.url_baselines (
    url                         TEXT PRIMARY KEY,
    -- CrUX field data (real user measurements from Google)
    ttfb_p75_ms                 FLOAT,
    lcp_p75_ms                  FLOAT,
    fcp_p75_ms                  FLOAT,
    ttfb_anomaly_threshold_ms   FLOAT,
    -- Probe-derived baselines (computed after warmup period)
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

-- status_incidents: real incident history from public status pages
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

-- labeled_probe_readings: final training dataset
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
