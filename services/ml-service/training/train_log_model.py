"""
train_log_model.py
==================
Trains TF-IDF + Logistic Regression root-cause classifier.
Data source: ml.labeled_probe_readings (real probe data with real labels).
Saves: pattern_classifier.pkl, log_classifier.pkl (legacy alias)
"""

import os
import sys
import joblib

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline

MODEL_DIR    = "/app/models"
MODEL_PATH   = os.path.join(MODEL_DIR, "pattern_classifier.pkl")
LEGACY_PATH  = os.path.join(MODEL_DIR, "log_classifier.pkl")
MIN_ROWS     = 200  # Minimum labeled rows required


def load_real_data():
    """Load metric_text and anomaly_type from ml.labeled_probe_readings."""
    from dataset import get_engine
    import pandas as pd

    engine = get_engine()
    query = """
        SELECT metric_text, anomaly_type
        FROM ml.labeled_probe_readings
        WHERE metric_text IS NOT NULL
          AND anomaly_type IS NOT NULL
          AND metric_text != ''
        ORDER BY RANDOM()
    """
    df = pd.read_sql(query, engine)

    if df.empty or len(df) < MIN_ROWS:
        raise ValueError(
            f"Not enough labeled data: found {len(df)} rows, need {MIN_ROWS}. "
            "Run label_probe_data.py first to generate training labels."
        )

    print(f"Loaded {len(df)} labeled rows from ml.labeled_probe_readings")
    print(f"Label distribution:\n{df['anomaly_type'].value_counts().to_string()}")

    return df["metric_text"].tolist(), df["anomaly_type"].tolist()


def main():
    print("=" * 70)
    print("TF-IDF + Logistic Regression — Root Cause Classifier")
    print("Data source: ml.labeled_probe_readings (real data)")
    print("=" * 70)

    texts, labels = load_real_data()

    X_train, X_test, y_train, y_test = train_test_split(
        texts, labels,
        test_size=0.2,
        random_state=42,
        stratify=labels,
    )

    pipeline = Pipeline([
        (
            "tfidf",
            TfidfVectorizer(
                analyzer="word",
                ngram_range=(1, 2),
                max_features=1200,
                min_df=1,
            ),
        ),
        (
            "clf",
            LogisticRegression(
                max_iter=1000,
                class_weight="balanced",
                random_state=42,
                n_jobs=-1,
            ),
        ),
    ])

    pipeline.fit(X_train, y_train)
    y_pred = pipeline.predict(X_test)

    print(f"\nTrain samples: {len(X_train)} | Test samples: {len(X_test)}")
    print(classification_report(y_test, y_pred))

    os.makedirs(MODEL_DIR, exist_ok=True)
    joblib.dump(pipeline, MODEL_PATH)
    joblib.dump(pipeline, LEGACY_PATH)  # legacy alias

    print(f"Saved: {MODEL_PATH}")
    print(f"Saved: {LEGACY_PATH}")


if __name__ == "__main__":
    main()