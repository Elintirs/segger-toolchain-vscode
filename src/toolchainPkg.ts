import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import * as vscode from "vscode";
import { copyFileEnsured, isDir, isFile, readJsoncFile, writeFileEnsured } from "./util";

/**
 * Pinned commit of github.com/SEGGERMicro/segger-toolchain-cmake so that the
 * extension behaves reproducibly. Bump this when you want to update.
 */
export const PKG_REF = "70f3a43b032b5c14f07d5771d388875ed0743384";
const PKG_REF_FALLBACK = "main";
const RAW_BASE = "https://raw.githubusercontent.com/SEGGERMicro/segger-toolchain-cmake";

const COMPILER_MODULES = [
    "SEGGERClang.cmake",
    "SEGGERClang-C.cmake",
    "SEGGERClang-CXX.cmake",
    "SEGGERClang-ASM.cmake",
    "SEGGERClang-FindBinUtils.cmake",
];

const TEMPLATE_DIR = "Samples/MltCfgApp/bsp/cortex-m4-m7";

const FILES: Array<{ remote: string; local: string }> = [
    { remote: "segger-toolchain.cmake", local: "segger-toolchain.cmake" },
    ...COMPILER_MODULES.map((name) => ({
        remote: `segger_cmake_modules/Compiler/${name}`,
        local: `segger_cmake_modules/Compiler/${name}`,
    })),
    {
        remote: `${TEMPLATE_DIR}/System/Cortex_M_Startup.s`,
        local: "templates/Cortex_M_Startup.s",
    },
    {
        remote: `${TEMPLATE_DIR}/System/SEGGER_THUMB_Startup.s`,
        local: "templates/SEGGER_THUMB_Startup.s",
    },
    {
        remote: `${TEMPLATE_DIR}/Setup/SEGGER_Flash.icf`,
        local: "templates/SEGGER_Flash.icf",
    },
];

export interface ToolchainPackage {
    root: string;
    toolchainFile: string;
    modulesDir: string;
    startupTemplate: string;
    thumbStartupTemplate: string;
    icfTemplate: string;
}

function resolvePackage(root: string): ToolchainPackage | undefined {
    const toolchainFile = path.join(root, "segger-toolchain.cmake");
    const modulesDir = path.join(root, "segger_cmake_modules");
    if (!isFile(toolchainFile) || !isDir(modulesDir)) {
        return undefined;
    }
    const templateRoots = [
        path.join(root, "templates"),
        path.join(root, TEMPLATE_DIR.replace(/\//g, path.sep)),
        path.join(root, "Samples", "MltCfgApp", "bsp", "cortex-m4-m7"),
    ];
    let startupTemplate = "";
    let thumbStartupTemplate = "";
    let icfTemplate = "";
    for (const dir of templateRoots) {
        const a = path.join(dir, "Cortex_M_Startup.s");
        const b = path.join(dir, "SEGGER_THUMB_Startup.s");
        const c = path.join(dir, "SEGGER_Flash.icf");
        if (isFile(a) && isFile(b) && isFile(c)) {
            startupTemplate = a;
            thumbStartupTemplate = b;
            icfTemplate = c;
            break;
        }
    }
    if (!startupTemplate) {
        const sysDir = path.join(root, "Samples", "MltCfgApp", "bsp", "cortex-m4-m7", "System");
        if (isFile(path.join(sysDir, "Cortex_M_Startup.s"))) {
            startupTemplate = path.join(sysDir, "Cortex_M_Startup.s");
            thumbStartupTemplate = path.join(sysDir, "SEGGER_THUMB_Startup.s");
            icfTemplate = path.join(root, "Samples", "MltCfgApp", "bsp", "cortex-m4-m7", "Setup", "SEGGER_Flash.icf");
        }
    }
    if (!startupTemplate || !isFile(startupTemplate)) {
        return undefined;
    }
    return { root, toolchainFile, modulesDir, startupTemplate, thumbStartupTemplate, icfTemplate };
}

function cacheRoot(context: vscode.ExtensionContext, ref: string): string {
    return path.join(context.globalStorageUri.fsPath, "segger-cmake", ref);
}

function httpGet(url: string, redirects = 6): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        if (redirects < 0) {
            reject(new Error("Too many redirects"));
            return;
        }
        const req = https.get(
            url,
            {
                headers: { "User-Agent": "vscode-segger-toolchain", Accept: "*/*" },
                timeout: 30_000,
            },
            (res) => {
                const status = res.statusCode ?? 0;
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    resolve(httpGet(new URL(res.headers.location, url).toString(), redirects - 1));
                    return;
                }
                if (status !== 200) {
                    res.resume();
                    reject(new Error(`HTTP ${status} for ${url}`));
                    return;
                }
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("end", () => resolve(Buffer.concat(chunks)));
                res.on("error", reject);
            },
        );
        req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
        req.on("error", reject);
    });
}

async function downloadInto(
    context: vscode.ExtensionContext,
    ref: string,
    files: Array<{ remote: string; local: string }>,
    output: vscode.OutputChannel,
): Promise<string> {
    const root = cacheRoot(context, ref);
    const marker = path.join(root, ".complete.json");
    const existing = readJsoncFile<{ ref: string; files: string[] }>(marker);
    if (existing?.ref === ref && files.every((f) => isFile(path.join(root, f.local)))) {
        return root;
    }
    await fs.promises.mkdir(root, { recursive: true });
    for (const file of files) {
        const target = path.join(root, file.local);
        if (isFile(target)) {
            continue;
        }
        const url = `${RAW_BASE}/${ref}/${file.remote}`;
        output.appendLine(`Downloading ${url}`);
        const data = await httpGet(url);
        await writeFileEnsured(target, data.toString("utf8"));
    }
    await writeFileEnsured(marker, JSON.stringify({ ref, files: files.map((f) => f.local), downloadedAt: new Date().toISOString() }, null, 2));
    return root;
}

/** Make sure the official SEGGER CMake integration is available locally. */
export async function ensureToolchainPackage(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    force = false,
): Promise<ToolchainPackage> {
    const cfg = vscode.workspace.getConfiguration("segger");
    const localPath = cfg.get<string>("cmakePackagePath", "").trim();
    if (localPath) {
        const local = resolvePackage(localPath);
        if (local) {
            output.appendLine(`Using local SEGGER CMake package: ${local.root}`);
            return local;
        }
        void vscode.window.showWarningMessage(
            `segger.cmakePackagePath does not look like a segger-toolchain-cmake checkout: ${localPath}`,
        );
    }

    const pinned = resolvePackage(cacheRoot(context, PKG_REF));
    if (pinned && !force) {
        return pinned;
    }

    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: "Downloading SEGGER CMake integration",
            cancellable: false,
        },
        async (progress) => {
            progress.report({ message: "github.com/SEGGERMicro/segger-toolchain-cmake" });
            try {
                await downloadInto(context, PKG_REF, FILES, output);
            } catch (err) {
                output.appendLine(`Pinned download failed: ${String(err)}. Falling back to 'main'.`);
                if (force) {
                    await fs.promises.rm(cacheRoot(context, PKG_REF), { recursive: true, force: true });
                }
                await downloadInto(context, PKG_REF_FALLBACK, FILES, output);
                const pkg = resolvePackage(cacheRoot(context, PKG_REF_FALLBACK));
                if (!pkg) {
                    throw new Error("Downloaded files are incomplete");
                }
                return pkg;
            }
            const pkg = resolvePackage(cacheRoot(context, PKG_REF));
            if (!pkg) {
                throw new Error("Downloaded files are incomplete");
            }
            return pkg;
        },
    );
}

/** Copy the toolchain file and compiler modules into the project so it stays portable. */
export async function vendorPackageIntoProject(pkg: ToolchainPackage, projectDir: string): Promise<{ toolchainFile: string; destDir: string }> {
    const destDir = path.join(projectDir, "cmake", "segger");
    await copyFileEnsured(pkg.toolchainFile, path.join(destDir, "segger-toolchain.cmake"));
    for (const name of COMPILER_MODULES) {
        await copyFileEnsured(
            path.join(pkg.modulesDir, "Compiler", name),
            path.join(destDir, "segger_cmake_modules", "Compiler", name),
        );
    }
    return { toolchainFile: path.join(destDir, "segger-toolchain.cmake"), destDir };
}
