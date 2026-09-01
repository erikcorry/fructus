; Immediates too wide for any real form.  In r5 mode all of these assemble; with
; --noat only the ones whose destination differs from the source do.

        add     r1, r2, #4000           ; d != a: no scratch needed
        add     r3, r3, #4000           ; d == a: needs the scratch
        and     r1, r2, #0x0fff         ; mask that fits neither imm5 nor imm10
        ld      r1, [r2, #4000]         ; d != a
        ld      r1, [r1, #4000]         ; d == a
        st      r1, [r2, #4000]         ; a store always needs the scratch
