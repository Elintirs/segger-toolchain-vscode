import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { firstExisting, isDir, isFile, runStreaming } from "./util";

export function findJLink(explicit?: string): string | undefined {
    if (explicit && isFile(explicit)) {
        return explicit;
    }
    const direct = firstExisting([
        "C:\\Program Files\\SEGGER\\JLink\\JLink.exe",
        "C:\\Program Files (x86)\\SEGGER\\JLink\\JLink.exe",
        path.join(os.homedir(), "AppData", "Local", "SEGGER", "JLink", "JLink.exe"),
    ]);
    if (direct) {
        return direct;
    }
    for (const base of ["C:\\Program Files\\SEGGER", "C:\\Program Files (x86)\\SEGGER"]) {
        if (!isDir(base)) {
            continue;
        }
        for (const entry of fs.readdirSync(base)) {
            const candidate = path.join(base, entry, "JLink.exe");
            if (isFile(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
}

export interface FlashOptions {
    projectDir: string;
    elf: string;
    device: string;
    interfaceName: string;
    speedKhz: number;
    jlinkPath?: string;
}

export async function flash(options: FlashOptions, output: vscode.OutputChannel): Promise<boolean> {
    const jlink = findJLink(options.jlinkPath);
    if (!jlink) {
        throw new Error(
            "JLink.exe was not found. Install the J-Link Software and Documentation Pack or set segger.jlinkPath.",
        );
    }
    const scriptPath = path.join(options.projectDir, ".segger", "flash.jlink");
    await fs.promises.mkdir(path.dirname(scriptPath), { recursive: true });
    const script = [
        "r",
        "h",
        `loadfile "${options.elf.replace(/\\/g, "/")}"`,
        "g",
        "qc",
        "",
    ].join("\n");
    await fs.promises.writeFile(scriptPath, script, "utf8");

    const args = [
        "-device",
        options.device,
        "-if",
        options.interfaceName,
        "-speed",
        String(options.speedKhz),
        "-autoconnect",
        "1",
        "-NoGui",
        "1",
        "-ExitOnError",
        "1",
        "-CommanderScript",
        scriptPath,
    ];
    output.appendLine(`Flashing ${options.elf} via ${jlink} (${options.device})`);
    const code = await runStreaming(jlink, args, options.projectDir, output);
    return code === 0;
}
