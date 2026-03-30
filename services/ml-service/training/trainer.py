"""
trainer.py — LSTM training with z-score normalization.
Saves model.pt, scaler.pkl, AND baseline.pkl (mean/std for z-scoring).
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

import torch
import numpy as np
from torch.utils.data import DataLoader, TensorDataset
import joblib

from config   import FEATURES, INPUT_WINDOW, OUTPUT_WINDOW, EPOCHS, BATCH_SIZE, LEARNING_RATE
from dataset  import load_data, compute_service_baseline, normalize_zscore, create_sequences
from model    import LSTMModel

os.makedirs("/app/models", exist_ok=True)


def train():
    print("=" * 60)
    print("  LSTM Training — Z-score Normalization")
    print("=" * 60)

    # 1. Load raw data
    print("\n[1/5] Loading data from TimescaleDB...")
    raw = load_data()
    print(f"      Loaded {len(raw)} timesteps × {raw.shape[1]} features")

    # 2. Compute service baseline (what "normal" looks like)
    print("[2/5] Computing service baseline (mean/std per feature)...")
    mean, std = compute_service_baseline(raw)
    for i, feat in enumerate(FEATURES):
        print(f"      {feat:12s}  mean={mean[i]:.2f}  std={std[i]:.2f}")

    # Save baseline so the prediction endpoint can use it
    joblib.dump({"mean": mean, "std": std}, "/app/models/baseline.pkl")
    print("      Baseline saved → /app/models/baseline.pkl")

    # 3. Normalize
    print("[3/5] Normalizing to z-scores...")
    normalized = normalize_zscore(raw, mean, std)

    # 4. Create sequences
    X, y = create_sequences(normalized)
    print(f"      Created {len(X)} sequences  ({INPUT_WINDOW}→{OUTPUT_WINDOW} steps)")

    # 5. Train/val split
    split    = int(0.8 * len(X))
    X_train, X_val = X[:split], X[split:]
    y_train, y_val = y[:split], y[split:]
    print(f"      Train: {len(X_train)} | Val: {len(X_val)}")

    y_train_flat = y_train.reshape(len(y_train), -1)
    y_val_flat   = y_val.reshape(len(y_val),   -1)

    train_loader = DataLoader(
        TensorDataset(torch.tensor(X_train, dtype=torch.float32),
                      torch.tensor(y_train_flat, dtype=torch.float32)),
        batch_size=BATCH_SIZE, shuffle=False
    )
    val_loader = DataLoader(
        TensorDataset(torch.tensor(X_val, dtype=torch.float32),
                      torch.tensor(y_val_flat, dtype=torch.float32)),
        batch_size=BATCH_SIZE
    )

    # 6. Train
    print("\n[4/5] Training LSTM...")
    model     = LSTMModel(len(FEATURES))
    optimizer = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)
    loss_fn   = torch.nn.MSELoss()

    best_val  = float("inf")
    patience  = 5
    counter   = 0

    for epoch in range(EPOCHS):
        model.train()
        train_loss = 0
        for xb, yb in train_loader:
            optimizer.zero_grad()
            pred = model(xb)
            loss = loss_fn(pred, yb)
            loss.backward()
            optimizer.step()
            train_loss += loss.item()
        train_loss /= len(train_loader)

        model.eval()
        val_loss = 0
        with torch.no_grad():
            for xb, yb in val_loader:
                val_loss += loss_fn(model(xb), yb).item()
        val_loss /= len(val_loader)

        print(f"  Epoch {epoch+1:02d}/{EPOCHS}  train={train_loss:.6f}  val={val_loss:.6f}")

        if val_loss < best_val:
            best_val = val_loss
            torch.save(model.state_dict(), "/app/models/model.pt")
            counter = 0
            print(f"  ✓ Best model saved (val={best_val:.4f})")
        else:
            counter += 1
            if counter >= patience:
                print(f"  Early stopping at epoch {epoch+1}")
                break

    # 7. Save a StandardScaler-compatible object so main.py still works
    from sklearn.preprocessing import StandardScaler
    scaler = StandardScaler()
    scaler.mean_ = mean
    scaler.scale_ = std
    scaler.var_   = std ** 2
    scaler.n_features_in_ = len(FEATURES)
    joblib.dump(scaler, "/app/models/scaler.pkl")

    print(f"\n[5/5] Done. Best val_loss={best_val:.4f}")
    print("Saved: model.pt  scaler.pkl  baseline.pkl")


if __name__ == "__main__":
    train()