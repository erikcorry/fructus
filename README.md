# Fructus

A 16-bit retrocomputer instruction set, and the toolchain that keeps it honest.

Eight registers, byte-granular instructions of one to three bytes, no carry
flag, no condition codes, and a 64 KiB address space. It is meant to run on the
kind of machine a 6502 ran on — a narrow memory bus where every instruction byte
is a cycle you pay for — so the design question behind almost every decision in
here is *what does this cost in bytes*.

Right now: **98 encoding forms over 128 of the 256 first bytes, 128 free.**

![The Fructus opcode map: 128 assigned first bytes in an eight-column grid, coloured by addressing mode, with a key](docs/opcodes.svg)

Both this and an interactive version with per-cell tooltips come from
`npm run map`.

## The one idea

[`isa/fructus.toml`](isa/fructus.toml) is the single source of truth. It holds
every encoding, every operand type, and what every instruction *does*. The
assembler, the decoder and the simulator are all generated from it or driven by
it, so none of them can drift away from the spec or from each other.

It is also, deliberately, a document. The file is about two thirds prose: what
each decision cost, what was rejected, and why. If you only read one thing, read
that file top to bottom.

The one hand-maintained view left in it — the opcode map in the header comment —
is checked against the encodings below it by `npm run check`, because it had
already drifted once and nothing caught it.

## Quick start

You need [customasm](https://github.com/hlorenzi/customasm) (Rust, Apache-2.0)
on your `PATH`:

```sh
cargo install customasm        # or grab a release binary
npm install                    # one dependency: a TOML parser
npm run gen                    # generate build/fructus.asm from the spec
npm test                       # 83 checks, ~800,000 assertions
```

Then assemble and run something. `customasm` takes several input files, so the
generated ruledef goes first:

```sh
customasm -q build/fructus.asm myprog.s -f binary -o build/myprog.bin
npm run sim -- build/myprog.bin --trace
```

```
0000  mov r0, #10          r0=0000 r1=0000 r2=0000 ... r6=fffe r7=0000
0002  mov r1, #0           r0=000a r1=0000 ...
0004  add r1, r1, r0       r0=000a r1=0000 ...
0005  add r0, r0, #-1      r0=000a r1=000a ...
0006  br   ne, r0, #0, 0x0004   r0=0009 r1=000a ...
halted after 33 instructions
```

The registers on each line are the state *entering* that instruction — what it
reads, not what it produced.

### Notation

Three spellings in the assembly language have no opcode behind them. They are
`[[alias]]` entries in `isa/fructus.toml`, not rules in the generator, because
the spec is what defines the language:

| you write | it assembles as | why |
|---|---|---|
| `mov rd, rs` | `or rd, rs, #0` | there is no move opcode; `or` with zero is a copy |
| `sub rd, ra, rb` | `rsb rd, rb, ra` | one subtract opcode, sources swapped |
| `sub rd, ra, #k` | `add rd, ra, #-k` | …and the immediate negated |
| `ld rd, [ra]` | `ld rd, [ra, #0]` | the offset is a field of the encoding, so `#0` is just typing |

The last one covers `ld`, `ld8`, `st` and `st8`. Rewriting happens *before*
form selection, so the shorthand still reaches the shortest encoding —
`ld r0, [r0]` is one byte, the pinned abbreviation at `0x02`.

Disassembly prints the long form in every case except `mov`. A listing read
beside a hex dump should show every field the bytes carry, and an offset field
that is zero is still an offset field.

## What's here

```
isa/fructus.toml      the ISA: encodings, operand types, semantics, rationale
isa/abi.s             the calling convention, as a file that assembles
isa/mos6502.toml      the NMOS 6502 opcode table, for comparison - not part of Fructus
tools/                the toolchain, all driven by the TOML
rtl/                  hardware, generated from the spec - see below
libc/                 a tiny libc, sized for a machine with 64K
snippets/             worked routines, with their byte counts measured
tangerine/            the Microtan monitor ROM
tests/                the test suite
```

### Tools

| | |
|---|---|
| `npm run check` | validates the six encoding invariants, prints the opcode census |
| `npm run gen` | emits `build/fructus.asm`, a customasm ruledef |
| `npm run sim -- <bin>` | runs a flat binary. `--trace`, `--pc`, `--sp`, `--max` |
| `npm run microtan -- <rom>` | runs a ROM on the simulated board |
| `npm run map` | the opcode map: `build/opcodes.html` and `docs/opcodes.svg` |
| `npm run map6502` | the same map for the NMOS 6502: `build/6502.html` and `docs/6502.svg` |
| `npm run rtl` | `rtl/immgen.sv` and `rtl/rhs.sv`, from the spec's value tables |
| `npm test` | everything, `npm run check` included |

Heading for hardware: [docs/fpga-toolchain.md](docs/fpga-toolchain.md) is the
open-source iCE40 toolchain, how to install it and the two things that catch
you out.

### rtl/

Generated, not written. `rtl/immgen.sv` produces the 16-bit immediate right-hand
side for every instruction that has one — the ALU and shift groups, `mov`, the
load and store displacements, `brclear`/`brset`, and the packed branch's
`condimm5` constant — from `immreg`, `opcode[2:0]` and one control line. 109
LUT4 and three LUT levels on an iCE40 UP5K.

It costs that little because of properties of the *values* in the spec, not of
the circuit: `immbit5` and `immask5` are each sixteen entries plus their exact
complements, so the two share one complement layer; and `shift3` is `imm3`
masked to four bits, which is what the shifter does anyway, so there is no
`shift3` table in hardware at all. Both are checked by `npm run check`, which
names the hardware cost when an edit breaks them.

`rtl/rhs.sv` puts **one four-bit microcode field** on top of it, choosing a
register, a constant, or immgen in one of its two readings:

```
 0  r0         4  reserved     8  #0      12  immgen, as condimm5
 1  r1         5  r5           9  #1      13  port B, from the bytes
 2  reserved   6  sp          10  #2      14  #-2
 3  reserved   7  lr          11  immgen  15  #-1
```

The encoding is what makes it nearly free. `src[3]=0` is a register and
`src[2:0]` *is* its number, so `regnum` is wiring; `src[3]=1` reads `src[2:0]` as
a 3-bit **signed** constant, so `konst` is one signal fanned out thirteen ways.
That is why `#-2` and `#-1` sit at 14 and 15 rather than in numeric order. Two
cells more than the four separate control bits it replaces, at the same depth,
for a microcode bit back — and the three reserved codes cost nothing to reserve,
since they decode as r2/r3/r4 today and the microcode never emits them.

The constants are exactly what the one-byte abbreviations need, and `npm run
rtl` fails if a new one needs something outside them.

`rtl/unary.sv` is the eight-way unary block — `sxt8`, `zxt8`, `clz`, `bitrev`,
`popcount`, and three free slots. Its selector is `{byte1[1:0], opcode[0]}`, the
same three bits that carry ALU port B, so it needs no decode of its own. Only
the selector table is generated: adding an operation to the spec fails the build
rather than silently producing a block that doesn't implement it. 95 LUT4, five
LUT levels, 56 MHz.

`bitrev` is a permutation of sixteen nets and `sxt8`/`zxt8` are a fanout and a
constant, so the block's entire cost is `clz`, `popcount` and the mux. Both of
those are written the cheap way, and both have a note in the file saying what
the alternative was and what it measured.

Port B's register number comes off the instruction bytes rather than out of
immgen, so the register file's read overlaps the immediate unit instead of
waiting for it — four LUT levels and 38 MHz against six and 31, with a real 8×16
file behind it. That is also why immgen drives `x` at `+6`/`+7`: nothing reads
it there, and an `x` reaching the ALU means the microcode asked for an immediate
from an instruction that has none.

The suite regenerates the file and fails if the committed copy has drifted, then
runs 378,320 vectors — built from the same TOML by a path sharing no code with
the generator — against them under `iverilog`, skipping if `iverilog` is absent.
The unary operations are swept over their *whole* input space, all 65536 values
each, because a sampled sweep misses exactly the interesting inputs: dropping
popcount's carry-free top bit is wrong for one input in 65536, `0xffff`.
All sixteen source codes are swept, the reserved three included, so a change
that gives them a meaning has to say so there rather than silently altering
what they do.
It also decodes real bytes with `tools/decode.js` to confirm that
`{byte1[1:0], opcode[0]}` really is ALU port B for every three-operand form,
which is what the `+6`/`+7` output claims.

`tools/isa.js` reads the spec; `tools/decode.js` turns bytes back into
operands; `tools/sim.js` executes the `semantics` expressions. The generator and
the decoder share only the code that reads an `encoding` string — below that
they are independent implementations of the same table, going in opposite
directions.

### Tests

The suite is layered, and each layer catches something the one below it cannot.

- **It assembles.** Proves an encoding exists. Says nothing about whether it is
  the right one.
- **It round-trips.** `tests/roundtrip.mjs` assembles, decodes with
  `tools/decode.js`, re-assembles, and compares bytes. Two independent readings
  of the encoding checked against each other — this catches a field gathered in
  the wrong order or a signed immediate read unsigned, which validate clean and
  round-trip wrong.
- **It computes the right answer.** `tests/sim-check.mjs` runs the actual
  assembled snippets on the simulator against exact BigInt arithmetic — not
  another transcription of the algorithm.
- **The board works.** `tests/microtan-check.mjs` checks reset, the ROM window,
  the keyboard handshake and the display.
- **It survives every placement.** `tests/libc-check.mjs` runs `libc/` against
  a reference built from a snapshot rather than a second copy of the algorithm,
  sweeping every overlap of source and destination in a window, at two bases and
  across the 0x8000 sign boundary. Two things the sweep depends on are asserted
  rather than assumed: no placement may leave the window, and the fill may not
  resemble a shifted copy of itself — a fill with a period, or merely with runs
  of equal bytes, makes a wrong-direction copy invisible. It also checks which
  loop `memmove` picked, since a version that always copies downwards writes
  exactly the right bytes and is three times slower.
- **It is still as fast as the comment claims.** The `memcpy` ladder in
  `snippets/memcpy.s` is executed at sixteen lengths and its cost is measured,
  by differencing two buffer sizes so the setup cancels and the loop alone
  shows. A rung that gets slower fails the suite. Prose about performance is the
  thing in this repo most likely to go quietly stale.

`tests/fpadd-check.mjs` and `tests/fpsub-check.mjs` are hand-written mirrors of
two snippets. They predate the simulator and are kept for their exhaustiveness —
a 47-million-combination sweep of two carry conditions, past what running real
code case by case reaches.

## The machine

`tools/microtan.js` puts the core on a board shaped like the Microtan 65, a 1979
single-board 6502 from Tangerine Computer Systems:

```
0x0001           keyboard port, one byte
0x0200 - 0x03ff  screen, 32 x 16 characters, row major
0xfc00 - 0xffff  ROM, 1K, read only
0xfffd           where the CPU starts
```

The reset address is three bytes from the top of memory and `jmp target` is a
three-byte instruction, so the vector and the code that uses it are the same
three bytes.

A key press is delivered to `0x0001` only when that byte reads zero — the
handshake the monitor completes by clearing it after a read. ROM writes are
dropped and counted, because a monitor that stores into its own ROM has a bug
and the count is the only evidence it will leave.

```sh
make boot          # assemble tangerine/monitor.s and run it
```

Interactive mode takes over the terminal; `--keys "..."` runs the same machine
headless and dumps the screen, which is how the tests drive it.

## A few things that are load-bearing

**Instruction length comes from the first byte alone.** The decoder is a
256-entry table and the fetch unit never looks ahead. `tools/decode.js` asserts
it, which the assembler structurally cannot — it only ever goes the other way.

**Pointers are tagged in the low bit**, so displacements count *bytes* and are
never scaled by access width. Field offsets come out odd (`ld rd, [rp, #-1]`),
and a scaled displacement could not express them at all.

**There is no carry flag.** The carry out of a 16-bit add is recoverable from the
result — `sum < A` — so 32-bit arithmetic is add, compare, conditionally bump.
See `snippets/add32.s`.

**`r5` belongs to the assembler.** Any immediate that does not fit its
instruction expands through it, so no function can promise to preserve it. This
is MIPS's `$at`, and it costs what MIPS's does.

The rule that follows is **don't keep anything in `r5` that has to survive** —
not "check whether this particular instruction expands". Whether `lsr r5, lr, #14`
expands depends on which forms exist for that mnemonic, which is not something a
reader should have to know. So it is enforced rather than remembered: `npm test`
assembles every file in `snippets/` and `libc/` against the `--noat` ruledef,
which omits every rule that borrows the scratch. A file that assembles there
cannot contain an expansion, and `r5` in it is an ordinary register.
`isa/abi.s` is the one exception, and expands exactly once on purpose to show
what it costs — the suite pins the count at one.

**Unaligned 16-bit access is free**, with no fault and no penalty visible to
software, which is what lets the stack pack byte arguments without padding.

**The calling convention depends on the arity.** `r2` and `r3` are caller-saved
when the function takes an argument in them and callee-saved when it does not —
a static approximation of interprocedural register allocation, using the only
signal that costs nothing to distribute. `isa/abi.s` has the argument, including
the case against.

**`halt` is opcode `0x00`,** so erased memory, an unwritten ROM and a wild jump
into a zeroed page all stop where the mistake happened.

**A taken relative branch costs one cycle more than its length**, for the add
that produces `pc + off`; an absolute `jmp`, `call` or `ret` costs nothing
beyond its bytes, because the target is latched as it is fetched or read
straight from the register file. This is the 6502's behaviour — a branch is two
cycles falling through and three when taken, while `JMP` absolute is exactly
three — and it is what makes a longer unrolled loop worth anything once the
instruction mix is fixed. The simulator does not keep a list of which
instructions are which: `pc = pc + off` mentions `pc` on the right and is
therefore relative, `pc = target` does not.

## Possible enhancements

The opcode map makes the gaps visible, and four of them are worth naming. None
is implemented; they are here so the space does not get spent on something else
by accident.

### A multi-register store through an ordinary register

**The strongest case in this list, and it comes from measurement.** `push` moves
three registers in one two-byte instruction; a `st` moves one. That factor of
three is the whole difference between the two cores in `snippets/`:

| | measured |
|---|---|
| `memset`, filling through `sp` with `push` | **1.3488** cycles/byte |
| `memcpy`, reading through `sp` with `pop`, writing with `st` | **3.5000** cycles/byte |

memcpy's source side already gets the cheap rate, because `sp` can be pointed at
it. Its *destination* side cannot, because there is only one `sp` and `memset`
has a prior claim on it. Give the destination the same rate and memcpy goes to a
projected **2.6984** cycles/byte — one `pop` and one multi-store per six bytes,
four instruction bytes and twelve bus bytes, 126 bytes per iteration in 87.

**A multi-register STORE is worth more than a multi-register LOAD**, and the
asymmetry is not close. memset writes and never reads, so a load form does
nothing for it at all; memcpy needs both sides fast but already has a fast
source. So the store form serves both routines and the load form serves one —
and the one it serves is the one already covered.

**It has to count UP.** `push` pre-decrements and `pop` post-increments, which
is what makes them a stack pair and exactly what makes them useless as a
*matched* pair: reading ascending while writing descending copies the bytes to
the wrong end of the buffer. Pairing with the existing `pop` means the new
instruction must post-increment, like `pop` does:

```
stm ra!, rb, rc, rd        ; store three registers, ra += 6
```

The alternative — a descending multi-load to pair with the existing `push` —
gets memcpy to the same place and leaves memset where it is, needing `sp`.

**It costs four opcodes**, mirroring the push family: one register, two, and
three (which takes an aligned pair, because nine register bits do not fit in
byte 1). The push and pop block has seven free — 0x83, 0x84, 0x85, 0x8b, 0x8c,
0x8d, 0x9f — including the aligned pairs 0x84/0x85 and 0x8c/0x8d, so it fits
where it belongs with three to spare.

**And it would free `sp`.** Both cores today point `sp` at data, which means
interrupts need their own stack pointer while a copy or a fill is running. That
is a real constraint on the whole machine bought by two routines. With a
multi-store through an ordinary register, `memset` gives `sp` back entirely and
`memcpy` keeps it only for the source.

This is a different thing from the indexed load and store below: that one adds
an addressing *mode*, this one adds a transfer *width*. They do not compete for
the same opcodes and neither substitutes for the other.

### Three-register load and store — `ld rd, [ra, rb]`

The obvious missing addressing mode: an index register instead of a constant
displacement, for `p[i]` where `i` is not known at assembly time. Today that
costs an `add` first, and a register to put the sum in.

**The free space is exactly the right shape.** A three-register form needs nine
register bits, so it spends one opcode bit on the third register and takes a
*pair* of opcodes — which is what the ALU's three-register forms already do:

```
0100_011b  ddda_aacc      add rd, ra, rb
```

Columns `.6` and `.7` are free in all four memory rows, and `.6`/`.7` is the
column where three-register forms live:

```
0001_111b  st   rs, [ra, rb]      0010_111b  ld   rd, [ra, rb]
0010_011b  st8  rs, [ra, rb]      0011_011b  ld8  rd, [ra, rb]
```

Four instructions, two opcodes each, eight opcodes — and exactly eight are free,
in exactly those columns. Nothing has to move.

The hardware cost is a second read port on the address path, which the ALU's
three-register forms already need.

### `rsb` with a `#1<<n` immediate

Slot `+1` of every ALU group is the immbit5 slot, and four of the eight
operations now use theirs — `add` (0x41), `xor` (0x51), `or` (0x59), `and`
(0x61). `rsb` (0x49) is the one left that could plausibly want it:
`rsb rd, rd, #1<<n` computes (2ⁿ − rd), plausible for mirroring an index, and
no routine here has wanted one yet. The shifts leave theirs free because a
shift distance is four bits.

One opcode each and no new hardware — the 4-to-16 decoder is already built for
the other three. Cheap enough that the question is whether they earn their line
in the documentation, not whether the map can afford them.

The other three free `+1` slots — `shl`, `asr` and `lsr` at 0x69, 0x71 and 0x79
— are free for a reason and should stay that way. A shift count is masked to
four bits, so `1<<4` and everything above it reads as a shift of zero. immbit5
is meaningless there.

### Four unused one-byte encodings

0x0c through 0x0f. The twelve that are spent buy `add r0, r0, #1`, `mov r0, r1`,
`mov r0, #0` and their neighbours at one byte instead of two, which is why
`leaf_example` in [isa/abi.s](isa/abi.s) is four bytes rather than six.

`mov r0, #0` at 0x0b was the most recent, and the argument for it is the 65C02's:
`STZ` was one of that part's most valuable additions because clearing a location
is the commonest thing a program does that the 6502 had no short way to say.
Zeroing a register is the same observation one level in — loop counters,
accumulators, null pointers, cleared flags — and `r0` is where a return value and
a first argument live.

**The rest should not be spent on a guess.** Each is worth exactly the frequency
of the operand pattern it pins, and that is a question about real code rather
than about the instruction set. The way to spend them is to write or compile a
corpus, count, and pin the top four — which is also an argument for getting a
compiler working before the map fills up.

## Status

The instruction set is settled enough to write real code against, and the
snippets in `snippets/` are real code. Open:

- `clz`, `bitrev` and `popcount` are marked TENTATIVE in the spec.
- The monitor in `tangerine/` is barely started.
- Nothing checks that a call site and its callee agree about arity. The fix is
  a `.args` declaration the assembler and linker verify; `isa/abi.s` describes
  it and why it is not written yet.
- No object format, so everything is one translation unit. A binutils/gas port
  via CGEN is the intended answer, once the encodings stop moving.

## License

ISC.
