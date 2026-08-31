#!/usr/bin/env node
// =============================================================================
// microtan-check.mjs - the Microtan board, headless
// =============================================================================
//
// Runs tests/microtan-smoke.s on the simulated board and checks what appears on
// the screen.  What is being tested is the MACHINE - reset, the ROM window, the
// keyboard handshake and the display - rather than the instruction set, which
// sim-check.mjs already covers.
// =============================================================================

import { assemble, spec } from './harness.mjs';
import { Microtan, MICROTAN } from '../tools/microtan.js';

let fails = 0, checks = 0;
const check = (name, ok, detail = '') => { checks++; if (!ok) { fails++; console.log(`  FAIL ${name}: ${detail}`); } };

const { code } = assemble('tests/microtan-smoke.s');
check('rom is exactly one socket', code.length === MICROTAN.rom.size, `${code.length} bytes`);

const boot = (keys) => {
  const m = new Microtan(spec).loadRom(code);
  m.type(keys);
  while (!m.halted && m.count < 2e6) if (m.batch(50000) !== 'running') break;
  return m;
};

// --- it starts at 0xfffd, and only a three-byte jmp fits there ---------------
{
  const m = new Microtan(spec).loadRom(code);
  check('reset address', m.pc === 0xfffd, `pc=0x${m.pc.toString(16)}`);
  m.batch(1);
  check('reset jumps into the ROM', m.pc >= MICROTAN.rom.base && m.pc < 0xfffd,
        `after one instruction pc=0x${m.pc.toString(16)}`);
}

// --- typing appears on the screen -------------------------------------------
{
  const m = boot('HELLO, MICROTAN 65!\x01');
  check('halted on the stop key', m.halted, `pc=0x${m.pc.toString(16)} after ${m.count}`);
  check('echoed to the screen', m.screen()[0] === 'HELLO, MICROTAN 65!'.padEnd(32),
        JSON.stringify(m.screen()[0]));
  check('rest of the screen is blank', m.screen().slice(1).every((l) => l === ' '.repeat(32)));
  check('key port left clear', m.mem[MICROTAN.key] === 0, `port=${m.mem[MICROTAN.key]}`);
  check('no writes into ROM', m.romWrites === 0, `${m.romWrites}`);
}

// --- more than a screenful wraps to the top ---------------------------------
{
  const n = MICROTAN.screen.cols * MICROTAN.screen.rows;   // 512
  const over = 18;
  let s = ''; for (let i = 0; i < n + over; i++) s += String.fromCharCode(48 + (i % 10));
  const m = boot(s + '\x01');
  const row0 = m.screen()[0];
  const wrapped = s.slice(n, n + over);
  check('wrapped to the top', row0.startsWith(wrapped), `row 0 = ${JSON.stringify(row0)}`);
  check('the unwrapped tail survives', row0.slice(over) === s.slice(over, MICROTAN.screen.cols),
        `row 0 = ${JSON.stringify(row0)}`);
}

// --- the ROM window is read only --------------------------------------------
{
  const m = new Microtan(spec).loadRom(code);
  const was = m.mem[MICROTAN.rom.base];
  m.wr8(MICROTAN.rom.base, was ^ 0xff);
  m.wr16(0xfffe, 0x1234);                       // straddles nothing, still ROM
  check('rom byte unchanged', m.mem[MICROTAN.rom.base] === was);
  check('rom writes counted', m.romWrites === 2, `${m.romWrites}`);
  m.wr8(MICROTAN.screen.base, 65);
  check('ram still writable', m.mem[MICROTAN.screen.base] === 65);
}

// --- the keyboard handshake --------------------------------------------------
// A key is delivered only when the port reads zero.  That is what stops a fast
// typist overrunning a slow poll loop, and it is the protocol the monitor
// implements by zeroing the byte after it reads one.
{
  const m = new Microtan(spec).loadRom(code);
  m.type('ab');
  m.deliverKey();
  check('first key delivered', m.mem[MICROTAN.key] === 0x61, `${m.mem[MICROTAN.key]}`);
  m.deliverKey();
  check('second key held while the port is busy', m.mem[MICROTAN.key] === 0x61 && m.keys.length === 1,
        `port=${m.mem[MICROTAN.key]} queued=${m.keys.length}`);
  m.mem[MICROTAN.key] = 0;
  m.deliverKey();
  check('second key delivered once the port clears', m.mem[MICROTAN.key] === 0x62, `${m.mem[MICROTAN.key]}`);
}

// --- an oversized ROM is refused rather than wrapping ------------------------
{
  let threw = false;
  try { new Microtan(spec).loadRom(new Uint8Array(MICROTAN.rom.size + 1)); } catch { threw = true; }
  check('oversized rom rejected', threw);
}

console.log(`${fails ? 'FAIL ' : 'ok   '} tests/microtan-smoke.s on the board: ${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
