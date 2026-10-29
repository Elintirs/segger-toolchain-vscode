/* Self test: exercises the pure logic of the extension without VS Code. */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
        return require("./mock-vscode");
    }
    return originalLoad.call(this, request, parent, isMain);
};

const root = path.resolve(__dirname, "..");
const out = path.join(root, "out");
const devices = require(path.join(out, "devices"));
const presets = require(path.join(out, "presets"));
const project = require(path.join(out, "project"));
const pkgMod = require(path.join(out, "toolchainPkg"));
const size = require(path.join(out, "size"));
const ses = require(path.join(out, "ses"));

const example = path.join(root, "examples", "STM32F072");
const logs = [];
const channel = { appendLine: (s) => logs.push(s), show() {} };

let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === "function") {
            return r.then(
                () => {
                    passed++;
                    console.log(`  PASS  ${name}`);
                },
                (e) => {
                    failed++;
                    console.log(`  FAIL  ${name}\n        ${e.message}`);
                },
            );
        }
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (e) {
        failed++;
        console.log(`  FAIL  ${name}\n        ${e.message}`);
    }
    return Promise.resolve();
}

async function main() {
    console.log("unit tests");

    await test("extension activates", async () => {
        const ext = require(path.join(out, "extension.js"));
        ext.activate({ subscriptions: [], globalStorageUri: { fsPath: path.join(os.tmpdir(), "segger-activate") } });
        ext.deactivate();
    });

    const ld = fs.readFileSync(path.join(example, "linker", "STM32F072CBTX_FLASH.ld"), "utf8");
    const regions = devices.parseMemoryRegions(ld);
    await test("parse MEMORY of the STM32F072 linker script", () => {
        assert.strictEqual(regions.length, 2);
        assert.strictEqual(regions[0].name, "FLASH");
        assert.strictEqual(regions[0].origin, 0x08000000);
        assert.strictEqual(regions[0].length, 128 * 1024);
        assert.strictEqual(regions[1].name, "RAM");
        assert.strictEqual(regions[1].origin, 0x20000000);
        assert.strictEqual(regions[1].length, 16 * 1024);
    });

    const cmake = fs.readFileSync(path.join(example, "CMakeLists.txt"), "utf8");
    await test("detect -mcpu", () => {
        const flags = devices.detectCpuFlags(cmake);
        assert.deepStrictEqual(flags, { cpu: "cortex-m0", fpu: undefined, floatAbi: undefined });
    });

    const startup = fs.readFileSync(
        path.join(example, "third_party", "cmsis-device-f0", "Source", "Templates", "gcc", "startup_stm32f072xb.s"),
        "utf8",
    );
    const irqs = devices.extractIrqHandlers(startup);
    await test("extract IRQ handlers from the CMSIS startup file", () => {
        assert.ok(irqs.length >= 20, `expected >= 20 IRQs, got ${irqs.length}`);
        assert.ok(irqs.includes("RTC_IRQHandler"), "RTC_IRQHandler missing");
        assert.ok(irqs.includes("TIM1_CC_IRQHandler") || irqs.includes("USART1_IRQHandler"));
        assert.ok(irqs.every((n) => /^[A-Za-z_]\w*$/.test(n)), "invalid handler name");
    });

    await test("prepareIcf drops the NXP-only 0x400 block for STM32", () => {
        const tpl = [
            "// For emPower board: exclude the range 0x400 to 0x410.",
            "define region FLASH = FLASH1 - [from 0x400 size 16];",
            "define region RAM = RAM1;",
            "define block config.key with size = 8, fill = 0xFF { symbol BackDoorKey };",
            "place at 0x400 with fixed order { block config.key };",
            "place in FLASH { readonly };",
        ].join("\n");
        const stm32 = devices.prepareIcf(tpl, 0x08000000);
        assert.ok(!stm32.includes("0x400"), "0x400 block was not removed");
        assert.ok(stm32.includes("define region FLASH = FLASH1;"));
        assert.ok(stm32.includes("place in FLASH"));
        const kinetis = devices.prepareIcf(tpl, 0);
        assert.ok(kinetis.includes("place at 0x400"), "NXP config must be kept for flash at 0");
    });

    await test("parse size output", () => {        const s = size.parseSizeOutput("   text\t   data\t    bss\t    dec\t    hex\tfilename\n   972\t      4\t     16\t    992\t    3e0\tfirmware.elf\n");
        assert.strictEqual(s.text, 972);
        assert.strictEqual(s.data, 4);
        assert.strictEqual(s.flash, 976);
        assert.strictEqual(s.ram, 20);
    });

    // --- fake SES installation ------------------------------------------------
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "segger-test-"));
    const fakeRoot = path.join(tmp, "SEGGER", "SEGGER Embedded Studio for ARM 8.24");
    for (const f of [
        "bin/cc.exe",
        "bin/cc++.exe",
        "bin/cc-segger.exe",
        "gcc/arm-segger/bin/ar.exe",
        "gcc/arm-segger/bin/objcopy.exe",
        "gcc/arm-segger/bin/size.exe",
    ]) {
        const p = path.join(fakeRoot, f);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, "");
    }
    await test("find a SES installation and its binutils", () => {
        const found = ses.findSesInstallations(path.join(tmp, "SEGGER"));
        assert.strictEqual(found.length, 1);
        assert.strictEqual(found[0].version, "8.24");
        assert.ok(found[0].ccSegger.endsWith("cc-segger.exe"));
        assert.ok(found[0].size.endsWith("size.exe"));
    });

    // --- toolchain package download ------------------------------------------
    const context = { globalStorageUri: { fsPath: path.join(tmp, "storage") }, subscriptions: [] };
    let pkg;
    await test("download the official SEGGER CMake package", async () => {
        pkg = await pkgMod.ensureToolchainPackage(context, channel);
        assert.ok(fs.existsSync(pkg.toolchainFile), "segger-toolchain.cmake missing");
        assert.ok(fs.existsSync(path.join(pkg.modulesDir, "Compiler", "SEGGERClang.cmake")));
        assert.ok(fs.existsSync(pkg.startupTemplate));
        assert.ok(fs.existsSync(pkg.icfTemplate));
        const text = fs.readFileSync(pkg.toolchainFile, "utf8");
        assert.ok(text.includes("SEGGERClang"), "unexpected toolchain file");
    });
    if (!pkg) {
        process.exitCode = 1;
        return;
    }
    process.env.SEGGER_PKG = pkg.root;

    await test("build a SEGGER startup file", () => {
        const tpl = fs.readFileSync(pkg.startupTemplate, "utf8");
        const thumb = fs.readFileSync(pkg.thumbStartupTemplate, "utf8");
        const text = devices.buildSeggerStartup(tpl, thumb, irqs);
        assert.ok(text.includes("ISR_HANDLER RTC_IRQHandler"));
        assert.ok(text.includes("_start"));
        assert.strictEqual((text.match(/\.macro\s+END_FUNC/g) || []).length, 1, "duplicate macro");
    });

    // --- full project conversion ---------------------------------------------
    const work = path.join(tmp, "STM32F072");
    fs.cpSync(example, work, { recursive: true, filter: (src) => !/[\\/]build([\\/]|$)/.test(src) });
    const install = ses.findSesInstallations(path.join(tmp, "SEGGER"))[0];

    let result;
    await test("convert the example project", async () => {
        result = await project.convertProject(
            {
                projectDir: work,
                ses: install,
                pkg,
                cpu: "",
                deviceName: "STM32F072CB",
                stackSize: 1024,
                heapSize: 0,
                presetName: "segger-debug",
            },
            channel,
        );
        assert.strictEqual(result.irqCount, irqs.length);
        assert.ok(fs.existsSync(path.join(work, "segger", "SEGGER_Startup.S")));
        assert.ok(fs.existsSync(path.join(work, "cmake", "segger", "segger-toolchain.cmake")));
        assert.ok(fs.existsSync(path.join(work, "cmake_modules", "Platform", "Generic-SEGGERClang-C-arm-cortex-m0.cmake")));
        assert.ok(fs.existsSync(path.join(work, "CMakeUserPresets.json")));
    });

    await test("CMakeLists keeps the GCC branch and adds the SEGGER branch", async () => {
        const text = fs.readFileSync(path.join(work, "CMakeLists.txt"), "utf8");
        assert.ok(text.includes("managed:header"));
        assert.ok(text.includes("set(CMAKE_SYSTEM_PROCESSOR arm-cortex-m0)"));
        assert.ok(text.includes("segger/SEGGER_Startup.S"));
        assert.ok(text.includes("segger/SEGGER_Flash.icf"));
        assert.ok(text.includes("--specs=nano.specs"), "GCC flags were lost");
        assert.ok(text.indexOf("--specs=nano.specs") > text.indexOf("else()"), "GCC flags leaked into the SEGGER branch");
        assert.ok(text.includes("--add-region:FLASH1=0x20000@0x08000000"));
        assert.ok(text.includes("--add-region:RAM1=0x4000@0x20000000"));
        assert.ok(!/-T\$\{LINKER_SCRIPT\}\s*\n\s*-mcpu/.test(text), "unexpected leftover");
    });

    await test("generated CMakeUserPresets.json is valid", async () => {
        const data = JSON.parse(fs.readFileSync(path.join(work, "CMakeUserPresets.json"), "utf8"));
        assert.strictEqual(data.version, 3);
        const preset = data.configurePresets.find((p) => p.name === "segger-debug");
        assert.ok(preset);
        assert.strictEqual(preset.cacheVariables.CMAKE_SYSTEM_PROCESSOR, "arm-cortex-m0");
        assert.ok(preset.cacheVariables.SEGGER_TOOLCHAIN_PKG_ROOT.length > 0);
        assert.ok(preset.toolchainFile.endsWith("segger-toolchain.cmake"));
        assert.ok(data.buildPresets.some((b) => b.name === "segger-debug"));
    });

    await test("startup contains the device interrupt vectors", async () => {
        const text = fs.readFileSync(path.join(work, "segger", "SEGGER_Startup.S"), "utf8");
        assert.ok(text.includes("ISR_HANDLER RTC_IRQHandler"));
        assert.ok(text.includes("External interrupt vectors"));
        assert.ok(text.includes("_start"));
    });

    await test("generated ICF has no emPower leftovers", () => {
        const icf = fs.readFileSync(path.join(work, "segger", "SEGGER_Flash.icf"), "utf8");
        assert.ok(!icf.includes("0x400"), "NXP-specific placement still present");
        assert.ok(icf.includes("define region FLASH = FLASH1;"));
        assert.ok(icf.includes("place at start of FLASH"));
    });

    await test("conversion is all-or-nothing", async () => {
        const bad = path.join(tmp, "badproj");
        fs.mkdirSync(bad, { recursive: true });
        const cm = fs
            .readFileSync(path.join(example, "CMakeLists.txt"), "utf8")
            .replace(/target_link_options\([\s\S]*?\n\)/, "");
        fs.writeFileSync(path.join(bad, "CMakeLists.txt"), cm);
        fs.cpSync(path.join(example, "linker"), path.join(bad, "linker"), { recursive: true });
        let threw = false;
        try {
            await project.convertProject(
                {
                    projectDir: bad,
                    ses: install,
                    pkg,
                    cpu: "",
                    deviceName: "STM32F072CB",
                    stackSize: 1024,
                    heapSize: 0,
                    presetName: "segger-debug",
                },
                channel,
            );
        } catch {
            threw = true;
        }
        assert.ok(threw, "expected the conversion to fail");
        assert.ok(!fs.existsSync(path.join(bad, "segger")), "partial files were written before validation failed");
        assert.strictEqual(fs.readFileSync(path.join(bad, "CMakeLists.txt"), "utf8"), cm, "CMakeLists was modified");
    });

    await test("conversion is idempotent", async () => {
        const before = fs.readFileSync(path.join(work, "CMakeLists.txt"), "utf8");
        const first = await project.convertProject(
            {
                projectDir: work,
                ses: install,
                pkg,
                cpu: "",
                deviceName: "STM32F072CB",
                stackSize: 1024,
                heapSize: 0,
                presetName: "segger-debug",
            },
            channel,
        );
        const after = fs.readFileSync(path.join(work, "CMakeLists.txt"), "utf8");
        assert.strictEqual(after, before, "second conversion changed CMakeLists again");
        assert.strictEqual(first.irqCount, irqs.length);
        assert.strictEqual(
            (after.match(/# >>> SEGGER TOOLCHAIN \(managed:header\) >>>/g) || []).length,
            1,
            "duplicate managed blocks",
        );
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    console.log(`work dir: ${tmp}`);
    if (failed > 0) {
        process.exitCode = 1;
    }
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
