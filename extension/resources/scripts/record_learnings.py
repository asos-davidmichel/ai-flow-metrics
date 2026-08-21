"""
Append, list, or remove interpretation learnings in a JSON log file.

Usage
-----
  python src/record_learnings.py --text "TEXT" --log PATH [--board BOARD_NAME]
  python src/record_learnings.py --list --log PATH
  python src/record_learnings.py --remove INDEX --log PATH
"""
import argparse
import json
from datetime import date
from pathlib import Path


def _load(log_path: Path) -> list:
    if not log_path.exists():
        return []
    try:
        data = json.loads(log_path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Manage interpretation learnings in a JSON log file."
    )
    parser.add_argument("--text", help="The learning text to save")
    parser.add_argument("--log", required=True, help="Path to the learnings JSON file")
    parser.add_argument("--board", default="", help="Board name (informational)")
    parser.add_argument("--list", action="store_true", help="List all learnings as JSON")
    parser.add_argument("--remove", type=int, metavar="INDEX", help="Remove learning at 0-based index")
    args = parser.parse_args()

    log_path = Path(args.log)

    if args.list:
        print(json.dumps(_load(log_path), indent=2, ensure_ascii=False))
        return

    if args.remove is not None:
        existing = _load(log_path)
        if args.remove < 0 or args.remove >= len(existing):
            print(json.dumps({"error": f"Index {args.remove} out of range (0–{len(existing)-1})"}))
            return
        removed = existing.pop(args.remove)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(json.dumps(existing, indent=2, ensure_ascii=False), encoding="utf-8")
        print(json.dumps({"removed": removed, "total": len(existing)}))
        return

    if not args.text:
        parser.error("--text is required when not using --list or --remove")

    log_path.parent.mkdir(parents=True, exist_ok=True)
    existing = _load(log_path)

    entry: dict = {"date": str(date.today()), "text": args.text.strip()}
    if args.board:
        entry["board"] = args.board

    existing.append(entry)
    log_path.write_text(json.dumps(existing, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"saved": True, "entry": entry, "total": len(existing)}))


if __name__ == "__main__":
    main()
