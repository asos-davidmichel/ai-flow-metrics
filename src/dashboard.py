"""
Dashboard generator.

Reads:  output/metrics/time_in_columns.json
        output/metrics/cycle_time.json        (optional — skipped if not present)
        src/templates/time_in_columns.html
Writes: output/dashboard.html

Usage:
  python src/dashboard.py
"""

import json
import sys
from pathlib import Path

TIC_PATH = Path("output/metrics/time_in_columns.json")
CT_PATH = Path("output/metrics/cycle_time.json")
TEMPLATE_PATH = Path("src/templates/time_in_columns.html")
OUTPUT_PATH = Path("output/dashboard.html")


def main():
    for path in (TIC_PATH, TEMPLATE_PATH):
        if not path.exists():
            print(f"Error: {path} not found.", file=sys.stderr)
            sys.exit(1)

    dashboard = {
        "time_in_columns": json.loads(TIC_PATH.read_text(encoding="utf-8")),
        "cycle_time": json.loads(CT_PATH.read_text(encoding="utf-8")) if CT_PATH.exists() else None,
    }

    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    html = template.replace("/*DASHBOARD_DATA_PLACEHOLDER*/", json.dumps(dashboard))

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(html, encoding="utf-8")
    print(f"Written: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
