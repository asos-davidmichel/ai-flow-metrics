---
mode: ask
description: "Flow metrics — interpret board structure and propose config_draft.json"
---

You are helping configure a flow metrics tool for an Azure DevOps Kanban board.

The tool calculates cycle time, lead time, flow efficiency, and blocked time.
Before it can compute metrics, four configuration decisions must be made.

Board structure and card rules: #file:output/data/context.json
Data quality findings: #file:output/data/data_quality_report.json

The script `src/ai_configure_board.py` also performed an automated analysis.
Its findings are embedded below.

## Board: Backlog items
Org: asos | Project: Customer | Team: Analytics and Experimentation

## Columns
| Name | Type | WIP limit | Dwell (n, avg, median) |
|------|------|-----------|------------------------|
| New | incoming | 0 | n=86, avg=150.6h, median=22.7h |
| Ready for Dev | inProgress | 5 | n=169, avg=90.3h, median=26.5h |
| In Development | inProgress | 5 | n=292, avg=239450.3h, median=22.2h |
| In Review | inProgress | 5 | n=179, avg=2343015.1h, median=118.0h |
| External Review | inProgress | 5 | n=78, avg=143.4h, median=66.8h |
| Ready for QA | inProgress | 3 | n=61, avg=1145737.7h, median=4.6h |
| QA | inProgress | 3 | n=107, avg=653304.1h, median=68.0h |
| Ready for release | inProgress | 5 | n=85, avg=7400311.7h, median=481.0h |
| Closed | outgoing | 0 | n=11, avg=12.3h, median=0.0h |

## Unknown historical columns (no longer on current board)
- QA / External Review

## Blocked signals detected
- {"mechanism": "fill_rule", "name": "Blocked", "filter": "[System.Tags] contains 'blocked'", "background_color": "#EB3345"}
- {"mechanism": "fill_rule", "name": "Hold", "filter": "[System.Tags] contains 'hold'", "background_color": "#43B4D5"}

## Flow efficiency
Always waiting (deterministic): New, Closed

inProgress columns to classify (active or waiting):
- Ready for Dev (avg=90.3h, median=26.5h)
- In Development (avg=239450.3h, median=22.2h)
- In Review (avg=2343015.1h, median=118.0h)
- External Review (avg=143.4h, median=66.8h)
- Ready for QA (avg=1145737.7h, median=4.6h)
- QA (avg=653304.1h, median=68.0h)
- Ready for release (avg=7400311.7h, median=481.0h)

---

## Decisions required

### 1. Lead time clock start
Lead time = customer/request perspective (from intake to done).
Choose ONE of:
- `{"type": "date_field", "value": "created_date"}` — clock starts when the work item was created in ADO
- `{"type": "column", "value": "<incoming column name>"}` — clock starts when the item first appeared on the board

### 2. Cycle time clock start
Cycle time = team processing perspective (from active work start to done).
Choose ONE of:
- `{"type": "column", "value": "<incoming column name>"}` — clock starts when the item first appeared on the board
- `{"type": "column", "value": "<first inProgress column name>"}` — clock starts when the item first entered an inProgress column

### 3. Shared clock end (applies to both lead time and cycle time)
Must be a column. The outgoing column is the standard choice.
- `{"type": "column", "value": "<outgoing column name>"}` — clock stops when the item first entered that column

### 4. Historical column mapping
Some items have history spanning columns that no longer exist on the board.
For each unknown historical column listed above, provide ONE of:
- a current column name to treat it as equivalent to
- null to exclude those spans from metrics entirely

If there are no unknown columns, return an empty object {}.

### 5. Flow efficiency — active vs waiting columns
Classify each inProgress column as "active" (value-adding work happening) or "waiting"
(queue, handoff, or blocked state). Use column names and dwell patterns to guide your choice.
incoming and outgoing columns are always "waiting" — do not include them in your response.
Only classify the inProgress columns listed above.

### 6. Blocked time detection
List ALL signals this team uses to indicate blocked or on-hold items.
Return an array — include every signal you find with reasonable confidence.
Each signal is one of:
  {"mechanism": "swimlane", "swimlane_name": "<name>"}
  {"mechanism": "tag", "tag": "<tag>"}
  {"mechanism": "column", "column_name": "<name>"}
If no signal found, return an empty array [].

---

## Required output

1. Write the configuration directly to `output/data/config.json` using the create/edit file tool.
   Do NOT include `_note` or `_reasoning` fields in the saved file.

2. After saving the file, present a brief Markdown summary to the user with:
   - Each decision and its chosen value in a table
   - A short rationale for any non-obvious choices
   - Any assumptions or items the user may want to reconsider

The JSON structure to write to `output/data/config.json`:

```json
{
  "lead_time": {
    "clock_start": {"type": "<column | date_field>", "value": "<column name or field name>"},
    "clock_end": {"type": "column", "value": "<column name>"}
  },
  "cycle_time": {
    "clock_start": {"type": "column", "value": "<column name>"},
    "clock_end": {"type": "column", "value": "<column name>"}
  },
  "historical_column_mapping": {
    "<old column name>": "<current column name, or null to exclude>"
  },
  "flow_efficiency": {
    "active_columns": ["<column name>"],
    "waiting_columns": ["<column name>"]
  },
  "blocked_time": {
    "signals": [
      {"mechanism": "<swimlane | tag | column>", "<swimlane_name | tag | column_name>": "<value>"}
    ]
  }
}
```
