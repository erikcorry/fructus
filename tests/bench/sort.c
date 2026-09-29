typedef unsigned short u16;
static short a[200];
__attribute__((noinline)) void isort (short *v, int n)
{
  for (int i = 1; i < n; i++)
    {
      short x = v[i];
      int j = i - 1;
      while (j >= 0 && v[j] > x)
        {
          v[j + 1] = v[j];
          j--;
        }
      v[j + 1] = x;
    }
}
int main (void)
{
  u16 s = 12345;
  for (int i = 0; i < 200; i++) { s = s * 25173 + 13849; a[i] = s; }
  isort (a, 200);
  u16 h = 0;
  for (int i = 0; i < 200; i++) h = h * 31 + a[i];
  return h & 0xff;
}
