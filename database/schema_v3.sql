CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS incidents.incident_embeddings (
    id           TEXT PRIMARY KEY REFERENCES incidents.incidents(id) ON DELETE CASCADE,
    embedding    vector(5),          
    service_id   TEXT,
    severity     TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS idx_embeddings_vector
    ON incidents.incident_embeddings
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 10);

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

DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT id FROM incidents.incidents LOOP
        PERFORM incidents.generate_embedding(r.id);
    END LOOP;
END $$;

SELECT COUNT(*) AS embeddings_created FROM incidents.incident_embeddings;
