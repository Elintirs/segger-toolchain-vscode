import * as fs from "fs";
import { run, which } from "./util";

export interface FirmwareSize {
    text: number;
    data: number;
    bss: number;
    /** Flash bytes: .text + .data */
    flash: number;
    /** RAM bytes: .data + .bss */
    ram: number;
}

/**
 * Compute text/data/bss directly from an ELF32 little-endian file.
 * Used as a fallback when the SEGGER/ARM `size` tool is not installed.
 */
export function sizeFromElf(file: string): FirmwareSize | undefined {
    let buf: Buffer;
    try {
        buf = fs.readFileSync(file);
    } catch {
        return undefined;
    }
    if (buf.length < 0x34 || buf.readUInt32BE(0) !== 0x7f454c46) {
        return undefined;
    }
    if (buf[4] !== 1 || buf[5] !== 1) {
        return undefined; // only ELF32 little-endian
    }
    const shoff = buf.readUInt32LE(0x20);
    const shentsize = buf.readUInt16LE(0x2e);
    const shnum = buf.readUInt16LE(0x30);
    const shstrndx = buf.readUInt16LE(0x32);
    if (!shoff || !shnum || !shentsize || shstrndx >= shnum) {
        return undefined;
    }
    const section = (index: number) => {
        const off = shoff + index * shentsize;
        return {
            name: buf.readUInt32LE(off),
            type: buf.readUInt32LE(off + 4),
            flags: buf.readUInt32LE(off + 8),
            size: buf.readUInt32LE(off + 20),
        };
    };
    const SHF_WRITE = 0x1;
    const SHF_ALLOC = 0x2;
    const SHT_NOBITS = 8;

    let text = 0;
    let data = 0;
    let bss = 0;
    for (let i = 1; i < shnum; i++) {
        const s = section(i);
        if (!(s.flags & SHF_ALLOC)) {
            continue;
        }
        const isWrite = Boolean(s.flags & SHF_WRITE);
        if (!isWrite) {
            text += s.size;
        } else if (s.type === SHT_NOBITS) {
            bss += s.size;
        } else {
            data += s.size;
        }
    }
    return { text, data, bss, flash: text + data, ram: data + bss };
}

export function parseSizeOutput(text: string): FirmwareSize | undefined {
    const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        const parts = lines[i].split(/\s+/);
        if (parts.length >= 4 && parts.slice(0, 3).every((p) => /^\d+$/.test(p))) {
            const textBytes = parseInt(parts[0], 10);
            const data = parseInt(parts[1], 10);
            const bss = parseInt(parts[2], 10);
            return { text: textBytes, data, bss, flash: textBytes + data, ram: data + bss };
        }
    }
    return undefined;
}

/** Run `size` on the ELF (SEGGER/ARM binutils) or fall back to reading the ELF sections. */
export async function measureSize(elf: string, sizeTool?: string): Promise<FirmwareSize | undefined> {
    const tool = sizeTool ?? which("arm-none-eabi-size") ?? which("size");
    if (tool) {
        const result = await run(tool, ["-B", elf]);
        if (result.code === 0) {
            const parsed = parseSizeOutput(result.stdout);
            if (parsed) {
                return parsed;
            }
        }
    }
    return sizeFromElf(elf);
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    return `${bytes} B (${(bytes / 1024).toFixed(1)} KiB)`;
}

export interface CompareRow {
    label: string;
    segger?: FirmwareSize;
    gcc?: FirmwareSize;
}

export function renderComparePanel(rows: CompareRow[], cpu: string): string {
    const pct = (a?: number, b?: number) => {
        if (a === undefined || b === undefined || b === 0) {
            return "";
        }
        const d = ((a - b) / b) * 100;
        return `${d >= 0 ? "+" : ""}${d.toFixed(1)} %`;
    };
    const cells = rows
        .map((row) => {
            const s = row.segger?.flash;
            const g = row.gcc?.flash;
            const cls = s !== undefined && g !== undefined ? (s < g ? "good" : "bad") : "";
            return `<tr class="${cls}">
                <td>${row.label}</td>
                <td>${s ?? "-"}</td>
                <td>${g ?? "-"}</td>
                <td>${pct(s, g)}</td>
            </tr>`;
        })
        .join("\n");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
  h1 { font-size: 1.3em; font-weight: 600; }
  table { border-collapse: collapse; min-width: 420px; }
  th, td { border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 14px; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  tr.good td:nth-child(4) { color: var(--vscode-testing-iconPassed); }
  tr.bad td:nth-child(4) { color: var(--vscode-testing-iconFailed); }
  .muted { opacity: .7; font-size: .9em; }
</style>
</head>
<body>
  <h1>Firmware size: SEGGER vs GCC</h1>
  <p class="muted">Flash usage = .text + .data, target ${cpu}.</p>
  <table>
    <tr><th>Build</th><th>SEGGER, B</th><th>GCC, B</th><th>Delta</th></tr>
    ${cells}
  </table>
</body>
</html>`;
}
