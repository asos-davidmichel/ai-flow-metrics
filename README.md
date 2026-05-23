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
  ADO[("☁ Azure DevOps\n(board URL + PAT)")]:::external

  subgraph main["Main pipeline — steps 1–7"]
    fetch["1 · fetch_data.py\n📄 context.json · work_items.json · work_item_history.json"]:::script
    check["2 · check_data.py\n📄 data_quality_report.json · excluded_items.json · work_item_rework.json"]:::script
    aiconf["3 · ai_configure_board.py"]:::script
    aiconfprompt{{"🤖✎ Run AI prompt\n→ save response as config.json"}}:::humanai
    autoconf["OpenAI-compatible API\nauto-writes config.json"]:::autoai
    calccol["4 · calc_columns.py  →  📄 time_in_columns.json"]:::script
    calcct["5 · calc_cycle_time.py  →  📄 cycle_time.json"]:::script
    calclt["6 · calc_lead_time.py  →  📄 lead_time.json"]:::script
    dash["7 · create_dashboard.py  →  📄 dashboard.html"]:::script
    out(["🌐 dashboard.html (basic)"]):::output

    fetch --> check --> aiconf
    aiconf -->|"--mode copilot / prompt"| aiconfprompt --> calccol
    aiconf -->|"--mode openai"| autoconf --> calccol
    calccol --> calcct --> calclt --> dash --> out
  end

  subgraph opt["Optional — AI chart insights (step 8 + re-run 7)"]
    aimetrics["8 · ai_interpret_metrics.py"]:::script
    savemetrics{{"🤖✎ Run AI prompt\n→ save response as insights.json"}}:::humanai
    autoinsights["OpenAI-compatible API\nauto-writes insights.json"]:::autoai
    insights[/"insights.json"/]:::file
    redash["re-run 7 · create_dashboard.py  →  📄 dashboard.html"]:::script
    out2(["🌐 dashboard.html (with AI insights)"]):::output

    aimetrics -->|"--mode copilot / prompt"| savemetrics --> insights
    aimetrics -->|"--mode openai"| autoinsights --> insights
    insights --> redash --> out2
  end

  ADO -->|"reads via REST API"| fetch
  out -->|"then optionally"| aimetrics

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
| 3 | `src/ai_configure_board.py` | Generates an AI prompt to configure the board |
| — | *(human + AI)* | Run the AI prompt; save the JSON response as `config.json` |
| 4 | `src/calc_columns.py` | Calculates time-in-columns → `output/metrics/time_in_columns.json` |
| 5 | `src/calc_cycle_time.py` | Calculates cycle time and throughput → `output/metrics/cycle_time.json` |
| 6 | `src/calc_lead_time.py` | Calculates lead time → `output/metrics/lead_time.json` |
| 7 | `src/create_dashboard.py` | Renders everything into `output/dashboard.html` |
| 8 *(optional)* | `src/ai_interpret_metrics.py` | Generates AI chart insights → `output/data/insights.json`; re-run step 7 to embed them |

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
| `--interpret-mode MODE` | `copilot` | AI mode for board configuration — see [AI modes](#ai-modes) below. |
| `--insights-mode MODE` | `copilot` | AI mode for chart insights — see [AI modes](#ai-modes) below. |

**Fully automated run (no human interaction):**
```bash
# Requires OPENAI_API_KEY (and optionally OPENAI_BASE_URL, OPENAI_MODEL)
python run.py https://dev.azure.com/... --interpret-mode openai --insights-mode openai --yes
```

**Default interactive run:**
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
| `openai` | Calls an OpenAI-compatible API directly and writes the output automatically. Requires `OPENAI_API_KEY`. |

**Environment variables for `openai` mode:**

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | *(required)* | API key — OpenAI key, GitHub PAT, Azure key, etc. |
| `OPENAI_MODEL` | `gpt-4o` | Model name (e.g. `gpt-4o`, `claude-sonnet-4-5`). |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Base URL for any OpenAI-compatible endpoint. |

**Compatible endpoints:**

| Provider | `OPENAI_BASE_URL` | Auth |
|----------|-------------------|------|
| OpenAI | `https://api.openai.com/v1` *(default)* | OpenAI API key |
| GitHub Models | `https://models.inference.ai.azure.com` | GitHub PAT |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<deployment>` | Azure key |

### Board configuration

Proposes column classification, flow efficiency rules, and blocker tag signals. Run this before setting up `config.json`.

```bash
python src/ai_configure_board.py                     # opens in VS Code Copilot (default)
python src/ai_configure_board.py --mode prompt       # writes a .txt file to paste elsewhere
python src/ai_configure_board.py --mode openai       # calls API directly → writes config.json
```

### Metrics interpretation

Generates chart-by-chart insights and a leadership narrative that are embedded in the dashboard.

```bash
python src/ai_interpret_metrics.py                   # opens in VS Code Copilot (default)
python src/ai_interpret_metrics.py --mode prompt     # writes a .txt file to paste elsewhere
python src/ai_interpret_metrics.py --mode openai     # calls API directly → writes insights.json
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
  "blocked_time": {
    "signals": [
      { "mechanism": "tag", "tags": ["Blocked", "Blocked by BAG", "Blocked by PLP"], "label": "Blocked",           "color": "#f06673" },
      { "mechanism": "tag", "tags": ["Waiting - Internal"],                           "label": "Waiting Internal", "color": "#ffe0c1" }
    ]
  }
}
```

`config.json` is produced by running `ai_configure_board.py`. The AI detects blocked signals from card rules and actual tags in use, and can merge tag variants into a single signal (e.g. "Blocked by BAG" + "Blocked by PLP" → one "Blocked" entry). Each signal has a `label` (shown in charts) and a `color` (from the card rule background colour).
