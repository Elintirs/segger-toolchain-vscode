import * as fs from "fs";
import * as path from "path";
import {
    detectCpuFlags,
    detectDeviceName,
    MemoryRegion,
    parseMemoryRegions,
} from "./devices";
import { readJsoncFile } from "./util";

export interface ProjectInfo {
    cpu: string;
    device?: string;
    sources: string[];
    includes: string[];
    defines: string[];
    linkerScript: string;
    regions: MemoryRegion[];
}

function cacheVars(projectDir: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const file of [path.join(projectDir, "CMakePresets.json"), path.join(projectDir, "CMakeUserPresets.json")]) {
        const data = readJsoncFile<{
            configurePresets?: Array<{ cacheVariables?: Record<string, unknown> }>;
        }>(file);
        for (const preset of data?.configurePresets ?? []) {
            for (const [key, value] of Object.entries(preset.cacheVariables ?? {})) {
                if (typeof value === "string" && !out[key]) {
                    out[key] = value
                        .replace(/\$\{sourceDir\}/g, projectDir)
                        .replace(/\$\{CMAKE_SOURCE_DIR\}/g, projectDir)
                        .replace(/\//g, path.sep);
                }
            }
        }
    }
    return out;
}

function walkC(dir: string, out: string[]): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "build" || entry.name === "Output" || entry.name === ".git") {
                continue;
            }
            walkC(full, out);
        } else if (entry.name.toLowerCase().endsWith(".c")) {
            out.push(full);
        }
    }
}

/** Collect the information needed to build the project outside CMake (emBuild). */
export function collectProjectInfo(projectDir: string): ProjectInfo {
    const cmakeLists = path.join(projectDir, "CMakeLists.txt");
    let text = "";
    try {
        text = fs.readFileSync(cmakeLists, "utf8");
    } catch {
        throw new Error(`CMakeLists.txt not found in ${projectDir}`);
    }
    const vars = cacheVars(projectDir);
    const flags = detectCpuFlags(text);
    const cpu = flags?.cpu ?? "cortex-m0";

    // Source roots from file(GLOB_RECURSE ... "dir/*.c"), fallback to source/.
    const roots: string[] = [];
    for (const m of text.matchAll(/file\s*\(\s*GLOB_RECURSE\s+\w+[^)]*"([^"]+\.c)"/gi)) {
        const dir = path.dirname(m[1].replace(/\$\{CMAKE_SOURCE_DIR\}/g, projectDir).replace(/\//g, path.sep));
        roots.push(dir);
    }
    if (roots.length === 0) {
        roots.push(path.join(projectDir, "source"));
    }
    const sources: string[] = [];
    for (const root of roots) {
        walkC(root, sources);
    }

    // CMSIS sources and includes.
    const devicePath = vars.STM32_DEVICE_PATH;
    if (devicePath) {
        const sys = path.join(devicePath, "Source", "Templates", "system_stm32f0xx.c");
        if (fs.existsSync(sys)) {
            sources.push(sys);
        }
    }

    const includes = new Set<string>(["source"]);
    for (const value of [vars.CMSIS_CORE_PATH, vars.STM32_DEVICE_PATH ? path.join(vars.STM32_DEVICE_PATH, "Include") : ""]) {
        if (value) {
            includes.add(value);
        }
    }
    for (const m of text.matchAll(/-I\s*"?([^"\s)]+)/g)) {
        includes.add(m[1].replace(/\$\{CMAKE_SOURCE_DIR\}/g, projectDir).replace(/\//g, path.sep));
    }

    const defines = new Set<string>(["STM32F072xB"]);
    const defBlock = /target_compile_definitions\s*\(([^)]*)\)/gi;
    for (const block of text.matchAll(defBlock)) {
        const tokens = block[1].trim().split(/\s+/).slice(1); // drop the target name
        for (const token of tokens) {
            if (token && !["PRIVATE", "PUBLIC", "INTERFACE"].includes(token)) {
                defines.add(token);
            }
        }
    }

    // Linker script: prefer the GCC .ld (regions) from the project.
    let ld = "";
    const linkerBlock = /set\s*\(\s*LINKER_SCRIPT[\s\S]*?\)/i.exec(text);
    if (linkerBlock) {
        const quoted = /"([^"]+\.ld)"/.exec(linkerBlock[0]);
        if (quoted) {
            ld = quoted[1].replace(/\$\{CMAKE_SOURCE_DIR\}/g, projectDir).replace(/\$\{CMAKE_CURRENT_SOURCE_DIR\}/g, projectDir).replace(/\//g, path.sep);
        }
    }
    if (!ld || !fs.existsSync(ld)) {
        const candidate = path.join(projectDir, "linker");
        const files = fs.existsSync(candidate) ? fs.readdirSync(candidate).filter((f) => f.endsWith(".ld")) : [];
        ld = files.length ? path.join(candidate, files[0]) : "";
    }
    const regions = ld && fs.existsSync(ld) ? parseMemoryRegions(fs.readFileSync(ld, "utf8")) : [];
    if (regions.length < 2) {
        throw new Error("Could not read FLASH/RAM regions from the linker script");
    }

    return {
        cpu,
        device: detectDeviceName(ld),
        sources: [...new Set(sources)],
        includes: [...includes],
        defines: [...defines],
        linkerScript: ld,
        regions,
    };
}
