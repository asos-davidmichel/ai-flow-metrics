import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface Board {
    id: string;
    name: string;
    url: string;
}

const PIPELINE_STEPS = [
    { label: 'Fetch ADO Data',            description: 'Step 1', contextValue: 'step.fetch'    },
    { label: 'Data Quality Checks',        description: 'Step 2', contextValue: 'step.inactive' },
    { label: 'Configure Board (AI)',        description: 'Step 3', contextValue: 'step.inactive' },
    { label: 'Calculate Time in Columns',  description: 'Step 4', contextValue: 'step.inactive' },
    { label: 'Calculate Cycle Time',       description: 'Step 5', contextValue: 'step.inactive' },
    { label: 'Calculate Lead Time',        description: 'Step 6', contextValue: 'step.inactive' },
    { label: 'Generate Dashboard',         description: 'Step 7', contextValue: 'step.inactive' },
    { label: 'Interpret Metrics (AI)',     description: 'Step 8', contextValue: 'step.inactive' },
    { label: 'Re-generate Dashboard',      description: 'Step 9', contextValue: 'step.inactive' },
];

function slugify(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'board';
}

// ── Boards TreeView ────────────────────────────────────────────────────────

class BoardItem extends vscode.TreeItem {
    constructor(readonly board: Board, isActive: boolean) {
        super(board.name, vscode.TreeItemCollapsibleState.None);
        this.description = board.url.replace(/^https?:\/\//, '').slice(0, 50);
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

    constructor(private readonly state: vscode.Memento) {}

    refresh(): void { this._onDidChangeTreeData.fire(); }

    getBoards(): Board[] { return this.state.get<Board[]>('boards', []); }

    async addBoard(board: Board): Promise<void> {
        const boards = this.getBoards();
        boards.push(board);
        await this.state.update('boards', boards);
        this.refresh();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

    getChildren(): vscode.TreeItem[] {
        const boards = this.getBoards();
        if (boards.length === 0) {
            const empty = new vscode.TreeItem('No boards yet — click + to add one');
            return [empty];
        }
        const activeId = this.state.get<string>('activeBoardId');
        return boards.map(b => new BoardItem(b, b.id === activeId));
    }
}

// ── Pipeline TreeView ──────────────────────────────────────────────────────

class PipelineItem extends vscode.TreeItem {
    constructor(config: { label: string; description: string; contextValue: string }) {
        super(config.label, vscode.TreeItemCollapsibleState.None);
        this.description = config.description;
        this.contextValue = config.contextValue;
    }
}

class PipelineProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly state: vscode.Memento) {}

    refresh(): void { this._onDidChangeTreeData.fire(); }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

    getChildren(): vscode.TreeItem[] {
        if (!this.state.get<string>('activeBoardId')) {
            return [new vscode.TreeItem('Select a board above to begin')];
        }
        return PIPELINE_STEPS.map(s => new PipelineItem(s));
    }
}

// ── Activate ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    const boardsProvider = new BoardsProvider(context.globalState);
    const pipelineProvider = new PipelineProvider(context.globalState);

    vscode.window.registerTreeDataProvider('aiFlowMetrics.boards', boardsProvider);
    vscode.window.registerTreeDataProvider('aiFlowMetrics.pipeline', pipelineProvider);

    context.subscriptions.push(
        vscode.commands.registerCommand('ai-flow-metrics.addBoard', async () => {
            const name = await vscode.window.showInputBox({
                prompt: 'Board name (e.g. "Team Alpha")',
                ignoreFocusOut: true,
            });
            if (!name) { return; }

            const existing = boardsProvider.getBoards();
            const id = slugify(name);
            if (existing.some(b => b.id === id)) {
                vscode.window.showErrorMessage(`A board named "${name}" already exists.`);
                return;
            }

            const url = await vscode.window.showInputBox({
                prompt: 'Azure DevOps board URL',
                placeHolder: 'https://dev.azure.com/org/project/_boards/board/...',
                ignoreFocusOut: true,
            });
            if (!url) { return; }

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

        vscode.commands.registerCommand('ai-flow-metrics.fetchData', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) {
                vscode.window.showErrorMessage('Select a board first.');
                return;
            }

            const script = path.join(context.extensionPath, 'resources', 'scripts', 'fetch_data.py');
            const outputDir = path.join(context.globalStorageUri.fsPath, board.id);
            fs.mkdirSync(outputDir, { recursive: true });

            let terminal = vscode.window.terminals.find(t => t.name === 'AI Flow Metrics');
            if (!terminal) {
                terminal = vscode.window.createTerminal({ name: 'AI Flow Metrics', cwd: outputDir });
            }
            terminal.show();
            // Install the only external dep quietly, then run the fetch script
            terminal.sendText(`pip install requests -q ; python "${script}" "${board.url}"`);
        }),
    );
}

export function deactivate() {}

