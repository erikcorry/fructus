/* harness.c - 023.eqntott's stand-in: eqntott on an embedded equation file.

   eqntott's own main, renamed, with a command line that prints the truth
   table in PLA form with its labels and product-term count (-.iolpte).  Its stdin
   is the embedded pri.eqn, already through cpp; see preprocess.c.  */

int eqntott_main (int, char **);

int
main (void)
{
  static char *argv[] = { "eqntott", "-.iolpte", "pri.eqn", 0 };
  return eqntott_main (3, argv);
}
