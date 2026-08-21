# AI Flow Metrics

A VS Code extension that fetches Azure DevOps board data, calculates flow metrics, and generates an interactive dashboard — all from the Activity Bar, with GitHub Copilot doing the two AI steps automatically.

## Requirements

- **Python 3.10+** on your PATH (`python` or `python3`)
- **Azure DevOps Personal Access Token** — read-only access to your board. Either set `ADO_PAT` in your environment, or the extension will prompt you securely on first use.
- **GitHub Copilot** — required for the two AI steps (Configure Board and Interpret Metrics) and the `@flowmetrics` chat participant.

## Getting started

1. Open the **AI Flow Metrics** Activity Bar panel.
2. Click **+** (Add Board) and paste your Azure DevOps board URL.
3. Click **▶ Autoplay** to run the full pipeline automatically, or run each step individually.

---

## The pipeline

The extension runs a six-step pipeline. Each step shows a green tick when done. Steps that are already complete are skipped by Autoplay.

| Step | What it does |
|------|-------------|
| **1 · Fetch Board Context** | Fetches the board structure and column definitions from ADO. |
| **2 · Fetch & Check** | Fetches all work item history, runs data quality checks, and writes `data_quality_report.json`. |
| **3 · Configure Board (AI)** | Uses GitHub Copilot to analyse the board structure and generate `config.json` — clock start/end columns, active vs waiting column classification, and blocker signals. Opens `config.json` for review after writing it. |
| **4 · Calculate Metrics** | Calculates time-in-columns, cycle time, and lead time for the selected analysis window. |
| **5 · Generate Dashboard** | Renders the interactive Chart.js dashboard to `dashboard.html` and opens it in the preview panel. |
| **6 · Interpret Metrics (AI)** | Uses GitHub Copilot to write a chart-by-chart analysis with evidence, watch-outs, and a leadership narrative. Re-generates the dashboard with insights embedded. |

### Analysis window

The default window is the last 6 months. Click the window label next to **Step 4** to change it:

- Rolling periods: 4 weeks, 3 months, 6 months, 1 year
- Custom date range: pick a start and end date

The window setting is persisted per board. Re-run Step 4 after changing it.

### Re-running steps

Individual steps can be re-run at any time. Step 3 (Configure Board) asks before overwriting an existing `config.json` — choose **Regenerate dashboard only** to re-inject existing insights without calling the AI again.

---

## Boards panel

The **Boards** panel lists all your boards. Expand a board to see its output files and when each was last generated. Click any file to open a formatted preview.

- **Add** — paste any Azure DevOps board URL (`https://dev.azure.com/org/project/_boards/...`)
- **Remove** — deletes the board and all its output files
- **Clear output** — deletes output files but keeps the board registered

Multiple boards are supported. The active board (shown with a filled circle) drives the Pipeline and Publish panels.

---

## @flowmetrics chat

Type `@flowmetrics` in GitHub Copilot Chat to ask questions about your board data:

- *"What is our current P85 cycle time?"*
- *"Which items have been in progress the longest?"*
- *"Show me blockers from the last month."*
- *"Change the cycle time clock start to the Refinement column."*

The participant reads your cached output files and can fetch live work item data directly from ADO when the cached data may be stale. It can also update `config.json` when you ask it to change column classifications or blocker signals.

---

## @flowlearn chat

Type `@flowlearn` to teach the AI how to interpret your team's metrics. Learnings are saved per board and injected into the AI context the next time **Step 6 — Interpret Metrics** runs.

Examples:

- *"Don't flag March throughput dips — those are always hackathon weeks"*
- *"Our team calls cycle time 'delivery time' — use that term in insights"*
- *"High WIP in the Review column is normal for us, not a blocker"*

Learnings are stored in `output/data/interpretation_learnings.json` and can be edited or deleted at any time. Re-run Step 6 to apply changes.

---

## GitHub publishing

Connect a board to a GitHub repository to publish the dashboard as a GitHub Pages site and schedule automatic daily or weekly updates via GitHub Actions.

1. Open the **Publish** panel and click **Publish to GitHub**.
2. Choose an existing repo or let the extension create one.
3. Optionally configure a schedule — the workflow runs `fetch → check → calculate → interpret → publish` on cron.

A `sync` indicator in the Boards panel shows whether your local files are up to date with the latest commit in the linked repo.

---

## Data & privacy

All board data is stored locally in VS Code's extension storage (`~/.vscode/extensions/...`). Nothing is sent anywhere except:

- ADO API calls when fetching board data (using your PAT)
- GitHub Copilot API calls during the two AI steps (metrics data only — no work item titles or assignees)
- GitHub API calls when publishing

Your ADO PAT is stored in VS Code's encrypted secret storage.

## Known Issues

Calling out known issues can help limit users opening duplicate issues against your extension.

## Release Notes

Users appreciate release notes as you update your extension.

### 1.0.0

Initial release of ...

### 1.0.1

Fixed issue #.

### 1.1.0

Added features X, Y, and Z.

---

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
