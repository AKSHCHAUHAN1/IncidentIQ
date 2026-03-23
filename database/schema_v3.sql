-- schema_v3: pgvector embeddings (optional — skipped if extension unavailable)
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector not available, skipping embedding tables';
  RETURN;
END $$;

-- Only create if extension succeeded
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE TABLE IF NOT EXISTS incidents.incident_embeddings (
      id         TEXT PRIMARY KEY REFERENCES incidents.incidents(id) ON DELETE CASCADE,
      embedding  vector(5),
      service_id TEXT,
      severity   TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Skipping incident_embeddings: %', SQLERRM;
END $$;

SELECT 'schema_v3 applied (pgvector optional)' AS status;
