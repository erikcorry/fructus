/* Callees for the sliding-convention check.  Each keeps more values live
   than it has argument registers, so the allocator reaches for r2, r3 and r4
   - and must save them exactly when the ABI says they are callee saved.  */

volatile int sink;

#define WORK(a)							\
  int p = (a) * 3 + 1, q = p ^ (a), r = q + p, s = r | (a);	\
  int t = s - q, u = t + r, v = u ^ p, w = v + s;		\
  sink = p; sink = q; sink = r; sink = s;			\
  sink = t; sink = u; sink = v; sink = w;

int one (int a) { WORK (a) return p + q + r + s + t + u + v + w; }
int two (int a, int b) { WORK (a + b) return p + q + r + s + t + u + v + w; }
int three (int a, int b, int c) { WORK (a + b + c) return p + q + r + s + t + u + v + w; }
int four (int a, int b, int c, int d) { WORK (a + b + c + d) return p + q + r + s + t + u + v + w; }

/* One argument, but the 64-bit return reaches r3: ABI 0.  */
long long wide (int a) { WORK (a) return (long long) (p + q) << 32 | (unsigned) (r + s); }
