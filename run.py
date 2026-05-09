"""
Full pipeline runner.

Usage:
  python run.py <board-url> [--short-dwell-minutes N] [--interpret-mode copilot|prompt|openai]

Runs:
  1. main.py           — fetch board context and work items from Azure DevOps
  2. check.py          — run data quality checks on the saved JSON files
  3. interpret_config.py — generate AI interpretation prompt → output/data/config_draft.json

After step 3: review config_draft.json, edit if needed, save as output/data/config.json.
Then run: python src/metrics.py  (once implemented)
"""

import subprocess
import sys


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
        print("Usage: python run.py <board-url> [--short-dwell-minutes N]", file=sys.stderr)
        sys.exit(1)

    board_url = sys.argv[1]

    # Forward --short-dwell-minutes to check.py if provided
    check_args = []
    if "--short-dwell-minutes" in sys.argv:
        idx = sys.argv.index("--short-dwell-minutes")
        try:
            check_args = ["--short-dwell-minutes", sys.argv[idx + 1]]
        except IndexError:
            print("Error: --short-dwell-minutes requires an integer value.", file=sys.stderr)
            sys.exit(1)

    # Forward --interpret-mode to interpret_config.py if provided (default: copilot)
    interpret_mode = "copilot"
    if "--interpret-mode" in sys.argv:
        idx = sys.argv.index("--interpret-mode")
        try:
            interpret_mode = sys.argv[idx + 1]
        except IndexError:
            print("Error: --interpret-mode requires a value (copilot, prompt, openai).", file=sys.stderr)
            sys.exit(1)

    run(
        [sys.executable, "src/main.py", board_url],
        "Step 1 / 3 — Fetch from Azure DevOps",
    )
    run(
        [sys.executable, "src/check.py"] + check_args,
        "Step 2 / 3 — Data quality checks",
    )
    run(
        [sys.executable, "src/interpret_config.py", "--mode", interpret_mode],
        "Step 3 / 3 — Generate AI interpretation prompt",
    )

    print("\nData files:")
    print("  output/data/context.json")
    print("  output/data/work_items.json")
    print("  output/data/work_item_history.json")
    print("  output/data/data_quality_report.json")
    print("  output/data/excluded_items.json")
    print("  output/data/work_item_rework.json")
    print()
    print("Next: review output/data/config_draft.json, edit if needed,")
    print("      then save as output/data/config.json to confirm your choices.")
    print("      Once config.json exists, run: python src/metrics.py")


if __name__ == "__main__":
    main()
