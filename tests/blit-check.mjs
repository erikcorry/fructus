#!/usr/bin/env node
// =============================================================================
// blit-check.mjs - tools/fpga-system.sv: its modes, through the real memories
// =============================================================================
//
//   node tests/blit-check.mjs
//
// tests/cpu-check.mjs already runs every load in blit mode against the
// simulator, with an idealised memory handing the words back late.  This runs a
// program on the WHOLE SYSTEM instead - the processor built with FRUCTUS_BLIT,
// its two SPRAMs, the frame buffers, the register block and the display, with
// yosys's own model of the SPRAM - so what is checked is the memory map and
// the late path as they are wired, not as they were meant.
//
// WHAT THE PROGRAM DOES, and what is checked afterwards in the four SPRAMs:
//
//   - in processor mode, a store above 0x8000 lands in ram_hi and not a buffer;
//   - blit mode is switched on and a load follows AT ONCE, with no padding;
//   - ld and ld8 from the back buffer, at even and odd addresses;
//   - st and st8 into it, each read back by the very next instruction;
//   - ldm, reading the back buffer, and push and pop with the stack below
//     0x8000;
//   - a frame pushed and popped in blit mode just below 0x8000, which is
//     allowed; and, in two programs of their own, a pop from 0xf000 and a
//     push that would store at 0x8000, each of which must stop the processor
//     with `trapped` before it moves a byte;
//   - a copy loop inside the back buffer, and the sum of what it copied;
//   - brk, and then the interrupt line, both in blit mode.  The vector at
//     0xfff8 is a jump the processor fetches, so it comes from ram_hi however
//     the mode is set - A holds a pattern there that would not run.  The
//     handler inherits blit mode, so its load above 0x8000 reads A, and it
//     counts its entries: exactly two, and each returns where it should;
//   - WRITETHRU: loads above 0x8000 are ram_hi's, and st and st8 there land
//     in both ram_hi and A;
//   - blit mode off, and the loads above 0x8000 are ram_hi's again;
//   - COPY of A into B, held for about three frames of a short frame the
//     program sets up: every word of B must afterwards be its old self or A's,
//     and the line tables of every visible line - which the display must have
//     fetched - must be A's;
//   - then the other way about, A shown and B the processor's: a blit-mode
//     store before the next vertical sync is dropped, since B is still being
//     copied into; after it, a load from B finds the copy of A's word, and a
//     store to B reads back; and a writethru store lands in ram_hi and B, not
//     A.
//
// Every buffer and ram_hi start filled with a different pattern, so a load
// from the wrong one, or a store that lands in two places, shows.
//
// Needs iverilog and yosys's ice40 cell models.  Skips with a message when
// either is absent.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { assemble } from './harness.mjs';

const have = (cmd) => {
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
const CELLS = (() => {
  try {
    const dir = execFileSync('yosys-config', ['--datdir'], { encoding: 'utf8' }).trim();
    return `${dir}/ice40/cells_sim.v`;
  } catch { return '/usr/share/yosys/ice40/cells_sim.v'; }
})();
if (!have('iverilog') || !existsSync(CELLS)) {
  console.log('skip  tests/blit-check.mjs: iverilog or the ice40 cell models not installed');
  process.exit(0);
}
mkdirSync('build', { recursive: true });

// --- the starting contents, a word per 16-bit location ----------------------------
const WORDS = 16384;
const fbA = (w) => (0xa000 + w * 7) & 0xffff;   // A: the processor's buffer
const fbB = (w) => (0xb000 + w * 5) & 0xffff;   // B: the one shown
const hiC = (w) => (0xc000 + w * 3) & 0xffff;   // ram_hi
const hex = (f) => Array.from({ length: WORDS }, (_, w) => f(w).toString(16).padStart(4, '0')).join('\n') + '\n';

const RESULT = 0x6000;
const LINES = 8;          // the visible lines of the short frame
const src = `
        mov  r1, #0x208            ; vertical timing, while the first front porch
        mov  r0, #2                ; still runs: porch 2, sync 2, back 3, and
        st8  r0, [r1, #0]          ; ${LINES} lines - a frame of 15 lines
        st8  r0, [r1, #2]
        mov  r0, #3
        st8  r0, [r1, #4]
        mov  r0, #${LINES}
        st8  r0, [r1, #6]
        mov  r0, #0
        st8  r0, [r1, #7]
        mov  sp, #0x8000
        mov  r1, #0x241
        mov  r0, #2
        st8  r0, [r1]              ; blit on
        mov  r0, #0x3141
        mov  r3, #0x5926
        push r0, r3                ; 0x7ffc: just below 0x8000, so no fault
        mov  r0, #0
        mov  r3, #0
        pop  r3, r0
        mov  r4, #${RESULT}
        st   r3, [r4, #26]
        st   r0, [r4, #28]
        mov  r0, #0
        st8  r0, [r1]              ; blit off again
        mov  sp, #0x7000
        mov  r1, #0x8000
        mov  r0, #0x1111
        st   r0, [r1]              ; processor mode: ram_hi's word 0
        mov  r1, #0x241
        mov  r0, #2
        st8  r0, [r1]              ; blit on
        mov  r2, #0x8010
        ld   r3, [r2]              ; at once: A's word 8
        mov  r4, #${RESULT}
        st   r3, [r4, #0]
        ld8  r3, [r2, #3]          ; 0x8013, the high byte of word 9
        st   r3, [r4, #2]
        mov  r0, #0x5a5a
        st   r0, [r2, #4]          ; A's word 10
        ld   r3, [r2, #4]          ; and straight back
        st   r3, [r4, #4]
        mov  r0, #0x77
        st8  r0, [r2, #7]          ; the high byte of word 11
        ld   r3, [r2, #6]
        st   r3, [r4, #6]
        mov  r2, #0x8020
        ldm  r0, r3                ; words 16 and 17; r2 steps to 0x8024
        st   r0, [r4, #8]
        st   r3, [r4, #10]
        st   r2, [r4, #12]
        mov  r0, #0x1357
        mov  r3, #0x2468
        push r0, r3                ; the stack is ram_lo's, in blit mode too
        mov  r0, #0
        mov  r3, #0
        pop  r3, r0
        st   r0, [r4, #14]
        st   r3, [r4, #16]
        mov  r1, #0x8040           ; copy words 32..47 to 64..79, and sum them
        mov  r2, #0x8080
        mov  r3, #16
        mov  r0, #0
loop:   ld   r4, [r1]
        st   r4, [r2]
        add  r0, r0, r4
        add  r1, r1, #2
        add  r2, r2, #2
        add  r3, r3, #-1
        br   ne, r3, #0, loop
        mov  r4, #${RESULT}
        st   r0, [r4, #18]
        mov  r2, #0x8010           ; still blit mode: the handler reads A through r2
        brk                        ; the vector is fetched from ram_hi
        mov  r0, #0x5e5e
        st   r0, [r4, #42]         ; brk came back to the next instruction
        mov  r0, #1
        st   r0, [r4, #44]         ; the test bench raises irq when it sees this
        sei
irqw:   ld   r0, [r4, #40]         ; until the handler has run twice
        add  r0, r0, #-2
        br   ne, r0, #0, irqw
        cli
        mov  r1, #0x241
        mov  r0, #3
        st8  r0, [r1]              ; writethru
        mov  r2, #0x8200
        ld   r3, [r2, #2]          ; ram_hi's word 257, not A's
        st   r3, [r4, #20]
        mov  r0, #0x4242
        st   r0, [r2, #0]          ; word 256, in ram_hi and in A
        ld   r3, [r2, #0]          ; and back, from ram_hi
        st   r3, [r4, #22]
        mov  r0, #0x99
        st8  r0, [r2, #3]          ; the high byte of word 257, in both
        mov  r0, #0
        st8  r0, [r1]              ; processor mode
        mov  r2, #0x8000
        ld   r3, [r2, #0]          ; ram_hi's word 0 again
        st   r3, [r4, #24]
        ld   r3, [r2, #2]          ; and its word 1
        st   r3, [r4, #30]
        mov  r0, #5
        st8  r0, [r1]              ; A shown, and copied into B
        mov  r3, #6000             ; about three frames
wait1:  add  r3, r3, #-1
        br   ne, r3, #0, wait1
        mov  r0, #6
        st8  r0, [r1]              ; A shown, blit to B - from the next sync
        mov  r2, #0xf400
        mov  r0, #0x7777
        st   r0, [r2]              ; B's word 0x3a00, line 0's colour pointer: dropped,
                                   ; B is still being copied into
        mov  r3, #3000             ; past a vertical sync
wait2:  add  r3, r3, #-1
        br   ne, r3, #0, wait2
        mov  r2, #0xf000
        ld   r3, [r2]              ; B's word 0x3800, line 0's character pointer: A's copy
        st   r3, [r4, #32]
        mov  r2, #0x8500
        mov  r0, #0x6161
        st   r0, [r2]              ; B's word 0x280, clear of the line tables
        ld   r3, [r2]              ; and back
        st   r3, [r4, #34]
        mov  r0, #7
        st8  r0, [r1]              ; A shown, writethru to B
        mov  r2, #0x8600
        mov  r0, #0x6262
        st   r0, [r2]              ; word 768, in ram_hi and in B
        ld   r3, [r2]              ; and back, from ram_hi
        st   r3, [r4, #36]
        mov  r0, #0
        st8  r0, [r1]              ; processor mode: B shown again, at the next sync
        mov  r3, #3000
wait3:  add  r3, r3, #-1
        br   ne, r3, #0, wait3
        halt

handler:                           ; brk and the interrupt line, in blit mode
        ld   r0, [r2]              ; A's word 8: the handler inherits the mode
        st   r0, [r4, #38]
        ld   r0, [r4, #40]
        add  r0, r0, #1
        st   r0, [r4, #40]         ; count the entry
        rti
`;
writeFileSync('build/blit-prog.s', src.split('\n').map((l) => l.trim()).join('\n') + '\n');
const { code, syms } = assemble('build/blit-prog.s');
rmSync('build/blit-prog.s', { force: true });
const prog = Array.from({ length: WORDS }, (_, w) => (code[2 * w] ?? 0) | ((code[2 * w + 1] ?? 0) << 8));

// THE VECTOR: a jump to the handler, in ram_hi at 0xfff8.  Assembled apart,
// now that the handler's address is known; an absolute jump is the same bytes
// wherever it sits.
const VECTOR = 0xfff8;
writeFileSync('build/blit-vec.s', `jmp 0x${syms.get('handler').toString(16)}\n`);
const vec = [...assemble('build/blit-vec.s').code];
rmSync('build/blit-vec.s', { force: true });
const hiWords = Array.from({ length: WORDS }, (_, w) => hiC(w));
vec.forEach((b, k) => {
  const w = ((VECTOR + k) & 0x7fff) >> 1, hiByte = (VECTOR + k) & 1;
  hiWords[w] = hiByte ? (hiWords[w] & 0x00ff) | (b << 8) : (hiWords[w] & 0xff00) | b;
});

writeFileSync('build/blit-lo.hex', hex((w) => prog[w]));
writeFileSync('build/blit-hi.hex', hex((w) => hiWords[w]));
writeFileSync('build/blit-fba.hex', hex(fbA));
writeFileSync('build/blit-fbb.hex', hex(fbB));

// --- what should be where afterwards ---------------------------------------------------
const sum = Array.from({ length: 16 }, (_, k) => fbA(32 + k)).reduce((a, b) => (a + b) & 0xffff, 0);
const results = [
  ['a load from the back buffer, just after blit mode is set', fbA(8)],
  ['ld8 of an odd byte of the back buffer',                    fbA(9) >> 8],
  ['st to the back buffer, then ld of it at once',             0x5a5a],
  ['st8 into the back buffer, then ld of its word',            (fbA(11) & 0xff) | 0x7700],
  ['ldm, first register',                                      fbA(16)],
  ['ldm, second register',                                     fbA(17)],
  ['ldm, the stepped pointer',                                 0x8024],
  ['pop in blit mode, first',                                  0x1357],
  ['pop in blit mode, second',                                 0x2468],
  ['the copy loop\'s sum',                                     sum],
  ['writethru: a load above 0x8000 is ram_hi\'s',             hiC(257)],
  ['writethru: st, then ld of it at once',                     0x4242],
  ['blit off: ram_hi\'s word 0, stored in processor mode',     0x1111],
  ['a frame just below 0x8000, in blit mode, first',          0x5926],
  ['a frame just below 0x8000, in blit mode, second',         0x3141],
  ['blit off: ram_hi\'s word 1, untouched',                    hiC(1)],
  ['blit to B: a table word is the copy of A\'s',              fbA(0x3800)],
  ['blit to B: st, then ld of it at once',                     0x6161],
  ['writethru to B: st, then ld of it, from ram_hi',           0x6262],
  ['the handler, in blit mode, loaded A\'s word 8',             fbA(8)],
  ['the handler ran twice: brk, then the interrupt line',      2],
  ['brk returned to the instruction after it',                 0x5e5e],
];
const words = [
  ...results.map(([what, v], k) => ['lo', (RESULT >> 1) + k, v, what]),
  ['fba', 0, fbA(0), 'the processor-mode store did not reach A'],
  ['fba', 10, 0x5a5a, 'the st landed in A'],
  ['fba', 11, (fbA(11) & 0xff) | 0x7700, 'the st8 changed only its byte'],
  ...Array.from({ length: 16 }, (_, k) => ['fba', 64 + k, fbA(32 + k), `the copy loop's word ${k}`]),
  ['fba', 80, fbA(80), 'the copy loop stopped where it should'],
  ['fba', 256, 0x4242, 'the writethru st reached A'],
  ['fba', 257, (fbA(257) & 0xff) | 0x9900, 'and so did the st8, to its byte'],
  ['hi', 256, 0x4242, 'the writethru st reached ram_hi'],
  ['hi', 257, (hiC(257) & 0xff) | 0x9900, 'and so did the st8'],
  ['fbb', 0x280, 0x6161, 'the blit-mode st landed in B'],
  ['fba', 0x280, fbA(0x280), 'and not in A'],
  ['hi', 0x280, hiC(0x280), 'nor in ram_hi'],
  ['fbb', 768, 0x6262, 'the writethru st reached B'],
  ['hi', 768, 0x6262, 'and ram_hi'],
  ['fba', 768, fbA(768), 'and not A'],
  ['hi', 0, 0x1111, 'the processor-mode store landed in ram_hi'],
  ['hi', 10, hiC(10), 'blit-mode stores did not reach ram_hi'],
  ...Array.from({ length: 16 }, (_, k) => ['hi', 64 + k, hiC(64 + k), `nor did the copy loop, word ${k}`]),
];

writeFileSync('build/blit-tb.sv', `module tb;
    logic clk = 0, din = 1;
    wire dout, hsync_n, vsync_n; wire [2:0] red, green, blue;
    // The interrupt line: raised once the program says it is waiting, and
    // held until the handler has counted two entries - brk's and its own.
    wire irq = dut.ram_lo.mem[${(RESULT + 44) >> 1}] == 16'd1 && dut.ram_lo.mem[${(RESULT + 40) >> 1}] < 16'd2;
    top dut (.clk, .din, .irq, .dout, .hsync_n, .vsync_n, .red, .green, .blue);
    integer cyc, k;
    initial begin
        $readmemh("build/blit-lo.hex",  dut.ram_lo.mem);
        $readmemh("build/blit-hi.hex",  dut.ram_hi.mem);
        $readmemh("build/blit-fba.hex", dut.fba.mem);
        $readmemh("build/blit-fbb.hex", dut.fbb.mem);
        repeat (4) begin #1 clk = 1; #1 clk = 0; end
        din = 0;
        for (cyc = 0; cyc < 200000 && !dut.halted && !dut.trapped; cyc = cyc + 1) begin
            #1 clk = 1; #1 clk = 0;
        end
        // Two more edges, so a store's late write has landed.
        repeat (2) begin #1 clk = 1; #1 clk = 0; end
        $display("END %0d %0d %0d", dut.halted, dut.trapped, cyc);
${words.map(([mem, w], k) => {
  const inst = { lo: 'ram_lo', hi: 'ram_hi', fba: 'fba', fbb: 'fbb' }[mem];
  return `        $display("W ${k} %h", dut.${inst}.mem[${w}]);`;
}).join('\n')}
        for (k = 0; k < ${WORDS}; k = k + 1) $display("AB %0d %h %h", k, dut.fba.mem[k], dut.fbb.mem[k]);
        // For the programs that fault: the marker, and the words a push at
        // 0x8000 would have written.
        $display("F %h %h %h %h %h", dut.ram_lo.mem[${RESULT >> 1}],
                 dut.fba.mem[0], dut.fba.mem[1], dut.ram_hi.mem[0], dut.ram_hi.mem[1]);
        $finish;
    end
endmodule
`);

const RTL = ['rtl/cpu.sv', 'rtl/classify.sv', 'rtl/alu.sv', 'rtl/ucode.sv',
             'rtl/lhs.sv', 'rtl/dest.sv', 'rtl/immgen.sv', 'rtl/cond.sv', 'rtl/compare.sv'];
const VIDEO = ['rtl/video/video.sv', 'rtl/video/timing.sv', 'rtl/video/background.sv',
               'rtl/video/foreground.sv', 'rtl/video/sprites.sv'];
execFileSync('iverilog', ['-g2012', '-DFRUCTUS_BLIT', '-DNO_ICE40_DEFAULT_ASSIGNMENTS', '-o', 'build/blit-tb.vvp',
  ...RTL, ...VIDEO, CELLS, 'tools/fpga-system.sv', 'build/blit-tb.sv'], { stdio: ['ignore', 'ignore', 'inherit'] });
const out = execFileSync('vvp', ['-n', 'build/blit-tb.vvp'], { encoding: 'utf8' });

// --- a stack above 0x8000 in blit mode: a fault --------------------------------------
// Each program stores a marker, sets blit mode and then pushes or pops where
// it may not.  The processor must stop there, trapped: the marker's second
// value never stored, nothing written above 0x8000 in ram_hi or A - which is
// where a push at 0x8000 would land in blit mode - and, for the pop, no
// register changed that the marker would show.
const faults = [
  ['a pop from 0xf000', `mov sp, #0xf000`, `pop r3, r0`],
  ['a push that would store at 0x8000', `mov sp, #0x8004`, `push r0, r3`],
].map(([what, setsp, insn]) => {
  writeFileSync('build/blit-fault.s', `
        ${setsp}
        mov  r4, #${RESULT}
        mov  r1, #0x241
        mov  r0, #2
        st8  r0, [r1]
        mov  r0, #1
        st   r0, [r4]
        ${insn}
        mov  r0, #2
        st   r0, [r4]
        halt
`.split('\n').map((l) => l.trim()).join('\n'));
  const { code: fc } = assemble('build/blit-fault.s');
  rmSync('build/blit-fault.s', { force: true });
  writeFileSync('build/blit-lo.hex', hex((w) => (fc[2 * w] ?? 0) | ((fc[2 * w + 1] ?? 0) << 8)));
  return [what, execFileSync('vvp', ['-n', 'build/blit-tb.vvp'], { encoding: 'utf8' })];
});
for (const f of ['blit-lo.hex', 'blit-hi.hex', 'blit-fba.hex', 'blit-fbb.hex', 'blit-tb.sv', 'blit-tb.vvp'])
  rmSync(`build/${f}`, { force: true });

let bad = 0;
for (const [what, fout] of faults) {
  const e = fout.match(/^END (\d) (\d) (\d+)/m), f = fout.match(/^F (\S+) (\S+) (\S+) (\S+) (\S+)/m);
  const got = f ? f.slice(1).map((x) => parseInt(x, 16)) : [];
  const want = [1, fbA(0), fbA(1), hiC(0), hiC(1)];
  if (!e || e[2] !== '1' || e[1] !== '0') {
    console.log(`  MISMATCH ${what} in blit mode ${e ? (e[1] === '1' ? 'halted' : 'did not stop') : 'printed nothing'}, not trapped`);
    bad++;
  } else if (want.some((v, k) => got[k] !== v)) {
    console.log(`  MISMATCH ${what} in blit mode: marker, A's words 0 and 1, ram_hi's 0 and 1 are ${got.map((v) => v?.toString(16)).join(' ')}, want ${want.map((v) => v.toString(16)).join(' ')}`);
    bad++;
  }
}
const end = out.match(/^END (\d) (\d) (\d+)/m);
if (!end || end[1] !== '1' || end[2] !== '0') {
  console.log(`  the program ${end ? (end[2] === '1' ? 'trapped' : 'did not halt') : 'printed nothing'} after ${end?.[3]} cycles`);
  bad++;
}
for (const m of out.matchAll(/^W (\d+) ([0-9a-fx]+)/gm)) {
  const [mem, w, want, what] = words[+m[1]];
  if (parseInt(m[2], 16) !== want) {
    if (bad++ < 8) console.log(`  MISMATCH ${what}: ${mem} word ${w} is ${m[2]}, want ${want.toString(16).padStart(4, '0')}`);
  }
}
// THE COPY.  Every word of B is its old self or A's, since B is written only
// with what the display read from A; and the line tables of every visible
// line are A's, since the display fetches those whatever they say.
const A = [], B = [];
for (const m of out.matchAll(/^AB (\d+) ([0-9a-fx]+) ([0-9a-fx]+)/gm)) { A[+m[1]] = parseInt(m[2], 16); B[+m[1]] = parseInt(m[3], 16); }
let copied = 0;
const WRITTEN = new Set([0x280, 768]);    // B's words the program wrote itself, checked above
for (let w = 0; w < WORDS; w++) {
  if (WRITTEN.has(w)) continue;
  if (B[w] === A[w] && A[w] !== fbB(w)) copied++;
  else if (B[w] !== fbB(w) && bad++ < 8)
    console.log(`  MISMATCH B word ${w} is ${B[w]?.toString(16)}, neither its old ${fbB(w).toString(16)} nor A's ${A[w]?.toString(16)}`);
}
for (let n = 0; n < LINES; n++)
  for (const t of [0x3800, 0x3a00, 0x3c00, 0x3e00])
    if (B[t + n] !== A[t + n] && bad++ < 8)
      console.log(`  MISMATCH line ${n}'s table word ${(t + n).toString(16)} was not copied into B`);
if (bad) { console.log(`FAIL  tests/blit-check.mjs: ${bad} wrong`); process.exit(1); }
console.log(`ok    tests/blit-check.mjs: tools/fpga-system.sv's modes, ${results.length} results, ${words.length - results.length} memory words and ${copied} words copied into B, in ${end[3]} cycles; `
          + `${faults.length} stacks above 0x8000 in blit mode trapped`);
