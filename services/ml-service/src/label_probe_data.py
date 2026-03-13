"""
label_probe_data.py
====================
Labels real probe data collected by the website-probe service.

Two labeling sources (both producing REAL labels on REAL data):

SOURCE 1 — Status page correlation (highest confidence)
    When probe reading falls within a known status page incident window,
    it gets the incident's label. This is ground truth from the vendor.

SOURCE 2 — Programmatic labeling (for what status pages don't cover)
    Statistical rules applied to real observations using per-URL baselines.
    This is the "weak supervision" / Snorkel approach — deterministic rules
    on real data. Not synthetic. The observations are 100% real; only the
    label derivation is automated.

    Rules are based on well-documented networking behaviour:
    - DNS degradation: dns_ms >> baseline while origin_time stays normal
    - Origin slowdown: origin_time >> baseline while dns_ms stays normal
    - Error spike: error_rate > 10%
    - SSL warning: ssl_days_left < 14 (hard threshold, no ambiguity)
    - Latency spike: ttfb >> 3σ with no specific DNS/origin pattern

Conflict resolution:
    Status page label always wins over programmatic label.

Usage:
    python label_probe_data.py
    python label_probe_data.py --min-probe-days 7  # require 7+ days of warmup
"""

import psycopg2
import psycopg2.extras
import json
import os
import argparse
import numpy as np
from datetime import datetime, timezone, timedelta

DB_URL = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/incident_predictor")

# ─────────────────────────────────────────────────────────────
# STEP 1: Compute per-URL probe baselines from the warmup window
# (first N days of data before any known incidents)
# ─────────────────────────────────────────────────────────────

COMPUTE_PROBE_BASELINES_SQL = """
WITH clean_window AS (
    -- Use probe data that does NOT overlap any known status page incident
    SELECT
        p.url,
        p.ttfb_ms,
        p.dns_ms,
        p.error_rate,
        (p.ttfb_ms - p.dns_ms) AS origin_time_ms
    FROM metrics.probe_readings p
    WHERE p.probed_at >= NOW() - INTERVAL '{days} days'
      AND NOT EXISTS (
          SELECT 1 FROM ml.status_incidents si
          WHERE si.url = p.url
            AND p.probed_at BETWEEN si.started_at AND si.resolved_at
      )
      -- Only clear normal status codes
      AND p.status_code = 200
)
SELECT
    url,
    AVG(ttfb_ms)        AS ttfb_mean,
    STDDEV(ttfb_ms)     AS ttfb_std,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ttfb_ms) AS ttfb_p95,
    AVG(dns_ms)         AS dns_mean,
    STDDEV(dns_ms)      AS dns_std,
    AVG(error_rate)     AS error_rate_mean,
    STDDEV(error_rate)  AS error_rate_std,
    AVG(origin_time_ms) AS origin_mean,
    STDDEV(origin_time_ms) AS origin_std,
    COUNT(*)            AS sample_count
FROM clean_window
GROUP BY url
HAVING COUNT(*) >= 1000  -- need at least ~17 hours of readings to compute baseline
"""

UPDATE_BASELINE_SQL = """
UPDATE ml.url_baselines SET
    probe_ttfb_mean_ms       = %(ttfb_mean)s,
    probe_ttfb_std_ms        = %(ttfb_std)s,
    probe_dns_mean_ms        = %(dns_mean)s,
    probe_dns_std_ms         = %(dns_std)s,
    probe_error_rate_mean    = %(error_rate_mean)s,
    probe_error_rate_std     = %(error_rate_std)s,
    baseline_computed_at     = NOW()
WHERE url = %(url)s;
"""

# ─────────────────────────────────────────────────────────────
# STEP 2: Label probe readings
# ─────────────────────────────────────────────────────────────

CREATE_LABELED_TABLE_SQL = """
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
    -- Z-scores relative to per-URL baseline
    ttfb_zscore         FLOAT,
    dns_zscore          FLOAT,
    origin_zscore       FLOAT,
    error_zscore        FLOAT,
    -- Derived features for TF-IDF text generation
    metric_text         TEXT,
    -- Label
    anomaly_type        TEXT NOT NULL DEFAULT 'normal',
    is_anomaly          BOOLEAN NOT NULL DEFAULT FALSE,
    label_source        TEXT,  -- 'statuspage' | 'programmatic' | 'normal'
    label_confidence    FLOAT, -- 1.0 for statuspage, 0.7-0.9 for programmatic
    UNIQUE (url, probed_at)
);

CREATE INDEX IF NOT EXISTS idx_labeled_url ON ml.labeled_probe_readings (url);
CREATE INDEX IF NOT EXISTS idx_labeled_at  ON ml.labeled_probe_readings (probed_at DESC);
CREATE INDEX IF NOT EXISTS idx_labeled_type ON ml.labeled_probe_readings (anomaly_type);
"""

FETCH_UNLABELED_SQL = """
SELECT
    p.id,
    p.url,
    p.probed_at,
    p.ttfb_ms,
    p.dns_ms,
    (p.ttfb_ms - p.dns_ms)  AS origin_time_ms,
    p.error_rate,
    p.status_code,
    p.ssl_days_left,
    b.probe_ttfb_mean_ms    AS ttfb_mean,
    b.probe_ttfb_std_ms     AS ttfb_std,
    b.probe_dns_mean_ms     AS dns_mean,
    b.probe_dns_std_ms      AS dns_std,
    b.probe_error_rate_mean AS err_mean,
    b.probe_error_rate_std  AS err_std,
    -- origin baseline derived from probe baseline
    (b.probe_ttfb_mean_ms - b.probe_dns_mean_ms) AS origin_mean,
    SQRT(POWER(b.probe_ttfb_std_ms, 2) + POWER(b.probe_dns_std_ms, 2)) AS origin_std
FROM metrics.probe_readings p
JOIN ml.url_baselines b ON b.url = p.url
WHERE b.probe_ttfb_mean_ms IS NOT NULL   -- baseline must exist
  AND p.probed_at >= NOW() - INTERVAL '60 days'
  AND NOT EXISTS (
      SELECT 1 FROM ml.labeled_probe_readings lpr
      WHERE lpr.url = p.url AND lpr.probed_at = p.probed_at
  )
ORDER BY p.probed_at
"""


def zscore(value, mean, std):
    if std is None or std == 0:
        return 0.0
    return (value - mean) / std


def row_to_metric_text(row: dict) -> str:
    """
    Convert probe row into discretized text tokens for TF-IDF.
    Real observations → structured vocabulary.

    This is not fabrication — it's feature engineering on real data.
    TF-IDF cannot process floats directly; discretization is standard practice.
    """
    parts = []

    # TTFB absolute level
    ttfb = row["ttfb_ms"] or 0
    if ttfb < 200:   parts.append("ttfb_fast")
    elif ttfb < 600: parts.append("ttfb_moderate")
    elif ttfb < 1500:parts.append("ttfb_slow")
    else:            parts.append("ttfb_very_slow")

    # TTFB z-score level
    tz = row["ttfb_zscore"] or 0
    if tz < 1:    parts.append("ttfb_z_normal")
    elif tz < 2:  parts.append("ttfb_z_elevated")
    elif tz < 3:  parts.append("ttfb_z_high")
    else:         parts.append("ttfb_z_critical")

    # DNS absolute
    dns = row["dns_ms"] or 0
    if dns < 30:    parts.append("dns_fast")
    elif dns < 100: parts.append("dns_moderate")
    elif dns < 250: parts.append("dns_slow")
    else:           parts.append("dns_very_slow")

    # DNS z-score
    dz = row["dns_zscore"] or 0
    if dz < 1:   parts.append("dns_z_normal")
    elif dz < 2: parts.append("dns_z_elevated")
    elif dz < 3: parts.append("dns_z_high")
    else:        parts.append("dns_z_critical")

    # Origin time (TTFB - DNS): key discriminator between DNS vs origin issues
    origin = row["origin_time_ms"] or 0
    oz = row["origin_zscore"] or 0
    if oz < 1:   parts.append("origin_z_normal")
    elif oz < 2: parts.append("origin_z_elevated")
    elif oz < 3: parts.append("origin_z_high")
    else:        parts.append("origin_z_critical")

    # TTFB/DNS ratio — if ratio is low, TTFB is explained by DNS (dns issue)
    # If ratio is high, origin explains TTFB (origin issue)
    ratio = ttfb / (dns + 1)
    if ratio < 3:    parts.append("ratio_dns_dominant")
    elif ratio < 8:  parts.append("ratio_balanced")
    else:            parts.append("ratio_origin_dominant")

    # Error rate
    err = row["error_rate"] or 0
    if err < 0.02:   parts.append("errors_clean")
    elif err < 0.10: parts.append("errors_low")
    elif err < 0.30: parts.append("errors_high")
    else:            parts.append("errors_critical")

    # Status code
    code = row.get("status_code") or 200
    if code == 200:         parts.append("status_ok")
    elif 400 <= code < 500: parts.append("status_client_error")
    elif code >= 500:       parts.append("status_server_error")

    # SSL
    ssl = row.get("ssl_days_left") or 365
    if ssl < 7:    parts.append("ssl_critical")
    elif ssl < 14: parts.append("ssl_warning")
    elif ssl < 30: parts.append("ssl_soon")
    else:          parts.append("ssl_ok")

    return " ".join(parts)


def programmatic_label(row: dict) -> tuple[str, float]:
    """
    Apply deterministic rules to real probe data to derive a label.
    Returns (anomaly_type, confidence).

    Rule logic is based on standard network diagnostics:
    - DNS issues: DNS z-score >> origin z-score
    - Origin issues: origin z-score >> DNS z-score
    - Error spikes: elevated error rate
    - SSL: hard threshold
    - Latency spike: overall TTFB z-score high, pattern unclear
    """
    tz  = abs(row["ttfb_zscore"]   or 0)
    dz  = abs(row["dns_zscore"]    or 0)
    oz  = abs(row["origin_zscore"] or 0)
    ez  = row["error_rate"]        or 0
    ssl = row["ssl_days_left"]     or 365

    # SSL warning — hard rule, high confidence
    if ssl < 14:
        return "ssl_expiry_warning", 1.0

    # Error spike — high error rate is unambiguous
    if ez > 0.10:
        return "error_spike", 0.92

    # Below 2 sigma on TTFB — normal
    if tz < 2.0:
        return "normal", 1.0

    # Above 2 sigma — classify the pattern:
    if dz > 2.0 and dz > oz * 1.5:
        # DNS z-score dominates → DNS is the culprit
        return "dns_degradation", min(0.95, 0.7 + dz * 0.05)

    if oz > 2.0 and oz > dz * 1.5:
        # Origin time z-score dominates → server-side slowdown
        return "origin_slowdown", min(0.95, 0.7 + oz * 0.05)

    if tz > 3.0:
        # Both elevated or unclear — general latency spike
        return "latency_spike", 0.75

    return "normal", 1.0


def label_with_statuspage(row: dict, incident_windows: dict) -> tuple[str, float] | None:
    """
    Check if this probe reading falls within a real status page incident window.
    incident_windows: { url: [(started_at, resolved_at, anomaly_type), ...] }
    Returns (anomaly_type, confidence=1.0) if match found, else None.
    """
    windows = incident_windows.get(row["url"], [])
    ts = row["probed_at"]
    if isinstance(ts, str):
        ts = datetime.fromisoformat(ts)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)

    for (start, end, label) in windows:
        if start <= ts <= end:
            return label, 1.0
    return None


# ─────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--min-probe-days", type=int, default=7,
                        help="Minimum days of probe data required for baseline")
    parser.add_argument("--batch-size", type=int, default=5000)
    args = parser.parse_args()

    conn = psycopg2.connect(DB_URL)
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Create labeled table
    cur.execute(CREATE_LABELED_TABLE_SQL)
    conn.commit()

    # ── STEP 1: Compute probe baselines ──────────────────────
    print("Computing per-URL probe baselines from clean data...")
    cur.execute(COMPUTE_PROBE_BASELINES_SQL.format(days=args.min_probe_days * 4))
    baseline_rows = cur.fetchall()
    if not baseline_rows:
        print("[!] No baseline data yet — need at least 7 days of probe data first.")
        print("    Start the website-probe service and wait 7+ days, then re-run.")
        return

    for row in baseline_rows:
        cur.execute(UPDATE_BASELINE_SQL, dict(row))
    conn.commit()
    print(f"✓ Baselines computed for {len(baseline_rows)} URLs")

    # ── STEP 2: Load status page incident windows ────────────
    print("\nLoading status page incident windows...")
    cur.execute("""
        SELECT url, started_at, resolved_at, anomaly_type
        FROM ml.status_incidents
        ORDER BY started_at
    """)
    incident_rows = cur.fetchall()

    incident_windows: dict = {}
    for row in incident_rows:
        url = row["url"]
        if url not in incident_windows:
            incident_windows[url] = []
        incident_windows[url].append((
            row["started_at"], row["resolved_at"], row["anomaly_type"]
        ))

    status_urls = len(incident_windows)
    total_windows = sum(len(v) for v in incident_windows.values())
    print(f"✓ {total_windows} incident windows across {status_urls} URLs")

    # ── STEP 3: Fetch unlabeled probe readings ────────────────
    print("\nFetching unlabeled probe readings...")
    cur.execute(FETCH_UNLABELED_SQL)
    rows = cur.fetchall()
    print(f"✓ {len(rows):,} readings to label")

    if not rows:
        print("[!] No new readings to label.")
        return

    # ── STEP 4: Label each reading ────────────────────────────
    print("Labeling...")
    labeled = []
    counts = {"normal": 0, "statuspage": 0, "programmatic": 0}

    for row in rows:
        row = dict(row)

        # Compute z-scores
        row["ttfb_zscore"]   = zscore(row["ttfb_ms"] or 0, row["ttfb_mean"], row["ttfb_std"])
        row["dns_zscore"]    = zscore(row["dns_ms"] or 0, row["dns_mean"], row["dns_std"])
        row["origin_zscore"] = zscore(row["origin_time_ms"] or 0, row["origin_mean"], row["origin_std"])
        row["error_zscore"]  = zscore(row["error_rate"] or 0, row["err_mean"], row["err_std"])

        # Generate metric text
        row["metric_text"] = row_to_metric_text(row)

        # Label: statuspage wins over programmatic
        sp_result = label_with_statuspage(row, incident_windows)
        if sp_result:
            anomaly_type, confidence = sp_result
            label_source = "statuspage"
            counts["statuspage"] += 1
        else:
            anomaly_type, confidence = programmatic_label(row)
            label_source = "programmatic" if anomaly_type != "normal" else "normal"
            counts["normal" if anomaly_type == "normal" else "programmatic"] += 1

        labeled.append({
            "url":            row["url"],
            "probed_at":      row["probed_at"],
            "ttfb_ms":        row["ttfb_ms"],
            "dns_ms":         row["dns_ms"],
            "origin_time_ms": row["origin_time_ms"],
            "error_rate":     row["error_rate"],
            "status_code":    row.get("status_code"),
            "ssl_days_left":  row.get("ssl_days_left"),
            "ttfb_zscore":    round(row["ttfb_zscore"], 3),
            "dns_zscore":     round(row["dns_zscore"], 3),
            "origin_zscore":  round(row["origin_zscore"], 3),
            "error_zscore":   round(row["error_zscore"], 3),
            "metric_text":    row["metric_text"],
            "anomaly_type":   anomaly_type,
            "is_anomaly":     anomaly_type != "normal",
            "label_source":   label_source,
            "label_confidence": round(confidence, 3),
        })

    # ── STEP 5: Insert in batches ─────────────────────────────
    print(f"Inserting {len(labeled):,} labeled rows...")
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
            %(metric_text)s, %(anomaly_type)s, %(is_anomaly)s, %(label_source)s, %(label_confidence)s
        ) ON CONFLICT DO NOTHING
    """

    for i in range(0, len(labeled), args.batch_size):
        batch = labeled[i:i + args.batch_size]
        psycopg2.extras.execute_batch(cur, insert_sql, batch, page_size=500)
        conn.commit()
        print(f"  {min(i + args.batch_size, len(labeled)):,}/{len(labeled):,}")

    print(f"""
✓ Labeling complete

  Label sources:
    Status page (ground truth): {counts['statuspage']:,}
    Programmatic (weak supervision): {counts['programmatic']:,}
    Normal: {counts['normal']:,}

  Run train_models.py next to train all three models on this data.
""")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
