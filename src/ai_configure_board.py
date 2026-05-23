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

Writes (depending on --mode):
  src/prompts/ai_configure_board.prompt.md  (--mode prompt)   open in VS Code chat or paste into any AI
  output/data/config.json                   (--mode openai)   direct API call (requires OPENAI_API_KEY)

After prompt mode: paste the AI's JSON response directly into output/data/config.json.
The metrics script requires config.json.

Usage:
  python src/ai_configure_board.py
  python src/ai_configure_board.py --mode prompt
  python src/ai_configure_board.py --mode openai
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
PROMPTS_DIR = Path(__file__).parent / "prompts"

CONTEXT_PATH = DATA_DIR / "context.json"
HISTORY_PATH = DATA_DIR / "work_item_history.json"
QUALITY_PATH = DATA_DIR / "data_quality_report.json"
WORK_ITEMS_PATH = DATA_DIR / "work_items.json"
CONFIG_PATH = DATA_DIR / "config.json"
PROMPT_MD_PATH = PROMPTS_DIR / "ai_configure_board.prompt.md"

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
    needs_classification = [
        c for c in columns_info if c["column_type"] == "inProgress"
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
- `{"type": "date_field", "value": "created_date"}` — clock starts when the work item was created in ADO
- `{"type": "column", "value": "<incoming column name>"}` — clock starts when the item first appeared on the board

### 2. Cycle time clock start
Cycle time = team processing perspective (from active work start to done).
Choose ONE of:
- `{"type": "column", "value": "<incoming column name>"}` — clock starts when the item first appeared on the board
- `{"type": "column", "value": "<first inProgress column name>"}` — clock starts when the item first entered an inProgress column

### 3. Shared clock end (applies to both lead time and cycle time)
Must be a column. The outgoing column is the standard choice.
- `{"type": "column", "value": "<outgoing column name>"}` — clock stops when the item first entered that column

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
List ALL signals this team uses to indicate blocked or waiting items.
Return an array — include every signal you find with reasonable confidence.
Include waiting/on-hold states (e.g. "Waiting - Internal" tags) as well as hard blocks.

For tag signals:
- Use the "tags" field as a LIST of tag strings that all belong to the same concept.
- If multiple tags clearly refer to the same blocking concept (e.g. "Blocked by BAG", "Blocked by PLP"
  are variants of the same type of block), group them into ONE signal with all matching tags listed.
- If tags represent meaningfully different concepts (e.g. "Waiting - Internal" vs "Blocked"), keep
  them as separate signals.
- Use the card rule background_color for each signal's color where available.
- If a tag is in the "tags in use" list but has no card rule, infer a reasonable color (or use null).

Tag signal format:
  {"mechanism": "tag", "tags": ["<tag1>", "<tag2>"], "label": "<display label>", "color": "<hex or null>"}
Other signal formats (non-tag, treated as informational only):
  {"mechanism": "swimlane", "swimlane_name": "<name>", "label": "<display label>", "color": null}
  {"mechanism": "column", "column_name": "<name>", "label": "<display label>", "color": null}
If no signal found, return an empty array [].

### 7. Swimlane mapping
Some items may carry a historical swimlane name that no longer matches the current board.
For each unknown historical swimlane name, provide the current swimlane name it should map to,
or null to leave those items unmapped.
If there are no unknown swimlanes, return an empty object {}.

---

## Required output format

Produce the JSON object, then write it to `output/data/config.json`. Do not print it to chat.

{
  "lead_time": {
    "clock_start": {"type": "<column | date_field>", "value": "<column name or field name>"},
    "clock_end": {"type": "column", "value": "<column name>"}
  },
  "cycle_time": {
    "clock_start": {"type": "column", "value": "<column name>"},
    "clock_end": {"type": "column", "value": "<column name>"}
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
      {"mechanism": "tag", "tags": ["<tag1>", "<tag2>"], "label": "<display label>", "color": "<hex or null>"},
      {"mechanism": "swimlane", "swimlane_name": "<name>", "label": "<display label>", "color": null}
    ]
  },
  "swimlane_mapping": {
    "<old swimlane name>": "<current swimlane name, or null to leave unmapped>"
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


def build_prompt(findings):
    """Build prompt content with inline context data (works in VS Code and when pasted elsewhere)."""
    header = """\
---
mode: agent
description: "Flow metrics — interpret board structure and write config.json"
---

"""
    context_block = ""
    if CONTEXT_PATH.exists():
        context_block = (
            "## Board structure and card rules (context.json)\n\n"
            + CONTEXT_PATH.read_text(encoding="utf-8")
            + "\n\n"
        )

    quality_block = ""
    if QUALITY_PATH.exists():
        quality_block = (
            "## Data quality findings (data_quality_report.json)\n\n"
            + QUALITY_PATH.read_text(encoding="utf-8")
            + "\n\n"
        )

    return header + _PREAMBLE + context_block + quality_block + _findings_as_text(findings) + _DECISIONS


# ---------------------------------------------------------------------------
# Mode: prompt
# ---------------------------------------------------------------------------


def write_prompt(findings):
    import subprocess
    PROMPTS_DIR.mkdir(exist_ok=True)
    content = build_prompt(findings)
    PROMPT_MD_PATH.write_text(content, encoding="utf-8")
    print(f"Written: {PROMPT_MD_PATH}")
    try:
        subprocess.Popen(["code", str(PROMPT_MD_PATH)])
        print("Opened in VS Code — click 'Run in Chat' and select your model.")
        print("Or paste the file contents into any AI assistant.")
    except FileNotFoundError:
        print(f"Open {PROMPT_MD_PATH} in VS Code, or paste its contents into any AI assistant.")
    print()
    print("Next steps:")
    print("  1. Run the prompt in VS Code chat (or paste into ChatGPT / Claude / etc.).")
    print("  2. Save the JSON response as output/data/config.json.")


def call_openai(findings):
    """
    Call an OpenAI-compatible Chat Completions API to produce config.json directly.

    Required environment variables:
      OPENAI_API_KEY  — API key (OpenAI key, GitHub PAT, Azure key, etc.)
    Optional:
      OPENAI_MODEL    — model name (default: gpt-4o)
      OPENAI_BASE_URL — base URL for the API (default: https://api.openai.com/v1)
                        Examples:
                          GitHub Models:  https://models.inference.ai.azure.com
                          Azure OpenAI:   https://<resource>.openai.azure.com/openai/deployments/<deployment>
    """
    import os, urllib.request
    api_key  = os.environ.get("OPENAI_API_KEY")
    model    = os.environ.get("OPENAI_MODEL", "gpt-4o")
    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    endpoint = f"{base_url}/chat/completions"
    if not api_key:
        print("Error: OPENAI_API_KEY environment variable is not set.", file=sys.stderr)
        sys.exit(1)

    prompt = build_prompt(findings)
    body = json.dumps({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a JSON configuration generator for a flow metrics tool. "
                    "Return ONLY a valid JSON object as your response — no explanation, "
                    "no markdown fences, no preamble. The JSON will be written directly "
                    "to config.json by the calling script."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.1,
    }).encode("utf-8")

    req = urllib.request.Request(
        endpoint,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    print(f"Calling {endpoint} ({model}) to configure board…")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read())
    except Exception as e:
        print(f"Error calling OpenAI API: {e}", file=sys.stderr)
        sys.exit(1)

    content = result["choices"][0]["message"]["content"].strip()
    # Strip markdown fences if present
    if content.startswith("```"):
        content = "\n".join(content.split("\n")[1:])
        if content.endswith("```"):
            content = content[:-3].rstrip()

    try:
        config = json.loads(content)
    except json.JSONDecodeError as e:
        print(f"Warning: could not parse AI response as JSON: {e}", file=sys.stderr)
        raw_path = DATA_DIR / "config_raw.txt"
        raw_path.write_text(content, encoding="utf-8")
        print(f"Raw response saved to {raw_path}")
        sys.exit(1)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(config, indent=2), encoding="utf-8")
    print(f"Written: {CONFIG_PATH}")


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
        choices=["prompt", "openai"],
        default="prompt",
        help="How to deliver the prompt (default: prompt)",
    )
    args = parser.parse_args()

    if CONFIG_PATH.exists():
        print(f"Skipping: {CONFIG_PATH} already exists. Delete it to regenerate.")
        sys.exit(0)

    context = load(CONTEXT_PATH)
    history = load(HISTORY_PATH)
    quality = load(QUALITY_PATH)
    work_items = json.loads(WORK_ITEMS_PATH.read_text(encoding="utf-8")) if WORK_ITEMS_PATH.exists() else None

    findings = analyse(context, history, work_items)

    if args.mode == "prompt":
        write_prompt(findings)
    elif args.mode == "openai":
        call_openai(findings)


if __name__ == "__main__":
    main()
