// =============================================================================
// spi.js - the SPI port, rtl/spi.sv, on a tools/sim.js machine
// =============================================================================
//
// attachSpi(m, { late, flash }) adds the port's two words, [cpu.io] spi_data
// and spi_ctrl, to a machine with the I/O page: `late' says whether a load
// is in the late bit's window, tools/gpu.js's late(), and `flash' is a
// tools/flash.js Flash behind the flash's select, or null.  Nothing is behind
// the header's two: their bytes read as 0xff.
//
// AS THE HARDWARE HAS IT: a store to spi_data sends its byte unless one is on
// the wire, and keeps what came back; a load of it, in the window, reads
// {busy, 7 zeros, the byte}, and with stream set one that finds the port idle
// sends 0xff.  A write to spi_ctrl ends the byte under way.  Outside the
// window a load is the memory beneath, and every store writes it as well.
//
// BUSY IS TIMED BY THE CYCLE COUNTER as each access would capture it - what
// tools/sim.js's I/O page answers at [cpu.io] cycles, mid-instruction: a
// load whose count is BUSY_FROM to BUSY_TO after the store's finds the byte
// on the wire.  tests/spi-check.mjs holds the two to rtl/spi.sv in
// tools/fpga-system.sv, a load after each store at every distance.  The
// byte itself moves at the store: the flash's answer is the same whenever it
// is read, and a load while busy is the byte before, where the hardware
// would show half of the new one, which no program can use.
// =============================================================================

import { loadSpec } from './isa.js';

export const BUSY_FROM = 1, BUSY_TO = 9;

export function attachSpi(m, { late, flash = null, io = loadSpec().cpu.io } = {}) {
  const DATA = io.spi_data, CTRL = io.spi_ctrl, CYC = io.cycles;
  const peek = m.peek.bind(m), poke = m.poke.bind(m);
  const now = () => peek(CYC) | peek(CYC + 1) << 8;
  let sel = 0, stream = false, rx = 0xff, before = 0xff, start = -1, hi = null;
  const busy = (t) => {
    if (start < 0) return false;
    const d = (t - start) & 0xffff;
    return d >= BUSY_FROM && d <= BUSY_TO;
  };
  const send = (b, t) => {
    before = rx;
    rx = sel & 1 && flash ? flash.xfer(b) : 0xff;
    start = t;
  };
  const port = { bytes: 0, get sel() { return sel; } };

  m.poke = (a, v) => {
    a &= 0xffff;
    if (a === DATA) {
      const t = now();
      if (!busy(t)) { send(v & 0xff, t); port.bytes++; }
    } else if (a === CTRL) {
      const was = sel;
      sel = v & 7;
      stream = (v & 8) !== 0;
      start = -1;
      if (flash && (was & 1) && !(sel & 1)) flash.deselect();
      if (flash && !(was & 1) && (sel & 1)) flash.select();
    }
    poke(a, v);
  };
  m.peek = (a) => {
    a &= 0xffff;
    if ((a & ~1) !== DATA || !late()) return peek(a);
    // A word's two bytes are one load: its high byte is the busy the low
    // byte found, before that load started the next byte.
    if (a === DATA + 1 && hi !== null) { const v = hi; hi = null; return v; }
    const t = now(), b = busy(t), v = b ? before : rx;
    if (!b && stream) { send(0xff, t); port.bytes++; }
    if (a === DATA) { hi = b ? 0x80 : 0; return v; }
    return b ? 0x80 : 0;
  };
  return port;
}
