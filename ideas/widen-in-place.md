# Extend a byte in place

A GCC pass for the fructus port, run before register allocation, that lets
`and rd, rd, #0x00ff` be used where GCC now emits the three-byte
`and rd, ra, #255`.

## The case

```c++
char isFoo(char x) {
  switch (x) {
    case 42: case 43: case 44: case 45: case 46:
      return x;
    default:
      return -1;
  }
}
```

compiles at `-Os` to 14 bytes:

```
and     r1, r0, #255    ; 3 bytes: imm10
add     r1, r1, #-42    ; 3
mov     r5, #4          ; 2
br      ls, r1, r5, 1f  ; 3
mov     r0, #-1         ; 2
1: ret                  ; 1
```

and could be 13:

```
and     r0, r0, #0x00ff ; 2 bytes: immask5, tied
add     r1, r0, #-42    ; 3
...
```

The `and` is needed. The ABI (`isa/abi.s`, "8-bit arguments") leaves the high
byte of a byte argument unspecified, and the range test is a 16-bit unsigned
compare. Writing the extension back into `r0` is legal for the same reason: a
returned `char` has unspecified high bits too, so a cleared high byte is as
good as the original.

## Why GCC does not find it

The port already knows the lengths. `zero_extendqihi2` in `fructus.md` says 2
bytes tied and 3 untied, and nothing else has to be taught there. The
allocator never gets the choice because of how the RTL describes the values:

```
insn 7:  (set (reg:HI 20 [_1]) (zero_extend:HI (reg/v:QI 19 [x])))
insn 8:  (set (reg:HI 21) (plus:HI (reg:HI 20) (const_int -42)))
insn 4:  (set (reg/v:QI 19 [x]) (const_int -1))          ; default path
insn 18: (set (reg/i:QI 0 r0) (reg/v:QI 19 [x]))         ; return x
```

Pseudo 19 (`x`) is live past insn 7, to the return. Pseudo 20 (`zext(x)`) is
a different value. Two values live at once need two registers, so 20 cannot
take 19's register, and the tied alternative never applies. Nothing in the
RTL says that the only later reads of 19 are of its low byte, which
`zext(x)` holds too.

No generic GCC pass makes that rewrite. `ree` and `ext-dce` delete
extensions; neither reuses an extension's result for the value it extended.

## The rewrite

For a QImode pseudo `X` extended by exactly one insn `E` into an HImode pseudo
`Y`:

1. Make a new HImode pseudo `W`.
2. Replace every occurrence of `X`, definitions and uses alike, with
   `(subreg:QI (reg:HI W) 0)`.
3. Rewrite `E` as `(set W (zero_extend:HI (subreg:QI W 0)))`, or with
   `sign_extend`.
4. Replace every use of `Y` with `W`, and delete `Y`.

`X` and `Y` become one pseudo with one live range, and the extension is now a
two-address insn that the tied alternative matches. In the example the
argument copy, the extension and the return all move `W` to and from `r0`, so
IRA's copy preferences should place `W` in `r0` and choose the 2-byte form.
That outcome has to be checked in the dumps, not assumed.

### Why it is correct

- **A definition through the lowpart subreg is a full definition.**
  `UNITS_PER_WORD` is 2, so `W` is one word. A store to a subreg narrower than
  a word leaves the rest of the word undefined (GCC internals, "subreg"). That
  is exactly the ABI's "high byte unspecified", so the definitions of `X` lose
  nothing by becoming definitions of `W`.
- **Every old read of `X` was QImode**, so reading the low byte of `W` gives
  the same value whether or not `E` has run on that path. On the default path
  above, `W`'s low byte is `-1` and its high byte is garbage, and the return
  reads only the low byte.
- **After `E`, `W` holds `Y`'s value**, provided nothing writes `W` between
  `E` and a use of `Y`. That is the condition to check.

### Conditions

Rewrite only when all of these hold. Otherwise skip, and the code is as it is
now.

- `X` is a pseudo in QImode, and its address is never taken
  (no `MEM` of it, no `REG_EQUIV` to memory).
- `Y` has exactly one definition, `E`, and `E` is `zero_extend:HI` or
  `sign_extend:HI` of `X`.
- `X` has exactly one extension. If CSE left a `zero_extend` and a
  `sign_extend` of the same `X`, rewrite neither.
- No definition of `X` lies on a path from `E` to any use of `Y`. A
  conservative first version only needs `E` and every use of `Y` in one basic
  block with no definition of `X` between them, and that covers the case
  above. Reaching definitions from DF (`df_chain`) can relax it later.
- `X` appears nowhere except as a plain `(reg:QI X)`. A subreg of `X`, a
  `strict_low_part`, or an `asm` operand means skip.

## Where it runs

After `combine`, so that `*movhi_<code>_zext` and the other combined patterns
in `fructus.md` have already claimed the extensions they absorb, and before
`ira`. `split1` also comes earlier, so no later split re-creates the pattern.

The port registers no passes of its own yet. The plumbing, as other ports do
it:

- `config/fructus/fructus-passes.def`:
  `INSERT_PASS_BEFORE (pass_ira, 1, pass_fructus_widen_in_place);`
- `config/fructus/t-fructus` sets `PASSES_EXTRA += $(srcdir)/config/fructus/fructus-passes.def`,
  plus a build rule if the pass gets its own `.cc`.
- `config.gcc`: `tmake_file="${tmake_file} fructus/t-fructus"` in the
  `fructus-*-elf*` entry, and `extra_objs` for a separate source file.
- `make_pass_fructus_widen_in_place` declared in `fructus-protos.h`.

A separate `fructus-widen.cc` keeps `fructus.cc` from growing; the pass is a
loop over insns plus the condition checks.

## What it is worth

- **Zero extension:** 1 byte for each extension that the allocator can now
  tie. `and rd, ra, #255` is imm10 and 3 bytes, while `and rd, rd, #0x00ff`
  is immask5 and 2 bytes (`isa/fructus.toml`, "There is no zxt8").
- **Sign extension:** `sxt8 rd, ra` is 2 bytes either way, so no byte saved
  in the instruction. Merging the two pseudos still frees a register, which
  can save a spill or a move in a function short of registers.
- **Where it applies:** a `char` argument that is tested as a 16-bit value and
  then returned or passed on. The character class tests that `abi.s` gives as
  its example of a small leaf function are this shape.

## Testing

- `isFoo` above: 13 bytes, with `and r0, r0, #0x00ff`.
- The same with `signed char`, and with an argument that is passed on to a
  call rather than returned.
- A function where a definition of `X` sits between `E` and a use of `Y`:
  must be skipped, and still correct.
- `just torture -Os` and `just torture -O2`. The pass touches every function
  with a byte argument, so wrong code will show up there first.
- `just test`, and a size comparison of the compiled tests and benchmarks
  before and after. A growth anywhere means the merged live range cost more
  than the tie saved, and the condition list needs a cost check.

## Risks

- **A longer live range.** `W` lives from the first definition of `X` to the
  last use of `Y`, where before two shorter ranges covered the same span.
  Because `X` and `Y` overlapped anyway, this should never raise register
  pressure, but the size comparison is what proves it.
- **Missed tie.** If IRA still gives `W` a register other than `r0`, the pass
  costs nothing but saves nothing. In that case look at the copy costs before
  adding anything to the pass.
