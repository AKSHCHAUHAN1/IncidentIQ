# IncidentIQ — Real Data Pipeline

## The Data Problem (Solved)

The original project assumed we could get training data by waiting for sites to go down.
That doesn't work — modern sites have 99.9%+ uptime, meaning maybe 8 hours of outage per year.
You'd need years of data to get enough failure examples.

**The solution: predict performance degradation, not binary downtime.**
Sites degrade constantly — TTFB spikes, DNS slows, error rates rise, SSL certs expire.
These happen every day across any set of URLs. This gives you rich, continuous training signal.

---

## Data Sources (All Real, Zero Synthetic)

### Source 1: Your own probe service
The `website-probe` service probes 20 curated URLs every 60 seconds and writes to TimescaleDB.
After **7 days**: ~200,000 rows per URL = enough for LSTM and Isolation Forest baselines.
After **30 days**: rich enough for all three models with high confidence.

### Source 2: Google CrUX API
Chrome UX Report — real TTFB data from millions of Chrome users.
Gives you the true P75 baseline for each URL from real-world traffic.
Used to set anomaly detection thresholds per URL.

### Source 3: Public Statuspage APIs
20 companies (GitHub, Stripe, Cloudflare, Vercel, npm...) expose their full incident history
publicly via Atlassian Statuspage's JSON API. No authentication required.
These incidents are cross-referenced with probe readings to produce **real ground-truth labels**.

### Source 4: Programmatic labeling (weak supervision)
For probe readings not covered by status page incidents, deterministic statistical rules
label real observations. This is the **Snorkel** methodology — used at Google, Apple, Stanford.
Rules are grounded in network diagnostics:
- `dns_ms >> baseline while origin_time is normal` → `dns_degradation`
- `origin_time >> baseline while dns_ms is normal` → `origin_slowdown`
- `error_rate > 10%` → `error_spike`
- `ssl_days_left < 14` → `ssl_expiry_warning`

**The observations are 100% real. Only the label derivation is automated.**

---

## Setup & Run Order

### Prerequisites
```bash
pip install psycopg2-binary requests numpy scikit-learn torch joblib
npm install pg  # in website-probe service
```

### Step 0: Start probing (do this NOW — data takes time to accumulate)
```bash
# Add probe targets to your docker-compose website-probe service
# The service reads probe-targets.json automatically
docker-compose up -d website-probe
```

### Step 1: Fetch CrUX baselines (run once, re-run monthly)
```bash
# Run from repository root
python fetch_crux_baselines.py
# With free API key (faster):
python fetch_crux_baselines.py --api-key YOUR_GOOGLE_API_KEY
```
Get a free API key: https://console.cloud.google.com → Enable "Chrome UX Report API"

### Step 2: Fetch real incident history (run daily via cron)
```bash
python fetch_status_incidents.py --days 90
```
This pulls the last 90 days of real incidents from all 20 status pages.

### Step 3: Label probe data (run after 7+ days of probe data)
```bash
python label_probe_data.py
```
Cross-references probe readings with incident windows → labeled dataset in `ml.labeled_probe_readings`.

### Step 4: Train models
```bash
python train_models.py
# Or train individually:
python train_models.py --model if      # Isolation Forest
python train_models.py --model tfidf   # TF-IDF + LR
python train_models.py --model lstm    # LSTM
```

### Step 5: Retrain (set up weekly cron)
```cron
0 2 * * 0  cd /app && python fetch_status_incidents.py --days 7
0 3 * * 0  cd /app && python label_probe_data.py
0 4 * * 0  cd /app && python train_models.py
```

### Step 6: Apply schema migrations (including pivot tables)
```bash
./scripts/apply-schemas.sh
```

---

## Data Flow Diagram

```
Public URLs (20 targets)
        │
        ▼ every 60 seconds
website-probe (Node.js)
        │ TTFB, DNS, SSL, error_rate
        ▼
metrics.probe_readings (TimescaleDB)
        │
        ├──────────────────────────────────┐
        │                                  │
        ▼                                  ▼
fetch_crux_baselines.py         fetch_status_incidents.py
(Google CrUX real P75)          (Statuspage real incidents)
        │                                  │
        ▼                                  ▼
ml.url_baselines                ml.status_incidents
        │                                  │
        └──────────────┬───────────────────┘
                       │
                       ▼
             label_probe_data.py
             (cross-reference + z-score rules)
                       │
                       ▼
          ml.labeled_probe_readings
          ┌────────────────────────┐
          │ url, probed_at         │
          │ ttfb_ms, dns_ms, ...   │
          │ ttfb_zscore, ...       │
          │ metric_text            │ ← for TF-IDF
          │ anomaly_type           │ ← the label
          │ label_source           │ ← 'statuspage' | 'programmatic'
          └────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
     LSTM model   Isolation    TF-IDF + LR
     (TTFB        Forest       (classify
     forecast)    (anomaly     anomaly type)
                  detection)
```

---

## Model Data Requirements

| Model | What it uses | Minimum data |
|---|---|---|
| Isolation Forest | Normal rows from `labeled_probe_readings` | 500 normal rows (~8 hours) |
| TF-IDF + LR | All rows with `metric_text` and `anomaly_type` | 1,000 rows across classes |
| LSTM | All rows, grouped by URL, time-ordered | 1,000+ rows per URL (~17 hours) |

**Practical timeline:**
- Day 1: Start probe service
- Day 3: Run CrUX fetch + status incident fetch
- Day 7: Run label_probe_data.py → train IF and TF-IDF+LR (LSTM needs more)
- Day 14: Retrain all three models with two weeks of real data
- Day 30: Final training run — all models well-trained on real data

---

## Checking Data Quality

```sql
-- How much probe data do you have?
SELECT url, COUNT(*), MIN(probed_at), MAX(probed_at)
FROM metrics.probe_readings
GROUP BY url ORDER BY COUNT(*) DESC;

-- Label distribution in training data
SELECT anomaly_type, label_source, COUNT(*)
FROM ml.labeled_probe_readings
GROUP BY anomaly_type, label_source
ORDER BY COUNT(*) DESC;

-- Real incidents collected
SELECT service_name, anomaly_type, COUNT(*), AVG(duration_min)::INT as avg_min
FROM ml.status_incidents
GROUP BY service_name, anomaly_type
ORDER BY service_name;

-- Baselines computed
SELECT url, probe_ttfb_mean_ms, probe_ttfb_std_ms, baseline_computed_at
FROM ml.url_baselines
WHERE probe_ttfb_mean_ms IS NOT NULL;
```

---

## Academic Justification

**For your project report / presentation:**

1. **Probe data** is real HTTP measurements — same methodology used by Pingdom, Datadog Synthetics, and UptimeRobot.

2. **CrUX baselines** are Google's official field data (Chrome User Experience Report), used as the reference dataset for Core Web Vitals globally.

3. **Status page labels** are vendor-reported ground truth — the same companies use this data to measure their own SLA compliance.

4. **Programmatic labeling** is the Snorkel weak supervision framework (Ratner et al., 2017, NeurIPS) — used at Google Brain, Apple, and Stanford for large-scale label generation. It is not synthetic data generation; it is automated label inference on real observations.

5. **No data is fabricated.** Every TTFB, DNS time, error rate, and SSL value comes from a real HTTP probe to a real server.
