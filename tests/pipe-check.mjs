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
// Needs iverilog; skips without it.
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
// One register written, no memory, no second statement, and single-cycle in
// the spec - less mul, which the experiment leaves out.  nop comes too.
const forms = new Map();
for (let op = 0; op < 256; op++)
  for (let b1 = 0; b1 < 256; b1++) {
    const d = decode(dec, [op, b1, 0], 0);
    if (!d) continue;
    const sem = d.insn.semantics ?? '';
    const ok = d.insn.mnemonic === 'nop'
            || (/^R\[[a-z]\] = /.test(sem) && !/M(8|16)\[|;/.test(sem)
                && !(d.insn.extra_cycles > 0) && d.insn.mnemonic !== 'mul');
    if (!ok) continue;
    const key = `${d.insn.mnemonic}/${d.form.name}@${op}`;
    if (!forms.has(key)) forms.set(key, { op, nbytes: d.nbytes, b1s: [] });
    forms.get(key).b1s.push(b1);
  }
const all = [...forms.values()];

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

const N_RANDOM = 60;
const PROGRAMS = N_RANDOM + assembled.length;
const programs = [];
mkdirSync('build', { recursive: true });
for (let p = 0; p < PROGRAMS; p++) {
  let bytes;
  if (p < N_RANDOM) {
    // The first program has every form twice, once from each alignment;
    // after that, one instruction in five is a branch.
    const picks = p === 0 ? shuffle([...all, ...brs, ...jumps, NOP, ...all, ...brs, ...jumps])
                          : Array.from({ length: 40 }, () => {
                              const r = rnd() % 10;
                              return r < 2 ? brs[rnd() % brs.length]
                                   : r < 3 ? jumps[rnd() % jumps.length]
                                   : all[rnd() % all.length];
                            });
    bytes = layout(picks).concat([HALT]);
  } else {
    bytes = assembled[p - N_RANDOM];
  }
  const reg = Array.from({ length: 8 }, val);
  const m = new Machine(spec).load(bytes, 0);
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
    m.step();
    if (!m.halted) trace.push({ pc, len: d.nbytes, taken, jump, R: Array.from(m.R) });
  }
  programs.push({ bytes, reg, trace, old: m.cycles() });
  writeFileSync(`build/pipe-prog-${p}.hex`, bytes.map((b) => b.toString(16).padStart(2, '0')).join('\n') + '\n');
  writeFileSync(`build/pipe-reg-${p}.hex`, reg.map(hex4).join('\n') + '\n');
}

writeFileSync('build/pipe-tb.sv', `module tb;
    logic clk = 0, rst = 1;
    logic [7:0] mem [0:65535];
    logic [15:0] rdata;
    logic [15:0] regs [0:7];
    wire [15:0] addr;
    wire halted, trapped;
    pipe_cpu u (.clk(clk), .rst(rst), .mem_addr(addr), .mem_rdata(rdata),
                .halted(halted), .trapped(trapped), .result());
    // A word a cycle, the even byte low, as the SPRAM delivers it.
    always @(posedge clk) rdata <= {mem[{addr[15:1], 1'b1}], mem[{addr[15:1], 1'b0}]};
    integer p, k, cyc, ev, epc, go, dpc, sq;
    reg [8*64:1] name;
    initial begin
        for (p = 0; p < ${PROGRAMS}; p = p + 1) begin
            for (k = 0; k < 65536; k = k + 1) mem[k] = 8'h00;
            $sformat(name, "build/pipe-prog-%0d.hex", p); $readmemh(name, mem);
            $sformat(name, "build/pipe-reg-%0d.hex", p);  $readmemh(name, regs);
            rst = 1;
            repeat (3) begin #1 clk = 1; #1 clk = 0; end
            for (k = 0; k < 8; k = k + 1) u.R[k] = regs[k];
            rst = 0; cyc = 0;
            while (!halted && !trapped && cyc < 5000) begin
                ev = u.e_valid & ~u.taken_q; epc = u.e_pc; go = u.go; dpc = u.pc; sq = u.taken_q;
                #1 clk = 1; #1 clk = 0;
                if (sq) $display("SQUASH %0d %0d", p, cyc);
                if (go) $display("DISP %0d %0d %h", p, cyc, dpc[15:0]);
                if (ev) $display("RET %0d %h %h %h %h %h %h %h %h %h", p, epc[15:0],
                                 u.R[0], u.R[1], u.R[2], u.R[3], u.R[4], u.R[5], u.R[6], u.R[7]);
                cyc = cyc + 1;
            end
            $display("END %0d %0d %0d %0d", p, halted, trapped, cyc);
        end
        $finish;
    end
endmodule
`);
execFileSync('iverilog', ['-g2012', '-o', 'build/pipe-tb.vvp',
  'rtl/pipe/cpu.sv', 'rtl/pipe/classify.sv', 'rtl/pipe/alu.sv',
  'rtl/lhs.sv', 'rtl/dest.sv', 'rtl/immgen.sv', 'rtl/cond.sv', 'rtl/compare.sv',
  'build/pipe-tb.sv'], { stdio: 'inherit' });
const out = execFileSync('vvp', ['build/pipe-tb.vvp'], { encoding: 'utf8', maxBuffer: 1 << 26 });

const rets = programs.map(() => []), disps = programs.map(() => []), squashes = programs.map(() => []), ends = [];
for (const line of out.split('\n')) {
  const f = line.trim().split(/\s+/);
  if (f[0] === 'RET')  rets[+f[1]].push({ pc: parseInt(f[2], 16), R: f.slice(3, 11).map((h) => parseInt(h, 16)) });
  if (f[0] === 'DISP') disps[+f[1]].push({ cyc: +f[2], pc: parseInt(f[3], 16) });
  if (f[0] === 'SQUASH') squashes[+f[1]].push(+f[2]);
  if (f[0] === 'END')  ends[+f[1]] = { halted: f[2] === '1', trapped: f[3] === '1', cyc: +f[4] };
}

let bad = 0, instructions = 0, cycNew = 0, cycOld = 0;
const complain = (msg) => { if (bad++ < 8) console.log(`  MISMATCH ${msg}`); };
programs.forEach(({ trace, old }, p) => {
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
    const want = prev.jump ? 3 : prev.taken ? 4 : (prev.pc & 1) && prev.len === 3 ? 2 : 1;
    if (ds[i].pc !== (trace[i]?.pc ?? ds[i].pc)) complain(`program ${p} dispatch ${i}: pc ${ds[i].pc.toString(16)}`);
    if (ds[i].cyc - ds[i - 1].cyc !== want)
      complain(`program ${p} dispatch ${i}: ${ds[i].cyc - ds[i - 1].cyc} cycles after the one at 0x${prev.pc.toString(16)}, want ${want}`);
  }
  cycNew += ends[p]?.cyc ?? 0;
  cycOld += old;
});
for (let p = 0; p < PROGRAMS; p++) for (const f of [`build/pipe-prog-${p}.hex`, `build/pipe-reg-${p}.hex`]) rmSync(f, { force: true });
for (const f of ['build/pipe-tb.vvp', 'build/pipe-tb.sv']) rmSync(f, { force: true });

if (bad === 0) {
  const taken = programs.reduce((n, { trace }) => n + trace.filter((t) => t.taken).length, 0);
  const jumped = programs.reduce((n, { trace }) => n + trace.filter((t) => t.jump).length, 0);
  console.log(`ok    rtl/pipe/cpu.sv: ${PROGRAMS} programs, ${instructions} instructions over ${all.length + brs.length + jumps.length} forms, `
            + `${taken} branches taken, ${jumped} jumps; registers and dispatch cadence agree with tools/sim.js`);
  console.log(`      ${cycNew} cycles to halt, against ${cycOld} on the byte-serial cost model `
            + `(${(cycOld / cycNew).toFixed(2)}x fewer)`);
} else {
  console.log(`FAIL  rtl/pipe/cpu.sv: ${bad} disagreements with tools/sim.js`);
  process.exit(1);
}
