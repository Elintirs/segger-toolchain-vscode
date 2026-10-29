
ENTRY(Reset_Handler)

_Min_Heap_Size  = 0;
_Min_Stack_Size = 0x400;

_estack      = ORIGIN(RAM) + LENGTH(RAM);
__stack_end__ = _estack;
_stack_limit = _estack - _Min_Stack_Size;

MEMORY
{
    FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 128K
    RAM   (xrw) : ORIGIN = 0x20000000, LENGTH = 16K
}

PHDRS
{
    flash PT_LOAD FLAGS(5);  /* R + X */
    ram   PT_LOAD FLAGS(6);  /* R + W */
}

SECTIONS
{
    /* Vector table must be at the beginning of Flash. */
    .isr_vector :
    {
        . = ALIGN(256);
        KEEP(*(.isr_vector))
        . = ALIGN(4);
    } > FLASH : flash

    /* Program code and read-only constants. */
    .text :
    {
        . = ALIGN(4);

        *(.text)
        *(.text*)

        *(.rodata)
        *(.rodata*)

        *(.glue_7)
        *(.glue_7t)

        KEEP(*(.init))
        KEEP(*(.fini))

        . = ALIGN(4);
        _etext = .;
    } > FLASH : flash

    .ARM.extab :
    {
        *(.ARM.extab*)
    } > FLASH : flash

    .ARM.exidx :
    {
        __exidx_start = .;
        *(.ARM.exidx*)
        __exidx_end = .;
    } > FLASH : flash

    .preinit_array :
    {
        PROVIDE_HIDDEN(__preinit_array_start = .);
        KEEP(*(.preinit_array*))
        PROVIDE_HIDDEN(__preinit_array_end = .);
    } > FLASH : flash

    .init_array :
    {
        PROVIDE_HIDDEN(__init_array_start = .);
        KEEP(*(SORT(.init_array.*)))
        KEEP(*(.init_array*))
        PROVIDE_HIDDEN(__init_array_end = .);
    } > FLASH : flash

    .fini_array :
    {
        PROVIDE_HIDDEN(__fini_array_start = .);
        KEEP(*(SORT(.fini_array.*)))
        KEEP(*(.fini_array*))
        PROVIDE_HIDDEN(__fini_array_end = .);
    } > FLASH : flash

    /* Initialized variables: stored in Flash, copied to RAM at startup. */
    _sidata = LOADADDR(.data);

    .data :
    {
        . = ALIGN(4);
        _sdata = .;

        *(.data)
        *(.data*)

        . = ALIGN(4);
        _edata = .;
    } > RAM AT> FLASH : ram

    /* Zero-initialized variables. */
    .bss :
    {
        . = ALIGN(4);
        _sbss = .;

        *(.bss)
        *(.bss*)
        *(COMMON)

        . = ALIGN(4);
        _ebss = .;
    } > RAM : ram

    . = ALIGN(8);
    _end = .;
    PROVIDE(end = .);

    /* Catch RAM overflow before it reaches the stack. */
    ASSERT(_end <= _stack_limit, "RAM overflow: .data/.bss overlaps reserved stack")
}
