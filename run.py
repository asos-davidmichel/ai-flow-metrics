"""
Full pipeline runner.

Usage:
  python run.py <board-url> [--short-dwell-minutes N] [--ai-mode prompt|openai|skip]
                            [--window 6m] [--clean] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--yes]
  python run.py --clean   (clean output files only, no board URL required)

Runs:
  1. fetch_data.py         — fetch board context and work items from Azure DevOps
  2. check_data.py         — run data quality checks on the saved JSON files
  3. ai_configure_board.py — generate AI interpretation prompt → output/data/config.json

After step 3: paste the AI's JSON response directly into output/data/config.json.

If output/data/config.json exists, also runs:
  4. calc_columns.py         — calculate time-in-columns metric → output/metrics/time_in_columns.json
  5. calc_cycle_time.py      — calculate cycle time and throughput → output/metrics/cycle_time.json
  6. calc_lead_time.py       — calculate lead time → output/metrics/lead_time.json
  7. create_dashboard.py     — generate dashboard → output/dashboard.html
  8. ai_interpret_metrics.py — generate AI chart insights → output/data/insights.json
                               (skipped when --ai-mode skip)
  9. create_dashboard.py     — re-generate dashboard with insights embedded

Window values for --window: 1m, 3m, 6m, 1y (default: 6m)
--from / --to: explicit date range YYYY-MM-DD (overrides --window when --from is given)
--ai-mode: prompt (default), auto, skip
  skip omits step 8 (insights) only — board config (step 3) always runs.

--clean  Delete all previously generated output files before running.
--yes    Skip all confirmation prompts (useful with --ai-mode auto).
"""

import os
import shutil
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
    Path("output/data/blocked_signals.json"),
    Path("output/data/config.json"),
    Path("output/data/insights.json"),
    Path("output/data/interpret_metrics_prompt.txt"),
    Path("output/data/ai_configure_board.prompt.md"),
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


def open_prompt_file(path: Path):
    """Open a generated prompt file in VS Code (if running inside VS Code's terminal)
    or with the OS default application otherwise."""
    resolved = path.resolve()
    opened = False
    if os.environ.get("TERM_PROGRAM") == "vscode" and shutil.which("code"):
        try:
            subprocess.run(["code", str(resolved)], check=False, shell=(sys.platform == "win32"))
            opened = True
        except FileNotFoundError:
            pass
    if not opened:
        if sys.platform == "win32":
            os.startfile(resolved)
        elif sys.platform == "darwin":
            subprocess.run(["open", str(resolved)], check=False)
        else:
            subprocess.run(["xdg-open", str(resolved)], check=False)


def run(cmd, description):
    print(f"\n{'=' * 60}")
    print(f"  {description}")
    print(f"{'=' * 60}\n")
    result = subprocess.run(cmd, check=False)
    if result.returncode != 0:
        print(f"\nError: '{' '.join(cmd)}' exited with code {result.returncode}.", file=sys.stderr)
        sys.exit(result.returncode)


def main():
    if "--clean" in sys.argv and len(sys.argv) == 2:
        # clean-only mode — no board URL required
        clean_output()
        return

    # Expect board URL as first positional argument
    positional = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not positional:
        print("Usage: python run.py <board-url> [--short-dwell-minutes N] [--window 6m] [--clean]", file=sys.stderr)
        print("       python run.py --clean   (clean output files only)", file=sys.stderr)
        sys.exit(1)

    board_url = positional[0]

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

    # --ai-mode controls both ai_configure_board.py (step 3) and ai_interpret_metrics.py (step 8)
    ai_mode = "prompt"
    if "--ai-mode" in sys.argv:
        idx = sys.argv.index("--ai-mode")
        try:
            ai_mode = sys.argv[idx + 1]
            if ai_mode not in ("prompt", "auto", "skip"):
                print("Error: --ai-mode must be prompt, auto, or skip.", file=sys.stderr)
                sys.exit(1)
        except IndexError:
            print("Error: --ai-mode requires a value (prompt, auto, skip).", file=sys.stderr)
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

    # Custom date range: --from / --to (override --window when --from is given)
    date_from = None
    date_to = None
    if "--from" in sys.argv:
        idx = sys.argv.index("--from")
        try:
            date_from = sys.argv[idx + 1]
        except IndexError:
            print("Error: --from requires a YYYY-MM-DD value.", file=sys.stderr)
            sys.exit(1)
    if "--to" in sys.argv:
        idx = sys.argv.index("--to")
        try:
            date_to = sys.argv[idx + 1]
        except IndexError:
            print("Error: --to requires a YYYY-MM-DD value.", file=sys.stderr)
            sys.exit(1)

    insights_mode = ai_mode  # same mode for both AI steps

    config_path = Path("output/data/config.json")
    config_exists = config_path.exists()

    print()
    print("Run configuration")
    print("-" * 40)
    print(f"  Board URL       : {board_url}")
    print(f"  AI mode         : {ai_mode}")
    if date_from:
        range_label = f"{date_from} → {date_to or 'today'}"
        print(f"  Metrics window  : {range_label} (--from/--to)")
    else:
        print(f"  Metrics window  : {window}")
    if check_args:
        print(f"  Short dwell     : {check_args[1]} minutes")
    print(f"  config.json     : {'found — metrics will run' if config_exists else 'not found — will stop after step 3'}")
    print()
    print("Available options (Ctrl+C to abort and rerun with different flags):")
    print("  --window         2w | 1m | 3m | 6m | 1y         (default: 6m)")
    print("  --from YYYY-MM-DD [--to YYYY-MM-DD]             (explicit date range, overrides --window)")
    print("  --ai-mode        prompt | auto | skip                (default: prompt)")
    print("  --short-dwell-minutes N                       (flag items moved too quickly)")
    print("  --clean                                       (delete all output files first)")
    print("  --yes                                         (skip all confirmation prompts; pair with --ai-mode auto)")
    print()

    yes = "--yes" in sys.argv or "-y" in sys.argv

    try:
        if not yes:
            input("Press Enter to start, or Ctrl+C to abort...")
    except KeyboardInterrupt:
        print("\nAborted.")
        sys.exit(0)

    run(
        [sys.executable, "src/fetch_data.py", board_url],
        "Step 1 / 3 — Fetch from Azure DevOps",
    )
    run(
        [sys.executable, "src/check_data.py"] + check_args,
        "Step 2 / 3 — Data quality checks",
    )
    run(
        [sys.executable, "src/ai_configure_board.py", "--mode", ai_mode if ai_mode != "skip" else "prompt"],
        "Step 3 / 3 — Generate AI interpretation prompt",
    )

    print("\nData files:")
    print("  output/data/context.json")
    print("  output/data/work_items.json")
    print("  output/data/work_item_history.json")
    print("  output/data/data_quality_report.json")
    print("  output/data/excluded_items.json")
    print("  output/data/work_item_rework.json")

    # For prompt mode (human-in-the-loop), pause so the user can run the prompt
    # and save the AI's JSON response as config.json before metrics continue.
    if ai_mode == "prompt":
        configure_prompt_path = Path("output/data/ai_configure_board.prompt.md")
        open_prompt_file(configure_prompt_path)
        print()
        print("Next steps:")
        print("  1. Open output/data/ai_configure_board.prompt.md in any AI assistant and run it.")
        print("  2. The agent will save output/data/config.json automatically.")
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

    # Build window args to forward to calc scripts
    if date_from:
        window_args = ["--from", date_from] + (["--to", date_to] if date_to else [])
        window_label = f"{date_from} → {date_to or 'today'}"
    else:
        window_args = ["--window", window]
        window_label = window

    print()
    run(
        [sys.executable, "src/calc_columns.py"] + window_args,
        f"Step 4 / 9 — Calculate time-in-columns (window: {window_label})",
    )
    run(
        [sys.executable, "src/calc_cycle_time.py"] + window_args,
        f"Step 5 / 9 — Calculate cycle time (window: {window_label})",
    )
    run(
        [sys.executable, "src/calc_lead_time.py"] + window_args,
        f"Step 6 / 9 — Calculate lead time (window: {window_label})",
    )
    run(
        [sys.executable, "src/create_dashboard.py"],
        "Step 7 / 9 — Generate dashboard",
    )

    if insights_mode == "skip":
        dashboard_path = Path("output/dashboard.html").resolve()
        print()
        print(f"Dashboard ready: {dashboard_path}")
        import webbrowser
        webbrowser.open(dashboard_path.as_uri())
        return

    run(
        [sys.executable, "src/ai_interpret_metrics.py", "--mode", insights_mode],
        f"Step 8 / 9 — Generate AI chart insights ({insights_mode})",
    )

    if insights_mode == "prompt":
        interpret_prompt_path = Path("output/data/ai_interpret_metrics.prompt.md")
        open_prompt_file(interpret_prompt_path)
        print()
        print("Next steps:")
        print("  1. Open output/data/ai_interpret_metrics.prompt.md in any AI assistant and run it.")
        print("  2. The agent will save output/data/insights.json automatically.")
        print()
        try:
            input("Press Enter when insights.json is ready to re-generate the dashboard...")
        except KeyboardInterrupt:
            print("\nAborted.")
            sys.exit(0)

    run(
        [sys.executable, "src/create_dashboard.py", "--force"],
        "Step 9 / 9 — Re-generate dashboard with insights",
    )

    dashboard_path = Path("output/dashboard.html").resolve()
    print()
    print(f"Dashboard ready: {dashboard_path}")
    import webbrowser
    webbrowser.open(dashboard_path.as_uri())


if __name__ == "__main__":
    main()
