"""
fetch_status_incidents.py
==========================
Fetches REAL incident history from public Atlassian Statuspage APIs.

These are the same status pages companies use to communicate outages to their
customers. They expose a public JSON API with full incident timelines —
no authentication required.

What this gives you:
- Real incident timestamps (created_at, resolved_at)
- Real incident impact levels (none, minor, major, critical)
- Real incident names/descriptions (e.g. "Elevated API error rates", "DNS resolution delays")
- This data is cross-referenced with your probe readings to produce REAL labels

Academic note: This is the same methodology used in production AIOps systems —
correlating external monitoring with vendor-reported incidents to build ground truth.

Usage:
    python fetch_status_incidents.py
    python fetch_status_incidents.py --days 90   # fetch last 90 days
"""

import requests
import json
import time
import argparse
import os
import re
import psycopg2
from datetime import datetime, timezone, timedelta

# ─────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────

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
# INCIDENT TYPE CLASSIFIER
# Maps real incident titles → our anomaly labels
# These keyword rules cover the vast majority of real incidents
# ─────────────────────────────────────────────────────────────

INCIDENT_TYPE_RULES = [
    # DNS-related
    (r"dns|domain|resolv|nameserver", "dns_degradation"),
    # SSL/TLS
    (r"ssl|tls|cert|https|certificate", "ssl_expiry_warning"),
    # Error rates
    (r"error rate|5xx|500|503|502|504|gateway|errors elevated|api errors", "error_spike"),
    # Latency / slowness
    (r"latenc|slow|degraded|response time|ttfb|performance|timeout|high latency", "origin_slowdown"),
    # General degradation / partial outage
    (r"partial outage|degraded performance|elevated|intermittent|degradation", "latency_spike"),
    # Full outage — maps to origin_slowdown since we measure via TTFB
    (r"outage|down|unavailable|disruption", "origin_slowdown"),
]

def classify_incident(title: str, body: str = "") -> str:
    """Classify a real incident into our anomaly label taxonomy."""
    text = (title + " " + body).lower()
    for pattern, label in INCIDENT_TYPE_RULES:
        if re.search(pattern, text):
            return label
    return "origin_slowdown"  # default: unknown incidents treated as generic slowdown


# ─────────────────────────────────────────────────────────────
# STATUSPAGE API FETCHER
# ─────────────────────────────────────────────────────────────

def fetch_incidents(target: dict, days_back: int = 90) -> list[dict]:
    """
    Fetch all resolved incidents from a public Statuspage API.
    Returns list of incident windows with start/end times and our label.
    """
    url = target.get("status_page_api")
    name = target.get("name", target.get("probe_url", "unknown-service"))
    probe_url = target.get("probe_url")

    if not url:
        print(f"  [SKIP] {name}: status_page_api missing in target definition")
        return []

    try:
        resp = requests.get(url, timeout=15, headers={"User-Agent": "IncidentIQ-Research/1.0"})
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        print(f"  [ERROR] {name}: {e}")
        return []

    incidents = data.get("incidents", [])
    cutoff = datetime.now(timezone.utc) - timedelta(days=days_back)

    results = []
    for inc in incidents:
        # Only process resolved incidents (they have a real end time)
        if inc.get("status") != "resolved":
            continue

        # Parse timestamps
        created_raw = inc.get("created_at") or inc.get("started_at")
        resolved_raw = inc.get("resolved_at")
        if not created_raw or not resolved_raw:
            continue

        created_at  = datetime.fromisoformat(created_raw.replace("Z", "+00:00"))
        resolved_at = datetime.fromisoformat(resolved_raw.replace("Z", "+00:00"))

        if created_at < cutoff:
            continue  # too old

        # Get impact
        impact = inc.get("impact", "minor")  # none, minor, major, critical

        # Classify
        title = inc.get("name", "")
        body  = " ".join(
            update.get("body", "")
            for update in inc.get("incident_updates", [])
        )
        anomaly_type = classify_incident(title, body)

        results.append({
            "url":           probe_url,
            "service_name":  name,
            "incident_id":   inc.get("id"),
            "title":         title,
            "impact":        impact,
            "anomaly_type":  anomaly_type,
            "started_at":    created_at.isoformat(),
            "resolved_at":   resolved_at.isoformat(),
            "duration_min":  round((resolved_at - created_at).total_seconds() / 60, 1),
            "source":        "statuspage_api"
        })

    if results:
        print(f"  [OK] {name}: {len(results)} incidents in last {days_back} days")
        for r in results[:3]:  # show first 3 as sample
            print(f"       • [{r['anomaly_type']}] {r['title'][:60]} ({r['duration_min']:.0f} min)")
    else:
        print(f"  [OK] {name}: no resolved incidents in last {days_back} days")

    return results


# ─────────────────────────────────────────────────────────────
# STORE IN TIMESCALEDB
# ─────────────────────────────────────────────────────────────

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS ml.status_incidents (
    incident_id     TEXT,
    url             TEXT NOT NULL,
    service_name    TEXT,
    title           TEXT,
    impact          TEXT,
    anomaly_type    TEXT NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL,
    resolved_at     TIMESTAMPTZ NOT NULL,
    duration_min    FLOAT,
    source          TEXT DEFAULT 'statuspage_api',
    fetched_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (incident_id, url)
);
"""

UPSERT_SQL = """
INSERT INTO ml.status_incidents (
    incident_id, url, service_name, title, impact,
    anomaly_type, started_at, resolved_at, duration_min, source
) VALUES (
    %(incident_id)s, %(url)s, %(service_name)s, %(title)s, %(impact)s,
    %(anomaly_type)s, %(started_at)s, %(resolved_at)s, %(duration_min)s, %(source)s
)
ON CONFLICT (incident_id, url) DO UPDATE SET
    anomaly_type = EXCLUDED.anomaly_type,
    fetched_at   = NOW();
"""

def store_incidents(all_incidents: list[dict]):
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()
    cur.execute(CREATE_TABLE_SQL)
    for inc in all_incidents:
        cur.execute(UPSERT_SQL, inc)
    conn.commit()
    cur.close()
    conn.close()
    print(f"\n✓ Stored {len(all_incidents)} incidents in ml.status_incidents")


def save_json(all_incidents: list[dict]):
    out_path = os.path.join(os.path.dirname(__file__), "data/status_incidents.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(all_incidents, f, indent=2, default=str)
    print(f"✓ Also saved to {out_path}")


# ─────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=90, help="Fetch incidents from last N days")
    parser.add_argument("--no-db", action="store_true", help="Skip DB, save JSON only")
    args = parser.parse_args()

    print(f"Fetching real incident history (last {args.days} days) from {len(TARGETS)} status pages...\n")

    all_incidents = []
    for target in TARGETS:
        incidents = fetch_incidents(target, args.days)
        all_incidents.extend(incidents)
        time.sleep(0.5)  # polite rate limiting

    print(f"\nTotal real incidents collected: {len(all_incidents)}")

    # Summary by type
    from collections import Counter
    type_counts = Counter(i["anomaly_type"] for i in all_incidents)
    print("Label distribution:")
    for label, count in type_counts.most_common():
        print(f"  {label}: {count}")

    save_json(all_incidents)

    if not args.no_db:
        try:
            store_incidents(all_incidents)
        except Exception as e:
            print(f"[DB] Could not store to DB: {e}")
            print("[DB] Data saved to JSON only")


if __name__ == "__main__":
    main()
