#!/usr/bin/env node
// =============================================================================
// fcc-run.mjs - run a compiled C program on the simulator
// =============================================================================
//
//   node tools/fcc-run.mjs prog.bin [--max N] [--stats]
//
// prog.bin is the flat image tools/fcc writes: ld/fructus-sim.ld linked at 0,
// objcopied to binary.  The program starts at 0 and runs until `halt'.
//
// THE EXIT STATUS IS r0 AT THE HALT, which is what crt/crt0.s arranges: main's
// return value falls into exit, exit is a halt, and abort halts with 134.  A
// program that never halts exits 125 with the pc it was at.
//
// A byte stored to 0xff00 (`__console' in the linker script) is printed.
// That is the whole of the I/O model; nothing in tools/sim.js knows about it,
// it is this runner intercepting the store.
// =============================================================================

import { readFileSync } from 'node:fs';
import { loadSpec } from './isa.js';
import { Machine } from './sim.js';

const CONSOLE = 0xff00;

const args = process.argv.slice(2);
let file = null, max = 5e7, stats = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max') max = Number(args[++i]);
  else if (args[i] === '--stats') stats = true;
  else file = args[i];
}
if (!file) {
  console.error('usage: node tools/fcc-run.mjs prog.bin [--max N] [--stats]');
  process.exit(2);
}

const m = new Machine(loadSpec());
m.load(readFileSync(file));
m.pc = 0;
m.R[m.named.sp] = CONSOLE;

const wr8 = m.wr8.bind(m);
m.wr8 = (a, v) => {
  if ((a & 0xffff) === CONSOLE) { m.bus += 1; process.stdout.write(String.fromCharCode(v & 0xff)); }
  else wr8(a, v);
};

const why = m.run({ max });
if (stats)
  console.error(`${m.count} instructions, ${m.cycles()} cycles, r0 = ${m.R[0]}`);
if (why !== 'halted') {
  console.error(`fcc-run: ${why} after ${m.count} instructions, pc 0x${m.pc.toString(16)}`);
  process.exit(125);
}
process.exit(m.R[0] & 0xff);
