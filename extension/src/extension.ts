import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { openPreview } from './preview';

interface Board {
    id: string;
    name: string;
    url: string;
}

const PIPELINE_STEPS = [
    { label: 'Fetch Board Context',        description: 'Step 1',  contextValue: 'step.fetchContext', outputFile: 'output/data/context.json'                },
    { label: 'Fetch Work Items',           description: 'Step 2',  contextValue: 'step.fetchItems',   outputFile: 'output/data/work_items.json'              },
    { label: 'Data Quality Checks',        description: 'Step 3',  contextValue: 'step.checkData',    outputFile: 'output/data/data_quality_report.json'    },
    { label: 'Configure Board (AI)',        description: 'Step 4',  contextValue: 'step.configureBoard', outputFile: 'output/data/config.json'                 },
    { label: 'Calculate Time in Columns',  description: 'Step 5',  contextValue: 'step.inactive',     outputFile: 'output/metrics/time_in_columns.json'     },
    { label: 'Calculate Cycle Time',       description: 'Step 6',  contextValue: 'step.inactive',     outputFile: 'output/metrics/cycle_time.json'          },
    { label: 'Calculate Lead Time',        description: 'Step 7',  contextValue: 'step.inactive',     outputFile: 'output/metrics/lead_time.json'           },
    { label: 'Generate Dashboard',         description: 'Step 8',  contextValue: 'step.inactive',     outputFile:  'output/dashboard.html'                                                              },
    { label: 'Interpret Metrics (AI)',     description: 'Step 9',  contextValue: 'step.inactive',     outputFile:  'output/data/insights.json'                                                          },
    { label: 'Re-generate Dashboard',      description: 'Step 10', contextValue: 'step.inactive',     outputFiles: ['output/dashboard.html', 'output/data/insights.json'] as string[] },
];

function slugify(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'board';
}

// Extract a friendly name from an ADO board URL's team segment
function inferBoardName(url: string): string {
    try {
        const parts = new URL(url).pathname.split('/').filter(Boolean);
        const bi = parts.indexOf('_boards');
        // path: org/project/_boards/board/t/Team/BoardName
        if (bi >= 0 && parts[bi + 3]) {
            return decodeURIComponent(parts[bi + 3]).replace(/[+]/g, ' ');
        }
    } catch { /* invalid URL */ }
    return '';
}

function getOutputFiles(boardDir: string): string[] {
    const outDir = path.join(boardDir, 'output');
    if (!fs.existsSync(outDir)) { return []; }
    const results: string[] = [];
    const scan = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === '__pycache__') { continue; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(full); }
            else if (/\.(json|html)$/.test(entry.name)) { results.push(full); }
        }
    };
    scan(outDir);
    return results;
}

// ── Boards TreeView ────────────────────────────────────────────────────────

const FILE_LABELS: Record<string, string> = {
    'context.json':             'Board Context',
    'data_quality_report.json': 'Data Quality Report',
    'excluded_items.json':      'Excluded Work Items',
    'work_items.json':          'List of Work Items',
    'work_item_history.json':   'Work Item History',
    'work_item_rework.json':    'Work Item Backward Moves',
};

class FileItem extends vscode.TreeItem {
    constructor(readonly filePath: string, boardDir: string) {
        const filename = path.basename(filePath);
        super(FILE_LABELS[filename] ?? filename, vscode.TreeItemCollapsibleState.None);
        this.description = path.relative(path.join(boardDir, 'output'), path.dirname(filePath));
        this.resourceUri = vscode.Uri.file(filePath);
        const isHtml = filePath.endsWith('.html');
        this.command = isHtml
            ? { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(filePath)] }
            : { command: 'ai-flow-metrics.previewFile', title: 'Preview', arguments: [filePath] };
        this.contextValue = 'outputFile';
    }
}

class BoardItem extends vscode.TreeItem {
    constructor(readonly board: Board, isActive: boolean) {
        super(board.name, vscode.TreeItemCollapsibleState.Collapsed);
        this.tooltip = board.url;
        this.contextValue = isActive ? 'board.active' : 'board';
        this.iconPath = new vscode.ThemeIcon(isActive ? 'circle-filled' : 'circle-outline');
        this.command = {
            command: 'ai-flow-metrics.selectBoard',
            title: 'Select Board',
            arguments: [board],
        };
    }
}

class BoardsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private readonly state: vscode.Memento,
        private readonly globalStoragePath: string,
    ) {}

    refresh(): void { this._onDidChangeTreeData.fire(); }

    getBoards(): Board[] { return this.state.get<Board[]>('boards', []); }

    async addBoard(board: Board): Promise<void> {
        const boards = this.getBoards();
        boards.push(board);
        await this.state.update('boards', boards);
        this.refresh();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

    getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
        if (element instanceof BoardItem) {
            const boardDir = path.join(this.globalStoragePath, element.board.id);
            const files = getOutputFiles(boardDir);
            if (files.length === 0) {
                const empty = new vscode.TreeItem('No output yet');
                empty.iconPath = new vscode.ThemeIcon('info');
                return [empty];
            }
            return files.map(f => new FileItem(f, boardDir));
        }
        const boards = this.getBoards();
        if (boards.length === 0) {
            return [new vscode.TreeItem('No boards yet — click + to add one')];
        }
        const activeId = this.state.get<string>('activeBoardId');
        return boards.map(b => new BoardItem(b, b.id === activeId));
    }
}

// ── Pipeline TreeView ──────────────────────────────────────────────────────

class PipelineItem extends vscode.TreeItem {
    constructor(config: { label: string; description: string; contextValue: string }, done: boolean) {
        super(config.label, vscode.TreeItemCollapsibleState.None);
        this.description = config.description;
        this.contextValue = config.contextValue;
        this.iconPath = done
            ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
            : new vscode.ThemeIcon('circle-outline');
    }
}

class PipelineProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private readonly state: vscode.Memento,
        private readonly globalStoragePath: string,
    ) {}

    refresh(): void { this._onDidChangeTreeData.fire(); }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

    getChildren(): vscode.TreeItem[] {
        const activeId = this.state.get<string>('activeBoardId');
        if (!activeId) {
            return [new vscode.TreeItem('Select a board above to begin')];
        }
        const boardDir = path.join(this.globalStoragePath, activeId);
        return PIPELINE_STEPS.map(s => {
            const done = 'outputFiles' in s
                ? s.outputFiles!.every(f => fs.existsSync(path.join(boardDir, f)))
                : s.outputFile
                    ? fs.existsSync(path.join(boardDir, s.outputFile))
                    : false;
            return new PipelineItem(s, done);
        });
    }
}

// ── AI helpers ────────────────────────────────────────────────────────────

function extractJson(text: string): unknown {
    // Prefer a fenced JSON block, then fall back to bare object/array
    const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    const src = fenced ? fenced[1] : text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)?.[1] ?? text;
    return JSON.parse(src.trim());
}

async function runConfigureBoardAI(
    promptUri: vscode.Uri,
    dataDir: string,
    context: vscode.ExtensionContext,
): Promise<void> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (!models.length) {
        await vscode.commands.executeCommand('vscode.open', promptUri);
        vscode.window.showErrorMessage(
            'No Copilot language model available. Ensure GitHub Copilot is installed and signed in, then try again. The prompt has been opened for manual use.'
        );
        return;
    }

    const promptText = fs.readFileSync(promptUri.fsPath, 'utf-8');

    const panel = vscode.window.createWebviewPanel(
        'ai-flow-metrics.configuring',
        'Configure Board (AI)',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.webview.html = buildStreamingHtml(panel.webview);

    const cts = new vscode.CancellationTokenSource();
    context.subscriptions.push({ dispose: () => cts.dispose() });

    try {
        const response = await models[0].sendRequest(
            [vscode.LanguageModelChatMessage.User(promptText)],
            {},
            cts.token,
        );

        let fullText = '';
        for await (const chunk of response.stream) {
            if (chunk instanceof vscode.LanguageModelTextPart) {
                fullText += chunk.value;
                panel.webview.postMessage({ type: 'chunk', text: chunk.value });
            }
        }

        panel.webview.postMessage({ type: 'done' });

        let config: unknown;
        try {
            config = extractJson(fullText);
        } catch {
            panel.webview.postMessage({ type: 'error', message: 'Could not extract JSON from response — please complete config.json manually.' });
            return;
        }

        const configPath = path.join(dataDir, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        panel.webview.postMessage({ type: 'saved' });
    } finally {
        cts.dispose();
    }
}

function buildStreamingHtml(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);
    const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Configure Board (AI)</title>
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
       color: var(--vscode-foreground); background: var(--vscode-editor-background);
       margin: 0; padding: 16px; }
h2 { margin: 0 0 12px; font-size: 1.1em; opacity: 0.7; font-weight: normal; }
#output { white-space: pre-wrap; word-break: break-word; line-height: 1.6; }
#status { margin-top: 16px; font-style: italic; opacity: 0.6; }
#status.saved { color: var(--vscode-testing-iconPassed); font-style: normal; opacity: 1; }
#status.error { color: var(--vscode-errorForeground); font-style: normal; opacity: 1; }
.cursor { display: inline-block; width: 2px; height: 1em; background: currentColor;
          vertical-align: text-bottom; animation: blink 1s step-end infinite; }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
</style>
</head><body>
<h2>Configure Board (AI)</h2>
<div id="output"></div><span class="cursor" id="cursor"></span>
<div id="status">Calling Copilot…</div>
<script nonce="${nonce}">
const output = document.getElementById('output');
const status = document.getElementById('status');
const cursor = document.getElementById('cursor');
window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'chunk') {
        output.textContent += m.text;
        window.scrollTo(0, document.body.scrollHeight);
    } else if (m.type === 'done') {
        cursor.remove();
        status.textContent = 'Parsing response…';
    } else if (m.type === 'saved') {
        status.textContent = '✓ config.json saved — review it, then run the metrics steps.';
        status.className = 'saved';
    } else if (m.type === 'error') {
        cursor.remove();
        status.textContent = m.message;
        status.className = 'error';
    }
});
</script>
</body></html>`;
}

// ── Activate ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    const boardsProvider = new BoardsProvider(context.globalState, context.globalStorageUri.fsPath);
    const pipelineProvider = new PipelineProvider(context.globalState, context.globalStorageUri.fsPath);

    vscode.window.registerTreeDataProvider('aiFlowMetrics.boards', boardsProvider);
    vscode.window.registerTreeDataProvider('aiFlowMetrics.pipeline', pipelineProvider);

    // Refresh the boards tree whenever output files are created or deleted
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(context.globalStorageUri, '**/*.{json,html}')
    );
    watcher.onDidCreate(() => { boardsProvider.refresh(); pipelineProvider.refresh(); });
    watcher.onDidDelete(() => { boardsProvider.refresh(); pipelineProvider.refresh(); });
    context.subscriptions.push(watcher);

    context.subscriptions.push(
        vscode.commands.registerCommand('ai-flow-metrics.previewFile', (filePath: string) => {
            openPreview(filePath, context);
        }),

        vscode.commands.registerCommand('ai-flow-metrics.addBoard', async () => {
            const url = await vscode.window.showInputBox({
                prompt: 'Azure DevOps board URL',
                placeHolder: 'https://dev.azure.com/org/project/_boards/board/t/Team/...',
                ignoreFocusOut: true,
            });
            if (!url) { return; }

            const inferred = inferBoardName(url);
            const name = await vscode.window.showInputBox({
                prompt: 'Board name',
                value: inferred,
                ignoreFocusOut: true,
            });
            if (!name) { return; }

            const existing = boardsProvider.getBoards();
            const id = slugify(name);
            if (existing.some(b => b.id === id)) {
                vscode.window.showErrorMessage(`A board named "${name}" already exists.`);
                return;
            }

            const outputDir = path.join(context.globalStorageUri.fsPath, id);
            fs.mkdirSync(outputDir, { recursive: true });

            await boardsProvider.addBoard({ id, name, url });
            await context.globalState.update('activeBoardId', id);
            boardsProvider.refresh();
            pipelineProvider.refresh();
        }),

        vscode.commands.registerCommand('ai-flow-metrics.selectBoard', async (board: Board) => {
            await context.globalState.update('activeBoardId', board.id);
            boardsProvider.refresh();
            pipelineProvider.refresh();
        }),

        vscode.commands.registerCommand('ai-flow-metrics.removeBoard', async (item?: BoardItem) => {
            const board = item?.board ?? boardsProvider.getBoards().find(
                b => b.id === context.globalState.get<string>('activeBoardId')
            );
            if (!board) { return; }

            const answer = await vscode.window.showWarningMessage(
                `Remove "${board.name}" and delete all its output files?`,
                { modal: true },
                'Remove'
            );
            if (answer !== 'Remove') { return; }

            const boards = boardsProvider.getBoards().filter(b => b.id !== board.id);
            await context.globalState.update('boards', boards);

            const boardDir = path.join(context.globalStorageUri.fsPath, board.id);
            if (fs.existsSync(boardDir)) {
                fs.rmSync(boardDir, { recursive: true });
            }

            if (context.globalState.get<string>('activeBoardId') === board.id) {
                await context.globalState.update('activeBoardId', boards[0]?.id);
            }
            boardsProvider.refresh();
            pipelineProvider.refresh();
        }),

        vscode.commands.registerCommand('ai-flow-metrics.clearOutput', async (item?: BoardItem) => {
            const board = item?.board ?? boardsProvider.getBoards().find(
                b => b.id === context.globalState.get<string>('activeBoardId')
            );
            if (!board) { return; }

            const answer = await vscode.window.showWarningMessage(
                `Delete all output files for "${board.name}"?`,
                { modal: true },
                'Delete'
            );
            if (answer !== 'Delete') { return; }

            const outputDir = path.join(context.globalStorageUri.fsPath, board.id, 'output');
            if (fs.existsSync(outputDir)) {
                fs.rmSync(outputDir, { recursive: true });
            }
            boardsProvider.refresh();
        }),

        vscode.commands.registerCommand('ai-flow-metrics.fetchContext', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) { vscode.window.showErrorMessage('Select a board first.'); return; }

            const script = path.join(context.extensionPath, 'resources', 'scripts', 'fetch_data.py');
            const outputDir = path.join(context.globalStorageUri.fsPath, board.id);
            fs.mkdirSync(outputDir, { recursive: true });

            let terminal = vscode.window.terminals.find(t => t.name === 'AI Flow Metrics');
            if (!terminal) {
                terminal = vscode.window.createTerminal({ name: 'AI Flow Metrics', cwd: outputDir });
            }
            terminal.show();
            terminal.sendText(`pip install requests -q ; python "${script}" --context-only "${board.url}"`);
        }),

        vscode.commands.registerCommand('ai-flow-metrics.fetchWorkItems', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) { vscode.window.showErrorMessage('Select a board first.'); return; }

            const script = path.join(context.extensionPath, 'resources', 'scripts', 'fetch_data.py');
            const outputDir = path.join(context.globalStorageUri.fsPath, board.id);
            fs.mkdirSync(outputDir, { recursive: true });

            let terminal = vscode.window.terminals.find(t => t.name === 'AI Flow Metrics');
            if (!terminal) {
                terminal = vscode.window.createTerminal({ name: 'AI Flow Metrics', cwd: outputDir });
            }
            terminal.show();
            terminal.sendText(`pip install requests -q ; python "${script}" "${board.url}"`);
        }),

        vscode.commands.registerCommand('ai-flow-metrics.configureBoard', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) { vscode.window.showErrorMessage('Select a board first.'); return; }

            const script = path.join(context.extensionPath, 'resources', 'scripts', 'ai_configure_board.py');
            const outputDir = path.join(context.globalStorageUri.fsPath, board.id);
            const dataDir = path.join(outputDir, 'output', 'data');
            const promptPath = path.join(dataDir, 'ai_configure_board.prompt.md');

            // Remove stale prompt so onDidCreate always fires reliably
            if (fs.existsSync(promptPath)) { fs.unlinkSync(promptPath); }

            let terminal = vscode.window.terminals.find(t => t.name === 'AI Flow Metrics');
            if (!terminal) {
                terminal = vscode.window.createTerminal({ name: 'AI Flow Metrics', cwd: outputDir });
            }
            terminal.show();
            terminal.sendText(`python "${script}"`);

            vscode.window.showInformationMessage('Generating board configuration prompt…');

            const w = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(dataDir), 'ai_configure_board.prompt.md')
            );
            // onDidChange is the fallback if the OS reports a modify instead of create
            let handled = false;
            const handler = async (uri: vscode.Uri) => {
                if (handled) { return; }
                handled = true;
                d1.dispose(); d2.dispose(); w.dispose();
                await runConfigureBoardAI(uri, dataDir, context);
            };
            const d1 = w.onDidCreate(handler);
            const d2 = w.onDidChange(handler);
            context.subscriptions.push(w);
        }),

        vscode.commands.registerCommand('ai-flow-metrics.checkData', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) { vscode.window.showErrorMessage('Select a board first.'); return; }

            const script = path.join(context.extensionPath, 'resources', 'scripts', 'check_data.py');
            const outputDir = path.join(context.globalStorageUri.fsPath, board.id);

            let terminal = vscode.window.terminals.find(t => t.name === 'AI Flow Metrics');
            if (!terminal) {
                terminal = vscode.window.createTerminal({ name: 'AI Flow Metrics', cwd: outputDir });
            }
            terminal.show();
            terminal.sendText(`python "${script}"`);
        }),
    );
}

export function deactivate() {}

