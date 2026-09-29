typedef unsigned short u16;
typedef unsigned char u8;
static u8 buf[512];
__attribute__((noinline)) u16 crc16 (const u8 *p, u16 n)
{
  u16 crc = 0xffff;
  while (n--)
    {
      crc ^= (u16) *p++ << 8;
      for (int i = 0; i < 8; i++)
        crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
    }
  return crc;
}
int main (void)
{
  for (int i = 0; i < 512; i++) buf[i] = i * 7 + 3;
  return crc16 (buf, 512) & 0xff;
}
