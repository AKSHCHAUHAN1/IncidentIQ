"""
LSTM Training Entry Point
Run: docker compose exec ml-service python ../training/train_lstm.py
"""

import sys
import os

# Add /app/training to path so 'from trainer import train' works
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# Add /app/src to path so trainer.py can import config, model, dataset
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from trainer import train

if __name__ == "__main__":
    print("=" * 50)
    print("  LSTM Predictor - Training Pipeline")
    print("=" * 50)
    train()