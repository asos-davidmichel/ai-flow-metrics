"""
AI interpretation pass 1 — proposes config_draft.json from board structure and history.

Analyses:
  - Unknown historical column names (vs current board)
  - Blocked time signals (swimlane names, card rules, column names)
  - Dwell time statistics per column (to assist flow efficiency classification)
  - Deterministic flow efficiency rules (incoming/outgoing always waiting)

Reads:
  output/data/context.json
  output/data/work_item_history.json
  output/data/data_quality_report.json

Writes (depending on --mode):
  prompts/interpret_config.prompt.md      (--mode copilot)  open in VS Code chat, pick your model
  output/data/interpret_config_prompt.txt (--mode prompt)   paste into any AI assistant
  output/data/config_draft.json           (--mode openai)   direct API call (not yet implemented)

After any mode: review output/data/config_draft.json and save as output/data/config.json
to confirm your interpretation choices. The metrics script requires config.json.

Usage:
  python src/interpret_config.py
  python src/interpret_config.py --mode copilot
  python src/interpret_config.py --mode prompt
  python src/interpret_config.py --mode openai
"""

import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

DATA_DIR = Path("output/data")
PROMPTS_DIR = Path("prompts")

CONTEXT_PATH = DATA_DIR / "context.json"
HISTORY_PATH = DATA_DIR / "work_item_history.json"
QUALITY_PATH = DATA_DIR / "data_quality_report.json"
CONFIG_DRAFT_PATH = DATA_DIR / "config_draft.json"
PROMPT_TXT_PATH = DATA_DIR / "interpret_config_prompt.txt"
PROMPT_MD_PATH = PROMPTS_DIR / "interpret_config.prompt.md"

VIRTUAL_COLUMNS = {"Backlog"}
BLOCKED_KEYWORDS = ("block", "impede", "impediment", "on hold", "hold")

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


def analyse(context, history):
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

    # 5. Flow efficiency: deterministic vs needs classification
    waiting_deterministic = [
        c["name"] for c in context["columns"]
        if c["column_type"] in ("incoming", "outgoing")
    ]
    needs_classification = [
        c for c in columns_info if c["column_type"] == "inProgress"
    ]

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
        "flow_efficiency": {
            "waiting_deterministic": waiting_deterministic,
            "needs_classification": needs_classification,
        },
    }


# ---------------------------------------------------------------------------
# Prompt building
# ---------------------------------------------------------------------------

_PREAMBLE = """\
You are helping configure a flow metrics tool for an Azure DevOps Kanban board.

The tool calculates cycle time, lead time, flow efficiency, and blocked time.
Before it can compute metrics, four configuration decisions must be made.
Analyse the board data below and return a JSON object that resolves all four decisions.

---

"""

_DECISIONS = """\

---

## Decisions required

### 1. Lead time clock start
Lead time = customer/request perspective (from intake to done).
Choose ONE of:
- "created_date" — clock starts when the work item was created in ADO
- "board_entry_date" — clock starts when the item first appeared on the board (any column)

### 2. Cycle time clock start
Cycle time = team processing perspective (from active work start to done).
Choose ONE of:
- "board_entry_date" — clock starts when the item first appeared on the board (any column)
- "first_inprogress_entry" — clock starts when the item first entered an inProgress column

### 3. Shared clock end (applies to both lead time and cycle time)
Choose ONE of:
- "outgoing_column" — clock stops when the item enters the board's outgoing column (e.g. Closed)
- "closed_state" — clock stops when the ADO state field becomes "Closed"
- "resolved_state" — clock stops when the ADO state field becomes "Resolved" (warning: maps to pre-QA columns for many work item types on this board — likely too early)

### 4. Historical column mapping
Some items have history spanning columns that no longer exist on the board.
For each unknown historical column listed above, provide ONE of:
- a current column name to treat it as equivalent to
- null to exclude those spans from metrics entirely

If there are no unknown columns, return an empty object {}.

### 5. Flow efficiency — active vs waiting columns
Classify each inProgress column as "active" (value-adding work happening) or "waiting"
(queue, handoff, or blocked state). Use column names and dwell patterns to guide your choice.
incoming and outgoing columns are always "waiting" — do not include them in your response.
Only classify the inProgress columns listed above.

### 6. Blocked time detection
List ALL signals this team uses to indicate blocked or on-hold items.
Return an array — include every signal you find with reasonable confidence.
Each signal is one of:
  {"mechanism": "swimlane", "swimlane_name": "<name>"}
  {"mechanism": "tag", "tag": "<tag>"}
  {"mechanism": "column", "column_name": "<name>"}
If no signal found, return an empty array [].

---

## Required output format

Return ONLY a valid JSON object. No markdown fences, no explanation, no preamble.

{
  "_note": "Reviewed and confirmed by user. Edit freely before saving as config.json.",
  "_reasoning": "<optional: the AI's explanation for each choice — remove before saving as config.json>",
  "lead_time": {
    "clock_start": "<created_date | board_entry_date>",
    "clock_end": "<outgoing_column | closed_state | resolved_state>"
  },
  "cycle_time": {
    "clock_start": "<board_entry_date | first_inprogress_entry>",
    "clock_end": "<outgoing_column | closed_state | resolved_state>"
  },
  "historical_column_mapping": {
    "<old column name>": "<current column name, or null to exclude>"
  },
  "flow_efficiency": {
    "active_columns": ["<column name>"],
    "waiting_columns": ["<column name>"]
  },
  "blocked_time": {
    "signals": [
      {"mechanism": "<swimlane | tag | column>", "<swimlane_name | tag | column_name>": "<value>"}
    ]
  }
}
"""


def _findings_as_text(findings):
    lines = []

    board = findings["board"]
    lines.append(f"## Board: {board['board_name']}")
    lines.append(f"Org: {board['org']} | Project: {board['project']} | Team: {board['team']}")
    lines.append("")

    lines.append("## Columns")
    lines.append("| Name | Type | WIP limit | Dwell (n, avg, median) |")
    lines.append("|------|------|-----------|------------------------|")
    for col in findings["columns"]:
        d = col["dwell"]
        dwell = f"n={d['n']}, avg={d['avg_hours']}h, median={d['median_hours']}h" if d else "no data"
        lines.append(f"| {col['name']} | {col['column_type']} | {col['wip_limit']} | {dwell} |")
    lines.append("")

    lines.append("## Unknown historical columns (no longer on current board)")
    if findings["unknown_historical_columns"]:
        for col in findings["unknown_historical_columns"]:
            lines.append(f"- {col}")
    else:
        lines.append("None.")
    lines.append("")

    lines.append("## Blocked signals detected")
    if findings["blocked_signals"]:
        for sig in findings["blocked_signals"]:
            lines.append(f"- {json.dumps(sig)}")
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

    return "\n".join(lines)


def build_plain_prompt(findings):
    return _PREAMBLE + _findings_as_text(findings) + _DECISIONS


def build_copilot_prompt(findings):
    header = """\
---
mode: ask
description: "Flow metrics — interpret board structure and propose config_draft.json"
---

"""
    preamble = """\
You are helping configure a flow metrics tool for an Azure DevOps Kanban board.

The tool calculates cycle time, lead time, flow efficiency, and blocked time.
Before it can compute metrics, four configuration decisions must be made.

Board structure and card rules: #file:output/data/context.json
Data quality findings: #file:output/data/data_quality_report.json

The script `src/interpret_config.py` also performed an automated analysis.
Its findings are embedded below.

"""
    return header + preamble + _findings_as_text(findings) + _DECISIONS


# ---------------------------------------------------------------------------
# Mode: copilot
# ---------------------------------------------------------------------------


def write_copilot_prompt(findings):
    PROMPTS_DIR.mkdir(exist_ok=True)
    content = build_copilot_prompt(findings)
    PROMPT_MD_PATH.write_text(content, encoding="utf-8")
    print(f"Written: {PROMPT_MD_PATH}")
    print()
    print("Next steps:")
    print("  1. Open the prompt file in VS Code.")
    print("  2. Run it in chat — select your preferred model.")
    print("  3. Copy the JSON response into output/data/config_draft.json.")
    print("  4. Review and edit config_draft.json, then save as output/data/config.json.")


# ---------------------------------------------------------------------------
# Mode: prompt
# ---------------------------------------------------------------------------


def write_plain_prompt(findings):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    content = build_plain_prompt(findings)
    PROMPT_TXT_PATH.write_text(content, encoding="utf-8")
    print(f"Written: {PROMPT_TXT_PATH}")
    print()
    print("Next steps:")
    print("  1. Open output/data/interpret_config_prompt.txt.")
    print("  2. Paste the contents into any AI assistant.")
    print("  3. Copy the JSON response into output/data/config_draft.json.")
    print("  4. Review and edit config_draft.json, then save as output/data/config.json.")


# ---------------------------------------------------------------------------
# Mode: openai (stub)
# ---------------------------------------------------------------------------


def call_openai(findings):
    """
    Call OpenAI Chat Completions API to produce config_draft.json directly.

    Required environment variables:
      OPENAI_API_KEY — your OpenAI API key
      OPENAI_MODEL   — model to use (default: gpt-4o)

    Not yet implemented. To implement:
      1. requests is already a dependency — no additional packages needed.
      2. POST to https://api.openai.com/v1/chat/completions.
         Headers: {"Authorization": "Bearer <key>", "Content-Type": "application/json"}
         Body: {"model": model, "messages": [{"role": "user", "content": prompt}]}
      3. Parse JSON from response["choices"][0]["message"]["content"].
      4. Write parsed dict to CONFIG_DRAFT_PATH.
    """
    import os
    if not os.environ.get("OPENAI_API_KEY"):
        print("Error: OPENAI_API_KEY environment variable is not set.", file=sys.stderr)
        sys.exit(1)
    print("Error: --mode openai is not yet implemented.", file=sys.stderr)
    print("Use --mode copilot or --mode prompt instead.", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Generate an AI interpretation prompt to configure flow metrics."
    )
    parser.add_argument(
        "--mode",
        choices=["copilot", "prompt", "openai"],
        default="copilot",
        help="How to deliver the prompt (default: copilot)",
    )
    args = parser.parse_args()

    context = load(CONTEXT_PATH)
    history = load(HISTORY_PATH)
    quality = load(QUALITY_PATH)

    findings = analyse(context, history)

    if args.mode == "copilot":
        write_copilot_prompt(findings)
    elif args.mode == "prompt":
        write_plain_prompt(findings)
    elif args.mode == "openai":
        call_openai(findings)


if __name__ == "__main__":
    main()
