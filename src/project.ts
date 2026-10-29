import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
    buildSeggerStartup,
    detectCpuFlags,
    detectDeviceName,
    extractIrqHandlers,
    findFileUnder,
    MemoryRegion,
    parseMemoryRegions,
    platformModules,
    prepareIcf,
} from "./devices";
import { findGccPreset, PresetPaths, writeUserPresets, writeWorkspaceSettings } from "./presets";
import { SesInstall } from "./ses";
import { ToolchainPackage, vendorPackageIntoProject } from "./toolchainPkg";
import { isFile, readJsoncFile, writeFileEnsured } from "./util";

export interface ConvertOptions {
    projectDir: string;
    ses: SesInstall;
    pkg: ToolchainPackage;
    cpu?: string;
    deviceName: string;
    stackSize: number;
    heapSize: number;
    presetName: string;
    extraCFlags?: string;
    extraLinkFlags?: string;
    extraDefines?: string[];
    extraIncludes?: string[];
}

export interface ConvertResult {
    preset: PresetPaths;
    changes: string[];
    warnings: string[];
    regions: MemoryRegion[];
    irqCount: number;
    startupFile: string;
    device?: string;
}

interface PresetsLike {
    configurePresets?: Array<{
        name?: string;
        cacheVariables?: Record<string, unknown>;
    }>;
}

function cacheVar(projectDir: string, name: string): string | undefined {
    for (const file of [path.join(projectDir, "CMakePresets.json"), path.join(projectDir, "CMakeUserPresets.json")]) {
        const data = readJsoncFile<PresetsLike>(file);
        for (const preset of data?.configurePresets ?? []) {
            const value = preset.cacheVariables?.[name];
            if (typeof value === "string" && value.trim()) {
                return value.replace(/\$\{sourceDir\}/g, projectDir).replace(/\//g, path.sep);
            }
        }
    }
    return undefined;
}

function quotedPaths(block: string): string[] {
    return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function setBlock(text: string, variable: string): { text: string; index: number } | undefined {
    const m = new RegExp(`set\\(\\s*${variable}\\s+[\\s\\S]*?\\)`, "i").exec(text);
    return m ? { text: m[0], index: m.index } : undefined;
}

function managedPattern(id: string): RegExp {
    return new RegExp(
        `\\r?\\n?[ \\t]*# >>> SEGGER TOOLCHAIN \\(managed:${id}\\) >>>[\\s\\S]*?# <<< SEGGER TOOLCHAIN \\(managed:${id}\\) <<<\\r?\\n?`,
    );
}

function hasManaged(text: string, id: string): boolean {
    return managedPattern(id).test(text);
}

/** Replace a marker-delimited block; the original GCC branch is kept. */
function applyManaged(text: string, id: string, build: (original: string | undefined) => string): string {
    const re = managedPattern(id);
    const m = re.exec(text);
    if (!m) {
        return text;
    }
    const original = /else\(\)\r?\n([\s\S]*?)\r?\n[ \t]*endif\(\)/.exec(m[0])?.[1];
    return text.slice(0, m.index) + "\n" + build(original) + "\n" + text.slice(m.index + m[0].length);
}

function wrap(id: string, segger: string, original: string | undefined): string {
    return [
        `# >>> SEGGER TOOLCHAIN (managed:${id}) >>>`,
        'if(CMAKE_TOOLCHAIN_FILE MATCHES "segger-toolchain")',
        segger,
        "else()",
        original ?? "",
        "endif()",
        `# <<< SEGGER TOOLCHAIN (managed:${id}) <<<`,
    ].join("\n");
}

function formatRegion(region: MemoryRegion): string {
    return `0x${region.length.toString(16)}@0x${region.origin.toString(16).padStart(8, "0")}`;
}

function seggerLinkerBlock(target: string, regions: MemoryRegion[], stackSize: number, heapSize: number): string {
    const flash = regions.find((r) => /FLASH/i.test(r.name)) ?? regions[0];
    const ram = regions.find((r) => /RAM/i.test(r.name)) ?? regions[1] ?? regions[0];
    return [
        `    target_link_options(${target} PRIVATE`,
        "        -T${LINKER_SCRIPT}",
        `        -Wl,--add-region:FLASH1=${formatRegion(flash)}`,
        `        -Wl,--add-region:RAM1=${formatRegion(ram)}`,
        `        -Wl,--defsym=__STACKSIZE__=${stackSize}`,
        `        -Wl,--defsym=__HEAPSIZE__=${heapSize}`,
        "        -eReset_Handler",
        "        --full-section-headers",
        "        --merge-sections",
        "        --merge-strings",
        "        --map-text",
        "        --map-standard",
        "        --no-outline",
        "        --relax",
        "        --no-springboard",
        "        --no-tail-merge",
        "        --tp-model=auto",
        "        --list-all-undefineds",
        "    )",
    ].join("\n");
}

export async function convertProject(opts: ConvertOptions, output: vscode.OutputChannel): Promise<ConvertResult> {
    const { projectDir } = opts;
    const cmakeListsPath = path.join(projectDir, "CMakeLists.txt");
    if (!isFile(cmakeListsPath)) {
        throw new Error(`CMakeLists.txt not found in ${projectDir}`);
    }
    const original = fs.readFileSync(cmakeListsPath, "utf8");
    const changes: string[] = [];
    const warnings: string[] = [];

    const flags = detectCpuFlags(original);
    const cpu = opts.cpu?.trim() || flags?.cpu || "cortex-m0";
    const sysProc = `arm-${cpu}`;

    // --- GNU linker script -> memory regions --------------------------------
    const linkerBlock = setBlock(original, "LINKER_SCRIPT");
    const linkerPaths = linkerBlock ? quotedPaths(linkerBlock.text) : [];
    let ldFile = linkerPaths.find((p) => /\.ld$/i.test(p)) ?? linkerPaths.find((p) => !/SEGGER_Flash\.icf$/i.test(p));
    if (ldFile) {
        ldFile = ldFile
            .replace(/\$\{CMAKE_SOURCE_DIR\}/g, projectDir)
            .replace(/\$\{CMAKE_CURRENT_SOURCE_DIR\}/g, projectDir)
            .replace(/\//g, path.sep);
    }
    if (!ldFile || !isFile(ldFile)) {
        ldFile = findFileUnder([projectDir], /\.ld$/i, 4);
    }
    if (!ldFile || !isFile(ldFile)) {
        throw new Error("Could not find the GNU linker script (*.ld) referenced by CMakeLists.txt");
    }
    const regions = parseMemoryRegions(fs.readFileSync(ldFile, "utf8"));
    if (regions.length < 2) {
        throw new Error(`Could not parse the MEMORY block of ${ldFile}`);
    }
    const device = detectDeviceName(ldFile);
    changes.push(`Linker script: ${path.relative(projectDir, ldFile)} -> segger/SEGGER_Flash.icf`);
    if (device) {
        changes.push(`Detected J-Link device: ${device}`);
    }

    // --- CMSIS startup -> interrupt vector names ----------------------------
    const startupBlock = setBlock(original, "STARTUP_FILE");
    const startupPaths = startupBlock ? quotedPaths(startupBlock.text) : [];
    const startupRef =
        startupPaths.find((p) => !/segger[\\/]SEGGER_Startup\.s$/i.test(p)) ?? startupPaths[0];
    const devicePath = cacheVar(projectDir, "STM32_DEVICE_PATH");
    const searchRoots = [
        devicePath ? path.join(devicePath, "Source", "Templates", "gcc") : "",
        devicePath ?? "",
        projectDir,
    ].filter(Boolean);
    let cmsisStartup = startupRef
        ? searchRoots.map((root) => path.join(root, path.basename(startupRef))).find((p) => isFile(p))
        : undefined;
    if (!cmsisStartup) {
        cmsisStartup = findFileUnder(searchRoots, /^startup_.*\.s$/i, 6);
    }
    let irqHandlers: string[] = [];
    if (cmsisStartup && isFile(cmsisStartup)) {
        irqHandlers = extractIrqHandlers(fs.readFileSync(cmsisStartup, "utf8"));
        if (irqHandlers.length === 0) {
            warnings.push(`No external interrupt vectors found in ${cmsisStartup}`);
        }
    } else {
        warnings.push(
            "CMSIS startup file not found. The generated startup will only contain core exception vectors; " +
                "add the device interrupt handlers to segger/SEGGER_Startup.S manually.",
        );
    }

    // --- prepare SEGGER support files (written only after all checks pass) ---
    const seggerDir = path.join(projectDir, "segger");
    const flashRegion = regions.find((r) => /FLASH/i.test(r.name)) ?? regions[0];
    const startupText = buildSeggerStartup(
        fs.readFileSync(opts.pkg.startupTemplate, "utf8"),
        fs.readFileSync(opts.pkg.thumbStartupTemplate, "utf8"),
        irqHandlers,
    );
    const icfText = prepareIcf(fs.readFileSync(opts.pkg.icfTemplate, "utf8"), flashRegion.origin);

    // --- patch CMakeLists.txt -----------------------------------------------
    let text = original;

    const headerBlock = [
        "# >>> SEGGER TOOLCHAIN (managed:header) >>>",
        'if(CMAKE_TOOLCHAIN_FILE MATCHES "segger-toolchain")',
        `    set(CMAKE_SYSTEM_PROCESSOR ${sysProc})`,
        '    list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake_modules")',
        "endif()",
        "# <<< SEGGER TOOLCHAIN (managed:header) <<<",
    ].join("\n");

    if (hasManaged(text, "header")) {
        text = applyManaged(text, "header", () => headerBlock);
    } else {
        const projectIndex = /\nproject\s*\(/.exec(text)?.index;
        if (projectIndex === undefined) {
            throw new Error("Could not find project() in CMakeLists.txt");
        }
        text = text.slice(0, projectIndex) + "\n" + headerBlock + "\n" + text.slice(projectIndex);
    }
    changes.push("CMakeLists.txt: CMAKE_SYSTEM_PROCESSOR + module path added");

    // Startup source
    const currentStartup = setBlock(text, "STARTUP_FILE");
    if (currentStartup) {
        const build = (orig: string | undefined) =>
            wrap("startup", `    set(STARTUP_FILE "\${CMAKE_CURRENT_SOURCE_DIR}/segger/SEGGER_Startup.S")`, orig ?? currentStartup.text);
        if (hasManaged(text, "startup")) {
            text = applyManaged(text, "startup", build);
        } else {
            text = text.slice(0, currentStartup.index) + build(undefined) + text.slice(currentStartup.index + currentStartup.text.length);
        }
        changes.push("CMakeLists.txt: startup source switched per toolchain");
    } else {
        warnings.push("No set(STARTUP_FILE ...) found in CMakeLists.txt - add segger/SEGGER_Startup.S to your target manually.");
    }

    // Linker script variable
    const currentLinker = setBlock(text, "LINKER_SCRIPT");
    if (currentLinker) {
        const build = (orig: string | undefined) =>
            wrap("linker", `    set(LINKER_SCRIPT "\${CMAKE_CURRENT_SOURCE_DIR}/segger/SEGGER_Flash.icf")`, orig ?? currentLinker.text);
        if (hasManaged(text, "linker")) {
            text = applyManaged(text, "linker", build);
        } else {
            text = text.slice(0, currentLinker.index) + build(undefined) + text.slice(currentLinker.index + currentLinker.text.length);
        }
        changes.push("CMakeLists.txt: linker script switched per toolchain");
    }

    // target_link_options
    const currentLinkOptions = /target_link_options\(\s*([A-Za-z0-9_]+)\s+PRIVATE\b[\s\S]*?\n\)/.exec(text);
    if (!currentLinkOptions) {
        throw new Error("Could not find a target_link_options(<target> PRIVATE ...) block in CMakeLists.txt");
    }
    const target = currentLinkOptions[1];
    {
        const build = (orig: string | undefined) =>
            wrap("link-options", seggerLinkerBlock(target, regions, opts.stackSize, opts.heapSize), orig ?? currentLinkOptions[0]);
        if (hasManaged(text, "link-options")) {
            text = applyManaged(text, "link-options", build);
        } else {
            text =
                text.slice(0, currentLinkOptions.index) +
                build(undefined) +
                text.slice(currentLinkOptions.index + currentLinkOptions[0].length);
        }
        changes.push("CMakeLists.txt: linker options switched per toolchain");
    }

    // objcopy/size must not be required as arm-none-eabi-* when SEGGER binutils are used
    text = text
        .replace(
            /find_program\(\s*ARM_OBJCOPY\s+arm-none-eabi-objcopy\s+REQUIRED\s*\)/i,
            "find_program(ARM_OBJCOPY NAMES arm-none-eabi-objcopy objcopy)",
        )
        .replace(
            /find_program\(\s*ARM_SIZE\s+arm-none-eabi-size\s+REQUIRED\s*\)/i,
            "find_program(ARM_SIZE NAMES arm-none-eabi-size size)",
        );

    // --- everything validated: write the generated files ---------------------
    await writeFileEnsured(path.join(seggerDir, "SEGGER_Startup.S"), startupText);
    await writeFileEnsured(path.join(seggerDir, "SEGGER_Flash.icf"), icfText);
    changes.push(`Created segger/SEGGER_Startup.S (${irqHandlers.length} IRQs, ${cpu})`);
    changes.push("Created segger/SEGGER_Flash.icf");

    const vendor = await vendorPackageIntoProject(opts.pkg, projectDir);
    changes.push(`Vendored SEGGER CMake package into ${path.relative(projectDir, vendor.destDir)}`);

    for (const module of platformModules({ cpu, fpu: flags?.fpu, floatAbi: flags?.floatAbi })) {
        await writeFileEnsured(path.join(projectDir, module.relativePath), module.content);
    }
    changes.push(`Generated CMake platform modules for ${sysProc}`);

    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    text = text.replace(/\r?\n/g, eol);

    if (text !== original) {
        const backupDir = path.join(projectDir, ".segger", "backup");
        await fs.promises.mkdir(backupDir, { recursive: true });
        const backup = path.join(backupDir, `CMakeLists.${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
        await fs.promises.writeFile(backup, original, "utf8");
        await fs.promises.writeFile(cmakeListsPath, text, "utf8");
        output.appendLine(`CMakeLists.txt patched (backup: ${backup})`);
    }

    // --- presets -------------------------------------------------------------
    const preset = writeUserPresets({
        projectDir,
        toolchainFile: vendor.toolchainFile,
        pkgRoot: opts.ses.root,
        sysProc,
        objcopy: opts.ses.objcopy,
        sizeTool: opts.ses.size,
        stackSize: opts.stackSize,
        heapSize: opts.heapSize,
        presetName: opts.presetName,
        deviceName: device ?? opts.deviceName,
        extraCFlags: opts.extraCFlags,
        extraLinkFlags: opts.extraLinkFlags,
        extraDefines: opts.extraDefines,
        extraIncludes: opts.extraIncludes,
    });
    await writeWorkspaceSettings(projectDir, opts.presetName);
    changes.push(`Created ${path.basename(preset.userPresetsFile)} (${opts.presetName})`);

    if (!findGccPreset(projectDir)) {
        warnings.push("No GCC preset found - size comparison against GCC will not be available.");
    }

    return {
        preset,
        changes,
        warnings,
        regions,
        irqCount: irqHandlers.length,
        startupFile: path.join(seggerDir, "SEGGER_Startup.S"),
        device,
    };
}
