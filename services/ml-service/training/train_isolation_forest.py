import os
import sys

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

import joblib
import numpy as np
from sklearn.ensemble import IsolationForest
from dataset import load_flat_training_data

MODEL_PATH = "/app/models/isolation_forest.pkl"

def main():
    print("=" * 50)
    print("Isolation Forest Training")
    print("=" * 50)

    data = load_flat_training_data()
    X = np.array(data)

    print(f"Loaded {len(X)} rows of data")

    # FIX: lowered minimum — IF works fine with 30+ rows
    if len(X) < 30:
        raise RuntimeError(
            f"Not enough data: need 30 rows, got {len(X)}. "
            "Wait a few more minutes for data to accumulate."
        )

    model = IsolationForest(
        n_estimators=300,
        contamination=0.05,
        random_state=42,
        n_jobs=-1
    )

    model.fit(X)

    os.makedirs("/app/models", exist_ok=True)
    joblib.dump(model, MODEL_PATH)

    print(f"Isolation Forest trained on {len(X)} rows")
    print("Model saved:", MODEL_PATH)

if __name__ == "__main__":
    main()