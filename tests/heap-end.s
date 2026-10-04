; A program's own __heap_end, overriding ld/fructus-sim.ld's default 0x8000:
; 40K for the program at 0x6000 and 75 pages of heap below it.  run.sh links
; it with tests/malloc.c, which checks it gets every one of those pages.

        .globl  __heap_end
        .set    __heap_end, 0x6000
