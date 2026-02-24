from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import torch
import joblib
import numpy as np
import os
from typing import List
from model import LSTMModel
from config import FEATURES, INPUT_WINDOW, OUTPUT_WINDOW

app = FastAPI(
    title="Incident Predictor ML Service",
    description="LSTM-based metric prediction API",
    version="1.0.0"
)

model = None
scaler = None

BASE_DIR = "/app/models"


def load_model():
    global model, scaler

    model_path = os.path.join(BASE_DIR, "model.pt")
    scaler_path = os.path.join(BASE_DIR, "scaler.pkl")

    if not os.path.exists(model_path):
        print("Model file not found. Start without trained model.")
        print("Run: docker compose exec ml-service python training/train_lstm.py")
        return

    model = LSTMModel(len(FEATURES))
    model.load_state_dict(torch.load(model_path, map_location="cpu"))
    model.eval()

    scaler = joblib.load(scaler_path)
    print("Model loaded successfully.")


@app.on_event("startup")
def startup_event():
    load_model()


# ─── Health ───────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "running",
        "model_loaded": model is not None,
    }


# ─── Model Info ───────────────────────────────────────────────────────────────

@app.get("/model/info")
def model_info():
    """Returns metadata about the loaded model."""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not trained yet")

    return {
        "features": FEATURES,
        "input_window": INPUT_WINDOW,
        "output_window": OUTPUT_WINDOW,
        "model_type": "LSTM + Attention",
        "model_path": os.path.join(BASE_DIR, "model.pt"),
    }


# ─── Predict ──────────────────────────────────────────────────────────────────

class PredictRequest(BaseModel):
    data: List[List[float]]  # shape: [INPUT_WINDOW, len(FEATURES)]


@app.post("/predict")
def predict(request: PredictRequest):
    """
    Accepts INPUT_WINDOW rows of metrics and returns OUTPUT_WINDOW predictions.

    Each row must have exactly len(FEATURES) values in this order:
      cpu, memory, request_rate, error_rate, latency

    Example body:
    {
      "data": [
        [40.0, 60.0, 500.0, 5.0, 120.0],
        ... (20 rows total)
      ]
    }
    """
    if model is None or scaler is None:
        raise HTTPException(status_code=503, detail="Model not trained yet")

    arr = np.array(request.data)

    # Input validation
    if arr.ndim != 2:
        raise HTTPException(status_code=422, detail="Input must be a 2D array")
    if arr.shape[0] != INPUT_WINDOW:
        raise HTTPException(
            status_code=422,
            detail=f"Expected {INPUT_WINDOW} rows, got {arr.shape[0]}"
        )
    if arr.shape[1] != len(FEATURES):
        raise HTTPException(
            status_code=422,
            detail=f"Expected {len(FEATURES)} features per row, got {arr.shape[1]}"
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