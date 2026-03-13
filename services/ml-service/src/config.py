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
    "ttfb_ms",
    "dns_ms",
    "error_rate",
    "ssl_days_left"
]

INPUT_WINDOW = 60
OUTPUT_WINDOW = 30

# =========================
# Training Parameters
# =========================

BATCH_SIZE = 64
EPOCHS = 20
LEARNING_RATE = 0.001
HIDDEN_SIZE = 128
NUM_LAYERS = 2
