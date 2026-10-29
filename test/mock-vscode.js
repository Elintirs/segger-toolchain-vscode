/* Minimal VS Code API mock so that extension modules can be loaded in plain Node. */
const config = {
    get(key, fallback) {
        return fallback;
    },
    async update() {},
};

const statusBar = { text: "", tooltip: "", command: "", show() {}, hide() {}, dispose() {} };

module.exports = {
    workspace: {
        getConfiguration: () => config,
        workspaceFolders: [],
    },
    window: {
        createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
        createStatusBarItem: () => statusBar,
        showErrorMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showInformationMessage: async () => undefined,
        showQuickPick: async () => undefined,
        showOpenDialog: async () => undefined,
        createWebviewPanel: () => ({ webview: { html: "" } }),
        withProgress: async (_options, task) =>
            task({ report() {} }, { isCancellationRequested: false, onCancellationRequested() {} }),
    },
    commands: {
        registerCommand: () => ({ dispose() {} }),
    },
    Uri: { file: (fsPath) => ({ fsPath }) },
    env: { openExternal: async () => true },
    ProgressLocation: { Notification: 15 },
    StatusBarAlignment: { Right: 2 },
    ConfigurationTarget: { Global: 1 },
};
