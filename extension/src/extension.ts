import * as cp from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
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
    {
        label: 'Interpret Metrics (AI)', description: 'Step 6', contextValue: 'step.interpretMetrics',
        // Done when dashboard has been re-generated with the AI insights
        doneCheck: (boardDir) => {
            const dashboard = path.join(boardDir, 'output/dashboard.html');
            const insights  = path.join(boardDir, 'output/data/insights.json');
            return fs.existsSync(dashboard) && fs.existsSync(insights) &&
                fs.statSync(dashboard).mtimeMs >= fs.statSync(insights).mtimeMs;
        },
    },
];

const PIPELINE_GROUPS: PipelineGroup[] = [
    { label: 'Fetch & Check',     contextValue: 'group.fetchAndCheck',    description: 'Step 2', requires: 'output/data/context.json' },
    { label: 'Calculate Metrics', contextValue: 'group.calculateMetrics', description: 'Step 4', requires: 'output/data/config.json'   },
];

const STEP_PREREQS: Record<string, string> = {
    'step.fetchItems':     'output/data/context.json',
    'step.checkData':      'output/data/work_items.json',
    'step.configureBoard': 'output/data/data_quality_report.json',
    'step.calcColumns':    'output/data/config.json',
    'step.calcCycleTime':  'output/metrics/time_in_columns.json',
    'step.calcLeadTime':   'output/metrics/cycle_time.json',
    'step.generateDashboard': 'output/metrics/lead_time.json',
    'step.interpretMetrics':  'output/dashboard.html',
    'group.fetchAndCheck':    'output/data/context.json',
    'group.calculateMetrics': 'output/data/config.json',
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
    results.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
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

        // Count progress at the top-level granularity (groups count as 1 unit)
        let totalTopLevel = 0, doneTopLevel = 0;
        const seenForProgress = new Set<string>();
        for (const s of PIPELINE_STEPS) {
            if (!s.group) {
                totalTopLevel++;
                if (stepDone(s)) { doneTopLevel++; }
            } else if (!seenForProgress.has(s.group)) {
                seenForProgress.add(s.group);
                totalTopLevel++;
                if (PIPELINE_STEPS.filter(x => x.group === s.group).every(stepDone)) { doneTopLevel++; }
            }
        }

        const seenGroups = new Set<string>();
        const items: vscode.TreeItem[] = [new PipelineProgressItem(doneTopLevel, totalTopLevel)];
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

// ── Publish helpers ────────────────────────────────────────────────────────

// Returns ADO PAT from env, then SecretStorage, then prompts the user once and stores it
async function getAdoPat(context: vscode.ExtensionContext): Promise<string | undefined> {
    if (process.env.ADO_PAT) { return process.env.ADO_PAT; }
    const stored = await context.secrets.get('ADO_PAT');
    if (stored) { return stored; }
    const input = await vscode.window.showInputBox({
        prompt: 'Azure DevOps Personal Access Token (stored securely in VS Code)',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'Paste your read-only ADO PAT here',
    });
    if (!input?.trim()) { return undefined; }
    await context.secrets.store('ADO_PAT', input.trim());
    return input.trim();
}

// Creates or reuses the AI Flow Metrics terminal, injecting ADO_PAT when it's not in process.env
function getOrCreateTerminal(cwd: string, adoPat?: string): vscode.Terminal {
    if (process.env.ADO_PAT || !adoPat) {
        return vscode.window.terminals.find(t => t.name === 'AI Flow Metrics')
            ?? vscode.window.createTerminal({ name: 'AI Flow Metrics', cwd });
    }
    // PAT from storage — must inject via terminal env; dispose stale terminal that lacks it
    vscode.window.terminals.find(t => t.name === 'AI Flow Metrics')?.dispose();
    return vscode.window.createTerminal({ name: 'AI Flow Metrics', cwd, env: { ADO_PAT: adoPat } });
}

function slugifyRepoName(name: string): string {
    return 'flow-metrics-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function runGh(cmd: string): Promise<string> {
    return new Promise((resolve, reject) =>
        cp.exec(cmd, (err, stdout, stderr) =>
            err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())
        )
    );
}

// Pipes value via stdin to avoid shell escaping issues (e.g. for secrets)
function runGhStdin(cmd: string, stdin: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = cp.exec(cmd, (err, _out, stderr) =>
            err ? reject(new Error((stderr || err.message).trim())) : resolve()
        );
        proc.stdin?.write(stdin);
        proc.stdin?.end();
    });
}

// Copies output files, skipping .prompt.md and dashboard.html (published separately as index.html)
function copyOutputFiles(src: string, dest: string): void {
    if (!fs.existsSync(src)) { return; }
    for (const item of fs.readdirSync(src, { withFileTypes: true })) {
        if (item.name.endsWith('.prompt.md') || item.name === 'dashboard.html') { continue; }
        const s = path.join(src, item.name), d = path.join(dest, item.name);
        if (item.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyOutputFiles(s, d); }
        else { fs.copyFileSync(s, d); }
    }
}

function generateWorkflowYaml(cronExpr: string): string {
    return [
        'name: Update Dashboard',
        'on:',
        '  schedule:',
        `    - cron: '${cronExpr}'`,
        '  workflow_dispatch:',
        'jobs:',
        '  update:',
        '    runs-on: ubuntu-latest',
        '    permissions:',
        '      contents: write',
        '      copilot-requests: write',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - uses: actions/setup-python@v5',
        '        with:',
        '          python-version: "3.11"',
        '      - name: Install dependencies',
        '        run: pip install requests jinja2 github-copilot-sdk -q',
        '      - name: Clean stale data',
        '        run: |',
        '          rm -f output/data/work_items.json',
        '          rm -f output/data/work_item_history.json',
        '          rm -f output/data/work_item_rework.json',
        '          rm -f output/data/excluded_items.json',
        '          rm -f output/data/sprint_retro.json',
        '          rm -f output/data/data_quality_report.json',
        '          rm -f output/metrics/time_in_columns.json',
        '          rm -f output/metrics/cycle_time.json',
        '          rm -f output/metrics/lead_time.json',
        '          rm -f output/data/insights.json',
        '      - name: Fetch data',
        '        env:',
        '          ADO_PAT: ${{ secrets.ADO_PAT }}',
        '        run: python scripts/fetch_data.py "${{ vars.BOARD_URL }}"',
        '      - name: Check data',
        '        run: python scripts/check_data.py',
        '      - name: Calculate metrics',
        '        run: |',
        '          python scripts/calc_columns.py',
        '          python scripts/calc_cycle_time.py',
        '          python scripts/calc_lead_time.py',
        '      - name: Interpret metrics (AI)',
        '        env:',
        '          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
        '          AI_API_KEY: ${{ secrets.AI_API_KEY }}',
        '          AI_API_ENDPOINT: ${{ vars.AI_API_ENDPOINT }}',
        '          AI_MODEL: ${{ vars.AI_MODEL }}',
        '        run: python scripts/ai_interpret_metrics.py --auto',
        '        continue-on-error: true',
        '      - name: Generate dashboard',
        '        run: python scripts/create_dashboard.py --force',
        '      - name: Update index.html',
        '        run: cp output/dashboard.html index.html',
        '      - name: Commit and push',
        '        run: |',
        '          git config user.email "github-actions@github.com"',
        '          git config user.name "GitHub Actions"',
        '          git add -A',
        '          git diff --quiet && git diff --staged --quiet || git commit -m "Dashboard updated $(date -u +%Y-%m-%dT%H:%M:%SZ)"',
        '          git push',
    ].join('\n');
}

function githubPost(token: string, apiPath: string, body: object): Promise<void> {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = https.request({
            hostname: 'api.github.com', path: apiPath, method: 'POST',
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'User-Agent': 'ai-flow-metrics-vscode',
            }
        }, res => {
            let raw = '';
            res.on('data', (c: string) => raw += c);
            res.on('end', () => (res.statusCode ?? 0) < 400 ? resolve() : reject(new Error(`GitHub ${res.statusCode}: ${raw}`)));
        });
        req.on('error', reject);
        req.write(data); req.end();
    });
}

// ── Publish Panel ──────────────────────────────────────────────────────────

class PublishProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private readonly globalState: vscode.Memento,
    ) {}

    refresh() { this._onDidChangeTreeData.fire(); }
    getTreeItem(item: vscode.TreeItem) { return item; }

    getChildren(): vscode.TreeItem[] {
        const activeId = this.globalState.get<string>('activeBoardId');
        if (!activeId) { return [new vscode.TreeItem('No board selected')]; }

        const repo      = this.globalState.get<string>(`publishRepo.${activeId}`);
        const publishedAt = this.globalState.get<string>(`publishedAt.${activeId}`);

        if (!repo) {
            const item = new vscode.TreeItem('Not yet published', vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('circle-outline');
            item.contextValue = 'publish.unpublished';
            return [item];
        }

        const isPublic = this.globalState.get<boolean>(`publishIsPublic.${activeId}`);
        const cleanRepo = repo.replace(/^https?:\/\/github\.com\//, '');
        const [owner, repoName] = cleanRepo.split('/');
        const pagesUrl = `https://${owner}.github.io/${repoName}`;
        const dateStr  = publishedAt
            ? new Date(publishedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
            : '';

        const repoItem = new vscode.TreeItem(cleanRepo, vscode.TreeItemCollapsibleState.None);
        repoItem.description  = dateStr ? `published ${dateStr}` : '';
        repoItem.iconPath     = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
        repoItem.contextValue = 'publish.repo';
        repoItem.command      = { command: 'vscode.open', title: 'Open Repository', arguments: [vscode.Uri.parse(`https://github.com/${cleanRepo}`)] };
        repoItem.tooltip      = `https://github.com/${cleanRepo}`;

        const items: vscode.TreeItem[] = [repoItem];

        if (isPublic) {
            const pagesItem = new vscode.TreeItem(pagesUrl.replace('https://', ''), vscode.TreeItemCollapsibleState.None);
            pagesItem.description  = 'live dashboard';
            pagesItem.iconPath     = new vscode.ThemeIcon('globe');
            pagesItem.contextValue = 'publish.pages';
            pagesItem.command      = { command: 'vscode.open', title: 'Open Dashboard', arguments: [vscode.Uri.parse(pagesUrl)] };
            pagesItem.tooltip      = pagesUrl;
            items.push(pagesItem);
        }

        const schedule = this.globalState.get<string>(`publishSchedule.${activeId}`);
        const schedItem = new vscode.TreeItem('Schedule', vscode.TreeItemCollapsibleState.None);
        schedItem.description  = schedule ?? 'not configured';
        schedItem.iconPath     = new vscode.ThemeIcon('calendar');
        schedItem.contextValue = schedule ? 'publish.schedule.configured' : 'publish.schedule';
        items.push(schedItem);

        return items;
    }
}

// ── Activate ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    const boardsProvider   = new BoardsProvider(context.globalState, context.globalStorageUri.fsPath);
    const pipelineProvider  = new PipelineProvider(context.globalState, context.globalStorageUri.fsPath);
    const publishProvider   = new PublishProvider(context.globalState);

    vscode.window.registerTreeDataProvider('aiFlowMetrics.boards',   boardsProvider);
    vscode.window.registerTreeDataProvider('aiFlowMetrics.pipeline', pipelineProvider);
    vscode.window.registerTreeDataProvider('aiFlowMetrics.publish',  publishProvider);

    // Refresh trees whenever output files are created or deleted
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
            publishProvider.refresh();
        }),

        vscode.commands.registerCommand('ai-flow-metrics.selectBoard', async (board: Board) => {
            await context.globalState.update('activeBoardId', board.id);
            boardsProvider.refresh();
            pipelineProvider.refresh();
            publishProvider.refresh();
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
            publishProvider.refresh();
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

            const adoPat = await getAdoPat(context);
            if (!adoPat) { return; }
            const terminal = getOrCreateTerminal(outputDir, adoPat);
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

            const adoPat = await getAdoPat(context);
            if (!adoPat) { return; }
            const terminal = getOrCreateTerminal(outputDir, adoPat);
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
                    cp.exec(`python "${script}" --force`, { cwd: outputDir, env: { ...process.env, PYTHONUTF8: '1' } }, (error, stdout, stderr) => {
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

            let chatOpened = false;
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Interpret Metrics (AI)', cancellable: false },
                (progress) => new Promise<void>((resolve) => {
                    progress.report({ message: 'Generating prompt…' });
                    cp.exec(`python "${script}"`, { cwd: outputDir, env: { ...process.env, PYTHONUTF8: '1' } }, async (error, stdout, stderr) => {
                        const output = (stdout + stderr).trim();
                        if (error || !fs.existsSync(promptPath)) {
                            resolve();
                            vscode.window.showErrorMessage(`Step 6 failed: ${output || 'No output. Ensure Steps 1–5 have run successfully.'}`);
                            return;
                        }
                        progress.report({ message: 'Opening Copilot Chat…' });
                        const promptText = fs.readFileSync(promptPath, 'utf-8');
                        const query = `${promptText}\n\nWrite the resulting JSON insights to "${insightsPath}".`;
                        await vscode.commands.executeCommand('workbench.action.chat.open', { query });
                        chatOpened = true;
                        resolve();
                    });
                })
            );
            // Auto-regenerate the dashboard as soon as Copilot writes insights.json
            if (chatOpened) {
                let triggered = false;
                const insightsWatcher = vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(vscode.Uri.file(path.join(outputDir, 'output', 'data')), 'insights.json')
                );
                const autoRegen = async () => {
                    if (triggered) return;
                    triggered = true;
                    insightsWatcher.dispose();
                    await vscode.commands.executeCommand('ai-flow-metrics.regenerateDashboard');
                };
                insightsWatcher.onDidCreate(() => autoRegen());
                insightsWatcher.onDidChange(() => autoRegen());
                setTimeout(() => { if (!triggered) { insightsWatcher.dispose(); } }, 15 * 60 * 1000);
            }
        }),

        vscode.commands.registerCommand('ai-flow-metrics.regenerateDashboard', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) { vscode.window.showErrorMessage('Select a board first.'); return; }

            const script = path.join(context.extensionPath, 'resources', 'scripts', 'create_dashboard.py');
            const outputDir = path.join(context.globalStorageUri.fsPath, board.id);
            const outputPath = path.join(outputDir, 'output', 'dashboard.html');

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

            const adoPat = await getAdoPat(context);
            if (!adoPat) { return; }
            const terminal = getOrCreateTerminal(outputDir, adoPat);
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

                    // Step 2: Fetch & Check group (terminal-based)
                    if (!exists('output/data/data_quality_report.json')) {
                        progress.report({ message: 'Step 2 — Fetching work items & data quality check…' });
                        await vscode.commands.executeCommand('ai-flow-metrics.runFetchAndCheckGroup');
                        if (!await waitForFile('output/data/data_quality_report.json', 10 * 60 * 1000)) {
                            vscode.window.showErrorMessage('Autoplay stopped: Step 2 timed out.');
                            return;
                        }
                    }

                    // Step 3: Configure Board (AI — opens Copilot Chat, user must complete)
                    if (!exists('output/data/config.json')) {
                        progress.report({ message: 'Step 3 — Configure Board (AI) — waiting for config.json…' });
                        await vscode.commands.executeCommand('ai-flow-metrics.configureBoard');
                        if (!await waitForFile('output/data/config.json', 30 * 60 * 1000)) {
                            vscode.window.showErrorMessage('Autoplay stopped: Step 3 timed out (config.json not written).');
                            return;
                        }
                    }

                    // Step 4: Calculate Metrics group
                    if (!exists('output/metrics/lead_time.json')) {
                        progress.report({ message: 'Step 4 — Calculating metrics…' });
                        await vscode.commands.executeCommand('ai-flow-metrics.runCalculationsGroup');
                        if (!await waitForFile('output/metrics/lead_time.json', 5 * 60 * 1000)) {
                            vscode.window.showErrorMessage('Autoplay stopped: Step 4 timed out.');
                            return;
                        }
                    }

                    // Step 5: Generate Dashboard
                    progress.report({ message: 'Step 5 — Generating dashboard…' });
                    await vscode.commands.executeCommand('ai-flow-metrics.generateDashboard');
                    await waitForFile('output/dashboard.html', 2 * 60 * 1000);

                    // Step 6: Interpret — auto-regenerates dashboard when Copilot writes insights.json
                    progress.report({ message: 'Step 6 — Interpreting metrics (AI)…' });
                    await vscode.commands.executeCommand('ai-flow-metrics.interpretMetrics');

                }
            );
        }),

        vscode.commands.registerCommand('ai-flow-metrics.autoplayWithReview', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) { vscode.window.showErrorMessage('Select a board first.'); return; }

            const outputDir = path.join(context.globalStorageUri.fsPath, board.id);

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
                    if (!exists('output/data/context.json')) {
                        progress.report({ message: 'Step 1 — Fetching board context…' });
                        await vscode.commands.executeCommand('ai-flow-metrics.fetchContext');
                        if (!await waitForFile('output/data/context.json', 2 * 60 * 1000)) {
                            vscode.window.showErrorMessage('Autoplay stopped: Step 1 timed out.');
                            return;
                        }
                    }

                    if (!exists('output/data/data_quality_report.json')) {
                        progress.report({ message: 'Step 2 — Fetching work items & data quality check…' });
                        await vscode.commands.executeCommand('ai-flow-metrics.runFetchAndCheckGroup');
                        if (!await waitForFile('output/data/data_quality_report.json', 10 * 60 * 1000)) {
                            vscode.window.showErrorMessage('Autoplay stopped: Step 2 timed out.');
                            return;
                        }
                    }

                    if (!exists('output/data/config.json')) {
                        progress.report({ message: 'Step 3 — Configure Board (AI) — waiting for config.json…' });
                        await vscode.commands.executeCommand('ai-flow-metrics.configureBoard');
                        if (!await waitForFile('output/data/config.json', 30 * 60 * 1000)) {
                            vscode.window.showErrorMessage('Autoplay stopped: Step 3 timed out (config.json not written).');
                            return;
                        }
                    }

                    // Pause for human review before continuing
                    progress.report({ message: 'Step 3 complete — review board config, then continue.' });
                    const choice = await vscode.window.showInformationMessage(
                        'Board configured (Step 3 complete). Review config.json, then continue autoplay.',
                        { modal: true }, 'Continue', 'Stop'
                    );
                    if (choice !== 'Continue') { return; }

                    if (!exists('output/metrics/lead_time.json')) {
                        progress.report({ message: 'Step 4 — Calculating metrics…' });
                        await vscode.commands.executeCommand('ai-flow-metrics.runCalculationsGroup');
                        if (!await waitForFile('output/metrics/lead_time.json', 5 * 60 * 1000)) {
                            vscode.window.showErrorMessage('Autoplay stopped: Step 4 timed out.');
                            return;
                        }
                    }

                    progress.report({ message: 'Step 5 — Generating dashboard…' });
                    await vscode.commands.executeCommand('ai-flow-metrics.generateDashboard');
                    await waitForFile('output/dashboard.html', 2 * 60 * 1000);

                    progress.report({ message: 'Step 6 — Interpreting metrics (AI)…' });
                    await vscode.commands.executeCommand('ai-flow-metrics.interpretMetrics');

                }
            );
        }),

        vscode.commands.registerCommand('ai-flow-metrics.publishDashboard', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) { vscode.window.showErrorMessage('Select a board first.'); return; }

            const boardDir = path.join(context.globalStorageUri.fsPath, board.id);
            const dashboardSrc = path.join(boardDir, 'output', 'dashboard.html');
            if (!fs.existsSync(dashboardSrc)) {
                vscode.window.showErrorMessage('No dashboard found. Run the pipeline first.');
                return;
            }

            // Re-use saved repo; only prompt on first publish (or after re-link)
            let fullRepo = context.globalState.get<string>(`publishRepo.${activeId}`);
            if (!fullRepo) {
                const input = await vscode.window.showInputBox({
                    prompt: 'GitHub repository (owner/repo)',
                    placeHolder: `myorg/${slugifyRepoName(board.name)}`,
                    ignoreFocusOut: true,
                    validateInput: v => v.includes('/') ? undefined : 'Must be owner/repo',
                });
                if (!input) { return; }
                fullRepo = input.trim();
            }
            fullRepo = fullRepo.replace(/^https?:\/\/github\.com\//, '');

            const [owner, repoName] = fullRepo.split('/');

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Publish Dashboard', cancellable: false },
                async (progress) => {
                    // 1. Check gh CLI + auth
                    progress.report({ message: 'Checking GitHub CLI…' });
                    try { await runGh('gh --version'); }
                    catch { vscode.window.showErrorMessage('GitHub CLI (gh) not found. Install from https://cli.github.com'); return; }
                    try { await runGh('gh auth status'); }
                    catch { vscode.window.showErrorMessage('Not logged in to GitHub CLI. Run: gh auth login'); return; }

                    // 2. Create repo if it doesn't exist
                    let isNew = false;
                    progress.report({ message: `Checking ${fullRepo}…` });
                    let repoExists = true;
                    try { await runGh(`gh repo view "${fullRepo}"`); }
                    catch { repoExists = false; }

                    let isPublic = false;
                    if (!repoExists) {
                        const visibilityPick = await vscode.window.showQuickPick(
                            [
                                { label: '$(lock) Private', description: 'Pages requires GitHub Pro / Teams / Enterprise', value: '--private' },
                                { label: '$(globe) Public',  description: 'Anyone can view — dashboard data will be visible', value: '--public'  },
                            ],
                            { title: 'Repository visibility', ignoreFocusOut: true }
                        );
                        if (!visibilityPick) { return; }
                        const visibilityFlag = (visibilityPick as { value: string }).value;
                        isPublic = visibilityFlag === '--public';
                        progress.report({ message: `Creating ${fullRepo}…` });
                        try {
                            await runGh(`gh repo create "${fullRepo}" ${visibilityFlag} --description "AI Flow Metrics dashboard for ${board.name}"`);
                            isNew = true;
                        } catch (e) { vscode.window.showErrorMessage(`Could not create repo: ${e}`); return; }
                    } else {
                        // Query visibility of the existing repo
                        try {
                            const isPrivateStr = await runGh(`gh repo view "${fullRepo}" --json isPrivate --jq .isPrivate`);
                            isPublic = isPrivateStr.trim() === 'false';
                        } catch { /* assume private if query fails */ }
                    }

                    // 3. Clone → clear → copy → commit → push
                    const tmpDir = path.join(os.tmpdir(), `aiflowmetrics-publish-${Date.now()}`);
                    progress.report({ message: 'Cloning repository…' });
                    try {
                        await runGh(`gh repo clone "${fullRepo}" "${tmpDir}"`);
                    } catch (e) { vscode.window.showErrorMessage(`Clone failed: ${e}`); return; }

                    try {
                        for (const item of fs.readdirSync(tmpDir)) {
                            if (item === '.git' || item === '.github' || item === 'scripts') { continue; }
                            fs.rmSync(path.join(tmpDir, item), { recursive: true });
                        }
                        copyOutputFiles(path.join(boardDir, 'output'), path.join(tmpDir, 'output'));
                        fs.copyFileSync(dashboardSrc, path.join(tmpDir, 'index.html'));

                        progress.report({ message: 'Publishing to GitHub…' });
                        const gitCmds = [
                            `git -C "${tmpDir}" config user.email "aiflowmetrics@users.noreply.github.com"`,
                            `git -C "${tmpDir}" config user.name "AI Flow Metrics"`,
                            `git -C "${tmpDir}" add -A`,
                            `git -C "${tmpDir}" commit -m "Dashboard published ${new Date().toISOString()}"`,
                            isNew
                                ? `git -C "${tmpDir}" push -u origin HEAD:main`
                                : `git -C "${tmpDir}" push`,
                        ];
                        for (const cmd of gitCmds) {
                            await runGh(cmd).catch(() => {}); // commit is a no-op if nothing changed
                        }

                        if (isNew) {
                            progress.report({ message: 'Enabling GitHub Pages…' });
                            try {
                                const token = await runGh('gh auth token');
                                await githubPost(token, `/repos/${fullRepo}/pages`, { source: { branch: 'main', path: '/' } });
                            } catch { /* Pages may already be on, or org policy differs */ }
                        }
                    } finally {
                        // git may still hold handles on Windows — ignore EPERM
                        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
                    }

                    await context.globalState.update(`publishRepo.${activeId}`, fullRepo);
                    await context.globalState.update(`publishedAt.${activeId}`, new Date().toISOString());
                    await context.globalState.update(`publishIsPublic.${activeId}`, isPublic);
                    publishProvider.refresh();

                    const pagesUrl = `https://${owner}.github.io/${repoName}`;
                    const repoUrl  = `https://github.com/${fullRepo}`;
                    if (isNew && isPublic) {
                        vscode.window.showInformationMessage(
                            `Published to ${fullRepo}. GitHub Pages will be live at ${pagesUrl} in ~1 minute.`,
                            'Open Repository'
                        ).then(c => { if (c === 'Open Repository') { vscode.env.openExternal(vscode.Uri.parse(repoUrl)); } });
                    } else {
                        vscode.window.showInformationMessage(
                            `Dashboard published to ${fullRepo}`,
                            ...(isPublic ? ['Open Dashboard' as const] : []), 'Open Repository' as const
                        ).then(c => {
                            if (c === 'Open Dashboard')  { vscode.env.openExternal(vscode.Uri.parse(pagesUrl)); }
                            if (c === 'Open Repository') { vscode.env.openExternal(vscode.Uri.parse(repoUrl)); }
                        });
                    }
                }
            );
        }),

        vscode.commands.registerCommand('ai-flow-metrics.configureSchedule', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            const board = boardsProvider.getBoards().find(b => b.id === activeId);
            if (!board) { vscode.window.showErrorMessage('Select a board first.'); return; }

            const fullRepo = context.globalState.get<string>(`publishRepo.${activeId}`);
            if (!fullRepo) {
                vscode.window.showErrorMessage('Publish the dashboard first, then configure a schedule.');
                return;
            }
            const cleanRepo = fullRepo.replace(/^https?:\/\/github\.com\//, '');

            const isConfigured = !!context.globalState.get<string>(`publishSchedule.${activeId}`);

            const SCHEDULES = [
                { label: 'Daily at 9am UTC',          cron: '0 9 * * *', description: 'Every day at 09:00 UTC' },
                { label: 'Weekly — Monday 9am UTC',   cron: '0 9 * * 1', description: 'Every Monday at 09:00 UTC' },
                { label: 'Weekly — Friday 9am UTC',   cron: '0 9 * * 5', description: 'Every Friday at 09:00 UTC' },
                { label: '$(edit) Custom cron…',      cron: '',          description: 'Enter a cron expression' },
                ...(isConfigured ? [{ label: '$(trash) Remove schedule', cron: 'remove', description: 'Delete the workflow from the repo' }] : []),
            ];
            const pick = await vscode.window.showQuickPick(SCHEDULES, { title: 'Schedule', ignoreFocusOut: true });
            if (!pick) { return; }

            // ── Remove ────────────────────────────────────────────────────
            if (pick.cron === 'remove') {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Remove Schedule', cancellable: false },
                    async (progress) => {
                        const tmpDir = path.join(os.tmpdir(), `aiflowmetrics-schedule-${Date.now()}`);
                        progress.report({ message: 'Cloning repository…' });
                        try { await runGh(`gh repo clone "${cleanRepo}" "${tmpDir}"`); }
                        catch (e) { vscode.window.showErrorMessage(`Clone failed: ${e}`); return; }
                        try {
                            const workflowFile = path.join(tmpDir, '.github', 'workflows', 'update-dashboard.yml');
                            if (fs.existsSync(workflowFile)) { fs.unlinkSync(workflowFile); }
                            const gitCmds = [
                                `git -C "${tmpDir}" config user.email "aiflowmetrics@users.noreply.github.com"`,
                                `git -C "${tmpDir}" config user.name "AI Flow Metrics"`,
                                `git -C "${tmpDir}" add -A`,
                                `git -C "${tmpDir}" commit -m "Remove scheduled update workflow"`,
                                `git -C "${tmpDir}" push`,
                            ];
                            for (const cmd of gitCmds) { await runGh(cmd).catch(() => {}); }
                        } finally {
                            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
                        }
                        await context.globalState.update(`publishSchedule.${activeId}`, undefined);
                        publishProvider.refresh();
                        vscode.window.showInformationMessage('Schedule removed.');
                    }
                );
                return;
            }

            // ── Add / Edit ────────────────────────────────────────────────
            let cronExpr = pick.cron;
            if (!cronExpr) {
                const input = await vscode.window.showInputBox({
                    prompt: 'Cron expression (UTC)',
                    placeHolder: '0 9 * * 1',
                    ignoreFocusOut: true,
                    validateInput: v => v.trim().split(/\s+/).length === 5 ? undefined : 'Must be 5 fields: minute hour day month weekday',
                });
                if (!input) { return; }
                cronExpr = input.trim();
            }

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Configure Schedule', cancellable: false },
                async (progress) => {
                    const tmpDir = path.join(os.tmpdir(), `aiflowmetrics-schedule-${Date.now()}`);
                    progress.report({ message: 'Cloning repository…' });
                    try { await runGh(`gh repo clone "${cleanRepo}" "${tmpDir}"`); }
                    catch (e) { vscode.window.showErrorMessage(`Clone failed: ${e}`); return; }

                    try {
                        // Write workflow
                        const workflowDir = path.join(tmpDir, '.github', 'workflows');
                        fs.mkdirSync(workflowDir, { recursive: true });
                        fs.writeFileSync(path.join(workflowDir, 'update-dashboard.yml'), generateWorkflowYaml(cronExpr));

                        // Copy Python scripts + dashboard template
                        const scriptsDir = path.join(tmpDir, 'scripts');
                        const templatesDir = path.join(scriptsDir, 'templates');
                        const promptsDir  = path.join(scriptsDir, 'prompts');
                        fs.mkdirSync(templatesDir, { recursive: true });
                        fs.mkdirSync(promptsDir,   { recursive: true });
                        const scriptNames = ['fetch_data.py','util_ado.py','check_data.py','calc_columns.py','calc_cycle_time.py','calc_lead_time.py','create_dashboard.py','ai_interpret_metrics.py'];
                        for (const s of scriptNames) {
                            fs.copyFileSync(
                                path.join(context.extensionPath, 'resources', 'scripts', s),
                                path.join(scriptsDir, s)
                            );
                        }
                        fs.copyFileSync(
                            path.join(context.extensionPath, 'resources', 'scripts', 'templates', 'dashboard.html'),
                            path.join(templatesDir, 'dashboard.html')
                        );
                        fs.copyFileSync(
                            path.join(context.extensionPath, 'resources', 'scripts', 'prompts', 'ai_interpret_metrics.prompt.md'),
                            path.join(promptsDir, 'ai_interpret_metrics.prompt.md')
                        );

                        progress.report({ message: 'Committing workflow…' });
                        const gitCmds = [
                            `git -C "${tmpDir}" config user.email "aiflowmetrics@users.noreply.github.com"`,
                            `git -C "${tmpDir}" config user.name "AI Flow Metrics"`,
                            `git -C "${tmpDir}" add -A`,
                            `git -C "${tmpDir}" commit -m "${isConfigured ? 'Update' : 'Add'} scheduled update workflow (${cronExpr})"`,
                            `git -C "${tmpDir}" push`,
                        ];
                        for (const cmd of gitCmds) { await runGh(cmd).catch(() => {}); }

                        // Set BOARD_URL as Actions variable
                        progress.report({ message: 'Setting BOARD_URL variable…' });
                        try {
                            await runGh(`gh api repos/${cleanRepo}/actions/variables -X POST -f name=BOARD_URL -f value="${board.url}"`);
                        } catch {
                            // Variable may already exist — try PATCH
                            await runGh(`gh api repos/${cleanRepo}/actions/variables/BOARD_URL -X PATCH -f value="${board.url}"`).catch(() => {});
                        }

                        // Set ADO_PAT secret from env or SecretStorage (optional — skip if unavailable)
                        const adoPat = process.env.ADO_PAT ?? await context.secrets.get('ADO_PAT');
                        if (adoPat) {
                            progress.report({ message: 'Setting ADO_PAT secret…' });
                            try { await runGhStdin(`gh secret set ADO_PAT --repo "${cleanRepo}"`, adoPat); }
                            catch { /* non-fatal — user can set manually */ }
                        }

                        // Set AI_API_KEY secret if stored (optional — powers automated AI interpretation)
                        const aiApiKey = process.env.AI_API_KEY ?? await context.secrets.get('AI_API_KEY');
                        if (aiApiKey) {
                            progress.report({ message: 'Setting AI_API_KEY secret…' });
                            try { await runGhStdin(`gh secret set AI_API_KEY --repo "${cleanRepo}"`, aiApiKey); }
                            catch { /* non-fatal */ }
                        }
                    } finally {
                        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
                    }

                    const scheduleLabel = pick.cron ? pick.label : cronExpr;
                    await context.globalState.update(`publishSchedule.${activeId}`, scheduleLabel);
                    publishProvider.refresh();

                    const secretsUrl = `https://github.com/${cleanRepo}/settings/secrets/actions/new`;
                    const hasAdoPat = !!(process.env.ADO_PAT ?? await context.secrets.get('ADO_PAT'));
                    const msg = hasAdoPat
                        ? `Schedule configured: ${scheduleLabel}`
                        : `Schedule configured. Add ADO_PAT as a repository secret to enable data fetching.`;
                    vscode.window.showInformationMessage(msg, ...(hasAdoPat ? [] : ['Set ADO_PAT Secret']))
                        .then(c => { if (c === 'Set ADO_PAT Secret') { vscode.env.openExternal(vscode.Uri.parse(secretsUrl)); } });
                }
            );
        }),

        vscode.commands.registerCommand('ai-flow-metrics.runScheduleNow', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            if (!activeId) { return; }
            const fullRepo = context.globalState.get<string>(`publishRepo.${activeId}`);
            if (!fullRepo) { return; }
            const cleanRepo = fullRepo.replace(/^https?:\/\/github\.com\//, '');

            // Ensure ADO_PAT secret is up to date before triggering
            const adoPat = await getAdoPat(context);
            if (!adoPat) { return; }

            try { await runGhStdin(`gh secret set ADO_PAT --repo "${cleanRepo}"`, adoPat); }
            catch { /* non-fatal */ }

            try {
                await runGh(`gh workflow run update-dashboard.yml --repo "${cleanRepo}"`);
                vscode.window.showInformationMessage(
                    'Workflow triggered. Check progress on GitHub Actions.',
                    'Open Actions'
                ).then(c => {
                    if (c === 'Open Actions') {
                        vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${cleanRepo}/actions`));
                    }
                });
            } catch (e) {
                vscode.window.showErrorMessage(`Could not trigger workflow: ${e}`);
            }
        }),

        vscode.commands.registerCommand('ai-flow-metrics.setAdoPat', async () => {
            const input = await vscode.window.showInputBox({
                prompt: 'Azure DevOps Personal Access Token — leave blank to clear',
                password: true,
                ignoreFocusOut: true,
                placeHolder: 'Paste your read-only ADO PAT here',
            });
            if (input === undefined) { return; } // cancelled
            if (input.trim()) {
                await context.secrets.store('ADO_PAT', input.trim());
                vscode.window.showInformationMessage('ADO PAT saved.');
            } else {
                await context.secrets.delete('ADO_PAT');
                vscode.window.showInformationMessage('ADO PAT cleared.');
            }
        }),

        vscode.commands.registerCommand('ai-flow-metrics.setAiApiKey', async () => {
            const input = await vscode.window.showInputBox({
                prompt: 'AI API key for automated insights (OpenAI, Azure AI Foundry, etc.) — leave blank to clear',
                password: true,
                ignoreFocusOut: true,
                placeHolder: 'Paste your API key here',
            });
            if (input === undefined) { return; }
            if (input.trim()) {
                await context.secrets.store('AI_API_KEY', input.trim());
                vscode.window.showInformationMessage('AI API key saved. Re-run Configure Schedule to push it to GitHub.');
            } else {
                await context.secrets.delete('AI_API_KEY');
                vscode.window.showInformationMessage('AI API key cleared.');
            }
        }),

        vscode.commands.registerCommand('ai-flow-metrics.relinkRepo', async () => {
            const activeId = context.globalState.get<string>('activeBoardId');
            if (!activeId) { return; }
            const previousRepo      = context.globalState.get<string>(`publishRepo.${activeId}`);
            const previousAt        = context.globalState.get<string>(`publishedAt.${activeId}`);
            const previousIsPublic  = context.globalState.get<boolean>(`publishIsPublic.${activeId}`);
            await context.globalState.update(`publishRepo.${activeId}`, undefined);
            await context.globalState.update(`publishedAt.${activeId}`, undefined);
            await context.globalState.update(`publishIsPublic.${activeId}`, undefined);
            publishProvider.refresh();
            await vscode.commands.executeCommand('ai-flow-metrics.publishDashboard');
            // If the user cancelled without publishing, restore the previous state
            if (!context.globalState.get(`publishRepo.${activeId}`)) {
                await context.globalState.update(`publishRepo.${activeId}`, previousRepo);
                await context.globalState.update(`publishedAt.${activeId}`, previousAt);
                await context.globalState.update(`publishIsPublic.${activeId}`, previousIsPublic);
                publishProvider.refresh();
            }
        }),
    );
}

export function deactivate() {}
