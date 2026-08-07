import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { openPreview } from './preview';

interface Board {
    id: string;
    name: string;
    url: string;
}

interface PipelineStep {
    label: string;
    description: string;
    contextValue: string;
    outputFile?: string;
    doneCheck?: (boardDir: string) => boolean;
    group?: string;  // contextValue of the parent PipelineGroup
}

interface PipelineGroup {
    label: string;
    contextValue: string;
    description?: string;
    requires?: string;
}

const PIPELINE_STEPS: PipelineStep[] = [
    { label: 'Fetch Board Context',        description: 'Step 1', contextValue: 'step.fetchContext',       outputFile: 'output/data/context.json'                },
    { label: 'Fetch Work Items',           description: '',       contextValue: 'step.fetchItems',         outputFile: 'output/data/work_items.json',              group: 'group.fetchAndCheck'          },
    { label: 'Data Quality Checks',        description: '',       contextValue: 'step.checkData',          outputFile: 'output/data/data_quality_report.json',    group: 'group.fetchAndCheck'          },
    { label: 'Configure Board (AI)',       description: 'Step 3', contextValue: 'step.configureBoard',     outputFile: 'output/data/config.json'                 },
    { label: 'Calculate Time in Columns',  description: '',       contextValue: 'step.calcColumns',        outputFile: 'output/metrics/time_in_columns.json',     group: 'group.calculateMetrics'       },
    { label: 'Calculate Cycle Time',       description: '',       contextValue: 'step.calcCycleTime',      outputFile: 'output/metrics/cycle_time.json',          group: 'group.calculateMetrics'       },
    { label: 'Calculate Lead Time',        description: '',       contextValue: 'step.calcLeadTime',       outputFile: 'output/metrics/lead_time.json',           group: 'group.calculateMetrics'       },
    { label: 'Generate Dashboard',         description: 'Step 5', contextValue: 'step.generateDashboard',  outputFile: 'output/dashboard.html'                   },
    { label: 'Interpret Metrics (AI)',     description: '',       contextValue: 'step.interpretMetrics',   outputFile: 'output/data/insights.json',               group: 'group.interpretAndRegenerate' },
    {
        label: 'Re-generate Dashboard', description: '', contextValue: 'step.regenerateDashboard',
        group: 'group.interpretAndRegenerate',
        // Green when dashboard.html is newer than insights.json (meaning it was re-generated with insights)
        doneCheck: (boardDir) => {
            const dashboard = path.join(boardDir, 'output/dashboard.html');
            const insights  = path.join(boardDir, 'output/data/insights.json');
            return fs.existsSync(dashboard) && fs.existsSync(insights) &&
                fs.statSync(dashboard).mtimeMs >= fs.statSync(insights).mtimeMs;
        },
    },
];

const PIPELINE_GROUPS: PipelineGroup[] = [
    { label: 'Fetch & Check',          contextValue: 'group.fetchAndCheck',          description: 'Step 2', requires: 'output/data/context.json'      },
    { label: 'Calculate Metrics',      contextValue: 'group.calculateMetrics',       description: 'Step 4', requires: 'output/data/config.json'        },
    { label: 'Interpret & Regenerate', contextValue: 'group.interpretAndRegenerate', description: 'Step 6', requires: 'output/dashboard.html'          },
];

const STEP_PREREQS: Record<string, string> = {
    'step.fetchItems':              'output/data/context.json',
    'step.checkData':               'output/data/work_items.json',
    'step.configureBoard':          'output/data/data_quality_report.json',
    'step.calcColumns':             'output/data/config.json',
    'step.calcCycleTime':           'output/metrics/time_in_columns.json',
    'step.calcLeadTime':            'output/metrics/cycle_time.json',
    'step.generateDashboard':       'output/metrics/lead_time.json',
    'step.interpretMetrics':        'output/dashboard.html',
    'step.regenerateDashboard':     'output/data/insights.json',
    'group.fetchAndCheck':          'output/data/context.json',
    'group.calculateMetrics':       'output/data/config.json',
    'group.interpretAndRegenerate': 'output/dashboard.html',
};

function assertPrereq(key: string, boardDir: string): boolean {
    const rel = STEP_PREREQS[key];
    if (rel && !fs.existsSync(path.join(boardDir, rel))) {
        vscode.window.showErrorMessage(`Complete the previous step first — ${path.basename(rel)} not found.`);
        return false;
    }
    return true;
}

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
    'config.json':              'Board Configuration',
    'data_quality_report.json': 'Data Quality Report',
    'excluded_items.json':      'Excluded Work Items',
    'work_items.json':          'List of Work Items',
    'work_item_history.json':   'Work Item History',
    'work_item_rework.json':    'Work Item Backward Moves',
    'sprint_retro.json':        'Sprint Retrospective',
    'insights.json':            'AI Insights',
    'time_in_columns.json':     'Time in Columns',
    'cycle_time.json':          'Cycle Time',
    'lead_time.json':           'Lead Time',
    'dashboard.html':           'Dashboard',
};

class FileItem extends vscode.TreeItem {
    constructor(readonly filePath: string, boardDir: string) {
        const filename = path.basename(filePath);
        super(FILE_LABELS[filename] ?? filename, vscode.TreeItemCollapsibleState.None);
        this.description = path.relative(path.join(boardDir, 'output'), path.dirname(filePath));
        this.resourceUri = vscode.Uri.file(filePath);
        this.command = { command: 'ai-flow-metrics.previewFile', title: 'Preview', arguments: [filePath] };
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
    constructor(config: { label: string; description: string; contextValue: string }, done: boolean, isSubstep = false) {
        super(config.label, vscode.TreeItemCollapsibleState.None);
        this.description = config.description;
        this.contextValue = config.contextValue;
        this.iconPath = done
            ? new vscode.ThemeIcon(isSubstep ? 'check' : 'pass-filled', new vscode.ThemeColor('testing.iconPassed'))
            : new vscode.ThemeIcon('circle-outline');
    }
}

class PipelineGroupItem extends vscode.TreeItem {
    constructor(readonly group: PipelineGroup, allDone: boolean, isRunning = false) {
        super(group.label, isRunning ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        this.description = group.description;
        this.contextValue = group.contextValue;
        this.iconPath = allDone
            ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
            : new vscode.ThemeIcon('circle-outline');
    }
}

class PipelineProgressItem extends vscode.TreeItem {
    constructor(done: number, total: number) {
        const filled = Math.round((done / total) * 10);
        const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
        super(bar, vscode.TreeItemCollapsibleState.None);
        this.description = `${done} / ${total} steps`;
        this.tooltip = `${done} of ${total} pipeline steps completed`;
        this.contextValue = 'pipelineProgress';
    }
}

class PipelineProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private runningGroups = new Set<string>();

    constructor(
        private readonly state: vscode.Memento,
        private readonly globalStoragePath: string,
    ) {}

    refresh(): void { this._onDidChangeTreeData.fire(); }

    setGroupRunning(contextValue: string, running: boolean): void {
        running ? this.runningGroups.add(contextValue) : this.runningGroups.delete(contextValue);
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

    getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
        const activeId = this.state.get<string>('activeBoardId');
        if (!activeId) {
            return [new vscode.TreeItem('Select a board above to begin')];
        }
        const boardDir = path.join(this.globalStoragePath, activeId);

        const stepDone = (s: PipelineStep) =>
            s.doneCheck ? s.doneCheck(boardDir)
            : s.outputFile ? fs.existsSync(path.join(boardDir, s.outputFile))
            : false;

        if (element instanceof PipelineGroupItem) {
            return PIPELINE_STEPS.filter(s => s.group === element.contextValue).map(s => new PipelineItem(s, stepDone(s), true));
        }

        const doneCount = PIPELINE_STEPS.filter(stepDone).length;
        const seenGroups = new Set<string>();
        const items: vscode.TreeItem[] = [new PipelineProgressItem(doneCount, PIPELINE_STEPS.length)];
        for (const s of PIPELINE_STEPS) {
            if (!s.group) {
                items.push(new PipelineItem(s, stepDone(s)));
            } else if (!seenGroups.has(s.group)) {
                seenGroups.add(s.group);
                const grp = PIPELINE_GROUPS.find(g => g.contextValue === s.group)!;
                const allDone = PIPELINE_STEPS.filter(x => x.group === s.group).every(stepDone);
                items.push(new PipelineGroupItem(grp, allDone, this.runningGroups.has(s.group)));
            }
        }
        return items;
    }
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
    watcher.onDidCreate((uri) => {
        boardsProvider.refresh();
        pipelineProvider.refresh();
        openPreview(uri.fsPath, context);
    });
    watcher.onDidChange((uri) => {
        openPreview(uri.fsPath, context);
    });
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

        vscode.commands.registerCommand('ai-flow-metrics.deleteFile', async (item?: FileItem) => {
            if (!item?.filePath) { return; }
            const name = path.basename(item.filePath);
            const answer = await vscode.window.showWarningMessage(
                `Delete ${name}?`,
                { modal: true },
                'Delete'
            );
            if (answer !== 'Delete') { return; }
            fs.unlinkSync(item.filePath);
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
            if (!assertPrereq('step.fetchItems', outputDir)) { return; }
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
            if (!assertPrereq('step.configureBoard', outputDir)) { return; }
            const dataDir = path.join(outputDir, 'output', 'data');
            const promptPath = path.join(dataDir, 'ai_configure_board.prompt.md');
            const configPath = path.join(dataDir, 'config.json');

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Configure Board (AI)', cancellable: false },
                (progress) => new Promise<void>((resolve) => {
                    progress.report({ message: 'Generating prompt…' });
                    let output = '';
                    cp.exec(`python "${script}"`, { cwd: outputDir, env: { ...process.env, PYTHONUTF8: '1' } }, async (error, stdout, stderr) => {
                        output = (stdout + stderr).trim();
                        if (error || !fs.existsSync(promptPath)) {
                            resolve();
                            const detail = output || 'No output. Ensure Steps 1–3 have run successfully.';
                            vscode.window.showErrorMessage(`Step 4 failed: ${detail}`);
                            return;
                        }
                        progress.report({ message: 'Opening Copilot Chat…' });
                        const promptText = fs.readFileSync(promptPath, 'utf-8');
                        const query = `${promptText}\n\nWrite the resulting JSON config to "${configPath}".`;
                        await vscode.commands.executeCommand('workbench.action.chat.open', { query });
                        resolve();
                    });
                })
            );
        }),

        vscode.commands.registerCommand('ai-flow-metrics.checkData', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) { vscode.window.showErrorMessage('Select a board first.'); return; }

            const script = path.join(context.extensionPath, 'resources', 'scripts', 'check_data.py');
            const outputDir = path.join(context.globalStorageUri.fsPath, board.id);
            if (!assertPrereq('step.checkData', outputDir)) { return; }

            let terminal = vscode.window.terminals.find(t => t.name === 'AI Flow Metrics');
            if (!terminal) {
                terminal = vscode.window.createTerminal({ name: 'AI Flow Metrics', cwd: outputDir });
            }
            terminal.show();
            terminal.sendText(`python "${script}"`);
        }),

        vscode.commands.registerCommand('ai-flow-metrics.calculateTimeInColumns', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) { vscode.window.showErrorMessage('Select a board first.'); return; }

            const script = path.join(context.extensionPath, 'resources', 'scripts', 'calc_columns.py');
            const outputDir = path.join(context.globalStorageUri.fsPath, board.id);
            if (!assertPrereq('step.calcColumns', outputDir)) { return; }
            const outputPath = path.join(outputDir, 'output', 'metrics', 'time_in_columns.json');

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Calculate Time in Columns', cancellable: false },
                (progress) => new Promise<void>((resolve) => {
                    progress.report({ message: 'Running…' });
                    cp.exec(`python "${script}"`, { cwd: outputDir, env: { ...process.env, PYTHONUTF8: '1' } }, (error, stdout, stderr) => {
                        resolve();
                        const output = (stdout + stderr).trim();
                        if (error && !fs.existsSync(outputPath)) {
                            vscode.window.showErrorMessage(`Step 5 failed: ${output || 'No output. Ensure Steps 1–4 have run successfully.'}`);
                        } else {
                            boardsProvider.refresh();
                            pipelineProvider.refresh();
                        }
                    });
                })
            );
        }),

        vscode.commands.registerCommand('ai-flow-metrics.calculateCycleTime', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) { vscode.window.showErrorMessage('Select a board first.'); return; }

            const script = path.join(context.extensionPath, 'resources', 'scripts', 'calc_cycle_time.py');
            const outputDir = path.join(context.globalStorageUri.fsPath, board.id);
            if (!assertPrereq('step.calcCycleTime', outputDir)) { return; }
            const outputPath = path.join(outputDir, 'output', 'metrics', 'cycle_time.json');

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Calculate Cycle Time', cancellable: false },
                (progress) => new Promise<void>((resolve) => {
                    progress.report({ message: 'Running…' });
                    cp.exec(`python "${script}"`, { cwd: outputDir, env: { ...process.env, PYTHONUTF8: '1' } }, (error, stdout, stderr) => {
                        resolve();
                        const output = (stdout + stderr).trim();
                        if (error && !fs.existsSync(outputPath)) {
                            vscode.window.showErrorMessage(`Step 6 failed: ${output || 'No output. Ensure Steps 1–5 have run successfully.'}`);
                        } else {
                            boardsProvider.refresh();
                            pipelineProvider.refresh();
                        }
                    });
                })
            );
        }),

        vscode.commands.registerCommand('ai-flow-metrics.calculateLeadTime', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) { vscode.window.showErrorMessage('Select a board first.'); return; }

            const script = path.join(context.extensionPath, 'resources', 'scripts', 'calc_lead_time.py');
            const outputDir = path.join(context.globalStorageUri.fsPath, board.id);
            if (!assertPrereq('step.calcLeadTime', outputDir)) { return; }
            const outputPath = path.join(outputDir, 'output', 'metrics', 'lead_time.json');

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Calculate Lead Time', cancellable: false },
                (progress) => new Promise<void>((resolve) => {
                    progress.report({ message: 'Running…' });
                    cp.exec(`python "${script}"`, { cwd: outputDir, env: { ...process.env, PYTHONUTF8: '1' } }, (error, stdout, stderr) => {
                        resolve();
                        const output = (stdout + stderr).trim();
                        if (error && !fs.existsSync(outputPath)) {
                            vscode.window.showErrorMessage(`Step 7 failed: ${output || 'No output. Ensure Steps 1–6 have run successfully.'}`);
                        } else {
                            boardsProvider.refresh();
                            pipelineProvider.refresh();
                        }
                    });
                })
            );
        }),

        vscode.commands.registerCommand('ai-flow-metrics.generateDashboard', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) { vscode.window.showErrorMessage('Select a board first.'); return; }

            const script = path.join(context.extensionPath, 'resources', 'scripts', 'create_dashboard.py');
            const outputDir = path.join(context.globalStorageUri.fsPath, board.id);
            const outputPath = path.join(outputDir, 'output', 'dashboard.html');
            if (!assertPrereq('step.generateDashboard', outputDir)) { return; }

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Generate Dashboard', cancellable: false },
                (progress) => new Promise<void>((resolve) => {
                    progress.report({ message: 'Rendering…' });
                    cp.exec(`python "${script}"`, { cwd: outputDir, env: { ...process.env, PYTHONUTF8: '1' } }, (error, stdout, stderr) => {
                        resolve();
                        const output = (stdout + stderr).trim();
                        if (error && !fs.existsSync(outputPath)) {
                            vscode.window.showErrorMessage(`Step 8 failed: ${output || 'No output. Ensure Steps 1–7 have run successfully.'}`);
                        } else {
                            boardsProvider.refresh();
                            pipelineProvider.refresh();
                        }
                    });
                })
            );
        }),

        vscode.commands.registerCommand('ai-flow-metrics.interpretMetrics', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) { vscode.window.showErrorMessage('Select a board first.'); return; }

            const script = path.join(context.extensionPath, 'resources', 'scripts', 'ai_interpret_metrics.py');
            const outputDir = path.join(context.globalStorageUri.fsPath, board.id);
            if (!assertPrereq('step.interpretMetrics', outputDir)) { return; }
            const dataDir = path.join(outputDir, 'output', 'data');
            const promptPath = path.join(dataDir, 'ai_interpret_metrics.prompt.md');
            const insightsPath = path.join(dataDir, 'insights.json');

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Interpret Metrics (AI)', cancellable: false },
                (progress) => new Promise<void>((resolve) => {
                    progress.report({ message: 'Generating prompt…' });
                    cp.exec(`python "${script}"`, { cwd: outputDir, env: { ...process.env, PYTHONUTF8: '1' } }, async (error, stdout, stderr) => {
                        const output = (stdout + stderr).trim();
                        if (error || !fs.existsSync(promptPath)) {
                            resolve();
                            vscode.window.showErrorMessage(`Step 9 failed: ${output || 'No output. Ensure Steps 1–8 have run successfully.'}`);
                            return;
                        }
                        progress.report({ message: 'Opening Copilot Chat…' });
                        const promptText = fs.readFileSync(promptPath, 'utf-8');
                        const query = `${promptText}\n\nWrite the resulting JSON insights to "${insightsPath}".`;
                        await vscode.commands.executeCommand('workbench.action.chat.open', { query });
                        resolve();
                    });
                })
            );
        }),

        vscode.commands.registerCommand('ai-flow-metrics.regenerateDashboard', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) { vscode.window.showErrorMessage('Select a board first.'); return; }

            const script = path.join(context.extensionPath, 'resources', 'scripts', 'create_dashboard.py');
            const outputDir = path.join(context.globalStorageUri.fsPath, board.id);
            const outputPath = path.join(outputDir, 'output', 'dashboard.html');
            if (!assertPrereq('step.regenerateDashboard', outputDir)) { return; }

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Re-generate Dashboard', cancellable: false },
                (progress) => new Promise<void>((resolve) => {
                    progress.report({ message: 'Rendering…' });
                    cp.exec(`python "${script}" --force`, { cwd: outputDir, env: { ...process.env, PYTHONUTF8: '1' } }, (error, stdout, stderr) => {
                        resolve();
                        const output = (stdout + stderr).trim();
                        if (error && !fs.existsSync(outputPath)) {
                            vscode.window.showErrorMessage(`Step 10 failed: ${output || 'No output. Ensure Steps 1–9 have run successfully.'}`);
                        } else {
                            boardsProvider.refresh();
                            pipelineProvider.refresh();
                        }
                    });
                })
            );
        }),
        vscode.commands.registerCommand('ai-flow-metrics.runFetchAndCheckGroup', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) { vscode.window.showErrorMessage('Select a board first.'); return; }

            const fetchScript = path.join(context.extensionPath, 'resources', 'scripts', 'fetch_data.py');
            const checkScript = path.join(context.extensionPath, 'resources', 'scripts', 'check_data.py');
            const outputDir = path.join(context.globalStorageUri.fsPath, board.id);
            if (!assertPrereq('group.fetchAndCheck', outputDir)) { return; }
            fs.mkdirSync(outputDir, { recursive: true });

            let terminal = vscode.window.terminals.find(t => t.name === 'AI Flow Metrics');
            if (!terminal) {
                terminal = vscode.window.createTerminal({ name: 'AI Flow Metrics', cwd: outputDir });
            }
            terminal.show();
            terminal.sendText(`pip install requests -q ; python "${fetchScript}" "${board.url}" ; python "${checkScript}"`);
            pipelineProvider.setGroupRunning('group.fetchAndCheck', true);
        }),

        vscode.commands.registerCommand('ai-flow-metrics.runCalculationsGroup', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) { vscode.window.showErrorMessage('Select a board first.'); return; }

            const outputDir = path.join(context.globalStorageUri.fsPath, board.id);
            if (!assertPrereq('group.calculateMetrics', outputDir)) { return; }
            const env = { ...process.env, PYTHONUTF8: '1' };

            pipelineProvider.setGroupRunning('group.calculateMetrics', true);
            const runStep = (scriptName: string, outputFile: string, stepNum: number) =>
                new Promise<boolean>(resolve => {
                    const script = path.join(context.extensionPath, 'resources', 'scripts', scriptName);
                    cp.exec(`python "${script}"`, { cwd: outputDir, env }, (error, stdout, stderr) => {
                        const output = (stdout + stderr).trim();
                        if (error && !fs.existsSync(path.join(outputDir, outputFile))) {
                            vscode.window.showErrorMessage(`Step ${stepNum} failed: ${output || 'No output.'}`);
                            resolve(false);
                        } else { resolve(true); }
                    });
                });

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Calculate Metrics (3 steps)', cancellable: false },
                async (progress) => {
                    progress.report({ message: 'Time in Columns (5/7)…' });
                    if (!await runStep('calc_columns.py', 'output/metrics/time_in_columns.json', 5)) return;
                    progress.report({ message: 'Cycle Time (6/7)…', increment: 33 });
                    if (!await runStep('calc_cycle_time.py', 'output/metrics/cycle_time.json', 6)) return;
                    progress.report({ message: 'Lead Time (7/7)…', increment: 33 });
                    if (!await runStep('calc_lead_time.py', 'output/metrics/lead_time.json', 7)) return;
                    pipelineProvider.setGroupRunning('group.calculateMetrics', false);
                    boardsProvider.refresh(); pipelineProvider.refresh();
                }
            );
        }),

        vscode.commands.registerCommand('ai-flow-metrics.runInterpretAndRegenerateGroup', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) { vscode.window.showErrorMessage('Select a board first.'); return; }

            const outputDir = path.join(context.globalStorageUri.fsPath, board.id);
            if (!assertPrereq('group.interpretAndRegenerate', outputDir)) { return; }

            pipelineProvider.setGroupRunning('group.interpretAndRegenerate', true);
            // Step 9: generate prompt and open Copilot Chat
            await vscode.commands.executeCommand('ai-flow-metrics.interpretMetrics');

            // Auto-run step 10 as soon as Copilot writes insights.json
            let triggered = false;
            const insightsWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(path.join(outputDir, 'output', 'data')), 'insights.json')
            );
            const autoRegen = async () => {
                if (triggered) return;
                triggered = true;
                insightsWatcher.dispose();
                await vscode.commands.executeCommand('ai-flow-metrics.regenerateDashboard');
                pipelineProvider.setGroupRunning('group.interpretAndRegenerate', false);
            };
            insightsWatcher.onDidCreate(() => autoRegen());
            insightsWatcher.onDidChange(() => autoRegen());
            setTimeout(() => { if (!triggered) insightsWatcher.dispose(); }, 15 * 60 * 1000);
        }),

        vscode.commands.registerCommand('ai-flow-metrics.autoplay', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) { vscode.window.showErrorMessage('Select a board first.'); return; }

            const outputDir = path.join(context.globalStorageUri.fsPath, board.id);

            /** Wait for a file relative to outputDir, up to timeoutMs. */
            function waitForFile(relPath: string, timeoutMs: number): Promise<boolean> {
                const absPath = path.join(outputDir, relPath);
                if (fs.existsSync(absPath)) { return Promise.resolve(true); }
                return new Promise<boolean>(resolve => {
                    const dir = path.dirname(absPath);
                    const file = path.basename(absPath);
                    const watcher = vscode.workspace.createFileSystemWatcher(
                        new vscode.RelativePattern(vscode.Uri.file(dir), file)
                    );
                    let done = false;
                    const finish = (ok: boolean) => {
                        if (done) return;
                        done = true;
                        watcher.dispose();
                        clearTimeout(timer);
                        resolve(ok);
                    };
                    watcher.onDidCreate(() => finish(true));
                    watcher.onDidChange(() => finish(true));
                    const timer = setTimeout(() => finish(false), timeoutMs);
                });
            }

            const exists = (rel: string) => fs.existsSync(path.join(outputDir, rel));

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'AI Flow Metrics — Autoplay', cancellable: false },
                async (progress) => {
                    // Step 1: Fetch Board Context
                    if (!exists('output/data/context.json')) {
                        progress.report({ message: 'Step 1 — Fetching board context…' });
                        await vscode.commands.executeCommand('ai-flow-metrics.fetchContext');
                        if (!await waitForFile('output/data/context.json', 2 * 60 * 1000)) {
                            vscode.window.showErrorMessage('Autoplay stopped: Step 1 timed out.');
                            return;
                        }
                    }

                    // Steps 2–3: Fetch & Check group (terminal-based)
                    if (!exists('output/data/data_quality_report.json')) {
                        progress.report({ message: 'Steps 2–3 — Fetching work items & data quality check…' });
                        await vscode.commands.executeCommand('ai-flow-metrics.runFetchAndCheckGroup');
                        if (!await waitForFile('output/data/data_quality_report.json', 10 * 60 * 1000)) {
                            vscode.window.showErrorMessage('Autoplay stopped: Steps 2–3 timed out.');
                            return;
                        }
                    }

                    // Step 4: Configure Board (AI — opens Copilot Chat, user must complete)
                    if (!exists('output/data/config.json')) {
                        progress.report({ message: 'Step 4 — Configure Board (AI) — waiting for config.json…' });
                        await vscode.commands.executeCommand('ai-flow-metrics.configureBoard');
                        if (!await waitForFile('output/data/config.json', 30 * 60 * 1000)) {
                            vscode.window.showErrorMessage('Autoplay stopped: Step 4 timed out (config.json not written).');
                            return;
                        }
                    }

                    // Steps 5–7: Calculate Metrics group
                    if (!exists('output/metrics/lead_time.json')) {
                        progress.report({ message: 'Steps 5–7 — Calculating metrics…' });
                        await vscode.commands.executeCommand('ai-flow-metrics.runCalculationsGroup');
                        if (!await waitForFile('output/metrics/lead_time.json', 5 * 60 * 1000)) {
                            vscode.window.showErrorMessage('Autoplay stopped: Steps 5–7 timed out.');
                            return;
                        }
                    }

                    // Step 8: Generate Dashboard
                    progress.report({ message: 'Step 8 — Generating dashboard…' });
                    await vscode.commands.executeCommand('ai-flow-metrics.generateDashboard');
                    await waitForFile('output/dashboard.html', 2 * 60 * 1000);

                    // Steps 9–10: Interpret & Regenerate (auto-chained)
                    progress.report({ message: 'Steps 9–10 — Interpreting metrics (AI)…' });
                    await vscode.commands.executeCommand('ai-flow-metrics.runInterpretAndRegenerateGroup');
                }
            );
        }),    );
}

export function deactivate() {}
