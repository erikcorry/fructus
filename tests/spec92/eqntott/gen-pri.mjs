#!/usr/bin/env node
// gen-pri.mjs - an interrupt priority encoder, in eqntott's equations
//
//   node tests/spec92/eqntott/gen-pri.mjs N [grants] > pri.eqn
//
// SPEC92's input was int_pri_3.eqn, an interrupt priority encoder, which SPEC
// never published.  This is one of the same kind: N request lines r0..rN-1,
// each with an enable e0..eN-1, and request i is taken when it is raised and
// enabled and no higher one is.  The outputs are the number of the request
// taken, in binary, and whether there is one; with `grants', also each
// request's own grant line, one-hot, as a controller drives them.
//
// Each output is one expression over the inputs, and that is where the work
// is: "no higher request" is the complement of an OR of ANDs, which De Morgan
// turns into a product of sums, and multiplying that out gives each grant
// 2^(N-1-i) product terms for the reduction to sort and merge.

const n = Number(process.argv[2] || 8);
const bits = Math.max(1, Math.ceil(Math.log2(n)));
const grants = process.argv[3] === 'grants';
const lines = [];
const ins = [], outs = [];
for (let i = 0; i < n; i++) ins.push(`r${i}`, `e${i}`);
for (let k = bits - 1; k >= 0; k--) outs.push(`level${k}`);
outs.push('irq');
if (grants) for (let i = n - 1; i >= 0; i--) outs.push(`g${i}`);

lines.push(`NAME = pri${n};`);
lines.push(`INORDER = ${ins.join(' ')};`);
lines.push(`OUTORDER = ${outs.join(' ')};`);
const act = i => `r${i} & e${i}`;
const grant = i => {
  const higher = [];
  for (let j = i + 1; j < n; j++) higher.push(`(${act(j)})`);
  return `(${act(i)}` + (higher.length ? ` & !(${higher.join(' | ')})` : '') + ')';
};
for (let k = bits - 1; k >= 0; k--) {
  const g = [];
  for (let i = 0; i < n; i++) if (i >> k & 1) g.push(grant(i));
  lines.push(`level${k} = ${g.length ? g.join(' |\n\t') : 'ZERO'};`);
}
const all = [];
for (let i = 0; i < n; i++) all.push(`(${act(i)})`);
lines.push(`irq = ${all.join(' | ')};`);
if (grants) for (let i = n - 1; i >= 0; i--) lines.push(`g${i} = ${grant(i)};`);
console.log(lines.join('\n'));
