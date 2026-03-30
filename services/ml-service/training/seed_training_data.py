"""
seed_training_data.py
=====================
Runs label_probe_data.py to generate labels from real probe data.
Does NOT insert any synthetic data.
Call this when you have some probe data but it's below the normal minimum threshold.
"""
import subprocess
import sys
import os

print("Running label_probe_data.py to generate real labels from probe readings...")

result = subprocess.run(
    [sys.executable,
     os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "label_probe_data.py")],
    capture_output=False
)

sys.exit(result.returncode)
