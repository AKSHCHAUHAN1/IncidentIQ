from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import torch
import joblib
import numpy as np
import os
from typing import List
from model import LSTMModel
from config import FEATURES, INPUT_WINDOW, OUTPUT_WINDOW
from sklearn.ensemble import IsolationForest
from transformers import DistilBertTokenizerFast, DistilBertForSequenceClassification

log_model = None
log_tokenizer = None

app = FastAPI(
    title="Incident Predictor ML Service",
    description="LSTM + Isolation Forest ML API",
    version="2.0.0"
)

# Global models
model = None
scaler = None
iso_model = None

BASE_DIR = "/app/models"


def load_models():
    global model, scaler, iso_model, log_model, log_tokenizer

    # ---- Load LSTM ----
    model_path = os.path.join(BASE_DIR, "model.pt")
    scaler_path = os.path.join(BASE_DIR, "scaler.pkl")

    if os.path.exists(model_path) and os.path.exists(scaler_path):
        model = LSTMModel(len(FEATURES))
        model.load_state_dict(torch.load(model_path, map_location="cpu"))
        model.eval()
        scaler = joblib.load(scaler_path)
        print("LSTM model loaded successfully.")
    else:
        print("LSTM model not found.")

    # ---- Load Isolation Forest ----
    iso_path = os.path.join(BASE_DIR, "isolation_forest.pkl")

    if os.path.exists(iso_path):
        iso_model = joblib.load(iso_path)
        print("Isolation Forest loaded successfully.")
    else:
        print("Isolation Forest model not found.")

    # ---- Load Log Model ----
    log_path = os.path.join(BASE_DIR, "log_model")

    if os.path.exists(log_path):
        log_model = DistilBertForSequenceClassification.from_pretrained(log_path)
        log_tokenizer = DistilBertTokenizerFast.from_pretrained(log_path)
        log_model.eval()
        print("Log classifier loaded successfully.")
    else:
        print("Log model not found.")


@app.on_event("startup")
def startup_event():
    load_models()


# ───────────────────────── Health ─────────────────────────

@app.get("/health")
def health():
    return {
        "status": "running",
        "lstm_loaded": model is not None,
        "iso_loaded": iso_model is not None,
        "log_loaded": log_model is not None
    }

# ───────────────────────── Predict (LSTM) ─────────────────────────

class PredictRequest(BaseModel):
    data: List[List[float]]


@app.post("/predict")
def predict(request: PredictRequest):

    if model is None or scaler is None:
        raise HTTPException(status_code=503, detail="LSTM model not trained")

    arr = np.array(request.data)

    if arr.ndim != 2:
        raise HTTPException(status_code=422, detail="Input must be 2D array")

    if arr.shape[0] != INPUT_WINDOW:
        raise HTTPException(
            status_code=422,
            detail=f"Expected {INPUT_WINDOW} rows"
        )

    if arr.shape[1] != len(FEATURES):
        raise HTTPException(
            status_code=422,
            detail=f"Expected {len(FEATURES)} features"
        )

    arr_scaled = scaler.transform(arr)

    with torch.no_grad():
        inp = torch.tensor(arr_scaled, dtype=torch.float32).unsqueeze(0)
        pred = model(inp)
        pred = pred.reshape(OUTPUT_WINDOW, len(FEATURES))
        pred = scaler.inverse_transform(pred.numpy())

    return {
        "prediction": pred.tolist(),
        "features": FEATURES,
        "output_window": OUTPUT_WINDOW,
    }


# ───────────────────────── Anomaly (Isolation Forest) ─────────────────────────

@app.post("/anomaly")
def detect_anomaly(request: PredictRequest):

    if iso_model is None:
        raise HTTPException(status_code=503, detail="Isolation model not trained")

    arr = np.array(request.data)

    if arr.ndim != 2:
        raise HTTPException(status_code=422, detail="Input must be 2D array")

    if arr.shape[1] != len(FEATURES):
        raise HTTPException(
            status_code=422,
            detail=f"Expected {len(FEATURES)} features"
        )

    flags = iso_model.predict(arr)   # -1 anomaly, 1 normal
    scores = iso_model.decision_function(arr)

    return {
        "anomaly_flags": flags.tolist(),
        "anomaly_scores": scores.tolist()
    }

# ───────────────────────── Log Classification ─────────────────────────

class LogRequest(BaseModel):
    log_text: str


@app.post("/classify-log")
def classify_log(req: LogRequest):

    if log_model is None or log_tokenizer is None:
        raise HTTPException(status_code=503, detail="Log model not trained")

    inputs = log_tokenizer(req.log_text, return_tensors="pt")

    with torch.no_grad():
        outputs = log_model(**inputs)

    probs = torch.softmax(outputs.logits, dim=1)
    predicted_class = torch.argmax(probs, dim=1).item()

    label_map = {
        0: "normal",
        1: "warning",
        2: "critical"
    }

    return {
        "prediction": label_map[predicted_class],
        "probabilities": probs.tolist()
    }

class EnsembleRequest(BaseModel):
    metrics_window: List[List[float]]
    log_text: str

@app.post("/ensemble")
def ensemble_predict(req: EnsembleRequest):

    if model is None or scaler is None:
        raise HTTPException(status_code=503, detail="LSTM not loaded")

    if iso_model is None:
        raise HTTPException(status_code=503, detail="Isolation Forest not loaded")

    if log_model is None:
        raise HTTPException(status_code=503, detail="Log model not loaded")

    arr = np.array(req.metrics_window)

    if arr.shape[0] != INPUT_WINDOW:
        raise HTTPException(status_code=422, detail="Invalid window size")

    if arr.shape[1] != len(FEATURES):
        raise HTTPException(status_code=422, detail="Invalid feature size")

    # ----- LSTM Forecast -----
    arr_scaled = scaler.transform(arr)

    with torch.no_grad():
        inp = torch.tensor(arr_scaled, dtype=torch.float32).unsqueeze(0)
        pred = model(inp)
        pred = pred.reshape(OUTPUT_WINDOW, len(FEATURES))
        pred = scaler.inverse_transform(pred.numpy())

    future_last = pred[-1]
    cpu, memory, request_rate, error_rate, latency = future_last

    # ----- Isolation Forest -----
    iso_flag = iso_model.predict([future_last])[0]

    # ----- Log Model -----
    inputs = log_tokenizer(req.log_text, return_tensors="pt")

    with torch.no_grad():
        outputs = log_model(**inputs)

    probs = torch.softmax(outputs.logits, dim=1)
    log_class = torch.argmax(probs, dim=1).item()

    # ----- Fusion Logic -----
    severity = "normal"

    if (
        iso_flag == -1 or
        log_class == 2 or
        cpu > 85 or
        memory > 85 or
        error_rate > 20 or
        latency > 300
    ):
        severity = "critical"

    elif (
        log_class == 1 or
        cpu > 70 or
        memory > 75 or
        error_rate > 10 or
        latency > 200
    ):
        severity = "warning"

    return {
        "severity": severity,
        "lstm_forecast": pred.tolist(),
        "iso_flag": int(iso_flag),
        "log_prediction": log_class,
        "log_probabilities": probs.tolist()
    }