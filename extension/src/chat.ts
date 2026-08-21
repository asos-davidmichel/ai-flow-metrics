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
    {
        name: 'check_config_draft',
        description:
            'Check whether the board config was modified from the AI\'s original proposal after the user reviewed it. ' +
            'Call this when the user indicates they have reviewed and approved the config at step 3, before continuing the pipeline. ' +
            'Returns a diff summary if anything changed.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'save_config_corrections',
        description:
            'Record the config corrections to the global learning log so future boards benefit from them. ' +
            'IMPORTANT: call this immediately when the user says yes — all file paths are resolved internally. ' +
            'Do NOT search for files, read scripts, or run terminal commands before calling this. ' +
            'Shows a VS Code confirmation notification before writing to disk.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'read_output_file',
        description:
            'Read a cached output data file. Call this when you need detailed data to answer a question — ' +
            'only fetch what you actually need. The system prompt lists which files are available.',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'Relative path, e.g. "output/data/insights.json"' },
            },
            required: ['file'],
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

const READABLE_FILES: Array<{ rel: string; description: string }> = [
    { rel: 'output/data/work_items.json',          description: 'Current work items — id, title, type, column, state, assignee, tags' },
    { rel: 'output/data/work_item_history.json',   description: 'Full column transition history for every item (entered/left dates, tag changes, state changes)' },
    { rel: 'output/data/work_item_rework.json',    description: 'Items that moved backward to an earlier column (rework / regression events)' },
    { rel: 'output/data/insights.json',            description: 'AI-generated insights — executive summary, per-chart insights, diagnostic findings, outlier patterns' },
    { rel: 'output/data/sprint_retro.json',        description: 'Sprint-level retrospective data' },
    { rel: 'output/data/data_quality_report.json', description: 'Data quality warnings and excluded items' },
    { rel: 'output/metrics/cycle_time.json',       description: 'Cycle time — overall stats (median, P85, mean), weekly throughput, per-item breakdown' },
    { rel: 'output/metrics/lead_time.json',        description: 'Lead time — overall stats, weekly breakdown, per-item breakdown' },
    { rel: 'output/metrics/time_in_columns.json',  description: 'Time spent in each column — per-column stats and per-item dwell times' },
];

function buildSystemPrompt(board: Board, boardDir: string): string {
    const ctx = loadJson<any>(path.join(boardDir, 'output/data/context.json'));
    const cfg = loadJson<any>(path.join(boardDir, 'output/data/config.json'));

    const columns        = (ctx?.columns ?? []).map((c: any) => c.name).join(' → ');
    const activeColumns  = (cfg?.flow_efficiency?.active_columns  ?? []).join(', ');
    const waitingColumns = (cfg?.flow_efficiency?.waiting_columns ?? []).join(', ');
    const cycleStart     = cfg?.cycle_time?.clock_start?.value ?? 'unknown';
    const cycleEnd       = cfg?.cycle_time?.clock_end?.value   ?? 'unknown';
    const rawConfig      = cfg ? JSON.stringify(cfg, null, 2) : 'Not yet configured.';

    // Only list files that actually exist
    const availableFiles = READABLE_FILES.filter(f => fs.existsSync(path.join(boardDir, f.rel)));
    const fileCatalogue = availableFiles
        .map(f => `  ${f.rel} — ${f.description}`)
        .join('\n');

    return [
        `You are a flow metrics assistant for the "${board.name}" board (team: ${ctx?.team ?? ''}, project: ${ctx?.project ?? ''}).`,
        ``,
        `Board columns (left to right): ${columns}`,
        `Active (in-progress) columns: ${activeColumns || 'not configured'}`,
        `Waiting columns: ${waitingColumns || 'not configured'}`,
        `Cycle time clock: ${cycleStart} → ${cycleEnd}`,
        ``,
        `Full board config — use this exact structure when calling update_board_config:`,
        rawConfig,
        ``,
        `Available data files (use read_output_file to load any of these on demand):`,
        fileCatalogue,
        ``,
        `Tools available:`,
        `- read_output_file: load any of the above files when you need their data`,
        `- fetch_live_work_items: fetch fresh work items directly from ADO (use when cache may be stale)`,
        `- fetch_item_history: fetch detailed column/state history for a single item by ID from ADO`,
        `- update_board_config: save a modified board config to disk`,
        ``,
        `Strategy: first read the cached files that are most relevant to the question. If the cached data is insufficient, stale, or missing the detail needed, use fetch_live_work_items or fetch_item_history to query ADO directly. For questions about a specific item's journey, prefer fetch_item_history over loading the full history file.`,
        `Data honesty rule: never state any figures, item counts, tag values, or distributions without first loading the relevant data file or fetching live data in the current response. Do not speculate or recall values from earlier in the conversation — always re-check the source. If you are about to state a number or list, it must come from a tool call made in this response.`,
        `Honesty rule: never invent or guess data. If none of the tools or files can provide what is asked, say so clearly. You may then offer to write a standalone Python script (using util_ado.py or the ADO REST API directly) that the user can run themselves to retrieve the missing information.`,
        `Answer questions about flow metrics, blocked items, cycle time, WIP, and delivery patterns. Be specific — include work item IDs and titles.`,
        ``,
        `Correction learning workflow — two triggers:`,
        ``,
        `A) After step 3 pipeline approval (user says config looks good / ready to continue):`,
        `1. Call check_config_draft to detect whether they edited anything from the AI's original proposal.`,
        `2. If there are changes, explain them conversationally — e.g. "I noticed you reclassified 'Amigo' from waiting to active".`,
        `3. Ask: "Would you like me to save these as corrections so future boards start with better defaults?"`,
        `4. If the user says yes: your ONLY action is to call save_config_corrections. Do not search for files, read scripts, or run commands first.`,
        `5. Whether or not corrections are saved, continue with the pipeline.`,
        ``,
        `B) After any direct update_board_config call made at the user's explicit request (not during step 3 auto-config):`,
        `1. After confirming the change to the user, ask: "Would you like me to save this as a correction so future boards start with better defaults?"`,
        `2. If the user says yes: your ONLY action is to call save_config_corrections. The draft snapshot and log path are already set up — no file searching or script reading needed.`,
        ``,
        `RULE: when the user answers yes to saving corrections, the correct response is a single save_config_corrections tool call. Any file exploration before that call is wrong.`,
        ``,
        `Metrics re-run hint: after any update_board_config call, check the available data files listed above. If any output/metrics/ files are present (meaning the pipeline has already run metrics for this board), tell the user the dashboard is now stale and suggest: "To recalculate, run: python aiflowmetrics.py metrics". If no output/metrics/ files are listed, the pipeline hasn't run yet — say nothing.`,
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
        async (request, ctx, stream, token) => {
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
            ];

            // Replay prior turns so the model has full conversation context
            for (const turn of ctx.history) {
                if (turn instanceof vscode.ChatRequestTurn) {
                    messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
                } else if (turn instanceof vscode.ChatResponseTurn) {
                    const text = turn.response
                        .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
                        .map(p => p.value.value)
                        .join('');
                    if (text) { messages.push(vscode.LanguageModelChatMessage.Assistant(text)); }
                }
            }

            // Collect image attachments from references
            const imageParts: vscode.LanguageModelDataPart[] = [];
            const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
            for (const ref of request.references) {
                if (ref.value instanceof vscode.Uri && imageExts.has(path.extname(ref.value.fsPath).toLowerCase())) {
                    try {
                        const ext = path.extname(ref.value.fsPath).toLowerCase();
                        const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                            : ext === '.gif' ? 'image/gif'
                            : ext === '.webp' ? 'image/webp'
                            : 'image/png';
                        imageParts.push(new vscode.LanguageModelDataPart(fs.readFileSync(ref.value.fsPath), mime));
                    } catch { /* non-fatal — skip unreadable attachment */ }
                }
            }

            if (imageParts.length > 0) {
                messages.push(vscode.LanguageModelChatMessage.User([
                    ...imageParts,
                    new vscode.LanguageModelTextPart(request.prompt),
                ]));
            } else {
                messages.push(vscode.LanguageModelChatMessage.User(request.prompt));
            }

            // Tool-calling loop — up to 5 rounds (read_output_file may need multiple fetches)
            for (let round = 0; round < 5; round++) {
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
                    stream.progress(`${call.name === 'read_output_file' ? 'Reading' : 'Querying ADO'}: ${(call.input as any).file ?? (call.input as any).id ?? call.name.replace(/_/g, ' ')}…`);
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
                            const draftPath  = path.join(boardDir, 'output', 'data', 'config.ai_draft.json');
                            // snapshot pre-edit config so save_config_corrections can diff it
                            if (fs.existsSync(configPath) && !fs.existsSync(draftPath)) {
                                fs.copyFileSync(configPath, draftPath);
                            }
                            fs.writeFileSync(configPath, jsonStr, 'utf-8');
                            refresh?.();
                            vscode.commands.executeCommand('ai-flow-metrics.previewFile', configPath);
                            result = JSON.stringify({ success: true, offerCorrections: true });
                        } catch (e) {
                            result = JSON.stringify({ error: String(e) });
                        }                        } else if (call.name === 'read_output_file') {
                            const relPath = (call.input as { file: string }).file;
                            const allowed = READABLE_FILES.map(f => f.rel);
                            if (!allowed.includes(relPath)) {
                                result = JSON.stringify({ error: `Not a readable file: ${relPath}` });
                            } else {
                                const absPath = path.join(boardDir, relPath);
                                if (!fs.existsSync(absPath)) {
                                    result = JSON.stringify({ error: 'File not found — pipeline may not have run this step yet.' });
                                } else {
                                    const raw = fs.readFileSync(absPath, 'utf-8');
                                    result = raw.length > 100_000 ? raw.slice(0, 100_000) + '\n... (truncated)' : raw;
                                }
                            }
                        } else if (call.name === 'check_config_draft') {
                            const draftPath = path.join(boardDir, 'output', 'data', 'config.ai_draft.json');
                            const finalPath = path.join(boardDir, 'output', 'data', 'config.json');
                            if (!fs.existsSync(draftPath)) {
                                result = JSON.stringify({ hasDraft: false, message: 'No draft saved — written automatically when autoplay runs step 3.' });
                            } else {
                                const corrScript = path.join(context.extensionPath, 'resources', 'scripts', 'record_corrections.py');
                                const logPath = path.join(context.globalStorageUri.fsPath, 'corrections_log.json');
                                result = await runPython(corrScript, ['--draft', draftPath, '--final', finalPath, '--log', logPath, '--dry-run'], boardDir, env);
                            }
                        } else if (call.name === 'save_config_corrections') {
                            const draftPath = path.join(boardDir, 'output', 'data', 'config.ai_draft.json');
                            const finalPath = path.join(boardDir, 'output', 'data', 'config.json');
                            const logPath   = path.join(context.globalStorageUri.fsPath, 'corrections_log.json');
                            const choice = await vscode.window.showInformationMessage(
                                'Save corrections to the learning log for future boards?',
                                'Save', 'Skip'
                            );
                            if (choice !== 'Save') {
                                result = JSON.stringify({ saved: false });
                            } else {
                                const corrScript = path.join(context.extensionPath, 'resources', 'scripts', 'record_corrections.py');
                                result = await runPython(corrScript, ['--draft', draftPath, '--final', finalPath, '--log', logPath], boardDir, env);
                                try { fs.unlinkSync(draftPath); } catch { /* non-fatal */ }
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

export function registerLearnParticipant(
    context: vscode.ExtensionContext,
    getBoards: () => Board[],
): void {
    const participant = vscode.chat.createChatParticipant(
        'ai-flow-metrics.learn',
        async (request, _ctx, stream, _token) => {
            if (!request.prompt.trim()) {
                stream.markdown(
                    'Tell me what to remember about your team or board — for example:\n\n' +
                    '- *"Don\'t flag March throughput dips — those are always hackathon weeks"*\n' +
                    '- *"Our team calls cycle time \'delivery time\' — use that term in insights"*\n' +
                    '- *"High WIP in the Review column is normal for us and not a blocker"*\n\n' +
                    'Learnings are saved per board and injected into the AI context the next time Step 6 (Interpret Metrics) runs.'
                );
                return {};
            }

            const resolved = await resolveBoard(
                context.globalState, context.globalStorageUri.fsPath, getBoards, stream
            );
            if (!resolved) { return {}; }
            const { board, boardDir } = resolved;

            const learnScript = path.join(context.extensionPath, 'resources', 'scripts', 'record_learnings.py');
            const logPath = path.join(boardDir, 'output', 'data', 'interpretation_learnings.json');
            const env = { ...process.env, PYTHONUTF8: '1' };

            stream.progress('Saving learning…');
            try {
                const raw = await runPython(
                    learnScript,
                    ['--text', request.prompt.trim(), '--board', board.name, '--log', logPath],
                    boardDir,
                    env,
                );
                const result = JSON.parse(raw.trim());
                stream.markdown(
                    `**Saved** for **${board.name}** (${result.total} learning${result.total === 1 ? '' : 's'} total):\n\n` +
                    `> ${request.prompt.trim()}\n\n` +
                    `This will be included in the AI's context the next time you run **Step 6 — Interpret Metrics**. ` +
                    `To review or edit all saved learnings, open \`output/data/interpretation_learnings.json\` in the board folder.`
                );
            } catch (e) {
                stream.markdown(`Failed to save learning: ${e instanceof Error ? e.message : String(e)}`);
            }

            return {};
        }
    );
    participant.iconPath = new vscode.ThemeIcon('lightbulb');
    context.subscriptions.push(participant);
}
