; ============================================================================
; abi.s - the fructus calling convention
; ============================================================================
;
; This file is documentation that assembles.  Every sequence below is real code
; and every byte count in a comment was produced by the assembler, so the costs
; here cannot drift away from the ISA the way a prose document would.
;
; ----------------------------------------------------------------------------
; REGISTERS
; ----------------------------------------------------------------------------
;
;   r0   argument 0 / return value       caller saved, always
;   r1   argument 1 / return value high  caller saved, always
;   r2   argument 2                      SLIDING - see below
;   r3   argument 3                      SLIDING - see below
;   r4   -                               CALLEE saved, always
;   r5   -                               caller saved, always, and the
;                                        assembler's immediate scratch register
;   r6   sp, the stack pointer           preserved by definition
;   r7   lr, the link register           both - see below
;
; lr IS BOTH, DEPENDING ON WHICH END YOU STAND AT.  From the caller's side it is
; caller saved: `call` overwrites it, so no caller may expect it to survive.
; From the callee's side it is callee saved: the return address arrives in it
; and has to still be there at the `ret`, so a function that calls anything must
; save and restore it.  The two views do not conflict, because nobody is
; preserving lr for anybody else - each end is describing its own obligation.
; A leaf function does not have to touch it at all, which is the whole reason it
; is a register and not a stack slot.
;
; WHY r5 IS CALLER SAVED, when there are so few registers to give away.  r5 is
; the register the assembler borrows when an immediate does not fit its
; instruction - `add sp, sp, #-600` becomes `mov r5, #-600` then `add sp, sp,
; r5`.  A function can therefore destroy r5 without any line of its source
; mentioning r5, so it cannot promise to preserve it, so it cannot be callee
; saved.  Worse, the same source would mean different things in the assembler's
; two immediate modes, and hand-written and compiled code linked together would
; disagree about who owns the register.
;
; This is MIPS's answer for $at, and it costs what MIPS's does: one register in
; the middle of the file that neither side may rely on.
;
; ----------------------------------------------------------------------------
; THE SLIDING REGISTERS - THE SAVE CONVENTION DEPENDS ON THE ARITY
; ----------------------------------------------------------------------------
;
; r2 and r3 have no fixed save convention.  For each one, independently:
;
;       CALLER saved   if this function takes an argument in it
;       CALLEE saved   if it does not
;
; which gives three conventions rather than one:
;
;   arg registers used         caller saved              callee saved
;   ------------------------   ----------------------    ---------------
;   0, 1 or 2   (r0, r1)       r0 r1 r5                  r2 r3 r4
;   3           (r0, r1, r2)   r0 r1 r2 r5               r3 r4
;   4           (r0 - r3)      r0 r1 r2 r3 r5            r4
;
; COUNT REGISTERS, NOT ARGUMENTS.  A 32-bit value occupies two registers and a
; struct is decomposed into its fields, so f(long, long) uses four argument
; registers and has the bottom row's convention even though it has two
; arguments.  The count is over the NAMED parameters only; see varargs below.
;
; DO NOT TUNE ANY OF THIS AROUND 32-BIT ARGUMENTS.  f(long, long) is the shape
; that consumes the whole argument file at once, and it is tempting to reason
; from it because the 32-bit routines in snippets/ are written that way.  Those
; are library internals.  In ordinary code a 32-bit argument is rare, and a pair
; of them is rarer, so the rows that matter for the design are the top two.
;
; r4 IS NEVER AN ARGUMENT REGISTER and is always callee saved, so the callee
; saved set is never empty.  Every function, whatever its arity, has at least
; one register it can keep a value in across a call.
;
; ----------------------------------------------------------------------------
; WHY THIS IS WORTH THE COMPLICATION
; ----------------------------------------------------------------------------
;
; Caller saved and callee saved are two readings of one fact.  A caller saved
; register is free for the callee to clobber, and is destroyed by every call the
; callee makes.  A callee saved register costs the callee a push to use, and
; then survives the callee's own calls.  Which one a function wants is decided
; by whether it makes calls, not by how big it is.
;
; The bet here is that ARITY IS A USABLE PROXY FOR THAT, in the direction that a
; function with one or two arguments is more often a small leaf - a comparison,
; an accessor, a character class test.  Such a function never touches r2 or r3,
; so making them callee saved costs it exactly nothing, and hands its callers
; two extra registers that survive the call.  A function with four arguments
; already has its arguments sitting in r2 and r3 and wants to overwrite them,
; and is the case where making them callee saved would charge the callee for
; consuming its own arguments.
;
; The bet loses on a one-argument function with high register pressure, which
; now pays a push and a pop to use r2 and r3 where it previously got them free.
; That cost is bounded and paid once per call; the gain is paid back at every
; call site that had something live across the call.
;
; ARITY IS THE ONLY PER-FUNCTION CONVENTION THAT IS FREE TO DISTRIBUTE.  This is
; a crude version of what a compiler does with interprocedural register
; allocation, where the caller learns the callee's real clobber set - better
; information, but information that has to be computed from the whole program
; and then communicated.  Arity needs no channel at all: the caller cannot emit
; the call without the prototype, and the prototype is the whole input to the
; rule, so both ends derive the same answer independently and separate
; compilation is unaffected.
;
; ----------------------------------------------------------------------------
; THE CONVENTION IS PART OF THE TYPE
; ----------------------------------------------------------------------------
;
; Two function pointers with different argument register counts are NOT
; interchangeable, even where C would otherwise allow it.  Calling through a
; pointer cast to the wrong arity is already undefined behaviour; the difference
; here is that it stops being undefined-but-works and becomes silent register
; corruption in the caller, surfacing arbitrarily far from the cast.
;
; This is a real pattern - uniform dispatch tables of mixed-arity handlers,
; reached through one pointer type and cast back at the point of call, or not
; cast back at all.  The rule for such code is that IT ANNOTATES.  A function
; that will be called through a pointer of the wrong type carries an explicit
; calling convention on its definition, and then it has one convention for
; everybody.  The ABI does not try to make the shenanigans safe; it makes them
; declare themselves.
;
; NOTHING CHECKS THIS YET, and a mismatch is silent - the callee returns having
; clobbered a register the caller expected back, and the damage shows up far
; from the call.  A `.args` declaration is the fix if it turns out to be needed:
; each callable symbol states its argument register count, the assembler
; verifies it at every call site whose target it can resolve, and the count goes
; into the object file so the linker rejects a disagreement between separately
; assembled files.  That turns silent corruption into a link error.
;
; It is not written because it is not yet earned.  With one assembler and no
; separate compilation, a call site and its target are usually in the same file
; and under the same pair of eyes.  The declaration becomes worth its complexity
; when there is a compiler emitting calls from prototypes it cannot see the
; definitions of - which is also the point at which the arity rule stops being
; a convention people follow and starts being one they can get wrong at a
; distance.  Noting it here so the option is on the record and the ABI does not
; have to be reopened to add it.
;
; VARARGS COMPOSES CLEANLY, because unnamed arguments always go on the stack.
; The count that selects the convention is the count of NAMED parameters, so
; printf(const char *, ...) uses one argument register and has r2, r3 and r4
; callee saved, which is also what a variadic function wants - it is going to
; walk a list and call things.
;
; ----------------------------------------------------------------------------
; WHAT A PUSH ACTUALLY COSTS
; ----------------------------------------------------------------------------
;
; Byte count is a good first proxy for run time, because the memory bus is
; 6502-like and every instruction byte is a bus cycle to fetch.  It is not the
; whole story for push and pop.  Each 16-bit memory access costs TWO MORE bus
; cycles on top of the fetch, and a multi-register push does one access per
; register named:
;
;       push    lr                      2 bytes    2 + 2 = 4 bus cycles
;       push    lr, r4                  2 bytes    2 + 4 = 6 bus cycles
;       push    lr, r4, r3              2 bytes    2 + 6 = 8 bus cycles
;
; THE SECOND AND THIRD REGISTERS OF A PUSH ARE FREE IN SPACE AND NOT IN TIME.
; That matters for reasoning about the save convention, because it is easy to
; look at the byte counts alone and conclude that preserving three registers is
; as cheap as preserving one.  It is, to the fetch unit; it is twice the work to
; the bus.
;
; The comparison still comes out the same way, and by more than the bytes
; suggest.  Using a callee saved register costs 4 extra bus cycles ONCE PER
; INVOCATION - two on the push, two on the pop, with no extra fetch at all.  A
; caller spilling one value around a call costs 4 bytes and 8 bus cycles EVERY
; TIME THAT CALL SITE EXECUTES.  A call inside a loop pays the second cost per
; iteration and the first not at all, which is the case the sliding convention
; is really aimed at.
;
; ----------------------------------------------------------------------------
; ARGUMENTS
; ----------------------------------------------------------------------------
;
; One register per value up to 16 bits.  A 32-bit value takes two registers,
; HIGH half first.  Structs are decomposed into their fields and each field is
; assigned independently - there is no such thing as passing a struct.
;
; Assignment walks the arguments left to right over the list r0, r1, r2, r3 and
; then the stack.  Three rules make that unambiguous:
;
;   NO PAIR ALIGNMENT.  A 32-bit value may start in any register, including r1
;   or r3.  With only four argument registers, burning one on padding would
;   leave f(int16, int32) with a single register's worth of arguments, and the
;   ISA has no register-pair instruction that would benefit from the alignment.
;
;   NO SPLITTING.  A value that does not fit entirely in the registers left
;   goes entirely on the stack.  At most one register is wasted, and the callee
;   never has to reassemble a value from two places.
;
;   NO BACKFILLING.  Once an argument has gone to the stack, every later
;   argument goes to the stack too, even a small one that would still fit.  This
;   is what keeps the stack block contiguous, which is what makes varargs work.
;
; ----------------------------------------------------------------------------
; 8-BIT ARGUMENTS
; ----------------------------------------------------------------------------
;
; A byte-sized argument takes a WHOLE REGISTER but only ONE BYTE OF STACK.  The
; two halves of that rule are asymmetric on purpose, and each is the cheap
; choice for where the value is:
;
;   IN A REGISTER the value is in the low 8 bits and THE HIGH 8 BITS ARE
;   UNSPECIFIED.  The caller is not required to clear them, sign extend them, or
;   do anything else with them, and the callee MUST NOT LOOK AT THEM.  A callee
;   that needs a clean 16-bit value says so itself:
;
;       zxt8    r0, r0          ; unsigned char argument      2 bytes
;       sxt8    r0, r0          ; signed char argument        2 bytes
;
;   which is why those two instructions exist.  Putting the burden on the callee
;   costs two bytes in the functions that care and nothing anywhere else; the
;   other way round, every caller pays whether the callee looks or not.
;
;   ON THE STACK the value is one byte and IS NOT PADDED.  `push8` pushes one
;   byte and moves sp by one, so an argument after a byte argument sits at an
;   ODD offset, and so does everything after it.  That is fine: the ISA allows
;   unaligned 16-bit access with no fault and no penalty, so a misaligned stack
;   slot costs literally nothing to read.  Packing is the free option and
;   padding would waste a byte per char in the one place where bytes are scarce.
;
; RETURNING a byte works the same way: the value is in the low 8 bits of r0 and
; the high bits are unspecified, so a caller that needs 16 clean bits extends it
; itself.
;
; ----------------------------------------------------------------------------
; RETURN VALUES
; ----------------------------------------------------------------------------
;
;   up to 8 bits     r0, low byte, high byte unspecified
;   up to 16 bits    r0
;   32 bits          r0:r1, high:low - the same shape as an argument pair
;   anything larger  the CALLER allocates the space and passes a pointer to it
;                    as a hidden first argument in r0, shifting the real
;                    arguments up one register.  The callee writes through it
;                    and returns that same pointer in r0.
;
; ----------------------------------------------------------------------------
; THE STACK
; ----------------------------------------------------------------------------
;
; Grows DOWN.  sp points at the last thing pushed, not at free space.  There is
; no frame pointer: every access is sp relative and the compiler tracks the
; offset.  A function with a variable sized frame therefore cannot exist, which
; is the price of the register.
;
; NO ALIGNMENT REQUIREMENT ANYWHERE.  sp may be odd, and after a single `push8`
; it is.  The ISA allows unaligned 16-bit accesses with no fault and no penalty
; visible to software, so nothing has to be padded and nothing has to be
; realigned before a call.
;
; The caller pushes stack arguments in REVERSE order, last argument first, so
; that the first stack argument ends up nearest sp.  This is not a style choice;
; see WHY THE PUSH ORDER IS REVERSED below.
;
;       high addresses
;               ...
;               stack argument 2
;               stack argument 1, high half
;               stack argument 1, low half
;               stack argument 0            <- sp on entry to the callee
;               saved lr                    <- sp after the prologue
;               saved r4
;               locals ...                  <- sp in the body
;       low addresses
;
; ----------------------------------------------------------------------------
; WHY THE PUSH ORDER IS REVERSED
; ----------------------------------------------------------------------------
;
; Pushing the stack arguments in their written order is the obvious thing and it
; does not work.  The stack grows down, so the FIRST value pushed ends up at the
; highest address - which means pushing in order puts the LAST argument at sp
; and the first argument at the far end of the block.  The distance from sp to
; any given argument is then the total size of everything after it, so every
; offset in the callee depends on the total argument count.
;
; For a prototyped call that is merely ugly: the compiler knows the count and
; can compute the offsets.  For varargs it is fatal.  On entry sp points at the
; BOTTOM of the argument block and the block's size is exactly what a variadic
; callee does not know, so it cannot find where the arguments start, and no
; amount of reading the named arguments helps - they tell it how many arguments
; there are, but it needs to know that before it can find them.
;
; Reversing the push order fixes it by making the block grow AWAY from sp.  The
; first stack argument is then at sp+0 always, and each argument's offset is the
; total size of the arguments BEFORE it - which the callee knows from its own
; prototype, without knowing the count.  This is why cdecl pushes right to left,
; and the reason is the same one.
;
; ----------------------------------------------------------------------------
; THE PUSH ORDER AND THE REGISTER ORDER ARE INDEPENDENT
; ----------------------------------------------------------------------------
;
; Reversing the argument order does NOT force 32-bit values into lo:hi register
; order.  There are two orderings here and they are separate:
;
;   BETWEEN arguments   reversed - last argument pushed first
;   WITHIN an argument   NOT reversed - high half pushed first
;
; The second one is fixed by endianness alone and has nothing to do with the
; first.  The stack grows down, so whichever half is pushed first lands higher;
; little endian wants the low half lower; therefore the high half is pushed
; first, whatever order the arguments themselves are in.  f(a32, b32) both on
; the stack pushes b.hi, b.lo, a.hi, a.lo, and comes out as
;
;       sp+0  a.lo    sp+2  a.hi    sp+4  b.lo    sp+6  b.hi
;
; - first argument nearest sp, and each value little endian.  Both properties at
; once, with the registers still written high:low.
;
; THE INFERENCE IS RIGHT FOR ONE PARTICULAR IMPLEMENTATION.  If the reversal is
; defined over the flat list of REGISTERS rather than over the arguments -
; "emit the pushes backwards" - then a hi:lo pair comes out lo first and lands
; big endian, and the fix really is to swap the register convention to lo:hi.
; Both schemes produce the identical instruction sequence and the identical
; memory image; they differ only in which register holds the high half.
;
; SO KEEP hi:lo, for three reasons that all point the same way.  Every 32-bit
; routine already written assumes it - add32.s, roll32.s, fpadd.s and fpsub.s
; all use r0:r1 as high:low.  `push ra, rb` pushes ra first, so the two-
; register push already takes its operands in high:low order.  And "reverse the
; arguments" is the rule a compiler wants anyway, because argument boundaries
; are where the no-splitting rule lives.
;
; ----------------------------------------------------------------------------
; WHY hi:lo LOOKS LITTLE ENDIAN ON THE STACK
; ----------------------------------------------------------------------------
;
; A 32-bit value lives in a register pair as high:low, and it is pushed in that
; order - high first.  The stack grows down, so the FIRST thing pushed lands at
; the HIGHER address.  The low half therefore ends up below the high half,
; which is exactly the layout `endian = "little"` gives a 32-bit value in data
; memory.  Register order and memory order agree without anything having to be
; reversed, and a spilled 32-bit value can be reloaded by a pair of ld16s at
; consecutive addresses in either direction.
;
; The multi-register push takes its operands in that same order, so a 32-bit
; value is pushed by naming its pair the way it is already written:
;
;       push    r0, r1          ; a 32-bit value in r0:r1, correctly ordered  2
;
; NOTHING IS COALESCED.  What is written is what runs: `push r0` followed by
; `push r1` is two instructions and four bytes, and `push r0, r1` is one
; instruction and two.  The assembler will not merge them and the disassembler
; will not split them, so a prologue's cost is a property of the source rather
; than of the tool that assembled it.
; ============================================================================


; ============================================================================
; A leaf function                                                    4 bytes
; ============================================================================
; It calls nothing, so lr is untouched and there is no prologue at all.  A leaf
; may freely clobber its own argument registers and r5 - here r0, r1, r2 and r5,
; four registers, which is enough that most small functions never touch memory.
;
; This is where the sliding convention charges its premium.  add3 takes three
; arguments, so r3 and r4 are callee saved and a leaf that wants them pays one
; push and one pop, four bytes, to borrow them.  Before the convention slid,
; r3 was free here.  What the four bytes buy is on the other side of the call:
; every caller of add3 now keeps two more registers across it.
;
;       int16_t add3(int16_t a, int16_t b, int16_t c)

leaf_example:
        add     r0, r0, r1              ; a + b                          1
        add     r0, r0, r2              ; + c                            2
        ret                             ;                                1

; THE FIRST ADD IS ONE BYTE.  `add r0, r0, r1` is one of the pinned implicit
; encodings in the one-byte region, and it is reachable here only because the
; ABI puts argument 0 in r0 and argument 1 in r1.  The one-byte forms were
; chosen by frequency before this convention existed; assigning arguments from
; r0 upward is what cashes them in.  Combining the first two arguments of a
; function is about as common as operations get.


; ============================================================================
; A leaf function taking bytes                                       6 bytes
; ============================================================================
; The high halves of r0 and r1 are whatever the caller happened to leave there,
; so a function that does 16-bit arithmetic on them must extend first.
;
;       int16_t sum(unsigned char a, signed char b)

byte_example:
        zxt8    r0, r0                  ; a was unsigned                 2
        sxt8    r1, r1                  ; b was signed                   2
        add     r0, r0, r1              ;                                1
        ret                             ;                                1

; A function that only passes its byte arguments along, or only stores them
; with st8, extends nothing and pays nothing.


; ============================================================================
; A non-leaf function                                   5 bytes of overhead
; ============================================================================
; Save lr, call, restore, return.  `ret` does not pop: it is `pc = lr` and
; nothing more, so lr has to be back in place before it runs.
;
; Two bytes of prologue, two of epilogue and the ret - five bytes that a leaf
; function does not pay.

nonleaf_example:
        push    lr                      ;                                2
        call    leaf_example            ;                                3
        pop     lr                      ;                                2
        ret                             ;                                1


; ============================================================================
; A non-leaf that uses its callee-saved registers       5 bytes of overhead
; ============================================================================
; The SAME five bytes, whether it preserves one register or three.  A function
; with two arguments has r2, r3 and r4 callee saved, and lr plus any two of them
; fit in a single push - so the whole callee-save prologue is one instruction
; however the convention slid.
;
;       int16_t f(int16_t a, int16_t b)         2 argument registers

full_example:
        push    lr, r4, r3              ; lr and two of them, one push   2
        ; ... body, free to use r0, r1, r3, r4, r5 ...
        pop     r3, r4, lr              ; reverse order                  2
        ret                             ;                                1

; THE THIRD REGISTER IS FREE IN BYTES AND NOT IN CYCLES.  This push is the same
; two bytes as `push lr` and does three times the bus work: 8 cycles against
; 4, and the same again on the pop.  Naming a register you do not use costs
; nothing to fetch and four cycles to execute, so the prologue should still name
; only what the body actually touches.

; POP ORDER IS THE REVERSE OF PUSH ORDER.  A push writes its registers left to
; right and the stack grows down, so the first named lands highest; a pop reads
; left to right and takes them off in the order they come.  Getting this
; backwards is silent, so read a multi-register push or pop as "first named,
; first moved".


; ============================================================================
; Spilling arguments across a call                       4 bytes of overhead
; ============================================================================
; r0-r3 and r5 do not survive a call, so a caller that still needs them saves
; them itself.  Three at a time, two bytes each way.

spill_example:
        push    r0, r1, r2              ; three registers, one push      2
        call    leaf_example            ;                                3
        pop     r2, r1, r0              ; reverse                        2
        ret                             ;                                1

; HOW MUCH THERE IS TO SPILL DEPENDS ON WHAT IS BEING CALLED.  A call to a
; four-argument function leaves only r4 standing and this is the common shape;
; a call to a one-argument function leaves r2, r3 and r4, and most of the spill
; disappears.  The caller knows which from the prototype it already has.
;
; THIS IS WHAT THE THREE-REGISTER FORM IS FOR.  It covers the worst case in one
; instruction each way, which is what makes the sliding convention affordable:
; when the arity bet goes against the caller, the fallback is two bytes, not a
; restructured frame.


; ============================================================================
; What the sliding convention buys                    4 bytes per iteration
; ============================================================================
; A loop around a call is where the two save conventions come apart, because a
; caller's spill repeats and a prologue's push does not.  This function has one
; argument, so r2, r3 and r4 are all callee saved and two live values stay in
; registers across the call.
;
;       int16_t sum(node_t *list)       1 argument register

loop_example:
        push    lr, r4, r3              ; one push covers all three      2
        mov     r3, r0                  ; the cursor                     2
        mov     r4, #0                  ; the accumulator                2
loop_body:
        ld      r0, [r3, #2]            ; node->value                    2
        call    leaf_example            ;                                3
        add     r4, r4, r0              ;                                2
        ld      r3, [r3, #0]            ; cursor = cursor->next          2
        br      ne, r3, #0, loop_body   ;                                3
        mov     r0, r4                  ;                                2
        pop     r3, r4, lr              ;                                2
        ret                             ;                    total  23   1

; THE SAME FUNCTION UNDER A FIXED CONVENTION, where only r4 is callee saved.
; One live value fits and the other does not, so the cursor is spilled around
; the call - inside the loop, where it is paid every iteration.

loop_example_alt:
        push    lr, r4                  ;                                2
        mov     r3, r0                  ;                                2
        mov     r4, #0                  ;                                2
loop_body_alt:
        ld      r0, [r3, #2]            ;                                2
        push    r3                      ; <-- per iteration              2
        call    leaf_example            ;                                3
        pop     r3                      ; <-- per iteration              2
        add     r4, r4, r0              ;                                2
        ld      r3, [r3, #0]            ;                                2
        br      ne, r3, #0, loop_body_alt ;                              3
        mov     r0, r4                  ;                                2
        pop     r4, lr                  ;                                2
        ret                             ;                    total  27   1

; 12 bytes of loop body against 16, and the difference is not only bytes: the
; two extra instructions are a push and a pop, so they carry 8 bus cycles of
; memory traffic on top of their 4 bytes of fetch, every iteration.  The push
; that replaced them is one instruction executed once.
;
; THE PROLOGUES ARE THE SAME SIZE.  `push lr, r4, r3` and `push lr, r4` are
; both two bytes, so the extra callee-saved register cost this function nothing
; to fetch and 4 bus cycles once.  That is the whole trade, and it is the reason
; the sliding convention is cheap to lose with: when arity guesses wrong, the
; loser pays two bytes, and when it guesses right the winner stops paying in a
; loop.


; ============================================================================
; Indirect calls
; ============================================================================
; `call rX` is two bytes and does exactly what `call label` does, taking the
; target from a register.  Function pointers, vtables and dispatch tables all
; work normally.

indirect_example:
        push    lr                      ;                                2
        call    r3                      ; r3 holds the function pointer  2
        pop     lr                      ;                                2
        ret                             ;                                1

; AN INDIRECT TAIL CALL needs no opcode of its own and no saved lr, because
; `ret` is `pc = lr` and lr is about to be dead anyway:

tailcall_example:
        mov     lr, r3                  ; r3 holds the function pointer  2
        ret                             ; "return" into it               1

; TAKING a function's address is `mov r0, #label`, three bytes and absolute.


; ============================================================================
; Frame allocation
; ============================================================================
; sp is r6, an ordinary register, so a frame is just an add.  What it costs
; depends entirely on the size, and the cliff is worth knowing:

frame_examples:
        add     sp, sp, #-8             ; up to 16 bytes: tied imm5      2
        add     sp, sp, #-30            ; up to 512:      imm10          3
        add     sp, sp, #-600           ; beyond: mov + add, CLOBBERS r5 5

; The last line is why r5 is caller saved.  A frame larger than 512 bytes on a
; machine with a 64K address space is already unusual, so the practical rule is:
; keep frames under 512 bytes and the prologue stays three bytes.


; ============================================================================
; Reaching stack slots
; ============================================================================
; The two-byte load form takes its displacement from the imm3 table,
; {-1, 0, 1, 2, 3, 4, 6, 8}.  Five of those are even, so the first five aligned
; 16-bit stack slots are two-byte accesses and everything above them is three:

slot_examples:
        ld      r0, [sp, #0]            ; slot 0                         2
        ld      r0, [sp, #2]            ; slot 1                         2
        ld      r0, [sp, #4]            ; slot 2                         2
        ld      r0, [sp, #6]            ; slot 3                         2
        ld      r0, [sp, #8]            ; slot 4                         2
        ld      r0, [sp, #10]           ; slot 5 - imm10 form            3
        st      r0, [sp, #4]            ; stores have the same shape     2
        ld      r0, [sp, #3]            ; an ODD offset costs the same   2
        ld8     r0, [sp, #1]            ; a byte argument                2

; SO ORDER THE FRAME BY TRAFFIC.  The five hottest 16-bit locals belong in the
; first five slots; everything after that pays a byte per access.  The imm3
; table was chosen for tagged-pointer field access rather than for stack frames,
; and it happens to serve both - and because it holds odd values too, a frame
; knocked out of alignment by a byte argument is no more expensive than one that
; is not.


; ============================================================================
; Varargs
; ============================================================================
; UNNAMED ARGUMENTS ARE ALWAYS PASSED ON THE STACK.  Named arguments use the
; registers exactly as they would in any other function; everything after the
; last named parameter goes to the stack even when registers are still free.
;
; The caller always knows to do this, because a variadic function cannot be
; called without its prototype in view - which is the same modern-C assumption
; that makes the whole scheme workable.
;
; What this buys is that there is NO PROLOGUE.  The variadic arguments are
; already a contiguous, correctly ordered block in the caller's frame, so
; va_list is a plain pointer into it and va_start is one add:
;
;       ...
;       unnamed argument 2
;       unnamed argument 1
;       unnamed argument 0      <- va_list, and sp on entry
;       saved lr                <- sp
;
;       int printf(const char *fmt, ...)
;
; fmt is named, so it arrives in r0.  Everything else is on the stack.

vararg_example:
        push    lr                      ;                                2
        add     r1, sp, #2              ; r1 = va_list                   2
        ; ... r0 is fmt, r1 walks the arguments upward ...
        ld      r2, [r1, #0]            ; va_arg, 16-bit                 2
        add     r1, r1, #2              ; step over it                   2
        pop     lr                      ;                                2
        ret                             ;                                1

; A VARIADIC FUNCTION COSTS THE SAME AS ANY OTHER.  Three bytes of prologue and
; epilogue, and the two-byte add that materialises va_list.
;
; NO UNNAMED ARGUMENT IS EVER 8 BITS, so va_arg never has to deal with the
; unpadded byte slot.  C's default argument promotions widen char to int before
; an unnamed argument is passed, and int is 16 bits here.  A byte on the stack
; is therefore always a NAMED argument that overflowed the registers, whose size
; the callee knows from its prototype.
;
; va_arg FOR A 32-BIT TYPE reads two consecutive words and finds the low half
; first, because the caller pushed the high half first and it landed higher.
; The register convention and the memory convention agree, so a 32-bit vararg
; loads into a high:low register pair with ld at #2 and #0 and needs no
; shuffling - the same layout as a spilled local or a struct field.
;
; WHERE THE no-backfill RULE EARNS ITS KEEP.  If a small argument after a
; stack-bound one could drop back into a spare register, the stack block would
; have holes in it and would no longer be the argument list in order.  It is
; the rule that keeps "the arguments are contiguous in memory from va_list
; upward" true, which is the only thing va_arg can rely on.
;
; NAMED ARGUMENTS CAN THEMSELVES OVERFLOW to the stack, in a function with more
; than four registers' worth of them.  Nothing special happens: they are pushed
; last, so they sit BELOW the unnamed ones, and va_start adds their total size
; to sp.  That size is a constant the callee knows from its own prototype, so
; the count-independence still holds.
;
; ----------------------------------------------------------------------------
; THE ALTERNATIVE IS NOT OBVIOUSLY WORSE, and the choice is a real one.  Letting
; unnamed arguments use r0-r3 and having the callee push them back out to
; reconstitute the block costs the callee four bytes once - `push r3, r2, r1`
; and `push r0` before saving lr - plus two to discard them, and eight bytes
; of stack on every call no matter how few arguments were passed.  What it saves
; is the caller's cleanup: passing in a register is a `mov` where a push would
; have been, so the pushes themselves are free, and only the `add sp, sp, #n`
; after the call is new.
;
;       stack scheme      +2 bytes per CALL SITE
;       register scheme   +6 bytes per VARIADIC FUNCTION, +8 bytes of stack
;                         per call
;
; They cross over at three call sites, so for something like printf the register
; scheme is genuinely smaller - probably by a few dozen bytes across a program.
;
; THE STACK SCHEME IS STILL THE RECOMMENDATION, for a reason that is not size:
; it leaves exactly one place an argument can be.  va_arg becomes "read, add
; two" with no special case for the first four, va_list survives being copied
; and handed to a vprintf without anything having been spilled, and a variadic
; function's frame looks like every other function's.  Two bytes a call site is
; a fair price for deleting a category of bug from the one part of the ABI that
; is checked by nothing.
