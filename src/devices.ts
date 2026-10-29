import * as fs from "fs";

export interface MemoryRegion {
    name: string;
    origin: number;
    length: number;
}

/** Parse the MEMORY block of a GNU ld script. */
export function parseMemoryRegions(ldText: string): MemoryRegion[] {
    const block = /MEMORY\s*\{([\s\S]*?)\}/i.exec(ldText);
    if (!block) {
        return [];
    }
    const regions: MemoryRegion[] = [];
    for (const line of block[1].split(/\r?\n/)) {
        const cleaned = line.replace(/\/\*[\s\S]*?\*\//g, "").trim();
        const m = /^([A-Za-z_][\w]*)\s*(?:\([^)]*\))?\s*:\s*(?:ORIGIN|org)\s*=\s*([^,]+),\s*(?:LENGTH|len)\s*=\s*([^\s,]+)/i.exec(
            cleaned,
        );
        if (!m) {
            continue;
        }
        const origin = parseNumber(m[2]);
        const length = parseNumber(m[3]);
        if (origin === undefined || length === undefined) {
            continue;
        }
        regions.push({ name: m[1].toUpperCase(), origin, length });
    }
    return regions;
}

function parseNumber(text: string): number | undefined {
    const t = text.trim();
    const hex = /^0x([0-9a-f]+)$/i.exec(t);
    if (hex) {
        return parseInt(hex[1], 16);
    }
    const dec = /^(\d+)\s*([KMG])?$/i.exec(t);
    if (dec) {
        const base = parseInt(dec[1], 10);
        const mult = dec[2] ? { K: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024 }[dec[2].toUpperCase()]! : 1;
        return base * mult;
    }
    // Values like 64*1024
    const expr = /^([0-9x]+)\s*\*\s*([0-9]+)$/i.exec(t);
    if (expr) {
        const a = parseNumber(expr[1]);
        return a === undefined ? undefined : a * parseInt(expr[2], 10);
    }
    return undefined;
}

export interface CpuFlags {
    cpu: string;
    fpu?: string;
    floatAbi?: string;
}

/** Extract -mcpu/-mfpu/-mfloat-abi from a GCC CMakeLists.txt. */
export function detectCpuFlags(cmakeText: string): CpuFlags | undefined {
    const cpu = /-mcpu=([A-Za-z0-9_+-]+)/.exec(cmakeText);
    if (!cpu) {
        return undefined;
    }
    const fpu = /-mfpu=([A-Za-z0-9_+-]+)/.exec(cmakeText);
    const abi = /-mfloat-abi=([A-Za-z0-9_+-]+)/.exec(cmakeText);
    return { cpu: cpu[1], fpu: fpu?.[1], floatAbi: abi?.[1] };
}

/**
 * Read the interrupt vector table from a CMSIS/GCC startup file and return the
 * external interrupt handler names in IRQ order (IRQ0 first).
 */
export function extractIrqHandlers(startupText: string): string[] {
    const lines = startupText.split(/\r?\n/);
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/g_pfnVectors\s*:/i.test(lines[i])) {
            start = i;
            break;
        }
    }
    if (start < 0) {
        for (let i = 0; i < lines.length; i++) {
            if (/\.section\s+\.isr_vector/i.test(lines[i])) {
                start = i;
                break;
            }
        }
    }
    if (start < 0) {
        return [];
    }

    const words: string[] = [];
    for (let i = start; i < lines.length; i++) {
        const line = lines[i].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/, "").trim();
        if (/\.size\s+g_pfnVectors/i.test(line) || /^\};?\s*$/.test(line)) {
            break;
        }
        const m = /^\.word\s+(.+)$/i.exec(line);
        if (!m) {
            continue;
        }
        for (const token of m[1].split(",")) {
            const name = token.trim().split(/\s+/)[0];
            if (name) {
                words.push(name);
            }
        }
    }

    // 16 core exception vectors: initial SP, Reset, NMI, HardFault, ... SysTick.
    const CORE_VECTORS = 16;
    if (words.length <= CORE_VECTORS) {
        return [];
    }
    return words.slice(CORE_VECTORS).map((name, index) => {
        if (/^[A-Za-z_]\w*$/.test(name) && name !== "Default_Handler") {
            return name;
        }
        return `IRQ${index}_Handler`;
    });
}

/**
 * Build a single self-contained startup file for the SEGGER toolchain:
 * the SEGGER Cortex-M vector/exception skeleton plus the external interrupt
 * vectors of the target device, plus the SEGGER runtime init code.
 */
export function buildSeggerStartup(cortexTemplate: string, thumbStartup: string, irqHandlers: string[]): string {
    const marker = /\n[ \t]*\/\/\n[ \t]*\/\/ Add external interrupt vectors here\.[\s\S]*?(?=\n[ \t]*\.section\s+\.vectors)/;
    const vectors = irqHandlers.map((name) => `        ISR_HANDLER ${name}`).join("\n");
    const block = `\n        //\n        // External interrupt vectors (generated from the CMSIS startup file)\n        //\n${vectors}\n`;
    let result = marker.test(cortexTemplate) ? cortexTemplate.replace(marker, block) : cortexTemplate;
    if (!marker.test(cortexTemplate)) {
        // Insert before the closing of the vector table.
        result = result.replace(/(\n[ \t]*\.section\s+\.vectors\s*,\s*"a"\s*\n[ \t]*\.size\s+_vectors)/, `${block}$1`);
    }
    return `${result.trimEnd()}\n\n\n// ============================================================================\n` +
        `// SEGGER runtime initialization (SEGGER_THUMB_Startup.s), inlined so that\n` +
        `// the project only needs a single startup source file.\n` +
        `// ============================================================================\n\n` +
        `${stripDuplicateMacros(thumbStartup).trim()}\n`;
}

function stripDuplicateMacros(thumbStartup: string): string {
    // END_FUNC is defined by both startup files; keep the Cortex-M one.
    return thumbStartup.replace(/^\.macro\s+END_FUNC\b[\s\S]*?^\.endm[ \t]*$/gm, "");
}

/**
 * The upstream SEGGER_Flash.icf reserves 16 bytes at 0x400 for NXP Kinetis
 * security settings. That is meaningless for an STM32 whose flash starts at
 * 0x08000000, so drop that block unless flash really starts at address 0.
 */
export function prepareIcf(template: string, flashOrigin: number): string {
    if (flashOrigin === 0) {
        return template;
    }
    let text = template;
    text = text.replace(
        /\/\/[^\n]*emPower board:[^\n]*\r?\n[ \t]*define region FLASH = FLASH1 - \[from 0x400 size 16\];\r?\n?/i,
        "define region FLASH = FLASH1;\n",
    );
    text = text.replace(
        /define block config\.key[\s\S]*?place at 0x400 with fixed order \{[\s\S]*?\};\r?\n?/,
        "",
    );
    return text;
}

/** CMake platform module files that teach CMake the SEGGER flags for this CPU. */export function platformModules(flags: CpuFlags): Array<{ relativePath: string; content: string }> {
    const extra = [flags.fpu ? `-mfpu=${flags.fpu}` : "", flags.floatAbi ? `-mfloat-abi=${flags.floatAbi}` : ""]
        .filter(Boolean)
        .join("\n  ");
    const common = `# Generated by the SEGGER Toolchain extension for ${flags.cpu}\nset(common_TARGET_OPTS_LIST\n  -mcpu=${flags.cpu}\n  -mthumb\n${extra ? `  ${extra}\n` : ""})\n\nlist(JOIN common_TARGET_OPTS_LIST " " common_TARGET_OPTS_STR)\nunset(common_TARGET_OPTS_LIST)\n`;

    const lang = (variable: string, withLinker: boolean) => `${`# Generated by the SEGGER Toolchain extension`}\ninclude(\${CMAKE_CURRENT_LIST_DIR}/common_arm_${flags.cpu}.cmake)\nstring(APPEND ${variable} " \${common_TARGET_OPTS_STR}")\n${
        withLinker
            ? `if(NOT CMAKE_EXE_LINKER_FLAGS_INIT MATCHES " -mcpu=${flags.cpu}")\n  string(APPEND CMAKE_EXE_LINKER_FLAGS_INIT " -mcpu=${flags.cpu}")\nendif()\n`
            : ""
    }unset(common_TARGET_OPTS_STR)\n`;

    return [
        { relativePath: `cmake_modules/Platform/common_arm_${flags.cpu}.cmake`, content: common },
        {
            relativePath: `cmake_modules/Platform/Generic-SEGGERClang-C-arm-${flags.cpu}.cmake`,
            content: lang("CMAKE_C_FLAGS_INIT", true),
        },
        {
            relativePath: `cmake_modules/Platform/Generic-SEGGERClang-CXX-arm-${flags.cpu}.cmake`,
            content: lang("CMAKE_CXX_FLAGS_INIT", true),
        },
        {
            relativePath: `cmake_modules/Platform/Generic-SEGGERClang-ASM-arm-${flags.cpu}.cmake`,
            content: lang("CMAKE_ASM_FLAGS_INIT", false),
        },
    ];
}

/** Find the first file matching a name pattern below one of the given roots. */
export function findFileUnder(roots: string[], pattern: RegExp, maxDepth = 6): string | undefined {
    const fsMod = fs;
    const visit = (dir: string, depth: number): string | undefined => {
        if (depth > maxDepth) {
            return undefined;
        }
        let entries: fs.Dirent[];
        try {
            entries = fsMod.readdirSync(dir, { withFileTypes: true });
        } catch {
            return undefined;
        }
        for (const entry of entries) {
            if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "build") {
                continue;
            }
            const full = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                const found = visit(full, depth + 1);
                if (found) {
                    return found;
                }
            } else if (pattern.test(entry.name)) {
                return full;
            }
        }
        return undefined;
    };
    for (const root of roots) {
        const found = visit(root, 0);
        if (found) {
            return found;
        }
    }
    return undefined;
}
