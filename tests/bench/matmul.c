typedef unsigned short u16;
#define N 12
static u16 A[N][N], B[N][N], C[N][N];
__attribute__((noinline)) void matmul (void)
{
  for (int i = 0; i < N; i++)
    for (int j = 0; j < N; j++)
      {
        u16 s = 0;
        for (int k = 0; k < N; k++)
          s += A[i][k] * B[k][j];
        C[i][j] = s;
      }
}
__attribute__((noinline)) u16 scale (u16 *v, int n)
{
  u16 h = 0;
  for (int i = 0; i < n; i++)
    h += v[i] * 10 + v[i] * 3;          /* multiplies by constants */
  return h;
}
int main (void)
{
  for (int i = 0; i < N; i++)
    for (int j = 0; j < N; j++)
      A[i][j] = i + 2 * j + 1, B[i][j] = 3 * i + j + 7;
  matmul ();
  u16 h = scale (&C[0][0], N * N);
  return h & 0xff;
}
