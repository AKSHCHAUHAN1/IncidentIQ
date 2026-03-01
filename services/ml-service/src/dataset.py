import pandas as pd
import numpy as np
from sqlalchemy import create_engine
from config import (
    DB_HOST, DB_PORT, DB_NAME,
    DB_USER, DB_PASSWORD,
    FEATURES, INPUT_WINDOW, OUTPUT_WINDOW
)

def load_data():
    engine = create_engine(
        f"postgresql+psycopg2://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
    )

    # FIX: use 10-second buckets instead of 1-minute
    # synthetic generator pushes every 5s so this gives ~2x more rows
    query = """
    SELECT time_bucket('10 seconds', time) as minute,
           metric_name,
           avg(value) as value
    FROM metrics.raw_metrics
    GROUP BY minute, metric_name
    ORDER BY minute;
    """

    df = pd.read_sql(query, engine)

    if df.empty:
        raise ValueError("No data found in TimescaleDB.")

    pivot = df.pivot(index="minute", columns="metric_name", values="value")

    missing = [f for f in FEATURES if f not in pivot.columns]
    if missing:
        raise ValueError(f"Missing required metrics: {missing}")

    pivot = pivot[FEATURES]
    pivot = pivot.ffill().dropna()

    if len(pivot) < INPUT_WINDOW + OUTPUT_WINDOW:
        raise ValueError(
            f"Not enough data. Required: {INPUT_WINDOW + OUTPUT_WINDOW}, Found: {len(pivot)}. "
            f"Wait a few more minutes."
        )

    return pivot.values


def create_sequences(data):
    X, y = [], []
    total_window = INPUT_WINDOW + OUTPUT_WINDOW

    for i in range(len(data) - total_window):
        X.append(data[i:i + INPUT_WINDOW])
        y.append(data[i + INPUT_WINDOW:i + total_window])

    if len(X) == 0:
        raise ValueError("Sequence generation failed. No valid sequences created.")

    return np.array(X), np.array(y)


def load_flat_training_data():
    """
    Returns flat feature rows for Isolation Forest training.
    [[cpu, memory, request_rate, error_rate, latency], ...]
    """
    return load_data()