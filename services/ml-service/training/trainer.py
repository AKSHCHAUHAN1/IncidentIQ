import sys
import os

# Add src/ to path so config, model, dataset are importable
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

import torch
import numpy as np
from sklearn.preprocessing import StandardScaler
from torch.utils.data import DataLoader, TensorDataset
from config import *
from dataset import load_data, create_sequences
from model import LSTMModel
import joblib

os.makedirs("/app/models", exist_ok=True)


def train():
    print("Loading data from TimescaleDB...")
    data = load_data()
    print(f"Loaded {len(data)} rows of data")

    scaler = StandardScaler()
    scaled = scaler.fit_transform(data)

    X, y = create_sequences(scaled)
    print(f"Created {len(X)} sequences")

    split = int(0.8 * len(X))
    X_train, X_val = X[:split], X[split:]
    y_train, y_val = y[:split], y[split:]
    print(f"Train: {len(X_train)} | Val: {len(X_val)}")

    train_loader = DataLoader(
        TensorDataset(
            torch.tensor(X_train, dtype=torch.float32),
            torch.tensor(y_train.reshape(len(y_train), -1), dtype=torch.float32),
        ),
        batch_size=BATCH_SIZE,
        shuffle=True,
    )

    val_loader = DataLoader(
        TensorDataset(
            torch.tensor(X_val, dtype=torch.float32),
            torch.tensor(y_val.reshape(len(y_val), -1), dtype=torch.float32),
        ),
        batch_size=BATCH_SIZE,
    )

    model = LSTMModel(len(FEATURES))
    optimizer = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)
    loss_fn = torch.nn.MSELoss()

    best_val_loss = float("inf")
    patience = 5
    patience_counter = 0

    for epoch in range(EPOCHS):
        model.train()
        total_train_loss = 0
        for xb, yb in train_loader:
            pred = model(xb)
            loss = loss_fn(pred, yb)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            total_train_loss += loss.item()
        avg_train_loss = total_train_loss / len(train_loader)

        model.eval()
        total_val_loss = 0
        with torch.no_grad():
            for xb, yb in val_loader:
                pred = model(xb)
                total_val_loss += loss_fn(pred, yb).item()
        avg_val_loss = total_val_loss / len(val_loader)

        print(f"Epoch {epoch+1:02d}/{EPOCHS} | train_loss={avg_train_loss:.4f} | val_loss={avg_val_loss:.4f}")

        if avg_val_loss < best_val_loss:
            best_val_loss = avg_val_loss
            torch.save(model.state_dict(), "/app/models/model.pt")
            joblib.dump(scaler, "/app/models/scaler.pkl")
            patience_counter = 0
            print(f"  ✓ Best model saved (val_loss={best_val_loss:.4f})")
        else:
            patience_counter += 1
            if patience_counter >= patience:
                print(f"Early stopping at epoch {epoch+1}")
                break

    print(f"\nTraining complete. Best val_loss={best_val_loss:.4f}")
    print("Model saved to /app/models/model.pt")


if __name__ == "__main__":
    train()