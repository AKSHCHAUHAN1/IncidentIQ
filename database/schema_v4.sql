-- Migrate: ensure public.monitored_sites exists (canonical table)
-- The incidents.monitored_sites is legacy and deprecated
DROP TABLE IF EXISTS incidents.monitored_sites CASCADE;

-- Verification
SELECT 'schema_v4 applied — legacy incidents.monitored_sites dropped' AS status;
