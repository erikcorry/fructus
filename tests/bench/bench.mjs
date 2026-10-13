#!/usr/bin/env node
// =============================================================================
// bench.mjs - small C kernels, for weighing what the compiler does
// =============================================================================
//
//   node tests/bench/bench.mjs [compiler] [flags...]
//
// Compiles each kernel in tests/bench with the compiler (tools/fcc when none
// is named), runs it on tools/sim.js, and prints its cycles, the cycles
// dispatch waited for the fetcher's bytes, the cycles lost to data words at
// odd addresses - a byte at a time, a cycle more - the bytes of its noinline
// functions - the kernel alone, not main or libc - and its exit status, which
// is a checksum: the same at every optimisation level, or something is wrong.
//
// Five shapes a 16-bit program spends its time in: a bit loop (crc), memory
// shuffling (sort), a byte array (sieve), multiplies (matmul) and a switch
// dispatch and a pointer walk (interp).  They are what the numbers in
// vendor/gcc's fructus.cc and fructus.h were measured on.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { loadSpec } from '../../tools/isa.js';
import { Machine } from '../../tools/sim.js';

process.chdir(new URL('../..', import.meta.url).pathname);
let [cc, ...flags] = process.argv.slice(2);
if (!cc || cc.startsWith('-')) { if (cc) flags.unshift(cc); cc = 'tools/fcc'; }
const KERNELS = { crc: ['crc16'], sort: ['isort'], sieve: ['sieve'],
                  matmul: ['matmul', 'scale'], interp: ['run', 'walk'] };
const spec = loadSpec();
mkdirSync('build', { recursive: true });
let cycles = 0, starve = 0, split = 0, bytes = 0;
for (const [name, fns] of Object.entries(KERNELS)) {
  const out = `build/bench-${name}`;
  execFileSync(cc, [...flags, `tests/bench/${name}.c`, '-o', out]);
  const m = new Machine(spec);
  m.load(readFileSync(out + '.bin'));
  m.pc = 0; m.R[m.named.sp] = 0;   // crt0 sets it
  const why = m.run({ max: 5e7 });
  let b = 0;
  for (const l of execFileSync('fructus-elf-readelf', ['-s', out]).toString().split('\n')) {
    const f = l.trim().split(/\s+/);
    if (f.length >= 8 && fns.includes(f[7])) b += Number(f[2]);
  }
  cycles += m.cycles(); starve += m.starve; split += m.split; bytes += b;
  console.log(`${name.padEnd(7)} ${String(m.cycles()).padStart(8)} cycles ${String(m.starve).padStart(6)} starved ` +
              `${String(m.split).padStart(6)} split ` +
              `${String(b).padStart(5)} bytes  exit ${m.R[0] & 0xff}${why === 'halted' ? '' : ` (${why})`}`);
}
console.log(`total   ${String(cycles).padStart(8)} cycles ${String(starve).padStart(6)} starved ` +
            `${String(split).padStart(6)} split ${String(bytes).padStart(5)} bytes`);
