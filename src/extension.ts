import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { buildPreset, findBuiltElf } from "./build";
import { flash } from "./flash";
import { findGccPreset, readPresetBinaryDir, userPresetsPath } from "./presets";
import { convertProject, ConvertResult } from "./project";
import { describeSes, findSesInstallations, pickSes, resolveSes, SesInstall } from "./ses";
import { formatBytes, measureSize, renderComparePanel } from "./size";
import { ensureToolchainPackage } from "./toolchainPkg";
import { readJsoncFile, workspaceFolder } from "./util";

let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;
let lastElf: string | undefined;
let lastSize: number | undefined;
let activeSes: SesInstall | undefined;

export function activate(context: vscode.ExtensionContext): void {
    extensionContext = context;
    output = vscode.window.createOutputChannel("SEGGER Toolchain");
    context.subscriptions.push(output);

    status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    status.command = "segger.build";
    context.subscriptions.push(status);

    const register = (id: string, handler: (...args: unknown[]) => unknown) =>
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));

    register("segger.setup", () => runSafely(setupProject));
    register("segger.build", () => runSafely(() => buildWith(getPresetName())));
    register("segger.buildGcc", () => runSafely(buildWithGcc));
    register("segger.compare", () => runSafely(compareSizes));
    register("segger.clean", () => runSafely(cleanBuilds));
    register("segger.flash", () => runSafely(flashTarget));
    register("segger.selectStudio", () => runSafely(selectStudio));
    register("segger.updatePackage", () => runSafely(updatePackage));
    register("segger.showInfo", () => runSafely(showInfo));

    void refreshStatus();
}

export function deactivate(): void {
    /* nothing to do */
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function getPresetName(): string {
    return vscode.workspace.getConfiguration("segger").get<string>("presetName", "segger-debug");
}

function getProjectDir(): string | undefined {
    const folder = workspaceFolder();
    if (!folder) {
        void vscode.window.showErrorMessage("Open a folder with a CMake project first.");
        return undefined;
    }
    return folder.uri.fsPath;
}

function hasPreset(projectDir: string, presetName: string): boolean {
    const data = readJsoncFile<{ configurePresets?: Array<{ name?: string }> }>(userPresetsPath(projectDir));
    return Boolean(data?.configurePresets?.some((p) => p.name === presetName));
}

async function runSafely(fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`ERROR: ${message}`);
        output.show(true);
        void vscode.window.showErrorMessage(`SEGGER: ${message}`);
    }
}

async function refreshStatus(): Promise<void> {
    const folder = workspaceFolder();
    if (!folder) {
        status.text = "$(chip) SEGGER";
        status.tooltip = "Open a project to use the SEGGER toolchain";
        status.show();
        return;
    }
    const projectDir = folder.uri.fsPath;
    const presetName = getPresetName();
    activeSes = findSesInstallations(vscode.workspace.getConfiguration("segger").get<string>("studioPath", "") || undefined)[0];
    if (!hasPreset(projectDir, presetName)) {
        status.text = "$(chip) SEGGER: setup";
        status.tooltip = "SEGGER toolchain is not configured for this project. Click to set it up.";
        status.command = "segger.setup";
    } else {
        const sizeText = lastSize !== undefined ? ` · ${lastSize} B` : "";
        status.text = `$(chip) SEGGER${sizeText}`;
        status.tooltip = [
            `Preset: ${presetName}`,
            activeSes ? describeSes(activeSes) : "SEGGER Embedded Studio not found",
            "Click to build",
        ].join("\n");
        status.command = "segger.build";
    }
    status.show();
}

async function requireConfigured(): Promise<{ projectDir: string; presetName: string } | undefined> {
    const projectDir = getProjectDir();
    if (!projectDir) {
        return undefined;
    }
    const presetName = getPresetName();
    if (hasPreset(projectDir, presetName)) {
        return { projectDir, presetName };
    }
    const action = await vscode.window.showWarningMessage(
        "The SEGGER toolchain is not configured for this project yet.",
        "Setup now",
    );
    if (action === "Setup now") {
        await setupProject();
        return hasPreset(projectDir, presetName) ? { projectDir, presetName } : undefined;
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function setupProject(): Promise<void> {
    const projectDir = getProjectDir();
    if (!projectDir) {
        return;
    }
    const cfg = vscode.workspace.getConfiguration("segger");
    const ses = await resolveSes(true);
    if (!ses) {
        const action = await vscode.window.showErrorMessage(
            "SEGGER Embedded Studio was not found. Install it (8.24 or newer recommended) or set segger.studioPath.",
            "Open download page",
        );
        if (action === "Open download page") {
            void vscode.env.openExternal(vscode.Uri.parse("https://www.segger.com/downloads/embedded-studio/"));
        }
        return;
    }
    activeSes = ses;
    output.appendLine(`Using ${describeSes(ses)}`);
    if (!ses.ccSegger) {
        output.appendLine("bin/cc-segger.exe not found (SES < 8.24?). Falling back to bin/cc.exe.");
    }

    const result = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: "Configuring SEGGER toolchain",
            cancellable: false,
        },
        async (progress) => {
            progress.report({ message: "Preparing CMake integration" });
            const pkg = await ensureToolchainPackage(extensionContext, output);
            progress.report({ message: "Converting project" });
            return convertProject(
                {
                    projectDir,
                    ses,
                    pkg,
                    cpu: cfg.get<string>("cpu", ""),
                    deviceName: cfg.get<string>("deviceName", "STM32F072CB"),
                    stackSize: cfg.get<number>("stackSize", 1024),
                    heapSize: cfg.get<number>("heapSize", 0),
                    presetName: getPresetName(),
                },
                output,
            );
        },
    );

    logConvertResult(result);
    await refreshStatus();

    const summary = [
        `SEGGER toolchain is ready (${result.irqCount} interrupt vectors, ${result.regions.map((r) => `${r.name} ${Math.round(r.length / 1024)}K`).join(", ")}).`,
        ...result.changes.slice(0, 4),
    ].join("\n");
    const action = await vscode.window.showInformationMessage(
        `SEGGER toolchain configured for ${path.basename(projectDir)}.`,
        { modal: false, detail: summary },
        "Build now",
    );
    if (action === "Build now") {
        await buildWith(getPresetName());
    }
}

function logConvertResult(result: ConvertResult): void {
    output.appendLine("");
    output.appendLine("SEGGER toolchain setup");
    for (const change of result.changes) {
        output.appendLine(`  + ${change}`);
    }
    for (const warning of result.warnings) {
        output.appendLine(`  ! ${warning}`);
    }
    output.appendLine("");
}

async function buildWith(presetName: string): Promise<void> {
    const project = await requireConfigured();
    if (!project) {
        return;
    }
    const outcome = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Building with SEGGER (${presetName})`,
            cancellable: true,
        },
        (_progress, token) => buildPreset(project.projectDir, presetName, output, token),
    );
    if (!outcome.ok) {
        void vscode.window.showErrorMessage("Build failed. See the 'SEGGER Toolchain' output for details.");
        output.show(true);
        return;
    }
    lastElf = outcome.elf;
    const size = outcome.elf ? await measureSize(outcome.elf, activeSes?.size) : undefined;
    lastSize = size?.flash;
    await refreshStatus();
    const sizeText = size ? ` · ${formatBytes(size.flash)} flash` : "";
    const action = await vscode.window.showInformationMessage(
        `Build succeeded in ${outcome.seconds.toFixed(1)} s${sizeText}`,
        "Flash",
        "Show output",
    );
    if (action === "Flash") {
        await flashTarget();
    } else if (action === "Show output") {
        output.show(true);
    }
}

async function buildWithGcc(): Promise<void> {
    const projectDir = getProjectDir();
    if (!projectDir) {
        return;
    }
    const presetName = vscode.workspace.getConfiguration("segger").get<string>("gccPreset", "") || findGccPreset(projectDir);
    if (!presetName) {
        void vscode.window.showErrorMessage("No GCC preset found. Set segger.gccPreset or add a GCC preset to CMakePresets.json.");
        return;
    }
    const outcome = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Building GCC baseline (${presetName})`,
            cancellable: true,
        },
        (_progress, token) => buildPreset(projectDir, presetName, output, token),
    );
    if (!outcome.ok) {
        void vscode.window.showErrorMessage("GCC build failed. See output for details.");
        output.show(true);
        return;
    }
    const size = outcome.elf ? await measureSize(outcome.elf) : undefined;
    void vscode.window.showInformationMessage(
        `GCC build succeeded${size ? ` · ${formatBytes(size.flash)} flash` : ""}`,
    );
}

async function compareSizes(): Promise<void> {
    const projectDir = getProjectDir();
    if (!projectDir) {
        return;
    }
    const seggerPreset = getPresetName();
    const gccPreset = vscode.workspace.getConfiguration("segger").get<string>("gccPreset", "") || findGccPreset(projectDir);
    if (!gccPreset) {
        void vscode.window.showErrorMessage(
            "No GCC preset found. Add one to CMakePresets.json to compare against GCC.",
        );
        return;
    }
    if (!hasPreset(projectDir, seggerPreset)) {
        void vscode.window.showErrorMessage("Run 'SEGGER: Setup toolchain for this project' first.");
        return;
    }

    const result = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: "Comparing SEGGER and GCC firmware size",
            cancellable: true,
        },
        async (progress, token) => {
            progress.report({ message: `Building ${seggerPreset}` });
            const seggerBuild = await buildPreset(projectDir, seggerPreset, output, token);
            if (!seggerBuild.ok) {
                return { error: "SEGGER build failed" };
            }
            progress.report({ message: `Building ${gccPreset}` });
            const gccBuild = await buildPreset(projectDir, gccPreset, output, token);
            if (!gccBuild.ok) {
                return { error: "GCC build failed" };
            }
            return {
                segger: seggerBuild.elf ? await measureSize(seggerBuild.elf, activeSes?.size) : undefined,
                gcc: gccBuild.elf ? await measureSize(gccBuild.elf) : undefined,
            };
        },
    );
    if ("error" in result) {
        void vscode.window.showErrorMessage(`${result.error}. See output for details.`);
        return;
    }
    const panel = vscode.window.createWebviewPanel(
        "seggerCompare",
        "SEGGER vs GCC",
        vscode.ViewColumn.Active,
        { enableScripts: false },
    );
    panel.webview.html = renderComparePanel(
        [{ label: path.basename(projectDir), segger: result.segger, gcc: result.gcc }],
        vscode.workspace.getConfiguration("segger").get<string>("cpu", "") || "cortex-m",
    );
    if (result.segger?.flash !== undefined && result.gcc?.flash !== undefined) {
        const delta = ((result.segger.flash - result.gcc.flash) / result.gcc.flash) * 100;
        void vscode.window.showInformationMessage(
            `SEGGER: ${result.segger.flash} B, GCC: ${result.gcc.flash} B (${delta >= 0 ? "+" : ""}${delta.toFixed(1)} %).`,
        );
    }
}

async function cleanBuilds(): Promise<void> {
    const projectDir = getProjectDir();
    if (!projectDir) {
        return;
    }
    const confirmed = await vscode.window.showWarningMessage(
        "Delete the build directories of the SEGGER and GCC presets?",
        { modal: true },
        "Delete",
    );
    if (confirmed !== "Delete") {
        return;
    }
    const targets = new Set<string>();
    const seggerDir = readPresetBinaryDir(projectDir, getPresetName());
    if (seggerDir) {
        targets.add(seggerDir);
    }
    const gccPreset = vscode.workspace.getConfiguration("segger").get<string>("gccPreset", "") || findGccPreset(projectDir);
    const gccDir = gccPreset ? readPresetBinaryDir(projectDir, gccPreset) : undefined;
    if (gccDir) {
        targets.add(gccDir);
    }
    for (const dir of targets) {
        await fs.promises.rm(dir, { recursive: true, force: true });
        output.appendLine(`Removed ${dir}`);
    }
    lastSize = undefined;
    lastElf = undefined;
    await refreshStatus();
    void vscode.window.showInformationMessage(`Removed ${targets.size} build director${targets.size === 1 ? "y" : "ies"}.`);
}

async function flashTarget(): Promise<void> {
    const projectDir = getProjectDir();
    if (!projectDir) {
        return;
    }
    const presetName = getPresetName();
    const elf = lastElf ?? (await findBuiltElf(projectDir, presetName));
    if (!elf) {
        void vscode.window.showErrorMessage("No ELF file found. Build the project first.");
        return;
    }
    const cfg = vscode.workspace.getConfiguration("segger");
    const ok = await flash(
        {
            projectDir,
            elf,
            device: cfg.get<string>("deviceName", "STM32F072CB"),
            interfaceName: cfg.get<string>("flashInterface", "SWD"),
            speedKhz: cfg.get<number>("flashSpeed", 4000),
            jlinkPath: cfg.get<string>("jlinkPath", ""),
        },
        output,
    );
    if (ok) {
        void vscode.window.showInformationMessage(`Flashed ${path.basename(elf)}.`);
    } else {
        void vscode.window.showErrorMessage("Flashing failed. See output for details.");
    }
}

async function selectStudio(): Promise<void> {
    const found = findSesInstallations();
    let install: SesInstall | undefined;
    if (found.length > 0) {
        install = await pickSes(found);
    } else {
        const pick = await vscode.window.showOpenDialog({
            title: "Select the SEGGER Embedded Studio folder (contains bin/cc.exe)",
            canSelectFiles: false,
            canSelectFolders: true,
        });
        if (pick?.[0]) {
            install = findSesInstallations(pick[0].fsPath)[0];
        }
    }
    if (!install) {
        return;
    }
    await vscode.workspace
        .getConfiguration("segger")
        .update("studioPath", install.root, vscode.ConfigurationTarget.Global);
    activeSes = install;
    output.appendLine(`Selected ${describeSes(install)}`);
    await refreshStatus();
    void vscode.window.showInformationMessage(`Using ${describeSes(install)}`);
}

async function updatePackage(): Promise<void> {
    const pkg = await ensureToolchainPackage(extensionContext, output, true);
    void vscode.window.showInformationMessage(`SEGGER CMake package updated: ${pkg.root}`);
}

async function showInfo(): Promise<void> {
    const projectDir = getProjectDir();
    const cfg = vscode.workspace.getConfiguration("segger");
    const installs = findSesInstallations(cfg.get<string>("studioPath", "") || undefined);
    const lines = [
        "SEGGER Toolchain",
        `Project: ${projectDir ?? "-"}`,
        `Preset: ${getPresetName()}`,
        `SEGGER Embedded Studio: ${installs.length ? describeSes(installs[0]) : "not found"}`,
        `Compiler: ${installs[0]?.cc ?? "-"}`,
        `cc-segger: ${installs[0]?.ccSegger ?? "-"}`,
        `Binutils: ${installs[0]?.binutilsDir ?? "-"}`,
        `GCC preset: ${(projectDir && findGccPreset(projectDir)) || cfg.get<string>("gccPreset", "") || "-"}`,
        `Last ELF: ${lastElf ?? "-"}`,
        `Last flash size: ${lastSize !== undefined ? lastSize + " B" : "-"}`,
    ];
    output.appendLine("");
    lines.forEach((l) => output.appendLine(l));
    output.show(true);
    void vscode.window.showInformationMessage(lines.slice(0, 4).join(" · "));
}
