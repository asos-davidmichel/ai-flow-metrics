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

```mermaid
flowchart TD
    ADO[("☁ Azure DevOps\nboard URL + PAT")]:::external

    fetch["1 · fetch_data.py\nFetch board context & work items"]:::script
    check["2 · check_data.py\nData quality checks"]:::script
    aiconf["3 · ai_configure_board.py\nBuild board config prompt"]:::script
    aiconfprompt{{"🤖✎ Run AI prompt → review config_draft.json\n→ edit if needed → save as config.json"}}:::humanai
    calccol["4 · calc_columns.py\nTime in columns"]:::script
    calcct["5 · calc_cycle_time.py\nCycle time & throughput"]:::script
    calclt["6 · calc_lead_time.py\nLead time"]:::script
    dash["7 · create_dashboard.py\nRender dashboard"]:::script
    out(["🌐 dashboard.html"]):::output

    aimetrics["ai_interpret_metrics.py\nBuild metrics interpretation prompt"]:::script
    savemetrics{{"🤖✎ Run AI prompt → save response\nas insights.json"}}:::humanai
    autoinsights["OpenAI API\nauto-writes insights.json"]:::autoai
    insights[("insights.json")]:::file

    ADO -->|"reads via REST API"| fetch
    fetch --> check --> aiconf --> aiconfprompt
    aiconfprompt --> calccol --> calcct --> calclt --> dash
    aimetrics -->|"--mode copilot / prompt"| savemetrics
    aimetrics -->|"--mode openai"| autoinsights
    savemetrics --> insights
    autoinsights --> insights
    insights -.->|"optional enrichment"| dash
    dash --> out

    classDef script  fill:#667eea,color:#fff,stroke:#4c51bf
    classDef humanai fill:#9f7aea,color:#fff,stroke:#6b46c1
    classDef autoai  fill:#48bb78,color:#fff,stroke:#276749
    classDef external fill:#e2e8f0,color:#2d3748,stroke:#a0aec0
    classDef file    fill:#f7fafc,color:#4a5568,stroke:#cbd5e0
    classDef output  fill:#fefcbf,color:#744210,stroke:#d69e2e
```

> 🟦 Automated script &nbsp;·&nbsp; 🟣 Human-in-the-loop with AI &nbsp;·&nbsp; 🟩 Fully automated AI &nbsp;·&nbsp; ⬜ External system

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

### `run.py` options

| Option | Default | Description |
|--------|---------|-------------|
| `--window 6m` | `6m` | Analysis window for metrics. Accepts `1m`, `3m`, `6m`, `1y`. |
| `--clean` | off | Delete all generated output files before running. |
| `--short-dwell-minutes N` | `60` | Flag column visits shorter than N minutes as suspicious in the data quality report. |
| `--interpret-mode MODE` | `copilot` | AI mode for board configuration step — see [AI modes](#ai-modes) below. |

**Example:**
```bash
python run.py https://dev.azure.com/org/project/_boards/... --window 3m --clean
```

---

## AI interpretation

Two scripts generate AI prompts. Both support a `--mode` flag.

### AI modes

| Mode | What happens |
|------|--------------|
| `copilot` *(default)* | Writes a `.prompt.md` file and opens it in VS Code Copilot chat. |
| `prompt` | Writes a `.txt` file you can paste into any AI assistant (ChatGPT, Claude, etc.). |
| `openai` | Calls the OpenAI API directly and writes the response to `insights.json`. Requires `OPENAI_API_KEY`. |

### Board configuration

Proposes column classification, flow efficiency rules, and blocker tag signals. Run this before setting up `config.json`.

```bash
python src/ai_configure_board.py                     # opens in VS Code Copilot (default)
python src/ai_configure_board.py --mode prompt       # writes a .txt file to paste elsewhere
python src/ai_configure_board.py --mode openai       # calls OpenAI API directly
```

### Metrics interpretation

Generates chart-by-chart insights and a leadership narrative that are embedded in the dashboard.

```bash
python src/ai_interpret_metrics.py                   # opens in VS Code Copilot (default)
python src/ai_interpret_metrics.py --mode prompt     # writes a .txt file to paste elsewhere
python src/ai_interpret_metrics.py --mode openai     # calls OpenAI API directly
python src/ai_interpret_metrics.py --dump-summary    # print the anonymised metrics JSON sent to the AI
```

After running in `copilot` or `prompt` mode, save the AI response to `output/data/insights.json` — the dashboard picks it up automatically on the next `python src/create_dashboard.py`.

After running in `openai` mode, `insights.json` is written automatically.

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
