import * as path from "path";
import * as vscode from "vscode";
import { readPresetBinaryDir } from "./presets";
import { findCmake, findNinja, newestFile, run, runStreaming, walk } from "./util";

export interface BuildOutcome {
    ok: boolean;
    elf?: string;
    seconds: number;
}

export async function buildPreset(
    projectDir: string,
    presetName: string,
    output: vscode.OutputChannel,
    token?: vscode.CancellationToken,
): Promise<BuildOutcome> {
    const started = Date.now();
    const cmake = findCmake();
    if (!cmake) {
        throw new Error("CMake was not found. Install CMake and make sure 'cmake' is in PATH.");
    }
    if (!findNinja()) {
        output.appendLine("WARNING: ninja was not found in PATH. CMake will fail unless the preset uses another generator.");
    }
    if (!readPresetBinaryDir(projectDir, presetName)) {
        throw new Error(`Configure preset "${presetName}" not found in CMakePresets.json / CMakeUserPresets.json`);
    }

    const configureCode = await runStreaming(cmake, ["--preset", presetName], projectDir, output, token);
    if (configureCode !== 0) {
        return { ok: false, seconds: (Date.now() - started) / 1000 };
    }
    const buildCode = await runStreaming(cmake, ["--build", "--preset", presetName], projectDir, output, token);
    if (buildCode !== 0) {
        return { ok: false, seconds: (Date.now() - started) / 1000 };
    }

    const binaryDir = readPresetBinaryDir(projectDir, presetName) ?? path.join(projectDir, "build");
    const elf = newestFile(walk(binaryDir, (f) => f.toLowerCase().endsWith(".elf"), 8));
    return { ok: true, elf, seconds: (Date.now() - started) / 1000 };
}

export async function findBuiltElf(projectDir: string, presetName: string): Promise<string | undefined> {
    const binaryDir = readPresetBinaryDir(projectDir, presetName) ?? path.join(projectDir, "build");
    return newestFile(walk(binaryDir, (f) => f.toLowerCase().endsWith(".elf"), 8));
}

export async function cmakeVersion(): Promise<string | undefined> {
    const cmake = findCmake();
    if (!cmake) {
        return undefined;
    }
    const r = await run(cmake, ["--version"]);
    return r.code === 0 ? r.stdout.split(/\r?\n/)[0] : undefined;
}
