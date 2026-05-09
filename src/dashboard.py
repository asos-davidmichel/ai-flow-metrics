"""
Dashboard generator — slice 1: time in columns.

Reads:  output/metrics/time_in_columns.json
        src/templates/time_in_columns.html
Writes: output/dashboard.html

Usage:
  python src/dashboard.py
"""

import json
import sys
from pathlib import Path

METRICS_PATH = Path("output/metrics/time_in_columns.json")
TEMPLATE_PATH = Path("src/templates/time_in_columns.html")
OUTPUT_PATH = Path("output/dashboard.html")


def main():
    for path in (METRICS_PATH, TEMPLATE_PATH):
        if not path.exists():
            print(f"Error: {path} not found.", file=sys.stderr)
            sys.exit(1)

    metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    html = template.replace("/*DATA_PLACEHOLDER*/", json.dumps(metrics))

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(html, encoding="utf-8")
    print(f"Written: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
