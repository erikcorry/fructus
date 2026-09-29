typedef unsigned short u16;
typedef unsigned char u8;
/* A tiny stack machine: the shape of every bytecode interpreter.  */
enum { PUSH, ADD, SUB, DUP, SWAP, JNZ, DEC, DROP, OVER, HALT };
static const u8 prog[] = {
  PUSH, 0, PUSH, 200,           /* acc, counter */
  /* loop at 4: [acc c] -> [c acc] -> [c acc+c] -> [acc' c-1] */
  SWAP, OVER, ADD, SWAP, DEC, DUP, JNZ, 4,
  DROP, HALT                    /* sum 1..200 */
};
struct node { struct node *next; u16 v; };
static struct node nodes[300];
__attribute__((noinline)) u16 run (const u8 *pc)
{
  u16 st[16];
  int sp = 0;
  for (;;)
    switch (*pc++)
      {
      case PUSH: st[sp++] = *pc++; break;
      case ADD: sp--; st[sp - 1] += st[sp]; break;
      case SUB: sp--; st[sp - 1] -= st[sp]; break;
      case DUP: st[sp] = st[sp - 1]; sp++; break;
      case SWAP: { u16 t = st[sp - 1]; st[sp - 1] = st[sp - 2]; st[sp - 2] = t; break; }
      case JNZ: { u8 to = *pc++; if (st[--sp]) pc = prog + to; break; }
      case DEC: st[sp - 1]--; break;
      case DROP: sp--; break;
      case OVER: st[sp] = st[sp - 2]; sp++; break;
      default: return st[sp - 1];
      }
}
__attribute__((noinline)) u16 walk (struct node *n)
{
  u16 s = 0;
  for (; n; n = n->next)
    s += n->v;
  return s;
}
int main (void)
{
  /* linked in the order 0, 7, 14, ... mod 300: every node once, then null */
  for (int i = 0; i < 300; i++)
    {
      int at = i * 7 % 300;
      nodes[at].v = at;
      nodes[at].next = i < 299 ? &nodes[(i + 1) * 7 % 300] : 0;
    }
  u16 h = 0;
  for (int i = 0; i < 10; i++)
    h += run (prog) + walk (nodes);
  return h & 0xff;
}
