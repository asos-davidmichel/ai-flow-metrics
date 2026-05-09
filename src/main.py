import json
import os
import re
import sys
from pathlib import Path

from ado_client import (
    ADOError,
    discover_board,
    fetch_work_item_history,
    fetch_work_item_ids,
    fetch_work_item_type_styles,
    fetch_work_items,
    get_board_columns,
    get_board_rows,
    get_card_rule_settings,
    get_boards,
    make_auth_header,
    parse_board_url,
)


def _humanise_filter(filter_str):
    """Turn ADO filter syntax into a readable label, e.g. 'Tag: blocked'."""
    m = re.match(r"\[System\.Tags\] contains '(.+)'", filter_str, re.IGNORECASE)
    if m:
        return f"Tag: {m.group(1)}"
    m = re.match(r"\[(.+?)\] ([><=!]+) '(.+)'", filter_str)
    if m:
        field = m.group(1).split(".")[-1]  # strip namespace
        return f"{field} {m.group(2)} {m.group(3)}"
    return filter_str


def get_pat():
    pat = os.environ.get("ADO_PAT")
    if not pat:
        print("Error: ADO_PAT environment variable is not set.", file=sys.stderr)
        sys.exit(1)
    return pat


def prompt_board_selection(candidates, context_label=""):
    """Ask the user to pick a board from a numbered list. Returns the chosen board dict."""
    if context_label:
        print(context_label)
    for i, board in enumerate(candidates, start=1):
        print(f"  {i}. {board['name']}")

    raw = input("\nChoose a board number: ").strip()
    if not raw.isdigit() or not (1 <= int(raw) <= len(candidates)):
        print(
            f"Error: '{raw}' is not a valid choice. Enter a number between 1 and {len(candidates)}.",
            file=sys.stderr,
        )
        sys.exit(1)
    return candidates[int(raw) - 1]


def main():
    if len(sys.argv) != 2:
        print("Usage: python src/main.py <board-url>", file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]
    pat = get_pat()

    try:
        org, project, team, board_hint = parse_board_url(url)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"Organisation : {org}")
    print(f"Project      : {project}")
    print(f"Team         : {team}")
    print()

    headers = make_auth_header(pat)

    try:
        boards = get_boards(org, project, team, headers)
        discovery = discover_board(boards, board_hint)
    except ADOError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    if discovery["status"] == "no_boards_found":
        print("No boards found for this team.")
        sys.exit(0)

    if discovery["status"] == "matched":
        selected = discovery["matched_board"]
    else:
        candidates = discovery["candidates"]
        hint_context = f"No exact match for '{board_hint}'. " if board_hint else ""
        label = f"{hint_context}Found {len(candidates)} board(s):"
        selected = prompt_board_selection(candidates, label)

    print(f"Board  : {selected['name']}")
    print()

    try:
        columns = get_board_columns(selected["url"], headers)
        rows = get_board_rows(selected["url"], headers)
        card_rules = get_card_rule_settings(selected["url"], headers)
    except ADOError as e:
        print(f"Error fetching board details: {e}", file=sys.stderr)
        sys.exit(1)

    if not columns:
        print("No columns found for this board.")
        sys.exit(0)

    # Derive board-scoped work item types and state mappings from column data
    work_item_types = sorted({wit for c in columns for wit in c.get("stateMappings", {})})
    state_mappings = {
        wit: {c["name"]: c["stateMappings"][wit] for c in columns if wit in c.get("stateMappings", {})}
        for wit in work_item_types
    }

    print(f"Columns ({len(columns)}):\n")
    for col in columns:
        wip = col.get("itemLimit") or 0
        wip_label = f"WIP {wip}" if wip else "no WIP"
        print(f"  [{col.get('columnType', '?'):10}]  {col['name']:25}  {wip_label}")

    print(f"\nSwimlanes ({len(rows)}):\n")
    for row in rows:
        color = row.get("color") or "no colour"
        print(f"  {row['name']:35}  {color}")

    fill_rules = card_rules.get("fill", [])
    swimlane_rules = card_rules.get("swimlaneRule", [])
    print(f"\nCard colour rules ({len(fill_rules)}):\n")
    for rule in fill_rules:
        color = rule.get("settings", {}).get("background-color", "?")
        label = _humanise_filter(rule["filter"])
        print(f"  {rule['name']:20}  {label:35}  {color}")
    print(f"\nSwimlane rules ({len(swimlane_rules)}):\n")
    for rule in swimlane_rules:
        label = _humanise_filter(rule["filter"])
        print(f"  {rule['name']:35}  {label}")

    print(f"\nWork item types on this board ({len(work_item_types)}):\n")
    for wit in work_item_types:
        print(f"  - {wit}")

    print("\nFetching work items...")
    try:
        ids = fetch_work_item_ids(org, project, team, work_item_types, headers)
        print(f"  {len(ids)} items found")
        work_items = fetch_work_items(org, project, ids, headers)
        print(f"  {len(work_items)} items fetched")
    except ADOError as e:
        print(f"Error fetching work items: {e}", file=sys.stderr)
        sys.exit(1)

    print("\nFetching work item type styles...")
    work_item_type_styles = fetch_work_item_type_styles(org, project, work_item_types, headers)
    if work_item_type_styles:
        for wit, style in work_item_type_styles.items():
            print(f"  {wit}: color={style['color']}")
    else:
        print("  (none fetched — will use fallback colours in metrics.py)")

    output = {
        "org": org,
        "project": project,
        "team": team,
        "board": {
            "id": selected["id"],
            "name": selected["name"],
            "url": selected["url"],
        },
        "columns": [
            {
                "id": c.get("id"),
                "name": c["name"],
                "column_type": c.get("columnType"),
                "wip_limit": c.get("itemLimit") or 0,
            }
            for c in columns
        ],
        "work_item_types": work_item_types,
        "work_item_type_styles": work_item_type_styles,
        "state_mappings": state_mappings,
        "swimlanes": [{"id": r["id"], "name": r["name"], "color": r.get("color")} for r in rows],
        "card_rules": {
            "fill": [
                {
                    "name": rule["name"],
                    "filter": rule["filter"],
                    "background_color": rule.get("settings", {}).get("background-color"),
                }
                for rule in card_rules.get("fill", [])
            ],
            "swimlane_rules": [
                {
                    "name": rule["name"],
                    "filter": rule["filter"],
                }
                for rule in card_rules.get("swimlaneRule", [])
            ],
        },
    }

    output_path = Path("output/data/context.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2))
    print(f"\nContext saved to: {output_path}")

    items_path = Path("output/data/work_items.json")
    items_path.write_text(json.dumps(work_items, indent=2))
    print(f"Work items saved to: {items_path}")

    print(f"\nFetching history for {len(ids)} items (one request per item)...")
    board_column_names = [c["name"] for c in columns]
    history = []
    for i, item_id in enumerate(ids, start=1):
        try:
            record = fetch_work_item_history(org, project, item_id, board_column_names, headers)
            history.append(record)
        except ADOError as e:
            print(f"  Warning: could not fetch history for {item_id}: {e}", file=sys.stderr)
        if i % 25 == 0 or i == len(ids):
            print(f"  {i}/{len(ids)} done")

    history_path = Path("output/data/work_item_history.json")
    history_path.write_text(json.dumps(history, indent=2))
    print(f"History saved to: {history_path}")


if __name__ == "__main__":
    main()

