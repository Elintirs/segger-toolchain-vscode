# STM32F072 — пример

Это исходный GCC-проект из архива, приведённый в самодостаточный вид:

- CMSIS убран из абсолютных путей `C:/Users/OGK/...` в `third_party/`;
- `CMakePresets.json` собирает в `build/gcc` и использует `${sourceDir}`;
- удалён мусорный второй preset.

## Сборка GCC (базовая линия)

Нужны `cmake`, `ninja` и `arm-none-eabi-gcc` в `PATH`.

```powershell
cmake --preset stm32f072
cmake --build --preset stm32f072
arm-none-eabi-size build/gcc/firmware.elf
```

Ожидаемый результат для этой прошивки — около **1304 B** flash (`text + data`).

## Сборка SEGGER

1. Откройте эту папку в VS Code.
2. `Ctrl+Shift+P` → **SEGGER: Setup SEGGER toolchain for this project**.
3. `Ctrl+Shift+P` → **SEGGER: Build (SEGGER)**.
4. `Ctrl+Shift+P` → **SEGGER: Compare firmware size (SEGGER vs GCC)**.

Setup создаст `CMakeUserPresets.json` с пресетом `segger-debug`, папку `segger/` и `cmake/segger/`.
GCC-пресет `stm32f072` продолжит работать без изменений.

Ожидаемый результат — около **972 B** flash, то есть примерно на 25 % меньше GCC.

## Что внутри

```
source/            код (main.c, RTC, GPIO, clock)
linker/            GNU ld script (128K flash / 16K RAM)
third_party/       CMSIS Core + cmsis-device-f0 (заголовки, system_stm32f0xx.c, startup)
cmake/             GCC toolchain file
```

Таблица прерываний для SEGGER генерируется расширением из
`third_party/cmsis-device-f0/Source/Templates/gcc/startup_stm32f072xb.s`,
поэтому `RTC_IRQHandler` из `main.c` остаётся подключённым.
