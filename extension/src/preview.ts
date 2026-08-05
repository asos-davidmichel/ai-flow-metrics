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

function baseHtml(nonce: string, title: string, body: string, extraJs = '', imgSrc = ''): string {
    const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'${imgSrc ? `; img-src ${imgSrc}` : ''};`;
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
</body>
</html>`;
}

// ── Renderers ───────────────────────────────────────────────────────────────

function renderContext(data: any, nonce: string): string {
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

    return baseHtml(nonce, 'Board Context', body);
}

function renderConfig(data: any, nonce: string): string {
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
    const signals = (data.blocked_time?.signals ?? []).map((s: any) =>
        `<span class="chip" style="border-left: 4px solid ${esc(s.color)}; background:${esc(s.color)}22">${esc(s.label)}: ${esc((s.tags ?? []).join(', '))}</span>`
    ).join('');

    const mapping = Object.entries(data.historical_column_mapping ?? {});
    const mappingRows = mapping.map(([from, to]) =>
        `<tr><td>${esc(from)}</td><td style="color:var(--vscode-descriptionForeground)">→</td><td>${esc(to as string)}</td></tr>`
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
</section>` : ''}`;

    return baseHtml(nonce, 'Board Configuration', body);
}

function renderDataQuality(data: any, nonce: string): string {
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

    return baseHtml(nonce, 'Data Quality Report', body);
}

function renderMetricSummary(data: any, nonce: string): string {
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

    return baseHtml(nonce, title, body);
}

function renderTimeInColumns(data: any, nonce: string): string {
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

    return baseHtml(nonce, 'Time in Columns', body);
}

function renderInsights(data: any, nonce: string): string {
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

    return baseHtml(nonce, 'AI Insights', body);
}

function renderWorkItems(data: any[], filePath: string, nonce: string): string {
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

    return baseHtml(nonce, 'Work Items', body, filterJs, 'https://tfsprodweu3.visualstudio.com');
}

function renderGeneric(data: any, filename: string, nonce: string): string {
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
    return baseHtml(nonce, filename, body);
}

// ── Public API ──────────────────────────────────────────────────────────────

export function openPreview(filePath: string, context: vscode.ExtensionContext): void {
    const filename = path.basename(filePath);
    const panel = vscode.window.createWebviewPanel(
        'aiFlowMetrics.preview',
        filename,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
    );

    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0')).join('');

    let raw: string;
    try { raw = fs.readFileSync(filePath, 'utf-8'); }
    catch { panel.webview.html = baseHtml(nonce, filename, `<p>Could not read file.</p>`); return; }

    let data: any;
    try { data = JSON.parse(raw); }
    catch { panel.webview.html = baseHtml(nonce, filename, `<p>Invalid JSON.</p>`); return; }

    panel.webview.html = buildHtml(filePath, filename, data, nonce);
}

function buildHtml(filePath: string, filename: string, data: any, nonce: string): string {
    switch (filename) {
        case 'context.json':      return renderContext(data, nonce);
        case 'config.json':       return renderConfig(data, nonce);
        case 'data_quality_report.json': return renderDataQuality(data, nonce);
        case 'cycle_time.json':
        case 'lead_time.json':    return renderMetricSummary(data, nonce);
        case 'time_in_columns.json': return renderTimeInColumns(data, nonce);
        case 'insights.json':     return renderInsights(data, nonce);
        case 'work_items.json':   return renderWorkItems(Array.isArray(data) ? data : [], filePath, nonce);
        default:                  return renderGeneric(data, filename, nonce);
    }
}
