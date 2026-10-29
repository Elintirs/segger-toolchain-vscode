import * as fs from "fs";
import * as path from "path";
import { readJsoncFile, writeFileEnsured } from "./util";

export interface PresetInput {
    projectDir: string;
    toolchainFile: string;
    pkgRoot: string;
    sysProc: string; // e.g. arm-cortex-m0
    objcopy?: string;
    sizeTool?: string;
    stackSize: number;
    heapSize: number;
    presetName: string;
    deviceName: string;
}

export interface PresetPaths {
    userPresetsFile: string;
    configurePreset: string;
    buildPreset: string;
}

interface AnyPreset {
    name?: string;
    [key: string]: unknown;
}

interface PresetsFile {
    version?: number;
    configurePresets?: AnyPreset[];
    buildPresets?: AnyPreset[];
    [key: string]: unknown;
}

export function fwd(p: string): string {
    return p.replace(/\\/g, "/");
}

export function userPresetsPath(projectDir: string): string {
    return path.join(projectDir, "CMakeUserPresets.json");
}

export function projectPresetsPath(projectDir: string): string {
    return path.join(projectDir, "CMakePresets.json");
}

export function writeUserPresets(input: PresetInput): PresetPaths {
    const file = userPresetsPath(input.projectDir);
    const existing = readJsoncFile<PresetsFile>(file) ?? {};
    const parent = readJsoncFile<PresetsFile>(projectPresetsPath(input.projectDir));
    const version = Math.max(3, existing.version ?? 0, parent?.version ?? 0);

    const isOurs = (p: AnyPreset) => typeof p.name === "string" && p.name.startsWith("segger-");
    const configurePresets = (existing.configurePresets ?? []).filter((p) => !isOurs(p));
    const buildPresets = (existing.buildPresets ?? []).filter((p) => !isOurs(p));

    const cacheVariables: Record<string, unknown> = {
        CMAKE_BUILD_TYPE: "Debug",
        CMAKE_SYSTEM_PROCESSOR: input.sysProc,
        SEGGER_TOOLCHAIN_PKG_ROOT: fwd(input.pkgRoot),
        CMAKE_EXPORT_COMPILE_COMMANDS: true,
    };
    if (input.objcopy) {
        cacheVariables.ARM_OBJCOPY = fwd(input.objcopy);
    }
    if (input.sizeTool) {
        cacheVariables.ARM_SIZE = fwd(input.sizeTool);
    }

    configurePresets.push({
        name: input.presetName,
        displayName: `SEGGER ${input.deviceName} (${input.sysProc.replace(/^arm-/, "")})`,
        description: "SEGGER compiler from SEGGER Embedded Studio, configured through the official SEGGER CMake integration",
        generator: "Ninja",
        binaryDir: `${"${sourceDir}"}/build/${input.presetName}`,
        toolchainFile: fwd(input.toolchainFile),
        cacheVariables,
    });

    buildPresets.push({
        name: input.presetName,
        configurePreset: input.presetName,
        description: "Build with the SEGGER compiler",
    });

    const result: PresetsFile = {
        ...existing,
        version,
        configurePresets,
        buildPresets,
    };
    fs.mkdirSync(input.projectDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(result, null, 4) + "\n", "utf8");
    return {
        userPresetsFile: file,
        configurePreset: input.presetName,
        buildPreset: input.presetName,
    };
}

/** Try to find an existing GCC preset to use as a size baseline. */
export function findGccPreset(projectDir: string): string | undefined {
    const files = [projectPresetsPath(projectDir), userPresetsPath(projectDir)];
    const candidates: string[] = [];
    for (const file of files) {
        const data = readJsoncFile<PresetsFile>(file);
        for (const preset of data?.configurePresets ?? []) {
            if (!preset.name || preset.name.startsWith("segger-")) {
                continue;
            }
            const vars = (preset.cacheVariables ?? {}) as Record<string, unknown>;
            const toolchain = String(vars.CMAKE_TOOLCHAIN_FILE ?? preset.toolchainFile ?? "");
            if (/gcc|arm-none-eabi/i.test(toolchain) || /gcc/i.test(preset.name)) {
                candidates.push(preset.name);
            }
        }
    }
    return candidates[0];
}

/** Create/merge .vscode/settings.json so CMake Tools picks up the presets. */
export async function writeWorkspaceSettings(projectDir: string, presetName: string): Promise<void> {
    const file = path.join(projectDir, ".vscode", "settings.json");
    let current: Record<string, unknown> = {};
    try {
        const raw = fs.readFileSync(file, "utf8");
        current = JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1"));
    } catch {
        current = {};
    }
    current["cmake.useCMakePresets"] = "always";
    current["cmake.configurePreset"] = presetName;
    current["cmake.buildPreset"] = presetName;
    current["cmake.configureOnOpen"] = false;
    current["C_Cpp.default.configurationProvider"] = "ms-vscode.cmake-tools";
    await writeFileEnsured(file, JSON.stringify(current, null, 4) + "\n");
}

/** Resolve ${sourceDir} and other variable references used in binaryDir. */
export function expandPresetPath(value: string, projectDir: string): string {
    return fwd(value)
        .replace(/\$\{sourceDir\}/g, fwd(projectDir))
        .replace(/\$\{workspaceFolder\}/g, fwd(projectDir));
}

export function readPresetBinaryDir(projectDir: string, presetName: string): string | undefined {
    for (const file of [projectPresetsPath(projectDir), userPresetsPath(projectDir)]) {
        const data = readJsoncFile<PresetsFile>(file);
        const preset = data?.configurePresets?.find((p) => p.name === presetName);
        if (preset && typeof preset.binaryDir === "string") {
            return path.normalize(expandPresetPath(preset.binaryDir, projectDir));
        }
    }
    return undefined;
}
