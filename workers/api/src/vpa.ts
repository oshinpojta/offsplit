/** VPA shape — mirrors app/lib/features/settle/upi_link.dart exactly. */
export const VPA_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}@[a-zA-Z]{2,64}$/;

const MAX_NOTE = 80;

/** Server-side twin of the client UPI builder (§11: settlements return upi_link). */
export function buildUpiPayLink(args: {
  payeeVpa: string;
  payeeName: string;
  amountPaise: number;
  note?: string;
}): string {
  const rupees = Math.floor(args.amountPaise / 100);
  const paise = args.amountPaise % 100;
  const am = `${rupees}.${String(paise).padStart(2, '0')}`;
  const note = (args.note ?? '').trim().slice(0, MAX_NOTE);
  let link =
    `upi://pay?pa=${encodeURIComponent(args.payeeVpa)}` +
    `&pn=${encodeURIComponent(args.payeeName)}&am=${am}&cu=INR`;
  if (note) link += `&tn=${encodeURIComponent(note)}`;
  return link;
}
