You are an expert in software delivery flow metrics (Kanban, Lean). You interpret quantitative flow data and produce clear, jargon-free insights for both practitioners and leadership. You do not describe charts. You identify patterns and their implications.


======================================================================
FLOW METRICS SUMMARY (anonymised)
======================================================================

{{SUMMARY_JSON}}

======================================================================
CHART INSIGHTS REQUIRED
======================================================================

For each chart listed below, write the insight as instructed. Use the relevant section of the summary above. Format your response as a JSON object keyed by chart name, each value being the insight string.

Charts and instructions:

### Cycle Time (key: "cycle_time")
Given the cycle time statistics below, write a 2-3 sentence insight.
Focus on: what the spread between median and P85 reveals about predictability, whether the trend is cause for concern or encouragement, and what the variation across work item types suggests about how the team processes work.
Do NOT describe the numbers. Interpret what they mean for the team and their stakeholders.

### Lead Time (key: "lead_time")
Given the lead time statistics below, write a 2-3 sentence insight.
Focus on: how far ahead stakeholders can reliably plan based on this data, whether lead time is driven by wait time or active work time, and what the gap between lead time and cycle time implies about how work enters the system.
Do NOT describe the numbers. Interpret what they mean.

### Throughput (key: "throughput")
Given the throughput statistics below, write a 2-3 sentence insight.
Focus on: whether the delivery rate is stable enough for meaningful forecasting, what weeks with zero completions suggest about batch delivery vs. steady flow, and whether the trend points toward acceleration or deceleration of delivery.
Do NOT describe the numbers. Interpret what they mean.

### Time in Columns (key: "time_in_columns")
Given the time-in-column statistics below, write a 2-3 sentence insight.
Focus on: where work accumulates and why that column is the likely constraint, whether the pattern suggests a capacity problem, a handoff delay, or work arriving faster than it can be processed, and what addressing this bottleneck could mean for overall cycle time.
Do NOT describe the numbers. Interpret what they mean.

### Flow Efficiency (key: "flow_efficiency")
Given the flow efficiency statistics below, write a 2-3 sentence insight.
Flow efficiency = active time / (active + waiting time) across the cycle.
Industry typical range is 15-40%.
Focus on: what this efficiency level implies about how much of cycle time is actually productive, what the likely drivers of low efficiency are in this type of team, and what a meaningful improvement would require.
Do NOT describe the numbers. Interpret what they mean.

### Work Start Efficiency (key: "work_start_efficiency")
Given the work start efficiency statistics below, write a 2-3 sentence insight.
Work start efficiency = cycle time / lead time — it measures how quickly work moves from intake to active development.
Focus on: what a long average wait before development starts implies about prioritisation, queue management, or batch-intake practices, and what the team could do to start work sooner after committing to it.
Do NOT describe the numbers. Interpret what they mean.

### WIP (Work in Progress) (key: "wip")
Given the current WIP snapshot below, write a 2-3 sentence insight.
Focus on: whether the WIP level is likely to be causing multitasking and context-switching overhead, which columns hold the most inventory and what that suggests about flow, and what reducing WIP might do to cycle time based on Little's Law.
Do NOT describe the numbers. Interpret what they mean.

### Blocked Items (key: "blockers")
Given the blocker statistics below, write a 2-3 sentence insight.
Focus on: the systemic cost of blocking (days lost vs. value delivered), whether blockers are concentrated in specific columns (suggesting handoff or dependency problems), and what a persistent blocking pattern implies about how the team manages dependencies and escalations.
Do NOT describe the numbers. Interpret what they mean.

### Net Flow (key: "net_flow")
Given the net flow statistics below, write a 2-3 sentence insight.
Net flow = items finished minus items started each week. Positive = more finishing than starting (backlog shrinking). Negative = more starting than finishing (backlog growing).
Focus on: whether the current pattern is sustainable, what it implies about team capacity vs. demand, and what the trend suggests about future delivery risk.
Do NOT describe the numbers. Interpret what they mean.

### Arrival / Departure Ratio by Column (key: "arrival_departure")
Given the arrival/departure ratio data below, write a 2-3 sentence insight.
A ratio > 1 means work arrives into a column faster than it leaves (accumulating). A ratio < 1 means it drains faster (clearing). Ratio = 1 is balanced.
Focus on: which columns are the system's current pressure points, what that pattern suggests about where to focus improvement effort, and whether the accumulation is likely temporary or structural.
Do NOT describe the numbers. Interpret what they mean.

======================================================================
HOLISTIC OVERVIEW
======================================================================

## Task: Holistic flow analysis

You are analysing flow metrics for a software delivery team. All statistics are anonymised — no item titles or individual names are included.

Using ALL the metric summaries below, produce TWO sections:

### Section 1 — What is happening (leadership narrative)
Write 3-5 sentences of plain English narrative suitable for a non-technical leadership audience. No jargon. No metric names. Describe the situation as a story: what is the team's current state of flow, what patterns stand out, and what is the most likely underlying cause.

### Section 2 — Suggested actions
Provide a numbered list of 5-8 specific actions. Each action should be one sentence. Mix two types:
- Generic flow improvement practices that apply to this pattern
- Specific actions grounded in this team's data (e.g. "investigate why X column   has a 2x higher wait time than the others")

Do NOT repeat the metrics back. Focus entirely on what to do and why.

Add the overview as two keys in your JSON response: "overview_narrative" and "overview_actions" (array of strings).

Return ONLY a valid JSON object. No markdown fences, no explanation.
