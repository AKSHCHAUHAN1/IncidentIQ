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

# ----------------------------
# Synthetic DevOps Log Dataset
# ----------------------------
def build_dataset():
    texts = [
        "Service started successfully",
        "Connection timeout to database",
        "CPU usage exceeded 95 percent",
        "Memory allocation failed",
        "Health check passed",
        "Error rate increased above threshold",
        "Container restarted automatically",
        "Disk space critically low",
        "Latency spike detected",
        "Application running normally"
    ]

    labels = [
        0,  # normal
        2,  # critical
        2,
        2,
        0,
        1,
        1,
        2,
        1,
        0
    ]

    return Dataset.from_dict({
        "text": texts,
        "label": labels
    })


def main():
    print("="*50)
    print("Training DistilBERT Log Classifier")
    print("="*50)

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
        num_train_epochs=5,
        per_device_train_batch_size=4,
        save_strategy="no",
        logging_steps=1,
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


if __name__ == "__main__":
    main()