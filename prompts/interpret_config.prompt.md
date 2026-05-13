---
mode: ask
description: "Flow metrics — interpret board structure and propose config_draft.json"
---

You are helping configure a flow metrics tool for an Azure DevOps Kanban board.

The tool calculates cycle time, lead time, flow efficiency, and blocked time.
Before it can compute metrics, four configuration decisions must be made.

Board structure and card rules: #file:output/data/context.json
Data quality findings: #file:output/data/data_quality_report.json

The script `src/interpret_config.py` also performed an automated analysis.
Its findings are embedded below.

## Board: Backlog items
Org: asos | Project: Customer | Team: Analytics and Experimentation

## Columns
| Name | Type | WIP limit | Dwell (n, avg, median) |
|------|------|-----------|------------------------|
| New | incoming | 0 | n=83, avg=156.0h, median=22.8h |
| Ready for Dev | inProgress | 5 | n=168, avg=90.1h, median=26.5h |
| In Development | inProgress | 5 | n=286, avg=488832.3h, median=22.9h |
| In Review | inProgress | 5 | n=170, avg=2055957.1h, median=137.5h |
| External Review | inProgress | 5 | n=71, avg=151.2h, median=66.8h |
| Ready for QA | inProgress | 3 | n=50, avg=55.1h, median=4.4h |
| QA | inProgress | 3 | n=97, avg=170.1h, median=68.8h |
| Ready for release | inProgress | 5 | n=77, avg=2723434.1h, median=462.4h |
| Closed | outgoing | 0 | n=10, avg=13.5h, median=0.0h |

## Unknown historical columns (no longer on current board)
- QA / External Review

## Blocked signals detected
- {"mechanism": "fill_rule", "name": "Blocked", "filter": "[System.Tags] contains 'blocked'", "background_color": "#EB3345"}
- {"mechanism": "fill_rule", "name": "Hold", "filter": "[System.Tags] contains 'hold'", "background_color": "#43B4D5"}

## Flow efficiency
Always waiting (deterministic): New, Closed

inProgress columns to classify (active or waiting):
- Ready for Dev (avg=90.1h, median=26.5h)
- In Development (avg=488832.3h, median=22.9h)
- In Review (avg=2055957.1h, median=137.5h)
- External Review (avg=151.2h, median=66.8h)
- Ready for QA (avg=55.1h, median=4.4h)
- QA (avg=170.1h, median=68.8h)
- Ready for release (avg=2723434.1h, median=462.4h)

---

## Decisions required

### 1. Lead time clock start
Lead time = customer/request perspective (from intake to done).
Choose ONE of:
- "created_date" — clock starts when the work item was created in ADO
- "board_entry_date" — clock starts when the item first appeared on the board (any column)

### 2. Cycle time clock start
Cycle time = team processing perspective (from active work start to done).
Choose ONE of:
- "board_entry_date" — clock starts when the item first appeared on the board (any column)
- "first_inprogress_entry" — clock starts when the item first entered an inProgress column

### 3. Shared clock end (applies to both lead time and cycle time)
Choose ONE of:
- "outgoing_column" — clock stops when the item enters the board's outgoing column (e.g. Closed)
- "closed_state" — clock stops when the ADO state field becomes "Closed"
- "resolved_state" — clock stops when the ADO state field becomes "Resolved" (warning: maps to pre-QA columns for many work item types on this board — likely too early)

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

## Required output format

Return ONLY a valid JSON object. No markdown fences, no explanation, no preamble.

{
  "_note": "Reviewed and confirmed by user. Edit freely before saving as config.json.",
  "_reasoning": "<optional: the AI's explanation for each choice — remove before saving as config.json>",
  "lead_time": {
    "clock_start": "<created_date | board_entry_date>",
    "clock_end": "<outgoing_column | closed_state | resolved_state>"
  },
  "cycle_time": {
    "clock_start": "<board_entry_date | first_inprogress_entry>",
    "clock_end": "<outgoing_column | closed_state | resolved_state>"
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
