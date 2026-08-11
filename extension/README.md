# AI Flow Metrics

Run the AI Flow Metrics pipeline directly from VS Code.

Fetch Azure DevOps board data, calculate cycle time, lead time, and time-in-columns, then generate an interactive dashboard — all from the Activity Bar.

## Features

- **Pipeline view** — run each step individually or as a group
- **Configurable time window** — rolling (4w / 3m / 6m / 1y) or custom date range
- **AI steps** — configure board columns and interpret metrics using GitHub Copilot
- **Dashboard preview** — live Chart.js dashboard rendered inside VS Code
- **GitHub Actions publish** — schedule automated dashboard updates in a GitHub repo
- **@flowmetrics chat participant** — ask questions about your metrics in Copilot Chat

## Requirements

- Python 3.10+
- An Azure DevOps Personal Access Token stored as `ADO_PAT` in your environment
- GitHub Copilot (for AI steps and `@flowmetrics` chat)

## Getting Started

1. Open the **AI Flow Metrics** panel in the Activity Bar
2. Click **Add Board** and paste your Azure DevOps board URL
3. Run each pipeline step in order, or use **Run All** on each group


Describe specific features of your extension including screenshots of your extension in action. Image paths are relative to this README file.

For example if there is an image subfolder under your extension project workspace:

\!\[feature X\]\(images/feature-x.png\)

> Tip: Many popular extensions utilize animations. This is an excellent way to show off your extension! We recommend short, focused animations that are easy to follow.

## Requirements

If you have any requirements or dependencies, add a section describing those and how to install and configure them.

## Extension Settings

Include if your extension adds any VS Code settings through the `contributes.configuration` extension point.

For example:

This extension contributes the following settings:

* `myExtension.enable`: Enable/disable this extension.
* `myExtension.thing`: Set to `blah` to do something.

## Known Issues

Calling out known issues can help limit users opening duplicate issues against your extension.

## Release Notes

Users appreciate release notes as you update your extension.

### 1.0.0

Initial release of ...

### 1.0.1

Fixed issue #.

### 1.1.0

Added features X, Y, and Z.

---

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
