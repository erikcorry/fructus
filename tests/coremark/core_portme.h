/*
Copyright 2018 Embedded Microprocessor Benchmark Consortium (EEMBC)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

Original Author: Shay Gal-on
Ported to fructus: timed by the cycle counter at 0x0424.
*/
#ifndef CORE_PORTME_H
#define CORE_PORTME_H

#include <stdint.h>
#include <stddef.h>

/* The clock the seconds are reckoned at: 30 MHz, the processor's on the
   iCE40 without the VGA frame buffers (with them it runs at the 25.175 MHz
   pixel clock).  It sets EEMBC's seconds, its ten-second rule and so the
   iterations the calibration picks; CoreMark/MHz is the cycles' alone.  */
#ifndef CLOCK_HZ
#define CLOCK_HZ 30000000UL
#endif

/* 0 is EEMBC's calibration: ten times more until a run takes a second, then
   enough for ten.  */
#ifndef ITERATIONS
#define ITERATIONS 0
#endif

#define HAS_FLOAT 0
#define HAS_TIME_H 0
#define USE_CLOCK 0
#define HAS_STDIO 1
#define HAS_PRINTF 1

typedef uint32_t CORE_TICKS;

#ifndef COMPILER_VERSION
#define COMPILER_VERSION "GCC" __VERSION__
#endif
#ifndef COMPILER_FLAGS
#define COMPILER_FLAGS "see tests/coremark/run.sh"
#endif
#ifndef MEM_LOCATION
#define MEM_LOCATION "STACK"
#endif

/* int is 16 bits here, so the 32-bit types are long.  */
typedef signed short ee_s16;
typedef unsigned short ee_u16;
typedef signed long ee_s32;
typedef double ee_f32;
typedef unsigned char ee_u8;
typedef unsigned long ee_u32;
typedef ee_u16 ee_ptr_int;
typedef size_t ee_size_t;

#define align_mem(x) (void *)(4 + (((ee_ptr_int)(x) - 1) & ~3))

#define SEED_METHOD SEED_VOLATILE
#define MEM_METHOD MEM_STACK

#define MULTITHREAD 1
#define USE_PTHREAD 0
#define USE_FORK 0
#define USE_SOCKET 0

#define MAIN_HAS_NOARGC 1
#define MAIN_HAS_NORETURN 0

extern ee_u32 default_num_contexts;

typedef struct CORE_PORTABLE_S {
	ee_u8	portable_id;
} core_portable;

void portable_init(core_portable *p, int *argc, char *argv[]);
void portable_fini(core_portable *p);

#if !defined(PROFILE_RUN) && !defined(PERFORMANCE_RUN) && !defined(VALIDATION_RUN)
#if (TOTAL_DATA_SIZE==1200)
#define PROFILE_RUN 1
#elif (TOTAL_DATA_SIZE==2000)
#define PERFORMANCE_RUN 1
#else
#define VALIDATION_RUN 1
#endif
#endif

#endif /* CORE_PORTME_H */
