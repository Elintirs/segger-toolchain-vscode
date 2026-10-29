# SEGGER Toolchain для VS Code

Расширение, которое собирает проекты STM32 (и другие Cortex-M) **компилятором SEGGER из SEGGER Embedded Studio** через CMake + Ninja — без запуска самой IDE.

```
VS Code  →  CMake  →  Ninja  →  cc.exe -segger  (SEGGER Embedded Studio)
                                      ↓
                                 SEGGER linker + SEGGER RTL
```

## Зачем это

SEGGER Compiler даёт заметно меньший код, чем `arm-none-eabi-gcc` при тех же флагах оптимизации. В примере из этой папки мигалка для STM32F072 занимает:

| Компилятор | Flash |
|---|---|
| SEGGER | 972 B (замер автора проекта) |
| GCC 15.3 (SysGCC) | 1304 B |
| GCC 14.2 (проверено здесь) | 1264 B |

Разница ~23–25 %. При этом компилятор не поставляется отдельно: он лежит внутри SEGGER Embedded Studio.

**Декомпиляция не нужна.** С июля 2025 SEGGER официально поддерживает CMake: [SEGGERMicro/segger-toolchain-cmake](https://github.com/SEGGERMicro/segger-toolchain-cmake). Достаточно вызвать `bin/cc.exe -segger` и подключить их toolchain-файл. Расширение автоматизирует всё вокруг этого: поиск IDE, скачивание пакета, конвертацию GCC-проекта, пресеты, сборку, сравнение размеров и прошивку.

## Что умеет

- **Находит SEGGER Embedded Studio** в стандартных местах (`C:\Program Files\SEGGER`, `%LOCALAPPDATA%\SEGGER`, …), в `PATH` или по пути из настроек.
- **Скачивает официальный CMake-пакет** SEGGER с GitHub (закреплённый коммит) и кладёт его в проект — проект остаётся переносимым.
- **Конвертирует GCC-проект**: startup-файл, таблица прерываний, linker script, флаги линковщика, `CMakeUserPresets.json`.
- **Не ломает GCC-сборку**: изменения обёрнуты в `if(CMAKE_TOOLCHAIN_FILE MATCHES "segger-toolchain")`, исходные строки сохранены в ветке `else()`.
- **Собирает** через `cmake --preset` / `cmake --build --preset`.
- **Сравнивает размер прошивки** SEGGER и GCC в отдельной панели.
- **Прошивает через J-Link** (`JLink.exe -CommanderScript`).
- Показывает размер прошивки в статус-баре.

## Требования

| Компонент | Версия | Примечание |
|---|---|---|
| SEGGER Embedded Studio | 8.24+ (рекомендуется) | Старые версии тоже работают, если есть `bin/cc.exe` и `gcc/arm-segger/bin` |
| CMake | 3.22+ | `cmake` в `PATH` |
| Ninja | любая | `ninja` в `PATH` |
| VS Code | 1.85+ | |
| J-Link Software | опционально | только для прошивки |

Расширение **не содержит** бинарников SEGGER и не обходит лицензию: компилятор берётся из вашей установки Embedded Studio.

## Установка

```powershell
cd C:\Users\elimi\Documents\segger-vscode
npm install
npm run compile
npx @vscode/vsce package
code --install-extension segger-toolchain-0.1.0.vsix
```

Для разработки: откройте папку в VS Code и нажмите `F5` (Extension Development Host).

## Быстрый старт

1. Откройте папку проекта (`examples/STM32F072` — готовый пример).
2. `Ctrl+Shift+P` → **SEGGER: Setup SEGGER toolchain for this project**.
3. Выберите установку Embedded Studio, если их несколько.
4. `Ctrl+Shift+P` → **SEGGER: Build (SEGGER)**.
5. **SEGGER: Compare firmware size (SEGGER vs GCC)** — таблица с разницей.
6. **SEGGER: Flash with J-Link** — прошивка.

## Что именно меняется в проекте

Команда Setup создаёт:

```
<project>/
├── cmake/segger/                 # официальный SEGGER CMake-пакет (скопирован)
├── cmake_modules/Platform/       # флаги -mcpu для SEGGERClang
├── segger/
│   ├── SEGGER_Startup.S          # startup + векторы прерываний устройства
│   └── SEGGER_Flash.icf          # linker script для SEGGER Linker
├── CMakeUserPresets.json         # пресет segger-debug
├── .vscode/settings.json         # CMake Tools: использовать пресеты
└── .segger/backup/               # резервная копия CMakeLists.txt
```

В `CMakeLists.txt` добавляются блоки с маркерами:

```cmake
# >>> SEGGER TOOLCHAIN (managed:header) >>>
if(CMAKE_TOOLCHAIN_FILE MATCHES "segger-toolchain")
    set(CMAKE_SYSTEM_PROCESSOR arm-cortex-m0)
    list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake_modules")
endif()
# <<< SEGGER TOOLCHAIN (managed:header) <<<
```

и аналогично для `STARTUP_FILE`, `LINKER_SCRIPT`, `target_link_options`. Повторный запуск Setup не плодит дубликаты — блоки заменяются.

### Startup и прерывания

Generic startup от SEGGER содержит только ядровые исключения. Расширение берёт таблицу векторов из CMSIS `startup_<device>.s`, которую уже использует GCC-проект, и генерирует из неё `ISR_HANDLER ...` строки для всех внешних прерываний устройства (для STM32F072 — 32 IRQ, включая `RTC_IRQHandler`). Поэтому обработчики вроде `RTC_IRQHandler` в `main.c` продолжают работать.

### Память и линковка

Регионы FLASH/RAM читаются из существующего GNU `.ld` файла (`MEMORY { ... }`) и передаются SEGGER линковщику:

```
-Wl,--add-region:FLASH1=0x20000@0x08000000
-Wl,--add-region:RAM1=0x4000@0x20000000
```

Размеры стека/кучи настраиваются: `segger.stackSize`, `segger.heapSize`.

## Настройки

| Настройка | По умолчанию | Описание |
|---|---|---|
| `segger.studioPath` | авто | путь к установке SES |
| `segger.cmakePackagePath` | авто | локальная копия `segger-toolchain-cmake` (офлайн) |
| `segger.cpu` | авто из `-mcpu` | например `cortex-m0` |
| `segger.deviceName` | `STM32F072CB` | имя устройства для J-Link |
| `segger.presetName` | `segger-debug` | имя пресета |
| `segger.gccPreset` | авто | пресет GCC для сравнения |
| `segger.jlinkPath` | авто | путь к `JLink.exe` |
| `segger.stackSize` | `1024` | стек, байт |
| `segger.heapSize` | `0` | куча, байт |
| `segger.flashInterface` | `SWD` | SWD/JTAG |
| `segger.flashSpeed` | `4000` | кГц |

## Ограничения и честные предупреждения

- **Конвертер рассчитан на типовой шаблон** STM32CubeMX/ручной CMake-проект: `set(STARTUP_FILE ...)`, `set(LINKER_SCRIPT ...)`, `target_link_options(<target> PRIVATE ...)`. Если структура другая, Setup выдаст ошибку и **ничего не запишет** (сначала всё проверяется, потом пишется). Резервная копия `CMakeLists.txt` создаётся всегда.
- **SEGGER RTL, а не newlib.** Файл `syscalls.c` с `_write/_close/...` в этом примере не участвует в сборке (он только проверяется на существование), поэтому конфликта нет. В других проектах newlib-заглушки могут быть не нужны — их можно исключить из таргета.
- **Отладка** не входит в расширение: для неё используйте [cortex-debug](https://marketplace.visualstudio.com/items?itemName=marus25.cortex-debug) + J-Link, как описано в [KB SEGGER](https://kb.segger.com/How_to_use_the_SEGGER_Toolchain_with_CMake).
- **Первый запуск требует интернета** (скачивается пакет SEGGER с GitHub). Дальше — офлайн. Можно указать локальный клон в `segger.cmakePackagePath`.
- **Прокси.** Загрузка идёт через Node `https`, настройка `http.proxy` VS Code не применяется автоматически.
- **Лицензия SES.** Условия использования Embedded Studio определяет SEGGER; расширение лишь вызывает уже установленный компилятор.

## Как это проверялось

- `npm run compile` — сборка без ошибок.
- `npm test` — 13 самопроверок: активация расширения, парсинг `.ld`, определение `-mcpu`, извлечение 32 IRQ из CMSIS, генерация startup, поиск фейковой установки SES, скачивание официального пакета, полная конвертация примера, сохранение GCC-ветки, валидность пресетов, идемпотентность.
- **GCC-сборка примера выполнена реально**: CMake 4.4 + Ninja + Arm GNU 14.2, результат `text 1256 + data 8 = 1264 B`, `firmware.hex` создан. После конвертации GCC-пресет собирается с тем же результатом.
- Сконвертированный startup (`segger/SEGGER_Startup.S`) **собран реальным ассемблером** `arm-none-eabi-gcc -mcpu=cortex-m0 -mthumb`: 0 ошибок, в таблице присутствуют все 32 внешних IRQ, `Reset_Handler`, `_start`, `__stack_end__` и `__SEGGER_init_table__` (последние два разрешает линковщик SEGGER).
- Пресет `segger-debug` **реально конфигурируется CMake**: компилятор определяется как `SEGGERClang`, подхватывается официальный toolchain-файл, и конфигурация доходит до поиска binutils в установке SES. Дальше нужна сама SES — на машине разработчика расширения её нет.
- Размер прошивки читается либо `size`, либо встроенным парсером ELF32 (на случай, если `size.exe` нет в поставке SES). Проверено на реальном ELF: результат совпал с `arm-none-eabi-size` до байта.
- Итоговая линковка SEGGER-линковщиком и проверка «972 B» требуют установленной SEGGER Embedded Studio; это единственный шаг, который не автоматизирован в CI.

## Структура репозитория

```
src/
  extension.ts      команды, статус-бар, панель сравнения
  ses.ts            поиск установки Embedded Studio
  toolchainPkg.ts   загрузка официального SEGGER CMake-пакета
  project.ts        конвертация GCC-проекта
  devices.ts        .ld, IRQ, startup, Platform-модули
  presets.ts        CMakeUserPresets.json
  build.ts          cmake/ninja
  size.ts           размер прошивки
  flash.ts          J-Link
test/selftest.js    самопроверки
examples/STM32F072  исходный GCC-проект
```
