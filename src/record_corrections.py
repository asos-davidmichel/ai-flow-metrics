"""
Diffs config.ai_draft.json against config.json, extracts corrections, and
appends them (with deduplication by normalised column keyword) to a global
corrections_log.json.

Usage:
  python src/record_corrections.py --draft PATH --final PATH --log PATH [--dry-run]
"""

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path


# ---------------------------------------------------------------------------
# Diff helpers
# ---------------------------------------------------------------------------

def _normalize(name: str) -> str:
    """Strip emojis / punctuation, lowercase, collapse whitespace."""
    cleaned = re.sub(r"[^\w\s-]", "", name, flags=re.UNICODE).strip().lower()
    return re.sub(r"\s+", " ", cleaned)


def _diff_flow_efficiency(draft_fe: dict, final_fe: dict) -> list:
    draft_active  = set(draft_fe.get("active_columns",  []))
    draft_waiting = set(draft_fe.get("waiting_columns", []))
    final_active  = set(final_fe.get("active_columns",  []))
    final_waiting = set(final_fe.get("waiting_columns", []))
    corrections = []
    for col in draft_active - final_active:
        if col in final_waiting:
            corrections.append({"section": "flow_efficiency", "column": col, "ai_said": "active",  "corrected_to": "waiting"})
    for col in draft_waiting - final_waiting:
        if col in final_active:
            corrections.append({"section": "flow_efficiency", "column": col, "ai_said": "waiting", "corrected_to": "active"})
    return corrections


def _diff_clock(section: str, draft_s: dict, final_s: dict) -> list:
    return [
        {"section": section, "field": f, "ai_said": draft_s.get(f), "corrected_to": final_s.get(f)}
        for f in ("clock_start", "clock_end")
        if draft_s.get(f) != final_s.get(f)
    ]


def _diff_mapping(section: str, draft_map: dict, final_map: dict) -> list:
    corrections = []
    for key, final_val in final_map.items():
        if draft_map.get(key) != final_val:
            corrections.append({"section": section, "key": key, "ai_said": draft_map.get(key), "corrected_to": final_val})
    for key in draft_map:
        if key not in final_map:
            corrections.append({"section": section, "key": key, "ai_said": draft_map[key], "corrected_to": None})
    return corrections


def compute_diff(draft: dict, final: dict) -> list:
    corrections = []
    if "flow_efficiency" in draft and "flow_efficiency" in final:
        corrections.extend(_diff_flow_efficiency(draft["flow_efficiency"], final["flow_efficiency"]))
    for timing in ("lead_time", "cycle_time"):
        if timing in draft and timing in final:
            corrections.extend(_diff_clock(timing, draft[timing], final[timing]))
    if "historical_column_mapping" in draft and "historical_column_mapping" in final:
        corrections.extend(_diff_mapping("historical_column_mapping",
                                         draft["historical_column_mapping"],
                                         final["historical_column_mapping"]))
    if "swimlane_mapping" in draft and "swimlane_mapping" in final:
        corrections.extend(_diff_mapping("swimlane_mapping",
                                         draft["swimlane_mapping"],
                                         final["swimlane_mapping"]))
    # Blocked signals — compare as sorted JSON strings to ignore key ordering
    draft_sigs = sorted(json.dumps(s, sort_keys=True) for s in draft.get("blocked_time", {}).get("signals", []))
    final_sigs = sorted(json.dumps(s, sort_keys=True) for s in final.get("blocked_time", {}).get("signals", []))
    if draft_sigs != final_sigs:
        corrections.append({
            "section":      "blocked_time",
            "ai_said":      draft.get("blocked_time", {}).get("signals", []),
            "corrected_to": final.get("blocked_time", {}).get("signals", []),
        })
    return corrections


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------

def _dedup_key(c: dict) -> str:
    s = c["section"]
    if s == "flow_efficiency":
        return f"flow_efficiency|{_normalize(c['column'])}|{c['ai_said']}|{c['corrected_to']}"
    if s in ("lead_time", "cycle_time"):
        return f"{s}|{c['field']}|{json.dumps(c['ai_said'], sort_keys=True)}|{json.dumps(c['corrected_to'], sort_keys=True)}"
    if s in ("historical_column_mapping", "swimlane_mapping"):
        return f"{s}|{c['key']}|{json.dumps(c['corrected_to'], sort_keys=True)}"
    if s == "blocked_time":
        return f"blocked_time|{json.dumps(c['corrected_to'], sort_keys=True)}"
    return json.dumps(c, sort_keys=True)


def merge_into_log(log: dict, corrections: list, today: str) -> dict:
    existing = {e["_key"]: e for e in log.get("corrections", []) if "_key" in e}
    for c in corrections:
        key = _dedup_key(c)
        if key in existing:
            existing[key]["count"] += 1
            existing[key]["last_seen"] = today
            if c["section"] == "flow_efficiency":
                examples = existing[key].setdefault("example_columns", [])
                if c["column"] not in examples:
                    examples.append(c["column"])
        else:
            entry = {**c, "_key": key, "count": 1, "last_seen": today}
            if c["section"] == "flow_efficiency":
                entry["name_keyword"] = _normalize(c["column"])
                entry["example_columns"] = [c["column"]]
            existing[key] = entry
    log["corrections"] = list(existing.values())
    return log


# ---------------------------------------------------------------------------
# Summary formatting (returned to the LLM for conversational display)
# ---------------------------------------------------------------------------

def format_summary(corrections: list) -> str:
    if not corrections:
        return "No differences found between draft and final config."
    lines = [f"Found {len(corrections)} change(s):"]
    for c in corrections:
        s = c["section"]
        if s == "flow_efficiency":
            lines.append(f"  * '{c['column']}': {c['ai_said']} -> {c['corrected_to']}")
        elif s in ("lead_time", "cycle_time"):
            lines.append(f"  * {s}.{c['field']}: {json.dumps(c['ai_said'])} -> {json.dumps(c['corrected_to'])}")
        elif s in ("historical_column_mapping", "swimlane_mapping"):
            lines.append(f"  * {s}['{c['key']}']: {c['ai_said']} -> {c['corrected_to']}")
        elif s == "blocked_time":
            lines.append(f"  * blocked_time.signals: updated")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Record config corrections to the learning log.")
    parser.add_argument("--draft",   required=True, metavar="PATH", help="Path to config.ai_draft.json")
    parser.add_argument("--final",   required=True, metavar="PATH", help="Path to config.json (final approved)")
    parser.add_argument("--log",     required=True, metavar="PATH", help="Path to corrections_log.json")
    parser.add_argument("--dry-run", action="store_true",           help="Print diff as JSON without writing")
    args = parser.parse_args()

    draft_path = Path(args.draft)
    final_path = Path(args.final)
    log_path   = Path(args.log)

    if not draft_path.exists():
        print(json.dumps({"error": f"Draft not found: {draft_path}"}))
        sys.exit(1)
    if not final_path.exists():
        print(json.dumps({"error": f"Final config not found: {final_path}"}))
        sys.exit(1)

    draft = json.loads(draft_path.read_text(encoding="utf-8"))
    final = json.loads(final_path.read_text(encoding="utf-8"))
    corrections = compute_diff(draft, final)
    summary = format_summary(corrections)

    if args.dry_run:
        print(json.dumps({"changes": corrections, "summary": summary}, ensure_ascii=False))
        return

    log = json.loads(log_path.read_text(encoding="utf-8")) if log_path.exists() else {"corrections": []}
    log = merge_into_log(log, corrections, str(date.today()))
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(json.dumps(log, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"recorded": len(corrections), "summary": summary}, ensure_ascii=False))


if __name__ == "__main__":
    main()
