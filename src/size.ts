import * as vscode from "vscode";
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

/** Run objdump-style size on the ELF using SEGGER binutils when available. */
export async function measureSize(elf: string, sizeTool?: string): Promise<FirmwareSize | undefined> {
    const tool = sizeTool ?? which("arm-none-eabi-size") ?? which("size");
    if (!tool) {
        return undefined;
    }
    const result = await run(tool, ["-B", elf]);
    if (result.code !== 0) {
        return undefined;
    }
    return parseSizeOutput(result.stdout);
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
