CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS metrics;
CREATE SCHEMA IF NOT EXISTS incidents;
CREATE SCHEMA IF NOT EXISTS ml;
CREATE SCHEMA IF NOT EXISTS audit;

-- Raw metrics
CREATE TABLE metrics.raw_metrics (
    time TIMESTAMPTZ NOT NULL,
    service_id TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    value DOUBLE PRECISION NOT NULL
);

SELECT create_hypertable('metrics.raw_metrics', 'time', if_not_exists => TRUE);

-- 1-min continuous aggregate
CREATE MATERIALIZED VIEW metrics.metrics_1min
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', time) AS bucket,
  service_id,
  metric_name,
  AVG(value) AS avg_value,
  MIN(value) AS min_value,
  MAX(value) AS max_value,
  STDDEV(value) AS stddev_value
FROM metrics.raw_metrics
GROUP BY bucket, service_id, metric_name;

SELECT add_continuous_aggregate_policy(
  'metrics.metrics_1min',
  start_offset => INTERVAL '1 hour',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute'
);

-- Services registry
CREATE TABLE incidents.services (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    team TEXT,
    repository_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Incident embeddings
CREATE TABLE ml.incident_embeddings (
    incident_id TEXT PRIMARY KEY,
    embedding vector(768)
);

-- Logs hypertable
CREATE TABLE audit.log_events (
    time TIMESTAMPTZ NOT NULL,
    service_id TEXT,
    level TEXT,
    message TEXT,
    classification TEXT
);

SELECT create_hypertable('audit.log_events', 'time', if_not_exists => TRUE);
