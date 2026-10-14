/* usb.c - fructus/usb.h on tools/fcc-run.mjs, which has no USB port: its
   words are plain memory there, so a status of zero says idle and nothing
   attached, and nothing waits.  What is checked is what software makes -
   the CRCs, against packets as USB analysers show them - and that the
   helpers store the words they should.  Exits with the number of the first
   check that failed, 0 if none did.  */

#include <fructus/usb.h>

int
main (void)
{
  /* Tokens: SETUP to address 0, endpoint 0 is "2d 00 10" on the wire.  */
  if (fructus_usb_token (0, 0) != 0x1000)
    return 1;
  if (fructus_usb_token (1, 1) != 0x5881)
    return 2;
  if (fructus_usb_token (2, 1) != 0x1882)
    return 3;

  /* GET_DESCRIPTOR, the device's, 64 bytes: "80 06 00 01 00 00 40 00 dd 94".  */
  static const uint8_t get_descriptor[8] = { 0x80, 0x06, 0x00, 0x01, 0x00, 0x00, 0x40, 0x00 };
  if (fructus_usb_crc16 (get_descriptor, 8) != 0x94dd)
    return 4;
  /* A zero-length packet's CRC16 is zero.  */
  if (fructus_usb_crc16 (get_descriptor, 0) != 0)
    return 5;

  /* Idle, nothing attached.  */
  if (fructus_usb_attached () != FRUCTUS_USB_NOTHING || fructus_usb_ready ())
    return 6;

  /* The helpers' stores.  */
  fructus_usb_send (FRUCTUS_USB_SYNC);
  if (__usb_data != 0x080)
    return 7;
  fructus_usb_send_last (FRUCTUS_USB_ACK);
  if (__usb_data != 0x1d2)
    return 8;
  fructus_usb_control (FRUCTUS_USB_IRQ_RECEIVED | FRUCTUS_USB_IRQ_EOP | FRUCTUS_USB_ARM);
  if (__usb_ctrl != (FRUCTUS_USB_IRQ_RECEIVED | FRUCTUS_USB_IRQ_EOP))
    return 9;
  fructus_usb_arm_ack ();
  if (__usb_ctrl != (FRUCTUS_USB_IRQ_RECEIVED | FRUCTUS_USB_IRQ_EOP | FRUCTUS_USB_ARM)
      || __usb_data != FRUCTUS_USB_SYNC)
    return 10;
  /* ARM read back is a command written long ago, not a setting.  */
  if (fructus_usb_controls () != (FRUCTUS_USB_IRQ_RECEIVED | FRUCTUS_USB_IRQ_EOP))
    return 11;
  fructus_usb_flush ();
  if (__usb_ctrl != (FRUCTUS_USB_IRQ_RECEIVED | FRUCTUS_USB_IRQ_EOP | FRUCTUS_USB_FLUSH))
    return 12;
  return 0;
}
