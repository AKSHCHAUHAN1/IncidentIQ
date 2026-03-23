"""
seed_training_data.py
=====================
Generates realistic synthetic data directly into ml.labeled_probe_readings
so that train_models.py can run without waiting weeks for real probe data.

Safe to re-run: uses ON CONFLICT DO NOTHING.

Usage (inside Docker):
    python training/seed_training_data.py
    python training/seed_training_data.py --rows 20000
"""

import os
import argparse
import random
import numpy as np
import psycopg2
import psycopg2.extras
from datetime import datetime, timezone, timedelta
from collections import Counter

DB_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/incident_predictor",
)

# ── URLs to simulate ─────────────────────────────────────────
URLS = [
    "https://github.com",
    "https://stripe.com",
    "https://cloudflare.com",
    "https://vercel.com",
    "https://npmjs.com",
]

# ── Anomaly distribution ─────────────────────────────────────
# Matches what real-world monitoring typically yields
ANOMALY_WEIGHTS = {
    "normal":              0.80,
    "dns_degradation":     0.05,
    "origin_slowdown":     0.05,
    "latency_spike":       0.04,
    "error_spike":         0.03,
    "ssl_expiry_warning":  0.02,
    "cdn_throttling":      0.01,
}


def generate_normal():
    """Normal probe readings — healthy service."""
    return {
        "ttfb_ms":       round(random.gauss(160, 40), 1),
        "dns_ms":        round(random.gauss(25, 8), 1),
        "error_rate":    round(max(0, random.gauss(0.005, 0.003)), 4),
        "ssl_days_left": round(random.uniform(60, 365), 0),
        "status_code":   200,
    }


def generate_dns_degradation():
    """DNS is slow, origin is normal → DNS is the culprit."""
    dns = round(random.gauss(450, 120), 1)
    return {
        "ttfb_ms":       round(dns + random.gauss(120, 30), 1),  # TTFB ≈ DNS + small origin
        "dns_ms":        dns,
        "error_rate":    round(max(0, random.gauss(0.01, 0.005)), 4),
        "ssl_days_left": round(random.uniform(60, 365), 0),
        "status_code":   200,
    }


def generate_origin_slowdown():
    """Origin is slow, DNS is normal → server-side issue."""
    dns = round(random.gauss(25, 8), 1)
    origin = round(random.gauss(800, 200), 1)
    return {
        "ttfb_ms":       round(dns + origin, 1),
        "dns_ms":        dns,
        "error_rate":    round(max(0, random.gauss(0.02, 0.01)), 4),
        "ssl_days_left": round(random.uniform(60, 365), 0),
        "status_code":   200,
    }


def generate_latency_spike():
    """General TTFB spike — no clear DNS/origin pattern."""
    dns = round(random.gauss(80, 30), 1)
    return {
        "ttfb_ms":       round(random.gauss(1200, 300), 1),
        "dns_ms":        dns,
        "error_rate":    round(max(0, random.gauss(0.03, 0.02)), 4),
        "ssl_days_left": round(random.uniform(60, 365), 0),
        "status_code":   200,
    }


def generate_error_spike():
    """Elevated error rate — 5xx responses."""
    return {
        "ttfb_ms":       round(random.gauss(300, 100), 1),
        "dns_ms":        round(random.gauss(25, 8), 1),
        "error_rate":    round(random.uniform(0.12, 0.60), 4),
        "ssl_days_left": round(random.uniform(60, 365), 0),
        "status_code":   random.choice([500, 502, 503, 504]),
    }


def generate_ssl_expiry_warning():
    """SSL certificate about to expire."""
    return {
        "ttfb_ms":       round(random.gauss(160, 40), 1),
        "dns_ms":        round(random.gauss(25, 8), 1),
        "error_rate":    round(max(0, random.gauss(0.005, 0.003)), 4),
        "ssl_days_left": round(random.uniform(1, 13), 1),
        "status_code":   200,
    }


def generate_cdn_throttling():
    """Moderate TTFB + DNS elevation from CDN throttling."""
    dns = round(random.gauss(120, 30), 1)
    return {
        "ttfb_ms":       round(dns + random.gauss(350, 80), 1),
        "dns_ms":        dns,
        "error_rate":    round(max(0, random.gauss(0.04, 0.02)), 4),
        "ssl_days_left": round(random.uniform(60, 365), 0),
        "status_code":   200,
    }


GENERATORS = {
    "normal":              generate_normal,
    "dns_degradation":     generate_dns_degradation,
    "origin_slowdown":     generate_origin_slowdown,
    "latency_spike":       generate_latency_spike,
    "error_spike":         generate_error_spike,
    "ssl_expiry_warning":  generate_ssl_expiry_warning,
    "cdn_throttling":      generate_cdn_throttling,
}


# ── Metric text discretizer (mirrors label_probe_data.py) ────
def row_to_metric_text(row: dict) -> str:
    parts = []

    ttfb = row["ttfb_ms"] or 0
    if ttfb < 200:    parts.append("ttfb_fast")
    elif ttfb < 600:  parts.append("ttfb_moderate")
    elif ttfb < 1500: parts.append("ttfb_slow")
    else:             parts.append("ttfb_very_slow")

    tz = row.get("ttfb_zscore") or 0
    if tz < 1:    parts.append("ttfb_z_normal")
    elif tz < 2:  parts.append("ttfb_z_elevated")
    elif tz < 3:  parts.append("ttfb_z_high")
    else:         parts.append("ttfb_z_critical")

    dns = row["dns_ms"] or 0
    if dns < 30:    parts.append("dns_fast")
    elif dns < 100: parts.append("dns_moderate")
    elif dns < 250: parts.append("dns_slow")
    else:           parts.append("dns_very_slow")

    dz = row.get("dns_zscore") or 0
    if dz < 1:   parts.append("dns_z_normal")
    elif dz < 2: parts.append("dns_z_elevated")
    elif dz < 3: parts.append("dns_z_high")
    else:        parts.append("dns_z_critical")

    oz = row.get("origin_zscore") or 0
    if oz < 1:   parts.append("origin_z_normal")
    elif oz < 2: parts.append("origin_z_elevated")
    elif oz < 3: parts.append("origin_z_high")
    else:        parts.append("origin_z_critical")

    ratio = ttfb / (dns + 1)
    if ratio < 3:    parts.append("ratio_dns_dominant")
    elif ratio < 8:  parts.append("ratio_balanced")
    else:            parts.append("ratio_origin_dominant")

    err = row.get("error_rate") or 0
    if err < 0.02:   parts.append("errors_clean")
    elif err < 0.10: parts.append("errors_low")
    elif err < 0.30: parts.append("errors_high")
    else:            parts.append("errors_critical")

    code = row.get("status_code") or 200
    if code == 200:         parts.append("status_ok")
    elif 400 <= code < 500: parts.append("status_client_error")
    elif code >= 500:       parts.append("status_server_error")

    ssl = row.get("ssl_days_left") or 365
    if ssl < 7:    parts.append("ssl_critical")
    elif ssl < 14: parts.append("ssl_warning")
    elif ssl < 30: parts.append("ssl_soon")
    else:          parts.append("ssl_ok")

    return " ".join(parts)


# ── Main ──────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Seed synthetic training data")
    parser.add_argument("--rows", type=int, default=15000,
                        help="Total rows to generate (default: 15000)")
    args = parser.parse_args()

    random.seed(42)
    np.random.seed(42)

    total = args.rows
    anomaly_types = list(ANOMALY_WEIGHTS.keys())
    weights = [ANOMALY_WEIGHTS[t] for t in anomaly_types]

    # Distribute rows across URLs evenly
    rows_per_url = total // len(URLS)
    start_time = datetime(2026, 2, 20, 0, 0, 0, tzinfo=timezone.utc)

    all_rows = []

    for url in URLS:
        url_rows = []
        # Pick anomaly types for this URL's rows
        types = random.choices(anomaly_types, weights=weights, k=rows_per_url)
        for i, atype in enumerate(types):
            ts = start_time + timedelta(minutes=i)
            gen = GENERATORS[atype]
            metrics = gen()

            # Clamp negatives
            metrics["ttfb_ms"] = max(10, metrics["ttfb_ms"])
            metrics["dns_ms"] = max(1, metrics["dns_ms"])
            metrics["error_rate"] = max(0, metrics["error_rate"])

            origin_time_ms = round(metrics["ttfb_ms"] - metrics["dns_ms"], 1)

            row = {
                "url": url,
                "probed_at": ts,
                "ttfb_ms": metrics["ttfb_ms"],
                "dns_ms": metrics["dns_ms"],
                "origin_time_ms": origin_time_ms,
                "error_rate": metrics["error_rate"],
                "status_code": metrics["status_code"],
                "ssl_days_left": metrics["ssl_days_left"],
                "anomaly_type": atype,
                "is_anomaly": atype != "normal",
                "label_source": "synthetic",
                "label_confidence": 1.0,
            }
            url_rows.append(row)

        # Compute per-URL baselines from normal rows
        normal_rows = [r for r in url_rows if r["anomaly_type"] == "normal"]
        if normal_rows:
            ttfb_vals = [r["ttfb_ms"] for r in normal_rows]
            dns_vals = [r["dns_ms"] for r in normal_rows]
            origin_vals = [r["origin_time_ms"] for r in normal_rows]
            err_vals = [r["error_rate"] for r in normal_rows]

            ttfb_mean, ttfb_std = np.mean(ttfb_vals), max(np.std(ttfb_vals), 1.0)
            dns_mean, dns_std = np.mean(dns_vals), max(np.std(dns_vals), 1.0)
            origin_mean, origin_std = np.mean(origin_vals), max(np.std(origin_vals), 1.0)
            err_mean, err_std = np.mean(err_vals), max(np.std(err_vals), 0.001)
        else:
            ttfb_mean, ttfb_std = 160, 40
            dns_mean, dns_std = 25, 8
            origin_mean, origin_std = 135, 35
            err_mean, err_std = 0.005, 0.003

        # Add z-scores and metric_text to each row
        for row in url_rows:
            row["ttfb_zscore"] = round((row["ttfb_ms"] - ttfb_mean) / ttfb_std, 3)
            row["dns_zscore"] = round((row["dns_ms"] - dns_mean) / dns_std, 3)
            row["origin_zscore"] = round((row["origin_time_ms"] - origin_mean) / origin_std, 3)
            row["error_zscore"] = round((row["error_rate"] - err_mean) / err_std, 3)
            row["metric_text"] = row_to_metric_text(row)

        all_rows.extend(url_rows)

        # Store baseline info for this URL
        url_rows[0]["_baseline"] = {
            "url": url,
            "ttfb_mean": float(ttfb_mean),
            "ttfb_std": float(ttfb_std),
            "dns_mean": float(dns_mean),
            "dns_std": float(dns_std),
            "err_mean": float(err_mean),
            "err_std": float(err_std),
        }

    # Print distribution
    counts = Counter(r["anomaly_type"] for r in all_rows)
    print(f"Generated {len(all_rows):,} rows:")
    for label, count in counts.most_common():
        pct = count / len(all_rows) * 100
        print(f"  {label:25s} {count:6,}  ({pct:.1f}%)")

    # ── Insert into database ──────────────────────────────────
    print(f"\nConnecting to database...")
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = False
    cur = conn.cursor()

    # Ensure the schema and table exist
    cur.execute("CREATE SCHEMA IF NOT EXISTS ml;")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS ml.labeled_probe_readings (
            id                  BIGSERIAL PRIMARY KEY,
            url                 TEXT NOT NULL,
            probed_at           TIMESTAMPTZ NOT NULL,
            ttfb_ms             FLOAT,
            dns_ms              FLOAT,
            origin_time_ms      FLOAT,
            error_rate          FLOAT,
            status_code         INT,
            ssl_days_left       FLOAT,
            ttfb_zscore         FLOAT,
            dns_zscore          FLOAT,
            origin_zscore       FLOAT,
            error_zscore        FLOAT,
            metric_text         TEXT,
            anomaly_type        TEXT NOT NULL DEFAULT 'normal',
            is_anomaly          BOOLEAN NOT NULL DEFAULT FALSE,
            label_source        TEXT,
            label_confidence    FLOAT,
            UNIQUE (url, probed_at)
        );
    """)
    conn.commit()

    # Seed url_baselines
    cur.execute("""
        CREATE TABLE IF NOT EXISTS ml.url_baselines (
            url                         TEXT PRIMARY KEY,
            ttfb_p75_ms                 FLOAT,
            lcp_p75_ms                  FLOAT,
            fcp_p75_ms                  FLOAT,
            ttfb_anomaly_threshold_ms   FLOAT,
            probe_ttfb_mean_ms          FLOAT,
            probe_ttfb_std_ms           FLOAT,
            probe_dns_mean_ms           FLOAT,
            probe_dns_std_ms            FLOAT,
            probe_error_rate_mean       FLOAT,
            probe_error_rate_std        FLOAT,
            baseline_computed_at        TIMESTAMPTZ,
            crux_fetched_at             TIMESTAMPTZ,
            source                      TEXT DEFAULT 'synthetic'
        );
    """)
    conn.commit()

    baselines_inserted = 0
    for row in all_rows:
        bl = row.pop("_baseline", None)
        if bl:
            cur.execute("""
                INSERT INTO ml.url_baselines (
                    url, probe_ttfb_mean_ms, probe_ttfb_std_ms,
                    probe_dns_mean_ms, probe_dns_std_ms,
                    probe_error_rate_mean, probe_error_rate_std,
                    baseline_computed_at, source
                ) VALUES (
                    %(url)s, %(ttfb_mean)s, %(ttfb_std)s,
                    %(dns_mean)s, %(dns_std)s,
                    %(err_mean)s, %(err_std)s,
                    NOW(), 'synthetic'
                ) ON CONFLICT (url) DO UPDATE SET
                    probe_ttfb_mean_ms    = EXCLUDED.probe_ttfb_mean_ms,
                    probe_ttfb_std_ms     = EXCLUDED.probe_ttfb_std_ms,
                    probe_dns_mean_ms     = EXCLUDED.probe_dns_mean_ms,
                    probe_dns_std_ms      = EXCLUDED.probe_dns_std_ms,
                    probe_error_rate_mean = EXCLUDED.probe_error_rate_mean,
                    probe_error_rate_std  = EXCLUDED.probe_error_rate_std,
                    baseline_computed_at  = NOW(),
                    source                = 'synthetic'
            """, bl)
            baselines_inserted += 1

    conn.commit()
    print(f"✓ Seeded {baselines_inserted} URL baselines")

    # Insert labeled rows in batches
    insert_sql = """
        INSERT INTO ml.labeled_probe_readings (
            url, probed_at, ttfb_ms, dns_ms, origin_time_ms,
            error_rate, status_code, ssl_days_left,
            ttfb_zscore, dns_zscore, origin_zscore, error_zscore,
            metric_text, anomaly_type, is_anomaly, label_source, label_confidence
        ) VALUES (
            %(url)s, %(probed_at)s, %(ttfb_ms)s, %(dns_ms)s, %(origin_time_ms)s,
            %(error_rate)s, %(status_code)s, %(ssl_days_left)s,
            %(ttfb_zscore)s, %(dns_zscore)s, %(origin_zscore)s, %(error_zscore)s,
            %(metric_text)s, %(anomaly_type)s, %(is_anomaly)s,
            %(label_source)s, %(label_confidence)s
        ) ON CONFLICT DO NOTHING
    """

    batch_size = 5000
    for i in range(0, len(all_rows), batch_size):
        batch = all_rows[i:i + batch_size]
        psycopg2.extras.execute_batch(cur, insert_sql, batch, page_size=500)
        conn.commit()
        print(f"  Inserted {min(i + batch_size, len(all_rows)):,}/{len(all_rows):,}")

    # Verify count
    cur.execute("SELECT COUNT(*) FROM ml.labeled_probe_readings")
    total_in_db = cur.fetchone()[0]

    cur.close()
    conn.close()

    print(f"\n{'='*50}")
    print(f"✓ Done! {total_in_db:,} total rows in ml.labeled_probe_readings")
    print(f"  Run: python training/train_models.py")
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
