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
- **Blockers** — impeded items by signal type, days lost, timeline, and by-column breakdown
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

```mermaid
flowchart TD
  fetch["1 · Fetch ticket data\n`fetch_data.py`"]:::script
  check["2 · Data quality checks\n`check_data.py`"]:::script
  aiconf{{"3 · Generate configure-board prompt\n`ai_configure_board.py`"}}:::humanai
  review["· Human + AI review\nRun prompt → approve config.json"]:::human
  calc["4–6 · Calculate flow metrics\ncalc_columns · calc_cycle_time · calc_lead_time"]:::script
  dash["7 · Create dashboard\n`create_dashboard.py`"]:::script
  insights{{"8 · Generate insights prompt\n`ai_interpret_metrics.py`"}}:::humanai
  redash["9 · Re-generate dashboard with insights\n`create_dashboard.py`"]:::script

  fetch --> check --> aiconf --> review -->|"config ok"| calc --> dash --> insights --> redash

  classDef script   fill:#667eea,color:#fff,stroke:#4c51bf
  classDef humanai  fill:#9f7aea,color:#fff,stroke:#6b46c1
  classDef human    fill:#e2e8f0,color:#2d3748,stroke:#a0aec0
```

| Step | Script | What it does |
|------|--------|--------------|
| 1 | `src/fetch_data.py` | Fetches board context, work items, and full column + tag history from ADO |
| 2 | `src/check_data.py` | Runs data quality checks; writes `data_quality_report.json`, `excluded_items.json`, `work_item_rework.json` |
| 3 | `src/ai_configure_board.py` | Generates an AI prompt to configure the board |
| — | *(human + AI)* | Run the AI prompt; save the JSON response as `config.json` |
| 4 | `src/calc_columns.py` | Calculates time-in-columns → `output/metrics/time_in_columns.json` |
| 5 | `src/calc_cycle_time.py` | Calculates cycle time and throughput → `output/metrics/cycle_time.json` |
| 6 | `src/calc_lead_time.py` | Calculates lead time → `output/metrics/lead_time.json` |
| 7 | `src/create_dashboard.py` | Renders everything into `output/dashboard.html` |
| 8 *(optional)* | `src/ai_interpret_metrics.py` | Generates AI chart insights → `output/data/insights.json` |
| 9 *(optional)* | `src/create_dashboard.py` | Re-renders dashboard with insights embedded into each chart |

Steps 4–6 require `output/data/config.json` to exist.

### `run.py` options

| Option | Default | Description |
|--------|---------|-------------|
| `--window 6m` | `6m` | Analysis window for metrics. Accepts `2w`, `1m`, `3m`, `6m`, `1y`. |
| `--from YYYY-MM-DD` | — | Explicit window start date (overrides `--window`). |
| `--to YYYY-MM-DD` | today | Explicit window end date (used with `--from`). |
| `--clean` | off | Delete all generated output files before running. |
| `--yes` | off | Skip all confirmation prompts (required for fully automated runs). |
| `--short-dwell-minutes N` | `60` | Flag column visits shorter than N minutes as suspicious in the data quality report. |
| `--ai-mode MODE` | `prompt` | `prompt` (default) or `skip`. `skip` omits step 8 (insights) and re-generates the dashboard without them. |

**Example:**
```bash
python run.py https://dev.azure.com/org/project/_boards/... --window 3m --clean
```

---

## AI interpretation

Two scripts generate `.prompt.md` files that open automatically in VS Code Copilot (or can be pasted into any AI assistant). The AI reads the file and writes the output JSON directly.

### Board configuration

Proposes column classification, flow efficiency rules, and blocker tag signals. Run this before setting up `config.json`.

```bash
python src/ai_configure_board.py
```

### Metrics interpretation

Generates chart-by-chart insights and a leadership narrative that are embedded in the dashboard.

```bash
python src/ai_interpret_metrics.py
python src/ai_interpret_metrics.py --dump-summary    # print the anonymised metrics JSON sent to the AI
```

<img src="docs/screenshot_insight.png" width="450" alt="Chart insight box">

> *Each chart has a collapsible insight box with evidence and a watch-out signal*

![AI analysis overview](docs/screenshot_analysis.png)

> *Overview tab: AI-generated diagnostic findings, outlier patterns, investigation questions, and recommendations*

---

## Output files

```
output/
  dashboard.html              Single-file dashboard (open in any browser)
  data/
    context.json              Board structure, columns, work item type styles
    work_items.json           Current state of all work items
    work_item_history.json    Full column + tag change history
    work_item_rework.json     Items that moved backwards through columns
    data_quality_report.json  Data quality check results
    excluded_items.json       Items excluded from metrics (missing history etc.)
    config.json               Your confirmed flow metric configuration
    insights.json             AI-generated chart insights (optional)
  metrics/
    cycle_time.json
    lead_time.json
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
  "blocked_time": {
    "signals": [
      { "mechanism": "tag", "tags": ["Blocked", "Blocked by BAG", "Blocked by PLP"], "label": "Blocked",           "color": "#f06673" },
      { "mechanism": "tag", "tags": ["Waiting - Internal"],                           "label": "Waiting Internal", "color": "#ffe0c1" }
    ]
  }
}
```

`config.json` is produced by running `ai_configure_board.py`. The AI detects blocked signals from card rules and actual tags in use, and can merge tag variants into a single signal (e.g. "Blocked by BAG" + "Blocked by PLP" → one "Blocked" entry). Each signal has a `label` (shown in charts) and a `color` (from the card rule background colour).
