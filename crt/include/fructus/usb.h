/* fructus/usb.h - the low-speed USB host port.

   An option of the system's, rtl/usb.sv, built with FRUCTUS_USB; [cpu.io]
   in isa/fructus.toml has the register map, and rtl/usb.sv's header the
   whole of how it behaves.  The words are symbols in the linker scripts,
   for the reason fructus/display.h gives.

   THE BITS ARE THE HARDWARE'S AND THE PROTOCOL IS YOURS.  The port does
   NRZI, bit stuffing, the end of a packet, the 1 ms keep-alive and the
   CRC check that decides an ACK; everything else - SYNC, PIDs, tokens and
   their CRC5s, data and its CRC16, toggles, enumeration - is bytes stored
   and loaded here.  A packet goes out as FRUCTUS_USB_SYNC, the PID and the
   rest, the last of them sent with fructus_usb_send_last; one comes in
   from its PID on, the SYNC not delivered, and ends with EOP set.

   A BYTE IS ABOUT 134 CYCLES on the line, and the port holds one byte
   waiting behind the one going out, or one received, so a loop or a
   handler has that long to keep up.  Store a byte only while WAITING is
   clear: one stored while another waits replaces it.

   THE ACK.  A host must start its ACK within 7.5 bits of the device's EOP,
   which nothing reading bytes can promise.  So on seeing a DATA PID, call
   fructus_usb_arm_ack: the ACK's SYNC waits in the port until the packet
   ends, and goes if its CRC16 was good - CRC_OK - or is dropped if not, so
   that the device sends the same data again.  When WAITING clears behind
   the SYNC, send FRUCTUS_USB_ACK as the last byte.

   A STATUS OF ZERO IS IDLE.  On a machine without the port the words are
   plain memory, so nothing here waits, and nothing is ever received or
   attached.  tools/fcc-run.mjs has no USB device.

   THE STATUS AND THE BYTE RECEIVED ARE LOADED THROUGH fructus/io.h's window,
   and only so; __usb_ctrl is plain memory beneath, and reads as written.  */
#ifndef _FRUCTUS_USB_H
#define _FRUCTUS_USB_H

#include <stdint.h>
#include <fructus/io.h>

#ifdef __cplusplus
extern "C" {
#endif

extern volatile uint16_t __usb_data;
extern volatile uint16_t __usb_status;
extern volatile uint16_t __usb_ctrl;

/* __usb_data: a byte stored is sent, a load takes the byte received.  */
#define FRUCTUS_USB_LAST       0x100  /* with a byte stored: the packet's last */

/* __usb_status.  EOP, TIMEOUT, FRAME and ERROR stay set until a 1 is
   written to them there: fructus_usb_clear.  */
#define FRUCTUS_USB_BUSY       0x001  /* a packet is going out */
#define FRUCTUS_USB_WAITING    0x002  /* a byte waits to go */
#define FRUCTUS_USB_RECEIVED   0x004  /* a byte waits at __usb_data */
#define FRUCTUS_USB_EOP        0x008  /* a packet received has ended */
#define FRUCTUS_USB_CRC_OK     0x010  /* and its CRC16 was good */
#define FRUCTUS_USB_TIMEOUT    0x020  /* nothing answered within 20 bits */
#define FRUCTUS_USB_FRAME      0x040  /* 1 ms has passed */
#define FRUCTUS_USB_ERROR      0x080  /* a byte lost, or a packet cut short */
#define FRUCTUS_USB_DP         0x100  /* the line, D+ */
#define FRUCTUS_USB_DM         0x200  /* and D- */
#define FRUCTUS_USB_ARMED      0x400  /* an ACK waits for the EOP */
#define FRUCTUS_USB_EVENTS     (FRUCTUS_USB_EOP | FRUCTUS_USB_TIMEOUT \
                                | FRUCTUS_USB_FRAME | FRUCTUS_USB_ERROR)

/* __usb_ctrl.  It reads as the value last written - plain memory beneath -
   so ARM and FLUSH, which are commands, read back as written however long
   ago; the helpers below leave them out of what they keep.  */
#define FRUCTUS_USB_IRQ_EMPTY    0x001  /* interrupt while nothing WAITING */
#define FRUCTUS_USB_IRQ_RECEIVED 0x002  /* on RECEIVED */
#define FRUCTUS_USB_IRQ_EOP      0x004  /* on EOP */
#define FRUCTUS_USB_IRQ_TIMEOUT  0x008  /* on TIMEOUT */
#define FRUCTUS_USB_IRQ_FRAME    0x010  /* on FRAME */
#define FRUCTUS_USB_KEEPALIVE    0x020  /* an EOP every frame, once attached */
#define FRUCTUS_USB_RESET        0x040  /* hold the line at SE0: 10 ms is a bus reset */
#define FRUCTUS_USB_ARM          0x080  /* hold the byte waiting for the next EOP */
#define FRUCTUS_USB_FLUSH        0x100  /* drop the byte waiting, and disarm */
#define FRUCTUS_USB_COMMANDS     (FRUCTUS_USB_ARM | FRUCTUS_USB_FLUSH)

/* The bytes of a packet.  A PID's high nibble is its low one inverted.  */
#define FRUCTUS_USB_SYNC   0x80
#define FRUCTUS_USB_OUT    0xe1
#define FRUCTUS_USB_IN     0x69
#define FRUCTUS_USB_SOF    0xa5
#define FRUCTUS_USB_SETUP  0x2d
#define FRUCTUS_USB_DATA0  0xc3
#define FRUCTUS_USB_DATA1  0x4b
#define FRUCTUS_USB_ACK    0xd2
#define FRUCTUS_USB_NAK    0x5a
#define FRUCTUS_USB_STALL  0x1e

/* The control word's settings, ARM and FLUSH aside.  */
static inline void
fructus_usb_control (uint16_t bits)
{
  __usb_ctrl = bits & ~FRUCTUS_USB_COMMANDS;
}

static inline uint16_t
fructus_usb_controls (void)
{
  return __usb_ctrl & ~FRUCTUS_USB_COMMANDS;
}

/* Clear any of EVENTS.  */
static inline void
fructus_usb_clear (uint16_t events)
{
  __usb_status = events;
}

/* What is on the end of the wire, from the pull-up a device has: on D- a
   low-speed device, which this port speaks to; on D+ a full-speed one,
   which it does not.  Neither: nothing, or a bus reset in progress.  */
#define FRUCTUS_USB_NOTHING     0
#define FRUCTUS_USB_LOW_SPEED   1
#define FRUCTUS_USB_FULL_SPEED  2

static inline int
fructus_usb_attached (void)
{
  uint16_t s = fructus_io_load (&__usb_status);
  if ((s & (FRUCTUS_USB_DP | FRUCTUS_USB_DM)) == FRUCTUS_USB_DM)
    return FRUCTUS_USB_LOW_SPEED;
  if ((s & (FRUCTUS_USB_DP | FRUCTUS_USB_DM)) == FRUCTUS_USB_DP)
    return FRUCTUS_USB_FULL_SPEED;
  return FRUCTUS_USB_NOTHING;
}

/* A byte of a packet, once the one before has gone into the shift
   register; the first starts the packet.  */
static inline void
fructus_usb_send (uint8_t byte)
{
  while (fructus_io_load (&__usb_status) & FRUCTUS_USB_WAITING)
    ;
  __usb_data = byte;
}

/* The packet's last byte: the port ends the packet after it.  */
static inline void
fructus_usb_send_last (uint8_t byte)
{
  while (fructus_io_load (&__usb_status) & FRUCTUS_USB_WAITING)
    ;
  __usb_data = FRUCTUS_USB_LAST | byte;
}

static inline int
fructus_usb_ready (void)
{
  return (fructus_io_load (&__usb_status) & FRUCTUS_USB_RECEIVED) != 0;
}

/* The byte received, once fructus_usb_ready says there is one.  Reading it
   clears RECEIVED.  */
static inline uint8_t
fructus_usb_getc (void)
{
  while (!fructus_usb_ready ())
    ;
  return (uint8_t) fructus_io_load (&__usb_data);
}

/* Having seen a DATA PID: the ACK's SYNC, waiting for the packet's end and
   a good CRC.  Arm first, so the SYNC cannot go before the EOP.  */
static inline void
fructus_usb_arm_ack (void)
{
  __usb_ctrl = fructus_usb_controls () | FRUCTUS_USB_ARM;
  __usb_data = FRUCTUS_USB_SYNC;
}

/* Drop a byte waiting, and disarm: after a TIMEOUT with an ACK armed.  */
static inline void
fructus_usb_flush (void)
{
  __usb_ctrl = fructus_usb_controls () | FRUCTUS_USB_FLUSH;
}

/* THE CRCS, which software makes for what it sends.  Both run over the
   bits in the order they go, low first, which a right shift does.

   CRC5 covers a token's eleven bits, the address in 6:0 and the endpoint
   in 10:7; fructus_usb_token gives the token's two bytes after its PID as
   a word, low byte first: send it low byte, then high as the last.  */
static inline uint16_t
fructus_usb_crc5 (uint16_t bits11)
{
  uint8_t c = 0x1f;
  for (int i = 0; i < 11; i++, bits11 >>= 1)
    c = ((c ^ bits11) & 1) ? (c >> 1) ^ 0x14 : c >> 1;
  return c ^ 0x1f;
}

static inline uint16_t
fructus_usb_token (uint8_t addr, uint8_t endp)
{
  uint16_t bits = (addr & 0x7f) | (uint16_t) (endp & 0xf) << 7;
  return bits | fructus_usb_crc5 (bits) << 11;
}

/* CRC16 covers a data packet's bytes after its PID, and goes after them,
   low byte first.  A received packet's is checked by the port: CRC_OK.  */
static inline uint16_t
fructus_usb_crc16 (const uint8_t *p, unsigned n)
{
  uint16_t c = 0xffff;
  while (n--)
    {
      c ^= *p++;
      for (int i = 0; i < 8; i++)
        c = (c & 1) ? (c >> 1) ^ 0xa001 : c >> 1;
    }
  return ~c;
}

#ifdef __cplusplus
}
#endif

#endif
