# Fructus

A 16-bit retrocomputer instruction set, and the toolchain that keeps it honest.

Eight registers, byte-granular instructions of one to three bytes, no carry
flag, no condition codes, and a 64 KiB address space. It is meant to run on the
kind of machine a 6502 ran on — a narrow memory bus where every instruction byte
is a cycle you pay for — so the design question behind almost every decision in
here is *what does this cost in bytes*.

Right now: **83 encoding forms over 111 of the 256 first bytes, 145 free.**

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
npm test                       # 26 checks, ~23,000 assertions
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
0006  br16 ne, r0, #0, 0x0004   r0=0009 r1=000a ...
halted after 33 instructions
```

The registers on each line are the state *entering* that instruction — what it
reads, not what it produced.

## What's here

```
isa/fructus.toml      the ISA: encodings, operand types, semantics, rationale
isa/abi.s             the calling convention, as a file that assembles
tools/                the toolchain, all driven by the TOML
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
| `npm run map` | emits `build/opcodes.html`, the opcode map |
| `npm test` | everything |

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
never scaled by access width. Field offsets come out odd (`ld16 rd, [rp, #-1]`),
and a scaled displacement could not express them at all.

**There is no carry flag.** The carry out of a 16-bit add is recoverable from the
result — `sum < A` — so 32-bit arithmetic is add, compare, conditionally bump.
See `snippets/add32.s`.

**`r5` belongs to the assembler.** Any immediate that does not fit its
instruction expands through it, so no function can promise to preserve it. This
is MIPS's `$at`, and it costs what MIPS's does.

**Unaligned 16-bit access is free**, with no fault and no penalty visible to
software, which is what lets the stack pack byte arguments without padding.

**The calling convention depends on the arity.** `r2` and `r3` are caller-saved
when the function takes an argument in them and callee-saved when it does not —
a static approximation of interprocedural register allocation, using the only
signal that costs nothing to distribute. `isa/abi.s` has the argument, including
the case against.

**`halt` is opcode `0x00`,** so erased memory, an unwritten ROM and a wild jump
into a zeroed page all stop where the mistake happened.

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
