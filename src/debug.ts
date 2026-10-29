import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { findJLink } from "./flash";
import { isFile, readJsoncFile, which } from "./util";

export interface DebugConfigInput {
    projectDir: string;
    elf: string;
    device: string;
    interfaceName: string;
    gdbPath?: string;
    jlinkPath?: string;
}

interface LaunchFile {
    version?: string;
    configurations?: Array<Record<string, unknown>>;
    [key: string]: unknown;
}

const CONFIG_NAME = "SEGGER: J-Link";

/** Locate a GDB usable by cortex-debug. */
export function findGdb(explicit?: string, sesRoot?: string): string | undefined {
    if (explicit && isFile(explicit)) {
        return explicit;
    }
    const fromPath = which("arm-none-eabi-gdb") ?? which("gdb");
    if (fromPath) {
        return fromPath;
    }
    if (sesRoot) {
        for (const rel of ["bin/gdb.exe", "gcc/arm-segger/bin/gdb.exe", "gcc/arm-segger/bin/arm-segger-gdb.exe"]) {
            const candidate = path.join(sesRoot, rel);
            if (isFile(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
}

/** Find JLinkGDBServerCL.exe, usually next to JLink.exe. */
export function findJLinkGdbServer(jlinkPath?: string): string | undefined {
    const jlink = findJLink(jlinkPath);
    if (!jlink) {
        return undefined;
    }
    const candidate = path.join(path.dirname(jlink), "JLinkGDBServerCL.exe");
    return isFile(candidate) ? candidate : undefined;
}

function workspaceRelative(projectDir: string, file: string): string {
    const rel = path.relative(projectDir, file);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
        return "${workspaceFolder}/" + rel.replace(/\\/g, "/");
    }
    return file.replace(/\\/g, "/");
}

/** Create or update the cortex-debug launch configuration for J-Link. */
export async function writeDebugConfig(input: DebugConfigInput): Promise<string> {
    const dir = path.join(input.projectDir, ".vscode");
    const file = path.join(dir, "launch.json");
    const data: LaunchFile = readJsoncFile<LaunchFile>(file) ?? { version: "0.2.0", configurations: [] };
    data.version ??= "0.2.0";
    data.configurations = (data.configurations ?? []).filter((c) => c.name !== CONFIG_NAME);

    const serverPath = findJLinkGdbServer(input.jlinkPath);
    const executable = isFile(input.elf)
        ? workspaceRelative(input.projectDir, input.elf)
        : "${command:cmake.launchTargetPath}";

    const config: Record<string, unknown> = {
        name: CONFIG_NAME,
        type: "cortex-debug",
        request: "launch",
        cwd: "${workspaceFolder}",
        executable,
        servertype: "jlink",
        serverpath: serverPath ?? "C:/Program Files/SEGGER/JLink/JLinkGDBServerCL.exe",
        device: input.device,
        interface: input.interfaceName.toLowerCase(),
        runToEntryPoint: "main",
    };
    if (input.gdbPath) {
        config.gdbPath = input.gdbPath;
    }
    data.configurations.push(config);

    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify(data, null, 4) + "\n", "utf8");

    // Recommend cortex-debug for this workspace.
    const extFile = path.join(dir, "extensions.json");
    const ext = readJsoncFile<{ recommendations?: string[] }>(extFile) ?? {};
    ext.recommendations ??= [];
    if (!ext.recommendations.includes("marus25.cortex-debug")) {
        ext.recommendations.push("marus25.cortex-debug");
    }
    await fs.promises.writeFile(extFile, JSON.stringify(ext, null, 4) + "\n", "utf8");

    return file;
}

export async function openDebugConfig(file: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc);
}
