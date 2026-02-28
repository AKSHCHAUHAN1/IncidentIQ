import os
import sys

# Add /app/src to Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

import joblib
import numpy as np
from sklearn.ensemble import IsolationForest
from dataset import load_flat_training_data

MODEL_PATH = "/app/models/isolation_forest.pkl"

def main():
    print("="*50)
    print("Isolation Forest Training")
    print("="*50)

    data = load_flat_training_data()
    X = np.array(data)

    if len(X) < 100:
        raise RuntimeError("Not enough data for Isolation Forest training")

    model = IsolationForest(
        n_estimators=300,
        contamination=0.05,
        random_state=42,
        n_jobs=-1
    )

    model.fit(X)

    os.makedirs("/app/models", exist_ok=True)
    joblib.dump(model, MODEL_PATH)

    print("Isolation Forest saved:", MODEL_PATH)

if __name__ == "__main__":
    main()