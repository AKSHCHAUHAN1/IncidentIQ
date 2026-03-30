"""
dataset.py — Loads data from ml.labeled_probe_readings for training.

Provides:
  - load_data() for LSTM training (per-URL time-ordered data)
  - compute_service_baseline() for z-score normalization
  - create_sequences() for sliding window sequence generation
  - load_flat_training_data() for Isolation Forest
"""

import os
import pandas as pd
import numpy as np
from sqlalchemy import create_engine

# Import from config — works when called from src/ or training/
try:
    from config import (
        DB_HOST, DB_PORT, DB_NAME,
        DB_USER, DB_PASSWORD,
        FEATURES, INPUT_WINDOW, OUTPUT_WINDOW
    )
except ImportError:
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
    from config import (
        DB_HOST, DB_PORT, DB_NAME,
        DB_USER, DB_PASSWORD,
        FEATURES, INPUT_WINDOW, OUTPUT_WINDOW
    )


def get_engine():
    db_url = os.environ.get("DATABASE_URL")
    if db_url:
        return create_engine(db_url)
    return create_engine(
        f"postgresql+psycopg2://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
    )


def load_data():
    """
    Load labeled probe data from ml.labeled_probe_readings.
    Groups by URL to maintain per-URL time ordering.
    Returns a numpy array of shape (T, num_features).
    """
    engine = get_engine()

    query = f"""
    SELECT
        url,
        probed_at,
        {', '.join(FEATURES)}
    FROM ml.labeled_probe_readings
    WHERE ttfb_ms IS NOT NULL
      AND dns_ms IS NOT NULL
      AND COALESCE(label_source, 'programmatic') != 'synthetic'
    ORDER BY url, probed_at
    """

    df = pd.read_sql(query, engine)

    if df.empty:
        raise ValueError(
            "No labeled data in ml.labeled_probe_readings. "
            "Run the website-probe for 7+ days, then run label_probe_data.py."
        )

    # Fill missing values and extract features
    feature_df = df[FEATURES].ffill().fillna(0)

    if len(feature_df) < INPUT_WINDOW + OUTPUT_WINDOW:
        raise ValueError(
            f"Need {INPUT_WINDOW + OUTPUT_WINDOW} rows, have {len(feature_df)}. "
            "Run the probe service longer, then re-label."
        )

    return feature_df.values  # (T, num_features)


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
    y: (N, OUTPUT_WINDOW, num_features)
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