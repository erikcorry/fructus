// =============================================================================
// gpu.js - the display and its frame buffers, for the simulator
// =============================================================================
//
//   const gpu = new Gpu(machine, { onFrame });
//   ... machine.run() ...
//   gpu.finish();
//
// tools/fpga-system.sv's display, as a program sees it: frame buffers A and B,
// the registers at 0x0480 - 0x04ef (docs/vga.md, "Registers"), and the mode's
// routing of the processor's data above 0x8000.  The machine must have the I/O
// page, `new Machine(spec, { io: true })`, since the registers are in it.
//
// NOT CYCLE BY CYCLE.  The display draws a frame all at once, with the
// processor stopped, when the frame shown changes:
//
//   - at the vertical sync after the shown buffer changes, and
//   - at the vertical sync that starts COPY, which also copies into B every
//     word of A the frame read - all a copy ever moves, docs/vga.md "Why one
//     frame's reads are enough" - and again at each sync while COPY is held;
//   - and at a vertical sync after a write to the palette, the sprites or the
//     font register, so that moving a sprite or cycling colours shows.
//
// and calls onFrame({ width, height, rgb, cycle, buffer }) with it, `buffer`
// 'A' or 'B'.  Between those, a
// store into the shown buffer is not seen until the next one - or finish(),
// which draws the last frame if it differs from the one before.  A sync is
// noticed when the program next touches the display - its registers, or its
// buffers in BLIT or WRITETHRU - which is where a program waiting for one
// reads the status register.
//
// BUT THE TIMING A PROGRAM CAN SEE IS THE HARDWARE'S.  The processor runs on
// the pixel clock, so its cycle count, tools/sim.js's cost model, is the
// display's: the status register's line and vertical blank come from it, and
// as on the hardware the shown buffer and COPY change only in vertical sync.
// Until then a write to the buffer that is shown or being copied into is
// dropped, so a program that forgets to wait for the sync loses its stores
// here as it would on the board.  The frame starts at cycle 0 with the
// vertical front porch, as rtl/video/timing.sv comes up; a write to a timing
// register starts a new frame there and then.
//
// NOT MODELLED: blit mode's trap on a push or pop above 0x8000, and the
// interrupt line.  Instruction fetch never sees the frame buffers, as on the
// hardware: tools/sim.js fetches from the machine's memory, not through peek.
// =============================================================================

import { frame, decodeSprites } from './display.js';

const IO = 0x0400;

export class Gpu {
  constructor(m, { onFrame = () => {} } = {}) {
    this.m = m;
    this.onFrame = onFrame;
    this.fb = [new Uint8Array(0x8000), new Uint8Array(0x8000)];     // A, B
    // The mode as written - `wantA`, `copy`, `blit`, `fbSt`, as the flops in
    // tools/fpga-system.sv - and the two halves that follow it in vertical
    // sync: `onA`, the display reads A, and `copyOn`.
    this.wantA = this.copy = this.blit = this.fbSt = false;
    this.onA = this.copyOn = false;
    this.font = 0x6000;
    this.palette = new Uint8Array(32);
    this.patterns = new Uint16Array(1024);
    this.attrs = new Uint16Array(64);
    this.palI = this.patI = this.attrI = 0;
    this.hLen = [16, 96, 48, 640];     // front porch, sync, back porch, visible
    this.vLen = [10, 2, 33, 480];
    this.origin = 0;                   // the cycle the current timing's frame 0 began
    this.seen = -1;                    // the last vertical sync handled, by frame number
    this.used = false;                 // a register has been written
    this.dirty = false;                // the palette, a sprite or the font has changed
    this.last = null;                  // the last frame passed to onFrame
    this.frames = 0;

    const peek = m.peek.bind(m), poke = m.poke.bind(m);
    const wr8 = m.wr8.bind(m), wr16 = m.wr16.bind(m);
    m.peek = (a) => {
      a &= 0xffff;
      if (a >= 0x8000 && this.blit) { this.sync(); return this.fb[this.wantA ? 1 : 0][a & 0x7fff]; }
      if ((a & ~0xff) === IO) { const r = this.readReg(a & 0xfe); if (r !== null) return (r >> ((a & 1) * 8)) & 0xff; }
      return peek(a);
    };
    m.poke = (a, v) => {
      a &= 0xffff;
      if (a >= 0x8000 && this.fbSt) return this.store(a, v);
      return poke(a, v);
    };
    // A register takes an aligned st, or an st8 to its even address, which
    // the processor puts in both byte lanes; a write to the odd byte alone is
    // dropped.  The page is written through into memory, as on the hardware,
    // which is where a register reads back from.
    m.wr8 = (a, v) => {
      wr8(a, v);
      a &= 0xffff;
      if ((a & ~0xff) === IO && !(a & 1)) this.writeReg(a & 0xff, (v & 0xff) * 0x101);
    };
    m.wr16 = (a, v) => {
      wr16(a, v);
      a &= 0xffff;
      if ((a & ~0xff) === IO && !(a & 1)) this.writeReg(a & 0xff, v & 0xffff);
    };
  }

  // --- the processor's side ----------------------------------------------------

  // A store above 0x8000 in BLIT or WRITETHRU: to the buffer the display is not
  // asked to show, unless it is still shown, or is being copied into.
  store(a, v) {
    this.sync();
    const toA = !this.wantA;
    if (this.copyOn || toA === this.onA) return;
    this.fb[toA ? 0 : 1][a & 0x7fff] = v & 0xff;
  }

  // The four words the hardware changes; anything else reads as memory.
  readReg(off) {
    switch (off) {
      case 0x84: this.sync(); return this.status();
      case 0xa0: return this.palI;
      case 0xa4: return this.patI;
      case 0xa8: return this.attrI;
    }
    return null;
  }

  writeReg(off, w) {
    if (off < 0x80 || off > 0xff) return;
    this.sync();
    this.used = true;
    if (off === 0x80) {
      this.wantA = !!(w & 4);
      const k = w & 3;
      this.copy = k === 1 && this.wantA;       // COPY runs only from A to B
      this.blit = k === 2;
      this.fbSt = k >= 2;
      this.sync();                             // in vertical sync it is at once
    } else if (off === 0x82) { this.font = w & 0x7fff; this.dirty = true; }
    else if (off >= 0x90 && off <= 0x9e) {
      (off & 8 ? this.vLen : this.hLen)[(off >> 1) & 3] = Math.max(w & 0x3ff, 1);     // every length is at least 1
      this.origin = this.m.cyc; this.seen = -1;
    }
    else if (off === 0xa0) this.palI = w & 31;
    else if (off === 0xa2) { this.palette[this.palI] = w & 0xff; this.dirty = true; this.palI = (this.palI + 1) & 31; }
    else if (off === 0xa4) this.patI = w & 0x3ff;
    else if (off === 0xa6) { this.patterns[this.patI] = w; this.dirty = true; this.patI = (this.patI + 1) & 0x3ff; }
    else if (off === 0xa8) this.attrI = w & 63;
    else if (off === 0xaa) { this.attrs[this.attrI] = w; this.dirty = true; this.attrI = (this.attrI + 1) & 63; }
  }

  // --- the timing ----------------------------------------------------------------
  get htot() { return this.hLen.reduce((a, b) => a + b); }
  get vtot() { return this.vLen.reduce((a, b) => a + b); }

  // Where `now` is: the frame's number, and the line within it, from the
  // front porch.
  where(now = this.m.cyc) {
    const t = now - this.origin, htot = this.htot, P = htot * this.vtot;
    return { f: Math.floor(t / P), L: Math.floor((t % P) / htot) };
  }

  // 0x0484: bit 15 vertical blank, bits 9:0 the line, from the first visible
  // one; 0 in the blanking.
  status() {
    const { L } = this.where(), top = this.vLen[0] + this.vLen[1] + this.vLen[2];
    return L >= top ? (L - top) & 0x3ff : 0x8000;
  }

  // Catch up with the vertical syncs that have begun since the last access:
  // only the latest matters, since nothing the processor did in between could
  // reach the display.  Within a sync, a change of mode takes at once.
  sync() {
    const { f, L } = this.where(), vs = this.vLen[0];
    const inSync = L >= vs && L < vs + this.vLen[1];
    const latest = L >= vs ? f : f - 1;        // the last sync begun
    if (latest > this.seen) { this.seen = latest; this.vsync(true); }
    else if (inSync) this.vsync(false);
  }

  vsync(fresh) {
    const swap = this.onA !== this.wantA, start = this.copy && !this.copyOn;
    this.onA = this.wantA;
    this.copyOn = this.copy;
    if (this.copyOn && (fresh || start)) {
      const read = new Uint8Array(0x4000), a = this.fb[0], b = this.fb[1];
      const pic = this.render(0, read);
      for (let i = 0; i < 0x4000; i++) if (read[i]) { b[2 * i] = a[2 * i]; b[2 * i + 1] = a[2 * i + 1]; }
      if (start || (fresh && this.dirty)) this.show(pic);
    } else if (swap || (fresh && this.dirty)) this.show(this.render(this.onA ? 0 : 1));
  }

  // --- drawing ---------------------------------------------------------------------

  // Buffer k's frame; `read`, if given, marks every word the display fetched.
  render(k, read = null) {
    const fb = this.fb[k];
    const word = read ? (i) => { read[i] = 1; return fb[2 * i] | fb[2 * i + 1] << 8; }
                      : (i) => fb[2 * i] | fb[2 * i + 1] << 8;
    const sprites = decodeSprites(this.attrs);
    const st = { word, font: this.font, palette: this.palette, patterns: this.patterns,
                 sprites: () => sprites };
    const pic = frame(st, Math.min(this.hLen[3], 1024), Math.min(this.vLen[3], 1024));
    pic.buffer = k ? 'B' : 'A';
    return pic;
  }

  show(pic) {
    pic.cycle = this.m.cyc;
    this.dirty = false;
    this.last = pic;
    this.frames++;
    this.onFrame(pic);
  }

  // The program has stopped: take any pending change as the next vertical
  // sync would, then show the last frame if it is not the one already shown.
  // Nothing at all if the program never wrote a register.
  finish() {
    if (!this.used) return;
    this.vsync(true);
    const pic = this.render(this.onA ? 0 : 1), l = this.last;
    if (!l || l.width !== pic.width || l.height !== pic.height || !l.rgb.every((v, i) => v === pic.rgb[i]))
      this.show(pic);
  }
}
