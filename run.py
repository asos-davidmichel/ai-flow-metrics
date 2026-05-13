"""
Full pipeline runner.

Usage:
  python run.py <board-url> [--short-dwell-minutes N] [--interpret-mode copilot|prompt|openai] [--window 6m] [--clean]

Runs:
  1. fetch_data.py         — fetch board context and work items from Azure DevOps
  2. check_data.py         — run data quality checks on the saved JSON files
  3. ai_configure_board.py — generate AI interpretation prompt → output/data/config_draft.json

After step 3: review config_draft.json, edit if needed, save as output/data/config.json.

If output/data/config.json exists, also runs:
  4. calc_columns.py       — calculate time-in-columns metric → output/metrics/time_in_columns.json
  5. calc_cycle_time.py    — calculate cycle time and throughput → output/metrics/cycle_time.json
  6. calc_lead_time.py     — calculate lead time → output/metrics/lead_time.json
  7. create_dashboard.py   — generate dashboard → output/dashboard.html

Window values for --window: 1m, 3m, 6m, 1y (default: 6m)

--clean  Delete all previously generated output files before running.
"""

import subprocess
import sys
from pathlib import Path


GENERATED_FILES = [
    Path("output/data/context.json"),
    Path("output/data/work_items.json"),
    Path("output/data/work_item_history.json"),
    Path("output/data/work_item_rework.json"),
    Path("output/data/data_quality_report.json"),
    Path("output/data/excluded_items.json"),
    Path("output/data/config.json"),
    Path("output/data/config_draft.json"),
    Path("output/data/insights.json"),
    Path("output/data/interpret_metrics_prompt.txt"),
    Path("output/data/ai_interpret_metrics.prompt.md"),
    Path("output/metrics/cycle_time.json"),
    Path("output/metrics/lead_time.json"),
    Path("output/metrics/time_in_columns.json"),
    Path("output/dashboard.html"),
]


def clean_output():
    removed = []
    for path in GENERATED_FILES:
        if path.exists():
            path.unlink()
            removed.append(str(path))
    if removed:
        print("Cleaned:")
        for p in removed:
            print(f"  {p}")
    else:
        print("Nothing to clean — output files not found.")


def run(cmd, description):
    print(f"\n{'=' * 60}")
    print(f"  {description}")
    print(f"{'=' * 60}\n")
    result = subprocess.run(cmd, check=False)
    if result.returncode != 0:
        print(f"\nError: '{' '.join(cmd)}' exited with code {result.returncode}.", file=sys.stderr)
        sys.exit(result.returncode)


def main():
    if len(sys.argv) < 2:
        print("Usage: python run.py <board-url> [--short-dwell-minutes N] [--window 6m] [--clean]", file=sys.stderr)
        sys.exit(1)

    board_url = sys.argv[1]

    if "--clean" in sys.argv:
        clean_output()
        print()

    # Forward --short-dwell-minutes to check.py if provided
    check_args = []
    if "--short-dwell-minutes" in sys.argv:
        idx = sys.argv.index("--short-dwell-minutes")
        try:
            check_args = ["--short-dwell-minutes", sys.argv[idx + 1]]
        except IndexError:
            print("Error: --short-dwell-minutes requires an integer value.", file=sys.stderr)
            sys.exit(1)

    # Forward --interpret-mode to ai_configure_board.py if provided (default: copilot)
    interpret_mode = "copilot"
    if "--interpret-mode" in sys.argv:
        idx = sys.argv.index("--interpret-mode")
        try:
            interpret_mode = sys.argv[idx + 1]
        except IndexError:
            print("Error: --interpret-mode requires a value (copilot, prompt, openai).", file=sys.stderr)
            sys.exit(1)

    # Forward --window to metrics.py if provided (default: 6m)
    window = "6m"
    if "--window" in sys.argv:
        idx = sys.argv.index("--window")
        try:
            window = sys.argv[idx + 1]
        except IndexError:
            print("Error: --window requires a value (e.g. 1m, 3m, 6m, 1y).", file=sys.stderr)
            sys.exit(1)

    run(
        [sys.executable, "src/fetch_data.py", board_url],
        "Step 1 / 3 — Fetch from Azure DevOps",
    )
    run(
        [sys.executable, "src/check_data.py"] + check_args,
        "Step 2 / 3 — Data quality checks",
    )
    run(
        [sys.executable, "src/ai_configure_board.py", "--mode", interpret_mode],
        "Step 3 / 3 — Generate AI interpretation prompt",
    )

    print("\nData files:")
    print("  output/data/context.json")
    print("  output/data/work_items.json")
    print("  output/data/work_item_history.json")
    print("  output/data/data_quality_report.json")
    print("  output/data/excluded_items.json")
    print("  output/data/work_item_rework.json")

    # For modes that require human-in-the-loop (copilot / prompt), always pause so
    # the user can run the prompt, review config_draft.json, and save config.json
    # before the pipeline continues to metrics.
    if interpret_mode in ("copilot", "prompt"):
        print()
        print("Next steps:")
        if interpret_mode == "copilot":
            print("  1. Run the prompt that just opened in VS Code Copilot chat.")
        else:
            print("  1. Paste output/data/ai_configure_board_prompt.txt into your AI assistant.")
        print("  2. Review output/data/config_draft.json and edit if needed.")
        print("  3. Save it as output/data/config.json to confirm your choices.")
        print()
        try:
            input("Press Enter when config.json is ready to continue to metrics and dashboard...")
        except KeyboardInterrupt:
            print("\nAborted.")
            sys.exit(0)

    config_path = Path("output/data/config.json")
    if not config_path.exists():
        print()
        print("config.json not found — skipping metrics.")
        print(f"Re-run with --window {window} once config.json exists.")
        return

    print()
    run(
        [sys.executable, "src/calc_columns.py", "--window", window],
        f"Step 4 / 7 — Calculate time-in-columns (window: {window})",
    )
    run(
        [sys.executable, "src/calc_cycle_time.py", "--window", window],
        f"Step 5 / 7 — Calculate cycle time (window: {window})",
    )
    run(
        [sys.executable, "src/calc_lead_time.py", "--window", window],
        f"Step 6 / 7 — Calculate lead time (window: {window})",
    )
    run(
        [sys.executable, "src/create_dashboard.py"],
        "Step 7 / 7 — Generate dashboard",
    )
    print()
    print("Dashboard ready: output/dashboard.html")


if __name__ == "__main__":
    main()
