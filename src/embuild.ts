import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ProjectInfo } from "./projectInfo";
import { isFile, newestFile, runStreaming, walk } from "./util";

export type EmOptimization = "none" | "balanced" | "size";

export interface EmBuildOptions {
    projectDir: string;
    info: ProjectInfo;
    sesRoot: string;
    name: string;
    optimization: EmOptimization;
    stackSize: number;
    heapSize: number;
    extraDefines: string[];
    extraIncludes: string[];
}

const CPU_PROPS: Record<string, { target: string; arch: string }> = {
    "cortex-m0": { target: "Cortex-M0", arch: "v6M" },
    "cortex-m0plus": { target: "Cortex-M0+", arch: "v6M" },
    "cortex-m1": { target: "Cortex-M1", arch: "v6M" },
    "cortex-m3": { target: "Cortex-M3", arch: "v7M" },
    "cortex-m4": { target: "Cortex-M4", arch: "v7EM" },
    "cortex-m7": { target: "Cortex-M7", arch: "v7EM" },
    "cortex-m23": { target: "Cortex-M23", arch: "v8M" },
    "cortex-m33": { target: "Cortex-M33", arch: "v8M" },
};

const OPT_LEVEL: Record<EmOptimization, string> = {
    none: "None",
    balanced: "Level 2 balanced",
    size: "Level 2 for size",
};

function xml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function regionList(info: ProjectInfo): string {
    const flash = info.regions.find((r) => /FLASH/i.test(r.name)) ?? info.regions[0];
    const ram = info.regions.find((r) => /RAM/i.test(r.name)) ?? info.regions[1] ?? info.regions[0];
    return `FLASH1 RX 0x${flash.origin.toString(16).padStart(8, "0")} 0x${flash.length.toString(16)};RAM1 RWX 0x${ram.origin
        .toString(16)
        .padStart(8, "0")} 0x${ram.length.toString(16)}`;
}

/** Generate a SEGGER Embedded Studio project for emBuild. */
export function writeEmProject(options: EmBuildOptions): string {
    const { projectDir, info } = options;
    const startup = path.join(projectDir, "segger", "SEGGER_Startup.S");
    const icf = path.join(projectDir, "segger", "SEGGER_Flash.icf");
    if (!isFile(startup) || !isFile(icf)) {
        throw new Error("segger/SEGGER_Startup.S or segger/SEGGER_Flash.icf is missing - run 'SEGGER: Setup toolchain' first");
    }
    const cpu = CPU_PROPS[info.cpu] ?? CPU_PROPS["cortex-m0"];
    const rel = (p: string) => path.relative(projectDir, p).replace(/\\/g, "/");
    const sources = info.sources.map(
        (s) => `      <file file_name="${xml(rel(s))}" />`,
    );
    const defines = [...new Set([...info.defines, ...options.extraDefines])].join(";");
    const includes = [...new Set([...info.includes, ...options.extraIncludes])]
        .map((i) => rel(path.isAbsolute(i) ? i : path.join(projectDir, i)))
        .join(";");

    const project = `<!DOCTYPE CrossStudio_Project_File>
<solution Name="${xml(options.name)}" target="8" version="2">
  <configuration
    Name="Debug"
    c_preprocessor_definitions="${xml(defines)}"
    c_user_include_directories="${xml(includes)}"
    gcc_debugging_level="Level 2"
    gcc_omit_frame_pointer="Yes"
    gcc_optimization_level="${OPT_LEVEL[options.optimization]}"
    link_dedupe_code="Yes"
    link_merge_strings="Yes" />
  <project Name="${xml(options.name)}">
    <configuration
      Name="Common"
      Target="${xml(cpu.target)}"
      arm_architecture="${xml(cpu.arch)}"
      arm_compiler_variant="SEGGER"
      arm_core_type="${xml(cpu.target)}"
      arm_endian="Little"
      arm_linker_heap_size="${options.heapSize}"
      arm_linker_process_stack_size="0"
      arm_linker_stack_size="${options.stackSize}"
      arm_linker_variant="SEGGER"
      arm_target_device_name="${xml(info.device ?? options.name)}"
      arm_target_interface_type="SWD"
      debug_stack_pointer_start="__stack_end__"
      debug_target_connection="Simulator"
      gcc_entry_point="Reset_Handler"
      link_linker_script_file="${xml(rel(icf))}"
      linker_output_format="hex"
      linker_section_placements_segments="${xml(regionList(info))}"
      project_directory=""
      project_type="Executable"
      property_groups_file_path="$(StudioDir)/targets/propertyGroups_CM.xml" />
    <folder Name="Source">
${sources.join("\n")}
    </folder>
    <folder Name="System">
      <file file_name="${xml(rel(startup))}" />
    </folder>
    <folder Name="Setup">
      <file file_name="${xml(rel(icf))}" />
    </folder>
  </project>
</solution>
`;
    const file = path.join(projectDir, `${options.name}.emProject`);
    fs.writeFileSync(file, project, "utf8");
    return file;
}

export interface EmBuildResult {
    ok: boolean;
    elf?: string;
    seconds: number;
}

/** Build a generated SES project with emBuild (works under the free SFL, no CLI key). */
export async function runEmBuild(
    options: EmBuildOptions,
    output: vscode.OutputChannel,
    token?: vscode.CancellationToken,
): Promise<EmBuildResult> {
    const started = Date.now();
    const emBuild = path.join(options.sesRoot, "bin", "emBuild.exe");
    if (!isFile(emBuild)) {
        throw new Error(`emBuild.exe not found: ${emBuild}`);
    }
    const projectFile = writeEmProject(options);
    const code = await runStreaming(emBuild, [projectFile, "-config", "Debug"], options.projectDir, output, token);
    if (code !== 0) {
        return { ok: false, seconds: (Date.now() - started) / 1000 };
    }
    const outDir = path.join(options.projectDir, "Output");
    const elf = newestFile(walk(outDir, (f) => f.toLowerCase().endsWith(".elf"), 6));
    return { ok: true, elf, seconds: (Date.now() - started) / 1000 };
}
