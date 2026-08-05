import * as path from 'path';
import * as vscode from 'vscode';

interface StepConfig {
    label: string;
    description: string;
    contextValue: string;
}

const PIPELINE_STEPS: StepConfig[] = [
    { label: 'Fetch ADO Data',           description: 'Step 1', contextValue: 'step.fetch'    },
    { label: 'Data Quality Checks',       description: 'Step 2', contextValue: 'step.inactive' },
    { label: 'Configure Board (AI)',       description: 'Step 3', contextValue: 'step.inactive' },
    { label: 'Calculate Time in Columns', description: 'Step 4', contextValue: 'step.inactive' },
    { label: 'Calculate Cycle Time',      description: 'Step 5', contextValue: 'step.inactive' },
    { label: 'Calculate Lead Time',       description: 'Step 6', contextValue: 'step.inactive' },
    { label: 'Generate Dashboard',        description: 'Step 7', contextValue: 'step.inactive' },
    { label: 'Interpret Metrics (AI)',    description: 'Step 8', contextValue: 'step.inactive' },
    { label: 'Re-generate Dashboard',     description: 'Step 9', contextValue: 'step.inactive' },
];

class PipelineItem extends vscode.TreeItem {
    constructor(config: StepConfig) {
        super(config.label, vscode.TreeItemCollapsibleState.None);
        this.description = config.description;
        this.contextValue = config.contextValue;
    }
}

class PipelineProvider implements vscode.TreeDataProvider<PipelineItem> {
    getTreeItem(element: PipelineItem): vscode.TreeItem {
        return element;
    }
    getChildren(): PipelineItem[] {
        return PIPELINE_STEPS.map(s => new PipelineItem(s));
    }
}

export function activate(context: vscode.ExtensionContext) {
    vscode.window.registerTreeDataProvider('aiFlowMetrics.pipeline', new PipelineProvider());

    context.subscriptions.push(
        vscode.commands.registerCommand('ai-flow-metrics.helloWorld', () => {
            vscode.window.showInformationMessage('AI Flow Metrics is active!');
        }),

        vscode.commands.registerCommand('ai-flow-metrics.fetchData', async () => {
            const url = await vscode.window.showInputBox({
                prompt: 'Azure DevOps board URL',
                placeHolder: 'https://dev.azure.com/org/project/_boards/board/...',
                ignoreFocusOut: true,
            });
            if (!url) { return; }

            // extension/ lives one level inside the repo root
            const root = path.join(context.extensionPath, '..');
            const script = path.join(root, 'src', 'fetch_data.py');
            let terminal = vscode.window.terminals.find(t => t.name === 'AI Flow Metrics');
            if (!terminal) {
                terminal = vscode.window.createTerminal({ name: 'AI Flow Metrics' });
            }
            terminal.show();
            terminal.sendText(`python "${script}" "${url}"`);
        }),
    );
}

export function deactivate() {}

