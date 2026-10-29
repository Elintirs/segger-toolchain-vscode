import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** Run a program and capture its output. Never throws on non-zero exit. */
export function run(command: string, args: string[], cwd?: string): Promise<RunResult> {
    return new Promise((resolve) => {
        const child = cp.spawn(command, args, {
            cwd,
            windowsHide: true,
            shell: false,
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (d) => (stdout += d.toString()));
        child.stderr?.on("data", (d) => (stderr += d.toString()));
        child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
        child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
}

/** Run a program, streaming stdout/stderr into an output channel. */
export function runStreaming(
    command: string,
    args: string[],
    cwd: string,
    output: vscode.OutputChannel,
    token?: vscode.CancellationToken,
): Promise<number> {
    return new Promise((resolve) => {
        output.appendLine(`> ${quoteIfNeeded(command)} ${args.map(quoteIfNeeded).join(" ")}`);
        const child = cp.spawn(command, args, { cwd, windowsHide: true, shell: false });
        const pipe = (data: Buffer) => {
            for (const line of data.toString().split(/\r?\n/)) {
                if (line.length) {
                    output.appendLine(line);
                }
            }
        };
        child.stdout?.on("data", pipe);
        child.stderr?.on("data", pipe);
        child.on("error", (err) => {
            output.appendLine(`ERROR: ${String(err)}`);
            resolve(-1);
        });
        child.on("close", (code) => resolve(code ?? -1));
        token?.onCancellationRequested(() => child.kill());
    });
}

function quoteIfNeeded(s: string): string {
    return /\s/.test(s) ? `"${s}"` : s;
}

let cachedWhere: Map<string, string | undefined> | undefined;

/** Locate an executable in PATH (and common Windows locations). */
export function which(name: string): string | undefined {
    cachedWhere ??= new Map();
    if (cachedWhere.has(name)) {
        return cachedWhere.get(name);
    }
    const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
    const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        for (const ext of exts) {
            const candidate = path.join(dir, name + ext.toLowerCase());
            if (fs.existsSync(candidate)) {
                cachedWhere.set(name, candidate);
                return candidate;
            }
            const candidateUpper = path.join(dir, name + ext.toUpperCase());
            if (fs.existsSync(candidateUpper)) {
                cachedWhere.set(name, candidateUpper);
                return candidateUpper;
            }
        }
    }
    cachedWhere.set(name, undefined);
    return undefined;
}

/** Find cmake, preferring PATH and then the standard Windows install location. */
export function findCmake(): string | undefined {
    return (
        which("cmake") ??
        firstExisting([
            "C:\\Program Files\\CMake\\bin\\cmake.exe",
            "C:\\Program Files (x86)\\CMake\\bin\\cmake.exe",
            path.join(os.homedir(), "AppData", "Local", "Programs", "CMake", "bin", "cmake.exe"),
        ])
    );
}

export function findNinja(): string | undefined {
    return (
        which("ninja") ??
        firstExisting([
            "C:\\Program Files\\CMake\\bin\\ninja.exe",
            path.join(os.homedir(), "AppData", "Local", "Programs", "CMake", "bin", "ninja.exe"),
        ])
    );
}

export function firstExisting(paths: string[]): string | undefined {
    for (const p of paths) {
        try {
            if (fs.existsSync(p)) {
                return p;
            }
        } catch {
            /* ignore */
        }
    }
    return undefined;
}

export function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

export function isDir(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/** Remove // and block comments plus trailing commas so that JSONC can be parsed. */
export function stripJsonComments(text: string): string {
    let result = "";
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1];

        if (inLineComment) {
            if (c === "\n") {
                inLineComment = false;
                result += c;
            }
            continue;
        }
        if (inBlockComment) {
            if (c === "*" && next === "/") {
                inBlockComment = false;
                i++;
            }
            continue;
        }
        if (inString) {
            result += c;
            if (escaped) {
                escaped = false;
            } else if (c === "\\") {
                escaped = true;
            } else if (c === '"') {
                inString = false;
            }
            continue;
        }
        if (c === '"') {
            inString = true;
            result += c;
            continue;
        }
        if (c === "/" && next === "/") {
            inLineComment = true;
            i++;
            continue;
        }
        if (c === "/" && next === "*") {
            inBlockComment = true;
            i++;
            continue;
        }
        result += c;
    }
    // Drop trailing commas before } or ]
    return result.replace(/,(\s*[}\]])/g, "$1");
}

export function readJsoncFile<T>(file: string): T | undefined {
    try {
        const raw = fs.readFileSync(file, "utf8");
        return JSON.parse(stripJsonComments(raw)) as T;
    } catch {
        return undefined;
    }
}

export async function writeFileEnsured(file: string, content: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, content, "utf8");
}

export async function copyFileEnsured(src: string, dest: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);
}

export function workspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
}

export function relativeToWorkspace(p: string): string {
    const folder = workspaceFolder();
    return folder ? path.relative(folder.uri.fsPath, p) || "." : p;
}

/** Recursively find files by predicate, with a depth limit. */
export function walk(dir: string, predicate: (file: string) => boolean, maxDepth = 6): string[] {
    const out: string[] = [];
    const visit = (current: string, depth: number) => {
        if (depth > maxDepth) {
            return;
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === "node_modules" || entry.name === ".git") {
                    continue;
                }
                visit(full, depth + 1);
            } else if (predicate(full)) {
                out.push(full);
            }
        }
    };
    visit(dir, 0);
    return out;
}

export function newestFile(files: string[]): string | undefined {
    let best: string | undefined;
    let bestTime = -1;
    for (const f of files) {
        try {
            const t = fs.statSync(f).mtimeMs;
            if (t > bestTime) {
                bestTime = t;
                best = f;
            }
        } catch {
            /* ignore */
        }
    }
    return best;
}
