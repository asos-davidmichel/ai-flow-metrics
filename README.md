# AI Flow Metrics

A Python + Chart.js tool that fetches work item data from **Azure DevOps**, calculates flow metrics, and generates a self-contained HTML dashboard.

![Dashboard screenshot](docs/screenshot.png)

> *Flow tab showing CFD, Arrival/Departure ratio, Net Flow, and Time in Columns*

## What it produces

- **Cycle time** — histogram, P85, trend, and breakdown by work item type
- **Lead time** — same shape as cycle time, covering the full intake-to-done journey
- **Throughput** — weekly completions with trend line
- **Time in columns** — where work spends time and where the bottleneck is
- **Flow efficiency** — ratio of active time to total cycle time
- **Work start efficiency** — how long items wait before development begins
- **WIP** — current in-progress items by column, with limit violations
- **Blockers** — blocked and on-hold items, days lost, timeline, and by-column breakdown
- **Cumulative Flow Diagram** — with toggleable columns and dynamic arrival/departure rate lines
- **Net flow** — items finished minus items started each week
- **Arrival/Departure ratio** — per column, to identify accumulation points
- **Aging WIP and scatter** — item age by column and scatter plot
- **Bug flow** — separate bug creation vs completion view

---

## Prerequisites

- Python 3.10+
- An Azure DevOps **Personal Access Token** with read access to the board
- Set the environment variable: `ADO_PAT=<your-token>`

---

## Quickstart

```bash
# First run — fetch data and generate the dashboard
python run.py https://dev.azure.com/your-org/your-project/_boards/board/t/your-team/...

# Subsequent runs (data already fetched, just regenerate the dashboard)
python src/create_dashboard.py
```

---

## Pipeline steps

`run.py` orchestrates the full pipeline. You can also run each step individually.

| Step | Script | What it does |
|------|--------|--------------|
| 1 | `src/fetch_data.py` | Fetches board context, work items, and full column + tag history from ADO |
| 2 | `src/check_data.py` | Runs data quality checks; writes `data_quality_report.json`, `excluded_items.json`, `work_item_rework.json` |
| 3 | `src/ai_configure_board.py` | Generates an AI prompt to propose `config_draft.json` |
| — | *(manual)* | Review `config_draft.json`, edit if needed, save as `config.json` |
| 4 | `src/calc_columns.py` | Calculates time-in-columns → `output/metrics/time_in_columns.json` |
| 5 | `src/calc_cycle_time.py` | Calculates cycle time and throughput → `output/metrics/cycle_time.json` |
| 6 | `src/calc_lead_time.py` | Calculates lead time → `output/metrics/lead_time.json` |
| 7 | `src/create_dashboard.py` | Renders everything into `output/dashboard.html` |

Steps 4–6 require `output/data/config.json` to exist.

### Options

```
--window 6m       Analysis window: 1m, 3m, 6m, 1y (default: 6m)
--clean           Delete all generated output files before running
--short-dwell-minutes N   Threshold (minutes) for flagging suspiciously short column visits
```

---

## AI interpretation

Two scripts generate AI prompts for interpretation. Both support the same `--mode` flag:

| Mode | Output |
|------|--------|
| `copilot` (default) | Writes a `.prompt.md` and opens it in VS Code |
| `prompt` | Writes a `.txt` file to paste into any AI assistant |
| `openai` | Calls the OpenAI API directly (requires `OPENAI_API_KEY`) |

**Config interpretation** — proposes column classification, flow efficiency rules, and blocker signals:
```bash
python src/ai_configure_board.py --mode prompt
```

**Metrics interpretation** — generates chart-by-chart insights and a leadership narrative:
```bash
python src/ai_interpret_metrics.py --mode prompt
python src/ai_interpret_metrics.py --dump-summary   # inspect anonymised metrics JSON
```

![Chart insight box](docs/screenshot_insight.png)

> *Each chart has a collapsible AI insight box with evidence and a watch-out signal*

![AI analysis overview](docs/screenshot_analysis.png)

> *Overview tab: AI-generated diagnostic findings, outlier patterns, investigation questions, and recommendations*

After running in `openai` mode, save the response to `output/data/insights.json` — the dashboard will pick it up automatically on the next `python src/dashboard.py`.

---

## Output files

```
output/
  dashboard.html              Single-file dashboard (open in any browser)
  data/
    context.json              Board structure, columns, work item type styles
    work_items.json           Current state of all work items
    work_item_history.json    Full column + tag change history
    config.json               Your confirmed flow metric configuration
    insights.json             AI-generated chart insights (optional)
  metrics/
    cycle_time.json
    time_in_columns.json
```

---

## Configuration (`config.json`)

Key fields:

```json
{
  "cycle_time": {
    "clock_start": { "type": "column", "value": "Ready for Dev" },
    "clock_end":   { "type": "column", "value": "Closed" }
  },
  "flow_efficiency": {
    "active_columns":  ["In Development", "In Review", "QA"],
    "waiting_columns": ["Ready for Dev", "External Review", "Ready for QA", "Ready for release"]
  },
  "blocked_signals": {
    "tags": ["blocked", "on hold"]
  }
}
```

`config_draft.json` is proposed by `ai_configure_board.py`. Copy it to `config.json` once you're happy with it.
