"""
dataset.py — Z-score normalized sequences for LSTM training.

WHY Z-SCORES:
  Raw values (cpu=40%, cpu=80%) mean different things per service.
  Z-scores measure "how many std deviations from THIS service's normal"
  so one model generalizes to all services without retraining.
"""

import pandas as pd
import numpy as np
from sqlalchemy import create_engine
from config import (
    DB_HOST, DB_PORT, DB_NAME,
    DB_USER, DB_PASSWORD,
    FEATURES, INPUT_WINDOW, OUTPUT_WINDOW
)


def get_engine():
    return create_engine(
        f"postgresql+psycopg2://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
    )


def load_data():
    """
    Load raw metric data from TimescaleDB.
    Returns a numpy array of shape (T, num_features).
    """
    engine = get_engine()

    query = """
    SELECT
        time_bucket('10 seconds', time) AS bucket,
        metric_name,
        AVG(value) AS value
    FROM metrics.raw_metrics
    GROUP BY bucket, metric_name
    ORDER BY bucket;
    """

    df = pd.read_sql(query, engine)

    if df.empty:
        raise ValueError("No data in TimescaleDB. Let the generator run for 2+ minutes.")

    pivot = df.pivot(index="bucket", columns="metric_name", values="value")

    missing = [f for f in FEATURES if f not in pivot.columns]
    if missing:
        raise ValueError(f"Missing metrics: {missing}. Is the generator running?")

    pivot = pivot[FEATURES].ffill().dropna()

    if len(pivot) < INPUT_WINDOW + OUTPUT_WINDOW:
        raise ValueError(
            f"Need {INPUT_WINDOW + OUTPUT_WINDOW} rows, have {len(pivot)}. "
            "Wait 2-3 more minutes."
        )

    return pivot.values  # raw values (T, 5)


def compute_service_baseline(data):
    """
    Compute per-feature mean and std from the training data.
    This becomes the "normal" baseline for this service.
    Returns (mean array, std array) both of shape (num_features,)
    """
    mean = np.mean(data, axis=0)
    std  = np.std(data,  axis=0)
    # Avoid division by zero — if std is 0, treat as 1
    std  = np.where(std < 1e-8, 1.0, std)
    return mean, std


def normalize_zscore(data, mean, std):
    """Convert raw values to z-scores: (x - mean) / std"""
    return (data - mean) / std


def denormalize_zscore(zscores, mean, std):
    """Convert z-scores back to raw values: z * std + mean"""
    return zscores * std + mean


def create_sequences(data):
    """
    Create (X, y) sliding window sequences from normalized data.
    X: (N, INPUT_WINDOW, num_features)
    y: (N, OUTPUT_WINDOW, num_features) — flattened to (N, OUTPUT_WINDOW * num_features)
    """
    X, y = [], []
    total = INPUT_WINDOW + OUTPUT_WINDOW

    for i in range(len(data) - total):
        X.append(data[i : i + INPUT_WINDOW])
        y.append(data[i + INPUT_WINDOW : i + total])

    if not X:
        raise ValueError("Not enough data for sequences after windowing.")

    return np.array(X), np.array(y)


def load_flat_training_data():
    """
    Returns raw (unnormalized) flat rows for Isolation Forest.
    Shape: (T, num_features)
    """
    return load_data()