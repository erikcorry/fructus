#!/usr/bin/env node
// =============================================================================
// microtan.js - a Microtan 65 shaped machine around the fructus core
// =============================================================================
//
// The Microtan 65 was a 1979 single-board 6502 with a 1K monitor in ROM, a
// memory-mapped character display, and a keyboard that arrived as an interrupt.
// This is that machine's SHAPE, running fructus instead of a 6502:
//
//     0x0001           the keyboard port.  One byte.
//     0x0200 - 0x03ff  the screen.  32 x 16 characters, one byte each,
//                      row major, written directly by the CPU.
//     0xfc00 - 0xffff  ROM, 1K, read only.
//     0xfffd           where the CPU starts.
//
// THE RESET ADDRESS IS THREE BYTES FROM THE TOP, AND THAT IS THE POINT.  On the
// 6502, 0xfffc is a vector the hardware reads.  Here execution simply begins at
// 0xfffd - and `jmp target` is a three-byte instruction, so 0xfffd, 0xfffe and
// 0xffff hold exactly one jump and nothing is wasted.  The vector and the code
// that uses it are the same three bytes.
//
// THE KEYBOARD HANDSHAKE.  A key press is queued, and delivered to 0x0001 only
// when that byte reads zero.  The monitor zeroes it after picking a character
// up, which is what frees the port for the next one.  Delivering regardless
// would be closer to a real interrupt and would drop keys whenever the poll
// loop was slower than the typist; this way nothing is lost and the protocol is
// the one the software expects.
//
// Usage:
//     node tools/microtan.js rom.bin                 interactive
//     node tools/microtan.js rom.bin --keys "hi"     headless, then dump
// =============================================================================

import { readFileSync } from 'node:fs';
import { loadSpec } from './isa.js';
import { Machine } from './sim.js';
import { render as disasm } from './decode.js';

export const MICROTAN = {
  name:   'Microtan 65',
  key:    0x0001,
  screen: { base: 0x0200, cols: 32, rows: 16 },
  rom:    { base: 0xfc00, size: 0x0400 },
  reset:  0xfffd,
};

export class Microtan extends Machine {
  constructor(spec, layout = MICROTAN) {
    super(spec);
    this.L = layout;
    this.keys = [];
    this.romLo = layout.rom.base;
    this.romHi = layout.rom.base + layout.rom.size - 1;
    this.romWrites = 0;
    this.keyPoll = 32;          // instructions between interrupt opportunities
    this.pc = layout.reset;
  }

  // ROM is read only.  A store into it is silently dropped, as it would be on
  // a board where nothing is listening - but it is counted, because a monitor
  // that writes to its own ROM has a bug and the count is the only evidence.
  inRom(a) { a &= 0xffff; return a >= this.romLo && a <= this.romHi; }
  wr8(a, v)  { if (this.inRom(a)) { this.romWrites++; return; } super.wr8(a, v); }
  wr16(a, v) {
    if (this.inRom(a) || this.inRom(a + 1)) { this.romWrites++; return; }
    super.wr16(a, v);
  }

  loadRom(bytes) {
    if (bytes.length > this.L.rom.size)
      throw new Error(`ROM is ${bytes.length} bytes, the socket holds ${this.L.rom.size}`);
    this.mem.set(bytes, this.L.rom.base);
    return this;
  }

  type(s) { for (const ch of Buffer.from(s, 'latin1')) this.keys.push(ch); return this; }

  // The interrupt.  Offered every `keyPoll` instructions from inside the run
  // loop, NOT once per host scheduling quantum - an interrupt that only arrives
  // when the simulator happens to yield would deliver one key per frame however
  // fast the machine polls, which is a property of the host and not the board.
  deliverKey() {
    if (this.keys.length && this.mem[this.L.key] === 0) this.mem[this.L.key] = this.keys.shift();
  }

  // The screen as text.  0x00 is blank rather than a control picture, so a
  // cleared screen looks cleared; anything unprintable shows as a dot so that
  // writing rubbish to the display is visible rather than invisible.
  screen() {
    const { base, cols, rows } = this.L.screen;
    const out = [];
    for (let y = 0; y < rows; y++) {
      let line = '';
      for (let x = 0; x < cols; x++) {
        const c = this.mem[base + y * cols + x];
        line += c === 0 ? ' ' : (c >= 0x20 && c <= 0x7e) ? String.fromCharCode(c) : '.';
      }
      out.push(line);
    }
    return out;
  }

  framed() {
    const w = this.L.screen.cols;
    return [`┌${'─'.repeat(w)}┐`,
            ...this.screen().map((l) => `│${l}│`),
            `└${'─'.repeat(w)}┘`];
  }

  // Run a batch, stopping early on halt or on a bad instruction.  Returns the
  // reason, so the caller can decide whether that is an error or the program
  // simply finishing.
  batch(n, trace = null) {
    for (let i = 0; i < n; i++) {
      if ((i % this.keyPoll) === 0) this.deliverKey();
      if (this.halted) return 'halted';
      try { this.step(trace); }
      catch (e) { this.fault = e.message; return 'fault'; }
    }
    return 'running';
  }
}

// =============================================================================
// CLI
// =============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = { rom: null, keys: null, max: 20e6, ips: 200000, trace: false, at: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if      (a === '--keys')  opt.keys  = args[++i];
    else if (a === '--max')   opt.max   = Number(args[++i]);
    else if (a === '--ips')   opt.ips   = Number(args[++i]);
    else if (a === '--at')    opt.at    = Number(args[++i]);
    else if (a === '--trace') opt.trace = true;
    else opt.rom = a;
  }
  if (!opt.rom) {
    console.error('usage: microtan.js <rom.bin> [--keys "..."] [--max N] [--ips N] [--trace]');
    process.exit(2);
  }

  const spec = loadSpec();
  const m = new Microtan(spec);
  const rom = readFileSync(opt.rom);
  if (opt.at !== null) m.load(rom, opt.at); else m.loadRom(rom);

  const trace = opt.trace
    ? (at, d) => process.stderr.write(`${at.toString(16).padStart(4, '0')}  ${disasm(spec, d)}\n`)
    : null;

  const report = (why) => {
    console.log(m.framed().join('\n'));
    console.log(`${why} after ${m.count} instructions, pc=0x${m.pc.toString(16).padStart(4, '0')}` +
                (m.fault ? `\n  fault: ${m.fault}` : '') +
                (m.romWrites ? `\n  ${m.romWrites} writes into ROM were dropped` : ''));
  };

  // --- headless: type everything up front, run, dump the screen --------------
  if (opt.keys !== null || !process.stdin.isTTY) {
    if (opt.keys) m.type(opt.keys);
    let why = 'ran out';
    while (m.count < opt.max) {
      const r = m.batch(Math.min(opt.ips, opt.max - m.count), trace);
      if (r !== 'running') { why = r; break; }
    }
    report(why);
    process.exit(m.fault ? 1 : 0);
  }

  // --- interactive ----------------------------------------------------------
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const restore = () => { try { process.stdin.setRawMode(false); } catch {} process.stdout.write('\x1b[?25h\n'); };

  process.stdin.on('data', (b) => {
    for (const ch of b) {
      if (ch === 3) { restore(); report('interrupted'); process.exit(0); }   // ctrl-C
      m.keys.push(ch);
    }
  });

  process.stdout.write('\x1b[2J\x1b[?25l');
  let last = '';
  const draw = () => {
    const s = m.framed().join('\n');
    if (s === last) return;
    last = s;
    process.stdout.write(`\x1b[H${s}\n  ${MICROTAN.name} - ctrl-C to stop`);
  };

  const tick = () => {
    const why = m.batch(opt.ips, trace);
    draw();
    if (why !== 'running') { restore(); report(why); process.exit(m.fault ? 1 : 0); }
    setTimeout(tick, 16);
  };
  tick();
}
