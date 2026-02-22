import os

# =========================
# Database Configuration
# =========================

DB_HOST = os.getenv("DB_HOST", "postgres")
DB_PORT = int(os.getenv("DB_PORT", 5432))
DB_NAME = os.getenv("DB_NAME", "incident_predictor")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "postgres")

# =========================
# Feature Configuration
# =========================

FEATURES = [
    "cpu",
    "memory",
    "request_rate",
    "error_rate",
    "latency"
]

INPUT_WINDOW = 20
OUTPUT_WINDOW = 10

# =========================
# Training Parameters
# =========================

BATCH_SIZE = 64
EPOCHS = 20
LEARNING_RATE = 0.001
HIDDEN_SIZE = 128
NUM_LAYERS = 2
