#!/bin/bash
set -e

# Apply init.sql first (canonical schema — creates public.monitored_sites, metrics, ml, incidents schemas)
docker compose cp database/init.sql postgres:/tmp/init.sql
docker compose exec -T postgres psql -U postgres -d incident_predictor -f /tmp/init.sql

docker compose cp database/schema_v2.sql postgres:/tmp/schema_v2.sql
docker compose cp database/schema_v3.sql postgres:/tmp/schema_v3.sql
docker compose cp database/schema_v4.sql postgres:/tmp/schema_v4.sql
docker compose cp database/schema_v5.sql postgres:/tmp/schema_v5.sql
docker compose cp database/schema_v6.sql postgres:/tmp/schema_v6.sql
docker compose exec -T postgres psql -U postgres -d incident_predictor -f /tmp/schema_v2.sql
docker compose exec -T postgres psql -U postgres -d incident_predictor -f /tmp/schema_v3.sql
docker compose exec -T postgres psql -U postgres -d incident_predictor -f /tmp/schema_v4.sql
docker compose exec -T postgres psql -U postgres -d incident_predictor -f /tmp/schema_v5.sql
docker compose exec -T postgres psql -U postgres -d incident_predictor -f /tmp/schema_v6.sql
echo "All schemas applied."
