import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface Board { id: string; name: string; url: string; }

const TOOLS: vscode.LanguageModelChatTool[] = [
    {
        name: 'fetch_live_work_items',
        description:
            'Fetch up-to-date work items directly from ADO. Use when the cached data may be stale or when you need to confirm the current board state.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'fetch_item_history',
        description:
            'Fetch the full column and state-change history for a specific work item. Use when asked how long an item has been somewhere, when it moved, or details about its journey.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number', description: 'The numeric ADO work item ID' },
            },
            required: ['id'],
        },
    },
    {
        name: 'update_board_config',
        description:
            'Update the board configuration and save it to disk. Call only when the user explicitly asks to change column classification (active/waiting), clock start/end columns, or blocker signals. ' +
            'Provide the COMPLETE updated config object — preserve all fields that are not being changed.',
        inputSchema: {
            type: 'object',
            properties: {
                config: {
                    type: 'object',
                    description: 'The complete updated board config object (all fields, not just changed ones)',
                },
            },
            required: ['config'],
        },
    },
];

function runPython(script: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) =>
        cp.execFile('python', [script, ...args], { cwd, env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
            err ? reject(new Error(stderr || err.message)) : resolve(stdout)
        )
    );
}

function loadJson<T>(filePath: string): T | undefined {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
    catch { return undefined; }
}

function buildSystemPrompt(board: Board, boardDir: string): string {
    const ctx        = loadJson<any>(path.join(boardDir, 'output/data/context.json'));
    const cfg        = loadJson<any>(path.join(boardDir, 'output/data/config.json'));
    const items      = loadJson<any[]>(path.join(boardDir, 'output/data/work_items.json'));
    const history    = loadJson<any[]>(path.join(boardDir, 'output/data/work_item_history.json'));
    const insights   = loadJson<any>(path.join(boardDir, 'output/data/insights.json'));
    const sprintRetro = loadJson<any[]>(path.join(boardDir, 'output/data/sprint_retro.json'));
    const cycleTime  = loadJson<any>(path.join(boardDir, 'output/metrics/cycle_time.json'));
    const leadTime   = loadJson<any>(path.join(boardDir, 'output/metrics/lead_time.json'));
    const tic        = loadJson<any>(path.join(boardDir, 'output/metrics/time_in_columns.json'));

    const columns        = (ctx?.columns ?? []).map((c: any) => c.name).join(' → ');
    const activeColumns  = (cfg?.flow_efficiency?.active_columns  ?? []).join(', ');
    const waitingColumns = (cfg?.flow_efficiency?.waiting_columns ?? []).join(', ');
    const cycleStart     = cfg?.cycle_time?.clock_start?.value ?? 'unknown';
    const cycleEnd       = cfg?.cycle_time?.clock_end?.value   ?? 'unknown';
    const rawConfig      = cfg ? JSON.stringify(cfg, null, 2) : 'Not yet configured.';

    const truncate = (obj: unknown, limit: number) => {
        const s = JSON.stringify(obj);
        return s.length > limit ? s.slice(0, limit) + '\n... (truncated)' : s;
    };

    let itemsText: string;
    if (items?.length) {
        const compact = items.map((i: any) => ({
            id: i.id, title: i.title, type: i.type, column: i.column,
            assignee: i.assignee ?? null, tags: i.tags ?? [], state: i.state,
        }));
        itemsText = truncate(compact, 80_000);
    } else {
        itemsText = 'No cached data available — use fetch_live_work_items to get current items.';
    }

    // Compact column history: strip tag/state history, keep only column moves with dates
    let historyText = 'Not available.';
    if (history?.length) {
        const compact = history.map((item: any) => ({
            id: item.id,
            cols: (item.column_history ?? []).map((c: any) => ({
                col: c.value,
                from: c.entered?.slice(0, 10) ?? null,
                to: c.left?.slice(0, 10) ?? null,
            })),
        }));
        historyText = truncate(compact, 60_000);
    }

    // Metrics: summary only — skip per-item arrays to stay within context limits
    const cycleTimeSummary = cycleTime
        ? truncate({ overall: cycleTime.overall, weekly_stats: cycleTime.weekly_stats }, 30_000)
        : 'Not available.';
    const leadTimeSummary = leadTime
        ? truncate({ overall: leadTime.overall, weekly_stats: leadTime.weekly_stats }, 30_000)
        : 'Not available.';
    const ticSummary = tic
        ? truncate({ columns: tic.columns }, 30_000)
        : 'Not available.';
    const insightsText = insights ? truncate(insights, 55_000) : 'Not available.';
    const sprintRetroText = sprintRetro ? truncate(sprintRetro, 35_000) : 'Not available.';

    let dataAge = 'unknown';
    try {
        dataAge = fs.statSync(path.join(boardDir, 'output/data/work_items.json')).mtime.toLocaleString();
    } catch { /* file absent */ }

    return [
        `You are a flow metrics assistant for the "${board.name}" board (team: ${ctx?.team ?? ''}, project: ${ctx?.project ?? ''}).`,
        ``,
        `Board columns (left to right): ${columns}`,
        `Active (in-progress) columns: ${activeColumns || 'not configured'}`,
        `Waiting columns: ${waitingColumns || 'not configured'}`,
        `Cycle time clock: ${cycleStart} → ${cycleEnd}`,
        ``,
        `Full board config (config.json) — use this exact structure when calling update_board_config:`,
        rawConfig,
        ``,
        `Cached work items (as of ${dataAge}):`,
        itemsText,
        ``,
        `Column movement history — each item's column transitions with entry/exit dates:`,
        historyText,
        ``,
        `Cycle time metrics (overall summary + weekly throughput):`,
        cycleTimeSummary,
        ``,
        `Lead time metrics (overall summary + weekly):`,
        leadTimeSummary,
        ``,
        `Time in columns (per-column dwell time statistics):`,
        ticSummary,
        ``,
        `AI insights (executive summary, chart insights, diagnostic findings, outlier patterns):`,
        insightsText,
        ``,
        `Sprint retrospective data:`,
        sprintRetroText,
        ``,
        `Tools available:`,
        `- fetch_live_work_items: fetches fresh work items directly from ADO`,
        `- fetch_item_history: fetches column/state change history for one item by ID`,
        `- update_board_config: saves a modified config.json to disk (use when the user asks to change configuration)`,
        ``,
        `Answer questions about flow metrics, blocked items, cycle time, WIP, and delivery patterns.`,
        `Be specific — include work item IDs and titles. Offer to fetch live data if the cache looks stale.`,
    ].join('\n');
}

async function resolveBoard(
    state: vscode.Memento,
    globalStoragePath: string,
    getBoards: () => Board[],
    stream: vscode.ChatResponseStream,
): Promise<{ board: Board; boardDir: string } | undefined> {
    const boards = getBoards();
    if (!boards.length) {
        stream.markdown('No boards configured. Add a board in the AI Flow Metrics panel first.');
        return undefined;
    }

    // 1. Active board selected in sidebar
    const activeId = state.get<string>('activeBoardId');
    let board = boards.find(b => b.id === activeId);

    // 2. Infer from the currently open editor (check if path is under globalStorage/<boardId>)
    if (!board) {
        const openPath = vscode.window.activeTextEditor?.document.uri.fsPath;
        if (openPath) {
            board = boards.find(b => openPath.startsWith(path.join(globalStoragePath, b.id)));
        }
    }

    // 3. Ask the user
    if (!board && boards.length === 1) {
        board = boards[0];
    } else if (!board) {
        const pick = await vscode.window.showQuickPick(
            boards.map(b => ({ label: b.name, board: b })),
            { placeHolder: 'Which board are you asking about?' }
        );
        if (!pick) {
            stream.markdown('No board selected — select a board in the AI Flow Metrics panel and try again.');
            return undefined;
        }
        board = pick.board;
    }

    return { board, boardDir: path.join(globalStoragePath, board.id) };
}

export function registerChatParticipant(
    context: vscode.ExtensionContext,
    getBoards: () => Board[],
    refresh?: () => void,
): void {
    const participant = vscode.chat.createChatParticipant(
        'ai-flow-metrics.chat',
        async (request, _ctx, stream, token) => {
            const resolved = await resolveBoard(
                context.globalState, context.globalStorageUri.fsPath, getBoards, stream
            );
            if (!resolved) { return {}; }
            const { board, boardDir } = resolved;

            const model = request.model;

            const adoPat = await context.secrets.get('ADO_PAT') ?? process.env['ADO_PAT'] ?? '';
            const scriptPath = path.join(context.extensionPath, 'resources', 'scripts', 'query_ado.py');
            const env = { ...process.env, ADO_PAT: adoPat, PYTHONUTF8: '1' };

            const messages: vscode.LanguageModelChatMessage[] = [
                vscode.LanguageModelChatMessage.User(buildSystemPrompt(board, boardDir)),
                vscode.LanguageModelChatMessage.User(request.prompt),
            ];

            // Tool-calling loop — max 3 rounds to prevent runaway calls
            for (let round = 0; round < 3; round++) {
                const response = await model.sendRequest(messages, { tools: TOOLS }, token);
                const toolCalls: vscode.LanguageModelToolCallPart[] = [];

                for await (const part of response.stream) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        stream.markdown(part.value);
                    } else if (part instanceof vscode.LanguageModelToolCallPart) {
                        toolCalls.push(part);
                    }
                }

                if (!toolCalls.length) { break; }

                const toolResults: vscode.LanguageModelToolResultPart[] = [];
                for (const call of toolCalls) {
                    stream.progress(`Querying ADO (${call.name.replace(/_/g, ' ')})…`);
                    let result: string;
                    try {
                        if (call.name === 'fetch_live_work_items') {
                            result = await runPython(scriptPath, ['work-items'], boardDir, env);
                        } else if (call.name === 'fetch_item_history') {
                            const id = (call.input as { id: number }).id;
                            result = await runPython(scriptPath, ['item-history', '--id', String(id)], boardDir, env);
                        } else if (call.name === 'update_board_config') {
                        try {
                            const newConfig = (call.input as { config: unknown }).config;
                            const jsonStr = JSON.stringify(newConfig, null, 2);
                            const configPath = path.join(boardDir, 'output', 'data', 'config.json');
                            fs.writeFileSync(configPath, jsonStr, 'utf-8');
                            refresh?.();
                            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
                            vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
                            result = JSON.stringify({ success: true });
                        } catch (e) {
                            result = JSON.stringify({ error: String(e) });
                        }
                    } else {
                            result = JSON.stringify({ error: `Unknown tool: ${call.name}` });
                        }
                    } catch (e) {
                        result = JSON.stringify({ error: String(e) });
                    }
                    toolResults.push(
                        new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(result)])
                    );
                }

                messages.push(vscode.LanguageModelChatMessage.Assistant(toolCalls));
                messages.push(vscode.LanguageModelChatMessage.User(toolResults));
            }

            return {};
        }
    );
    participant.iconPath = new vscode.ThemeIcon('graph');
    context.subscriptions.push(participant);
}
