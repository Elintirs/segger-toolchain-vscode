#!/usr/bin/env python3
"""
Reproduce the firmware-size comparison from README.md.

Usage:
    python test/bench.py [--project examples/STM32F072] [--clang PATH]

Requires arm-none-eabi-gcc in PATH (or ARM_GCC_BIN set). Clang is optional.
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PROJECT = os.path.join(HERE, "..", "examples", "STM32F072")

SOURCES = [
    "source/main.c",
    "source/config/configuration.c",
    "source/config/system_init.c",
    "third_party/cmsis-device-f0/Source/Templates/system_stm32f0xx.c",
]
STARTUP = "third_party/cmsis-device-f0/Source/Templates/gcc/startup_stm32f072xb.s"
INCLUDES = ["source", "third_party/cmsis-device-f0/Include", "third_party/CMSIS_5/CMSIS/Core/Include"]
LINKER = "linker/STM32F072CBTX_FLASH.ld"

STUB = "void __libc_init_array(void) {}\nvoid __libc_fini_array(void) {}\nvoid _exit(int s) { for (;;) {} }\n"


def tool(name):
    path = shutil.which(name)
    if not path:
        sys.exit(f"{name} not found in PATH")
    return path


def size_of(size_tool, elf):
    out = subprocess.run([size_tool, "-B", elf], capture_output=True, text=True, check=True).stdout
    parts = out.strip().splitlines()[-1].split()
    text, data = int(parts[0]), int(parts[1])
    return text, data, text + data


def build(work, root, name, compiler, flags, gcc, size_tool, bare=False, sysinc=None):
    out = os.path.join(work, name)
    os.makedirs(out, exist_ok=True)
    inc = [f"-I{root}/{i}" for i in INCLUDES]
    if compiler == "clang":
        base = ["--target=arm-none-eabi", "-mcpu=cortex-m0", "-mthumb", "-DSTM32F072xB",
                "-ffunction-sections", "-fdata-sections", "-g0", "-fno-common"] + inc
        if sysinc:
            base.append(f"-isystem{sysinc}")
        cc = tool("clang")
    else:
        base = ["-mcpu=cortex-m0", "-mthumb", "-DSTM32F072xB", "-ffunction-sections",
                "-fdata-sections", "-g0"] + inc
        cc = gcc
    sources = list(SOURCES)
    if bare:
        stub = os.path.join(out, "stub.c")
        with open(stub, "w") as f:
            f.write(STUB)
        sources.append(stub)
    objs = []
    for i, src in enumerate(sources):
        obj = os.path.join(out, f"{i}.o")
        src_path = src if os.path.isabs(src) else f"{root}/{src}"
        subprocess.run([cc] + base + flags + ["-c", src_path, "-o", obj], check=True,
                       capture_output=True)
        objs.append(obj)
    start = os.path.join(out, "start.o")
    subprocess.run([gcc, "-mcpu=cortex-m0", "-mthumb", "-c", f"{root}/{STARTUP}", "-o", start],
                   check=True, capture_output=True)
    objs.append(start)
    elf = os.path.join(out, "fw.elf")
    link = [gcc] + flags + [f"-T{root}/{LINKER}", "-Wl,--gc-sections", "-o", elf] + objs
    if bare:
        link.insert(1, "-nostdlib")
        link.insert(2, "-nostartfiles")
    else:
        link[1:1] = ["--specs=nano.specs", "--specs=nosys.specs"]
    subprocess.run(link, check=True, capture_output=True)
    return size_of(size_tool, elf)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=DEFAULT_PROJECT)
    ap.add_argument("--clang", default=None, help="path to clang.exe (optional)")
    args = ap.parse_args()
    root = os.path.abspath(args.project)
    gcc = tool("arm-none-eabi-gcc")
    size_tool = tool("arm-none-eabi-size")
    sysinc = os.path.join(os.path.dirname(os.path.dirname(gcc)), "arm-none-eabi", "include")

    work = tempfile.mkdtemp(prefix="segger-bench-")
    rows = []
    try:
        variants = [
            ("GCC -O2 + newlib-nano", "gcc", "-O2", False),
            ("GCC -Os + newlib-nano", "gcc", "-Os", False),
            ("GCC -O2 -flto + newlib-nano", "gcc", "-O2 -flto", False),
            ("GCC -Os -flto + newlib-nano", "gcc", "-Os -flto", False),
            ("GCC -Os -flto, no libc", "gcc", "-Os -flto", True),
        ]
        if args.clang:
            os.environ["PATH"] = os.path.dirname(args.clang) + os.pathsep + os.environ["PATH"]
            variants += [
                ("Clang -Oz + newlib-nano", "clang", "-Oz", False),
                ("Clang -Oz, no libc", "clang", "-Oz", True),
            ]
        for label, cc, flags, bare in variants:
            text, data, flash = build(work, root, label.replace(" ", "_"), cc, flags.split(),
                                      gcc, size_tool, bare, sysinc)
            rows.append((label, text, data, flash))
            print(f"{label:34} text={text:5} data={data:4} flash={flash:5}", flush=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    print("\n| Configuration | text | data | Flash |")
    print("|---|---|---|---|")
    for label, text, data, flash in rows:
        print(f"| {label} | {text} | {data} | {flash} |")


if __name__ == "__main__":
    main()
