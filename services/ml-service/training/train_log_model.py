import os
import torch
from transformers import (
    DistilBertTokenizerFast,
    DistilBertForSequenceClassification,
    Trainer,
    TrainingArguments
)
from datasets import Dataset

MODEL_DIR = "/app/models/log_model"

# ─────────────────────────────────────────────────────────────────
# Expanded DevOps Log Dataset (80 samples, 3 classes)
# 0 = normal  |  1 = warning  |  2 = critical
# ─────────────────────────────────────────────────────────────────
LOGS = [
    # ── NORMAL (label 0) ──────────────────────────────────────────
    ("Service started successfully", 0),
    ("Health check passed", 0),
    ("Application running normally", 0),
    ("Database connection established", 0),
    ("Cache warmed up successfully", 0),
    ("Scheduled job completed", 0),
    ("Request processed in 45ms", 0),
    ("User authentication successful", 0),
    ("Config loaded from environment", 0),
    ("Replica synced successfully", 0),
    ("Backup completed successfully", 0),
    ("API response time 120ms", 0),
    ("Worker thread started", 0),
    ("Queue processing started", 0),
    ("Deployment completed successfully", 0),
    ("SSL certificate valid", 0),
    ("Load balancer healthy", 0),
    ("Metrics exported successfully", 0),
    ("Pod started and ready", 0),
    ("Service registered in discovery", 0),
    ("Log rotation completed", 0),
    ("Ping response time 5ms", 0),
    ("Connection pool initialized", 0),
    ("Graceful shutdown complete", 0),
    ("Feature flag evaluated normally", 0),

    # ── WARNING (label 1) ─────────────────────────────────────────
    ("Container restarted automatically", 1),
    ("Error rate increased above threshold", 1),
    ("Memory usage at 75 percent", 1),
    ("Latency spike detected 250ms", 1),
    ("Retry attempt 2 of 3", 1),
    ("Slow query detected 800ms", 1),
    ("CPU usage climbing to 70 percent", 1),
    ("Connection pool nearing limit", 1),
    ("Disk usage at 80 percent", 1),
    ("Rate limit approaching for service", 1),
    ("Response time degraded to 400ms", 1),
    ("Worker queue backing up", 1),
    ("Cache miss rate elevated", 1),
    ("Retrying failed request to database", 1),
    ("GC pause duration elevated 300ms", 1),
    ("Network packet loss detected 2 percent", 1),
    ("Timeout on downstream service", 1),
    ("Thread pool utilization at 80 percent", 1),
    ("Warning: high open file descriptor count", 1),
    ("Swap memory usage detected", 1),
    ("Log volume increasing rapidly", 1),
    ("Health check degraded response", 1),
    ("API error rate 8 percent", 1),
    ("Circuit breaker half-open state", 1),
    ("Pending requests queue growing", 1),

    # ── CRITICAL (label 2) ────────────────────────────────────────
    ("Connection timeout to database", 2),
    ("CPU usage exceeded 95 percent", 2),
    ("Memory allocation failed out of memory", 2),
    ("Disk space critically low 2 percent remaining", 2),
    ("Service crashed with exit code 1", 2),
    ("Database connection pool exhausted", 2),
    ("Error rate exceeded 25 percent", 2),
    ("Latency exceeded 1000ms SLA breached", 2),
    ("Pod OOMKilled by Kubernetes", 2),
    ("Critical security exception thrown", 2),
    ("Unhandled exception in main thread", 2),
    ("Deadlock detected in database", 2),
    ("Service unreachable connection refused", 2),
    ("Data corruption detected in storage", 2),
    ("Network interface down", 2),
    ("SSL certificate expired", 2),
    ("Multiple health checks failing", 2),
    ("Disk IO error write failed", 2),
    ("Cascading failure across services", 2),
    ("Circuit breaker open all requests failing", 2),
    ("Node memory pressure evicting pods", 2),
    ("Database replication lag critical", 2),
    ("Request queue overflow dropping requests", 2),
    ("Authentication service unavailable", 2),
    ("Fatal error application terminated", 2),
    ("Kernel OOM killer invoked", 2),
    ("TCP connection limit reached", 2),
    ("Storage backend not responding", 2),
    ("Load balancer health check failed all backends", 2),
    ("Emergency shutdown triggered", 2),
]


def build_dataset():
    texts  = [t for t, _ in LOGS]
    labels = [l for _, l in LOGS]
    return Dataset.from_dict({"text": texts, "label": labels})


def main():
    print("=" * 50)
    print("Training DistilBERT Log Classifier")
    print(f"Dataset size: {len(LOGS)} samples")
    print("=" * 50)

    dataset = build_dataset()

    tokenizer = DistilBertTokenizerFast.from_pretrained("distilbert-base-uncased")

    def tokenize(batch):
        return tokenizer(
            batch["text"],
            padding="max_length",
            truncation=True,
            max_length=64
        )

    dataset = dataset.map(tokenize, batched=True)
    dataset.set_format("torch", columns=["input_ids", "attention_mask", "label"])

    model = DistilBertForSequenceClassification.from_pretrained(
        "distilbert-base-uncased",
        num_labels=3
    )

    training_args = TrainingArguments(
        output_dir="/app/tmp",
        num_train_epochs=8,           # more epochs for small dataset
        per_device_train_batch_size=8,
        learning_rate=2e-5,
        weight_decay=0.01,
        save_strategy="no",
        logging_steps=5,
        report_to="none"
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=dataset
    )

    trainer.train()

    os.makedirs(MODEL_DIR, exist_ok=True)
    model.save_pretrained(MODEL_DIR)
    tokenizer.save_pretrained(MODEL_DIR)

    print("Log model saved:", MODEL_DIR)
    print(f"Classes: 0=normal  1=warning  2=critical")


if __name__ == "__main__":
    main()