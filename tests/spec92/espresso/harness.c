/* harness.c - 008.espresso's stand-in: Berkeley espresso on embedded PLAs.

   In place of espresso's main.c, whose option table reaches every one of its
   modes - exact minimisation, signatures, the lot - so that the linker could
   drop none of them.  This does what main.c does by default, the -Despresso
   it would run on one file, on each file in turn: main's defaults for the
   globals, getPLA's read_pla, then the KEY_ESPRESSO case - minimise, verify
   the result against the original, print it - and what -Dmany does between
   one PLA and the next.

   SPEC's inputs were bca, cps, ti and tial, 22K to 89K of text each, which
   with espresso's working sets are more than a 64K machine has.  These are
   smaller circuits from the same MCNC set that espresso ships with.  */

#include "espresso.h"
#include "strdup.h"

static char *inputs[] = { "rd53.pla", "misex1.pla", "sao2.pla", "5xp1.pla", 0 };

int
main (void)
{
  /* main.c's defaults */
  debug = 0;
  verbose_debug = FALSE;
  print_solution = TRUE;
  summary = FALSE;
  trace = FALSE;
  remove_essential = TRUE;
  force_irredundant = TRUE;
  unwrap_onset = TRUE;
  single_expand = FALSE;
  pos = FALSE;
  recompute_onset = FALSE;
  use_super_gasp = FALSE;
  use_random_order = FALSE;
  kiss = FALSE;
  echo_comments = TRUE;
  echo_unknown_commands = TRUE;

  for (char **name = inputs; *name; name++)
    {
      FILE *fp = fopen (*name, "r");
      pPLA PLA;
      if (!fp || read_pla (fp, TRUE, TRUE, FD_type, &PLA) == EOF)
	{
	  fprintf (stderr, "espresso: Unable to find PLA on file %s\n", *name);
	  return 1;
	}
      fclose (fp);
      PLA->filename = strdup (*name);
      filename = PLA->filename;

      pcover Fold = sf_save (PLA->F);
      PLA->F = espresso (PLA->F, PLA->D, PLA->R);
      if (verify (PLA->F, Fold, PLA->D))
	{
	  print_solution = FALSE;
	  PLA->F = Fold;
	  (void) check_consistency (PLA);
	}
      else
	free_cover (Fold);
      if (print_solution)
	fprint_pla (stdout, PLA, F_type);

      free_PLA (PLA);
      setdown_cube ();
      FREE (cube.part_size);
    }
  return 0;
}
