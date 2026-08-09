"""
Live ADO query helper for the @flowmetrics chat participant.

Usage (run from the board output directory where output/data/ exists):
  python query_ado.py work-items
  python query_ado.py item-history --id <work_item_id>

Environment:
  ADO_PAT  — Azure DevOps personal access token

Writes compact JSON to stdout. Errors are JSON on stdout with an "error" key.
"""

import argparse
import json
import os
import sys
from pathlib import Path

DATA_DIR = Path("output/data")


def _load(p: Path):
    if not p.exists():
        print(json.dumps({"error": f"{p} not found — run the pipeline first"}))
        sys.exit(1)
    return json.loads(p.read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser(description="Live ADO query for @flowmetrics chat")
    sub = parser.add_subparsers(dest="query", required=True)

    sub.add_parser("work-items", help="Fetch current work items (caps at 200)")

    hist_p = sub.add_parser("item-history", help="Fetch column/state history for one item")
    hist_p.add_argument("--id", type=int, required=True, help="Work item ID")

    args = parser.parse_args()

    pat = os.environ.get("ADO_PAT")
    if not pat:
        print(json.dumps({"error": "ADO_PAT environment variable not set"}))
        sys.exit(1)

    ctx = _load(DATA_DIR / "context.json")
    org = ctx["org"]
    project = ctx["project"]
    team = ctx["team"]

    from util_ado import (
        fetch_work_item_history,
        fetch_work_item_ids,
        fetch_work_items,
        get_team_area_paths,
        make_auth_header,
    )

    headers = make_auth_header(pat)

    if args.query == "work-items":
        work_item_types = ctx.get("work_item_types", ["Bug", "Product Backlog Item"])
        area_paths = get_team_area_paths(org, project, team, headers)
        ids = fetch_work_item_ids(org, project, team, work_item_types, headers, area_paths=area_paths)
        items = fetch_work_items(org, project, ids[:200], headers)
        print(json.dumps(items, ensure_ascii=False))

    elif args.query == "item-history":
        column_names = [c["name"] for c in ctx.get("columns", [])]
        split_cols = {c["name"] for c in ctx.get("columns", []) if c.get("is_split")}
        history = fetch_work_item_history(
            org, project, args.id, column_names, headers, split_columns=split_cols
        )
        print(json.dumps(history, ensure_ascii=False))


if __name__ == "__main__":
    main()
