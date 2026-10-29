# Changelog

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
