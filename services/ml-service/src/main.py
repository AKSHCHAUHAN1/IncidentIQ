"""
main.py — ML Service (Month 3 final)

Models:
  LSTM             → /predict      (z-score normalized forecasting)
  Isolation Forest → /anomaly      (statistical anomaly detection)
  TF-IDF+LR       → /classify-log (log severity classification)
  Ensemble         → /ensemble     (fusion of all three)
"""

import os
import sys
import torch
import joblib
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import FEATURES, INPUT_WINDOW, OUTPUT_WINDOW
from model  import LSTMModel

app = FastAPI(title="IncidentIQ ML Service")

# ── Load models ───────────────────────────────────────────────
MODEL_DIR = "/app/models"

lstm_model    = None
scaler        = None
baseline      = None   # {"mean": array, "std": array}
iso_model     = None
log_classifier = None  # sklearn Pipeline

def load_models():
    global lstm_model, scaler, baseline, iso_model, log_classifier

    # LSTM
    lstm_path = os.path.join(MODEL_DIR, "model.pt")
    if os.path.exists(lstm_path):
        lstm_model = LSTMModel(len(FEATURES))
        lstm_model.load_state_dict(torch.load(lstm_path, map_location="cpu"))
        lstm_model.eval()
        print("✓ LSTM loaded")
    else:
        print("✗ LSTM not found — train first")

    # Scaler / baseline
    scaler_path   = os.path.join(MODEL_DIR, "scaler.pkl")
    baseline_path = os.path.join(MODEL_DIR, "baseline.pkl")
    if os.path.exists(scaler_path):
        scaler = joblib.load(scaler_path)
        print("✓ Scaler loaded")
    if os.path.exists(baseline_path):
        baseline = joblib.load(baseline_path)
        print("✓ Baseline loaded")

    # Isolation Forest
    iso_path = os.path.join(MODEL_DIR, "isolation_forest.pkl")
    if os.path.exists(iso_path):
        iso_model = joblib.load(iso_path)
        print("✓ Isolation Forest loaded")
    else:
        print("✗ Isolation Forest not found — train first")

    # Log classifier (TF-IDF + LR)
    log_path = os.path.join(MODEL_DIR, "log_classifier.pkl")
    if os.path.exists(log_path):
        log_classifier = joblib.load(log_path)
        print("✓ Log classifier loaded")
    else:
        print("✗ Log classifier not found — train first")

load_models()


# ── Schemas ───────────────────────────────────────────────────
class PredictRequest(BaseModel):
    data: List[List[float]]   # shape: (INPUT_WINDOW, num_features)

class LogRequest(BaseModel):
    log_text: str

class EnsembleRequest(BaseModel):
    metrics_window: List[List[float]]    # (INPUT_WINDOW, num_features)
    log_text: Optional[str] = ""

class AnomalyRequest(BaseModel):
    data: List[List[float]]


# ── Helpers ───────────────────────────────────────────────────
def to_zscore(window_np):
    """Normalize raw metric window using saved baseline."""
    if baseline is not None:
        return (window_np - baseline["mean"]) / baseline["std"]
    elif scaler is not None:
        return scaler.transform(window_np)
    return window_np

def from_zscore(zscores):
    """Convert z-score predictions back to raw values."""
    if baseline is not None:
        return zscores * baseline["std"] + baseline["mean"]
    elif scaler is not None:
        return scaler.inverse_transform(zscores)
    return zscores


# ── /predict — LSTM forecast ──────────────────────────────────
@app.post("/predict")
def predict(request: PredictRequest):
    if lstm_model is None:
        raise HTTPException(503, "LSTM model not loaded")

    arr = np.array(request.data, dtype=np.float32)
    if arr.shape != (INPUT_WINDOW, len(FEATURES)):
        raise HTTPException(400, f"Expected shape ({INPUT_WINDOW}, {len(FEATURES)}), got {arr.shape}")

    # Normalize → run LSTM → denormalize
    normalized = to_zscore(arr)
    inp        = torch.tensor(normalized[np.newaxis, ...], dtype=torch.float32)

    with torch.no_grad():
        out = lstm_model(inp)  # (1, OUTPUT_WINDOW * num_features)

    z_pred   = out.numpy().reshape(OUTPUT_WINDOW, len(FEATURES))
    raw_pred = from_zscore(z_pred)

    return {
        "prediction":    raw_pred.tolist(),
        "feature_names": FEATURES,
        "output_window": OUTPUT_WINDOW,
    }


# ── /anomaly — Isolation Forest ───────────────────────────────
@app.post("/anomaly")
def detect_anomaly(request: AnomalyRequest):
    if iso_model is None:
        raise HTTPException(503, "Isolation Forest not loaded")

    arr   = np.array(request.data, dtype=np.float32)
    flags = iso_model.predict(arr)           # -1 = anomaly, 1 = normal
    scores = iso_model.decision_function(arr) # negative = more anomalous

    return {
        "anomaly_flags":  flags.tolist(),
        "anomaly_scores": scores.tolist(),
        "anomaly_count":  int((flags == -1).sum()),
    }


# ── /classify-log — TF-IDF + LR ──────────────────────────────
@app.post("/classify-log")
def classify_log(req: LogRequest):
    if log_classifier is None:
        raise HTTPException(503, "Log classifier not loaded")

    pred  = log_classifier.predict([req.log_text])[0]
    proba = log_classifier.predict_proba([req.log_text])[0]

    label_map = {0: "normal", 1: "warning", 2: "critical"}
    return {
        "prediction":    label_map[pred],
        "probabilities": {
            "normal":   float(proba[0]),
            "warning":  float(proba[1]),
            "critical": float(proba[2]),
        }
    }


# ── /ensemble — Fusion of all three ──────────────────────────
@app.post("/ensemble")
def ensemble_predict(req: EnsembleRequest):
    if lstm_model is None:
        raise HTTPException(503, "LSTM model not loaded")

    arr  = np.array(req.metrics_window, dtype=np.float32)
    norm = to_zscore(arr)
    inp  = torch.tensor(norm[np.newaxis, ...], dtype=torch.float32)

    with torch.no_grad():
        out = lstm_model(inp)

    z_pred   = out.numpy().reshape(OUTPUT_WINDOW, len(FEATURES))
    raw_pred = from_zscore(z_pred)
    worst    = raw_pred[-1]  # final forecast step

    # Map features
    feat_idx = {f: i for i, f in enumerate(FEATURES)}
    cpu         = float(worst[feat_idx.get("cpu", 0)])
    memory      = float(worst[feat_idx.get("memory", 1)])
    error_rate  = float(worst[feat_idx.get("error_rate", 3)])
    latency     = float(worst[feat_idx.get("latency", 4)])

    # Isolation Forest on forecast
    iso_flag = 1
    if iso_model is not None:
        iso_flag = int(iso_model.predict([worst])[0])

    # Log classification
    log_label = "normal"
    log_proba = {}
    if log_classifier is not None and req.log_text:
        log_label = log_classifier.predict([req.log_text])[0]
        proba     = log_classifier.predict_proba([req.log_text])[0]
        log_proba = {"normal": float(proba[0]), "warning": float(proba[1]), "critical": float(proba[2])}
        log_label = ["normal", "warning", "critical"][log_label]

    # Fusion rules
    if (iso_flag == -1 or log_label == "critical" or
            cpu > 85 or memory > 85 or error_rate > 20 or latency > 300):
        severity = "critical"
    elif (log_label == "warning" or
            cpu > 70 or memory > 75 or error_rate > 10 or latency > 200):
        severity = "warning"
    else:
        severity = "normal"

    return {
        "severity":        severity,
        "lstm_prediction": raw_pred.tolist(),
        "iso_flag":        iso_flag,
        "log_label":       log_label,
        "log_proba":       log_proba,
        "forecast_worst":  {
            "cpu":         cpu,
            "memory":      memory,
            "error_rate":  error_rate,
            "latency":     latency,
        },
    }


# ── /health ───────────────────────────────────────────────────
@app.get("/health")
def health():
    return {
        "status":       "running",
        "lstm_loaded":  lstm_model    is not None,
        "iso_loaded":   iso_model     is not None,
        "log_loaded":   log_classifier is not None,
        "baseline_loaded": baseline   is not None,
    }


# ── /reload — hot-reload models without restart ───────────────
@app.post("/reload")
def reload_models():
    load_models()
    return {"status": "reloaded"}