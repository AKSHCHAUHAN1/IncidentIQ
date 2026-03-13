"""Train TF-IDF + Logistic Regression root-cause classifier on metric text patterns."""

import os
import joblib
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline

MODEL_DIR = "/app/models"
MODEL_PATH = os.path.join(MODEL_DIR, "pattern_classifier.pkl")
LEGACY_PATH = os.path.join(MODEL_DIR, "log_classifier.pkl")


def build_dataset():
    rows = []

    normal = [
        "ttfb_fast dns_fast ratio_balanced errors_clean status_ok ssl_ok",
        "ttfb_moderate dns_moderate ratio_origin_dominant errors_low status_ok ssl_ok",
        "ttfb_fast dns_moderate ratio_balanced errors_clean status_ok ssl_ok",
        "ttfb_moderate dns_fast ratio_origin_dominant errors_low status_ok ssl_ok",
    ]

    dns = [
        "ttfb_slow dns_very_slow ratio_dns_dominant errors_low status_ok ssl_ok",
        "ttfb_very_slow dns_very_slow ratio_dns_dominant errors_clean status_ok ssl_ok",
        "ttfb_slow dns_slow ratio_dns_dominant errors_low status_ok ssl_ok",
        "ttfb_moderate dns_very_slow ratio_dns_dominant errors_clean status_ok ssl_ok",
    ]

    origin = [
        "ttfb_very_slow dns_fast ratio_origin_dominant errors_low status_ok ssl_ok",
        "ttfb_slow dns_fast ratio_origin_dominant errors_low status_ok ssl_ok",
        "ttfb_very_slow dns_moderate ratio_origin_dominant errors_low status_ok ssl_ok",
        "ttfb_slow dns_moderate ratio_origin_dominant errors_low status_ok ssl_ok",
    ]

    err = [
        "ttfb_slow dns_moderate ratio_balanced errors_high status_server_error ssl_ok",
        "ttfb_very_slow dns_fast ratio_origin_dominant errors_critical status_server_error ssl_ok",
        "ttfb_moderate dns_fast ratio_balanced errors_high status_server_error ssl_ok",
        "ttfb_slow dns_fast ratio_balanced errors_critical status_server_error ssl_ok",
    ]

    ssl = [
        "ttfb_moderate dns_fast ratio_balanced errors_clean status_ok ssl_warning",
        "ttfb_fast dns_fast ratio_balanced errors_clean status_ok ssl_critical",
        "ttfb_moderate dns_moderate ratio_balanced errors_low status_ok ssl_warning",
        "ttfb_fast dns_moderate ratio_balanced errors_clean status_ok ssl_critical",
    ]

    latency = [
        "ttfb_very_slow dns_moderate ratio_balanced errors_low status_ok ssl_ok",
        "ttfb_slow dns_moderate ratio_balanced errors_low status_ok ssl_ok",
        "ttfb_very_slow dns_fast ratio_balanced errors_low status_ok ssl_ok",
        "ttfb_slow dns_fast ratio_balanced errors_low status_ok ssl_ok",
    ]

    for txt in normal * 40:
        rows.append((txt, "normal"))
    for txt in dns * 30:
        rows.append((txt, "dns_degradation"))
    for txt in origin * 30:
        rows.append((txt, "origin_slowdown"))
    for txt in err * 30:
        rows.append((txt, "error_spike"))
    for txt in ssl * 20:
        rows.append((txt, "ssl_expiry_warning"))
    for txt in latency * 25:
        rows.append((txt, "latency_spike"))

    return rows


def main():
    rows = build_dataset()
    texts = [r[0] for r in rows]
    labels = [r[1] for r in rows]

    X_train, X_test, y_train, y_test = train_test_split(
        texts,
        labels,
        test_size=0.2,
        random_state=42,
        stratify=labels,
    )

    pipeline = Pipeline([
        (
            "tfidf",
            TfidfVectorizer(
                analyzer="word",
                ngram_range=(1, 2),
                max_features=1200,
                min_df=1,
            ),
        ),
        (
            "clf",
            LogisticRegression(
                max_iter=1000,
                class_weight="balanced",
                random_state=42,
                n_jobs=-1,
            ),
        ),
    ])

    pipeline.fit(X_train, y_train)
    y_pred = pipeline.predict(X_test)

    print("=" * 70)
    print("Pattern classifier (TF-IDF + LR)")
    print(f"Train samples: {len(X_train)} | Test samples: {len(X_test)}")
    print(classification_report(y_test, y_pred))

    os.makedirs(MODEL_DIR, exist_ok=True)
    joblib.dump(pipeline, MODEL_PATH)
    # Keep legacy path for backward compatibility in existing environments.
    joblib.dump(pipeline, LEGACY_PATH)

    print(f"Saved: {MODEL_PATH}")
    print(f"Saved: {LEGACY_PATH}")


if __name__ == "__main__":
    main()