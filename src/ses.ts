import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { firstExisting, isDir, isFile, run, walk } from "./util";

export interface SesInstall {
    /** Root of the SEGGER Embedded Studio installation (the folder that contains bin/). */
    root: string;
    /** Version string as found in the folder name, e.g. "8.24". */
    version: string;
    /** bin/cc.exe - the compiler driver in GNU compatible mode. */
    cc: string;
    /** bin/cc++.exe */
    ccxx?: string;
    /** bin/cc-segger.exe - present since SES 8.24 and used by the official CMake package. */
    ccSegger?: string;
    /** Path to one binutils directory below gcc/, e.g. gcc/arm-segger/bin. */
    binutilsDir?: string;
    objcopy?: string;
    size?: string;
    /** CPU family folder name, e.g. "arm-segger". */
    arch?: string;
}

const STANDARD_DIRS = [
    "C:\\Program Files\\SEGGER",
    "C:\\Program Files (x86)\\SEGGER",
    "C:\\SEGGER",
    path.join(os.homedir(), "AppData", "Local", "SEGGER"),
    path.join(os.homedir(), "AppData", "Local", "Programs", "SEGGER"),
    "/opt/SEGGER",
    "/Applications/SEGGER",
];

function versionOf(folderName: string): string {
    const m = /(\d+\.\d+[a-z]?)/i.exec(folderName);
    return m ? m[1] : "unknown";
}

function inspect(root: string): SesInstall | undefined {
    const bin = path.join(root, "bin");
    const cc = path.join(bin, "cc.exe");
    const ccUnix = path.join(bin, "cc");
    const ccSegger = firstExisting([path.join(bin, "cc-segger.exe"), path.join(bin, "cc-segger")]);
    if (!isFile(cc) && !isFile(ccUnix) && !ccSegger) {
        return undefined;
    }

    let binutilsDir: string | undefined;
    let arch: string | undefined;
    const gccRoot = path.join(root, "gcc");
    if (isDir(gccRoot)) {
        let entries: string[] = [];
        try {
            entries = fs.readdirSync(gccRoot);
        } catch {
            /* ignore */
        }
        // Prefer the SEGGER compiler's own binutils, then any ARM binutils.
        const ordered = entries
            .filter((e) => isDir(path.join(gccRoot, e)))
            .sort((a, b) => score(b) - score(a));
        for (const entry of ordered) {
            const binDir = path.join(gccRoot, entry, "bin");
            const ar = firstExisting([path.join(binDir, "ar.exe"), path.join(binDir, "ar")]);
            if (ar) {
                binutilsDir = binDir;
                arch = entry;
                break;
            }
        }
    }

    return {
        root,
        version: versionOf(path.basename(root)),
        cc: isFile(cc) ? cc : isFile(ccUnix) ? ccUnix : ccSegger!,
        ccxx: firstExisting([path.join(bin, "cc++.exe"), path.join(bin, "cc++")]),
        ccSegger,
        binutilsDir,
        objcopy: binutilsDir ? firstExisting([path.join(binutilsDir, "objcopy.exe"), path.join(binutilsDir, "objcopy")]) : undefined,
        size: binutilsDir ? firstExisting([path.join(binutilsDir, "size.exe"), path.join(binutilsDir, "size")]) : undefined,
        arch,
    };
}

function score(folder: string): number {
    let s = 0;
    if (folder.includes("arm")) {
        s += 10;
    }
    if (folder.includes("segger")) {
        s += 5;
    }
    if (folder === "arm-segger") {
        s += 10;
    }
    return s;
}

function collectFrom(parent: string, depth: number, found: SesInstall[]): void {
    if (depth < 0) {
        return;
    }
    const direct = inspect(parent);
    if (direct) {
        found.push(direct);
    }
    let entries: fs.Dirent[] = [];
    try {
        entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const child = path.join(parent, entry.name);
        const childInspect = inspect(child);
        if (childInspect) {
            found.push(childInspect);
        } else if (depth > 0) {
            collectFrom(child, depth - 1, found);
        }
    }
}

/** Find every SEGGER Embedded Studio installation that can act as a SEGGER toolchain. */
export function findSesInstallations(explicitPath?: string): SesInstall[] {
    const found = new Map<string, SesInstall>();

    const add = (p: string | undefined) => {
        if (!p) {
            return;
        }
        const cleaned = p.replace(/^"|"$/g, "").trim();
        const direct = inspect(cleaned);
        if (direct) {
            found.set(direct.root.toLowerCase(), direct);
        } else if (isDir(cleaned)) {
            const sub: SesInstall[] = [];
            collectFrom(cleaned, 1, sub);
            sub.forEach((s) => found.set(s.root.toLowerCase(), s));
        }
    };

    add(explicitPath);
    add(process.env.SEGGER_STUDIO_PATH);
    add(process.env.SEGGER_EMBEDDED_STUDIO);

    for (const dir of STANDARD_DIRS) {
        add(dir);
    }

    // Last resort: look for cc-segger.exe below the standard SEGGER folders only.
    for (const dir of STANDARD_DIRS) {
        if (!isDir(dir)) {
            continue;
        }
        try {
            for (const f of walk(dir, (file) => /[\\/]bin[\\/]cc(-segger)?\.exe$/i.test(file), 4)) {
                add(path.dirname(path.dirname(f)));
            }
        } catch {
            /* ignore */
        }
    }

    return [...found.values()].sort((a, b) => compareVersions(b.version, a.version));
}

function compareVersions(a: string, b: string): number {
    const pa = a.split(/[.\s]/).map((x) => parseInt(x, 10) || 0);
    const pb = b.split(/[.\s]/).map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d) {
            return d;
        }
    }
    return 0;
}

/** Ask the user to pick an installation when several are present. */
export async function pickSes(installs: SesInstall[]): Promise<SesInstall | undefined> {
    if (installs.length === 0) {
        return undefined;
    }
    if (installs.length === 1) {
        return installs[0];
    }
    const picked = await vscode.window.showQuickPick(
        installs.map((i) => ({
            label: `SEGGER Embedded Studio ${i.version}`,
            description: i.root,
            install: i,
        })),
        { title: "Select SEGGER Embedded Studio installation" },
    );
    return picked?.install;
}

/** Resolve the installation from settings, prompting if needed. */
export async function resolveSes(interactive: boolean): Promise<SesInstall | undefined> {
    const cfg = vscode.workspace.getConfiguration("segger");
    const explicit = cfg.get<string>("studioPath", "").trim();
    const found = findSesInstallations(explicit || undefined);
    if (found.length === 0) {
        if (interactive) {
            const pick = await vscode.window.showOpenDialog({
                title: "Select the SEGGER Embedded Studio installation folder (contains bin/cc.exe)",
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
            });
            if (pick?.[0]) {
                const install = inspect(pick[0].fsPath) ?? findSesInstallations(pick[0].fsPath)[0];
                if (install) {
                    await cfg.update("studioPath", install.root, vscode.ConfigurationTarget.Global);
                    return install;
                }
                void vscode.window.showErrorMessage(`No bin/cc.exe found in ${pick[0].fsPath}`);
            }
        }
        return undefined;
    }
    return pickSes(found);
}

export function describeSes(s: SesInstall): string {
    return `SES ${s.version} (${s.root})`;
}

export interface LicenseStatus {
    /** false only when emLicense is present and reports no installed license. */
    ok: boolean;
    detail: string;
}

/** Check whether a command-line license is installed via emLicense. */
export async function checkLicense(s: SesInstall): Promise<LicenseStatus> {
    const tool = firstExisting([
        path.join(s.root, "bin", "emLicense.exe"),
        path.join(s.root, "bin", "emLicense"),
    ]);
    if (!tool) {
        return { ok: true, detail: "emLicense not found, skipping license check" };
    }
    const result = await run(tool, ["list"]);
    const text = (result.stdout + result.stderr).trim();
    if (result.code !== 0) {
        return { ok: true, detail: `emLicense exited with ${result.code}` };
    }
    return text.length > 0
        ? { ok: true, detail: text.split(/\r?\n/)[0] }
        : { ok: false, detail: "No license installed: the command-line compiler will fail with 'no active license found'." };
}
