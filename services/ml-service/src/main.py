"""ML inference service for web performance anomaly detection and SLA forecasting."""

import os
import sys
from typing import List, Optional

import joblib
import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import FEATURES, INPUT_WINDOW, OUTPUT_WINDOW
from model import LSTMModel

app = FastAPI(title="IncidentIQ ML Service")

MODEL_DIR = os.getenv("MODEL_DIR", "/app/models")
os.makedirs(MODEL_DIR, exist_ok=True)
SLA_TTFB_MS = float(os.getenv("SLA_TTFB_MS", "2000"))

lstm_model = None
scaler = None
baseline = None
iso_model = None
if_scaler = None
log_classifier = None

ANOMALY_LABELS = {
    "dns_degradation",
    "origin_slowdown",
    "latency_spike",
    "error_spike",
    "ssl_expiry_warning",
    "cdn_throttling",
    "timeout_pattern",
}


def load_models():
    global lstm_model, scaler, baseline, iso_model, if_scaler, log_classifier

    lstm_model = None
    scaler = None
    baseline = None
    iso_model = None
    if_scaler = None
    log_classifier = None

    # LSTM — train_models.py saves as lstm_best.pt, legacy trainer saves as model.pt
    for lstm_name in ["lstm_best.pt", "model.pt"]:
        lstm_path = os.path.join(MODEL_DIR, lstm_name)
        if os.path.exists(lstm_path):
            try:
                lstm_model = LSTMModel(len(FEATURES))
                lstm_model.load_state_dict(torch.load(lstm_path, map_location="cpu", weights_only=True))
                lstm_model.eval()
                print(f"✓ LSTM loaded from {lstm_name}")
            except Exception as e:
                print(f"✗ LSTM load error ({lstm_name}): {e}")
                lstm_model = None
            break
    else:
        print("✗ LSTM not found — train first")

    scaler_path = os.path.join(MODEL_DIR, "scaler.pkl")
    baseline_path = os.path.join(MODEL_DIR, "baseline.pkl")
    if os.path.exists(scaler_path):
        scaler = joblib.load(scaler_path)
        print("✓ Scaler loaded")
    if os.path.exists(baseline_path):
        baseline = joblib.load(baseline_path)
        print("✓ Baseline loaded")

    iso_path = os.path.join(MODEL_DIR, "isolation_forest.pkl")
    if os.path.exists(iso_path):
        iso_model = joblib.load(iso_path)
        print("✓ Isolation Forest loaded")
    else:
        print("✗ Isolation Forest not found — train first")

    # IF scaler (saved alongside isolation forest by train_models.py)
    if_scaler_path = os.path.join(MODEL_DIR, "if_scaler.pkl")
    if os.path.exists(if_scaler_path):
        if_scaler = joblib.load(if_scaler_path)
        print("✓ IF Scaler loaded")

    # TF-IDF + LR pipeline — train_models.py saves as tfidf_lr_pipeline.pkl
    for clf_name in ["tfidf_lr_pipeline.pkl", "pattern_classifier.pkl", "log_classifier.pkl"]:
        clf_path = os.path.join(MODEL_DIR, clf_name)
        if os.path.exists(clf_path):
            log_classifier = joblib.load(clf_path)
            print(f"✓ Pattern classifier loaded from {clf_name}")
            break
    else:
        print("✗ Pattern classifier not found — train first")


load_models()


class PredictRequest(BaseModel):
    data: List[List[float]]


class LogRequest(BaseModel):
    log_text: str


class EnsembleRequest(BaseModel):
    metrics_window: List[List[float]]
    log_text: Optional[str] = ""


class AnomalyRequest(BaseModel):
    data: List[List[float]]


def _normalize_classifier_label(label) -> str:
    if isinstance(label, (int, np.integer)):
        return {0: "normal", 1: "warning", 2: "critical"}.get(int(label), "normal")
    return str(label)


def _classifier_probabilities(text: str) -> dict:
    if log_classifier is None:
        return {}
    if not hasattr(log_classifier, "predict_proba"):
        return {}

    probs = log_classifier.predict_proba([text])[0]
    classes = [_normalize_classifier_label(c) for c in getattr(log_classifier, "classes_", [])]
    if not classes:
        classes = [f"class_{i}" for i in range(len(probs))]
    return {classes[i]: float(probs[i]) for i in range(min(len(classes), len(probs)))}


def to_zscore(window_np: np.ndarray) -> np.ndarray:
    if baseline is not None:
        return (window_np - baseline["mean"]) / baseline["std"]
    if scaler is not None:
        return scaler.transform(window_np)
    return window_np


def from_zscore(zscores: np.ndarray) -> np.ndarray:
    if baseline is not None:
        return zscores * baseline["std"] + baseline["mean"]
    if scaler is not None:
        return scaler.inverse_transform(zscores)
    return zscores


def _validate_shape(arr: np.ndarray):
    expected = (INPUT_WINDOW, len(FEATURES))
    if arr.shape != expected:
        raise HTTPException(400, f"Expected shape {expected}, got {arr.shape}")


def _run_lstm(arr: np.ndarray) -> np.ndarray:
    if lstm_model is None:
        raise HTTPException(503, "LSTM model not loaded")
    normalized = to_zscore(arr)
    inp = torch.tensor(normalized[np.newaxis, ...], dtype=torch.float32)
    with torch.no_grad():
        out = lstm_model(inp)
    z_pred = out.numpy().reshape(OUTPUT_WINDOW, len(FEATURES))
    return from_zscore(z_pred)


def _root_cause_rule(ttfb_ms: float, dns_ms: float, error_rate: float, ssl_days_left: float, status_code: float = 200.0) -> str:
    if ssl_days_left < 14:
        return "ssl_expiry_warning"
    if status_code >= 500 or error_rate >= 10:
        return "error_spike"
    ratio = ttfb_ms / max(dns_ms, 1.0)
    if dns_ms >= 250 and ratio <= 3.5:
        return "dns_degradation"
    if ttfb_ms >= 1200 and ratio >= 5:
        return "origin_slowdown"
    if ttfb_ms >= 900:
        return "latency_spike"
    return "normal"


def _breach_eta(ttfb_forecast: np.ndarray, threshold_ms: float) -> Optional[int]:
    crossings = np.where(ttfb_forecast >= threshold_ms)[0]
    if crossings.size == 0:
        return None
    return int(crossings[0]) + 1


@app.post("/predict")
def predict(request: PredictRequest):
    arr = np.array(request.data, dtype=np.float32)
    _validate_shape(arr)
    raw_pred = _run_lstm(arr)

    idx = {f: i for i, f in enumerate(FEATURES)}
    ttfb_idx = idx["ttfb_ms"]
    dns_idx = idx["dns_ms"]
    err_idx = idx["error_rate"]
    ssl_idx = idx["ssl_days_left"]

    ttfb_forecast = raw_pred[:, ttfb_idx]
    eta = _breach_eta(ttfb_forecast, SLA_TTFB_MS)

    current = arr[-1]
    root_cause = _root_cause_rule(
        float(current[ttfb_idx]),
        float(current[dns_idx]),
        float(current[err_idx]),
        float(current[ssl_idx]),
    )

    return {
        "prediction": raw_pred.tolist(),
        "feature_names": FEATURES,
        "output_window": OUTPUT_WINDOW,
        "ttfb_forecast_ms": ttfb_forecast.tolist(),
        "p95_ttfb_ms": float(np.percentile(ttfb_forecast, 95)),
        "sla_threshold_ms": SLA_TTFB_MS,
        "breach_eta_min": eta,
        "root_cause": root_cause,
    }


@app.post("/anomaly")
def detect_anomaly(request: AnomalyRequest):
    if iso_model is None:
        raise HTTPException(503, "Isolation Forest not loaded")

    arr = np.array(request.data, dtype=np.float32)
    if arr.ndim == 1:
        arr = arr.reshape(1, -1)

    # Apply IF scaler if available
    eval_arr = if_scaler.transform(arr) if if_scaler is not None else arr

    flags = iso_model.predict(eval_arr)
    scores = iso_model.decision_function(eval_arr)

    return {
        "anomaly_flags": flags.tolist(),
        "anomaly_scores": scores.tolist(),
        "anomaly_count": int((flags == -1).sum()),
    }


@app.post("/classify-log")
def classify_log(req: LogRequest):
    if log_classifier is None:
        raise HTTPException(503, "Pattern classifier not loaded")

    pred = log_classifier.predict([req.log_text])[0]
    label = _normalize_classifier_label(pred)
    probabilities = _classifier_probabilities(req.log_text)

    return {
        "prediction": label,
        "probabilities": probabilities,
    }


@app.post("/ensemble")
def ensemble_predict(req: EnsembleRequest):
    arr = np.array(req.metrics_window, dtype=np.float32)

    # Graceful fallback when LSTM is not loaded (first boot, before training)
    if lstm_model is None:
        current = arr[-1] if len(arr) > 0 else np.zeros(len(FEATURES))
        idx = {f: i for i, f in enumerate(FEATURES)}
        current_ttfb = float(current[idx["ttfb_ms"]])
        current_dns = float(current[idx["dns_ms"]])
        current_error = float(current[idx["error_rate"]])
        current_ssl = float(current[idx["ssl_days_left"]])
        root_cause = _root_cause_rule(current_ttfb, current_dns, current_error, current_ssl)
        return {
            "severity": "normal",
            "confidence": 0.15,
            "root_cause": root_cause,
            "breach_eta_min": None,
            "sla_threshold_ms": SLA_TTFB_MS,
            "ttfb_forecast_ms": [],
            "prediction": [],
            "lstm_prediction": [],
            "iso_flag": 1,
            "pattern_label": "normal",
            "pattern_probabilities": {},
            "current_metrics": {
                "ttfb_ms": current_ttfb,
                "dns_ms": current_dns,
                "error_rate": current_error,
                "ssl_days_left": current_ssl,
            },
            "forecast_worst": {
                "ttfb_ms": current_ttfb,
                "dns_ms": current_dns,
                "error_rate": current_error,
                "ssl_days_left": current_ssl,
            },
            "_note": "Models not trained yet — returning low-confidence default",
        }

    _validate_shape(arr)
    raw_pred = _run_lstm(arr)

    idx = {f: i for i, f in enumerate(FEATURES)}
    ttfb_idx = idx["ttfb_ms"]
    dns_idx = idx["dns_ms"]
    err_idx = idx["error_rate"]
    ssl_idx = idx["ssl_days_left"]

    current = arr[-1]
    forecast_last = raw_pred[-1]

    current_ttfb = float(current[ttfb_idx])
    current_dns = float(current[dns_idx])
    current_error = float(current[err_idx])
    current_ssl = float(current[ssl_idx])

    forecast_ttfb = raw_pred[:, ttfb_idx]
    worst_ttfb = float(np.max(forecast_ttfb))
    breach_eta = _breach_eta(forecast_ttfb, SLA_TTFB_MS)

    iso_flag = 1
    if iso_model is not None:
        try:
            eval_row = np.array([[current_ttfb, current_dns, current_error, current_ssl]], dtype=np.float32)
            if if_scaler is not None:
                eval_row = if_scaler.transform(eval_row)
            iso_flag = int(iso_model.predict(eval_row)[0])
        except Exception:
            iso_flag = 1

    pattern_label = "normal"
    pattern_probabilities = {}
    if log_classifier is not None and req.log_text:
        pred = log_classifier.predict([req.log_text])[0]
        pattern_label = _normalize_classifier_label(pred)
        pattern_probabilities = _classifier_probabilities(req.log_text)

    root_cause = pattern_label if pattern_label in ANOMALY_LABELS else _root_cause_rule(
        current_ttfb,
        current_dns,
        current_error,
        current_ssl,
    )

    if breach_eta is not None and breach_eta <= 10:
        severity = "critical"
    elif current_ttfb >= SLA_TTFB_MS or current_error >= 15 or iso_flag == -1:
        severity = "critical"
    elif breach_eta is not None and breach_eta <= 30:
        severity = "warning"
    elif current_ttfb >= SLA_TTFB_MS * 0.7 or current_dns >= 200 or current_error >= 5:
        severity = "warning"
    else:
        severity = "normal"

    confidence = 0.2
    confidence += min(current_ttfb / SLA_TTFB_MS, 1.0) * 0.35
    confidence += min(current_error / 20.0, 1.0) * 0.2
    confidence += min(current_dns / 300.0, 1.0) * 0.15
    confidence += 0.15 if iso_flag == -1 else 0.0
    confidence += 0.15 if (breach_eta is not None and breach_eta <= 30) else 0.0
    confidence += 0.1 if root_cause in ANOMALY_LABELS else 0.0
    confidence = min(float(confidence), 0.99)

    return {
        "severity": severity,
        "confidence": confidence,
        "root_cause": root_cause,
        "breach_eta_min": breach_eta,
        "sla_threshold_ms": SLA_TTFB_MS,
        "ttfb_forecast_ms": forecast_ttfb.tolist(),
        "prediction": raw_pred.tolist(),
        "lstm_prediction": raw_pred.tolist(),
        "iso_flag": iso_flag,
        "pattern_label": pattern_label,
        "pattern_probabilities": pattern_probabilities,
        "current_metrics": {
            "ttfb_ms": current_ttfb,
            "dns_ms": current_dns,
            "error_rate": current_error,
            "ssl_days_left": current_ssl,
        },
        "forecast_worst": {
            "ttfb_ms": worst_ttfb,
            "dns_ms": float(forecast_last[dns_idx]),
            "error_rate": float(forecast_last[err_idx]),
            "ssl_days_left": float(forecast_last[ssl_idx]),
        },
    }

@app.get("/health")
def health():
    return {
        "status": "running",
        "lstm_loaded": lstm_model is not None,
        "iso_loaded": iso_model is not None,
        "log_loaded": log_classifier is not None,
        "pattern_loaded": log_classifier is not None,
        "baseline_loaded": baseline is not None,
    }


# ── Aliases to match documentation endpoint names ─────────────
@app.post("/detect-anomaly")
def detect_anomaly_alias(request: AnomalyRequest):
    """Alias for /anomaly (doc-specified name)."""
    return detect_anomaly(request)


@app.post("/classify")
def classify_alias(req: LogRequest):
    """Alias for /classify-log (doc-specified name)."""
    return classify_log(req)


# ── Training endpoint ─────────────────────────────────────────
@app.post("/train")
def train_models():
    """Trigger model retraining on latest labeled data."""
    import subprocess
    train_script = os.path.join(os.path.dirname(__file__), "..", "training", "train_models.py")
    if not os.path.exists(train_script):
        raise HTTPException(404, f"Training script not found at {train_script}")
    try:
        result = subprocess.run(
            [sys.executable, train_script],
            capture_output=True, text=True, timeout=3600
        )
        load_models()  # reload after training
        return {
            "status": "completed" if result.returncode == 0 else "failed",
            "returncode": result.returncode,
            "stdout": result.stdout[-2000:] if result.stdout else "",
            "stderr": result.stderr[-2000:] if result.stderr else "",
        }
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "Training timed out after 60 minutes")
    except Exception as e:
        raise HTTPException(500, f"Training error: {str(e)}")


# ── Model info endpoint ──────────────────────────────────────
@app.get("/model/info")
def model_info():
    """Return model metadata: version, files, and status."""
    info = {"models": {}}
    model_files = {
        "lstm": "model.pt",
        "isolation_forest": "isolation_forest.pkl",
        "pattern_classifier": "pattern_classifier.pkl",
        "scaler": "scaler.pkl",
        "baseline": "baseline.pkl",
    }
    for name, filename in model_files.items():
        path = os.path.join(MODEL_DIR, filename)
        if os.path.exists(path):
            stat = os.stat(path)
            info["models"][name] = {
                "loaded": True,
                "file": filename,
                "size_bytes": stat.st_size,
                "modified": os.path.getmtime(path),
            }
        else:
            info["models"][name] = {"loaded": False, "file": filename}
    info["sla_threshold_ms"] = SLA_TTFB_MS
    info["input_window"] = INPUT_WINDOW
    info["output_window"] = OUTPUT_WINDOW
    info["features"] = FEATURES
    return info


@app.post("/reload")
def reload_models():
    load_models()
    return {
        "status": "reloaded",
        "lstm_loaded": lstm_model is not None,
        "iso_loaded": iso_model is not None,
        "log_loaded": log_classifier is not None,
        "baseline_loaded": baseline is not None,
    }