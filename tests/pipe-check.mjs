#!/usr/bin/env node
// =============================================================================
// pipe-check.mjs - rtl/pipe/, the pipelined experiment, against the simulator
// =============================================================================
//
//   node tests/pipe-check.mjs
//
// Random programs of every form the experiment runs - each ALU instruction
// that writes one register from registers and constants, in one cycle, and
// the conditional branches - ending in halt, run from random registers on
// rtl/pipe/cpu.sv and tools/sim.js.  The random branches all go FORWARD, to
// an instruction boundary, so every program ends; loops come from a few
// programs written as source and assembled.
//
// WHAT IS COMPARED.  Every instruction that leaves the ALU stage is printed
// with its pc and the registers after its write, and must match the simulator
// instruction for instruction - branches included, which write nothing.  And
// the dispatches must come exactly as rtl/pipe/cpu.sv's header says: one a
// cycle, except that an instruction of three bytes starting at an odd address
// is followed by a cycle with none, and a taken branch by three.  The
// dispatches a taken branch squashes are dropped before that is checked.
// The forms are drawn so that every length lands at both alignments.
//
// Needs iverilog; skips without it.  PIPE_KEEP=1 leaves the programs in
// build/pipe-prog-N.hex and their registers in build/pipe-reg-N.hex, for
// looking at one that fails.
// =============================================================================

import { loadSpec } from '../tools/isa.js';
import { Machine } from '../tools/sim.js';
import { buildDecoder, decode } from '../tools/decode.js';
import { execFileSync } from 'node:child_process';
import { assemble } from './harness.mjs';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';

const have = (cmd) => {
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
if (!have('iverilog')) {
  console.log('skip  tests/pipe-check.mjs: iverilog not installed');
  process.exit(0);
}

const spec = loadSpec();
const dec = buildDecoder(spec);
const hex4 = (v) => ((v >>> 0) & 0xffff).toString(16).padStart(4, '0');
const rnd = (() => { let s = 2654435761;
  return () => (s ^= s << 13, s ^= s >>> 17, s ^= s << 5, s >>> 0); })();
const EDGE = [0, 1, 2, 0x7fff, 0x8000, 0xffff, 0x00ff, 0x0100];
const val = () => (rnd() % 4 === 0 ? EDGE[rnd() % EDGE.length] : rnd() & 0xffff);

// --- the forms: decided from the semantics, not from the classifier ----------
// One register written, no memory, no second statement.  nop comes too.  The
// two-cycle ones - mul, clz, popcount, which the spec gives an extra cycle -
// run a routine and cost four cycles, dispatch to dispatch.
const forms = new Map();
for (let op = 0; op < 256; op++)
  for (let b1 = 0; b1 < 256; b1++) {
    const d = decode(dec, [op, b1, 0], 0);
    if (!d) continue;
    const sem = d.insn.semantics ?? '';
    const ok = d.insn.mnemonic === 'nop'
            || (/^R\[[a-z]\] = /.test(sem) && !/M(8|16)\[|;/.test(sem));
    if (!ok) continue;
    const key = `${d.insn.mnemonic}/${d.form.name}@${op}`;
    if (!forms.has(key)) forms.set(key, { op, nbytes: d.nbytes, b1s: [] });
    forms.get(key).b1s.push(b1);
  }
const all = [...forms.values()];

// THE MEMORY INSTRUCTIONS, from their semantics, in the two pools
// tests/rtl-check.mjs uses.  A load is safe beside anything: it reads, and
// whatever it reads the simulator reads too.  A store is not - it could write
// over the program - so stores and the block moves that store go in programs
// of their own, whose registers all start in a window far above the program,
// and in which nothing but a walking pointer writes a register.  pop and ldm
// write registers from memory, so they go with the loads.
//
// `bytes` is what the sequencer moves, and what rtl/pipe/cpu.sv charges: a
// memory instruction's next dispatch comes bytes + 4 cycles after its own if
// it stores, and bytes + 3 if it loads, since a load's first address is the
// ALU's result, put out in its ALU cycle.
const memBytes = (sem) => {
  const blk = /^base = (sp|r1|r2); /.test(sem);
  if (blk) return 2 * (sem.match(/M16\[/g) ?? []).length;
  const m = /M(8|16)\[R\[a\] \+ (off|R\[b\])\]/.exec(sem);
  return m ? (m[1] === '8' ? 1 : 2) : 0;
};
const memPools = { ld: new Map(), st: new Map() };
for (let op = 0; op < 256; op++)
  for (let b1 = 0; b1 < 256; b1++) {
    const d = decode(dec, [op, b1, 0], 0);
    const sem = d?.insn.semantics ?? '';
    if (!d || !memBytes(sem)) continue;
    const kind = /^(M(8|16)\[R|base = [a-z0-9]+; M16)/.test(sem) ? 'st' : 'ld';
    const key = `${d.insn.mnemonic}/${d.form.name}@${op}`;
    if (!memPools[kind].has(key)) memPools[kind].set(key, { op, nbytes: d.nbytes, b1s: [] });
    memPools[kind].get(key).b1s.push(b1);
  }
const loads = [...memPools.ld.values()], stores = [...memPools.st.values()];

// The conditional branches, by what they are: a pc-relative transfer taken
// on a test.  The offset byte is filled in once the program is laid out.
const branches = new Map();
for (let op = 0; op < 256; op++)
  for (let b1 = 0; b1 < 256; b1++) {
    const d = decode(dec, [op, b1, 0], 0);
    if (!d || !/^if \(.*\) pc = pc \+ off$/.test(d.insn.semantics ?? '')) continue;
    const key = `${d.insn.mnemonic}/${d.form.name}@${op}`;
    if (!branches.has(key)) branches.set(key, { op, nbytes: d.nbytes, b1s: [], branch: true });
    branches.get(key).b1s.push(b1);
  }
const brs = [...branches.values()];

// THE EXCEPTION INSTRUCTIONS.  brk, sei and cli go in the random programs;
// rti is reached only through brk, since the vector holds nothing but rti in
// both machines - so a brk is a round trip that leaves every register as it
// was, through the shadows.  brk and rti cost rtl/pipe/cpu.sv six cycles,
// dispatch to dispatch, since they redirect the fetch through taken_q; sei
// and cli five.
const oneByte = (mnemonic) => parseInt(spec.insn.find((i) => i.mnemonic === mnemonic)
                                           .form[0].encoding.replace(/[\s_]/g, ''), 2);
const RTI = oneByte('rti'), VECTOR = spec.cpu.vectors.brk;
const excs = ['brk', 'sei', 'cli'].map((mn) => ({ op: oneByte(mn), nbytes: 1, b1s: [0] }));
const EXC = /^(brk|rti|sei|cli)$/;
const EXC_CYCLES = { brk: 6, rti: 6, sei: 5, cli: 5 };

// THE JUMPS, found by their semantics.  An immediate target is patched in
// after layout like a branch's offset.  A register target is a pair: a
// `mov rX, #target` and then the jump through rX - so the jump always reads
// the register the instruction just ahead of it wrote, through the bypass.
// X is drawn at random, so `call r7`, which goes to the new lr and not the
// target, comes up too.  ret is a mov into lr and then ret.
const JUMP_SEM = /^(lr = pc; )?pc = (target|pc \+ target|R\[a\]|lr)$/;
const find = (want) => {
  for (let op = 0; op < 256; op++)
    for (let b1 = 0; b1 < 256; b1++) {
      const d = decode(dec, [op, b1, 0], 0);
      if (d && want(d)) return { op, b1, d };
    }
  throw new Error('no such form');
};
const MOV_TO = Array.from({ length: 8 }, (_, x) =>
  find((d) => d.nbytes === 3 && d.insn.semantics === 'R[d] = imm' && d.ops.d === x).op);
const jumps = [];
for (let op = 0; op < 256; op++) {
  const d = decode(dec, [op, 0, 0], 0);
  const m = d && JUMP_SEM.exec(d.insn.semantics ?? '');
  if (!m) continue;
  const how = m[2] === 'target' ? 'abs' : m[2] === 'pc + target' ? 'rel' : m[2] === 'lr' ? 'ret' : 'reg';
  jumps.push({ op, jump: how });
}

// Lay a list of forms out as bytes, pointing each branch forward at a random
// instruction boundary no more than a dozen instructions on - the halt at the
// end is a boundary too - so every program ends.
const layout = (picks) => {
  const ins = picks.map((f) => ({ f, bytes: draw(f) }));
  const at = [];
  let a = 0;
  for (const i of ins) { at.push(a); a += i.bytes.length; }
  at.push(a);                                          // the halt
  ins.forEach((i, k) => {
    if (!i.f.branch && !i.f.jump) return;
    const j = k + 1 + (rnd() % Math.min(12, ins.length - k));
    const t = at[j];
    switch (i.f.jump ?? 'branch') {
      case 'branch': i.bytes[2] = (t - (at[k] + 3)) & 0xff; break;
      case 'rel':    i.bytes[1] = (t - (at[k] + 2)) & 0xff; break;
      default:       i.bytes[1] = t & 0xff; i.bytes[2] = t >> 8;   // abs, or the mov of a pair
    }
  });
  return ins.flatMap((i) => i.bytes);
};
const draw = (f) => {
  switch (f.jump) {
    case 'abs': return [f.op, 0, 0];
    case 'rel': return [f.op, 0];
    case 'ret': return [MOV_TO[7], 0, 0, f.op];
    case 'reg': { const x = rnd() & 7; return [MOV_TO[x], 0, 0, f.op, x]; }
  }
  if (f.nbytes === 1) return [f.op];
  const bytes = [f.op, f.b1s[rnd() % f.b1s.length]];
  if (f.nbytes === 3) bytes.push(rnd() & 0xff);
  return bytes;
};
const HALT = parseInt(spec.insn.find((i) => i.mnemonic === 'halt')
                          .form[0].encoding.replace(/[\s_]/g, ''), 2);

// Every form twice over, once from each alignment - a one-byte nop shifts the
// second pass by one - and then random mixtures.
const NOP = forms.get([...forms.keys()].find((k) => k.startsWith('nop/')));
const shuffle = (xs) => xs.map((x) => [rnd(), x]).sort((a, b) => a[0] - b[0]).map((e) => e[1]);

// Loops, and the register-register branch both ways round, assembled.  Each
// is run twice: as written, and a byte later behind a nop, so that every
// branch in it lands at the other alignment too.
const SOURCES = [
  `       mov  r0, #5
          mov  r1, #0
  loop:   add  r1, r1, r0
          add  r0, r0, #-1
          br   ne, r0, #0, loop
          brset r1, #1, odd
          mov  r2, #0x1234
  odd:    brclr r1, #0xf0f0, clear
          mov  r3, #0x5678
  clear:  add  r1, r1, #1
          halt`,
  `       mov  r2, #0
          mov  r3, #7
  up:     add  r2, r2, #1
          br   lt, r2, r3, up
          br   ge, r2, r3, past
          mov  r4, #0xbad
  past:   mov  r5, #3
  down:   add  r5, r5, #-1
          iseq r6, r5, #0
          br   eq, r6, #0, down
          halt`,
  `       mov  r0, #3
          mov  r1, #0
  again:  call bump
          add  r0, r0, #-1
          br   ne, r0, #0, again
          jmpr over
          mov  r2, #0xbad
  over:   mov  r2, #there
          jmp  r2
          mov  r3, #0xbad
  there:  call outer
          jmp  done
          mov  r4, #0xbad
  done:   halt
  outer:  mov  r5, lr
          mov  r4, #bump
          call r4
          mov  lr, r5
          ret
  bump:   add  r1, r1, #1
          ret`,
  // Stores read back: both widths, an odd address, every block move, and the
  // pointer in a block's own list both ways.
  `       mov  sp, #0x4000
          mov  r1, #0x3000
          mov  r0, #0x1234
          st   r0, [r1, #0]
          st8  r0, [r1, #3]
          ld   r2, [r1, #0]
          ld8  r3, [r1, #3]
          ld   r4, [r1, #1]
          mov  r5, #2
          ld   r4, [r1, r5]
          st   r4, [r1, #5]
          push r0, r2, r3
          push r4
          pop  r5
          pop  r0, r2, r3
          mov  r2, #0x3000
          ldm  r3, r4
          mov  r1, #0x3101
          stm  r0, r5, r1
          add  r2, r2, #-4
          ldm  r5
          mov  r2, #0x3101
          ldm  r3, r2, r4
          push sp
          pop  sp
          push r6, r0
          pop  r0, r6
          halt`,
  // A copy loop, word by word, as memcpy would do it.
  `       mov  r2, #0x3000
          mov  r1, #0x3000
          mov  r0, #0x0102
          mov  r3, #4
  fill:   stm  r0
          add  r0, r0, #0x0202
          add  r3, r3, #-1
          br   ne, r3, #0, fill
          mov  r1, #0x3401
          mov  r3, #2
  copy:   ldm  r4, r5
          stm  r4, r5
          add  r3, r3, #-1
          br   ne, r3, #0, copy
          mov  r1, #0x3401
          ld   r4, [r1, #0]
          ld   r5, [r1, #6]
          halt`,
];
// The second copy has its nop IN THE SOURCE, not put in front of the bytes:
// a call or a jmp to a label is an absolute address, which the assembler
// has to see move.
const assembled = SOURCES.flatMap((src, i) => [src, `nop\n${src}`].map((text, j) => {
  const f = `build/pipe-src-${i}-${j}.s`;
  writeFileSync(f, text.split('\n').map((l) => l.trim()).join('\n') + '\n');
  const { code } = assemble(f);
  rmSync(f, { force: true });
  return [...code];
}));

const N_ALU = 60, N_LD = 20, N_ST = 20;
const N_RANDOM = N_ALU + N_LD + N_ST;
// Even, and far above any program these make: the widest displacement is ten
// signed bits and an index is another register from the same window.
const safe = () => 0x2000 + ((rnd() % 0x1000) & ~1);
const PROGRAMS = N_RANDOM + assembled.length;
const programs = [];
mkdirSync('build', { recursive: true });
for (let p = 0; p < PROGRAMS; p++) {
  let bytes, draws = val;
  if (p < N_ALU) {
    // The first program has every form twice, once from each alignment;
    // after that, one instruction in five is a branch.
    const picks = p === 0 ? shuffle([...all, ...brs, ...jumps, ...excs, NOP, ...all, ...brs, ...jumps, ...excs])
                          : Array.from({ length: 40 }, () => {
                              const r = rnd() % 20;
                              return r < 4 ? brs[rnd() % brs.length]
                                   : r < 6 ? jumps[rnd() % jumps.length]
                                   : r < 7 ? excs[rnd() % excs.length]
                                   : all[rnd() % all.length];
                            });
    bytes = layout(picks).concat([HALT]);
  } else if (p < N_ALU + N_LD) {
    // Loads among everything else; the first has every load twice.
    const picks = p === N_ALU ? shuffle([...loads, NOP, ...loads])
                              : Array.from({ length: 40 }, () => {
                                  const r = rnd() % 10;
                                  return r < 3 ? loads[rnd() % loads.length]
                                       : r < 4 ? brs[rnd() % brs.length]
                                       : all[rnd() % all.length];
                                });
    bytes = layout(picks).concat([HALT]);
  } else if (p < N_RANDOM) {
    // Stores alone, from the safe window; the first has every one twice.
    const picks = p === N_ALU + N_LD ? shuffle([...stores, NOP, ...stores])
                                     : Array.from({ length: 30 }, () => stores[rnd() % stores.length]);
    bytes = layout(picks).concat([HALT]);
    draws = safe;
  } else {
    bytes = assembled[p - N_RANDOM];
  }
  const reg = Array.from({ length: 8 }, draws);
  const m = new Machine(spec).load(bytes, 0);
  m.mem[VECTOR] = RTI;
  reg.forEach((v, k) => { m.R[k] = v; });
  // WHETHER A BRANCH IS TAKEN IS NOT WHERE THE pc LANDS: a branch to the
  // very next instruction lands there either way, and the processor still
  // pays for taking it.  So a branch is stepped a second time, on a copy
  // whose offset byte is 1, and it was taken if that copy's pc moved by one
  // more than the branch's length.
  const takes = (pc, len) => {
    const c = new Machine(spec).load(m.mem, 0);
    c.R.set(m.R);
    c.pc = pc;
    c.mem[(pc + 2) & 0xffff] = 1;
    c.step();
    return c.pc === ((pc + len + 1) & 0xffff);
  };
  const trace = [];
  for (let guard = 0; !m.halted && guard < 1000; guard++) {
    const pc = m.pc;
    const d = decode(dec, [m.mem[pc], m.mem[(pc + 1) & 0xffff], m.mem[(pc + 2) & 0xffff]], 0);
    const taken = branches.has(`${d.insn.mnemonic}/${d.form.name}@${m.mem[pc]}`) && takes(pc, d.nbytes);
    const jump = JUMP_SEM.test(d.insn.semantics ?? '');
    const exc = EXC.test(d.insn.mnemonic) ? EXC_CYCLES[d.insn.mnemonic]
              : d.insn.extra_cycles > 0 ? 4 : 0;
    const mem = memBytes(d.insn.semantics ?? '');
    const memst = mem && /^(M(8|16)\[R|base = [a-z0-9]+; M16)/.test(d.insn.semantics);
    m.step();
    if (!m.halted) trace.push({ pc, len: d.nbytes, taken, jump, mem, memst, exc, R: Array.from(m.R) });
  }
  // WHAT A STORE DID IS NOT IN ANY REGISTER, so both machines fold their whole
  // memory into one number at the halt, as tests/rtl-check.mjs does.
  let hash = 0;
  for (let k = 0; k < 65536; k++) hash = (Math.imul(hash, 31) + m.mem[k]) & 0x7fffffff;
  programs.push({ bytes, reg, trace, hash, old: m.cycles() });
  writeFileSync(`build/pipe-prog-${p}.hex`, bytes.map((b) => b.toString(16).padStart(2, '0')).join('\n') + '\n');
  writeFileSync(`build/pipe-reg-${p}.hex`, reg.map(hex4).join('\n') + '\n');
}

writeFileSync('build/pipe-tb.sv', `module tb;
    logic clk = 0, rst = 1;
    logic [7:0] mem [0:65535];
    logic [15:0] rdata;
    logic [15:0] regs [0:7];
    wire [15:0] addr, rpc;
    wire [7:0] wdata;
    wire we, halted, trapped, ret;
    pipe_cpu u (.clk(clk), .rst(rst), .mem_addr(addr), .mem_rdata(rdata),
                .mem_wdata(wdata), .mem_we(we), .irq(1'b0),
                .halted(halted), .trapped(trapped), .result(), .retire(ret), .retire_pc(rpc));
    // A word a cycle, the even byte low, as the SPRAM delivers it; a write goes
    // to the byte mem_addr names, at the same edge, and a read in that cycle
    // sees what was there before.
    always @(posedge clk) begin
        rdata <= {mem[{addr[15:1], 1'b1}], mem[{addr[15:1], 1'b0}]};
        if (we) mem[addr] <= wdata;
    end
    integer p, k, cyc, ev, epc, go, dpc, sq, h;
    reg [8*64:1] name;
    initial begin
        for (p = 0; p < ${PROGRAMS}; p = p + 1) begin
            for (k = 0; k < 65536; k = k + 1) mem[k] = 8'h00;
            $sformat(name, "build/pipe-prog-%0d.hex", p); $readmemh(name, mem);
            $sformat(name, "build/pipe-reg-%0d.hex", p);  $readmemh(name, regs);
            rst = 1;
            repeat (3) begin #1 clk = 1; #1 clk = 0; end
            for (k = 0; k < 8; k = k + 1) u.R[k] = regs[k];
            // The shadows are not reset; tools/sim.js starts them at zero.
            u.shadow_sp = 0; u.shadow_lr = 0; u.shadow_isp = 0;
            mem[${VECTOR}] = 8'h${RTI.toString(16).padStart(2, '0')};
            rst = 0; cyc = 0;
            while (!halted && !trapped && cyc < 5000) begin
                ev = ret; epc = rpc; go = u.go; dpc = u.pc; sq = u.taken_q;
                #1 clk = 1; #1 clk = 0;
                if (sq) $display("SQUASH %0d %0d", p, cyc);
                if (go) $display("DISP %0d %0d %h", p, cyc, dpc[15:0]);
                if (ev) $display("RET %0d %h %h %h %h %h %h %h %h %h", p, epc[15:0],
                                 u.R[0], u.R[1], u.R[2], u.R[3], u.R[4], u.R[5], u.R[6], u.R[7]);
                cyc = cyc + 1;
            end
            h = 0;
            for (k = 0; k < 65536; k = k + 1) h = (h * 31 + mem[k]) & 32'h7fffffff;
            $display("END %0d %0d %0d %0d %0d", p, halted, trapped, cyc, h);
        end
        $finish;
    end
endmodule
`);
const RTL = ['rtl/pipe/cpu.sv', 'rtl/pipe/classify.sv', 'rtl/pipe/alu.sv', 'rtl/pipe/ucode.sv',
             'rtl/lhs.sv', 'rtl/dest.sv', 'rtl/immgen.sv', 'rtl/cond.sv', 'rtl/compare.sv'];
execFileSync('iverilog', ['-g2012', '-o', 'build/pipe-tb.vvp', ...RTL, 'build/pipe-tb.sv'], { stdio: 'inherit' });
const out = execFileSync('vvp', ['build/pipe-tb.vvp'], { encoding: 'utf8', maxBuffer: 1 << 26 });

// AND AGAIN WITH THE SB_MAC16 THAT SYNTHESIS GETS, as tests/rtl-check.mjs does
// for rtl/alu.sv: yosys's own model of the DSP, which checks the instance's
// parameters.  Every line must be the same, less the $finish, whose time unit
// the cells' `timescale changes.
const CELLS = '/usr/share/yosys/ice40/cells_sim.v';
execFileSync('iverilog', ['-g2012', '-DPIPE_CELLS', '-o', 'build/pipe-tb.vvp', CELLS, ...RTL, 'build/pipe-tb.sv'],
             { stdio: ['ignore', 'ignore', 'inherit'] });
const trace = (text) => text.split('\n').filter((l) => !/\$finish/.test(l)).join('\n');
const outCells = execFileSync('vvp', ['build/pipe-tb.vvp'], { encoding: 'utf8', maxBuffer: 1 << 26 });
if (trace(outCells) !== trace(out)) {
  console.log('FAIL  rtl/pipe/cpu.sv: with yosys\'s SB_MAC16 it runs differently from the plain multiply');
  process.exit(1);
}

const rets = programs.map(() => []), disps = programs.map(() => []), squashes = programs.map(() => []), ends = [];
for (const line of out.split('\n')) {
  const f = line.trim().split(/\s+/);
  if (f[0] === 'RET')  rets[+f[1]].push({ pc: parseInt(f[2], 16), R: f.slice(3, 11).map((h) => parseInt(h, 16)) });
  if (f[0] === 'DISP') disps[+f[1]].push({ cyc: +f[2], pc: parseInt(f[3], 16) });
  if (f[0] === 'SQUASH') squashes[+f[1]].push(+f[2]);
  if (f[0] === 'END')  ends[+f[1]] = { halted: f[2] === '1', trapped: f[3] === '1', cyc: +f[4], hash: +f[5] };
}

let bad = 0, instructions = 0, cycNew = 0, cycOld = 0;
const complain = (msg) => { if (bad++ < 8) console.log(`  MISMATCH ${msg}`); };
programs.forEach(({ trace, hash, old }, p) => {
  if (ends[p] && ends[p].hash !== hash)
    complain(`program ${p}: memory folds to ${ends[p].hash} on the RTL and ${hash} on the simulator`);
  // A squash in cycle T undoes the dispatches of T - 2, T - 1 and T: the
  // three instructions behind the branch.
  const got = rets[p];
  const ds = disps[p].filter((d) => !squashes[p].some((t) => d.cyc >= t - 2 && d.cyc <= t));
  if (!ends[p]?.halted || ends[p]?.trapped) complain(`program ${p}: ended ${ends[p]?.trapped ? 'trapped' : 'without halting'}`);
  if (got.length !== trace.length) complain(`program ${p}: ${got.length} retired, the simulator ran ${trace.length}`);
  for (let i = 0; i < Math.min(got.length, trace.length); i++) {
    const g = got[i], t = trace[i];
    if (g.pc !== t.pc || g.R.some((v, k) => v !== t.R[k]))
      complain(`program ${p} instruction ${i} at 0x${t.pc.toString(16)}: rtl pc ${g.pc.toString(16)} r=${g.R.map(hex4).join(' ')}, sim r=${t.R.map(hex4).join(' ')}`);
    instructions++;
  }
  // The dispatch cadence: the halt is dispatched too, so there is one more
  // dispatch than retirement.
  for (let i = 1; i < Math.min(ds.length, trace.length + 1); i++) {
    const prev = trace[i - 1];
    const want = prev.exc ? prev.exc : prev.mem ? prev.mem + (prev.memst ? 4 : 3) : prev.jump ? 3 : prev.taken ? 4
               : (prev.pc & 1) && prev.len === 3 ? 2 : 1;
    if (ds[i].pc !== (trace[i]?.pc ?? ds[i].pc)) complain(`program ${p} dispatch ${i}: pc ${ds[i].pc.toString(16)}`);
    if (ds[i].cyc - ds[i - 1].cyc !== want)
      complain(`program ${p} dispatch ${i}: ${ds[i].cyc - ds[i - 1].cyc} cycles after the one at 0x${prev.pc.toString(16)}, want ${want}`);
  }
  cycNew += ends[p]?.cyc ?? 0;
  cycOld += old;
});
for (const f of ['build/pipe-tb.vvp', 'build/pipe-tb.sv']) rmSync(f, { force: true });

// --- the interrupt line -----------------------------------------------------------
// THE SAME PROGRAMS, INTERRUPTED EVERY FEW CYCLES, as tests/rtl-check.mjs does
// for rtl/cpu.sv.  The vector holds nothing but rti, so an interrupt entered
// and left must leave a program exactly as if it had never come: the same
// registers and memory at the halt as the simulator's run without one.  The
// line goes up 17 to 39 cycles after each take, at random, and down at the
// next, so interrupts land after every kind of instruction.  Not on a fixed
// period: a level-sensitive line that comes back just as the preempted
// instruction is dispatched again starves it forever.
//
// AND ONCE AT THE HALT.  The machine must go on AFTER the halt, so a second
// one is put there, and the pc must end a byte further on than it waited at.
//
// A PROGRAM THAT RAN cli may rightly take none, and one whose ie is clear at
// the halt is not woken; the simulator, started with ie set as the test bench
// sets the RTL's, says which those are.
const finals = programs.map(({ bytes, reg }) => {
  const m = new Machine(spec).load(bytes, 0);
  m.mem[VECTOR] = RTI;
  m.ie = 1;
  reg.forEach((v, k) => { m.R[k] = v; });
  let cli = false;
  for (let guard = 0; !m.halted && guard < 1000; guard++) {
    if (m.mem[m.pc] === excs[2].op) cli = true;
    m.step();
  }
  m.mem[m.pc] = HALT;                            // as the test bench puts after the halt
  let hash = 0;
  for (let k = 0; k < 65536; k++) hash = (Math.imul(hash, 31) + m.mem[k]) & 0x7fffffff;
  return { R: Array.from(m.R), hash, cli, ie: m.ie };
});
writeFileSync('build/pipe-irq-tb.sv', `module tb;
    logic clk = 0, rst = 1, irq = 0, drop;
    integer next, lfsr;
    logic [7:0] mem [0:65535];
    logic [15:0] rdata;
    logic [15:0] regs [0:7];
    wire [15:0] addr;
    wire [7:0] wdata;
    wire we, halted, trapped;
    pipe_cpu u (.clk(clk), .rst(rst), .mem_addr(addr), .mem_rdata(rdata),
                .mem_wdata(wdata), .mem_we(we), .irq(irq),
                .halted(halted), .trapped(trapped), .result(), .retire(), .retire_pc());
    always @(posedge clk) begin
        rdata <= {mem[{addr[15:1], 1'b1}], mem[{addr[15:1], 1'b0}]};
        if (we) mem[addr] <= wdata;
    end
    integer p, k, cyc, takes, h, pc1;
    reg [8*64:1] name;
    // One cycle.  With \`raise\`, the line goes up at \`next\`; it drops after
    // a take, and \`next\` is then 17 to 39 cycles on.
    task tick(input integer raise);
        begin
            if (raise && cyc == next) irq = 1;
            drop = u.take;
            if (drop) takes = takes + 1;
            #1 clk = 1; #1 clk = 0;
            if (drop) begin
                irq = 0;
                lfsr = (lfsr * 1103515245 + 12345) & 32'h7fffffff;
                next = cyc + 17 + (lfsr >> 8) % 23;
            end
            cyc = cyc + 1;
        end
    endtask
    initial begin
        for (p = 0; p < ${PROGRAMS}; p = p + 1) begin
            for (k = 0; k < 65536; k = k + 1) mem[k] = 8'h00;
            $sformat(name, "build/pipe-prog-%0d.hex", p); $readmemh(name, mem);
            $sformat(name, "build/pipe-reg-%0d.hex", p);  $readmemh(name, regs);
            mem[${VECTOR}] = 8'h${RTI.toString(16).padStart(2, '0')};
            irq = 0;
            rst = 1;
            repeat (3) begin #1 clk = 1; #1 clk = 0; end
            for (k = 0; k < 8; k = k + 1) u.R[k] = regs[k];
            u.shadow_sp = 0; u.shadow_lr = 0; u.shadow_isp = 0;
            u.ie = 1'b1;                       // as sei would
            rst = 0; cyc = 0; takes = 0; next = 5 + p % 7; lfsr = p + 1;
            while (!halted && !trapped && cyc < 50000) tick(1);
            // At the halt: a second one after it, and the line once more.
            pc1 = u.pc;
            mem[pc1] = 8'h${HALT.toString(16).padStart(2, '0')};
            irq = 1;
            k = cyc;
            while (irq && cyc < k + 50) tick(0);
            irq = 0;
            repeat (40) tick(0);
            h = 0;
            for (k = 0; k < 65536; k = k + 1) h = (h * 31 + mem[k]) & 32'h7fffffff;
            $display("IRQ %0d %0d %0d %0d %0d %h %h %h %h %h %h %h %h %0d %0d", p, halted, trapped, takes, h,
                     u.R[0], u.R[1], u.R[2], u.R[3], u.R[4], u.R[5], u.R[6], u.R[7], pc1, u.pc);
        end
        $finish;
    end
endmodule
`);
execFileSync('iverilog', ['-g2012', '-o', 'build/pipe-irq-tb.vvp',
  ...RTL, 'build/pipe-irq-tb.sv'], { stdio: 'inherit' });
const irqOut = execFileSync('vvp', ['build/pipe-irq-tb.vvp'], { encoding: 'utf8', maxBuffer: 1 << 26 });
let irqTakes = 0;
const irqSeen = new Set();
for (const line of irqOut.split('\n')) {
  const f = line.trim().split(/\s+/);
  if (f[0] !== 'IRQ') continue;
  const p = +f[1], R = f.slice(6, 14).map((x) => parseInt(x, 16)), fin = finals[p];
  irqSeen.add(p);
  irqTakes += +f[4];
  if (f[2] !== '1' || f[3] !== '0') complain(`program ${p}: ${f[3] === '1' ? 'trapped' : 'did not halt'} under interrupts`);
  if (!fin.cli && +f[4] < 1) complain(`program ${p}: no interrupt taken`);
  if (+f[5] !== fin.hash) complain(`program ${p}: memory folds to ${f[5]} under interrupts and ${fin.hash} without`);
  if (fin.ie && +f[15] !== +f[14] + 1)
    complain(`program ${p}: waited at 0x${(+f[14]).toString(16)} and ended at 0x${(+f[15]).toString(16)}, not a byte on, after the interrupt at the halt`);
  if (R.some((v, k) => v !== fin.R[k]))
    complain(`program ${p}: r=${R.map(hex4).join(' ')} under interrupts, sim r=${fin.R.map(hex4).join(' ')}`);
}
if (irqSeen.size !== PROGRAMS) complain(`${PROGRAMS - irqSeen.size} programs printed nothing under interrupts`);
for (const f of ['build/pipe-irq-tb.vvp', 'build/pipe-irq-tb.sv']) rmSync(f, { force: true });
if (!process.env.PIPE_KEEP) for (let p = 0; p < PROGRAMS; p++) for (const f of [`build/pipe-prog-${p}.hex`, `build/pipe-reg-${p}.hex`]) rmSync(f, { force: true });

if (bad === 0) {
  const taken = programs.reduce((n, { trace }) => n + trace.filter((t) => t.taken).length, 0);
  const jumped = programs.reduce((n, { trace }) => n + trace.filter((t) => t.jump).length, 0);
  const moved = programs.reduce((n, { trace }) => n + trace.filter((t) => t.mem).length, 0);
  console.log(`ok    rtl/pipe/cpu.sv: ${PROGRAMS} programs, ${instructions} instructions over `
            + `${all.length + brs.length + jumps.length + loads.length + stores.length} forms, `
            + `${taken} branches taken, ${jumped} jumps, ${moved} memory instructions; `
            + `registers, memory and dispatch cadence agree with tools/sim.js`);
  console.log(`      ${cycNew} cycles to halt, against ${cycOld} on the byte-serial cost model `
            + `(${(cycOld / cycNew).toFixed(2)}x fewer)`);
  console.log(`ok    rtl/pipe/cpu.sv, interrupted: ${PROGRAMS} programs under ${irqTakes} interrupts, `
            + `the last at each halt, end as tools/sim.js does without them`);
} else {
  console.log(`FAIL  rtl/pipe/cpu.sv: ${bad} disagreements with tools/sim.js`);
  process.exit(1);
}
