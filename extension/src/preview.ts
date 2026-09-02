import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// ── Helpers ────────────────────────────────────────────────────────────────

function esc(s: unknown): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function fmtDate(iso: string): string {
    try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch { return iso; }
}

function fmtNum(n: number, decimals = 1): string {
    return n == null ? '—' : n.toFixed(decimals);
}

const COLUMN_TYPE_CLASS: Record<string, string> = {
    incoming: 'badge-incoming',
    inProgress: 'badge-active',
    outgoing: 'badge-done',
};

// ── Shared CSS ─────────────────────────────────────────────────────────────

const SHARED_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    padding: 20px 24px 40px;
    max-width: 900px;
}
h1 { font-size: 1.4em; font-weight: 600; margin-bottom: 6px; }
h2 { font-size: 1.05em; font-weight: 600; margin: 20px 0 8px; color: var(--vscode-editor-foreground); }
h3 { font-size: 0.95em; font-weight: 600; margin: 12px 0 6px; }
p { margin-bottom: 8px; line-height: 1.5; }
a { color: var(--vscode-textLink-foreground); text-decoration: none; }
a:hover { text-decoration: underline; }
section { margin-bottom: 24px; }
details { margin-top: 8px; }
summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 0.9em; user-select: none; }
summary:hover { color: var(--vscode-editor-foreground); }

.meta { color: var(--vscode-descriptionForeground); font-size: 0.88em; margin-bottom: 16px; }
.meta span + span::before { content: ' · '; }

.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
.chip {
    display: inline-block; padding: 2px 10px; border-radius: 12px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    font-size: 0.85em;
}
.chip-team { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

.badge {
    display: inline-block; padding: 1px 7px; border-radius: 4px; font-size: 0.8em;
    vertical-align: middle;
}
.badge-incoming { background: #5a5a5a22; color: var(--vscode-descriptionForeground); }
.badge-active    { background: #0078d422; color: #4dabf7; }
.badge-done      { background: #28a74522; color: #69db7c; }
.badge-warn      { background: #fd7e1422; color: #ffa94d; }

table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
th { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); font-weight: 600; }
td { padding: 5px 10px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
tr:last-child td { border-bottom: none; }
tr:hover td { background: var(--vscode-list-hoverBackground); }

.stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 12px; margin: 16px 0; }
.stat {
    display: flex; flex-direction: column; align-items: center;
    padding: 12px 8px; border-radius: 6px;
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-panel-border);
}
.stat .val { font-size: 1.5em; font-weight: 700; }
.stat .lbl { font-size: 0.78em; color: var(--vscode-descriptionForeground); margin-top: 2px; }

.checks { display: flex; flex-direction: column; gap: 8px; }
.check { padding: 8px 12px; border-radius: 6px; border-left: 3px solid; }
.check-ok   { background: #28a74508; border-color: #28a745; }
.check-warn { background: #fd7e1408; border-color: #fd7e14; }
.check-ok   .check-title { color: #69db7c; }
.check-warn .check-title { color: #ffa94d; }
.check-title { font-weight: 600; }
.check details { margin-top: 6px; }

.insight-card {
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px; padding: 16px; margin-bottom: 16px;
}
.insight-card h2 { margin-top: 0; font-size: 1em; text-transform: capitalize; }
.insight-text { margin: 8px 0 12px; line-height: 1.6; }
.evidence { list-style: none; margin-bottom: 12px; }
.evidence li { padding: 3px 0 3px 20px; position: relative; line-height: 1.4; }
.evidence li::before { content: '✓'; position: absolute; left: 0; color: #69db7c; font-weight: 700; }
.watch-out {
    background: #fd7e1412; border-left: 3px solid #fd7e14; border-radius: 0 4px 4px 0;
    padding: 8px 12px; font-size: 0.88em; line-height: 1.5;
}

.learning-card {
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-panel-border);
    border-left: 4px solid var(--vscode-textLink-foreground);
    border-radius: 6px; padding: 14px 16px; margin-bottom: 12px;
    transition: box-shadow 0.2s;
}
.learning-card:hover {
    box-shadow: 0 2px 8px var(--vscode-textLink-foreground)22;
}
.learning-card p { margin: 8px 0 0; line-height: 1.6; }
.learning-meta {
    display: flex; align-items: center; gap: 8px;
    font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-bottom: 6px;
}
.learning-date {
    background: var(--vscode-button-background)40; padding: 2px 8px; border-radius: 4px;
    font-size: 0.75em; font-weight: 500;
}
.learning-board {
    background: #0078d425; color: #4dabf7; padding: 2px 8px; border-radius: 4px;
    font-size: 0.75em; font-weight: 500;
}
.learnings-empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 20px 0; }

.search-row { margin-bottom: 12px; }
.search-row input {
    width: 100%; max-width: 400px; padding: 5px 10px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border); border-radius: 4px;
    font-family: inherit; font-size: inherit;
}

.type-dot {
    display: inline-block; width: 9px; height: 9px; border-radius: 50%;
    margin-right: 5px; vertical-align: middle;
}

.tag {
    display: inline-block; padding: 0 6px; border-radius: 10px; font-size: 0.78em;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    margin: 1px 2px;
}
`;

// ── Base wrapper ────────────────────────────────────────────────────────────

function baseHtml(nonce: string, title: string, body: string, extraJs = '', imgSrc = '', cspSource = ''): string {
    const src = cspSource ? ` ${cspSource}` : '';
    const csp = `default-src 'none'; style-src 'nonce-${nonce}'${src}; script-src 'nonce-${nonce}'${src}${imgSrc ? `; img-src ${imgSrc}${src}` : ''};`;
    // Signal readiness so openPreview can detect service worker failures (vscode#125993)
    const readySignal = `<script nonce="${nonce}">try{acquireVsCodeApi().postMessage({type:'__ready'});}catch(e){}</script>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(title)}</title>
    <style nonce="${nonce}">${SHARED_CSS}</style>
</head>
<body>
${body}
${extraJs ? `<script nonce="${nonce}">${extraJs}</script>` : ''}
${readySignal}
</body>
</html>`;
}

// ── Renderers ───────────────────────────────────────────────────────────────

function renderContext(data: any, nonce: string, cspSource = ''): string {
    const cols = (data.columns ?? []).map((c: any) => {
        const cls = COLUMN_TYPE_CLASS[c.column_type] ?? 'badge-incoming';
        const wip = c.wip_limit > 0 ? String(c.wip_limit) : '—';
        const split = c.is_split ? ' <span class="badge badge-warn">split</span>' : '';
        return `<tr>
            <td>${esc(c.name)}${split}</td>
            <td><span class="badge ${cls}">${esc(c.column_type)}</span></td>
            <td>${esc(wip)}</td>
        </tr>`;
    }).join('\n');

    const body = `
<h1>${esc(data.team ?? 'Board Context')}</h1>
<div class="chips">
    <span class="chip">${esc(data.org)}</span>
    <span class="chip">${esc(data.project)}</span>
    <span class="chip chip-team">${esc(data.team)}</span>
</div>
<div class="meta">
    <span>Board: ${esc(data.board?.name)}</span>
    ${data.board_url ? `<span><a href="${esc(data.board_url)}" target="_blank">${esc(data.board_url)}</a></span>` : ''}
</div>

<section>
    <h2>Columns (${(data.columns ?? []).length})</h2>
    <table>
        <thead><tr><th>Column</th><th>Type</th><th>WIP Limit</th></tr></thead>
        <tbody>${cols}</tbody>
    </table>
</section>`;

    return baseHtml(nonce, 'Board Context', body, '', '', cspSource);
}

function renderConfig(data: any, nonce: string, cspSource = ''): string {
    const clockRow = (label: string, cfg: any) => {
        if (!cfg) { return ''; }
        return `<tr>
            <td><strong>${esc(label)}</strong></td>
            <td class="badge badge-active">${esc(cfg.clock_start?.value)}</td>
            <td style="padding: 5px 6px; color: var(--vscode-descriptionForeground);">→</td>
            <td class="badge badge-done">${esc(cfg.clock_end?.value)}</td>
        </tr>`;
    };

    const chips = (cols: string[], cls: string) =>
        (cols ?? []).map(c => `<span class="chip ${cls}">${esc(c)}</span>`).join('');

    const fe = data.flow_efficiency ?? {};
    const signals = (data.blocked_time?.signals ?? []).map((s: any) => {
        const values = s.mechanism === 'tag'
            ? (s.tags ?? []).map((t: string) => `tag: ${t}`)
            : s.mechanism === 'column'
                ? (s.columns ?? []).map((c: string) => `column: ${c}`)
                : [`${s.mechanism}`];
        return `<span class="chip" style="border-left: 4px solid ${esc(s.color)}; background:${esc(s.color)}22">${esc(s.label)} <span style="opacity:0.7;font-size:0.85em">(${esc(values.join(', '))})</span></span>`;
    }).join('');

    const mapping = Object.entries(data.historical_column_mapping ?? {});
    const mappingRows = mapping.map(([from, to]) =>
        `<tr><td>${esc(from)}</td><td style="color:var(--vscode-descriptionForeground)">→</td><td>${esc(to as string ?? 'exclude')}</td></tr>`
    ).join('\n');

    const swimlaneMapping = Object.entries(data.swimlane_mapping ?? {});
    const swimlaneMappingRows = swimlaneMapping.map(([from, to]) =>
        `<tr><td>${esc(from)}</td><td style="color:var(--vscode-descriptionForeground)">→</td><td>${esc(to as string ?? 'unmapped')}</td></tr>`
    ).join('\n');

    const body = `
<h1>Board Configuration</h1>

<section>
    <h2>Clock Definitions</h2>
    <table>
        <thead><tr><th>Metric</th><th>Starts</th><th></th><th>Ends</th></tr></thead>
        <tbody>
            ${clockRow('Cycle Time', data.cycle_time)}
            ${clockRow('Lead Time', data.lead_time)}
        </tbody>
    </table>
</section>

<section>
    <h2>Flow Efficiency</h2>
    <div style="margin-bottom:8px">
        <span style="color:var(--vscode-descriptionForeground);font-size:0.88em">Active: </span>
        <div class="chips" style="display:inline-flex;margin-left:6px">${chips(fe.active_columns, '')}</div>
    </div>
    <div>
        <span style="color:var(--vscode-descriptionForeground);font-size:0.88em">Waiting: </span>
        <div class="chips" style="display:inline-flex;margin-left:6px">${chips(fe.waiting_columns, '')}</div>
    </div>
</section>

${signals ? `<section>
    <h2>Blocker Signals</h2>
    <div class="chips">${signals}</div>
</section>` : ''}

${mappingRows ? `<section>
    <h2>Historical Column Mapping (${mapping.length})</h2>
    <table><thead><tr><th>Old Name</th><th></th><th>Maps To</th></tr></thead>
    <tbody>${mappingRows}</tbody></table>
</section>` : ''}

${swimlaneMappingRows ? `<section>
    <h2>Swimlane Mapping (${swimlaneMapping.length})</h2>
    <table><thead><tr><th>Old Name</th><th></th><th>Maps To</th></tr></thead>
    <tbody>${swimlaneMappingRows}</tbody></table>
</section>` : ''}`;

    return baseHtml(nonce, 'Board Configuration', body, '', '', cspSource);
}

function renderDataQuality(data: any, nonce: string, cspSource = ''): string {
    const checks = data.checks ?? {};
    const checkHtml = Object.entries(checks).map(([key, val]: [string, any]) => {
        const count: number = val.count ?? 0;
        const cls = count === 0 ? 'check-ok' : 'check-warn';
        const icon = count === 0 ? '✓' : '⚠';
        const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const items: any[] = val.items ?? val.item_ids ?? [];
        const detail = items.length > 0 ? `<details>
            <summary>Show ${items.length} item${items.length > 1 ? 's' : ''}</summary>
            <ul style="margin-top:6px;padding-left:18px;font-size:0.88em">
                ${items.map((i: any) => `<li>${typeof i === 'object' ? esc(`${i.id}: ${i.state ?? ''} (${i.entered ?? ''})`) : esc(String(i))}</li>`).join('\n')}
            </ul>
        </details>` : '';
        return `<div class="check ${cls}">
            <span class="check-title">${icon} ${esc(label)} (${count})</span>
            ${detail}
        </div>`;
    }).join('\n');

    const totalOk = Object.values(checks).every((v: any) => (v.count ?? 0) === 0);

    const body = `
<h1>Data Quality Report</h1>
<div class="meta">
    <span>Generated: ${fmtDate(data.generated_at)}</span>
    <span>Total items: ${esc(data.total_items)}</span>
    ${totalOk ? '<span style="color:#69db7c">✓ All checks passed</span>' : ''}
</div>

<section>
    <h2>Checks</h2>
    <div class="checks">${checkHtml}</div>
</section>`;

    return baseHtml(nonce, 'Data Quality Report', body, '', '', cspSource);
}

function renderMetricSummary(data: any, nonce: string, cspSource = ''): string {
    const title = (data.metric ?? 'metric').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
    const w = data.window ?? {};
    const o = data.overall ?? {};
    const warnings: string[] = data.warnings ?? [];
    const items: any[] = data.items ?? [];
    const isCycleTime = data.metric === 'cycle_time';
    const dayField = isCycleTime ? 'cycle_time_days' : 'lead_time_days';

    const itemRows = items.map((i: any) =>
        `<tr>
            <td><a href="${esc(data.ado_url_base)}/${i.id}" target="_blank">${esc(i.id)}</a></td>
            <td>${esc(i.title)}</td>
            <td>${esc(i.type)}</td>
            <td>${fmtNum(i[dayField])}d</td>
            <td>${fmtDate(i.started_at ?? i.entered_at ?? '')}</td>
            <td>${fmtDate(i.completed_at ?? i.exited_at ?? '')}</td>
        </tr>`
    ).join('\n');

    const body = `
<h1>${esc(title)}</h1>
<div class="meta">
    <span>Window: ${esc(w.parameter)}</span>
    <span>${fmtDate(w.start)} → ${fmtDate(w.end)}</span>
    <span>Calculated: ${fmtDate(data.calculated_at)}</span>
</div>

<section>
    <h2>Overall (${o.n ?? data.item_count ?? 0} items)</h2>
    <div class="stats-grid">
        <div class="stat"><span class="val">${fmtNum(o.median_days)}d</span><span class="lbl">Median</span></div>
        <div class="stat"><span class="val">${fmtNum(o.mean_days)}d</span><span class="lbl">Mean</span></div>
        <div class="stat"><span class="val">${fmtNum(o.p85_days)}d</span><span class="lbl">P85</span></div>
        <div class="stat"><span class="val">${fmtNum(o.min_days)}d</span><span class="lbl">Min</span></div>
        <div class="stat"><span class="val">${fmtNum(o.max_days)}d</span><span class="lbl">Max</span></div>
    </div>
</section>

${warnings.length ? `<section>
    <details>
        <summary>Warnings (${warnings.length})</summary>
        <ul style="margin-top:8px;padding-left:18px;font-size:0.88em;line-height:1.8">
            ${warnings.map(w => `<li>${esc(w)}</li>`).join('\n')}
        </ul>
    </details>
</section>` : ''}

${items.length ? `<section>
    <h2>Items (${items.length})</h2>
    <table>
        <thead><tr><th>ID</th><th>Title</th><th>Type</th><th>Days</th><th>Started</th><th>Completed</th></tr></thead>
        <tbody>${itemRows}</tbody>
    </table>
</section>` : ''}`;

    return baseHtml(nonce, title, body, '', '', cspSource);
}

function renderTimeInColumns(data: any, nonce: string, cspSource = ''): string {
    const cols: any[] = data.columns ?? [];
    const warnings: string[] = data.warnings ?? [];
    const w = data.window ?? {};

    const colRows = cols.map((c: any) => {
        const cls = COLUMN_TYPE_CLASS[c.column_type] ?? 'badge-incoming';
        return `<tr>
            <td>${esc(c.name)}</td>
            <td><span class="badge ${cls}">${esc(c.column_type)}</span></td>
            <td>${esc(c.n)}</td>
            <td>${fmtNum(c.mean_hours)}h</td>
            <td>${fmtNum(c.median_hours)}h</td>
            <td>${fmtNum(c.mean_hours / 24)}d</td>
        </tr>`;
    }).join('\n');

    const body = `
<h1>Time in Columns</h1>
<div class="meta">
    <span>Window: ${esc(w.parameter)}</span>
    <span>${fmtDate(w.start)} → ${fmtDate(w.end)}</span>
    <span>${data.item_count ?? 0} items</span>
</div>

<section>
    <h2>Column Breakdown</h2>
    <table>
        <thead><tr><th>Column</th><th>Type</th><th>N</th><th>Mean</th><th>Median</th><th>Mean (days)</th></tr></thead>
        <tbody>${colRows}</tbody>
    </table>
</section>

${warnings.length ? `<section>
    <details>
        <summary>Warnings (${warnings.length})</summary>
        <ul style="margin-top:8px;padding-left:18px;font-size:0.88em;line-height:1.8">
            ${warnings.map((w: string) => `<li>${esc(w)}</li>`).join('\n')}
        </ul>
    </details>
</section>` : ''}`;

    return baseHtml(nonce, 'Time in Columns', body, '', '', cspSource);
}

function renderInsights(data: any, nonce: string, cspSource = ''): string {
    const charts = data.chart_insights ?? {};
    const CHART_LABELS: Record<string, string> = {
        cycle_time: 'Cycle Time',
        lead_time: 'Lead Time',
        throughput: 'Throughput',
        time_in_columns: 'Time in Columns',
        flow_efficiency: 'Flow Efficiency',
        work_start_efficiency: 'Work Start Efficiency',
        wip: 'WIP',
    };

    const cards = Object.entries(charts).map(([key, val]: [string, any]) => {
        const label = CHART_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const evidence = (val.evidence ?? []).map((e: string) => `<li>${esc(e)}</li>`).join('\n');
        return `<div class="insight-card">
            <h2>${esc(label)}</h2>
            <p class="insight-text">${esc(val.insight)}</p>
            ${evidence ? `<ul class="evidence">${evidence}</ul>` : ''}
            ${val.watch_out ? `<div class="watch-out"><strong>Watch out:</strong> ${esc(val.watch_out)}</div>` : ''}
        </div>`;
    }).join('\n');

    const body = `<h1>AI Insights</h1>
<div class="meta"><span>Generated from dashboard metrics</span></div>
${cards}`;

    return baseHtml(nonce, 'AI Insights', body, '', '', cspSource);
}

function renderLearnings(data: any, nonce: string, filename: string, cspSource = ''): string {
    const learnings = Array.isArray(data) ? data : [];
    const isGlobal = filename === 'global_learnings.json';
    const title = isGlobal ? 'Global Learnings' : 'Board Learnings';
    
    if (learnings.length === 0) {
        const body = `<h1>${title}</h1>
<div class="learnings-empty">No learnings saved yet. Ask @flowmetrics to save a learning using the board insights.</div>`;
        return baseHtml(nonce, title, body, '', '', cspSource);
    }

    const cards = learnings.map((entry: any) => {
        const dateStr = fmtDate(entry.date || '');
        const boardBadge = entry.board ? `<span class="learning-board">📊 ${esc(entry.board)}</span>` : '';
        return `<div class="learning-card">
            <div class="learning-meta">
                <span class="learning-date">📅 ${dateStr}</span>
                ${boardBadge}
            </div>
            <p>${esc(entry.text)}</p>
        </div>`;
    }).join('\n');

    const body = `<h1>${title}</h1>
<div class="meta"><span>${learnings.length} learning${learnings.length === 1 ? '' : 's'} saved</span></div>
${cards}`;

    return baseHtml(nonce, title, body, '', '', cspSource);
}

function renderWorkItems(data: any[], filePath: string, nonce: string, cspSource = ''): string {
    // Load type styles from context.json (same dir), which is written in Step 1
    type TypeStyle = { color: string; icon_url: string };
    let typeStyles: Record<string, TypeStyle> = {};
    try {
        const ctx = JSON.parse(fs.readFileSync(path.join(path.dirname(filePath), 'context.json'), 'utf-8'));
        if (ctx.work_item_type_styles) { typeStyles = ctx.work_item_type_styles; }
    } catch { /* context.json not yet available */ }

    const rows = data.map((i: any) => {
        const style: TypeStyle | undefined = typeStyles[i.type];
        const typeCell = style
            ? `<img src="${esc(style.icon_url)}" width="16" height="16" style="vertical-align:middle;margin-right:5px" alt="">${esc(i.type)}`
            : `<span class="type-dot" style="background:${esc(typeStyles[i.type]?.color ?? '#888')}"></span>${esc(i.type)}`;
        const tags = (i.tags ?? []).map((t: string) => `<span class="tag">${esc(t)}</span>`).join('');
        return `<tr data-search="${esc((i.title + ' ' + i.type + ' ' + (i.state ?? '') + ' ' + (i.column ?? '') + ' ' + (i.assignee ?? '')).toLowerCase())}">
            <td>${esc(i.id)}</td>
            <td>${typeCell}</td>
            <td>${esc(i.title)}${tags ? `<br>${tags}` : ''}</td>
            <td>${esc(i.state ?? '')}</td>
            <td>${esc(i.column ?? '')}</td>
            <td>${esc(i.assignee ?? '—')}</td>
        </tr>`;
    }).join('\n');

    const filterJs = `
function filter() {
    const q = document.getElementById('search').value.toLowerCase();
    for (const row of document.querySelectorAll('#items-tbody tr')) {
        row.style.display = !q || row.dataset.search.includes(q) ? '' : 'none';
    }
    const visible = document.querySelectorAll('#items-tbody tr:not([style*="none"])').length;
    document.getElementById('count').textContent = visible;
}
document.getElementById('search').addEventListener('input', filter);`;

    const body = `
<h1>Work Items (<span id="count">${data.length}</span>)</h1>
<div class="search-row">
    <input id="search" type="text" placeholder="Filter by title, type, state, column, assignee…">
</div>
<table>
    <thead><tr><th>ID</th><th>Type</th><th>Title</th><th>State</th><th>Column</th><th>Assignee</th></tr></thead>
    <tbody id="items-tbody">${rows}</tbody>
</table>`;

    return baseHtml(nonce, 'Work Items', body, filterJs, 'https://tfsprodweu3.visualstudio.com', cspSource);
}

function loadSiblingTitlesAndBase(filePath: string): [Record<number, string>, string] {
    const dir = path.dirname(filePath);
    const titles: Record<number, string> = {};
    try {
        const items = JSON.parse(fs.readFileSync(path.join(dir, 'work_items.json'), 'utf-8'));
        for (const i of items) { titles[i.id] = i.title; }
    } catch {}
    let adoBase = '';
    try {
        const ctx = JSON.parse(fs.readFileSync(path.join(dir, 'context.json'), 'utf-8'));
        adoBase = `https://dev.azure.com/${ctx.org}/${encodeURIComponent(ctx.project)}/_workitems/edit`;
    } catch {}
    return [titles, adoBase];
}

function renderExcludedItems(data: any[], filePath: string, nonce: string, cspSource = ''): string {
    const [titles, adoBase] = loadSiblingTitlesAndBase(filePath);

    if (data.length === 0) {
        const body = `<h1>Excluded Items</h1><p style="color:#69db7c;margin-top:12px">✓ No items excluded from metrics.</p>`;
        return baseHtml(nonce, 'Excluded Items', body, '', '', cspSource);
    }

    const rows = data.map((item: any) => {
        const idCell = adoBase
            ? `<a href="${esc(adoBase)}/${item.id}" target="_blank">${esc(item.id)}</a>`
            : esc(item.id);
        const reasons = (item.reasons ?? []).map((r: string) => `<span class="tag">${esc(r)}</span>`).join(' ');
        return `<tr>
            <td>${idCell}${titles[item.id] ? `<br><span style="font-size:0.8em;color:var(--vscode-descriptionForeground)">${esc(titles[item.id])}</span>` : ''}</td>
            <td>${esc(item.source ?? '')}</td>
            <td>${reasons}</td>
        </tr>`;
    }).join('\n');

    const body = `
<h1>Excluded Items (${data.length})</h1>
<div class="meta"><span>These items are omitted from all metric calculations</span></div>
<table>
    <thead><tr><th>ID / Title</th><th>Source</th><th>Reasons</th></tr></thead>
    <tbody>${rows}</tbody>
</table>`;

    return baseHtml(nonce, 'Excluded Items', body, '', '', cspSource);
}

function renderRework(data: any[], filePath: string, nonce: string, cspSource = ''): string {
    const [titles, adoBase] = loadSiblingTitlesAndBase(filePath);

    const withRework = data.filter((i: any) => {
        const s = i.rework_summary ?? {};
        return s.backward_column_moves > 0 || s.reopened_after_done || (s.revisited_columns ?? []).length > 0;
    });

    const rows = data.map((item: any) => {
        const s = item.rework_summary ?? {};
        const hasRework = s.backward_column_moves > 0 || s.reopened_after_done;
        const id = item.work_item_id;
        const idCell = adoBase
            ? `<a href="${esc(adoBase)}/${id}" target="_blank">${esc(id)}</a>`
            : esc(id);
        const revisited = (s.revisited_columns ?? []).map((c: string) => `<span class="tag">${esc(c)}</span>`).join(' ');
        const timeInRevisited = s.time_in_revisited_columns_hours != null
            ? `${fmtNum(s.time_in_revisited_columns_hours / 24)}d`
            : '—';
        return `<tr data-rework="${hasRework ? '1' : '0'}" data-search="${esc(String(id) + ' ' + (titles[id] ?? ''))}">
            <td>${idCell}${titles[id] ? `<br><span style="font-size:0.8em;color:var(--vscode-descriptionForeground)">${esc(titles[id])}</span>` : ''}</td>
            <td>${hasRework ? `<span class="badge badge-warn">${esc(s.backward_column_moves)}</span>` : '0'}</td>
            <td>${s.reopened_after_done ? '<span class="badge badge-warn">Yes</span>' : 'No'}</td>
            <td>${revisited || '—'}</td>
            <td>${timeInRevisited}</td>
        </tr>`;
    }).join('\n');

    const js = `
var showAll = false;
function applyFilters() {
    const q = document.getElementById('search').value.toLowerCase();
    document.querySelectorAll('tbody tr').forEach(row => {
        const matchQ = !q || row.dataset.search.includes(q);
        const matchR = showAll || row.dataset.rework === '1';
        row.style.display = matchQ && matchR ? '' : 'none';
    });
}
document.getElementById('search').addEventListener('input', applyFilters);
document.getElementById('toggle').addEventListener('click', function() {
    showAll = !showAll;
    this.textContent = showAll ? 'Show rework only' : 'Show all items';
    applyFilters();
});
applyFilters();`;

    const body = `
<h1>Work Item Rework</h1>
<div class="meta">
    <span>${withRework.length} of ${data.length} items have rework signals</span>
</div>
<div style="display:flex;gap:10px;margin-bottom:12px;align-items:center">
    <input id="search" type="text" class="search-row" style="flex:1;max-width:320px" placeholder="Filter by ID or title…">
    <button id="toggle" style="padding:4px 12px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-panel-border);border-radius:4px;cursor:pointer">Show all items</button>
</div>
<table>
    <thead><tr><th>ID / Title</th><th>Backward Moves</th><th>Reopened</th><th>Revisited Columns</th><th>Time in Revisited</th></tr></thead>
    <tbody>${rows}</tbody>
</table>`;

    return baseHtml(nonce, 'Work Item Rework', body, js, '', cspSource);
}

function renderHistory(data: any[], filePath: string, nonce: string, cspSource = ''): string {
    const [titles, adoBase] = loadSiblingTitlesAndBase(filePath);

    const now = Date.now();
    function dur(entered: string, left: string | null): string {
        const days = Math.round(((left ? new Date(left).getTime() : now) - new Date(entered).getTime()) / 86400000);
        if (days < 1) { return '<1d'; }
        if (days < 30) { return `${days}d`; }
        if (days < 56) { return `${Math.round(days / 7)}w`; }
        return `${Math.round(days / 30)}mo`;
    }

    const rows = data.map((item: any) => {
        const cols: any[] = item.column_history ?? [];
        const journey = cols.map((c: any) => esc(c.value)).join(' → ');
        const regressionCount = (item.regressions ?? []).length;
        const searchStr = [item.id, titles[item.id] ?? '', ...cols.map((c: any) => c.value)].join(' ').toLowerCase();
        const idCell = adoBase
            ? `<a href="${esc(adoBase)}/${item.id}" target="_blank">${esc(item.id)}</a>`
            : esc(item.id);

        const colRows = cols.map((c: any) =>
            `<tr><td>${esc(c.value)}</td><td>${fmtDate(c.entered)}</td><td>${c.left ? fmtDate(c.left) : '—'}</td><td>${dur(c.entered, c.left)}${!c.left ? ' <em>ongoing</em>' : ''}</td></tr>`
        ).join('');

        const stateRows = (item.state_history ?? []).map((s: any) =>
            `<tr><td>${esc(s.value)}</td><td>${fmtDate(s.entered)}</td><td>${s.left ? fmtDate(s.left) : '—'}</td><td>${dur(s.entered, s.left)}${!s.left ? ' <em>ongoing</em>' : ''}</td></tr>`
        ).join('');

        const tagRows = (item.tag_history ?? []).map((t: any) =>
            `<tr><td>${fmtDate(t.changed_at)}</td><td>${esc(t.old_value ?? '')}</td><td>${esc(t.new_value ?? '')}</td></tr>`
        ).join('');

        return `<tr class="hist-row" data-search="${esc(searchStr)}" data-target="hist-${item.id}">
            <td>${idCell}${titles[item.id] ? `<br><span class="item-title">${esc(titles[item.id])}</span>` : ''}</td>
            <td>${fmtDate(item.board_entry_date ?? '')}</td>
            <td class="journey">${esc(journey) || '—'}</td>
            <td>${regressionCount > 0 ? `<span class="badge badge-warn">${regressionCount}</span>` : '0'}</td>
        </tr>
        <tr class="hist-detail" id="hist-${item.id}" style="display:none">
            <td colspan="4"><div class="detail-inner">
                ${colRows ? `<h3>Column History</h3><table class="dtbl"><thead><tr><th>Column</th><th>Entered</th><th>Left</th><th>Duration</th></tr></thead><tbody>${colRows}</tbody></table>` : ''}
                ${stateRows ? `<h3>State History</h3><table class="dtbl"><thead><tr><th>State</th><th>Entered</th><th>Left</th><th>Duration</th></tr></thead><tbody>${stateRows}</tbody></table>` : ''}
                ${tagRows ? `<h3>Tag Changes</h3><table class="dtbl"><thead><tr><th>Date</th><th>From</th><th>To</th></tr></thead><tbody>${tagRows}</tbody></table>` : ''}
            </div></td>
        </tr>`;
    }).join('\n');

    const css = `
.hist-row { cursor: pointer; }
.hist-detail { display: none; }
.hist-detail td { padding: 0; background: var(--vscode-textCodeBlock-background); }
.detail-inner { padding: 12px 16px; }
.detail-inner h3 { margin: 12px 0 5px; font-size: 0.88em; color: var(--vscode-descriptionForeground); }
.detail-inner h3:first-child { margin-top: 0; }
.dtbl { width: 100%; border-collapse: collapse; font-size: 0.85em; margin-bottom: 6px; }
.dtbl th { text-align: left; padding: 3px 8px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); }
.dtbl td { padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.journey { font-size: 0.83em; color: var(--vscode-descriptionForeground); }
.item-title { font-size: 0.8em; color: var(--vscode-descriptionForeground); }`;

    const js = `
function filter() {
    const q = document.getElementById('search').value.toLowerCase();
    document.querySelectorAll('.hist-row').forEach(row => {
        const show = !q || row.dataset.search.includes(q);
        row.style.display = show ? '' : 'none';
        const det = document.getElementById(row.dataset.target);
        if (det && !show) det.style.display = 'none';
    });
}
document.getElementById('search').addEventListener('input', filter);
document.querySelector('tbody').addEventListener('click', e => {
    const row = e.target.closest('.hist-row');
    if (!row) { return; }
    const det = document.getElementById(row.dataset.target);
    if (det) { det.style.display = det.style.display === 'none' ? 'table-row' : 'none'; }
});`;

    const body = `
<h1>Work Item History (${data.length} items)</h1>
<div class="search-row"><input id="search" type="text" placeholder="Filter by ID, title, or column…"></div>
<style nonce="${nonce}">${css}</style>
<table>
    <thead><tr><th>ID / Title</th><th>Board Entry</th><th>Column Journey</th><th>Regressions</th></tr></thead>
    <tbody>${rows}</tbody>
</table>`;

    return baseHtml(nonce, 'Work Item History', body, js, '', cspSource);
}

function renderGeneric(data: any, filename: string, nonce: string, cspSource = ''): string {
    const json = JSON.stringify(data, null, 2);
    const highlighted = json
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
            let cls = 'json-num';
            if (/^"/.test(match)) { cls = /:$/.test(match) ? 'json-key' : 'json-str'; }
            else if (/true|false/.test(match)) { cls = 'json-bool'; }
            else if (/null/.test(match)) { cls = 'json-null'; }
            return `<span class="${cls}">${match}</span>`;
        });

    const css = `
pre { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; white-space: pre-wrap; word-break: break-word; }
.json-key  { color: #9cdcfe; }
.json-str  { color: #ce9178; }
.json-num  { color: #b5cea8; }
.json-bool { color: #569cd6; }
.json-null { color: #569cd6; }`;

    const body = `<h1>${esc(filename)}</h1><style nonce="${nonce}">${css}</style><pre>${highlighted}</pre>`;
    return baseHtml(nonce, filename, body, '', '', cspSource);
}

// ── Public API ──────────────────────────────────────────────────────────────

const _panels = new Map<string, vscode.WebviewPanel>();

// Retries webview HTML assignment if the VS Code service worker failed to register (vscode#125993)
function withSwRetry(panel: vscode.WebviewPanel, html: string, onReady: (cancel: () => void) => void): void {
    panel.webview.html = html;
    let done = false;
    const cancel = () => { done = true; };
    onReady(cancel);
    const retry = (attempt: number) => {
        if (done || attempt > 3) { return; }
        setTimeout(() => { if (!done) { panel.webview.html = html; retry(attempt + 1); } }, 3000);
    };
    retry(1);
}

function openHtmlPreview(filePath: string, context: vscode.ExtensionContext): void {
    const chartJsFsPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'chart.umd.min.js').fsPath;
    const chartJsInline = `<script>${fs.readFileSync(chartJsFsPath, 'utf-8')}</script>`;

    const buildDashHtml = (webview: vscode.Webview): string | null => {
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            // Explicit CSP is required so VS Code can inject its own initialisation scripts
            const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; img-src * data: blob:; font-src *;">`;
            let html = raw.replace('<head>', `<head>\n  ${cspMeta}`);
            html = html.replace(/\s*<script\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js[^"]*"><\/script>/, chartJsInline);
            return html;
        } catch { return null; }
    };

    const existing = _panels.get(filePath);
    if (existing) {
        const html = buildDashHtml(existing.webview);
        if (html) { existing.webview.html = html; }
        existing.reveal(undefined, true);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'aiFlowMetrics.dashboard', 'Dashboard', vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true, localResourceRoots: [context.extensionUri, context.globalStorageUri] },
    );
    // Inject ready signal so withSwRetry can detect service worker failures
    const buildDashHtmlWithReady = (webview: vscode.Webview): string | null => {
        const h = buildDashHtml(webview);
        return h ? h.replace('</body>', '<script>try{acquireVsCodeApi().postMessage({type:\'__ready\'});}catch(e){}</script></body>') : null;
    };
    const html = buildDashHtmlWithReady(panel.webview);
    let cancelRetry: (() => void) | undefined;
    if (html) {
        withSwRetry(panel, html, cancel => { cancelRetry = cancel; });
        panel.onDidDispose(() => { cancelRetry?.(); _panels.delete(filePath); }, null, context.subscriptions);
    } else {
        panel.onDidDispose(() => _panels.delete(filePath), null, context.subscriptions);
    }
    _panels.set(filePath, panel);
    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === '__ready') { cancelRetry?.(); return; }
        if (msg.type === 'askAI') {
            await vscode.env.clipboard.writeText(msg.context);
            // Step 1: switch to Ask mode with no query — await so session state settles
            await vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'ask' });
            // Step 2: prefill input with no mode switch to avoid the timing race
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: msg.context,
                isPartialQuery: true,
            });
        }
    }, null, context.subscriptions);
}

export function openPreview(filePath: string, context: vscode.ExtensionContext): void {
    if (filePath.endsWith('.html')) { openHtmlPreview(filePath, context); return; }

    const filename = path.basename(filePath);

    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0')).join('');

    let raw: string;
    let data: any;
    try { raw = fs.readFileSync(filePath, 'utf-8'); data = JSON.parse(raw); }
    catch {
        // If we have an existing panel, leave it as-is rather than showing an error on a partial write
        if (!_panels.has(filePath)) {
            const p = vscode.window.createWebviewPanel('aiFlowMetrics.preview', filename, vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true });
            p.webview.html = baseHtml(nonce, filename, `<p>Could not read file.</p>`, '', '', p.webview.cspSource);
            _panels.set(filePath, p);
            p.onDidDispose(() => _panels.delete(filePath), null, context.subscriptions);
        }
        return;
    }

    const existing = _panels.get(filePath);
    if (existing) {
        existing.webview.html = buildHtml(filePath, filename, data, nonce, existing.webview.cspSource);
        existing.reveal(undefined, true); // reveal without stealing focus
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'aiFlowMetrics.preview',
        filename,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true },
    );
    let cancelRetry: (() => void) | undefined;
    const html = buildHtml(filePath, filename, data, nonce, panel.webview.cspSource);
    withSwRetry(panel, html, cancel => { cancelRetry = cancel; });
    _panels.set(filePath, panel);
    panel.onDidDispose(() => { cancelRetry?.(); _panels.delete(filePath); }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage(msg => { if (msg.type === '__ready') { cancelRetry?.(); } }, null, context.subscriptions);
}

function buildHtml(filePath: string, filename: string, data: any, nonce: string, cspSource = ''): string {
    switch (filename) {
        case 'context.json':      return renderContext(data, nonce, cspSource);
        case 'config.json':       return renderConfig(data, nonce, cspSource);
        case 'data_quality_report.json': return renderDataQuality(data, nonce, cspSource);
        case 'cycle_time.json':
        case 'lead_time.json':    return renderMetricSummary(data, nonce, cspSource);
        case 'time_in_columns.json': return renderTimeInColumns(data, nonce, cspSource);
        case 'insights.json':     return renderInsights(data, nonce, cspSource);
        case 'interpretation_learnings.json':
        case 'global_learnings.json': return renderLearnings(data, nonce, filename, cspSource);
        case 'work_items.json':        return renderWorkItems(Array.isArray(data) ? data : [], filePath, nonce, cspSource);
        case 'excluded_items.json':     return renderExcludedItems(Array.isArray(data) ? data : [], filePath, nonce, cspSource);
        case 'work_item_rework.json':   return renderRework(Array.isArray(data) ? data : [], filePath, nonce, cspSource);
        case 'work_item_history.json':  return renderHistory(Array.isArray(data) ? data : [], filePath, nonce, cspSource);
        default:                        return renderGeneric(data, filename, nonce, cspSource);
    }
}
