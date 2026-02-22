"""
Shared utility functions for the ML service.
Used by trainer, main API, and future models (Month 3+).
"""

import numpy as np
from config import FEATURES


def compute_mae(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    """Mean Absolute Error"""
    return float(np.mean(np.abs(y_true - y_pred)))


def compute_rmse(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    """Root Mean Squared Error"""
    return float(np.sqrt(np.mean((y_true - y_pred) ** 2)))


def compute_metrics(y_true: np.ndarray, y_pred: np.ndarray) -> dict:
    """Returns MAE and RMSE per feature and overall."""
    results = {
        "overall": {
            "mae": compute_mae(y_true, y_pred),
            "rmse": compute_rmse(y_true, y_pred),
        },
        "per_feature": {}
    }
    for i, feature in enumerate(FEATURES):
        results["per_feature"][feature] = {
            "mae": compute_mae(y_true[:, :, i], y_pred[:, :, i]),
            "rmse": compute_rmse(y_true[:, :, i], y_pred[:, :, i]),
        }
    return results


def zscore_anomaly(value: float, mean: float, std: float) -> float:
    """
    Returns z-score for a single value.
    Used by Month 3 anomaly detection as a baseline.
    |z| > 3 is typically considered anomalous.
    """
    if std == 0:
        return 0.0
    return abs((value - mean) / std)


def build_sample_input(n_rows: int = None) -> list:
    """
    Builds a sample input payload for /predict endpoint testing.
    Returns INPUT_WINDOW rows with realistic synthetic values.
    """
    from config import INPUT_WINDOW
    n = n_rows or INPUT_WINDOW
    rows = []
    for _ in range(n):
        rows.append([
            round(40 + np.random.uniform(-5, 5), 2),   # cpu
            round(60 + np.random.uniform(-5, 5), 2),   # memory
            round(500 + np.random.uniform(-50, 50), 2), # request_rate
            round(max(0, 5 + np.random.uniform(-2, 2)), 2),  # error_rate
            round(120 + np.random.uniform(-20, 20), 2), # latency
        ])
    return rows
