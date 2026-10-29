const path = require("path");
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
    const ses = findSesInstallations().length
        ? findSesInstallations()[0]
        : {
              root: "C:/Program Files/SEGGER/SEGGER Embedded Studio for ARM 8.24",
              cc: "C:/Program Files/SEGGER/SEGGER Embedded Studio for ARM 8.24/bin/cc.exe",
              version: "8.24",
              objcopy: "C:/Program Files/SEGGER/SEGGER Embedded Studio for ARM 8.24/gcc/arm-segger/bin/objcopy.exe",
              size: "C:/Program Files/SEGGER/SEGGER Embedded Studio for ARM 8.24/gcc/arm-segger/bin/size.exe",
          };
    const result = await convertProject(
        {
            projectDir: process.argv[2],
            ses,
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
    console.log(JSON.stringify({ irqCount: result.irqCount, regions: result.regions }, null, 2));
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
