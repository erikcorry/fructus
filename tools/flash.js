// =============================================================================
// flash.js - a model of the board's SPI flash, a W25Q32JV, a byte at a time
// =============================================================================
//
// For tools/spi.js, the SPI port's model, and through it tools/fcc-run.mjs's
// --flash.  It is the flash as a program sees it a byte at a time: select it,
// exchange bytes, deselect it.  xfer(b) returns the byte the flash sends while
// b goes in, which in mode 0 it decided before b arrived: so it depends only
// on the bytes before.  tests/spi-check.mjs holds an RTL test bench's model,
// a bit at a time on the pins, to the same commands and answers.
//
// THE COMMANDS, with a 24-bit address where they take one:
//
//   0x03 read            the bytes from the address on, wrapping at the end
//   0x0b fast read       the same after a dummy byte
//   0x9f JEDEC ID        0xef 0x40 0x16
//   0xab release         from power-down, which is never entered; after
//                        three dummies its ID, 0x15
//   0x05 status 1        bit 0 busy, never set: every erase and program is
//                        instant; bit 1 write enable
//   0x06 write enable    0x04 write disable
//   0x02 page program    the bytes from the address on, wrapping within its
//                        256-byte page, ANDed into the flash at deselect
//   0x20 0x52 0xd8       erase 4 KB, 32 KB, 64 KB to 0xff
//   0x60 0xc7            erase the whole chip
//
// As the part does, a program or an erase needs write enable first and
// clears it, and one deselected short of its address is ignored.  Every
// other byte reads as 0xff, as the line does with nothing driving it.
// `log' has each command as it ends, for a test to look at.
// =============================================================================

export const FLASH_SIZE = 0x400000;

export class Flash {
  constructor(image = new Uint8Array(0), size = FLASH_SIZE) {
    this.mem = new Uint8Array(size).fill(0xff);
    this.mem.set(image.subarray(0, size));
    this.wel = false;
    this.cs = false;
    this.dirty = false;
    this.log = [];
  }

  select() {
    if (this.cs) return;
    this.cs = true;
    this.k = 0;
    this.cmd = -1;
    this.addr = 0;
    this.page = new Map();
  }

  deselect() {
    if (!this.cs) return;
    this.cs = false;
    const { cmd, k, addr } = this, mem = this.mem, mask = mem.length - 1;
    const erase = { 0x20: 0x1000, 0x52: 0x8000, 0xd8: 0x10000 }[cmd];
    if (cmd === 0x06) this.wel = true;
    else if (cmd === 0x04) this.wel = false;
    else if (erase && k >= 4) {
      if (this.wel) { mem.fill(0xff, addr & mask & ~(erase - 1), (addr & mask & ~(erase - 1)) + erase); this.dirty = true; }
      this.wel = false;
    } else if ((cmd === 0x60 || cmd === 0xc7) && k >= 1) {
      if (this.wel) { mem.fill(0xff); this.dirty = true; }
      this.wel = false;
    } else if (cmd === 0x02 && k >= 4) {
      if (this.wel) {
        const base = addr & mask & ~0xff;
        for (const [off, v] of this.page) mem[base + off] &= v;
        this.dirty = true;
      }
      this.wel = false;
    }
    if (cmd >= 0) this.log.push({ cmd, addr, bytes: k });
  }

  // The byte sent while b comes in.
  xfer(b) {
    if (!this.cs) return 0xff;
    const k = this.k++, { cmd, addr } = this, mem = this.mem, mask = mem.length - 1;
    let out = 0xff;
    if (cmd === 0x03 && k >= 4) out = mem[(addr + k - 4) & mask];
    else if (cmd === 0x0b && k >= 5) out = mem[(addr + k - 5) & mask];
    else if (cmd === 0x9f && k >= 1 && k <= 3) out = [0xef, 0x40, 0x16][k - 1];
    else if (cmd === 0xab && k >= 4) out = 0x15;
    else if (cmd === 0x05 && k >= 1) out = this.wel ? 2 : 0;
    if (k === 0) this.cmd = b;
    else if (k <= 3) this.addr = (this.addr << 8 | b) & 0xffffff;
    else if (cmd === 0x02) this.page.set((addr + k - 4) & 0xff, b);
    return out;
  }
}
