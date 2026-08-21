"""
Append an interpretation learning / preference to a JSON log file.

Usage
-----
  python src/record_learnings.py --text "TEXT" --log PATH [--board BOARD_NAME]
"""
import argparse
import json
from datetime import date
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Append an interpretation learning to a JSON log file."
    )
    parser.add_argument("--text", required=True, help="The learning text to save")
    parser.add_argument("--log", required=True, help="Path to the learnings JSON file")
    parser.add_argument("--board", default="", help="Board name (informational)")
    args = parser.parse_args()

    log_path = Path(args.log)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    existing: list = []
    if log_path.exists():
        try:
            data = json.loads(log_path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                existing = data
        except Exception:
            existing = []

    entry: dict = {
        "date": str(date.today()),
        "text": args.text.strip(),
    }
    if args.board:
        entry["board"] = args.board

    existing.append(entry)
    log_path.write_text(
        json.dumps(existing, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps({"saved": True, "entry": entry, "total": len(existing)}))


if __name__ == "__main__":
    main()
