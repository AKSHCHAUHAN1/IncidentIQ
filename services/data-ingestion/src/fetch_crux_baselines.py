"""
fetch_crux_baselines.py
========================
Fetches REAL per-URL performance baselines from the Google Chrome UX Report (CrUX) API.
CrUX collects field data from real Chrome users visiting real URLs.

Why CrUX?
- Real user measurements, not synthetic pings
- P75 TTFB is the industry standard threshold (Core Web Vitals)
- Gives you a legitimate baseline to define "normal" per URL
- Used by Google PageSpeed, web.dev, and Lighthouse

API Docs: https://developer.chrome.com/docs/crux/api/
Free API Key: https://console.cloud.google.com/ → Enable "Chrome UX Report API"
Without key: 150 requests/day (enough for initial run)
With free key: 150 requests/100 seconds (plenty)

Usage:
    python fetch_crux_baselines.py
    python fetch_crux_baselines.py --api-key YOUR_KEY_HERE
"""

import requests
import json
import time
import argparse
import os
import psycopg2
from datetime import datetime

# ─────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────

CRUX_API_URL = "https://chromeuxreport.googleapis.com/v1/records:queryRecord"

def resolve_targets_file() -> str:
    here = os.path.dirname(__file__)
    candidates = [
        os.path.join(here, "probe-targets.json"),
        "/app/probe-targets.json",
        os.path.join(here, "../../../services/website-probe/probe-targets.json")
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    raise FileNotFoundError("Could not locate probe-targets.json")


TARGETS_FILE = resolve_targets_file()
with open(TARGETS_FILE) as f:
    TARGETS = json.load(f)["targets"]

DB_URL = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/incident_predictor")


# ─────────────────────────────────────────────────────────────
# CRUX FETCHER
# ─────────────────────────────────────────────────────────────

def fetch_crux(url: str, api_key: str | None = None) -> dict | None:
    """
    Query CrUX for a single URL.
    Returns parsed baseline metrics or None if URL not in CrUX dataset.
    """
    params = {}
    if api_key:
        params["key"] = api_key

    payload = {
        "url": url,
        "metrics": [
            "largest_contentful_paint",
            "first_contentful_paint",
            "experimental_time_to_first_byte",
            "interaction_to_next_paint",
            "cumulative_layout_shift",
        ],
        "formFactor": "DESKTOP"
    }

    try:
        resp = requests.post(CRUX_API_URL, params=params, json=payload, timeout=15)

        if resp.status_code == 404:
            print(f"  [SKIP] {url} — not in CrUX dataset (not enough real user data)")
            return None

        if resp.status_code == 429:
            print(f"  [RATE LIMIT] Waiting 60s...")
            time.sleep(60)
            return fetch_crux(url, api_key)

        resp.raise_for_status()
        data = resp.json()

        record = data.get("record", {})
        metrics = record.get("metrics", {})

        def get_p(metric_name, percentile="p75"):
            m = metrics.get(metric_name, {})
            percentiles = m.get("percentiles", {})
            return percentiles.get(percentile)

        # CrUX returns TTFB in milliseconds
        ttfb_p75 = get_p("experimental_time_to_first_byte", "p75")
        lcp_p75  = get_p("largest_contentful_paint", "p75")
        fcp_p75  = get_p("first_contentful_paint", "p75")

        if ttfb_p75 is None:
            print(f"  [SKIP] {url} — TTFB metric unavailable in CrUX")
            return None

        result = {
            "url":        url,
            "ttfb_p75_ms": ttfb_p75,
            "lcp_p75_ms":  lcp_p75,
            "fcp_p75_ms":  fcp_p75,
            # Derived thresholds used by the labeler (3σ rule approximation)
            # CrUX "Good" threshold for TTFB is 800ms (per Core Web Vitals spec)
            # We set anomaly threshold at 2x the P75 as a conservative signal
            "ttfb_anomaly_threshold_ms": ttfb_p75 * 2.5,
            "fetched_at":  datetime.utcnow().isoformat(),
            "source":      "crux_api"
        }

        print(f"  [OK] {url} — TTFB P75: {ttfb_p75}ms | Anomaly threshold: {result['ttfb_anomaly_threshold_ms']:.0f}ms")
        return result

    except requests.RequestException as e:
        print(f"  [ERROR] {url}: {e}")
        return None


# ─────────────────────────────────────────────────────────────
# STORE BASELINES IN TIMESCALEDB
# ─────────────────────────────────────────────────────────────

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS ml.url_baselines (
    url                         TEXT PRIMARY KEY,
    ttfb_p75_ms                 FLOAT,
    lcp_p75_ms                  FLOAT,
    fcp_p75_ms                  FLOAT,
    ttfb_anomaly_threshold_ms   FLOAT,
    -- Populated after warmup period by label_probe_data.py
    probe_ttfb_mean_ms          FLOAT,
    probe_ttfb_std_ms           FLOAT,
    probe_dns_mean_ms           FLOAT,
    probe_dns_std_ms            FLOAT,
    probe_error_rate_mean       FLOAT,
    probe_error_rate_std        FLOAT,
    baseline_computed_at        TIMESTAMPTZ,
    crux_fetched_at             TIMESTAMPTZ,
    source                      TEXT DEFAULT 'crux_api'
);
"""

UPSERT_SQL = """
INSERT INTO ml.url_baselines (
    url, ttfb_p75_ms, lcp_p75_ms, fcp_p75_ms,
    ttfb_anomaly_threshold_ms, crux_fetched_at, source
) VALUES (
    %(url)s, %(ttfb_p75_ms)s, %(lcp_p75_ms)s, %(fcp_p75_ms)s,
    %(ttfb_anomaly_threshold_ms)s, %(fetched_at)s, %(source)s
)
ON CONFLICT (url) DO UPDATE SET
    ttfb_p75_ms                = EXCLUDED.ttfb_p75_ms,
    lcp_p75_ms                 = EXCLUDED.lcp_p75_ms,
    fcp_p75_ms                 = EXCLUDED.fcp_p75_ms,
    ttfb_anomaly_threshold_ms  = EXCLUDED.ttfb_anomaly_threshold_ms,
    crux_fetched_at            = EXCLUDED.crux_fetched_at;
"""

def store_baselines(baselines: list[dict]):
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()
    cur.execute(CREATE_TABLE_SQL)
    for b in baselines:
        cur.execute(UPSERT_SQL, b)
    conn.commit()
    cur.close()
    conn.close()
    print(f"\n✓ Stored {len(baselines)} baselines in ml.url_baselines")


# ─────────────────────────────────────────────────────────────
# ALSO SAVE TO JSON (for use without DB during development)
# ─────────────────────────────────────────────────────────────

def save_json(baselines: list[dict]):
    out_path = os.path.join(os.path.dirname(__file__), "data/crux_baselines.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump({b["url"]: b for b in baselines}, f, indent=2)
    print(f"✓ Also saved to {out_path}")


# ─────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-key", default=None, help="Google CrUX API key (optional)")
    parser.add_argument("--no-db", action="store_true", help="Skip DB, save JSON only")
    args = parser.parse_args()

    print(f"Fetching CrUX baselines for {len(TARGETS)} URLs...\n")

    baselines = []
    for target in TARGETS:
        url = target.get("probe_url")
        if not url:
            continue
        result = fetch_crux(url, args.api_key)
        if result:
            baselines.append(result)
        time.sleep(0.7)  # stay within rate limit even without key

    print(f"\nFetched {len(baselines)}/{len(TARGETS)} baselines")

    save_json(baselines)

    if not args.no_db:
        try:
            store_baselines(baselines)
        except Exception as e:
            print(f"[DB] Could not store to DB: {e}")
            print("[DB] Baselines saved to JSON only — run with --no-db to suppress this")


if __name__ == "__main__":
    main()
