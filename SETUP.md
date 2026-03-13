# IncidentIQ — Setup Guide

## Prerequisites

- **Docker Desktop** — https://docker.com/products/docker-desktop
- **Node.js 18+** — https://nodejs.org

Verify:
```bash
docker --version           # 24+
docker compose version     # v2+
node --version             # v18+
```

---

## Start the project

### 1. Start all backend services
```bash
cd incident-predictor
docker compose up -d
```

### 2. Apply database schemas
```bash
./scripts/apply-schemas.sh
```

### 3. Start the frontend
```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**

---

## Verify everything is working

```bash
# All services should show "Up"
docker compose ps

# Probe data should be growing (20 URLs probed every 60s)
docker compose exec postgres psql -U postgres -d incident_predictor \
  -c "SELECT COUNT(*) FROM metrics.probe_readings;"

# Website probe should show 20/20 OK
docker compose logs website-probe --tail 5

# Real incidents collected from public status pages
docker compose exec postgres psql -U postgres -d incident_predictor \
  -c "SELECT COUNT(*) FROM ml.status_incidents;"

# ML service health
curl http://localhost:8000/health
```

---

## Train ML models

Models need **7+ days of probe data** to train properly. After that:

```bash
# Train all 3 models at once (takes a few minutes)
curl -X POST http://localhost:8000/train

# Verify models loaded
curl http://localhost:8000/health
# All should show true: lstm_loaded, iso_loaded, log_loaded
```

Or train individually:
```bash
docker compose exec ml-service python training/train_models.py
curl -X POST http://localhost:8000/reload
```

---

## Daily usage

### Start
```bash
docker compose up -d
cd frontend && npm run dev
```

### Stop
```bash
docker compose down          # keeps data
docker compose down -v       # WIPES everything
```

### Rebuild after code changes
```bash
docker compose up -d --build
```

### Check logs
```bash
docker compose logs website-probe --tail 20
docker compose logs data-ingestion --tail 20
docker compose logs decision-engine --tail 20
docker compose logs data-collector --tail 20
```

---

## Service URLs

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| API Gateway | http://localhost:3000 |
| ML Service | http://localhost:8000 |
| ML Docs (Swagger) | http://localhost:8000/docs |
| PostgreSQL | `localhost:5432` / DB: `incident_predictor` |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "relation does not exist" | `./scripts/apply-schemas.sh` |
| ML returns 503 | Models not trained yet — need 7+ days of data, then `curl -X POST http://localhost:8000/train` |
| Frontend can't connect | `echo "VITE_API_URL=http://localhost:3000" > frontend/.env` |
| Service crash-looping | `docker compose logs <service> --tail 20` |
| Wipe everything and start fresh | `docker compose down -v && docker compose up -d && ./scripts/apply-schemas.sh` |
