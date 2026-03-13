"""
collector_scheduler.py
=======================
Runs inside the data-collector container.
Schedules fetch_crux_baselines.py and fetch_status_incidents.py
without needing an external cron daemon.

Place at: services/data-ingestion/src/collector_scheduler.py
"""

import time
import subprocess
import sys
import os
from datetime import datetime

CRUX_INTERVAL_HOURS   = int(os.environ.get("CRUX_INTERVAL_HOURS", 24))
STATUS_INTERVAL_HOURS = int(os.environ.get("STATUS_INTERVAL_HOURS", 6))
GOOGLE_API_KEY        = os.environ.get("GOOGLE_API_KEY", "")

CRUX_INTERVAL_SEC   = CRUX_INTERVAL_HOURS   * 3600
STATUS_INTERVAL_SEC = STATUS_INTERVAL_HOURS * 3600

SRC_DIR = os.path.dirname(__file__)

def run(script: str, extra_args: list = []):
    path = os.path.join(SRC_DIR, script)
    cmd  = [sys.executable, path] + extra_args
    print(f"\n[{datetime.utcnow().isoformat()}] Running {script}...")
    result = subprocess.run(cmd, capture_output=False)
    if result.returncode != 0:
        print(f"[WARN] {script} exited with code {result.returncode}")
    else:
        print(f"[OK] {script} complete")


def main():
    print("Data Collector Scheduler starting...")
    print(f"  CrUX fetch every    {CRUX_INTERVAL_HOURS}h")
    print(f"  Status fetch every  {STATUS_INTERVAL_HOURS}h")

    last_crux   = 0
    last_status = 0

    # Run both immediately on startup
    crux_args = ["--no-db"] if not os.environ.get("DATABASE_URL") else []
    if GOOGLE_API_KEY:
        crux_args += ["--api-key", GOOGLE_API_KEY]

    run("fetch_crux_baselines.py", crux_args)
    last_crux = time.time()

    run("fetch_status_incidents.py", ["--days", "90"])
    last_status = time.time()

    while True:
        time.sleep(60)  # check every minute
        now = time.time()

        if now - last_crux >= CRUX_INTERVAL_SEC:
            run("fetch_crux_baselines.py", crux_args)
            last_crux = time.time()

        if now - last_status >= STATUS_INTERVAL_SEC:
            run("fetch_status_incidents.py", ["--days", "7"])
            last_status = time.time()


if __name__ == "__main__":
    main()
