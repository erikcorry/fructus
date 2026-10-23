// LUT DEPTH ON THE PATHS THE OPCODE MAP WAS ARRANGED FOR.
//
// Some decodes sit on the processor's slowest paths, and their depth is a
// property of where the opcodes are, not of how the RTL is written: moving
// one opcode can put a LUT on the path into the fetch, and abc then maps the
// whole design to the longer delay (a jmp ra predictor, since removed, once
// decoded 0xb2/0x09/0xb3/0x0a, nothing in common, and cost 2 MHz).  So the depth is
// held here, where an opcode move that breaks it fails a test, rather than
// in a seed sweep that shows it as a MHz median.
//
//   rtl/cpu.sv's prr      the ret guess's recognizer: in three LUTs from the
//                         buffer's word and pcl[0], and it must pick out
//                         exactly what the spec says is ret
//   rtl/classify.sv len   the length decode, len[1] in one LUT and len[0]
//                         in two: the fetcher's next pointer adds it
//
// Each is synthesized alone by yosys's synth_ice40 - the recognizer's lines
// lifted out of rtl/cpu.sv into a module of the test's own, since as a
// module in cpu.sv it measured a MHz and more slower - and the depth is
// counted in SB_LUT4s from its input ports to each output bit.  The netlist
// is then evaluated over every input, against tools/decode.js, so the depth
// measured is the depth of the right function.
import { loadSpec } from '../tools/isa.js';
import { buildDecoder, decode } from '../tools/decode.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';

const spec = loadSpec('isa/fructus.toml');
const dec = buildDecoder(spec);
let fail = 0;

try { execFileSync('yosys', ['-V'], { stdio: 'ignore' }); } catch {
  console.log('skip  LUT depth: yosys not found');
  process.exit(0);
}

// One module through synth_ice40, as a netlist: its ports, its LUTs, and for
// every output bit its depth and a function of the inputs.
function synth(files, top) {
  mkdirSync('build', { recursive: true });
  const json = `build/depth-${top}.json`;
  try {
    execFileSync('yosys', ['-q', '-p', `read_verilog -sv ${files.join(' ')}; synth_ice40 -top ${top}; write_json ${json}`],
                 { stdio: 'pipe' });
  } catch (e) { process.stdout.write(e.stdout + e.stderr); throw e; }
  const m = JSON.parse(readFileSync(json, 'utf8')).modules[top];
  rmSync(json, { force: true });
  const drv = {};
  for (const c of Object.values(m.cells)) {
    if (c.type === '$scopeinfo') continue;   // where a flattened instance was
    if (c.type !== 'SB_LUT4') throw new Error(`${top}: a ${c.type}, which this check does not count`);
    drv[c.connections.O[0]] = c;
  }
  const memo = {};
  const depth = (b) => typeof b === 'string' ? 0 : b in memo ? memo[b]
    : (memo[b] = drv[b] ? 1 + Math.max(...['I0', 'I1', 'I2', 'I3'].map((p) => depth(c(b)[p][0]))) : 0);
  const c = (b) => drv[b].connections;
  // The value of bit b with the input ports' bits set from `inp`.
  const value = (b, inp) => {
    if (b === '0' || b === 'x') return 0;
    if (b === '1') return 1;
    if (b in inp) return inp[b];
    const l = drv[b];
    const k = ['I0', 'I1', 'I2', 'I3'].reduce((s, p, i) => s | value(l.connections[p][0], inp) << i, 0);
    const init = l.parameters.LUT_INIT;   // a binary string, bit 0 last
    return +init[init.length - 1 - k];
  };
  const out = (name) => m.ports[name].bits;
  const run = (ins) => {
    const inp = {};
    for (const [name, v] of Object.entries(ins)) m.ports[name].bits.forEach((b, i) => { inp[b] = v >> i & 1; });
    return (name) => out(name).reduce((s, b, i) => s | value(b, inp) << i, 0);
  };
  return { depth: (name, i = 0) => depth(out(name)[i]), run, luts: Object.keys(drv).length };
}

const hold = (what, got, most) => {
  if (got > most) { console.log(`FAIL  ${what}: ${got} LUTs deep, at most ${most}`); fail++; }
  return got;
};

// --- the ret guess's recognizer -----------------------------------------------
{
  // prr, as rtl/cpu.sv writes it, from iw[0] and pcl[0].
  const lines = readFileSync('rtl/cpu.sv', 'utf8').match(/^\s*wire\s+prr\s*=[^;]*;/gm) ?? [];
  if (lines.length !== 1) throw new Error(`rtl/cpu.sv: ${lines.length} of the recognizer's one wire found`);
  writeFileSync('build/depth-ret.sv', `module ret_op (input logic [15:0] w, input logic odd, output logic ret);
    logic [15:0] iw [0:0];
    logic [15:0] pcl;
    assign iw[0] = w;
    assign pcl = {15'b0, odd};
${lines.join('\n')}
    assign ret = prr;
endmodule
`);
  const ro = synth(['build/depth-ret.sv'], 'ret_op');
  rmSync('build/depth-ret.sv', { force: true });
  const dr = hold('rtl/cpu.sv prr', ro.depth('ret'), 3);
  // What the spec says each opcode is: a return or not.
  const want = [];
  for (let op = 0; op < 256; op++) {
    let sem = null;
    for (let b1 = 0; b1 < 256 && sem === null; b1++) {
      const d = decode(dec, [op, b1, 0], 0);
      if (d) sem = d.insn.semantics ?? '';
    }
    want.push(/^pc = lr$/.test(sem));
  }
  let bad = 0;
  for (let op = 0; op < 256; op++) for (const odd of [0, 1]) {
    // The other byte of the word, which must not matter.
    const r = [0x00, 0x08, 0x02, 0xff].map((other) => ro.run({ w: odd ? other | op << 8 : op | other << 8, odd }))
                                       .find((r) => r('ret') !== +want[op]);
    if (r && bad++ < 4)
      console.log(`  0x${op.toString(16).padStart(2, '0')} ${odd ? 'odd' : 'even'}: ret ${r('ret')}, the spec says ${want[op] ? 'ret' : 'not'}`);
  }
  const named = want.map((k, op) => k && `0x${op.toString(16).padStart(2, '0')}`).filter(Boolean);
  if (bad) { console.log(`FAIL  rtl/cpu.sv prr: ${bad} disagreements with the spec`); fail++; }
  else if (dr <= 3)
    console.log(`ok    rtl/cpu.sv prr: ${named.join(' ')} and nothing else, ${dr} LUTs deep; ${ro.luts} LUTs`);
}

// --- the length decode ------------------------------------------------------
{
  // As rtl/cpu.sv's cl0 and cl1 have it: the length and nothing else, which
  // alone is a different and much deeper circuit.
  writeFileSync('build/depth-len.sv', `module len_only (input logic [7:0] op, output logic [1:0] len);
    classify c (.op(op), .len(len));
endmodule
`);
  const cl = synth(['rtl/classify.sv', 'build/depth-len.sv'], 'len_only');
  rmSync('build/depth-len.sv', { force: true });
  const d1 = hold('rtl/classify.sv len[1]', cl.depth('len', 1), 1);
  const d0 = hold('rtl/classify.sv len[0]', cl.depth('len', 0), 2);
  let bad = 0;
  for (let op = 0; op < 256; op++) {
    let len = 0;
    for (let b1 = 0; b1 < 256 && !len; b1++) len = decode(dec, [op, b1, 0], 0)?.nbytes ?? 0;
    if (len && cl.run({ op })('len') !== len) bad++;
  }
  if (bad) { console.log(`FAIL  rtl/classify.sv len: ${bad} opcodes the wrong length`); fail++; }
  else if (d1 <= 1 && d0 <= 2) console.log(`ok    rtl/classify.sv len: len[1] ${d1} LUT deep, len[0] ${d0}`);
}

process.exit(fail ? 1 : 0);
