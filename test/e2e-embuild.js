const path = require("path");
const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "vscode") return require(path.join(__dirname, "..", "test", "mock-vscode"));
    return originalLoad.call(this, request, parent, isMain);
};
const root = path.resolve(__dirname, "..");
const { collectProjectInfo } = require(path.join(root, "out", "projectInfo"));
const { runEmBuild } = require(path.join(root, "out", "embuild"));

(async () => {
    const dir = process.argv[2];
    const info = collectProjectInfo(dir);
    console.log("sources:", info.sources.map((s) => path.basename(s)).join(", "));
    console.log("includes:", info.includes.length, "defines:", info.defines.join(","));
    const res = await runEmBuild(
        {
            projectDir: dir,
            info,
            sesRoot: "D:\\",
            name: "STM32F072_auto",
            optimization: "balanced",
            stackSize: 1024,
            heapSize: 0,
            extraDefines: [],
            extraIncludes: [],
        },
        { appendLine: (s) => console.log(s), show() {} },
    );
    console.log("result:", res);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
