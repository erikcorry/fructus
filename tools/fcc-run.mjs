#!/usr/bin/env node
// =============================================================================
// fcc-run.mjs - run a compiled C program on the simulator
// =============================================================================
//
//   node tools/fcc-run.mjs prog.bin [--max N] [--stats] [--input FILE [--paced]] [--frames DIR] [--x11 [--scale N]]
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
// it they are the memory beneath.  Sending takes no time.
//
// --paced SENDS THE INPUT AT THE LINE'S RATE instead: a byte every ten bits,
// a bit being the divisor at 0x0428 plus one cycles, 217 + 1 if the program
// never set it - 2,180 cycles at 115200 baud.  The line starts when the
// program first looks at the receiver, by its status or by enabling its
// interrupt.  As in rtl/uart.sv, one byte is held: one arriving while it
// waits is lost and sets `overrun', and fcc-run says how many were.
//
// THE RECEIVE INTERRUPT is modelled, status bit 4: the line, tools/sim.js's
// irq, is high while it is enabled and a byte waits.  The transmitter's,
// bit 5, is not.  Without --paced a byte waits whenever input is left, so a
// handler is entered again and again until it is all taken.
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
let file = null, max = 5e7, stats = false, frames = null, x11 = false, scale = 1, input = null, paced = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max') max = Number(args[++i]);
  else if (args[i] === '--stats') stats = true;
  else if (args[i] === '--input') input = readFileSync(args[++i]);
  else if (args[i] === '--paced') paced = true;
  else if (args[i] === '--frames') frames = args[++i];
  else if (args[i] === '--x11') x11 = true;
  else if (args[i] === '--scale') scale = Number(args[++i]);
  else file = args[i];
}
if (!file) {
  console.error('usage: node tools/fcc-run.mjs prog.bin [--max N] [--stats] [--input FILE [--paced]] [--frames DIR] [--x11 [--scale N]]');
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
// The UART's receiving side: `held' is the byte waiting, -1 for none, and
// a load of the data register's even byte takes it.  The status's bits 4
// and 5, the interrupts' enables, are memory's, written through as the
// hardware's are.
const STATUS = spec.cpu.io.uart_status, DIVISOR = spec.cpu.io.uart_divisor;
const peek = m.peek.bind(m);
const word = (a) => (m.little ? peek(a) | peek(a + 1) << 8 : peek(a) << 8 | peek(a + 1));
let next = 0, held = -1, overrun = false, lost = 0, due = -1;
function arrive() {
  if (!input) return;
  if (!paced) {
    if (held < 0 && next < input.length) held = input[next++];
    return;
  }
  if (due < 0) due = m.cyc;
  while (next < input.length && m.cyc >= due) {
    if (held >= 0) { overrun = true; lost++; }
    else held = input[next];
    next++;
    due += 10 * ((word(DIVISOR) || 217) + 1);
  }
}
m.peek = (a) => {
  a &= 0xffff;
  if (!gpu.late()) return peek(a);
  if (a === STATUS) {
    arrive();
    return (peek(a) & 0x30) | (held >= 0 ? 2 : 0) | (overrun ? 4 : 0);
  }
  if (a === STATUS + 1) return 0;
  if (a === CONSOLE) {
    arrive();
    const v = Math.max(held, 0);
    held = -1;
    overrun = false;
    return v;
  }
  if (a === CONSOLE + 1) return 0;
  return peek(a);
};
m.irq = () => {
  if (!(peek(STATUS) & 0x10)) return false;
  arrive();
  return held >= 0;
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
if (input && (stats || lost))
  console.error(`fcc-run: ${next} of ${input.length} bytes of input sent, ${lost} lost to overrun`);
if (why !== 'halted') {
  console.error(`fcc-run: ${why} after ${m.count} instructions, pc 0x${m.pc.toString(16)}`);
  process.exit(125);
}
process.exit(m.R[0] & 0xff);
