const path = require("path");
const fs = require("fs");
const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "vscode") return require(path.join(__dirname, "..", "test", "mock-vscode"));
    return originalLoad.call(this, request, parent, isMain);
};
const root = path.resolve(__dirname, "..");
const { ensureToolchainPackage } = require(path.join(root, "out", "toolchainPkg"));
const { convertProject } = require(path.join(root, "out", "project"));
const { findSesInstallations } = require(path.join(root, "out", "ses"));

(async () => {
    const logs = [];
    const channel = { appendLine: (s) => logs.push(s), show() {} };
    const context = { globalStorageUri: { fsPath: path.join(root, ".cache-test") }, subscriptions: [] };
    const pkg = await ensureToolchainPackage(context, channel);
    const installs = findSesInstallations("D:\\");
    console.log("SES:", JSON.stringify(installs.map((i) => ({ root: i.root, v: i.version, arch: i.arch, size: i.size, objcopy: i.objcopy }))));
    if (!installs.length) throw new Error("SES not found");
    const result = await convertProject(
        {
            projectDir: process.argv[2],
            ses: installs[0],
            pkg,
            cpu: "",
            deviceName: "STM32F072CB",
            stackSize: 1024,
            heapSize: 0,
            presetName: "segger-debug",
        },
        channel,
    );
    console.log(logs.join("\n"));
    console.log(JSON.stringify({ irq: result.irqCount, device: result.device, regions: result.regions }, null, 2));
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
