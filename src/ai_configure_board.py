"""
AI interpretation pass 1 — proposes config.json from board structure and history.

Analyses:
  - Unknown historical column names (vs current board)
  - Blocked time signals (swimlane names, card rules, column names)
  - Dwell time statistics per column (to assist flow efficiency classification)
  - Deterministic flow efficiency rules (incoming/outgoing always waiting)

Reads:
  output/data/context.json
  output/data/work_item_history.json
  output/data/data_quality_report.json

Writes:
  output/data/ai_configure_board.prompt.md  open in VS Code chat or paste into any AI

After running: the agent saves output/data/config.json automatically.
The metrics scripts require config.json.

Usage:
  python src/ai_configure_board.py
"""

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

DATA_DIR = Path("output/data")
PROMPTS_DIR = Path(__file__).parent / "prompts"

CONTEXT_PATH = DATA_DIR / "context.json"
HISTORY_PATH = DATA_DIR / "work_item_history.json"
QUALITY_PATH = DATA_DIR / "data_quality_report.json"
WORK_ITEMS_PATH = DATA_DIR / "work_items.json"
CONFIG_PATH = DATA_DIR / "config.json"
PROMPT_TEMPLATE_PATH = PROMPTS_DIR / "ai_configure_board.prompt.md"
PROMPT_MD_PATH = DATA_DIR / "ai_configure_board.prompt.md"

VIRTUAL_COLUMNS = {"Backlog"}
BLOCKED_KEYWORDS = ("block", "impede", "impediment", "on hold", "hold", "waiting")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def load(path):
    p = Path(path)
    if not p.exists():
        print(f"Error: required file not found: {path}", file=sys.stderr)
        sys.exit(1)
    return json.loads(p.read_text(encoding="utf-8"))


def _parse_dt(s):
    if not s:
        return None
    s = s.rstrip("Z")
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _dwell_stats(minutes_list):
    """Return avg and median hours from a list of minute durations."""
    if not minutes_list:
        return None
    sd = sorted(minutes_list)
    avg = sum(sd) / len(sd)
    med = sd[len(sd) // 2]
    return {
        "n": len(sd),
        "avg_hours": round(avg / 60, 1),
        "median_hours": round(med / 60, 1),
    }


def _has_blocked_keyword(text):
    t = text.lower()
    return any(kw in t for kw in BLOCKED_KEYWORDS)


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------


def analyse(context, history, work_items=None):
    known_cols = {c["name"] for c in context["columns"]}

    # 1. Unknown historical columns
    unknown_hist_cols = set()
    for h in history:
        for span in h.get("column_history", []):
            v = span.get("value")
            if v and v not in known_cols and v not in VIRTUAL_COLUMNS:
                unknown_hist_cols.add(v)

    # 2. Dwell stats per column
    col_dwells = defaultdict(list)
    for h in history:
        for span in h.get("column_history", []):
            if not span.get("left"):
                continue
            e = _parse_dt(span.get("entered"))
            left = _parse_dt(span.get("left"))
            v = span.get("value")
            if e and left and v and v not in VIRTUAL_COLUMNS:
                mins = (left - e).total_seconds() / 60
                if mins > 0:
                    col_dwells[v].append(mins)

    # 3. Columns enriched with type and dwell
    columns_info = []
    for col in context["columns"]:
        columns_info.append({
            "name": col["name"],
            "column_type": col["column_type"],
            "wip_limit": col["wip_limit"],
            "is_split": col.get("is_split", False),
            "dwell": _dwell_stats(col_dwells.get(col["name"], [])),
        })

    # 4. Blocked signals (ordered by reliability)
    blocked_signals = []
    card_rules = context.get("card_rules", {})

    for sw in context.get("swimlanes", []):
        name = sw.get("name", "")
        if _has_blocked_keyword(name):
            blocked_signals.append({"mechanism": "swimlane_name", "value": name})

    for rule in card_rules.get("swimlane_rules", []):
        if _has_blocked_keyword(rule.get("filter", "")):
            blocked_signals.append({
                "mechanism": "swimlane_rule",
                "name": rule["name"],
                "filter": rule.get("filter", ""),
            })

    for rule in card_rules.get("fill", []):
        if _has_blocked_keyword(rule.get("filter", "")):
            blocked_signals.append({
                "mechanism": "fill_rule",
                "name": rule["name"],
                "filter": rule.get("filter", ""),
                "background_color": rule.get("background_color"),
            })

    for col in context["columns"]:
        if _has_blocked_keyword(col["name"]):
            blocked_signals.append({"mechanism": "column_name", "value": col["name"]})

    # 4b. Tags actually observed in work items that imply blocking
    blocked_tags_in_use = []
    if work_items:
        seen: set = set()
        for item in work_items:
            for tag in (item.get("tags") or []):
                if tag.lower() not in seen and _has_blocked_keyword(tag):
                    seen.add(tag.lower())
                    blocked_tags_in_use.append(tag)
        blocked_tags_in_use.sort(key=str.lower)

    # 5. Flow efficiency: deterministic vs needs classification
    waiting_deterministic = [
        c["name"] for c in context["columns"]
        if c["column_type"] in ("incoming", "outgoing")
    ]
    # "(Done)" sub-columns of split columns are always waiting: items sit there as a
    # completed queue waiting for the next stage to pull them, not being actively worked.
    waiting_deterministic += [
        c["name"] for c in context["columns"]
        if c.get("is_split") and c["name"].endswith(" (Done)")
    ]
    needs_classification = [
        c for c in columns_info
        if c["column_type"] == "inProgress"
        and not (c.get("is_split") and c["name"].endswith(" (Done)"))
    ]

    # 6. Unknown historical swimlanes
    known_lanes = {s["name"] for s in context.get("swimlanes", [])}
    unknown_hist_swimlanes = set()
    if work_items:
        for item in work_items:
            lane = item.get("swimlane")
            if lane and lane not in known_lanes:
                unknown_hist_swimlanes.add(lane)

    return {
        "board": {
            "org": context["org"],
            "project": context["project"],
            "team": context["team"],
            "board_name": context["board"]["name"],
        },
        "columns": columns_info,
        "unknown_historical_columns": sorted(unknown_hist_cols),
        "blocked_signals": blocked_signals,
        "blocked_tags_in_use": blocked_tags_in_use,
        "flow_efficiency": {
            "waiting_deterministic": waiting_deterministic,
            "needs_classification": needs_classification,
        },
        "unknown_historical_swimlanes": sorted(unknown_hist_swimlanes),
        "current_swimlanes": [s["name"] for s in context.get("swimlanes", [])],
    }


# ---------------------------------------------------------------------------
# Prompt building
# ---------------------------------------------------------------------------


def _findings_as_text(findings):
    lines = []

    board = findings["board"]
    lines.append(f"## Board: {board['board_name']}")
    lines.append(f"Org: {board['org']} | Project: {board['project']} | Team: {board['team']}")
    lines.append("")

    lines.append("## Columns")
    lines.append("| Name | Type | WIP limit | Split | Dwell (n, avg, median) |")
    lines.append("|------|------|-----------|-------|------------------------|")
    for col in findings["columns"]:
        d = col["dwell"]
        dwell = f"n={d['n']}, avg={d['avg_hours']}h, median={d['median_hours']}h" if d else "no data"
        split_flag = "Doing" if (col.get("is_split") and col["name"].endswith(" (Doing)")) else \
                     "Done"  if (col.get("is_split") and col["name"].endswith(" (Done)"))  else "-"
        lines.append(f"| {col['name']} | {col['column_type']} | {col['wip_limit']} | {split_flag} | {dwell} |")
    lines.append("")
    has_split = any(col.get("is_split") for col in findings["columns"])
    if has_split:
        lines.append("_Note: columns marked Doing/Done are sub-columns of split board columns._")
        lines.append("")

    lines.append("## Unknown historical columns (no longer on current board)")
    if findings["unknown_historical_columns"]:
        for col in findings["unknown_historical_columns"]:
            lines.append(f"- {col}")
    else:
        lines.append("None.")
    lines.append("")

    lines.append("## Blocked signals detected (from card rules / swimlanes / columns)")
    if findings["blocked_signals"]:
        for sig in findings["blocked_signals"]:
            lines.append(f"- {json.dumps(sig)}")
    else:
        lines.append("None found.")
    lines.append("")

    lines.append("## Tags actually in use in work items that imply blocking")
    if findings.get("blocked_tags_in_use"):
        for tag in findings["blocked_tags_in_use"]:
            lines.append(f"- {tag}")
    else:
        lines.append("None found.")
    lines.append("")

    fe = findings["flow_efficiency"]
    lines.append("## Flow efficiency")
    lines.append(f"Always waiting (deterministic): {', '.join(fe['waiting_deterministic'])}")
    lines.append("")
    lines.append("inProgress columns to classify (active or waiting):")
    for col in fe["needs_classification"]:
        d = col["dwell"]
        dwell = f"avg={d['avg_hours']}h, median={d['median_hours']}h" if d else "no dwell data"
        lines.append(f"- {col['name']} ({dwell})")
    lines.append("")

    lines.append("## Swimlanes (current board)")
    if findings.get("current_swimlanes"):
        for sl in findings["current_swimlanes"]:
            lines.append(f"- {sl}")
    else:
        lines.append("None.")
    lines.append("")

    lines.append("## Unknown historical swimlanes (not on current board)")
    if findings.get("unknown_historical_swimlanes"):
        for sl in findings["unknown_historical_swimlanes"]:
            lines.append(f"- {sl}")
    else:
        lines.append("None.")
    lines.append("")

    return "\n".join(lines)


def _format_corrections_block(log_path) -> str:
    """Return a markdown section of learned corrections, or empty string if none."""
    if not log_path or not Path(log_path).exists():
        return ""
    try:
        log = json.loads(Path(log_path).read_text(encoding="utf-8"))
    except Exception:
        return ""
    corrections = log.get("corrections", [])
    if not corrections:
        return ""

    lines = [
        "## Corrections learned from past configurations",
        "",
        "Users confirmed these corrections on previous boards. Apply them when you see similar patterns.",
        "",
    ]

    fe = [c for c in corrections if c.get("section") == "flow_efficiency"]
    if fe:
        lines += [
            "### Flow efficiency reclassifications",
            "| Column keyword | AI classified as | Correct classification | Confirmed on |",
            "|---|---|---|---|",
        ]
        for c in sorted(fe, key=lambda x: x.get("count", 1), reverse=True):
            examples = ", ".join(f'"{e}"' for e in c.get("example_columns", [c.get("column", "")])[:2])
            lines.append(
                f"| {c.get('name_keyword', '')} | {c['ai_said']} "
                f"| **{c['corrected_to']}** "
                f"| {c.get('count', 1)} board(s) — e.g. {examples} |"
            )
        lines.append("")

    clock = [c for c in corrections if c.get("section") in ("lead_time", "cycle_time")]
    if clock:
        lines.append("### Clock boundary adjustments")
        for c in clock:
            lines.append(
                f"- {c['section']}.{c['field']}: was `{json.dumps(c['ai_said'])}` "
                f"→ corrected to `{json.dumps(c['corrected_to'])}` ({c.get('count', 1)} time(s))"
            )
        lines.append("")

    hcm = [c for c in corrections if c.get("section") == "historical_column_mapping"]
    if hcm:
        lines.append("### Historical column mapping corrections")
        for c in hcm:
            lines.append(f"- `{c['key']}` → `{c['corrected_to']}` ({c.get('count', 1)} time(s))")
        lines.append("")

    lines += ["---", ""]
    return "\n".join(lines)


def _compact_quality_report(quality):
    """Keep only data-quality summaries relevant to board configuration."""
    checks = quality.get("checks", {})
    compact = {"generated_at": quality.get("generated_at"), "total_items": quality.get("total_items")}
    compact_checks = {}
    for name, check in checks.items():
        summary = {"count": check.get("count", 0)}
        for key in ("threshold_minutes", "unknown_columns", "note"):
            if key in check:
                value = check[key]
                if key == "unknown_columns":
                    value = [entry.get("column") for entry in value]
                summary[key] = value
        compact_checks[name] = summary
    compact["checks"] = compact_checks
    return compact


def build_prompt(findings, corrections_block: str = ""):
    """Build prompt content with inline context data (works in VS Code and when pasted elsewhere)."""
    template = PROMPT_TEMPLATE_PATH.read_text(encoding="utf-8")

    context_block = ""
    if CONTEXT_PATH.exists():
        context_block = (
            "## Board structure and card rules (context.json)\n\n"
            + CONTEXT_PATH.read_text(encoding="utf-8")
            + "\n\n"
        )

    quality_block = ""
    if QUALITY_PATH.exists():
        quality = json.loads(QUALITY_PATH.read_text(encoding="utf-8"))
        quality_block = (
            "## Data quality findings (data_quality_report.json)\n\n"
            + json.dumps(_compact_quality_report(quality), indent=2)
            + "\n\n"
        )

    return (
        template
        .replace("{{CORRECTIONS}}", corrections_block)
        .replace("{{BOARD_CONTEXT}}", context_block)
        .replace("{{DATA_QUALITY}}", quality_block)
        .replace("{{FINDINGS}}", _findings_as_text(findings))
    )


# ---------------------------------------------------------------------------
# Mode: prompt
# ---------------------------------------------------------------------------


def write_prompt(findings, corrections_block: str = ""):
    import subprocess
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    header = """\
---
agent: agent
description: "Flow metrics — interpret board structure and write config.json"
---

"""
    content = header + build_prompt(findings, corrections_block)
    PROMPT_MD_PATH.write_text(content, encoding="utf-8")
    print(f"Written: {PROMPT_MD_PATH}")
    try:
        subprocess.Popen(["code", str(PROMPT_MD_PATH)])
        print(f"Opened: {PROMPT_MD_PATH}")
    except FileNotFoundError:
        pass
    print()
    print("Next steps:")
    print("  1. Open output/data/ai_configure_board.prompt.md in any AI assistant and run it.")
    print("  2. The agent will save output/data/config.json automatically.")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corrections-log", metavar="PATH", default=None,
                        help="Path to corrections_log.json (global learning log)")
    args = parser.parse_args()

    if CONFIG_PATH.exists():
        print(f"Skipping: {CONFIG_PATH} already exists. Delete it to regenerate.")
        sys.exit(0)

    context = load(CONTEXT_PATH)
    history = load(HISTORY_PATH)
    quality = load(QUALITY_PATH)
    work_items = json.loads(WORK_ITEMS_PATH.read_text(encoding="utf-8")) if WORK_ITEMS_PATH.exists() else None

    findings = analyse(context, history, work_items)
    corrections_block = _format_corrections_block(args.corrections_log)
    write_prompt(findings, corrections_block)


if __name__ == "__main__":
    main()
