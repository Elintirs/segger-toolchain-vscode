# Changelog

## 0.2.0

- Генерация `.vscode/launch.json` для отладки через cortex-debug + J-Link (`SEGGER: Generate J-Link debug configuration`).
- Автоопределение устройства J-Link по имени linker script (`STM32F072CBTX_FLASH.ld` → `STM32F072CB`).
- Запоминание прошлого размера прошивки и показ разницы после сборки.
- Проверка лицензии CLI через `emLicense list` с предупреждением при Setup.
- README: реальные замеры SEGGER/GCC/Clang, проверка линковки через `emBuild`, скрипт `test/bench.py`.

## 0.1.1

- Конвертация стала «всё или ничего»: файлы пишутся только после успешной проверки структуры `CMakeLists.txt`.
- Из `SEGGER_Flash.icf` удаляется NXP-специфичный блок `place at 0x400` (для STM32 он не нужен).
- README: раздел «Если что-то пошло не так».

## 0.1.0

Первая рабочая версия.

- Поиск установки SEGGER Embedded Studio (включая версии старше 8.24).
- Загрузка официального пакета `SEGGERMicro/segger-toolchain-cmake` (закреплённый коммит).
- Конвертация GCC-проекта: startup с таблицей прерываний из CMSIS, ICF из `.ld`, Platform-модули, `CMakeUserPresets.json`.
- GCC-ветка в `CMakeLists.txt` сохраняется, сборка GCC продолжает работать.
- Сборка через `cmake --preset` + Ninja.
- Сравнение размера прошивки SEGGER и GCC (собственный парсер ELF32 как fallback).
- Прошивка через J-Link.
- Статус-бар с размером прошивки.
