# IncidentIQ — Complete Setup & ML Training Guide

> **Intelligent Web Performance Anomaly Detector & SLA Predictor**
> B.Tech CSE (DevOps) · Semester 6 · UPES

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Docker Desktop | 24+ | https://docker.com/products/docker-desktop |
| Docker Compose | v2+ | Bundled with Docker Desktop |
| Node.js | 18+ | https://nodejs.org |

Verify:
```bash
docker --version           # 24+
docker compose version     # v2+
node --version             # v18+
```

---

## Part 1 — Project Setup

### Step 1: Start all backend services

```bash
docker compose up -d
```

This boots **10 containers**:

| Container | Role |
|---|---|
| `postgres` | TimescaleDB — stores all probe data, ML training data, predictions |
| `redis` | Message broker — streams probe readings to data-ingestion |
| `website-probe` | HTTP probes every 60s — writes real TTFB, DNS, SSL data |
| `data-collector` | Fetches Google CrUX baselines + real incident history |
| `ml-labeler` | Labels probe data using status page incidents + z-score rules |
| `ml-service` | FastAPI — serves LSTM, Isolation Forest, TF-IDF+LR predictions |
| `data-ingestion` | Redis consumer — calls ML service and decision engine |
| `decision-engine` | Confidence scoring + SLA breach forecasting + alert dispatch |
| `api-gateway` | REST API + WebSocket — serves the React frontend |
| `frontend` | React 18 + Vite — dashboard at http://localhost:5173 |

---

### Step 2: Apply database schemas

```bash
./scripts/apply-schemas.sh
```

This applies schemas in order:

| File | What it creates |
|---|---|
| `init.sql` | Core schemas, `public.monitored_sites`, `metrics.probe_readings` (hypertable), `ml.*` tables, `incidents.*` tables |
| `schema_v2.sql` | `ml.predictions`, `incidents.incidents`, `incidents.remediations` |
| `schema_v3.sql` | pgvector embeddings (optional — skipped if extension unavailable) |
| `schema_v4.sql` | Drops legacy `incidents.monitored_sites`, keeps `public.monitored_sites` as canonical |
| `schema_v5.sql` | Adds `response_time_ms`, `availability` columns to `probe_readings` |
| `schema_v6.sql` | Adds TimescaleDB compression + retention policies |

If you see `relation does not exist` errors — always run this first.

---

### Step 3: Start the frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend is live at **http://localhost:5173**

---

### Step 4: Verify all services are healthy

```bash
# All containers should show Up
docker compose ps

# Probe service is collecting data
docker compose logs website-probe --tail 5

# API gateway is responding
curl http://localhost:3000/health

# ML service is running (models not loaded yet — that's normal)
curl http://localhost:8000/health
# → { "lstm_loaded": false, "iso_loaded": false, "log_loaded": false }

# Probe data is accumulating
docker compose exec postgres psql -U postgres -d incident_predictor \
  -c "SELECT url, COUNT(*) FROM metrics.probe_readings GROUP BY url ORDER BY COUNT(*) DESC;"
```

---

### Step 5: Add a website to monitor

Open **http://localhost:5173/monitor** in your browser, enter any URL (e.g. `https://www.amazon.com`), and click Monitor.

Within 60 seconds the site card will show live TTFB, DNS, and status. Predictions begin appearing once models are trained.

---

## Part 2 — Understanding the Data Pipeline

Before training, you need to understand where the training data comes from. There is **zero synthetic data** in this project.

### The Four Real Data Sources

```
Public URLs (20 training targets)
        │
        ▼ every 60 seconds
website-probe (Node.js)
 measures: TTFB, DNS, TLS, SSL, error_rate via real HTTP sockets
        │
        ▼
metrics.probe_readings (TimescaleDB hypertable)
        │
        ├────────────────────────────────────┐
        ▼                                    ▼
fetch_crux_baselines.py          fetch_status_incidents.py
Google CrUX API                  20 x public Statuspage APIs
(real Chrome user P75 TTFB)      (GitHub, Stripe, Cloudflare etc.)
        │                                    │
        ▼                                    ▼
ml.url_baselines                 ml.status_incidents
(per-URL normal threshold)       (real ground-truth labels)
        │                                    │
        └──────────────┬─────────────────────┘
                       │
                       ▼
             label_probe_data.py
        (cross-reference + z-score rules)
                       │
                       ▼
          ml.labeled_probe_readings
     ┌──────────────────────────────────┐
     │ url, probed_at                   │
     │ ttfb_ms, dns_ms, origin_time_ms  │
     │ ttfb_zscore, dns_zscore, ...     │
     │ metric_text  ← for TF-IDF+LR    │
     │ anomaly_type ← the label         │
     │ label_source ← statuspage|prog.  │
     │ label_confidence                 │
     └──────────────────────────────────┘
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
    LSTM model   Isolation      TF-IDF + LR
    TTFB forecast  Forest       Anomaly type
    next 30 min   Anomaly flag  classification
```

### Source 1 — website-probe (your own measurements)
Real HTTP socket-level measurements from Node.js. Not estimates — actual socket events. Every probe writes one row to `metrics.probe_readings`. After 7 days of running: ~200,000 rows per URL.

### Source 2 — Google CrUX API
Chrome UX Report. Google collects real TTFB data from millions of Chrome users globally. The P75 TTFB for each URL becomes the per-URL anomaly threshold: `threshold = P75 × 2.5`. Used to define what "normal" means for each specific URL.

### Source 3 — Public Statuspage APIs
GitHub, Stripe, Cloudflare, Vercel, npm, Shopify and 14 others run public Atlassian Statuspage instances. Their full incident history is available as a public JSON API with no authentication. These provide **real ground-truth labels**: exact timestamps when a specific type of degradation was confirmed by the vendor.

### Source 4 — Programmatic labeling (weak supervision)
For probe readings not covered by a status page incident window, deterministic z-score rules assign labels. This is the **Snorkel** weak supervision methodology (Ratner et al., NeurIPS 2017) — used at Google Brain, Apple, and Stanford. The observations are 100% real; only the label derivation is automated.

**Labeling rules:**

| Rule | Condition | Label | Confidence |
|---|---|---|---|
| SSL hard threshold | `ssl_days_left < 14` | `ssl_expiry_warning` | 1.00 |
| Error spike | `error_rate > 10%` | `error_spike` | 0.92 |
| Normal | `ttfb_zscore < 2.0` | `normal` | 1.00 |
| DNS dominant | `dns_zscore > 2.0 AND dns_zscore > origin_zscore × 1.5` | `dns_degradation` | 0.70–0.95 |
| Origin dominant | `origin_zscore > 2.0 AND origin_zscore > dns_zscore × 1.5` | `origin_slowdown` | 0.70–0.95 |
| General spike | `ttfb_zscore > 3.0` | `latency_spike` | 0.75 |

---

## Part 3 — ML Model Training

### Data readiness timeline

| Day | What to do | Models trainable |
|---|---|---|
| Day 1 | Start services, `docker compose up -d` | None yet |
| Day 1 | Run CrUX fetch + status incident fetch | Baselines stored |
| Day 3 | Run labeler | IF and TF-IDF+LR can train |
| Day 7 | Full label run + train all models | All three |
| Day 14 | Retrain | Better LSTM |
| Day 30 | Final retrain | All models production-quality |

---

### Step 1: Fetch real baselines from Google CrUX

```bash
docker compose exec data-collector python3 src/fetch_crux_baselines.py
```

With your API key (faster — 150 req/100s instead of 150 req/day):
```bash
# The GOOGLE_API_KEY is already set in docker-compose.yml
# Or override:
docker compose exec -e GOOGLE_API_KEY=AIzaSyCb6nJx7lZNuDeQoPVqLchYd-TRY16JqWc data-collector python3 src/fetch_crux_baselines.py
```

**What it does:** Hits `https://chromeuxreport.googleapis.com/v1/records:queryRecord` for each of the 20 probe targets. Stores P75 TTFB and derived anomaly threshold in `ml.url_baselines`.

**Verify:**
```bash
docker compose exec postgres psql -U postgres -d incident_predictor \
  -c "SELECT url, ttfb_p75_ms, ttfb_anomaly_threshold_ms FROM ml.url_baselines;"
```

---

### Step 2: Fetch real incident history from status pages

```bash
docker compose exec data-collector python3 src/fetch_status_incidents.py --days 90
```

**What it does:** Hits the public Statuspage JSON API for all 20 target companies. Fetches the last 90 days of resolved incidents. Classifies each incident into one of 5 anomaly types using keyword regex. Stores in `ml.status_incidents`.

**Verify:**
```bash
docker compose exec postgres psql -U postgres -d incident_predictor \
  -c "SELECT service_name, anomaly_type, COUNT(*), AVG(duration_min)::INT as avg_min
      FROM ml.status_incidents
      GROUP BY service_name, anomaly_type
      ORDER BY COUNT(*) DESC;"
```

These are the real ground-truth labels that will be cross-referenced with your probe data.

---

### Step 3: Label probe data

```bash
docker compose exec ml-labeler python src/label_probe_data.py
```

**What it does:**
1. Queries `metrics.probe_readings` for all unlabeled rows
2. For each reading — checks if it falls inside a known status page incident window (label = ground truth, confidence 1.0)
3. If not — applies z-score rules against per-URL baselines (programmatic labeling)
4. Generates `metric_text` tokens for TF-IDF model
5. Batch inserts into `ml.labeled_probe_readings`

**Verify:**
```bash
docker compose exec postgres psql -U postgres -d incident_predictor \
  -c "SELECT anomaly_type, label_source, COUNT(*)
      FROM ml.labeled_probe_readings
      GROUP BY anomaly_type, label_source
      ORDER BY COUNT(*) DESC;"
```

You should see rows across multiple anomaly types. `label_source` will be `statuspage` (ground truth) or `programmatic` (weak supervision).

---

### Step 4: Train all three models

```bash
curl -X POST http://localhost:8000/train
```

Or directly inside the container:
```bash
docker compose exec ml-service python training/train_models.py
```

Train individual models:
```bash
docker compose exec ml-service python training/train_models.py --model if     # Isolation Forest only
docker compose exec ml-service python training/train_models.py --model tfidf  # TF-IDF + LR only
docker compose exec ml-service python training/train_models.py --model lstm   # LSTM only
```

Lower the minimum sample threshold if you have limited early data:
```bash
docker compose exec ml-service python training/train_models.py --min-samples 100
```

---

### Model 1 — LSTM Time-Series Predictor

**File:** `services/ml-service/training/trainer.py`

**What it does:** Given the last 60 minutes of `[ttfb_ms, dns_ms, error_rate, ssl_days_left]` for a URL, predicts the next 30 minutes of TTFB trajectory. If the forecast crosses the 2000ms SLA threshold, it returns how many minutes away that breach is.

**Architecture:**
```
Input: (batch, 60 timesteps, 4 features)  ← last 60 minutes, z-score normalized
    ↓
LSTM Layer 1: 128 hidden units
    ↓
LSTM Layer 2: 128 hidden units
    ↓
Attention: learns which time steps matter most
    ↓
Fully connected: 128 → 30 × 4 output
    ↓
Output: (batch, 30) ← predicted TTFB for next 30 minutes, denormalized
```

**Training details:**
- Loss: Mean Squared Error (regression)
- Optimizer: Adam, lr=0.001
- Early stopping: patience=5 epochs
- Train/val split: 80/20, time-ordered — never shuffled (shuffling time series causes data leakage)
- Normalization: per-service z-score using mean/std computed from training data
- Saves: `model.pt`, `scaler.pkl`, `baseline.pkl`

**Training output you should see:**
```
[1/5] Loading data from TimescaleDB...
      Loaded 12480 timesteps × 4 features
[2/5] Computing service baseline (mean/std per feature)...
      ttfb_ms      mean=287.42  std=94.31
      dns_ms       mean=18.76   std=8.43
      error_rate   mean=0.02    std=0.04
      ssl_days_left mean=187.3  std=42.1
[3/5] Normalizing to z-scores...
[4/5] Training LSTM...
  Epoch 01/20  train=0.142381  val=0.138920
  Epoch 02/20  train=0.098234  val=0.094711
  ✓ Best model saved (val=0.094711)
  ...
  Early stopping at epoch 12
[5/5] Done. Best val_loss=0.042183
Saved: model.pt  scaler.pkl  baseline.pkl
```

---

### Model 2 — Isolation Forest Anomaly Detector

**File:** `services/ml-service/training/train_isolation_forest.py`

**What it does:** Learns what "normal" probe readings look like by training exclusively on non-anomalous rows. In production, scores any new reading by how quickly it can be isolated in random decision trees — anomalous points isolate faster than normal ones.

**Why trained on normal data only:** This is the key property of Isolation Forest. You don't need labeled anomaly examples. The model learns the boundary of normal behaviour. Anything outside that boundary gets flagged.

**Architecture:**
```
Training data: only rows WHERE anomaly_type = 'normal' from ml.labeled_probe_readings
Features: [ttfb_ms, dns_ms, error_rate, ssl_days_left, origin_time_ms, ttfb_zscore, dns_zscore]
n_estimators: 300 trees
contamination: 0.05 (expects ~5% of future data to be anomalous)
Preprocessing: StandardScaler
Output per inference: anomaly score (0–1) + binary flag (-1 anomaly, 1 normal)
```

**Training output:**
```
==================================================
Isolation Forest Training
==================================================
Loaded 9847 rows of data
Model saved: /app/models/isolation_forest.pkl
```

**Saved file:** `isolation_forest.pkl`

---

### Model 3 — TF-IDF + Logistic Regression Classifier

**File:** `services/ml-service/training/train_log_model.py`

**What it does:** Given a string of discretized metric tokens, classifies which type of anomaly is occurring. This answers "what is wrong" after Isolation Forest answers "something is wrong."

**Why text tokens instead of raw floats:** TF-IDF processes text. Raw floats like `ttfb_ms=847.3` are meaningless to TF-IDF. Discretizing into tokens like `ttfb_very_slow` converts the continuous metric space into a vocabulary the classifier can learn from. Bigrams (pairs of tokens) capture co-occurring patterns that single tokens miss — `"dns_z_critical origin_z_normal"` is far more specific than either token alone.

**Token vocabulary:**

| Metric | Tokens |
|---|---|
| TTFB level | `ttfb_fast`, `ttfb_moderate`, `ttfb_slow`, `ttfb_very_slow` |
| DNS level | `dns_fast`, `dns_moderate`, `dns_slow`, `dns_very_slow` |
| TTFB/DNS ratio | `ratio_dns_dominant`, `ratio_balanced`, `ratio_origin_dominant` |
| Error rate | `errors_clean`, `errors_low`, `errors_high`, `errors_critical` |
| SSL | `ssl_ok`, `ssl_soon`, `ssl_warning`, `ssl_critical` |
| Status code | `status_ok`, `status_client_error`, `status_server_error` |

**Example metric_text strings:**

| Pattern | Label |
|---|---|
| `ttfb_slow dns_very_slow ratio_dns_dominant errors_clean ssl_ok` | `dns_degradation` |
| `ttfb_very_slow dns_fast ratio_origin_dominant errors_low ssl_ok` | `origin_slowdown` |
| `ttfb_fast dns_fast ratio_balanced errors_critical status_server_error ssl_ok` | `error_spike` |
| `ttfb_moderate dns_fast ratio_balanced errors_clean ssl_critical` | `ssl_expiry_warning` |

**Architecture:**
```
Input: metric_text string
    ↓
TfidfVectorizer: ngram_range=(1,2), max_features=1200, min_df=1
    ↓
LogisticRegression: class_weight='balanced', max_iter=1000
    ↓
Output: anomaly_type (one of 6 classes) + per-class probabilities
```

`class_weight='balanced'` is critical — without it, the model would predict "normal" for everything since 80%+ of readings are normal.

**Training output:**
```
======================================================================
Pattern classifier (TF-IDF + LR)
Train samples: 576 | Test samples: 145
                    precision  recall  f1-score  support
         dns_degradation  0.97    0.93    0.95      24
           error_spike    0.96    0.98    0.97      24
        latency_spike     0.94    0.96    0.95      20
              normal      0.98    0.99    0.99      48
       origin_slowdown    0.95    0.94    0.94      24
   ssl_expiry_warning     1.00    1.00    1.00       5

Saved: /app/models/pattern_classifier.pkl
Saved: /app/models/log_classifier.pkl
```

---

### Step 5: Verify models are loaded

```bash
curl http://localhost:8000/health
```

Expected response after successful training:
```json
{
  "lstm_loaded": true,
  "iso_loaded": true,
  "log_loaded": true,
  "baseline_loaded": true,
  "status": "ready"
}
```

If any model shows `false`, check:
```bash
docker compose logs ml-service --tail 20
ls -la $(docker compose exec ml-service ls /app/models/)
```

---

### Step 6: Test the ensemble endpoint

```bash
curl -X POST http://localhost:8000/ensemble \
  -H "Content-Type: application/json" \
  -d '{
    "metrics_window": [
      [287, 18, 0.01, 190],
      [290, 19, 0.01, 190],
      [295, 18, 0.01, 190],
      [310, 19, 0.02, 190],
      [350, 20, 0.02, 190],
      [420, 21, 0.03, 190],
      [580, 22, 0.04, 190],
      [750, 23, 0.05, 190],
      [900, 25, 0.06, 190],
      [1100, 28, 0.08, 190]
    ],
    "log_text": "ttfb_slow dns_fast ratio_origin_dominant errors_low status_ok ssl_ok"
  }'
```

Expected response:
```json
{
  "severity": "warning",
  "confidence": 0.68,
  "root_cause": "origin_slowdown",
  "breach_eta_min": 22,
  "iso_flag": -1,
  "prediction": [[...], ...],
  "message": "origin_slowdown detected on service. TTFB rising, estimated SLA breach in 22 minutes."
}
```

---

## Part 4 — How the Ensemble Works

All three models run on every probe reading for user-added sites. Their outputs are combined:

```
Every 60s probe reading (user-added site only)
            │
            ▼
   data-ingestion worker
   builds 60-reading window
            │
            ▼
   POST /ensemble → ml-service
            │
   ┌────────┼────────────┐
   ▼        ▼            ▼
  LSTM     IF           TF-IDF+LR
  failure  anomaly      root_cause
  prob     score        confidence
  (0-1)    (0-1)        (0-1)
   │        │            │
   └────────┴────────────┘
            │
   confidence = (lstm × 0.40) + (if_score × 0.35) + (lr × 0.25)
   + 0.15 bonus if iso_flag == -1 (confirmed anomaly)
            │
            ▼
   decision-engine /evaluate
            │
   ┌────────┼──────────────────┐
   ▼        ▼                  ▼
  ≥ 90%   70–89%            < 70%
  auto     approval          log
  alert    queue             only
```

**Three-tier action system:**

| Confidence | What happens | Where it appears |
|---|---|---|
| ≥ 90% | Alert fired, incident created | Dashboard toast + Incidents page |
| 70–89% | Queued for review | Alerts page with "Action Taken" / "Ignore" buttons |
| < 70% | Logged only | Not visible in frontend |

---

## Part 5 — Retraining

### Weekly automated retrain (runs inside ml-labeler container)
The ml-labeler container automatically runs `label_probe_data.py` every 6 hours via its shell loop in docker-compose.yml. Retraining must be triggered manually or via cron.

### Manual retrain
```bash
# Trigger via API (runs inside ml-service container)
curl -X POST http://localhost:8000/train

# Or directly
docker compose exec ml-service python training/train_models.py

# Reload models without container restart
curl -X POST http://localhost:8000/reload
```

### Weekly cron (add to crontab on host machine)
```cron
# Every Sunday at 2am — fetch new incidents
0 2 * * 0  docker compose exec -T data-collector python3 src/fetch_status_incidents.py --days 7

# Every Sunday at 3am — run labeler
0 3 * * 0  docker compose exec -T ml-labeler python src/label_probe_data.py

# Every Sunday at 4am — retrain
0 4 * * 0  curl -X POST http://localhost:8000/train
```

---

## Part 6 — Data Quality Checks

Run these queries anytime to understand your data:

```sql
-- How much probe data per URL?
SELECT url, COUNT(*) as rows, 
       MIN(probed_at) as first, 
       MAX(probed_at) as last,
       ROUND(EXTRACT(EPOCH FROM (MAX(probed_at) - MIN(probed_at)))/3600) as hours
FROM metrics.probe_readings
GROUP BY url ORDER BY rows DESC;

-- Label distribution (training data quality)
SELECT anomaly_type, label_source, COUNT(*),
       ROUND(AVG(label_confidence)::numeric, 3) as avg_confidence
FROM ml.labeled_probe_readings
GROUP BY anomaly_type, label_source
ORDER BY COUNT(*) DESC;

-- Real incidents collected (ground truth labels)
SELECT service_name, anomaly_type, COUNT(*), AVG(duration_min)::INT as avg_duration_min
FROM ml.status_incidents
GROUP BY service_name, anomaly_type
ORDER BY service_name, COUNT(*) DESC;

-- URL baselines (are they computed?)
SELECT url, 
       ROUND(probe_ttfb_mean_ms::numeric, 1) as ttfb_mean,
       ROUND(probe_ttfb_std_ms::numeric, 1) as ttfb_std,
       ROUND(ttfb_anomaly_threshold_ms::numeric, 1) as anomaly_threshold,
       baseline_computed_at
FROM ml.url_baselines
WHERE probe_ttfb_mean_ms IS NOT NULL
ORDER BY url;

-- Active predictions (is the pipeline working?)
SELECT url, severity, 
       ROUND(confidence::numeric, 3) as confidence,
       status, created_at
FROM ml.predictions
WHERE url IN (SELECT url FROM public.monitored_sites WHERE is_training_only = FALSE)
ORDER BY created_at DESC
LIMIT 20;

-- User-added sites vs training sites
SELECT is_training_only, is_active, COUNT(*) 
FROM public.monitored_sites 
GROUP BY is_training_only, is_active;
```

---

## Part 7 — Troubleshooting

| Problem | Diagnosis | Fix |
|---|---|---|
| `relation does not exist` | Schema not applied | `./scripts/apply-schemas.sh` |
| ML returns 503 | Models not trained | Collect data → label → train |
| `Only 0 labeled rows` | label_probe_data never ran | `docker compose exec ml-labeler python src/label_probe_data.py` |
| Site shows "Collecting data..." | New site not probed yet | Wait up to 60 seconds |
| Training URLs visible in frontend | Schema mismatch | Check `public.monitored_sites` has `is_training_only` column |
| Predictions not appearing | Pipeline broken | Check worker → ml-service → decision-engine logs in order |
| `lstm_loaded: false` after training | model.pt not saved | Check `/app/models/` volume, retrain |
| `iso_loaded: false` | isolation_forest.pkl missing | `docker compose exec ml-service python training/train_models.py --model if` |

### Check pipeline at each step:
```bash
# 1. Is probe data flowing?
docker compose logs website-probe --tail 10

# 2. Is Redis streaming?
docker compose exec redis redis-cli XLEN metrics_stream

# 3. Is data-ingestion consuming?
docker compose logs data-ingestion --tail 10

# 4. Is ML service responding?
curl http://localhost:8000/health

# 5. Is decision engine running?
docker compose logs decision-engine --tail 10

# 6. Is api-gateway broadcasting?
docker compose logs api-gateway --tail 10
```

### Nuclear reset (wipes all data):
```bash
docker compose down -v
docker compose up -d
./scripts/apply-schemas.sh
```

---

## Part 8 — Service URLs

| Service | URL |
|---|---|
| Frontend Dashboard | http://localhost:5173 |
| API Gateway | http://localhost:3000 |
| ML Service | http://localhost:8000 |
| ML Swagger Docs | http://localhost:8000/docs |
| PostgreSQL | `localhost:5432` · DB: `incident_predictor` · User/Pass: `postgres/postgres` |

---

## Quick Reference — Most Used Commands

```bash
# Start everything
docker compose up -d && cd frontend && npm run dev

# Apply schemas
./scripts/apply-schemas.sh

# Full data + training pipeline (run in order)
docker compose exec data-collector python3 src/fetch_crux_baselines.py
docker compose exec data-collector python3 src/fetch_status_incidents.py --days 90
docker compose exec ml-labeler python src/label_probe_data.py
curl -X POST http://localhost:8000/train
curl http://localhost:8000/health

# Check probe count
docker compose exec postgres psql -U postgres -d incident_predictor \
  -c "SELECT COUNT(*) FROM metrics.probe_readings;"

# Check labeled rows
docker compose exec postgres psql -U postgres -d incident_predictor \
  -c "SELECT anomaly_type, COUNT(*) FROM ml.labeled_probe_readings GROUP BY anomaly_type;"

# Rebuild after code changes
docker compose up -d --build

# View logs for any service
docker compose logs <service-name> --tail 20

# Stop (keeps data)
docker compose down

# Stop (wipes all data)
docker compose down -v
```
