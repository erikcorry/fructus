// cpu.sv - the processor: dispatch, decode, ALU, over 16-bit memory
// =============================================================================
//
// A THREE-STAGE PIPELINE, written by hand except for rtl/classify.sv and
// rtl/ucode.sv, which tools/gen-classify.js and tools/gen-ucode.js generate.
// The decode stage uses rtl/lhs.sv, rtl/dest.sv, rtl/immgen.sv and
// rtl/cond.sv, generated from isa/fructus.toml, and the ALU stage
// rtl/compare.sv.  It runs the one-register ALU
// instructions, the conditional branches, the jumps and calls, the loads and
// stores and block moves, mul, clz and popcount, brk, rti, sei, cli and halt,
// and the interrupt line - the whole instruction set.  An empty opcode sets
// `trapped`.
//
// IT REPLACED A BYTE-SERIAL CORE, which fetched and moved a byte a cycle
// through a microcoded datapath: smaller - 1371 LUT4s against 1651, though it
// took five block RAMs to this one's two - and slower per instruction, since
// an instruction of n bytes took at least n cycles where this one runs most
// ALU instructions in one.  In the whole system, tools/fpga-system.sv, the two
// place level: 28.20 MHz for it and 27.70 for this one, medians of sixteen
// seeds.  It is in the history: rtl/ as of commit 9a1d953.  "The byte-serial
// core" below means that one, and its figures were measured on its own
// harness.  It suits a part too small for this one.
//
// AN INTERRUPT IS A brk DISPATCHED IN PLACE OF THE INSTRUCTION IT PREEMPTS,
// with the pc left on that instruction, so brk's routine saves its address
// and rti restarts it.  brk, rti, sei and cli are microcode routines - see
// tools/gen-ucode.js - that move sp and lr through the shadows by the
// paths a memory instruction already has: a register read through decode's
// borrowed port, a register written from ldq through the ALU's pass-through.
// halt stops; an interrupt with ie set wakes it, and the brk dispatched then
// saves the address after the halt.
//
// MEMORY IS A WORD WIDE.  `mem_addr` is a byte address whose bit 0 is clear
// for every fetch; the word at that address, the even byte low, is on
// `mem_rdata` the cycle after the edge that sampled it - the UP5K's SPRAM
// exactly, with no byte select in front of it.  A write names its lanes on
// `mem_we`, the SPRAM's nibble mask a lane at a time: one for a byte, both
// for an aligned word.
//
// THREE STAGES, ONE INSTRUCTION A CYCLE when the bytes allow it, behind a
// fetcher that fills an instruction buffer - see THE INSTRUCTION BUFFER:
//
//   DISPATCH  the instruction is in the buffer's flops, and rtl/classify.sv
//             categorises its opcode.  If it is ALU the next instruction's
//             dispatch is the very next cycle, if the buffer has it.
//   DECODE    the whole instruction is present, in flops.  Both operands are
//             latched - the left one read from the register file, the right
//             one read from it or made into a 16-bit value that looks like an
//             immediate to the ALU, whatever it was made from - with the
//             operation and the destination.
//   ALU       two operand flops, the operation, and the result written.
//
// A CONDITIONAL BRANCH FLOWS THROUGH ALL THREE STAGES as an ALU instruction
// does, with the same operands and the same bypass - it compares a register
// with a register or a constant - and dispatch carries on behind it down the
// fall-through path.  Decode latches its condition, from rtl/cond.sv, and its
// target; the ALU stage decides it with rtl/compare.sv, a subtractor of its
// own beside the ALU on the same operand flops, and REGISTERS the verdict.
// If the branch is taken, the next cycle squashes the three instructions
// behind it - in the ALU stage, in decode, and dispatching - and reads the
// target's word, which arrives the cycle after and dispatches the next:
//
//     cycle   0          1          2          3            4          5
//     branch  dispatch   decode     ALU: taken
//     behind             dispatch   decode     squashed
//                                   dispatch   squashed
//                                              squashed
//     target                                   word read    arrives    dispatch
//
// So a taken branch costs five cycles - six if the target's instruction
// reaches into the word after its first, which the fetcher reads in cycle 4
// - and one not taken costs what any instruction does.  Nothing behind a branch can have done
// anything by then, because only the ALU stage writes; and halt takes effect
// in the ALU stage rather than decode for the same reason.
//
// A JUMP OR CALL ENTERS THE PIPELINE TOO, but dispatch stops behind it, since
// its fall-through is never right.  Decode builds the target - bytes 1 and
// 2, the next pc plus the last byte, or the left operand for jmp ra, call ra
// and ret - and a call's return address as its right-hand operand, which lr
// takes through the ALU's pass-through.  In the jump's ALU cycle the fetch
// reads the target's word, chosen by flops, which arrives the cycle after and
// dispatches the next: four cycles, or five as a taken branch's target can
// be, with nothing to squash.
//
// `call lr` GOES TO THE NEXT INSTRUCTION.  Its semantics, `lr = pc; pc =
// R[a]`, write lr before they read it, so this core - with tools/sim.js - goes
// to the NEW lr, and `call lr` is a way of writing the return address and
// falling through.  The byte-serial core read the register a cycle early and
// went to the OLD lr, which would make `call lr` a coroutine swap: jump to
// where lr pointed and leave the return address in its place.  Checked in
// simulation, `call r7` at 0x100 with lr = 0x4000: this core and tools/sim.js
// go to 0x102; the byte-serial core went to 0x4000.  isa/fructus.toml does
// not yet say which it means.  The byte-serial core also left lr = 0x0103
// after a two-byte `call ra` at 0x100, where tools/sim.js and this core leave
// 0x0102; its tests called only absolute targets, so none saw it.
//
// A LOAD, A STORE OR A BLOCK MOVE ENTERS THE PIPELINE AND STOPS DISPATCH.  The
// ALU computes the first address - base plus offset, op 0 - and a load puts it
// straight out from the adder, while a store registers it first; a sequencer
// then makes one access a cycle - a whole word when the first address is
// even, a byte when it is odd - writes registers through the ALU's result, and
// releases dispatch a step before its last access, so that the next
// instruction reaches decode after the routine's last use of decode's port.
// The bus is the sequencer's whenever it wants it, and the fetcher's in every
// other cycle.  N accesses cost N + 2 cycles from one dispatch to the next,
// load or store: 3 for ld8 and st8, and for ld, st and a one-register pop or
// push aligned, 4 for them at an odd address; 5 for three registers aligned,
// 8 odd.  See THE MEMORY SEQUENCER below.
//
// BLIT MODE, ONLY WHEN `FRUCTUS_BLIT IS DEFINED.  A system whose data can come
// from memory at the far side of the die - the display's frame buffers,
// tools/fpga-system.sv - sets `blit`, and then ld, ld8 and ldm take their
// bytes a cycle late, on `mem_late`: the word at the address sampled two
// edges ago, where `mem_rdata` has the one sampled at the last.  Each costs a
// cycle more, however many bytes it moves.  rtl/ucode.sv holds a late copy
// of their routines, at the entry with its top bit set, and decode sets that
// bit from `blit` and predecode's `ulate` column.
//
// ONLY A DATA BYTE CAN COME FROM THE LATE PORT.  Instruction bytes reach
// the instruction buffer from `mem_rdata` alone, and a load's bytes reach
// the register file only through the sequencer's capture into ldq, in the
// steps the routine marks - with `L`, in a late copy, for mem_late.  So the
// late byte, from across the chip, reaches ldq and nothing else, and no path
// from it runs in front of decode.  pop keeps its ordinary routine.
//
// AND A LOAD'S BYTES COME FROM `mem_data`, not `mem_rdata`, in the same
// build: the word the system says a load reads, which is mem_rdata except
// where it substitutes one of its own - tools/fpga-system.sv's I/O registers.
// Only captures read it, so the system's choice is in front of ldq and not
// of decode; in front of decode it cost a LUT level, 27.35 MHz to 25.58.
//
// SO A STACK ABOVE 0x8000 IS WRONG IN BLIT MODE: a push's bytes there are
// stores, which the system sends to the buffer, while pop's are read from
// the processor's own memory.  Nothing checks it.  A check once trapped such
// a push or pop, but it was one of many ways to get blit mode wrong, and it
// cost two carry chains on aq.
//
// WITHOUT THE DEFINE THE NETLIST IS THE SAME, bit for bit, as before blit
// mode existed - write_verilog of the synthesised design compared equal - so
// the figures below describe the core built without it.  That took care:
// ulate as an unread column of predecode's table, the late routines' words
// in the ROM, unreachable, and even a wire declared and not used each moved
// yosys's mapping by 20 to 30 LUT4s, so all three exist only under the define.
//
// ONE BYPASS, FROM THE ALU STAGE INTO DECODE'S OPERAND FLOPS.  The instruction
// directly ahead is in the ALU stage while this one decodes and writes only at
// the edge that ends the cycle, so its result is not yet in the register file.
// Decode knows that instruction's destination - it latched it itself, one-hot,
// a cycle earlier - and takes the result in place of the read when the numbers
// match.  Anything older has already landed.
//
// THE INSTRUCTION BUFFER.  A fetcher with a word pointer of its own, `fp`,
// reads a word in every cycle the sequencer and the redirects leave the bus
// alone, into a buffer of three words, and dispatch and decode read only the
// buffer's flops - never the memory's port.  Whole words go in, so the
// buffer's first byte is always at an even address, and an instruction's
// bytes are at pc[0], a flop.  A word read now is kept if what stays, with
// the word already arriving, is at most two words, so that it fits when it
// comes; a read that is not kept is simply never used.  A dispatch moves out
// the words the pc passes - 0, 1 or 2 - and a redirect empties the buffer,
// its own read the target's word; an odd target's low byte is passed over.
// An instruction dispatches once the buffer holds all its bytes.
//
// So the fetcher brings two bytes in every cycle the bus is its own, and an
// instruction's cost is its own, above, when the buffer keeps up.  It falls
// behind after a redirect, until the target's bytes are in, in a run of
// three-byte instructions, which take more than two bytes a cycle, and
// after a long run of loads and stores.  tools/sim.js models the fetcher,
// so its counts are exact.  A two-cycle operation's bubble lets the fetcher
// gain a word, and so do the cycles a routine leaves the bus alone.
//
// CODE MAY NOT WRITE JUST AHEAD OF ITSELF.  A store into the six bytes the
// buffer may hold reaches memory but not the buffer; code that writes
// instructions reaches them through a jump, a taken branch, a call, a return
// or rti, which empty it.
//
// WHAT IT BOUGHT, against the core before it (rtl/ as of commit 4d59ff9):
// DeltaBlue, cut down, 3,875,174 cycles to 3,422,518, -11.7%, of which
// -7.9% is the buffer and -4.2% the stores' early release, which the
// buffer allows; 2615 cells against about 2421, 30.20 MHz, 28.9 .. 31.3,
// against 29.78 for the buffer before the stores' release; and the whole
// system, tools/fpga-system.sv, 4229 cells and 29.06 MHz against 4028 and
// 26.65 - every critical path of the system's had begun at the SPRAM's data
// out, through dispatch and decode, and none does now.  Its floorplan's split
// moved a column, from 13 to 14, to make room: the core no longer fit.
// The design and the variants measured on the way, among them a buffer
// shifting bytes and a window that never moves, are in
// experiments/ib/README.md.
//
// MEASURED on an iCE40 UP5K, yosys + nextpnr-ice40, behind a real
// SB_SPRAM256KA read a word at a time (tools/fpga-top.sv), medians of eight
// placement seeds - `just speed 8`:
//
//                                                   cells     MHz   spread
//     A LOAD'S FIRST ADDRESS FROM THE ADDER, AT ONCE 1873    31.14  30.2 .. 33.3
//     and from the ALU's result, through its mux     1884    29.73  27.6 .. 30.9
//     the first address from the ALU, registered     1802    32.12  30.7 .. 32.9
//     a store's data through decode's left port      1816    32.06  31.2 .. 32.8
//     through a byte-wide port of its own            1937    31.22  28.9 .. 31.7
//     with loads, stores and block moves             2050    31.35  29.9 .. 33.3
//     the sequencer's controls from its counter      1933    30.99  29.9 .. 31.4
//     empty opcodes' length left to the mapper       1371    33.59  32.8 .. 34.4
//     with the jumps and calls                       1388    32.96  32.5 .. 33.7
//     pc + 1, 2, 3 as a LUT increment, no carry      1384    32.05  31.3 .. 33.0
//     and length and kind looked up before the mux   1385    31.13  30.6 .. 33.1
//     and a flop of its own for the next pc          1412    32.67  31.4 .. 34.1
//     and one for a register jump's target, `keep`   1383    31.93  29.3 .. 32.9
//     with the conditional branches                  1330    35.53  34.3 .. 36.1
//     the verdict choosing the address, 3 cycles     1267    30.10  28.7 .. 31.7
//     backward predicted taken, verdict picks pc     1347    32.19  31.6 .. 33.0
//     and the verdict into one flop only             1362    31.73  29.8 .. 32.6
//     and rtl/compare.sv kept as its own hierarchy   1356    32.79  31.9 .. 33.4
//     operands read in decode, with the bypass       1186    34.95  34.0 .. 36.2
//
//   and before it, with the register file read in the ALU stage:
//
//     register numbers binary, read by 8:1 mux       1177    26.25  25.9 .. 26.5
//     register selects one-hot                       1170    27.54  26.8 .. 28.4
//     and the result mux an AND-OR, one-hot op       1188    26.85  25.6 .. 27.1
//     shift amount from the immediate only (wrong)   1145    27.59  27.1 .. 28.2
//     no shifts at all (wrong)                                30.50  29.6 .. 31.3
//     no shifts and no unary operations (wrong)               31.50  30.5 .. 33.0
//     shifts gated and ORed after the fast mux       1145    27.41  26.9 .. 28.3
//     read selects copied per nibble, `keep`         1175    26.25  25.7 .. 27.8
//     floorplanned, ALU stage in (1,1)-(12,12)       1191    26.55  25.4 .. 27.4
//     floorplanned, ALU stage in (1,4)-(14,14)       1191    27.02  26.2 .. 27.9
//
// AND OVER SIXTEEN SEEDS, in a table of its own because a median of sixteen
// and a median of eight are not comparable:
//
//                                                   cells     MHz   spread
//     recip WITHOUT ITS LOW WORD, 0xbb, as here      2400    29.45  27.3 .. 31.3
//       2100 LUT4 against 2393 with the cycle counter, 30.00 then; the 3/2
//       reciprocal is libgcc's, from this one.  The system, 4536 cells and
//       unplaceable, is 4024.  Critical paths decode's, seven cells, in
//       fourteen seeds, the other two nine cells to pcc; none in recip
//     recip's LOW WORD, 0xc6 eight cycles            2811    30.60  29.6 .. 31.4
//       2308 LUT4 against 2044, the same RAM and DSPs - mac1 makes the third
//       product too; 0xc3, recip rd, ra, #0, still five cycles.  Critical
//       paths decode's, seven cells, or the first correction's in five
//       seeds, 29.7 .. 31.4.  On the way: the compares in the last cycle with
//       the select, 23.95; given a cycle of their own, 26.95, the choice
//       between the two answers then a LUT level on the first correction;
//       each answer into mul's output registers through macu's D and C, so
//       no choice, 28.78 - two long wires to the pin, 24.8 ns of 37.2
//       routing; the answer into a flop of recip's own, ORed in, 30.60
//     recip, rtl/recip.sv, keep_hierarchy            2340    30.29  29.1 .. 31.0
//       2044 LUT4, 3 block RAMs and 4 SB_MAC16s, against 1880, 2 and 2;
//       mulhu's commit, rerun the same day, 30.38, 29.5 .. 31.5.  Every
//       seed's critical path decode's, seven cells.  Flattened, the unit
//       made those paths eight cells deep without touching them, 28.08, and
//       nine with its answer through mul's D, 26.64; recip's release inside
//       dispatch's if-chain put aq -> pcc paths, nine cells, in five seeds;
//       the correction's increment behind its compares was the critical
//       path in five, from mac2's output, 30.32 then.  icetime: mac2's A
//       pins settle by 19.0 ns, macu's D by 30.7, decode's worst path 36.2
//     mulhu AND mulhs, a second SB_MAC16, OLOAD      2139    30.75  29.6 .. 32.1
//       1892 LUT4 against 1870, and in the same text before it 30.38,
//       29.4 .. 31.4; every seed's critical path still decode's.  icetime:
//       the DSPs' pins settle by 7.3 ns, then 6.5 inside to the output
//       registers, and the LUTs after them see their worst input, 10.5 ns,
//       from a fabric flop.  The system 27.01 against 27.40, 2990 LUT4
//       against 2991
//     ALIGNED WORDS IN ONE ACCESS, as here           1998    31.16  30.4 .. 31.9
//       1706 LUT4 against 1673, and in the same run the design before it
//       measured 30.84, 29.1 .. 32.4 - no seed's critical path at the new
//       release or the ROM's address; the system 27.95 against 27.44
//     mul HELD IN THE ALU STAGE, 2 cycles           1972    30.30  28.7 .. 31.4   (32 seeds)
//       registered at the SB_MAC16's inputs instead: the same netlist, and
//       icetime, which times through it, still found decode's path worst;
//       at both ends, 3 cycles and a second dispatch bubble: 31.43
//     the ALU's fast group and two adders            1954    30.95  29.6 .. 32.9   (32 seeds)
//       no seed's critical path in the ALU loop; in the same text as the rows
//       below it: one adder 30.71, two 31.04, group alone 30.12, both 31.29
//     clz and popcount in two cycles                 1937    31.34  29.7 .. 32.2   (32 seeds)
//       held in the ALU stage, a flop in the ALU;
//       reissued by decode instead: 29.6 .. 30.6
//     the unary select from bq[2:1]                  1926    30.75  29.9 .. 32.1
//     the same, its shifts through named wires       1920    31.94  30.5 .. 33.4
//     and the bypass chosen in the ALU cycle         1955    28.45  26.9 .. 29.3
//     register jumps through taken_q, usel flops     1946    31.81  30.0 .. 32.6
//     and the SPRAM pinned at the bottom left        1946    31.77  29.2 .. 32.8
//     and the SPRAM pinned at the bottom right       1946    31.29  30.4 .. 32.0
//     the pc's carry added a cycle late              1953    31.05  29.5 .. 32.6
//     mul, clz and popcount                          1986    31.68  31.0 .. 32.7
//     and ld8's release worked out in the ALU cycle  2013    30.21  29.4 .. 32.0
//     clz and popcount whole into ldq in one cycle   2012    26.40  25.4 .. 27.4
//     microcode redirecting through taken_q          1883    31.10  29.9 .. 32.0
//     with exceptions and interrupts, own mux arm    1917    30.61  29.2 .. 31.9
//     and without the opcode substitution (wrong)    1901    30.62  29.6 .. 32.0
//     the bypass selects spelled as AND-ORs          1927    29.25  28.4 .. 31.0
//     a store's bytes taken from aq, not the port    2053    29.95  28.8 .. 31.6
//     the sequencer's control as microcode           1725    31.38  29.2 .. 33.0
//     its control as schedules in LUTs               1873    31.23  30.2 .. 33.3
//     that, with dispatch never stopping itself      1853    30.57  29.2 .. 32.8
//
// INTERRUPTS COST 0.28 MHz of median and nothing at the low end, 124 LUT4s
// and a second block RAM - the word grew to 32 bits - and a cycle on brk and
// rti, which redirect the fetch through taken_q and tgt_q, the flops a taken
// branch uses, a cycle after their word asks.  Given an arm of their own on
// the address mux they cost 0.77, and they took five cycles rather than six.
// The opcode substitution that makes an interrupt a brk costs nothing: taken
// out, the design measured the same.
//
// THE TWO-CYCLE OPERATIONS COST ABOUT 0.9 MHz, AND THE COLUMN THEY BROUGHT
// BOUGHT BACK 1.5.  A one-byte load's early release was worked out in its ALU
// cycle as `~e_mst & e_mN == 1`, a compare over the ALU stage's flops in front
// of `stop` and the dispatch enables; predecode's `urs` column, which the
// two-cycle operations needed anyway, makes it one flop.  Put back, the old
// expression measured 30.21 - so the design is faster than before these
// operations for that reason, and no seed's critical path touches them.  mul's SB_MAC16
// works on the operand flops every cycle into its own output register, which
// reaches the ALU's result mux as op 14 in a mul's second, held cycle - so
// the only thing pulling toward the DSP's column is a bare wire from a flop.
// (It and clz and popcount were once routines into ldq instead, at four
// cycles.)  nextpnr cannot time through the SB_MAC16, so the path out of its
// output register - about 2 ns clock to out on the part's own figures, then
// the result mux - is not in
// these numbers.  The whole of clz and popcount computed in the ALU cycle and
// chosen into ldq was 26.40: yosys pushed ldq back into the popcount tree, and
// the flops it made there took a reset from dispatch.  The slow seeds are decode's: from the SPRAM, through a register
// number and the eight-way read, into an operand flop.  Whichever flop on
// that read reports - aq, bq, a shadow or the store byte wq - is only the one
// that loses the tie, which is why taking the shadows and then wq off the
// port's output removed them from the reports and bought nothing: the
// shadows now take aq for that reason, but wq taken from aq as well cost 134
// LUT4s and measured no faster, and was not kept.
//
// THE MICROCODE IS 125 LUT4s AND 148 CELLS SMALLER for one of the part's
// thirty block RAMs, at the same clock: 1494 LUT4 against 1619.  Its control
// comes out of the RAM's own output register, so nothing about it is on the
// critical path.  Stopping dispatch from decode instead of at dispatch - so
// that dispatch needs nothing of the classifier but the length - cost no
// cycle but moved the whole distribution down: the kind had never been on
// the path to the pc, only to `go` and `stop`.
//
// THE SHIFTERS ARE THE THREE MHz BETWEEN THIS AND 30.  Everything else in the
// stage - the read, the adder, the logic operations, the result mux and the
// write - reaches 30.5 once they are gone.  They cannot be hidden by moving
// them to the end of the result: the rows that gate them in after a fast mux
// came out the same, because abc flattens the result mux however it is
// written.  The amount and the data are equally deep - a register read and
// four levels of barrel shifter each - so removing either one alone buys
// nothing, and copying the read selects to cut their fanout made the low
// nibble's copy, which IS the amount, the one that fans out to everything.
//
// NOR DOES PLACEMENT HELP.  The path is nine LUTs, and the placer already
// keeps them together: in the best seeds every hop is 1.8 to 3 ns of wire
// between neighbouring tiles, so confining the stage to a rectangle
// (tools/fpga-top.py) gives the placer less room without making a
// single hop shorter.  At nine levels 30 MHz is out of reach wherever they
// sit; only fewer levels will get there.
//
// A TAKEN BRANCH STAYS AT FOUR CYCLES because nothing tried for three kept the
// clock.  Letting the comparison choose the next address put rtl/compare.sv's
// carry chain in front of the SPRAM's address pins; predicting backward
// branches taken, so the address comes from flops, cost three MHz however the
// verdict was then used, apparently by crowding the logic round the SPRAM -
// the slowed paths were the ALU's own, which had not changed.  A cycle on
// taken branches is not worth ten per cent on everything.
//
// THE pc'S THREE SUMS STAY ON THE CARRY CHAIN.  They are three chains - 41
// carry cells, the fetch address sharing pc + 2's - and a carry chain's cells
// must stand in a column; but they are fed by the pc flops alone and settle
// while the opcode is still leaving the SPRAM.  An increment of pc[15:2] as
// three levels of instantiated LUT4s, with the length's two-bit carry picking
// it, measured slower, and so did also reading the length before the opcode
// mux: what stands between the SPRAM and the pc is the classifier's table,
// three or four LUTs for a function of eight bits, and the five-input mux in
// front of it - not the sum behind it.  Measured again over sixteen seeds
// with the whole instruction set in, the LUT increment chosen by the length's
// two-bit carry was 29.26 MHz against 31.68, and the pc was the critical
// endpoint in fifteen seeds of sixteen: with the length feeding the carry and
// the low bits directly, abc folded the classifier's table into that logic and
// made it deeper - nine cells from the SPRAM to the pc's enable, not seven.
// Keeping the length a mux select - one 14-bit incrementer on the carry chain
// shared by three finished candidates, which the length chooses among - was
// 29.98: the pc ended fewer paths, four of sixteen, but decode's got slower,
// which the change does not touch.  Near the SPRAM, placement answers to more
// than the path being changed.
//
// WHAT DID TAKE THE pc OFF EVERY CRITICAL PATH was not a better adder but
// splitting it across two cycles: the pc is a base, two low bits and a carry
// still to be added, and a dispatch finishes only the low bits and the carry
// - a two-bit add from the classifier's length into three flops - while the
// high bits take the resolved base, from flops.  No seed of sixteen then ends
// at the pc, against five.  The median came out 0.6 MHz lower, 31.05 against
// 31.68, all of it decode's and the ALU's paths, which it does not touch;
// kept because it removes a whole family of critical paths, so that what
// speeds decode up is not capped by dispatch just behind it.
//
// AND aq NO LONGER REACHES THE ADDRESS MUX OR THE pc.  A jump to a register
// took its target straight from aq into both, and the path reports showed the
// ALU's own logic named after the pc and placed beside it, a long wire from
// aq.  Through tgt_q and taken_q, a cycle late, as rti's return does - jmp ra,
// call ra and ret take four cycles, not three - the ALU loop left all but two
// critical paths of sixteen, and the median rose to 31.81.
//
// THE UNARY SELECT IS bq[2:1].  For a unary instruction the right-hand
// operand is the imm3 value its encoding names, so bits 2:1 of bq are the
// select, and rtl/alu.sv and the slow unit read them there.  Until
// 2026-09-30 two flops, e_usel, held a copy loaded from the same bval.
// Without them the median measured 30.75 against 31.81 - but that is inside
// what the text alone moves this design: the same logic with its shifts
// spelled through named wires measured 31.94.  The critical paths end at
// decode's flops, not in the ALU cycle where e_usel's loads were, so there
// is no reason to think the two flops bought anything.
//
// THE BYPASS STAYS IN DECODE.  Latching R[an] and R[bn] alone, with the
// forwarding answers in two flops and the ALU's result in a third register,
// and choosing in the ALU cycle, is the same value a mux later - and 28.45
// against 30.75.  Decode got no shorter: its worst paths still run from the
// memory into aq, 8 cells, because what costs there is the register read
// selected by bytes that arrive that cycle, not the bypass mux.  And the ALU
// loop gained the mux: bq to yq and e_fb to the register file became the
// worst path in 5 seeds of 16, against 1 before.
//
// PINNING THE SPRAM DOES NOT HELP, in either corner.  The placer uses both,
// seed by seed; pinned at the left, decode settles beside it and the ALU loop
// ends ten critical paths of sixteen instead of two, and the median does not
// move; pinned at the right, decode ends all sixteen and it is half a MHz
// lower.  Decode's operand read and the ALU loop are the same length, seven
// or eight LUTs and two thirds of it wire, and placement only decides which
// of the two reports.  More clock needs fewer levels in both.
//
// WHAT FIXED IT WAS MOVING THE READ, NOT THE SHIFTERS.  the byte-serial core's cpu.sv as of
// 735e301, which reads its operands a cycle early with the same shifters,
// measured 33.96 on this harness; the shifters were only too slow with a
// register read in front of them.  With the read in decode the ALU loop is
// operand flop, ALU, result mux, and then either the register file or - one
// LUT - the bypass into the operand flops, and it is off the critical path:
// every seed's path now runs from the SPRAM's data out, through decode, to an
// operand flop or the pc, in six or seven cells.
// =============================================================================

// The vector, sp and lr, and the unary select, from isa/fructus.toml.
`include "rtl/isa.svh"

module cpu (
    input  logic        clk,
    input  logic        rst,
    input  logic        boot,        // <- the system: from reset, store a byte every
                                     //    eight cycles at 0, 1, 2 ... - see THE BOOT
                                     //    LOOP; held through rst, dropped under it
    output logic [15:0] mem_addr,    // -> memory: the word is [15:1]; [0] is clear for
                                     //    every fetch, and for a store says nothing
                                     //    mem_we does not
    input  logic [15:0] mem_rdata,   // <- the word sampled at the last edge
    output logic [15:0] mem_wdata,   // -> memory: the word to write, even byte low
    output logic [1:0]  mem_we,      // -> memory: write these lanes at this edge -
                                     //    [0] the even byte, [1] the odd
`ifdef FRUCTUS_BLIT
    input  logic        blit,        // <- the system: ld, ld8 and ldm's bytes come late
    input  logic [15:0] mem_late,    // <- the word at the address sampled two edges ago;
                                     //    read only by those loads' captures
    input  logic [15:0] mem_data,    // <- mem_rdata, or the system's word in its place:
                                     //    read only by every other load's captures
`endif
    input  logic        irq,        // <- the interrupt line, synchronised: level
                                     //    sensitive, taken where an instruction
                                     //    would have been dispatched, if ie is set
    output logic        halted,
    output logic        trapped,
    output logic [15:0] result,      // the ALU's output, for the harness
    output logic        retire,      // for the harness: an instruction completes
    output logic [15:0] retire_pc    //   this cycle, and this was its address
);

    // A taken branch, decided in the ALU stage at the last edge: this cycle
    // the three instructions behind it are wrong, and the fetch goes to `tgt_q`.
    logic        taken_q;
    logic [15:0] tgt_q;

    // =========================================================================
    // DISPATCH / PREDECODE
    // =========================================================================
    // THE pc IS KEPT AS A BASE, TWO LOW BITS AND A CARRY STILL TO BE ADDED, so
    // that a dispatch finishes only the part that needs the opcode's length:
    // the two low bits and whether they carry, one LUT each from the
    // classifier into a flop.  The high bits take the resolved high bits of
    // the pc being dispatched - base, or base + 1 if a carry is pending - which
    // are flops and an incrementer, and settled while the opcode was still
    // arriving.  So the fourteen-bit carry is added in the cycle after the one
    // that made it, and never behind the classifier.  `pc`, below, is the
    // whole value, for everything that reads it.
    logic [13:0] pcb;       // the base of pc[15:2]
    logic [1:0]  pcl;       // pc[1:0]
    logic        pcc;       // a carry into the base, not yet added
    wire  [13:0] pcb1 = pcb + 14'd1;
    wire  [13:0] pch  = pcc ? pcb1 : pcb;
    wire  [15:0] pc   = {pch, pcl};  // the instruction at ib0, dispatching this cycle if `go`
    wire         go;        // this cycle dispatches
    logic        stop;      // a microcoded instruction was dispatched: freeze
    logic        skip;      // a two-cycle instruction was dispatched: a cycle with none

    // THE INSTRUCTION BUFFER: three words, iw[0] pc's own, filled by the
    // fetcher - see THE INSTRUCTION BUFFER above.  Whole words go in, so its
    // first byte is always at an even address, and the instruction's bytes
    // are at pc[0], a flop: ib0, ib1 and ib2.
    logic [15:0] iw [0:2];
    wire  [7:0]  ib0 = pcl[0] ? iw[0][15:8] : iw[0][7:0];
    wire  [7:0]  ib1 = pcl[0] ? iw[1][7:0]  : iw[0][15:8];
    wire  [7:0]  ib2 = pcl[0] ? iw[1][15:8] : iw[1][7:0];
    logic [2:0]  nw;        // words held, pc's on: 0 .. 3
    logic        finq;      // the word on the port is the fetcher's
    logic [14:0] fp;        // the word the next fetch reads
    // AN INTERRUPT IS A brk DISPATCHED IN PLACE OF THE INSTRUCTION IT PREEMPTS.
    // brk is opcode 0 - tools/gen-isa.js checks - so the substitution is an
    // AND, and everything after it -
    // the classifier's row, decode, the routine - is brk's.  The only
    // difference is that the pc does not move on, so the routine saves the
    // preempted instruction's address and rti restarts it.
    // A GUARD TRAP IS ONE TOO, and not maskable: `gq', below, says a load or
    // store touched a guard of the I/O page, and the next dispatch is its brk.
    // So is a divide by zero: `dq', a recip whose ra had bit 15 clear.
    wire       ie_q;                           // below, with the shadows
    wire       aphase;                         // the sequencer has the bus: below
    logic      gq, dq;
    // A slot is a cycle that may dispatch; `take` needs only a byte in the
    // buffer, since brk has no bytes but its opcode, and it shifts nothing.
    wire       slot = ~rst & ~stop & ~skip & ~taken_q;
    wire       take = slot & (nw != 3'd0) & ((ie_q & irq) | gq | dq);
    wire [7:0] op = ib0 & {8{~take}};

    wire [1:0] kind, len, c_cond, c_pcsrc, c_mn;
    wire       c_wen, c_halt, c_mem, c_mst, c_mw2, c_mblk, c_mpush, c_useq, c_urs;
    wire [2:0] c_ext;                  // extra cycles in the ALU stage
`ifdef FRUCTUS_BLIT
    wire       c_ulate;
    logic      d_ulate;
`endif
    wire [3:0] c_alu, c_lhs, c_rhs, c_dest;
    wire  [2:0] c_lsel;                // which of the ALU's fast group, with code 4
    logic [2:0] d_lsel, e_lsel;
    wire [4:0] c_uent;
    classify c (.op(op), .kind(kind), .len(len), .wen(c_wen), .halt(c_halt),
                .alu_op(c_alu), .lhs_src(c_lhs), .rhs_src(c_rhs), .dest_src(c_dest),
                .cond_src(c_cond), .pc_src(c_pcsrc), .mem(c_mem), .mst(c_mst), .mw2(c_mw2),
                .mn(c_mn), .mblk(c_mblk), .mpush(c_mpush), .useq(c_useq), .uent(c_uent),
`ifdef FRUCTUS_BLIT
                .ulate(c_ulate),
`endif
                .ext(c_ext), .urs(c_urs), .lsel(c_lsel));
    // THE BUFFER'S LENGTH IS ib0's OWN, not the masked opcode's: an interrupt
    // moves nothing out, so the length need not wait for `take`.  And it is
    // classified from the flops, both bytes that could be the opcode, by two
    // more copies of the classifier of which only the length is read, so
    // pc[0] picks a two-bit length: ib0's mux is not on the loop from the
    // buffer through the length to the pc and the buffer again.
    wire [1:0] lenr;
    wire [1:0] lb0, lb1;
    classify cl0 (.op(iw[0][7:0]), .len(lb0));
    classify cl1 (.op(iw[0][15:8]), .len(lb1));
    assign lenr = pcl[0] ? lb1 : lb0;
    // jmp AND call TO AN ABSOLUTE ADDRESS, 0xa9 and 0xaa, FETCH THEIR TARGET
    // AS THEY DISPATCH: it is ib1 and ib2, already in the buffer, so the
    // fetch reads its word at once and the buffer is emptied, as a taken
    // branch empties it.  Recognised from the flops, both bytes that could be
    // the opcode, as the length is.  jmp moves the pc there too: two cycles.
    // call leaves the pc on the next instruction, which is its return
    // address, and stops dispatch; its ALU cycle moves the pc, as an
    // unpredicted jump's does, without touching the bus: three cycles.  If
    // the sequencer has the bus - a store's last access - neither is
    // predicted, and both go as they did: four.
    wire pjb0 = (iw[0][7:0]  == 8'ha9) | (iw[0][7:0]  == 8'haa);
    wire pjb1 = (iw[0][15:8] == 8'ha9) | (iw[0][15:8] == 8'haa);
    wire pjr  = pcl[0] ? pjb1 : pjb0;
    wire [15:0] ptgt = {ib2, ib1};
    wire        pjcall = ib0[1];      // 0xaa, given pjr; 0xa9 has bit 1 clear

    // A CONDITIONAL BRANCH FLOWS LIKE AN ALU INSTRUCTION.  Dispatch carries on
    // down the fall-through path behind it, which costs nothing if the branch
    // is not taken, and is undone below if it is.
    //
    // A JUMP ENTERS THE PIPELINE BUT STOPS DISPATCH behind it, since its fall
    // through is never right: nothing follows it to be undone, and the ALU
    // stage restarts dispatch at its target.
    wire is_cbr  = (kind == 2'd2);
    wire is_jump = (kind == 2'd3);
    wire flows   = (kind == 2'd0) | is_cbr;
    // A MEMORY INSTRUCTION ENTERS THE PIPELINE AND STOPS DISPATCH, as a jump
    // does: from its ALU cycle on the bus is the sequencer's whenever it wants
    // it, and the routine borrows decode's left port, so dispatch resumes when
    // the sequencer releases it, a step before its last access.
    wire piped   = flows | is_jump | c_useq;
    // The whole instruction is in the buffer.  An interrupt's brk needs only ib0.
    // Spelled so that an empty buffer's x opcode gives simulation the 0 the
    // hardware gives: three bytes are any instruction, none is none.
    wire ready   = take | (nw >= 3'd2) | (nw == 3'd1 && (pcl[0] ? lenr == 2'd1 : lenr != 2'd3));
    assign go    = slot & ready;
    // A predicted jump dispatches, `pjd`, and reads its target now, `pj`.
    // pj is spelled from flops: three bytes are there when two words are, so
    // neither the classifier's length nor `go` is in front of the address
    // pins.  An interrupt taken in its place lets it fire anyway: the pc
    // stays, and the brk's own redirect empties the buffer again.
    wire pjok    = pjr & ~aphase;
    wire pjd     = go & ~take & pjok;
    wire pj      = pjok & slot & (nw >= 3'd2);
    // mul, clz AND popcount TAKE TWO CYCLES IN THE ALU STAGE, and leave a
    // cycle with no dispatch after them, `skip`: see the ALU stage.
    // MORE THAN ONE EXTRA CYCLE - recip's four - STOPS DISPATCH, as a jump
    // does, and `xrel` releases it when the ALU stage has two held cycles to
    // come: the next instruction dispatches in the first and reaches decode
    // in the last, where it takes the result through the bypass.  So any
    // count from two up needs nothing more than the compare.
    wire c_long = |c_ext[2:1];

    // The candidates for the next pc come off the pc flop in parallel, so the
    // classifier's length only picks one.
    wire [2:0]  pcs = {1'b0, pcl} + {1'b0, lenr};   // the low bits' sum, and its carry

    // A jump in the ALU stage reads its target's word, chosen by flops alone.
    wire        jnow;
    wire [15:0] jaddr;
    wire        mrestart;                  // the memory sequencer, below
    logic [15:0] mar;
    wire        ldnow;                     // a load's first address: the ALU's result
    wire [15:0] maddr;
    wire        urj;                       // the microcode redirects the fetch
    wire [15:0] rjaddr;
    wire        wake;                      // an interrupt ends a halt
    wire        xrel;                      // a long hold releases dispatch: the ALU stage
    wire        jfetch;                    // jnow, unless a predicted call fetched already
    wire        fetch = ~taken_q & ~jfetch & ~ldnow & ~aphase & ~pj;   // the bus is the fetcher's
    assign mem_addr = taken_q ? {tgt_q[15:1], 1'b0}
                    : jfetch  ? {jaddr[15:1], 1'b0}
                    : ldnow   ? asum
                    : aphase  ? maddr
                    : pj      ? {ptgt[15:1], 1'b0}
                    :           {fp, 1'b0};

    // --- the buffer --------------------------------------------------------------
    // WORDS LEAVING: pc's word goes once the pc passes it.  sw[l] is how many
    // a dispatch of length l passes - 0, 1 or 2 - from the pc flop alone, so
    // the length only picks one, late.
    logic [1:0] sw [0:3];
    always_comb
        for (int l = 0; l < 4; l++) sw[l] = 2'((3'(l) + {2'b0, pcl[0]}) >> 1);
    wire        gon   = go & ~take;                 // dispatches, and moves on
    // A WORD FETCHED NOW IS KEPT if what stays, with the word arriving, is at
    // most two words: then it fits when it comes, whatever dispatches then.
    logic [3:0] croom;                              // ... after s words leave
    always_comb
        for (int s = 0; s < 4; s++) croom[s] = nw + {2'b0, finq} <= 3'(2 + s);
    wire [1:0]  sel   = gon ? sw[lenr] : 2'd0;
    wire        keepw = fetch & (gon ? croom[sw[lenr]] : croom[0]);
    wire [15:0] raddr = taken_q ? tgt_q : jaddr;    // a redirect's target
    // ONE LUT AFTER THE LATE SELECT.  A slot takes the word at position s,
    // and position p holds iw[p] if it is valid and the arriving word if
    // not - `e`, from flops and the port, settled early.  Holding is the
    // flops' enable; a slot at or past nw may load anything, since nothing
    // reads it before an arrival does.
    wire [15:0] e1 = (nw > 3'd1) ? iw[1] : mem_rdata;
    wire [15:0] e2 = (nw > 3'd2) ? iw[2] : mem_rdata;
    wire        smv = sel != 2'd0;
    always_ff @(posedge clk) begin
        if (smv | (nw == 3'd0)) iw[0] <= sel[1] ? e2 : e1;
        if (smv | (nw <= 3'd1)) iw[1] <= sel[0] ? e2 : mem_rdata;
        if (smv | (nw <= 3'd2)) iw[2] <= mem_rdata;
    end

    always_ff @(posedge clk) begin
        if (rst) begin
            nw <= 3'd0; finq <= 1'b0; fp <= 15'd0;
        end else if (taken_q | jfetch) begin
            // The redirect's own read is the target's word.
            nw <= 3'd0; finq <= 1'b1; fp <= raddr[15:1] + 15'd1;
        end else if (pj) begin
            nw <= 3'd0; finq <= 1'b1; fp <= ptgt[15:1] + 15'd1;
        end else begin
            nw <= nw + {2'b0, finq} - {1'b0, sel};
            finq <= keepw;
            if (keepw) fp <= fp + 15'd1;
        end
    end

    always_ff @(posedge clk) begin
        if (rst) begin
            {pcb, pcl, pcc} <= 17'd0; stop <= boot; skip <= 1'b0;
        end else if (taken_q) begin
            {pcb, pcl, pcc} <= {tgt_q, 1'b0}; stop <= 1'b0; skip <= 1'b0;
        end else if (jnow) begin
            {pcb, pcl, pcc} <= {jaddr, 1'b0}; stop <= 1'b0; skip <= 1'b0;
        end else if (take) begin
            // The brk goes down the pipeline; the pc stays on the instruction
            // it replaced.
            stop <= 1'b1;
        end else if (wake) begin
            stop <= 1'b0;
        end else if (mrestart) begin
            // The sequencer's last address is on the bus now; the buffer has
            // the next instruction, which dispatches next cycle.
            stop <= 1'b0;
        end else if (pjd & ~pjcall) begin
            // jmp goes down the pipeline as an ALU instruction that writes
            // nothing, and dispatch carries on at its target.
            {pcb, pcl, pcc} <= {ptgt, 1'b0}; stop <= 1'b0; skip <= 1'b0;
        end else if (go) begin
            pcb     <= pch;
            {pcc, pcl} <= pcs;
            skip    <= flows & (c_ext != 3'd0) & ~c_long;
            stop    <= ~flows | c_long;
        end else begin
            skip    <= 1'b0;
        end
        if (xrel & ~rst) stop <= 1'b0;
    end

    // =========================================================================
    // DECODE
    // =========================================================================
    logic        d_valid, d_ucode, d_halt, d_wen, d_cbr, d_jump, d_pj;
    logic        d_mem, d_mst, d_mw2, d_mblk, d_mpush;
    logic [1:0]  d_mn;
    logic [4:0]  d_uent;
    logic        d_useq, d_urs;
    logic [2:0]  d_ext;
    logic [7:0]  d_op, d_b1, d_b2;
    logic [3:0]  d_alu, d_lhs, d_rhs, d_dest;
    logic [1:0]  d_cond, d_pcsrc;
    logic [15:0] d_pc;
    always_ff @(posedge clk) begin
        d_valid <= ~rst & ~taken_q & go & piped;
        d_ucode <= ~rst & ~taken_q & go & ~piped;
        d_cbr   <= is_cbr;
        d_jump  <= is_jump & ~(pjok & ~pjcall);   // a predicted jmp has gone already
        d_pj    <= pjok;
        {d_mem, d_mst, d_mw2, d_mn, d_mblk, d_mpush} <= {c_mem, c_mst, c_mw2, c_mn, c_mblk, c_mpush};
        d_uent  <= c_uent;
        d_useq  <= c_useq;
        {d_ext, d_urs} <= {c_ext, c_urs};
        d_lsel  <= c_lsel;
`ifdef FRUCTUS_BLIT
        d_ulate <= c_ulate;
`endif
        d_pcsrc <= c_pcsrc;
        d_halt  <= c_halt;
        d_op    <= op;
        d_b1    <= ib1;
        d_b2    <= ib2;
        d_wen   <= c_wen;
        {d_alu, d_lhs, d_rhs, d_dest, d_cond} <= {c_alu, c_lhs, c_rhs, c_dest, c_cond};
        d_pc    <= pc;
    end

    // THE NEXT PC IS THE pc REGISTER.  Dispatch moved it on at the edge that
    // began this cycle, and nothing moves it again before this instruction
    // leaves decode except a redirect, which squashes this instruction too.
    // A flop of its own, loaded from the same sum, was measured on dispatch's
    // critical path at 32.67 MHz.
    wire [15:0] d_next = pc;

    // The instruction, whole, from the buffer.
    wire [7:0]  b1 = d_b1;
    wire [7:0]  b2 = d_b2;
    wire [23:0] ins = {b2, b1, d_op};

    wire [2:0] an, wn;
    lhs  l (.insn(ins), .src(d_lhs),  .regnum(an));
    dest d (.insn(ins), .src(d_dest), .regnum(wn));

    // --- the right-hand side, in predecode's rhs codes ------------------------------
    // A register is passed on as its number; anything else becomes a value.
    wire [2:0] rc = d_rhs[2:0];
    wire       rk = d_rhs[3];
    wire use_reg = (~rk & rc != 3'd4 & rc != 3'd2 & rc != 3'd3) | (rk & rc == 3'd5);
    wire use_imm = rk & (rc == 3'd3 | rc == 3'd4);
    wire [2:0]  bn = rk ? {ins[15:14], ins[0]} : rc;
    wire [15:0] imm;
    immgen g (.insn(ins), .cimm(rk & rc == 3'd4), .imm(imm));
    wire [15:0] konst = {{13{rc[2]}}, rc};
    // Code 2 is a call's return address, the next pc, which lr takes through
    // the ALU's pass-through.  Code 3 is a block move's offset from its
    // pointer - -2n for a push, 0 otherwise - which the ALU adds to make the
    // first address, as it adds a load's or store's offset.
    wire [15:0] moff_d;
    wire [15:0] bval  = use_imm ? imm : rk ? konst
                      : (rc == 3'd2) ? d_next : (rc == 3'd3) ? moff_d : ins[23:8];

    // --- a branch's condition, and a transfer's target -----------------------------
    // A displacement is always byte 2, since every relative transfer is a
    // three-byte branch, and counts from the instruction after - which
    // dispatch had already, as the pc it moved on to.  An absolute target is
    // bytes 1 and 2; a register's is the left operand.
    //
    // `call lr` IS THE EXCEPTION: its semantics are `lr = pc; pc = R[a]`, in
    // that order, so it goes to the NEW lr - the next instruction - and not the
    // register's old value, which is what `aq` holds.
    wire [2:0] ccode;
    wire       cneg, cmask;
    cond cu (.insn(ins), .src(d_cond), .code(ccode), .neg(cneg), .mask(cmask));
    wire        jreg    = (d_pcsrc == 2'd3);
    wire        calllr  = d_jump & d_wen & jreg & (an == `FRUCTUS_REG_LR);
    wire [15:0] tgt     = (d_pcsrc == 2'd2) ? ins[23:8]
                        : calllr            ? d_next
                        :                     d_next + {{8{b2[7]}}, b2};

    // =========================================================================
    // ALU
    // =========================================================================
    // THE OPERANDS ARE READ IN DECODE, into flops, so the ALU stage is those
    // two flops, the ALU and the write - as in the byte-serial core's cpu.sv, which measures 34
    // on the same harness for that reason.  Read in the ALU stage instead, the
    // register file's read put two more levels in front of the shifters, and
    // that measured 27.54.
    //
    // THE ONE HAZARD IS THE INSTRUCTION DIRECTLY AHEAD.  It is in the ALU
    // stage while this one decodes, and its result reaches the register file
    // only at the edge that ends this cycle, so the read below cannot see it.
    // Anything older has already landed.  So decode compares its register
    // numbers with that instruction's destination - `e_we`, one-hot, which
    // decode itself latched a cycle ago - and takes the ALU's result instead
    // of the register file's.  On the ALU's side that is one LUT between `y`
    // and the operand flop, in place of the two levels of read it replaces.
    // --- a memory instruction's registers, in the order of their addresses ------
    // The first is the destination field: a load's rd, a store's rs, a block
    // move's first register.  A push stores downward, so its registers lie in
    // memory the other way round, the last one lowest - and its encoding
    // turns them round to match, the last named in the destination field, so
    // the fields are in address order here for every block move.
    wire [2:0] ml0_d = wn, ml1_d = ins[13:11], ml2_d = {ins[15:14], ins[0]};
    wire [2:0] mN_d  = d_mw2 ? {d_mn, 1'b0} : {1'b0, d_mn};   // bytes: 1, 2, 4 or 6
    assign moff_d = d_mpush ? -{13'd0, mN_d} : 16'd0;         // a push starts 2n down
    // and its pointer ends there, where any other block move's ends 2n up -
    // chosen here, so the ALU stage needs no mux after its adder.
    wire [3:0] mstep_d = d_mpush ? -{1'b0, mN_d} : {1'b0, mN_d};

    (* ram_style = "logic" *)
    logic [15:0] R [0:7];

    logic [7:0]  e_we;                // the destination in the ALU stage, one-hot
    wire  [15:0] y;

    // DECODE'S LEFT PORT IS BORROWED for a store's data: decode is empty from
    // a memory instruction's ALU cycle until the sequencer is done, and the
    // choice is made by flops, so it did not lengthen decode's paths.
    wire [2:0] kreg_b;
    wire [2:0] an_rd = (e_mem | (mact & ~mdone)) ? kreg_b : an;
    // TWO SPELLINGS OF ONE FUNCTION.  While a routine runs decode is empty and
    // `an` may be x, and simulation would carry e_we[an] into aq - which a
    // routine reads - although e_we is 0 and the hardware's answer is 0 for
    // any `an`.  The AND-OR gives simulation that 0.  But yosys maps it
    // differently, on decode's critical path: 29.25 MHz against 30.61, medians
    // of sixteen seeds.  So synthesis keeps the index.
    // A load's last register is written in its routine's last step, when the
    // instruction after it may be in decode: the bypass takes that write too.
    wire [7:0] fwe = e_we | (mwe & {8{mdone}});
`ifdef SYNTHESIS
    wire fwd_a = fwe[an];
    wire fwd_b = use_reg & fwe[bn];
`else
    wire fwd_a = |(fwe & (8'd1 << an));
    wire fwd_b = use_reg & |(fwe & (8'd1 << bn));
`endif
    wire [15:0] rb = use_reg ? R[bn] : bval;

    // Everything decode hands on is dropped in a cycle that squashes: the
    // instruction in decode then is one of the three behind a taken branch.
    wire keep = d_valid & ~taken_q;
    wire mhold;                        // the sequencer holds the ALU on its word

    logic [3:0]  e_op;
    logic [15:0] aq, bq;
    logic        e_cbr, e_neg, e_mask, e_ucode, e_halt, e_jump, e_jreg, e_pj;
    logic [2:0]  e_code;
    logic [15:0] e_tgt;
    logic        e_mem, e_mst, e_mw2, e_mblk;
    logic [3:0]  e_mstep;
    logic [2:0]  e_l0, e_l1, e_l2, e_ptr;
    logic [4:0]  e_uent;               // where the microcode routine starts
    logic        e_useq;               // it runs one
    logic        e_urs;                // released at once
    // clz AND popcount STAY IN THE ALU STAGE A SECOND CYCLE, which dispatch
    // left empty, so decode has nothing to hand on.  The ALU finishes them from
    // a flop of its own - rtl/alu.sv - and writes rd twice: a wrong value in
    // the first cycle, which nothing reads, and the right one in the second,
    // which the instruction then in decode takes through the bypass as usual.
    logic [2:0]  e_cnt;               // held cycles still to come
    logic        e_two;               // held: clz or popcount's unary arm reads q
    logic        e_first;             // a held instruction's first ALU cycle
    wire         e_hold = e_cnt != 3'd0;
    wire         e_keep = e_hold & ~taken_q;   // held on; a squash ends it
    assign       xrel   = e_cnt == 3'd2;       // dispatch's release, for recip: above
    logic        e_valid;             // for the harness
    logic [15:0] e_pc;                // for the harness
    always_ff @(posedge clk) begin
        // A squash lands in the held instruction's first ALU cycle, if it is
        // the one behind a taken branch - and must end the hold there, or its
        // later cycles would write and retire it after all.
        e_valid <= e_hold ? (e_cnt == 3'd1) & ~taken_q : (keep & (d_ext == 3'd0));   // the last cycle retires
        e_cnt   <= (rst | taken_q) ? 3'd0 : e_hold ? e_cnt - 3'd1 : keep ? d_ext : 3'd0;
        e_two   <= ~rst & (e_hold ? e_two : keep & (d_ext != 3'd0));
        e_first <= ~rst & ~taken_q & ~e_hold & keep & (d_ext != 3'd0);
        aq      <= fwd_a ? y : R[an_rd];
        bq      <= fwd_b ? y : rb;
        if (!e_keep) e_we <= (keep & d_wen) ? 8'd1 << wn : 8'd0;
        // The sequencer holds the ALU on its word: the fast group's member 5.
        if (!e_keep) e_op <= mhold ? 4'd4 : d_alu;
        if (!e_keep) e_lsel <= mhold ? 3'd5 : d_lsel;
        e_cbr   <= keep & d_cbr;
        e_jump  <= keep & d_jump;
        e_pj    <= d_pj;
        e_jreg  <= jreg & ~calllr;
        {e_code, e_neg, e_mask} <= {ccode, cneg, cmask};
        e_tgt   <= tgt;
        e_ucode <= d_ucode & ~taken_q;
        e_mem   <= keep & d_mem;
        {e_mst, e_mw2, e_mblk} <= {d_mst, d_mw2, d_mblk};
        {e_mstep, e_l0, e_l1, e_l2, e_ptr} <= {mstep_d, ml0_d, ml1_d, ml2_d, an};
`ifdef FRUCTUS_BLIT
        // BLIT MODE CHOOSES THE LATE COPY HERE, flops into flops: the entry's
        // top bit, and no release in the ALU cycle.  The mode is sampled in
        // the load's decode cycle.  The late ld8 releases in its step 1
        // instead: released in its ALU cycle, the next instruction would
        // reach decode a step before the register it may read is written.
        e_uent  <= d_uent | {blit & d_ulate, 4'd0};
        e_useq  <= keep & d_useq;
        e_urs   <= d_urs & ~(blit & d_ulate);
`else
        e_uent  <= d_uent;
        e_useq  <= keep & d_useq;
        e_urs   <= d_urs;
`endif
        e_halt  <= d_halt;
        if (!e_keep) e_pc <= d_pc;
    end

    logic [15:0] ldq;                   // the sequencer's word: below
    wire [15:0] asum;
    wire [15:0] prod;                  // the SB_MAC16's, below
    alu a (.clk(clk), .lhs(aq), .rhs(bq), .op(e_op), .lsel(e_lsel), .two(e_two), .prod(prod), .mdata(ldq),
           .y(y), .sum(asum));

    // THE CONDITION HAS ITS OWN UNIT, as in the byte-serial core's cpu.sv: rtl/compare.sv's
    // subtractor reads the same operand flops as the ALU and none of its
    // result.  Its verdict is REGISTERED, so the comparison never reaches the
    // memory's address pins in the cycle it is made.  That costs a cycle on a
    // taken branch: the target dispatches two cycles after the branch's ALU
    // cycle, four after its own dispatch.
    // A JUMP TO A REGISTER GOES THROUGH taken_q, a cycle late, as rti does:
    // its target, aq, goes into tgt_q, which already takes aq for rti, and
    // the fetch goes there through taken_q's arm.  So aq - the operand flop
    // the ALU, the comparator and the bypass all hang on - no longer reaches
    // the address mux or the pc at all, and this arm is a flop's alone.
    // jmp ra, call ra and ret take four cycles, not three; `call lr`, whose
    // target is the next pc and not the register, stays at three.
    wire jreg_now = e_jump & e_jreg & ~taken_q;
    assign jnow  = e_jump & ~e_jreg & ~taken_q;
    assign jaddr = e_tgt;
    assign jfetch = jnow & ~e_pj;       // a predicted call's target is in already

    wire taken;
    compare cp (.lhs(aq), .rhs(bq), .cond(e_code), .neg(e_neg), .mask(e_mask), .taken(taken));

    // The instruction in the ALU stage while taken_q is set is the first of
    // the three behind the branch, so it may neither write nor branch.
    always_ff @(posedge clk) begin
        // THE MICROCODE REDIRECTS THROUGH THE SAME FLOPS a taken branch does, a
        // cycle after its word asks: a fourth arm on the address mux, for the
        // word's own address, measured 30.61 MHz against 31.13 without it.
        // The squash taken_q brings finds nothing to squash - dispatch is
        // stopped - and the routine's own writes are not taken_q's to stop.
        taken_q <= ~rst & ~taken_q & ((e_cbr & taken) | urj | jreg_now);
        tgt_q   <= (urj | jreg_now) ? rjaddr : e_tgt;
        for (int k = 0; k < 8; k++) if ((e_we[k] & ~taken_q) | mwe[k]) R[k] <= y;
    end
    assign result = y;

    // =========================================================================
    // THE MEMORY SEQUENCER
    // =========================================================================
    // It starts in a memory instruction's ALU cycle, whose ALU computes the
    // first address - a load puts it out at once, from the adder, and a store
    // keeps it in `mar` - and then takes one cycle an access, a byte or an
    // aligned word:
    //
    //     address steps  the address is mar, or the next access's for a load;
    //                    a store writes what `wq` holds, filled the step before
    //     arrivals       a load's byte comes back, from the lane its address
    //                    had, and shifts into `ldq` - low byte first - or its
    //                    aligned word, whole
    //     release        dispatch is let go as the last address goes out
    //
    // AND IT WRITES REGISTERS THROUGH THE ALU: e_op is held at 13, whose result
    // is `ldq`, and `mwe` joins the write enables.  A loaded register is written
    // the cycle after its last byte arrives, while the next byte shifts in
    // behind it.  A block move's pointer is written through the same word:
    // a load's FIRST, with any loaded register that is the pointer left
    // unwritten - the semantics end with the pointer's own value - and a
    // store's LAST, so that a stored register that is the pointer is still read
    // as it was.  Every write lands before the next instruction reaches decode,
    // so nothing needs the bypass.
    //
    // WHICH STEP DOES WHAT IS MICROCODE: rtl/ucode.sv, a block RAM
    // generated by tools/gen-ucode.js, whose header has the rules and the
    // word.  It is addressed by the instruction's shape and the step, a step
    // ahead - its output is registered, so every control here comes out of a
    // flop, the RAM's own.  Only what happens IN the ALU cycle is logic here:
    // no word can have been read for it.
    //
    // A WORD AT A TIME WHEN IT IS ALIGNED, a byte at a time when not.  An
    // ld, st, push, pop, ldm or stm whose first address is even takes each
    // register's two bytes in one access - a block move's addresses all have
    // its first one's parity - and runs the routine's ALIGNED COPY, at the
    // entry with bit 3 set: the byte routine's shape with one access a
    // register.  The ALU cycle chooses it, from bit 0 of the first address,
    // which is aq[0] ^ bq[0] and no carry: one LUT from the operand flops
    // into the ROM's address, and none of the adder's chain.  From then on
    // `mal` says every access moves a word: a capture takes the whole word,
    // a store writes both lanes, and mar steps by two.
    //
    // THE BOOT LOOP FILLS MEMORY FROM RESET, since the UP5K's SPRAM cannot be
    // initialised by the bitstream and the block RAMs can.  Reset with `boot`
    // leaves the sequencer running entry 0 - mact set, the step, the entry
    // and mar zero, a byte store's mst and mal - and dispatch stopped.  Entry
    // 0's word 0 is idle's, all zeros; its words 1 .. 7, which nothing else
    // reads, store one byte a lap, and with no D the step count wraps, so
    // the eight steps go round until the system resets again without `boot`.
    // The byte stored is not wq's: the system puts the flash's on the
    // memory's data pins, so nothing new stands between the register file
    // and the store port.  Counting from the first cycle out of reset as 0,
    // a lap's word k is in cycle 8n + k for n >= 0 and k >= 1 - cycle 0 has
    // word 1 too, read throughout reset - so byte n is written at the edge
    // ending cycle 8n + 5.  tools/fpga-system.sv's streamer keeps to that.
    // It costs the reset arms on six of the sequencer's flops, and nothing
    // on an address or data path: 7 LUT4s, and medians of sixteen of 30.85
    // MHz against 30.28 before it, spread 30.0 .. 32.5 against 29.4 .. 31.4;
    // the whole system, with rtl/spiboot.sv, 35 LUT4s and 27.19 against
    // 26.74, spread 26.5 .. 28.0 against 25.4 .. 27.5 - noise, both.
    wire mstart = e_useq & ~taken_q;
    wire [15:0] ea   = asum;
    wire        al   = e_mw2 & ~ea[0];     // a word instruction, aligned: bit 3
    wire [15:0] ptrv = aq + {{12{e_mstep[3]}}, e_mstep};   // where the pointer ends

    logic       mact, mst, mw2, mblk, mlane, weq, mal, wsel;
    logic [2:0] mu;                        // the step, less one
    logic [4:0] ment;                      // the routine's entry
    logic [2:0] ml0, ml1, ml2, mpr;
    logic [15:0] wq;
    logic [15:0] mpc;

    // A load puts its first address out in its ALU cycle, from the adder.
    assign ldnow = e_mem & ~e_mst;

    // THE ROUTINE'S ENTRY IS PREDECODE'S, a column of rtl/classify.sv
    // carried here like any other field, so any opcode can start anywhere.
    wire [31:0] uw;
    wire        mdone = uw[3];
    wire [4:0]  uent  = {e_uent[4], e_uent[3] | al, e_uent[2:0]};
    wire [7:0]  uaddr = mstart          ? {uent, 3'd0}
                      : (mact & ~mdone) ? {ment, mu + 3'd1}
                      :                   8'd0;
    ucode u (.clk(clk), .addr(uaddr), .word(uw));

    assign aphase   = uw[0];
    wire   mcap     = uw[1];
    // A routine done in one step - a load of one register in one access -
    // releases dispatch in its ALU cycle, before any word: predecode says so
    // for ld8, and for ld, pop and ldm of one register if they are aligned.
    wire   rs_now   = mstart & e_urs & ~(e_mw2 & ea[0]);
    assign mrestart = uw[2] | rs_now;
    wire   [1:0] uW  = uw[5:4];
    wire         uP  = uw[6];
    wire         uWE = uw[7];
    wire   [1:0] uKS = uw[9:8];
    wire         uKH = uw[10];
    wire   [1:0] uSH = uw[12:11];
    wire   [2:0] uLQ = uw[15:13];
    wire   [1:0] uWX = uw[17:16];
    wire   [1:0] uIE = uw[19:18];
    wire   [1:0] uRJ = uw[21:20];
    // THE SHADOWS' WORDS IN THE I/O PAGE, isa/fructus.toml's [cpu.io].  At a
    // load's capture `mar' is the address whose word is arriving - it went
    // out the cycle before, and mar moves only with an address - and a
    // store's address is mar, so both are decoded from a flop and not from
    // the adder.  A load takes the shadow in place of memory's word, at the
    // capture only, so nothing new is in front of decode; a store writes its
    // lanes into the shadow, and into memory as well, which reads nothing.
    logic [15:0] shadow_sp, shadow_lr, shadow_isp;
    localparam [15:0] SH_SP = `FRUCTUS_IO_SHADOW_SP, SH_LR = `FRUCTUS_IO_SHADOW_LR,
                      SH_ISP = `FRUCTUS_IO_SHADOW_ISP;
    wire         sh_sp  = mar[15:1] == SH_SP[15:1];
    wire         sh_lr  = mar[15:1] == SH_LR[15:1];
    wire         sh_isp = mar[15:1] == SH_ISP[15:1];
    // AND THE CYCLE COUNTER, [cpu.io] cycles: two read-only words, low first,
    // that a load takes as it takes a shadow and a store does not reach.  It
    // counts every clock from reset and has no hold register - software reads
    // hi, lo, hi and retries, crt/include/fructus/cycles.h - so it is a
    // counter and one more word on the shadows' mux, after memory's word has
    // already been passed over.
    //
    // FOUR BYTES, NOT ONE CARRY CHAIN.  An iCE40 carry chain is a column of
    // cells one above the other, and nextpnr places it whole: 32 bits are five
    // logic blocks in a line, wherever they land.  Nothing needs the count
    // sooner than a clock after its increment, so each byte has a chain of its
    // own and steps when `wrapq' says every bit below it is a one - decided a
    // cycle early, from the low byte at 0xfe, so that it steps in the same
    // cycle as one 32-bit increment would and the count is exactly that.
    localparam [15:0] CYC = `FRUCTUS_IO_CYCLES;
    logic [31:0] cycles;
    logic  [3:1] wrapq;
    always_ff @(posedge clk)
        if (rst) begin
            cycles <= 32'd0;
            wrapq  <= 3'd0;
        end else begin
            cycles[7:0] <= cycles[7:0] + 8'd1;
            if (wrapq[1]) cycles[15:8]  <= cycles[15:8]  + 8'd1;
            if (wrapq[2]) cycles[23:16] <= cycles[23:16] + 8'd1;
            if (wrapq[3]) cycles[31:24] <= cycles[31:24] + 8'd1;
            wrapq[1] <= cycles[7:0] == 8'hfe;
            wrapq[2] <= cycles[7:0] == 8'hfe && &cycles[15:8];
            wrapq[3] <= cycles[7:0] == 8'hfe && &cycles[23:8];
        end
    wire         cy     = mar[15:2] == CYC[15:2];
    wire  [15:0] shword = sh_sp ? shadow_sp : sh_lr ? shadow_lr : sh_isp ? shadow_isp
                        : mar[1] ? cycles[31:16] : cycles[15:0];
    wire         shrd   = sh_sp | sh_lr | sh_isp | cy;
    // THE GUARDS, the I/O page's first and last 16 bytes: a load or store
    // that touches one enters [cpu.vectors] io_guard, as an interrupt would,
    // at the first dispatch once `gq' is set - two cycles after a load's
    // address and one after a store's.  The instruction itself runs out
    // unchanged - the memory behind a guard is written, and a load takes what
    // is there - since the trap is a diagnostic, a stack run into the page,
    // and not something to return from.  Decoded from mar, like the shadows:
    // a store's access is at mar, and `mldq' says mar is an address a load
    // put out the cycle before.
    //
    // SO IT CAN BE AN INSTRUCTION LATE.  A memory instruction releases
    // dispatch a step before its last access, and the instruction after it
    // may dispatch in the very cycle a last access's hit sets gq: then it
    // runs, and the trap takes the dispatch after, lr the address after
    // that.  Making it exact would cost the adder's carry in front of gq or a
    // squash, for a diagnostic.  tools/sim.js keeps the same time.  A hit
    // that coincides with an interrupt's take makes that brk the guard's -
    // through gent below - so a hit is never lost; the interrupt, still
    // pending, comes after.
    wire         gmar = mar[15:8] == `FRUCTUS_IO_PAGE && (mar[7:4] == 4'h0 || mar[7:4] == 4'hf);
    logic        mldq, gent;
    wire         ghit = gmar & (mldq | (weq & aphase));
`ifdef FRUCTUS_BLIT
    // A late routine's capture takes its byte from mem_late, whose lane is the
    // one mlane held a cycle before.  Only the word's L bit chooses it, so an
    // instruction byte never comes from there, nor a byte of pop's.  Its
    // address was mar a cycle before, so whether it was a shadow's is too.
    wire         uL  = uw[22];
    logic        mlane2, shrd2;
    logic [15:0] shword2;
    always_ff @(posedge clk) begin mlane2 <= mlane; shrd2 <= shrd; shword2 <= shword; end
    wire  [15:0] mlw   = shrd2 ? shword2 : mem_late;
    wire  [15:0] mdw   = shrd  ? shword  : mem_data;
    wire  [15:0] mword = uL ? mlw : mdw;
    wire   [7:0] mbyte = uL ? (mlane2 ? mlw[15:8] : mlw[7:0])
                            : mlane ? mdw[15:8] : mdw[7:0];
`else
    wire  [15:0] mdw   = shrd ? shword : mem_rdata;
    wire  [15:0] mword = mdw;
    wire   [7:0] mbyte = mlane ? mdw[15:8] : mdw[7:0];
`endif

    // A loaded register that is the pointer is not written: the pointer's own
    // value is the one the semantics end with.
    wire [2:0] wreg = (uW == 2'd1) ? ml0 : (uW == 2'd2) ? ml1 : ml2;
    wire       wdat = (uW != 2'd0) & ~(mblk & wreg == mpr);
    wire [7:0] mwe  = (wdat ? 8'd1 << wreg : 8'd0) | (uP ? 8'd1 << mpr : 8'd0)
                    | (uWX == 2'd1 ? 8'd1 << `FRUCTUS_REG_SP : 8'd0)
                    | (uWX == 2'd2 ? 8'd1 << `FRUCTUS_REG_LR : 8'd0);

    assign mhold = mstart | (mact & ~mdone);

    // A store's next access: the first register in the ALU cycle, and after
    // that the one the word names.  It is read through DECODE'S LEFT
    // PORT, which has nothing to do from a memory instruction's ALU cycle
    // until the sequencer releases dispatch.  Two ports of the sequencer's own
    // - a word for the later bytes and one for byte 0 - were 186 of its 572
    // LUTs; one port of its own, a byte wide, still 114 more than borrowing.
    wire [2:0] kreg  = mstart ? e_l0 : (uKS == 2'd0) ? ml0 : (uKS == 2'd1) ? ml1
                     : (uKS == 2'd2) ? ml2 : {`FRUCTUS_REG_SPLR, uKH};    // 3: sp or lr
    assign kreg_b = kreg;
    wire       khalf = ~mstart & uKH;
    wire [15:0] kword = R[an_rd];
    // wq TAKES THE WHOLE REGISTER, and `wsel` which half a byte store writes,
    // so the half is chosen after the flop, on its way to the memory, and not
    // between the register file's read and wq, where decode's longest path
    // - from the SPRAM, through a register number and the read - ended.

    always_ff @(posedge clk) begin
        if (rst)         mact <= boot;
        else if (mstart) mact <= 1'b1;
        else if (mdone)  mact <= 1'b0;
        if (rst) begin
            // The boot loop's state; the rest is the system's or unused.
            mu <= 3'd0; ment <= 5'd0; mar <= 16'd0;
            {mst, mal} <= 2'b10;
            weq <= 1'b0;
        end else if (mstart) begin
            mu  <= 3'd0;
            ment <= uent;
            mar <= ea;
            mlane <= ea[0];
            mal <= al;
            ldq <= ptrv;                   // a block's pointer, written from here
            {mst, mw2, mblk} <= {e_mst, e_mw2, e_mblk};
            {ml0, ml1, ml2, mpr} <= {e_l0, e_l1, e_l2, e_ptr};
            mpc <= e_pc;
            wq  <= kword;
            wsel <= khalf;
            weq <= e_mst;
        end else begin
            mu  <= mu + 3'd1;
            if (aphase) begin mar <= mar + {14'd0, mal, ~mal}; mlane <= maddr[0]; end
            if (mcap)   ldq <= mal ? mword : mw2 ? {mbyte, ldq[15:8]} : {8'h00, mbyte};
            else if (uLQ != 3'd0) ldq <= lqsrc;
            wq  <= kword;
            wsel <= khalf;
            weq <= uWE;
        end
    end
    // --- the exception state ----------------------------------------------------
    // THREE SHADOWS AND ie, reached by microcode - and the shadows by loads
    // and stores, at THE SHADOWS' WORDS above: a shadow takes aq -
    // the word the borrowed port read the step before - and gives its value to
    // ldq, which the ALU's pass-through writes to sp or lr, so neither the
    // register file nor its write port has anything new in front of it.
    // rti's return address is aq too.  The vector is isa/fructus.toml's
    // [cpu.vectors] brk.
    localparam [15:0] VECTOR = `FRUCTUS_VECTOR_BRK;
    logic        ie;
    assign ie_q  = ie;
    // THE PRODUCT OF aq AND bq, worked on every cycle and a cycle late: the ALU
    // takes it as op 14 in a mul's second, held cycle.  e_lsel, which op 14
    // has no other use for, says which half - see rtl/alu.sv's mul.  (clz and popcount chosen
    // whole into ldq in the ALU cycle once measured 26.40 MHz: yosys pushed ldq
    // back into the popcount tree, and the flops it made there took a reset
    // from dispatch.)
    // recip's answer is ORed in, zero but in its last held cycle, and an lsel
    // of 111 has zeroed all three of mul's halves - rtl/recip.sv.
    wire [15:0] mprod, rprod;
    mul  mulu (.clk(clk), .a(aq), .b(bq), .z(e_lsel), .p(mprod));
    assign prod = mprod | rprod;
    // A module of its own, or abc maps decode a cell deeper: rtl/recip.sv.
    wire rgo = e_op == 4'd14 && e_lsel == 3'b111;
    (* keep_hierarchy *)
    recip rcp (.clk(clk), .a(aq), .go(rgo), .cnt(e_cnt), .p(rprod));
    wire [15:0] lqsrc = (uLQ == 3'd1) ? pc
                      : (uLQ == 3'd2) ? shadow_sp
                      : (uLQ == 3'd3) ? shadow_lr : shadow_isp;
    assign urj    = uRJ != 2'd0;
    localparam [15:0] GVECTOR = `FRUCTUS_VECTOR_IO_GUARD;
    localparam [15:0] DVECTOR = `FRUCTUS_VECTOR_DIVIDE_BY_ZERO;
    assign rjaddr = (urj & uRJ[0]) ? (gent ? GVECTOR : dent ? DVECTOR : VECTOR) : aq;   // aq: rti's, or a register jump's
    // The guard trap: gq from the faulting access until its brk is taken;
    // gent through that brk's routine, which jumps to GVECTOR.
    // THE DIVIDE BY ZERO is the same again, from recip's first ALU cycle,
    // where aq is ra: dq until its brk is taken, dent through the routine.
    // recip stops dispatch and releases it with three held cycles to come,
    // so the next dispatch is two cycles after dq is set - never late.  A
    // recip squashed behind a taken branch sets nothing.
    logic        dent;
    wire         dhit = e_first & rgo & ~aq[15] & ~taken_q;
    always_ff @(posedge clk) begin
        mldq <= ~rst & ((mstart & ldnow) | (aphase & ~mst));
        gq   <= ~rst & ~take & (gq | ghit);
        gent <= ~rst & (take ? gq | ghit : gent & ~(urj & uRJ[0]));
        dq   <= ~rst & ~take & (dq | dhit);
        dent <= ~rst & (take ? dq : dent & ~(urj & uRJ[0]));
    end
    assign wake   = halted & ie & irq;
    always_ff @(posedge clk) begin
        if (uSH == 2'd1) shadow_sp  <= aq;
        if (uSH == 2'd2) shadow_lr  <= aq;
        if (uSH == 2'd3) shadow_isp <= aq;
        // A store's lanes, at mar: never in the same cycle as uSH, which only
        // brk's and rti's routines set, and they store nothing.
        if (sh_sp  & mem_we[0]) shadow_sp[7:0]   <= mem_wdata[7:0];
        if (sh_sp  & mem_we[1]) shadow_sp[15:8]  <= mem_wdata[15:8];
        if (sh_lr  & mem_we[0]) shadow_lr[7:0]   <= mem_wdata[7:0];
        if (sh_lr  & mem_we[1]) shadow_lr[15:8]  <= mem_wdata[15:8];
        if (sh_isp & mem_we[0]) shadow_isp[7:0]  <= mem_wdata[7:0];
        if (sh_isp & mem_we[1]) shadow_isp[15:8] <= mem_wdata[15:8];
        if (rst)                ie <= 1'b0;
        else if (uIE == 2'd1)   ie <= 1'b0;
        else if (uIE == 2'd2)   ie <= 1'b1;
    end

    // A store's address is mar; a load's, whose mar is the address it last
    // put out, the one after - a word on, if aligned.
    assign maddr = mar + {14'd0, ~mst & mal, ~mst & ~mal};
    // A word goes out as it is; a byte in both lanes, and only its own lane
    // is written.
    assign mem_wdata = {(mal | wsel) ? wq[15:8] : wq[7:0], (~mal & wsel) ? wq[15:8] : wq[7:0]};
    wire [1:0] wlanes = {mal | mar[0], mal | ~mar[0]};
    assign mem_we    = {2{weq & aphase}} & wlanes;
    assign retire    = (e_valid & ~taken_q & ~e_useq) | mdone;
    assign retire_pc = mdone ? mpc : e_pc;

    // --- the one microcoded instruction there is --------------------------------
    // It takes effect in the ALU stage, not in decode, because a halt just
    // behind a taken branch reaches decode before the branch is decided.
    always_ff @(posedge clk)
        if (rst) begin halted <= 1'b0; trapped <= 1'b0; end
        else if (e_ucode & ~taken_q) begin halted <= e_halt; trapped <= ~e_halt; end
        else if (wake) halted <= 1'b0;

endmodule
