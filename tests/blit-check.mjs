#!/usr/bin/env node
// =============================================================================
// blit-check.mjs - tools/fpga-system.sv: blit mode, through the real memories
// =============================================================================
//
//   node tests/blit-check.mjs
//
// tests/rtl-check.mjs already runs every load in blit mode against the
// simulator, with an idealised memory handing the bytes back late.  This runs a
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
//   - a frame pushed above 0x8000 in processor mode, popped in blit mode: pop
//     keeps its ordinary routine and reads ram_hi, not the buffer;
//   - a copy loop inside the back buffer, and the sum of what it copied;
//   - `show` flipped, so the other buffer becomes the back one;
//   - blit mode off, and the loads above 0x8000 are ram_hi's again.
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
const fbA = (w) => (0xa000 + w * 7) & 0xffff;   // fb1: the back buffer while show = 0
const fbB = (w) => (0xb000 + w * 5) & 0xffff;   // fb0: the back buffer while show = 1
const hiC = (w) => (0xc000 + w * 3) & 0xffff;   // ram_hi
const hex = (f) => Array.from({ length: WORDS }, (_, w) => f(w).toString(16).padStart(4, '0')).join('\n') + '\n';

const RESULT = 0x6000;
const src = `
        mov  sp, #0xf000
        mov  r0, #0x3141
        mov  r3, #0x5926
        push r0, r3                ; processor mode: into ram_hi at 0xeffc
        mov  r1, #0x7f41
        mov  r0, #2
        st8  r0, [r1]              ; blit on
        mov  r0, #0
        mov  r3, #0
        pop  r3, r0                ; still ram_hi's, not the back buffer's
        mov  r4, #${RESULT}
        st   r3, [r4, #26]
        st   r0, [r4, #28]
        mov  r0, #0
        st8  r0, [r1]              ; blit off again
        mov  sp, #0x7000
        mov  r1, #0x8000
        mov  r0, #0x1111
        st   r0, [r1]              ; processor mode: ram_hi's word 0
        mov  r1, #0x7f41
        mov  r0, #2
        st8  r0, [r1]              ; blit on, show 0: the back buffer is fb1
        mov  r2, #0x8010
        ld   r3, [r2]              ; at once: fb1 word 8
        mov  r4, #${RESULT}
        st   r3, [r4, #0]
        ld8  r3, [r2, #3]          ; 0x8013, the high byte of word 9
        st   r3, [r4, #2]
        mov  r0, #0x5a5a
        st   r0, [r2, #4]          ; fb1 word 10
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
        mov  r1, #0x7f41
        mov  r0, #3
        st8  r0, [r1]              ; show 1: the back buffer is fb0
        mov  r2, #0x8000
        ld   r3, [r2, #2]          ; fb0 word 1
        st   r3, [r4, #20]
        mov  r0, #0x4242
        st   r0, [r2, #0]          ; fb0 word 0
        mov  r0, #0
        st8  r0, [r1]              ; blit off
        ld   r3, [r2, #0]          ; ram_hi's word 0 again
        st   r3, [r4, #22]
        ld   r3, [r2, #2]          ; and its word 1
        st   r3, [r4, #24]
        halt
`;
writeFileSync('build/blit-prog.s', src.split('\n').map((l) => l.trim()).join('\n') + '\n');
const { code } = assemble('build/blit-prog.s');
rmSync('build/blit-prog.s', { force: true });
const prog = Array.from({ length: WORDS }, (_, w) => (code[2 * w] ?? 0) | ((code[2 * w + 1] ?? 0) << 8));

writeFileSync('build/blit-lo.hex', hex((w) => prog[w]));
writeFileSync('build/blit-hi.hex', hex(hiC));
writeFileSync('build/blit-fb0.hex', hex(fbB));
writeFileSync('build/blit-fb1.hex', hex(fbA));

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
  ['a load from fb0 once show is set',                         fbB(1)],
  ['blit off: ram_hi\'s word 0, stored in processor mode',     0x1111],
  ['blit off: ram_hi\'s word 1, untouched',                    hiC(1)],
  ['a high frame popped in blit mode, first',                  0x5926],
  ['a high frame popped in blit mode, second',                 0x3141],
];
const words = [
  ...results.map(([what, v], k) => ['lo', (RESULT >> 1) + k, v, what]),
  ['fb1', 0, fbA(0), 'the processor-mode store did not reach the back buffer'],
  ['fb1', 10, 0x5a5a, 'the st landed in fb1'],
  ['fb1', 11, (fbA(11) & 0xff) | 0x7700, 'the st8 changed only its byte'],
  ...Array.from({ length: 16 }, (_, k) => ['fb1', 64 + k, fbA(32 + k), `the copy loop's word ${k}`]),
  ['fb1', 80, fbA(80), 'the copy loop stopped where it should'],
  ['fb0', 0, 0x4242, 'the st landed in fb0 once show was set'],
  ['fb0', 10, fbB(10), 'fb0 was not written while fb1 was the back buffer'],
  ['hi', 0, 0x1111, 'the processor-mode store landed in ram_hi'],
  ['hi', 10, hiC(10), 'blit-mode stores did not reach ram_hi'],
  ...Array.from({ length: 16 }, (_, k) => ['hi', 64 + k, hiC(64 + k), `nor did the copy loop, word ${k}`]),
];

writeFileSync('build/blit-tb.sv', `module tb;
    logic clk = 0, din = 1;
    wire dout, hsync_n, vsync_n; wire [2:0] red, green, blue;
    top dut (.clk, .din, .irq(1'b0), .dout, .hsync_n, .vsync_n, .red, .green, .blue);
    integer cyc;
    initial begin
        $readmemh("build/blit-lo.hex",  dut.ram_lo.mem);
        $readmemh("build/blit-hi.hex",  dut.ram_hi.mem);
        $readmemh("build/blit-fb0.hex", dut.fb0.mem);
        $readmemh("build/blit-fb1.hex", dut.fb1.mem);
        repeat (4) begin #1 clk = 1; #1 clk = 0; end
        din = 0;
        for (cyc = 0; cyc < 5000 && !dut.halted && !dut.trapped; cyc = cyc + 1) begin
            #1 clk = 1; #1 clk = 0;
        end
        // Two more edges, so a store's late write has landed.
        repeat (2) begin #1 clk = 1; #1 clk = 0; end
        $display("END %0d %0d %0d", dut.halted, dut.trapped, cyc);
${words.map(([mem, w], k) => {
  const inst = { lo: 'ram_lo', hi: 'ram_hi', fb0: 'fb0', fb1: 'fb1' }[mem];
  return `        $display("W ${k} %h", dut.${inst}.mem[${w}]);`;
}).join('\n')}
        $finish;
    end
endmodule
`);

const RTL = ['rtl/cpu.sv', 'rtl/ucode.sv', 'rtl/insn.sv', 'rtl/predecode.sv', 'rtl/lhs.sv', 'rtl/immgen.sv',
             'rtl/rhs.sv', 'rtl/unary.sv', 'rtl/alu.sv', 'rtl/dest.sv', 'rtl/cond.sv', 'rtl/compare.sv'];
const VIDEO = ['rtl/video/video.sv', 'rtl/video/timing.sv', 'rtl/video/background.sv',
               'rtl/video/foreground.sv', 'rtl/video/sprites.sv'];
execFileSync('iverilog', ['-g2012', '-DFRUCTUS_BLIT', '-DNO_ICE40_DEFAULT_ASSIGNMENTS', '-o', 'build/blit-tb.vvp',
  ...RTL, ...VIDEO, CELLS, 'tools/fpga-system.sv', 'build/blit-tb.sv'], { stdio: ['ignore', 'ignore', 'inherit'] });
const out = execFileSync('vvp', ['-n', 'build/blit-tb.vvp'], { encoding: 'utf8' });
for (const f of ['blit-lo.hex', 'blit-hi.hex', 'blit-fb0.hex', 'blit-fb1.hex', 'blit-tb.sv', 'blit-tb.vvp'])
  rmSync(`build/${f}`, { force: true });

let bad = 0;
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
if (bad) { console.log(`FAIL  tests/blit-check.mjs: ${bad} wrong`); process.exit(1); }
console.log(`ok    tests/blit-check.mjs: tools/fpga-system.sv in blit mode, ${results.length} results and ${words.length - results.length} memory words, in ${end[3]} cycles`);
