"""
AI Flow Metrics — pipeline runner.

Usage:
  python aiflowmetrics.py configure <board-url> [--short-dwell-minutes N] [--yes] [--clean]
  python aiflowmetrics.py metrics <config-file> [--window 6m | --from YYYY-MM-DD [--to YYYY-MM-DD]]
                                                [--ai-mode prompt|skip] [--yes] [--clean]

configure — steps 1–3: fetch ADO data, run data quality checks, generate board config prompt
metrics   — steps 4–9: calculate flow metrics, generate dashboard, generate AI chart insights

Window values for --window: 2w, 1m, 3m, 6m, 1y (default: 6m)
--from / --to: explicit date range YYYY-MM-DD (overrides --window when --from is given)
--ai-mode: prompt (default), skip
  skip omits step 8 (insights) only.

--clean  configure: delete all generated output files before running.
         metrics:   delete metrics and dashboard output files before running (keeps config).
--yes    Skip all confirmation prompts.
"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


ALL_GENERATED_FILES = [
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

METRICS_GENERATED_FILES = [
    Path("output/metrics/cycle_time.json"),
    Path("output/metrics/lead_time.json"),
    Path("output/metrics/time_in_columns.json"),
    Path("output/data/insights.json"),
    Path("output/data/ai_interpret_metrics.prompt.md"),
    Path("output/dashboard.html"),
]


def clean_files(paths):
    removed = []
    for path in paths:
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
    """Open a generated prompt file in VS Code or with the OS default application."""
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


def run_step(cmd, description):
    print(f"\n{'=' * 60}")
    print(f"  {description}")
    print(f"{'=' * 60}\n")
    result = subprocess.run(cmd, check=False)
    if result.returncode != 0:
        print(f"\nError: '{' '.join(cmd)}' exited with code {result.returncode}.", file=sys.stderr)
        sys.exit(result.returncode)


def cmd_configure(args):
    if args.clean:
        clean_files(ALL_GENERATED_FILES)
        print()

    check_args = []
    if args.short_dwell_minutes is not None:
        check_args = ["--short-dwell-minutes", str(args.short_dwell_minutes)]

    print()
    print("Configure")
    print("-" * 40)
    print(f"  Board URL   : {args.board_url}")
    if check_args:
        print(f"  Short dwell : {args.short_dwell_minutes} minutes")
    print()

    if not args.yes:
        try:
            input("Press Enter to start, or Ctrl+C to abort...")
        except KeyboardInterrupt:
            print("\nAborted.")
            sys.exit(0)

    run_step(
        [sys.executable, "src/fetch_data.py", args.board_url],
        "Step 1 / 3 — Fetch from Azure DevOps",
    )
    run_step(
        [sys.executable, "src/check_data.py"] + check_args,
        "Step 2 / 3 — Data quality checks",
    )
    run_step(
        [sys.executable, "src/ai_configure_board.py"],
        "Step 3 / 3 — Generate AI interpretation prompt",
    )

    print("\nData files written:")
    print("  output/data/context.json")
    print("  output/data/work_items.json")
    print("  output/data/work_item_history.json")
    print("  output/data/data_quality_report.json")
    print("  output/data/excluded_items.json")
    print("  output/data/work_item_rework.json")

    configure_prompt_path = Path("output/data/ai_configure_board.prompt.md")
    open_prompt_file(configure_prompt_path)
    print()
    print("Next steps:")
    print("  1. Open output/data/ai_configure_board.prompt.md in any AI assistant and run it.")
    print("  2. The agent will save output/data/config.json automatically.")
    print()
    try:
        input("Press Enter when config.json is ready...")
    except KeyboardInterrupt:
        print("\nAborted.")
        sys.exit(0)

    if not Path("output/data/config.json").exists():
        print()
        print("Error: config.json not found — run the AI prompt and save the result before continuing.", file=sys.stderr)
        sys.exit(1)

    print()
    print("config.json saved. Run metrics with:")
    print("  python aiflowmetrics.py metrics output/data/config.json")


def cmd_metrics(args):
    config_path = Path(args.config_file)
    if not config_path.exists():
        print(f"Error: config file not found: {config_path}", file=sys.stderr)
        print("Run `python aiflowmetrics.py configure <board-url>` first.", file=sys.stderr)
        sys.exit(1)

    if args.clean:
        clean_files(METRICS_GENERATED_FILES)
        print()

    if args.date_from:
        window_args = ["--from", args.date_from] + (["--to", args.date_to] if args.date_to else [])
        window_label = f"{args.date_from} → {args.date_to or 'today'}"
    else:
        window_args = ["--window", args.window]
        window_label = args.window

    print()
    print("Metrics")
    print("-" * 40)
    print(f"  Config      : {config_path}")
    print(f"  Window      : {window_label}")
    print(f"  AI mode     : {args.ai_mode}")
    print()

    if not args.yes:
        try:
            input("Press Enter to start, or Ctrl+C to abort...")
        except KeyboardInterrupt:
            print("\nAborted.")
            sys.exit(0)

    run_step(
        [sys.executable, "src/calc_columns.py"] + window_args,
        f"Step 4 / 9 — Calculate time-in-columns (window: {window_label})",
    )
    run_step(
        [sys.executable, "src/calc_cycle_time.py"] + window_args,
        f"Step 5 / 9 — Calculate cycle time (window: {window_label})",
    )
    run_step(
        [sys.executable, "src/calc_lead_time.py"] + window_args,
        f"Step 6 / 9 — Calculate lead time (window: {window_label})",
    )
    run_step(
        [sys.executable, "src/create_dashboard.py"],
        "Step 7 / 9 — Generate dashboard",
    )

    if args.ai_mode == "skip":
        dashboard_path = Path("output/dashboard.html").resolve()
        print()
        print(f"Dashboard ready: {dashboard_path}")
        import webbrowser
        webbrowser.open(dashboard_path.as_uri())
        return

    run_step(
        [sys.executable, "src/ai_interpret_metrics.py"],
        "Step 8 / 9 — Generate AI chart insights",
    )

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

    run_step(
        [sys.executable, "src/create_dashboard.py", "--force"],
        "Step 9 / 9 — Re-generate dashboard with insights",
    )

    dashboard_path = Path("output/dashboard.html").resolve()
    print()
    print(f"Dashboard ready: {dashboard_path}")
    import webbrowser
    webbrowser.open(dashboard_path.as_uri())


def main():
    parser = argparse.ArgumentParser(
        prog="aiflowmetrics",
        description="AI Flow Metrics — fetch ADO board data and generate a flow metrics dashboard.",
    )
    subparsers = parser.add_subparsers(dest="command", metavar="<command>")
    subparsers.required = True

    p_conf = subparsers.add_parser(
        "configure",
        help="Fetch ADO data and generate the board config prompt (steps 1–3).",
    )
    p_conf.add_argument("board_url", metavar="<board-url>", help="Azure DevOps board URL")
    p_conf.add_argument("--short-dwell-minutes", type=int, metavar="N", default=None,
                        help="Flag column visits shorter than N minutes as suspicious (default: 60)")
    p_conf.add_argument("--yes", "-y", action="store_true", help="Skip confirmation prompts")
    p_conf.add_argument("--clean", action="store_true",
                        help="Delete all generated output files before running")

    p_met = subparsers.add_parser(
        "metrics",
        help="Calculate flow metrics and generate the dashboard (steps 4–9).",
    )
    p_met.add_argument("config_file", metavar="<config-file>",
                       help="Path to config.json produced by the configure step")
    p_met.add_argument("--window", default="6m", metavar="WINDOW",
                       help="Analysis window: 2w, 1m, 3m, 6m, 1y (default: 6m)")
    p_met.add_argument("--from", dest="date_from", metavar="YYYY-MM-DD",
                       help="Explicit window start date (overrides --window)")
    p_met.add_argument("--to", dest="date_to", metavar="YYYY-MM-DD",
                       help="Explicit window end date (used with --from, default: today)")
    p_met.add_argument("--ai-mode", dest="ai_mode", choices=["prompt", "skip"], default="prompt",
                       help="prompt (default): pause for AI insights; skip: omit step 8")
    p_met.add_argument("--yes", "-y", action="store_true", help="Skip confirmation prompts")
    p_met.add_argument("--clean", action="store_true",
                       help="Delete metrics and dashboard output files before running (keeps config)")

    args = parser.parse_args()

    if args.command == "configure":
        cmd_configure(args)
    elif args.command == "metrics":
        cmd_metrics(args)


if __name__ == "__main__":
    main()
