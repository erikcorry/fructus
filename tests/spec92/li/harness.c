/* harness.c - 022.li's stand-in: XLISP 2.0 on queens.lsp.

   XLISP's own main, renamed, with queens.lsp on its command line.  It loads
   init.lsp, which is not there and so is skipped, then queens.lsp, then
   reads expressions from stdin, which is empty, and exits.  */

int xlisp_main (int, char **);

int
main (void)
{
  static char *argv[] = { "xlisp", "queens.lsp", 0 };
  return xlisp_main (2, argv);
}
