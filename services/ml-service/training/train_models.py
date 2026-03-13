"""
train_models.py
================
Trains all three ML models on REAL labeled probe data from TimescaleDB.

Models:
  1. LSTM         — predicts TTFB trajectory for next 30 minutes
  2. IsolationForest — learns the boundary of "normal" behaviour
  3. TF-IDF + LR  — classifies anomaly type from metric pattern text

All data comes from ml.labeled_probe_readings which contains:
  - Real HTTP probe readings from the website-probe service
  - Labels from real status page incidents (ground truth)
  - Labels from programmatic rules on real observations (weak supervision)

Usage:
    python train_models.py
    python train_models.py --model lstm          # train one model only
    python train_models.py --min-samples 5000   # require more data
"""

import os
import json
import argparse
import joblib
import numpy as np
import psycopg2
import psycopg2.extras
from datetime import datetime

# ─────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────

DB_URL    = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/incident_predictor")
MODEL_DIR = os.environ.get("MODEL_DIR", os.path.join(os.path.dirname(__file__), "models"))
os.makedirs(MODEL_DIR, exist_ok=True)

SEQUENCE_LENGTH  = 60   # 60 minutes of input for LSTM
PREDICT_HORIZON  = 30   # predict next 30 minutes of TTFB
LSTM_FEATURES    = ["ttfb_ms", "dns_ms", "error_rate", "ssl_days_left"]


# ─────────────────────────────────────────────────────────────
# DATA LOADING
# ─────────────────────────────────────────────────────────────

def load_data(min_samples: int) -> tuple:
    """Load all labeled probe data from TimescaleDB."""
    print("Loading labeled probe data from DB...")

    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute("""
        SELECT
            url, probed_at, ttfb_ms, dns_ms, origin_time_ms,
            error_rate, status_code, ssl_days_left,
            ttfb_zscore, dns_zscore, origin_zscore, error_zscore,
            metric_text, anomaly_type, is_anomaly, label_source
        FROM ml.labeled_probe_readings
        WHERE ttfb_ms IS NOT NULL
          AND dns_ms IS NOT NULL
        ORDER BY url, probed_at
    """)
    rows = cur.fetchall()
    cur.close()
    conn.close()

    if len(rows) < min_samples:
        raise ValueError(
            f"Only {len(rows)} labeled rows found. Need at least {min_samples}. "
            f"Run the website-probe service for more days, then re-run label_probe_data.py."
        )

    print(f"✓ Loaded {len(rows):,} rows")

    # Label distribution
    from collections import Counter
    label_counts = Counter(r["anomaly_type"] for r in rows)
    print("Label distribution:")
    for label, count in label_counts.most_common():
        print(f"  {label}: {count:,}")

    return rows


# ─────────────────────────────────────────────────────────────
# MODEL 1: ISOLATION FOREST
# Train ONLY on normal rows — learns the boundary of normal
# ─────────────────────────────────────────────────────────────

def train_isolation_forest(rows: list) -> None:
    from sklearn.ensemble import IsolationForest
    from sklearn.preprocessing import StandardScaler

    print("\n── Training Isolation Forest ──")

    # Use only normal rows — this is the core requirement of IF
    normal_rows = [r for r in rows if r["anomaly_type"] == "normal"]
    print(f"Normal rows for training: {len(normal_rows):,}")

    if len(normal_rows) < 500:
        print("[SKIP] Not enough normal rows yet (need 500+)")
        return

    features = ["ttfb_ms", "dns_ms", "error_rate", "ssl_days_left",
                "origin_time_ms", "ttfb_zscore", "dns_zscore"]

    X = np.array([
        [r[f] or 0 for f in features]
        for r in normal_rows
    ], dtype=np.float32)

    # Scale features
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    # Train Isolation Forest
    # contamination=0.05 means IF expects ~5% of *new* data to be anomalies
    clf = IsolationForest(
        n_estimators=200,
        contamination=0.05,
        max_samples="auto",
        random_state=42,
        n_jobs=-1
    )
    clf.fit(X_scaled)

    # Evaluate on full dataset
    all_X = np.array([
        [r[f] or 0 for f in features]
        for r in rows
    ], dtype=np.float32)
    all_X_scaled = scaler.transform(all_X)
    preds = clf.predict(all_X_scaled)  # -1 = anomaly, 1 = normal

    all_labels = [r["is_anomaly"] for r in rows]
    true_anomalies = sum(all_labels)
    detected = sum(1 for p, a in zip(preds, all_labels) if p == -1 and a)
    false_pos = sum(1 for p, a in zip(preds, all_labels) if p == -1 and not a)

    recall    = detected / max(true_anomalies, 1)
    precision = detected / max(detected + false_pos, 1)
    f1        = 2 * precision * recall / max(precision + recall, 1e-6)

    print(f"Evaluation on labeled data:")
    print(f"  Recall:    {recall:.3f}  ({detected}/{true_anomalies} anomalies caught)")
    print(f"  Precision: {precision:.3f}")
    print(f"  F1:        {f1:.3f}")

    # Save
    metadata = {
        "features": features,
        "n_estimators": 200,
        "trained_on_normal_rows": len(normal_rows),
        "trained_at": datetime.utcnow().isoformat(),
        "recall": recall, "precision": precision, "f1": f1
    }

    joblib.dump(clf,    os.path.join(MODEL_DIR, "isolation_forest.pkl"))
    joblib.dump(scaler, os.path.join(MODEL_DIR, "if_scaler.pkl"))
    with open(os.path.join(MODEL_DIR, "if_metadata.json"), "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"✓ Saved to {MODEL_DIR}/isolation_forest.pkl")


# ─────────────────────────────────────────────────────────────
# MODEL 2: TF-IDF + LOGISTIC REGRESSION
# Classifies anomaly type from metric pattern text
# ─────────────────────────────────────────────────────────────

def train_tfidf_lr(rows: list) -> None:
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import classification_report
    from sklearn.pipeline import Pipeline

    print("\n── Training TF-IDF + Logistic Regression ──")

    # Use all labeled rows (both anomaly types and normal)
    texts  = [r["metric_text"] for r in rows if r["metric_text"]]
    labels = [r["anomaly_type"] for r in rows if r["metric_text"]]

    if len(texts) < 1000:
        print("[SKIP] Not enough labeled data yet (need 1000+)")
        return

    print(f"Total samples: {len(texts):,}")

    X_train, X_test, y_train, y_test = train_test_split(
        texts, labels, test_size=0.2, random_state=42, stratify=labels
    )

    pipeline = Pipeline([
        ("tfidf", TfidfVectorizer(
            analyzer="word",
            ngram_range=(1, 2),  # unigrams + bigrams catch patterns like "dns_z_critical origin_z_normal"
            min_df=5,
            max_features=500,
        )),
        ("lr", LogisticRegression(
            max_iter=1000,
            C=1.0,
            class_weight="balanced",  # handles class imbalance in real data
            random_state=42,
            n_jobs=-1,
        ))
    ])

    pipeline.fit(X_train, y_train)

    # Evaluate
    y_pred = pipeline.predict(X_test)
    report = classification_report(y_test, y_pred)
    print(f"\nClassification Report:\n{report}")

    # Save
    from sklearn.metrics import accuracy_score, f1_score
    acc = accuracy_score(y_test, y_pred)
    f1  = f1_score(y_test, y_pred, average="weighted")

    metadata = {
        "trained_at":      datetime.utcnow().isoformat(),
        "total_samples":   len(texts),
        "train_samples":   len(X_train),
        "test_samples":    len(X_test),
        "accuracy":        round(acc, 4),
        "f1_weighted":     round(f1, 4),
        "classes":         list(set(labels)),
        "classification_report": report,
    }

    joblib.dump(pipeline, os.path.join(MODEL_DIR, "tfidf_lr_pipeline.pkl"))
    with open(os.path.join(MODEL_DIR, "tfidf_lr_metadata.json"), "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"✓ Saved to {MODEL_DIR}/tfidf_lr_pipeline.pkl")
    print(f"  Accuracy: {acc:.4f} | F1 (weighted): {f1:.4f}")


# ─────────────────────────────────────────────────────────────
# MODEL 3: LSTM TIME-SERIES PREDICTOR
# Predicts TTFB trajectory for next 30 minutes
# ─────────────────────────────────────────────────────────────

def build_lstm_sequences(rows: list, url: str) -> tuple:
    """Build (X, y) sequence pairs for a single URL."""
    url_rows = [r for r in rows if r["url"] == url]
    url_rows.sort(key=lambda r: r["probed_at"])

    if len(url_rows) < SEQUENCE_LENGTH + PREDICT_HORIZON + 10:
        return None, None

    # Per-URL normalization (z-score)
    values = np.array([
        [r[f] or 0.0 for f in LSTM_FEATURES]
        for r in url_rows
    ], dtype=np.float32)

    means = values.mean(axis=0)
    stds  = values.std(axis=0)
    stds[stds == 0] = 1.0
    normalized = (values - means) / stds

    ttfb_raw  = values[:, 0]
    ttfb_mean = means[0]
    ttfb_std  = stds[0]

    X_seqs, y_seqs = [], []
    for i in range(SEQUENCE_LENGTH, len(normalized) - PREDICT_HORIZON):
        X_seqs.append(normalized[i - SEQUENCE_LENGTH:i])
        # Target: next 30 min of TTFB (normalized)
        y_seqs.append((ttfb_raw[i:i + PREDICT_HORIZON] - ttfb_mean) / ttfb_std)

    if not X_seqs:
        return None, None

    return np.array(X_seqs, dtype=np.float32), np.array(y_seqs, dtype=np.float32)


def train_lstm(rows: list) -> None:
    try:
        import torch
        import torch.nn as nn
        from torch.utils.data import DataLoader, TensorDataset
    except ImportError:
        print("[SKIP] PyTorch not installed. Run: pip install torch")
        return

    print("\n── Training LSTM ──")

    # Build sequences per URL, concatenate
    urls = list(set(r["url"] for r in rows))
    all_X, all_y = [], []

    for url in urls:
        X, y = build_lstm_sequences(rows, url)
        if X is not None:
            all_X.append(X)
            all_y.append(y)
            print(f"  {url}: {len(X):,} sequences")

    if not all_X:
        print("[SKIP] Not enough data for LSTM sequences yet")
        return

    X = np.concatenate(all_X, axis=0)
    y = np.concatenate(all_y, axis=0)
    print(f"\nTotal sequences: {len(X):,} | Shape: X={X.shape}, y={y.shape}")

    # Train / val split (80/20, time-ordered — don't shuffle time series)
    split = int(len(X) * 0.8)
    X_train, X_val = X[:split], X[split:]
    y_train, y_val = y[:split], y[split:]

    X_train_t = torch.tensor(X_train)
    y_train_t = torch.tensor(y_train)
    X_val_t   = torch.tensor(X_val)
    y_val_t   = torch.tensor(y_val)

    train_ds = TensorDataset(X_train_t, y_train_t)
    val_ds   = TensorDataset(X_val_t, y_val_t)

    train_dl = DataLoader(train_ds, batch_size=256, shuffle=True)
    val_dl   = DataLoader(val_ds, batch_size=256, shuffle=False)

    # ── Model definition ──────────────────────────────────────
    class LSTMPredictor(nn.Module):
        def __init__(self, input_size, hidden_size, num_layers, output_size):
            super().__init__()
            self.lstm = nn.LSTM(
                input_size=input_size,
                hidden_size=hidden_size,
                num_layers=num_layers,
                batch_first=True,
                dropout=0.2 if num_layers > 1 else 0.0
            )
            self.attention = nn.Linear(hidden_size, 1)
            self.fc = nn.Linear(hidden_size, output_size)

        def forward(self, x):
            # x: (batch, seq_len, input_size)
            lstm_out, _ = self.lstm(x)
            # Attention over time steps
            attn_weights = torch.softmax(self.attention(lstm_out), dim=1)
            context = (lstm_out * attn_weights).sum(dim=1)
            return self.fc(context)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")

    model = LSTMPredictor(
        input_size=len(LSTM_FEATURES),
        hidden_size=128,
        num_layers=2,
        output_size=PREDICT_HORIZON
    ).to(device)

    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, patience=3, factor=0.5)
    loss_fn   = nn.MSELoss()

    # ── Training loop ─────────────────────────────────────────
    best_val_loss = float("inf")
    patience_count = 0
    EARLY_STOP_PATIENCE = 7

    for epoch in range(1, 51):
        model.train()
        train_loss = 0.0
        for xb, yb in train_dl:
            xb, yb = xb.to(device), yb.to(device)
            optimizer.zero_grad()
            pred = model(xb)
            loss = loss_fn(pred, yb)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            train_loss += loss.item()

        model.eval()
        val_loss = 0.0
        with torch.no_grad():
            for xb, yb in val_dl:
                xb, yb = xb.to(device), yb.to(device)
                val_loss += loss_fn(model(xb), yb).item()

        train_loss /= len(train_dl)
        val_loss   /= len(val_dl)
        scheduler.step(val_loss)

        print(f"Epoch {epoch:02d} | Train MSE: {train_loss:.4f} | Val MSE: {val_loss:.4f}")

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            patience_count = 0
            torch.save(model.state_dict(), os.path.join(MODEL_DIR, "lstm_best.pt"))
        else:
            patience_count += 1
            if patience_count >= EARLY_STOP_PATIENCE:
                print(f"Early stopping at epoch {epoch}")
                break

    # Compute MAE on validation set
    model.load_state_dict(torch.load(os.path.join(MODEL_DIR, "lstm_best.pt")))
    model.eval()
    all_preds, all_true = [], []
    with torch.no_grad():
        for xb, yb in val_dl:
            xb = xb.to(device)
            all_preds.append(model(xb).cpu().numpy())
            all_true.append(yb.numpy())
    all_preds = np.concatenate(all_preds)
    all_true  = np.concatenate(all_true)
    mae = np.abs(all_preds - all_true).mean()

    # Save architecture config
    config = {
        "input_size":       len(LSTM_FEATURES),
        "hidden_size":      128,
        "num_layers":       2,
        "output_size":      PREDICT_HORIZON,
        "sequence_length":  SEQUENCE_LENGTH,
        "predict_horizon":  PREDICT_HORIZON,
        "features":         LSTM_FEATURES,
        "trained_at":       datetime.utcnow().isoformat(),
        "total_sequences":  len(X),
        "val_mse":          round(float(best_val_loss), 6),
        "val_mae":          round(float(mae), 6),
    }
    with open(os.path.join(MODEL_DIR, "lstm_config.json"), "w") as f:
        json.dump(config, f, indent=2)

    print(f"✓ Saved to {MODEL_DIR}/lstm_best.pt")
    print(f"  Val MSE: {best_val_loss:.4f} | Val MAE: {mae:.4f}")


# ─────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=["lstm", "if", "tfidf", "all"], default="all")
    parser.add_argument("--min-samples", type=int, default=10000,
                        help="Minimum labeled rows required")
    args = parser.parse_args()

    rows = load_data(args.min_samples)

    if args.model in ("all", "if"):
        train_isolation_forest(rows)

    if args.model in ("all", "tfidf"):
        train_tfidf_lr(rows)

    if args.model in ("all", "lstm"):
        train_lstm(rows)

    print(f"\n{'='*50}")
    print("Training complete. Models saved to:", MODEL_DIR)
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
