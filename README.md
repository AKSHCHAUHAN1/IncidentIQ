# IncidentIQ

> **Intelligent Web Performance Anomaly Detector & SLA Predictor**

IncidentIQ is a production-grade, microservice-based machine learning pipeline designed to monitor web infrastructure, detect real-time performance anomalies, and forecast Service Level Agreement (SLA) breaches before they occur. 

Built exclusively with real-world data, IncidentIQ employs a unique ensemble of time-series forecasting, unsupervised anomaly detection, and natural language processing (NLP) to provide a robust, end-to-end incident intelligence platform.

---

## 🌟 Key Features

- **Zero Synthetic Data:** Utilizes 100% real web socket metrics, Google Chrome User Experience (CrUX) API baselines, and historical ground-truth data from Atlassian Statuspage APIs.
- **SLA Breach Forecasting (LSTM):** Predicts Time-To-First-Byte (TTFB) trajectories up to 30 minutes into the future to warn engineers of impending degradation.
- **Unsupervised Anomaly Detection (Isolation Forest):** Learns the multi-dimensional boundary of "normal" service behavior to flag previously unseen performance spikes.
- **NLP-Driven Root Cause Analysis (TF-IDF + LR):** Translates raw numeric metrics into discrete text tokens to classify the root cause of the anomaly (e.g., DNS degradation, Origin slowdown).
- **Event-Driven Architecture:** Utilizes Redis Streams to decouple high-throughput probe data ingestion from heavy Machine Learning inference.
- **Weak Supervision Labeling:** Employs the Snorkel methodology to programmatically label unlabeled probe data using deterministic statistical z-score rules.

---

## 🏗️ System Architecture

IncidentIQ operates on a containerized microservices architecture comprising 10 distinct Docker containers:

1. **`postgres` (TimescaleDB):** Optimized for high-throughput time-series data storage.
2. **`redis`:** High-speed message broker utilizing Redis Streams for load-leveling probe metrics.
3. **`website-probe`:** Node.js daemon executing raw HTTP/TLS socket measurements every 60 seconds.
4. **`data-collector`:** Python service fetching Google CrUX baselines and historical incident logs.
5. **`ml-labeler`:** Applies Snorkel weak-supervision logic to auto-label data for training.
6. **`ml-service`:** FastAPI application serving the ML models and exposing the `/ensemble` inference endpoint.
7. **`data-ingestion`:** Redis consumer that buffers metrics into 60-minute matrices for ML evaluation.
8. **`decision-engine`:** Aggregates ML probabilities, calculates final confidence scores, and determines alert actions.
9. **`api-gateway`:** Express REST API and WebSocket server for real-time frontend streaming.
10. **`frontend`:** React 18 + Vite interactive dashboard.

---

## 🧠 Machine Learning Ensemble

The decision engine relies on a weighted three-tier ensemble model:

1. **LSTM (Long Short-Term Memory):** 
   - **Task:** Time-Series Regression.
   - **Mechanism:** Analyzes the past 60 minutes of `[ttfb, dns, error_rate, ssl]` to forecast the next 30 minutes, identifying exactly when a metric will cross the SLA failure threshold.
2. **Isolation Forest:**
   - **Task:** Unsupervised Anomaly Detection.
   - **Mechanism:** Trained *exclusively* on healthy data. It maps the mathematical boundary of normal performance and flags any data point requiring few decision-tree splits to isolate.
3. **TF-IDF + Logistic Regression:**
   - **Task:** Multi-Class Classification.
   - **Mechanism:** Converts raw float metrics into n-gram text tokens (e.g., `ttfb_slow`, `dns_fast`) to identify co-occurring patterns and classify the exact type of anomaly.

**Confidence Formula:**  
`Confidence = (LSTM × 0.40) + (IF_Score × 0.35) + (LR_Confidence × 0.25) + 0.15 (if IF confirms)`

---

## 🚀 Getting Started

### Prerequisites
- Docker Desktop (v24+)
- Docker Compose (v2+)
- Node.js (v18+)

### 1. Boot the Cluster
Start all 10 microservices in detached mode:
```bash
docker compose up -d
```

### 2. Apply Database Schemas
Initialize the TimescaleDB hypertables and required relational schemas:
```bash
./scripts/apply-schemas.sh
```

### 3. Launch the Frontend
```bash
cd frontend
npm install
npm run dev
```
The dashboard will be available at **http://localhost:5173**.

---

## 📊 Data Pipeline & Training Lifecycle

1. **Fetch Baselines:**
   ```bash
   docker compose exec data-collector python3 src/fetch_crux_baselines.py
   ```
2. **Fetch Ground Truth Incidents:**
   ```bash
   docker compose exec data-collector python3 src/fetch_status_incidents.py --days 90
   ```
3. **Label Probe Data (Weak Supervision):**
   ```bash
   docker compose exec ml-labeler python src/label_probe_data.py
   ```
4. **Train the ML Ensemble:**
   ```bash
   curl -X POST http://localhost:8000/train
   ```

---

## 🧪 Testing with Chaos & Load

To test the anomaly detection pipeline in real-time, execute the included k6 scripts in `tests/`. This will stage thousands of virtual users against a target, causing a TTFB spike that will be caught by the probe, streamed through Redis, analyzed by the ML ensemble, and triggered as a high-confidence alert on the React dashboard.

```bash
# Aggressive spike load test
k6 run tests/loadtest.js

# Gradual degradation test (slow TTFB climb)
k6 run tests/slow_degradation.js
```

---

## 📚 Acknowledgments
Developed as a B.Tech CSE (DevOps) Minor Project at UPES.
