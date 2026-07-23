You are helping configure a flow metrics tool for an Azure DevOps Kanban board.

The tool calculates cycle time, lead time, flow efficiency, and blocked time.
Before it can compute metrics, four configuration decisions must be made.
Analyse the board data below and return a JSON object that resolves all four decisions.

---

{{BOARD_CONTEXT}}
{{DATA_QUALITY}}
{{FINDINGS}}

---

## Decisions required

### 1. Lead time clock start
Lead time = customer/request perspective (from intake to done).
Default: use the incoming column (when the item first appeared on the board).
Only use `created_date` if there is a clear reason the board does not reliably capture the true request date
(e.g. items are bulk-imported long after creation, or the board is used for a subset of a larger intake process).

- `{"type": "column", "value": "<incoming column name>"}` — **preferred default** — clock starts when the item first appeared on the board
- `{"type": "date_field", "value": "created_date"}` — fallback — clock starts when the work item was created in ADO

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
For split columns, the "(Done)" sub-column is always a waiting state (items queue there between
stages) — include it in waiting_columns. Only classify the "(Doing)" sub-columns and any
non-split inProgress columns listed above as active.

### 6. Blocked time detection
List ALL signals this team uses to indicate blocked or waiting items.
Return an array — include every signal you find with reasonable confidence.
Include waiting/on-hold states (e.g. "Waiting - Internal" tags) as well as hard blocks.

For tag signals:
- Use the "tags" field as a LIST of tag strings that all belong to the same concept.
- If multiple tags clearly refer to the same blocking concept (e.g. "Blocked by BAG", "Blocked by PLP"
  are variants of the same type of block), group them into ONE signal with all matching tags listed.
- If tags represent meaningfully different concepts (e.g. "Waiting - Internal" vs "Blocked"), keep
  them as separate signals.
- Use the card rule background_color for each signal's color where available.
- If a tag is in the "tags in use" list but has no card rule, infer a reasonable color (or use null).

Tag signal format:
  {"mechanism": "tag", "tags": ["<tag1>", "<tag2>"], "label": "<display label>", "color": "<hex or null>"}
Other signal formats (non-tag, treated as informational only):
  {"mechanism": "swimlane", "swimlane_name": "<name>", "label": "<display label>", "color": null}
  {"mechanism": "column", "column_name": "<name>", "label": "<display label>", "color": null}
If no signal found, return an empty array [].

### 7. Swimlane mapping
Some items may carry a historical swimlane name that no longer matches the current board.
For each unknown historical swimlane name, provide the current swimlane name it should map to,
or null to leave those items unmapped.
If there are no unknown swimlanes, return an empty object {}.

---

## Required output format

Produce the JSON object, then write it to `output/data/config.json`. Do not print it to chat.

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
      {"mechanism": "tag", "tags": ["<tag1>", "<tag2>"], "label": "<display label>", "color": "<hex or null>"},
      {"mechanism": "swimlane", "swimlane_name": "<name>", "label": "<display label>", "color": null}
    ]
  },
  "swimlane_mapping": {
    "<old swimlane name>": "<current swimlane name, or null to leave unmapped>"
  }
}