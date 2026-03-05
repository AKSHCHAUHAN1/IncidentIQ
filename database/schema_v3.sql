-- ============================================================
-- Schema v3 — pgvector similarity search
-- Run: docker compose exec postgres psql -U postgres -d incident_predictor -f /tmp/schema_v3.sql
-- ============================================================

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Incident embeddings table
-- Each incident gets a 5-dimensional embedding from its metrics snapshot
-- (cpu, memory, request_rate, error_rate, latency)
-- pgvector finds the most similar past incidents using cosine distance
CREATE TABLE IF NOT EXISTS incidents.incident_embeddings (
    id           TEXT PRIMARY KEY REFERENCES incidents.incidents(id) ON DELETE CASCADE,
    embedding    vector(5),           -- normalized metric vector
    service_id   TEXT,
    severity     TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS idx_embeddings_vector
    ON incidents.incident_embeddings
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 10);

-- Function to auto-generate embedding when incident is created
-- Pulls from metrics_snapshot JSONB column
CREATE OR REPLACE FUNCTION incidents.generate_embedding(incident_id TEXT)
RETURNS void AS $$
DECLARE
    snap   JSONB;
    vec    float[];
    cpu    float;
    mem    float;
    rr     float;
    err    float;
    lat    float;
BEGIN
    SELECT metrics_snapshot INTO snap
    FROM incidents.incidents
    WHERE id = incident_id;

    IF snap IS NULL THEN RETURN; END IF;

    cpu := COALESCE((snap->>'cpu')::float,          0);
    mem := COALESCE((snap->>'memory')::float,       0);
    rr  := COALESCE((snap->>'request_rate')::float, 0);
    err := COALESCE((snap->>'error_rate')::float,   0);
    lat := COALESCE((snap->>'latency')::float,      0);

    -- Normalize each metric to 0-1 range using known max values
    -- This makes the cosine similarity meaningful across different scales
    vec := ARRAY[
        LEAST(cpu / 100.0,  1.0),
        LEAST(mem / 100.0,  1.0),
        LEAST(rr  / 2000.0, 1.0),
        LEAST(err / 100.0,  1.0),
        LEAST(lat / 1000.0, 1.0)
    ];

    INSERT INTO incidents.incident_embeddings (id, embedding, service_id, severity)
    SELECT incident_id, vec::vector, service_id, severity
    FROM incidents.incidents WHERE id = incident_id
    ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding;
END;
$$ LANGUAGE plpgsql;

-- Backfill embeddings for existing incidents
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT id FROM incidents.incidents LOOP
        PERFORM incidents.generate_embedding(r.id);
    END LOOP;
END $$;

SELECT COUNT(*) AS embeddings_created FROM incidents.incident_embeddings;
