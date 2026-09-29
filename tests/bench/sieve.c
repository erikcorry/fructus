static unsigned char flags[4096];
__attribute__((noinline)) int sieve (int n)
{
  int count = 0;
  for (int i = 0; i < n; i++) flags[i] = 1;
  for (int i = 2; i < n; i++)
    if (flags[i])
      {
        count++;
        for (int k = i + i; k < n; k += i)
          flags[k] = 0;
      }
  return count;
}
int main (void) { return sieve (4096) & 0xff; }
