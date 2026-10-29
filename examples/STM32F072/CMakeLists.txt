cmake_minimum_required(VERSION 3.20)

project(STM32F072_Test LANGUAGES C ASM)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

if(NOT DEFINED CMSIS_CORE_PATH)
    message(FATAL_ERROR "Set CMSIS_CORE_PATH to CMSIS/Core/Include")
endif()

if(NOT DEFINED STM32_DEVICE_PATH)
    message(FATAL_ERROR "Set STM32_DEVICE_PATH to the cmsis-device-f0 directory")
endif()

set(STARTUP_FILE
    "${STM32_DEVICE_PATH}/Source/Templates/gcc/startup_stm32f072xb.s"
)

set(SYSTEM_FILE
    "${STM32_DEVICE_PATH}/Source/Templates/system_stm32f0xx.c"
)

set(LINKER_SCRIPT
    "${CMAKE_SOURCE_DIR}/linker/STM32F072CBTX_FLASH.ld"
)

foreach(FILE_PATH
    "${STARTUP_FILE}"
    "${SYSTEM_FILE}"
    "${LINKER_SCRIPT}"
    "${CMAKE_SOURCE_DIR}/syscalls.c"
)
    if(NOT EXISTS "${FILE_PATH}")
        message(FATAL_ERROR "Required file not found: ${FILE_PATH}")
    endif()
endforeach()

find_program(ARM_OBJCOPY arm-none-eabi-objcopy REQUIRED)
find_program(ARM_SIZE arm-none-eabi-size REQUIRED)

# Автоматический поиск всех C-файлов в source и вложенных папках
file(GLOB_RECURSE PROJECT_SOURCES CONFIGURE_DEPENDS
    "${CMAKE_SOURCE_DIR}/source/*.c"
)

add_executable(firmware
    ${PROJECT_SOURCES}
    "${SYSTEM_FILE}"
    "${STARTUP_FILE}"
)

set_target_properties(firmware PROPERTIES
    SUFFIX ".elf"
    LINK_DEPENDS "${LINKER_SCRIPT}"
)

target_include_directories(firmware PRIVATE
    "${CMAKE_SOURCE_DIR}/source"
    "${CMSIS_CORE_PATH}"
    "${STM32_DEVICE_PATH}/Include"
)

target_compile_definitions(firmware PRIVATE
    STM32F072xB
)

target_compile_options(firmware PRIVATE
    -mcpu=cortex-m0
    -mthumb
    -mlittle-endian

    -O2
    -g2
    -gdwarf-4

    -ffunction-sections
    -fdata-sections

    $<$<COMPILE_LANGUAGE:C>:-Wall>
    $<$<COMPILE_LANGUAGE:C>:-Wextra>
)

target_link_options(firmware PRIVATE
    -mcpu=cortex-m0
    -mthumb
    "-T${LINKER_SCRIPT}"
    "-Wl,-Map=${CMAKE_BINARY_DIR}/firmware.map"
    -Wl,--gc-sections
    --specs=nano.specs
    --specs=nosys.specs
)



add_custom_command(TARGET firmware POST_BUILD
    COMMAND "${ARM_OBJCOPY}"
            -O ihex
            "$<TARGET_FILE:firmware>"
            "${CMAKE_BINARY_DIR}/firmware.hex"
    COMMAND "${ARM_SIZE}" "$<TARGET_FILE:firmware>"
    COMMENT "Generating firmware.hex"
    VERBATIM
)