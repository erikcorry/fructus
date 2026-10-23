#!/usr/bin/env node
// =============================================================================
// fcc-run.mjs - run a compiled C program on the simulator
// =============================================================================
//
//   node tools/fcc-run.mjs prog.bin [--max N] [--stats] [--input FILE] [--frames DIR] [--x11 [--scale N]]
//
// prog.bin is the flat image tools/fcc writes: ld/fructus-sim.ld linked at 0,
// objcopied to binary.  The program starts at 0, where crt/crt0.s has put a
// jump over the zero page to _start, and runs until `halt'.
//
// THE EXIT STATUS IS r0 AT THE HALT, which is what crt/crt0.s arranges: main's
// return value falls into exit, exit is a halt, and abort halts with 134.  A
// program that never halts exits 125 with the pc it was at, and one that
// touches a guard of the I/O page 124, naming the instruction after it.
//
// THE MACHINE HAS THE I/O PAGE, [cpu.io] in isa/fructus.toml: its guards
// trap to [cpu.vectors] io_guard, and the shadows have a word each.  A byte
// stored to its console, 0x0420 (`__console' in the linker script), is
// printed: that is this runner intercepting the store, not tools/sim.js.
//
// THAT IS THE UART'S DATA REGISTER, [cpu.io] in isa/fructus.toml and
// rtl/uart.sv, and the rest of the UART is here too, as far as a program
// polling it can tell: its status at 0x0422 is never busy, and says a byte
// was received while --input FILE has bytes left; a load of 0x0420 takes the
// next.  Both only in the late bit's window, as tools/gpu.js says; outside
// it they are the memory beneath.  Sending takes no time, and the receive interrupt is not modelled,
// as the interrupt pin is not.
//
// The cycle counter at 0x0424 (`__cycles') is the I/O page's own, in
// tools/sim.js and rtl/cpu.sv alike; crt/include/fructus/cycles.h reads it.
//
// AND THE DISPLAY, tools/gpu.js: the frame buffers and the GPU's registers at
// 0x0480, as tools/fpga-system.sv has them.  A frame is drawn whenever the
// shown buffer changes or COPY starts, and once more at the end if the last
// one differs.  --frames DIR writes each as DIR/frame-0001.png and so on;
// --x11 shows them in a window at $DISPLAY, --scale N times the size, and
// after the program stops keeps it open until it is closed or a key is
// pressed in it.  Without either, the frames are drawn and dropped.
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadSpec } from './isa.js';
import { Machine } from './sim.js';
import { Gpu } from './gpu.js';
import { png } from './png.js';
import { openWindow } from './x11.js';

const args = process.argv.slice(2);
let file = null, max = 5e7, stats = false, frames = null, x11 = false, scale = 1, input = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max') max = Number(args[++i]);
  else if (args[i] === '--stats') stats = true;
  else if (args[i] === '--input') input = readFileSync(args[++i]);
  else if (args[i] === '--frames') frames = args[++i];
  else if (args[i] === '--x11') x11 = true;
  else if (args[i] === '--scale') scale = Number(args[++i]);
  else file = args[i];
}
if (!file) {
  console.error('usage: node tools/fcc-run.mjs prog.bin [--max N] [--stats] [--input FILE] [--frames DIR] [--x11 [--scale N]]');
  process.exit(2);
}

const spec = loadSpec();
const CONSOLE = spec.cpu.io.console;
const m = new Machine(spec, { io: true });
m.load(readFileSync(file));
m.pc = 0;
m.R[m.named.sp] = 0;      // crt0 sets it from __stack_top

const wr8 = m.wr8.bind(m);
m.wr8 = (a, v) => {
  if ((a & 0xffff) === CONSOLE) { m.bus += 1; process.stdout.write(String.fromCharCode(v & 0xff)); }
  else wr8(a, v);
};
// The UART's receiving side: `received' while input is left, and a load of
// the data register's even byte takes it.  The status's bits 4 and 5, the
// interrupts' enables, are memory's, written through as the hardware's are.
const STATUS = spec.cpu.io.uart_status;
let taken = 0;
const peek = m.peek.bind(m);
m.peek = (a) => {
  a &= 0xffff;
  if (!gpu.late()) return peek(a);
  if (a === STATUS) return (peek(a) & 0x30) | (input && taken < input.length ? 2 : 0);
  if (a === STATUS + 1) return 0;
  if (a === CONSOLE) return input && taken < input.length ? input[taken++] : 0;
  if (a === CONSOLE + 1) return 0;
  return peek(a);
};

const win = x11 ? await openWindow({ title: file, scale }) : null;
if (frames) mkdirSync(frames, { recursive: true });
const gpu = new Gpu(m, {
  onFrame: (pic) => {
    if (frames) writeFileSync(`${frames}/frame-${String(gpu.frames).padStart(4, '0')}.png`, png(pic));
    if (win) win.show(pic);
  },
});

// A guard trap stops the run where it enters, rather than in whatever the
// image has at the vector, which is usually nothing: zeroes, so brk forever.
// With a window the run goes in slices, so that frames reach it as they are
// drawn rather than all at the end.
let why;
for (;;) {
  why = m.run({ max: win ? Math.min(max, m.count + 200000) : max, stopAt: spec.cpu.vectors.io_guard });
  if (why !== 'ran out' || m.count >= max || !win) break;
  await new Promise((r) => setImmediate(r));
}
gpu.finish();
if (win && !win.isClosed) {
  console.error('fcc-run: the program has stopped; close the window or press a key in it');
  await win.closed;
}
if (why === 'stopped') {
  console.error(`fcc-run: I/O page guard touched just before 0x${m.R[m.named.lr].toString(16)}, `
              + `sp was 0x${m.shadow_sp.toString(16)}`);
  process.exit(124);
}
if (stats)
  console.error(`${m.count} instructions, ${m.cycles()} cycles, r0 = ${m.R[0]}`);
if (why !== 'halted') {
  console.error(`fcc-run: ${why} after ${m.count} instructions, pc 0x${m.pc.toString(16)}`);
  process.exit(125);
}
process.exit(m.R[0] & 0xff);
